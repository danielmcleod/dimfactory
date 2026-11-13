// Pin, Remove (undo) and retention over a real home (runs history Pin / Remove (undo);
// storage; "Unfinalized worktrees are never auto-deleted"): history.ts with the runs index and runs/history.json,
// and fakes for the core's side (locks, loaded runs, saved patches, worktree removal). No git: these runs have no
// shadow, so their snapshot refs are not looked up.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunSummary } from '../../../src/shared/run.ts'
import type { ApplyEntry, ApplyOp, FinalizeJournal } from '../../../src/core/git/finalize.ts'
import type { RemoveWorktreeOptions, RemoveWorktreeResult } from '../../../src/core/git/worktree.ts'
import { readRunDoc } from '../../../src/core/handlers.ts'
import { createHistory, REMOVE_UNDO_MS } from '../../../src/core/history.ts'
import type { CopyCheck, History, HistoryDeps } from '../../../src/core/history.ts'
import { homePaths } from '../../../src/core/home.ts'
import { silentLogger } from '../../../src/core/log.ts'
import { HistoryState, degradedText, historyStateFile } from '../../../src/core/store/history-state.ts'
import { IndexStore } from '../../../src/core/store/index-store.ts'
import type { RetentionPolicy } from '../../../src/core/store/retention.ts'
import { isPlainObject } from '../../../src/core/store/versions.ts'
import { toRunSummary } from '../../../src/core/supervisor/derive.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import { DAY, ManualTimers, rawLog, writeRun } from './helpers.ts'
import type { SeedRun } from './helpers.ts'

const paths = (): ReturnType<typeof homePaths> => homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
const NOW = 1_000 * DAY

interface World {
  h: History
  index: IndexStore
  state: HistoryState
  timers: ManualTimers
  locks: Map<string, 'held' | 'requested'>
  detached: string[]
  persisted: string[][]
  removedCopies: RemoveWorktreeOptions['worktree'][]
  policy: { value: RetentionPolicy }
  now: { value: number }
  persistFails: Set<string>
  /** What each copy was checked against right before removal (copyLoss), and the reasons to keep one. */
  copyChecks: CopyCheck[]
  copyLoss: Map<string, string>
}

const open: IndexStore[] = []
afterEach(async () => {
  for (const i of open.splice(0)) await i.close().catch(() => undefined)
})

async function world(runs: SeedRun[], over: Partial<HistoryDeps> = {}): Promise<World> {
  const p = paths()
  for (const r of runs) await writeRun(p, r)
  const state = await HistoryState.load(p)
  const index = await IndexStore.open(p, {
    summarize: (doc) =>
      isPlainObject(doc['state']) ? toRunSummary(doc['state'] as unknown as RunState) : null,
    overlay: (s) => state.overlay(s),
  })
  open.push(index)
  const w: Omit<World, 'h'> = {
    index,
    state,
    timers: new ManualTimers(),
    locks: new Map(),
    detached: [],
    persisted: [],
    removedCopies: [],
    policy: { value: { keepRuns: 300, keepDays: 60, rawLogDays: 14 } },
    now: { value: NOW },
    persistFails: new Set(),
    copyChecks: [],
    copyLoss: new Map(),
  }
  const h = createHistory({
    paths: p,
    log: silentLogger,
    now: () => w.now.value,
    state,
    index,
    summaries: () => index.list(),
    readDoc: (runId) => readRunDoc(p, runId),
    summarizeDoc: (doc) => state.overlay(toRunSummary(doc.state)) ?? toRunSummary(doc.state),
    lockOf: (runId) => w.locks.get(runId),
    detach: (runId) => {
      w.detached.push(runId)
      return Promise.resolve()
    },
    persistRuns: (ids) => {
      w.persisted.push([...ids])
      const failed = ids
        .filter((id) => w.persistFails.has(id))
        .map((runId) => ({ runId, reason: 'the drive is full' }))
      return Promise.resolve({ written: 0, failed })
    },
    folderInUse: () => false,
    lastLockAt: () => undefined,
    policy: () => w.policy.value,
    // The copies here are plain folders: what a real copy holds is checked by tests/integration/history.
    copyLoss: (c) => {
      w.copyChecks.push(c)
      return Promise.resolve(w.copyLoss.get(c.runId))
    },
    removeWorktree: (o): Promise<RemoveWorktreeResult> => {
      w.removedCopies.push(o.worktree)
      mkdirSync(o.worktree.path, { recursive: true })
      return import('node:fs/promises')
        .then((fs) => fs.rm(o.worktree.path, { recursive: true, force: true }))
        .then(() => ({ removed: true, branchDeleted: true, shadowDropped: true, notes: [], commands: [] }))
    },
    timers: w.timers,
    ...over,
  })
  return { ...w, h }
}

const seed = (n: number, over: Partial<SeedRun> = {}): SeedRun => ({
  runId: `20260101T00000${n}Z-run${n}`,
  displayNo: n,
  createdAt: NOW - (100 - n) * DAY,
  ...over,
})
const id = (n: number): string => seed(n).runId
const listed = (w: World): string[] => w.index.list().map((s) => s.runId)
const runDir = (n: number): string => paths().run(id(n)).dir

async function rejects(p: Promise<unknown>): Promise<{ code: string; message: string; details?: unknown }> {
  try {
    await p
  } catch (err) {
    const e = err as { code: string; message: string; details?: unknown }
    return { code: e.code, message: e.message, details: e.details }
  }
  throw new Error('expected a rejection')
}

/** An isolated run's copy and journal (`runs/<id>/finalize.json`). */
function isolatedCopy(n: number, journal: Partial<FinalizeJournal> & { record?: boolean }): string {
  const p = paths()
  const wt = p.worktree(id(n))
  mkdirSync(join(wt, 'src'), { recursive: true })
  writeFileSync(join(wt, 'src', 'a.txt'), 'copy\n')
  const j: FinalizeJournal = {
    schemaVersion: 1,
    ops: journal.ops ?? [],
    ...(journal.record !== false
      ? {
          worktree: {
            path: wt,
            branch: `dim/run${n}`,
            base: 'c'.repeat(40),
            commonDir: 'C:\\repo\\.git',
            folder: 'C:\\repo',
            state: 'created',
            at: 1,
          },
        }
      : {}),
    ...(journal.discard !== undefined ? { discard: journal.discard } : {}),
  }
  writeFileSync(join(p.run(id(n)).dir, 'finalize.json'), JSON.stringify(j))
  return wt
}

const SAME = { s0: '1'.repeat(40), s1: '1'.repeat(40) }
const CHANGED = { s0: '1'.repeat(40), s1: '2'.repeat(40) }

describe('runs.pin', () => {
  it('pins and unpins through runs/history.json and the index; an unknown run is NOT_FOUND', async () => {
    const w = await world([seed(1), seed(2)])
    await w.h.pin(id(1), true)
    expect(w.index.get(id(1))?.pinned).toBe(true)
    expect(w.state.isPinned(id(1))).toBe(true)
    const file = JSON.parse(readFileSync(historyStateFile(paths()), 'utf8')) as { pinned: object }
    expect(file.pinned).toHaveProperty(id(1))
    await w.h.pin(id(1), false)
    expect(w.index.get(id(1))?.pinned).toBe(false)
    expect((await rejects(w.h.pin('nope', true))).code).toBe('NOT_FOUND')
  })
})

describe('runs.remove and runs.undoRemove', () => {
  it('hides at once; Undo inside the window lists the run again and nothing is deleted', async () => {
    const w = await world([seed(1), seed(2), seed(3)])
    const r = await w.h.remove([id(2)])
    expect(r.removed).toEqual([id(2)])
    expect(listed(w)).toEqual([id(3), id(1)])
    expect(w.state.isHidden(id(2))).toBe(true)
    expect([...w.timers.pending.values()].map((t) => t.ms)).toEqual([REMOVE_UNDO_MS])
    await w.h.undoRemove(r.undoToken)
    expect(listed(w)).toEqual([id(3), id(2), id(1)])
    expect(w.state.removals()).toEqual([])
    expect(w.timers.pending.size).toBe(0)
    expect(existsSync(runDir(2))).toBe(true)
    expect(w.detached).toEqual([])
  })

  it('the deferred delete removes the run for real; an Undo after it is refused with why', async () => {
    const w = await world([seed(1), seed(2)])
    rawLog(paths(), id(2), 'implement-1.ndjson', 0)
    const r = await w.h.remove([id(2)])
    w.timers.fireAll()
    await w.h.settled()
    expect(existsSync(runDir(2))).toBe(false)
    expect(existsSync(runDir(1))).toBe(true)
    expect(w.detached).toEqual([id(2)])
    expect(w.persisted).toEqual([[id(2)]])
    expect(w.state.removals()).toEqual([])
    expect(listed(w)).toEqual([id(1)])
    const late = await rejects(w.h.undoRemove(r.undoToken))
    expect(late).toMatchObject({
      code: 'CONFLICT',
      message: 'It is too late to undo: Run #2 was already deleted.',
    })
    expect((await rejects(w.h.undoRemove('remove-unknown'))).code).toBe('CONFLICT')
  })

  it('refuses live, queued, paused, lock-holding and pinned runs, with the reason, and hides nothing', async () => {
    const w = await world([
      seed(1, { status: 'running' }),
      seed(2, { status: 'queued' }),
      seed(3, { status: 'paused' }),
      seed(4, { status: 'failed' }),
      seed(5),
      seed(6),
      seed(7, { status: 'failed' }),
    ])
    w.locks.set(id(4), 'held')
    w.locks.set(id(5), 'held')
    await w.h.pin(id(6), true)
    const reason = async (n: number): Promise<string> => (await rejects(w.h.remove([id(n)]))).message
    expect(await reason(1)).toBe('Run #1 is still running. Stop it first, then remove it.')
    expect(await reason(2)).toBe('Run #2 is waiting to start. Cancel it first, then remove it.')
    expect(await reason(3)).toBe('Run #3 is paused. Stop it first, then remove it.')
    expect(await reason(4)).toBe('Run #4 failed and still holds its folder. Close it first, then remove it.')
    expect(await reason(5)).toBe('Run #5 is still finishing. Try again in a moment.')
    expect(await reason(6)).toBe('Run #6 is pinned. Unpin it first, then remove it.')
    const many = await rejects(w.h.remove([id(1), id(7), id(3)]))
    expect(many.code).toBe('CONFLICT')
    expect(many.message).toBe(
      '2 of these runs cannot be removed now. Run #1 is still running. Stop it first, then remove it.',
    )
    expect(many.details).toEqual({
      refused: [
        { runId: id(1), reason: 'Run #1 is still running. Stop it first, then remove it.' },
        { runId: id(3), reason: 'Run #3 is paused. Stop it first, then remove it.' },
      ],
    })
    expect(listed(w)).toHaveLength(7)
    expect(w.state.removals()).toEqual([])
    // A failed run that let its folder go (R2b) can be removed.
    expect((await w.h.remove([id(7)])).removed).toEqual([id(7)])
    expect((await rejects(w.h.remove(['nope']))).code).toBe('NOT_FOUND')
  })

  it('UI copy has no em dash', async () => {
    const w = await world([seed(1, { status: 'running' }), seed(2)])
    await w.h.pin(id(2), true)
    for (const n of [1, 2]) expect((await rejects(w.h.remove([id(n)]))).message).not.toContain('\u2014')
  })
})

describe('isolated copies (unfinalized worktrees are never auto-deleted)', () => {
  it('a kept copy with changes refuses Remove; an applied copy, or one that changed nothing, goes with its run', async () => {
    const iso = (n: number, trees = CHANGED): SeedRun => seed(n, { isolation: 'worktree', trees })
    const w = await world([iso(1), iso(2), iso(3, SAME), iso(4), iso(5), iso(6)])
    isolatedCopy(1, {})
    const applied = isolatedCopy(2, {
      ops: [{ token: 'apply-1', state: 'applied', startedAt: 5, endedAt: 6, from: 'a', to: 'b' }],
    })
    const unchanged = isolatedCopy(3, {})
    isolatedCopy(4, { discard: { token: 'd', requestedAt: 1, deleteAt: NOW + 10, state: 'pending' } })
    isolatedCopy(5, { ops: [{ token: 'apply-2', state: 'started', startedAt: 5, from: 'a', to: 'b' }] })
    isolatedCopy(6, { record: false })
    expect((await rejects(w.h.remove([id(1)]))).message).toBe(
      "Run #1 still has its isolated copy with changes that are not in your folder. Apply or discard the copy in the run's Diff tab first.",
    )
    expect((await rejects(w.h.remove([id(4)]))).message).toBe(
      "Run #4's isolated copy is being discarded. Try again in a moment.",
    )
    expect((await rejects(w.h.remove([id(5)]))).message).toMatch(/stopped part way/)
    expect((await rejects(w.h.remove([id(6)]))).message).toMatch(/no record of how/)
    await w.h.remove([id(2), id(3)])
    w.timers.fireAll()
    await w.h.settled()
    expect(w.removedCopies.map((c) => c.path).sort()).toEqual([applied, unchanged].sort())
    expect(w.removedCopies.find((c) => c.path === applied)).toMatchObject({
      branch: 'dim/run2',
      commonDir: 'C:\\repo\\.git',
      folder: 'C:\\repo',
    })
    expect(existsSync(runDir(2))).toBe(false)
    expect(existsSync(runDir(3))).toBe(false)
    expect(existsSync(paths().worktree(id(1)))).toBe(true)
    // Each copy was checked by Remove and again right before it went (an applied one against the apply's
    // W.last, one that changed nothing against its last snapshot).
    expect(w.copyChecks.map((c) => `${c.runId} ${c.kind}`).sort()).toEqual(
      [`${id(2)} applied`, `${id(2)} applied`, `${id(3)} unchanged`, `${id(3)} unchanged`].sort(),
    )
  })

  // An apply that left part of the run outside the folder does not finalize the copy.
  const entry = (path: string, outcome: NonNullable<ApplyEntry['outcome']>): ApplyEntry => ({
    path,
    change: 'M',
    oldMode: '100644',
    oldSha: '1'.repeat(40),
    newMode: '100644',
    newSha: '2'.repeat(40),
    action: outcome === 'conflict' ? 'conflict' : 'write',
    outcome,
  })
  const op = (token: string, entries: ApplyEntry[], over: Partial<ApplyOp> = {}): ApplyOp => ({
    token,
    state: 'applied',
    startedAt: 5,
    endedAt: 6,
    from: 'a',
    to: 'b',
    entries,
    ...over,
  })

  it('an apply with an open conflict, a skipped file or a selection keeps the copy; one settled later lets it go', async () => {
    const iso = (n: number): SeedRun => seed(n, { isolation: 'worktree', trees: CHANGED })
    const w = await world([iso(1), iso(2), iso(3), iso(4)])
    isolatedCopy(1, { ops: [op('c', [entry('a.txt', 'written'), entry('b.txt', 'conflict')])] })
    isolatedCopy(2, { ops: [op('s', [entry('a.txt', 'written'), entry('b.txt', 'skipped')])] })
    // A selection: the journal cannot tell what was left out, so the check before removal does (copyLoss).
    isolatedCopy(3, { ops: [op('p', [entry('a.txt', 'written')], { paths: ['a.txt'] })] })
    w.copyLoss.set(id(3), 'Run #3 still has its isolated copy with changes that are not in your folder.')
    // A conflict taken as the run's by a later apply: every change is settled.
    const settled = isolatedCopy(4, {
      ops: [
        op('f', [entry('a.txt', 'written'), entry('b.txt', 'conflict')]),
        op('r', [entry('b.txt', 'written')], { paths: ['b.txt'], resolutions: { 'b.txt': 'theirs' } }),
      ],
    })
    const unapplied =
      "still has its isolated copy with changes that are not in your folder. Apply or discard the copy in the run's Diff tab first."
    expect((await rejects(w.h.remove([id(1)]))).message).toBe(`Run #1 ${unapplied}`)
    expect((await rejects(w.h.remove([id(2)]))).message).toBe(`Run #2 ${unapplied}`)
    expect((await rejects(w.h.remove([id(3)]))).message).toMatch(/^Run #3 still has its isolated copy/)
    w.policy.value = { keepRuns: 0, keepDays: 0, rawLogDays: 14 }
    w.now.value = NOW + 2 * DAY
    const r = await w.h.retention()
    expect(r.removed.map((x) => x.displayNo)).toEqual([4])
    expect(r.kept.map((x) => x.displayNo).sort()).toEqual([1, 2, 3])
    expect(w.removedCopies.map((c) => c.path)).toEqual([settled])
    for (const n of [1, 2, 3]) {
      expect(existsSync(paths().worktree(id(n)))).toBe(true)
      expect(existsSync(runDir(n))).toBe(true)
    }
  })

  it('a copy that fails its check right before removal stays with its run (Remove and retention)', async () => {
    const iso = (n: number, trees = SAME): SeedRun => seed(n, { isolation: 'worktree', trees })
    const w = await world([iso(1), iso(2)])
    const edited = isolatedCopy(1, {})
    isolatedCopy(2, {})
    const why =
      "Run #1's isolated copy was changed after the run (notes.txt), so Dim Factory leaves it alone. Discard the copy in the run's Diff tab once you no longer need those changes."
    w.copyLoss.set(id(1), why)
    expect((await rejects(w.h.remove([id(1)]))).message).toBe(why)
    w.policy.value = { keepRuns: 0, keepDays: 0, rawLogDays: 14 }
    w.now.value = NOW + 2 * DAY
    const r = await w.h.retention()
    expect(r.removed.map((x) => x.displayNo)).toEqual([2])
    expect(r.kept).toContainEqual(expect.objectContaining({ displayNo: 1, reason: why }))
    expect(existsSync(edited)).toBe(true)
    expect(existsSync(runDir(1))).toBe(true)
  })
})

describe('boot', () => {
  it('deletes the removals an app that quit left; a removal the index still lists is dropped; lost runs come back', async () => {
    const p = paths()
    const w = await world([seed(1), seed(2), seed(3), seed(4)])
    await w.h.remove([id(2)])
    w.h.close() // the app quit inside the undo window
    // A removal recorded but never hidden (the app stopped between the two writes).
    const three = w.index.get(id(3))
    await w.state.addRemoval({
      token: 'remove-half',
      runIds: [id(3)],
      requestedAt: NOW,
      deleteAt: NOW + 10_000,
      summaries: three !== undefined ? [three] : [],
    })
    // An Undo cut short: the record is gone, the index never listed the run again.
    await w.index.del(id(4))
    await w.index.close()
    // A pin the index does not show (the app stopped between the two writes).
    const file = JSON.parse(readFileSync(historyStateFile(p), 'utf8')) as { pinned: Record<string, number> }
    file.pinned[id(1)] = 5
    writeFileSync(historyStateFile(p), JSON.stringify(file))
    const next = await world([])
    expect(next.index.get(id(1))?.pinned).toBe(false)
    expect(next.index.get(id(4))).toBeUndefined()
    await next.h.boot()
    await next.h.settled()
    expect(existsSync(runDir(2))).toBe(false)
    expect(existsSync(runDir(3))).toBe(true)
    expect(next.state.removals()).toEqual([])
    expect(
      next.index
        .list()
        .map((s) => s.runId)
        .sort(),
    ).toEqual([id(1), id(3), id(4)].sort())
    expect(next.index.get(id(1))?.pinned).toBe(true)
  })

  it('a damaged runs/history.json: the index keeps its pins (never unpinned), the file is written again, retention deletes no run', async () => {
    const p = paths()
    const old = (n: number): SeedRun => seed(n, { createdAt: NOW - (100 - n) * DAY })
    const w = await world([old(1), old(2), old(3)])
    await w.h.pin(id(1), true)
    await w.index.close()
    writeFileSync(historyStateFile(p), '{"schemaVersion":1,"pinned":{"2026')
    const next = await world([])
    expect(next.state.degraded).toMatchObject({ kind: 'corrupt' })
    // app-core.ts adopts the index's pins as soon as the index is open (before anything writes a summary).
    next.state.adoptPins(
      next.index
        .list()
        .filter((s) => s.pinned)
        .map((s) => s.runId),
      NOW,
    )
    await next.h.boot()
    await next.h.settled()
    expect(next.index.get(id(1))?.pinned).toBe(true)
    expect(
      (JSON.parse(readFileSync(historyStateFile(p), 'utf8')) as { pinned: Record<string, number> }).pinned,
    ).toHaveProperty(id(1))
    next.policy.value = { keepRuns: 0, keepDays: 0, rawLogDays: 14 }
    const r = await next.h.retention()
    expect(r.removed).toEqual([])
    const reason = degradedText({ kind: 'corrupt', error: '' })
    expect(r.kept.map((x) => [x.displayNo, x.reason])).toEqual([
      [1, 'pinned'],
      [2, reason],
      [3, reason],
    ])
    for (const n of [1, 2, 3]) expect(existsSync(runDir(n))).toBe(true)
  })
})

describe('retention', () => {
  const old = (n: number, over: Partial<SeedRun> = {}): SeedRun =>
    seed(n, { createdAt: NOW - (100 - n) * DAY, ...over })

  it('deletes runs past keepRuns and keepDays, keeps pinned, live, lock-holding runs and unfinalized copies', async () => {
    const w = await world([
      old(1),
      old(2),
      old(3, { status: 'paused' }),
      old(4, { isolation: 'worktree', trees: CHANGED }),
      old(5),
      old(6),
      old(7),
    ])
    w.policy.value = { keepRuns: 1, keepDays: 30, rawLogDays: 14 }
    await w.h.pin(id(5), true)
    w.locks.set(id(6), 'held')
    isolatedCopy(4, {})
    const dry = await w.h.retention({ dryRun: true })
    expect(dry.removed.map((r) => r.displayNo)).toEqual([1, 2])
    expect(existsSync(runDir(1))).toBe(true)
    const r = await w.h.retention()
    expect(r.removed.map((x) => x.displayNo)).toEqual([1, 2])
    expect(r.kept.map((x) => [x.displayNo, x.reason])).toEqual([
      [3, 'not finished'],
      [5, 'pinned'],
      [6, 'still holds its folder'],
      [
        4,
        "Run #4 still has its isolated copy with changes that are not in your folder. Apply or discard the copy in the run's Diff tab first.",
      ],
    ])
    expect(existsSync(runDir(1))).toBe(false)
    expect(existsSync(runDir(2))).toBe(false)
    for (const n of [3, 4, 5, 6, 7]) expect(existsSync(runDir(n))).toBe(true)
    expect(existsSync(paths().worktree(id(4)))).toBe(true)
    expect(listed(w).sort()).toEqual([id(3), id(4), id(5), id(6), id(7)].sort())
  })

  it('deletes raw logs older than rawLogDays of kept, finished, lock-free runs', async () => {
    const w = await world([old(1), old(2, { status: 'paused' }), old(3)])
    w.locks.set(id(3), 'held')
    const kept = rawLog(paths(), id(1), 'implement-1.ndjson', 20 * DAY)
    const fresh = rawLog(paths(), id(1), 'fix-1.ndjson', DAY)
    const live = rawLog(paths(), id(2), 'implement-1.ndjson', 20 * DAY)
    const locked = rawLog(paths(), id(3), 'implement-1.ndjson', 20 * DAY)
    const r = await w.h.retention()
    expect(r.removed).toEqual([])
    expect(r.rawLogs.files).toBe(1)
    expect(existsSync(kept)).toBe(false)
    for (const f of [fresh, live, locked]) expect(existsSync(f)).toBe(true)
  })

  it("removes a kept run's finalized copy a day after, once its diff is saved", async () => {
    const iso = (n: number, trees = CHANGED): SeedRun => old(n, { isolation: 'worktree', trees })
    const w = await world([iso(1), iso(2), iso(3, SAME), iso(4)])
    const dayAgo = NOW - 2 * DAY
    const aDayOld = isolatedCopy(1, {
      ops: [{ token: 'a1', state: 'applied', startedAt: dayAgo, endedAt: dayAgo, from: 'a', to: 'b' }],
    })
    const recent = isolatedCopy(2, {
      ops: [
        { token: 'a2', state: 'applied', startedAt: NOW - 1000, endedAt: NOW - 1000, from: 'a', to: 'b' },
      ],
    })
    const noChanges = isolatedCopy(3, {})
    const unsaved = isolatedCopy(4, {
      ops: [{ token: 'a4', state: 'applied', startedAt: dayAgo, endedAt: dayAgo, from: 'a', to: 'b' }],
    })
    w.persistFails.add(id(4))
    const r = await w.h.retention()
    expect(r.removed).toEqual([])
    expect(r.copies.map((c) => c.displayNo).sort()).toEqual([1, 3])
    expect(existsSync(aDayOld)).toBe(false)
    expect(existsSync(noChanges)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(unsaved)).toBe(true)
    expect(w.persisted).toContainEqual([id(1)])
    // The runs stay in the history.
    expect(listed(w)).toHaveLength(4)
  })

  it('a pin in flight when the pass starts keeps the run and its pin; a pin asked for mid-delete is refused', async () => {
    const w = await world([old(1), old(2), old(3)])
    w.policy.value = { keepRuns: 1, keepDays: 30, rawLogDays: 14 }
    // Pinned while the pass plans (the write still in flight).
    const pinning = w.h.pin(id(1), true)
    const r = await w.h.retention()
    await pinning
    expect(r.removed.map((x) => x.displayNo)).toEqual([2])
    expect(r.kept).toContainEqual(expect.objectContaining({ displayNo: 1, reason: 'pinned' }))
    expect(w.state.isPinned(id(1))).toBe(true)
    expect(existsSync(runDir(1))).toBe(true)
  })

  it('a pin asked for while the run is being deleted is refused (CONFLICT), never accepted and then dropped', async () => {
    let refusal: { code: string; message: string } | undefined
    const box: { h?: History } = {}
    const w = await world([old(1), old(2)], {
      // Saving patch copies of many runs takes a while; the user pins run 1 meanwhile (runs.pin over IPC).
      persistRuns: async () => {
        refusal = await rejects(box.h?.pin(id(1), true) ?? Promise.resolve())
        return { written: 0, failed: [] }
      },
    })
    box.h = w.h
    w.policy.value = { keepRuns: 0, keepDays: 30, rawLogDays: 14 }
    const r = await w.h.retention()
    expect(refusal).toMatchObject({
      code: 'CONFLICT',
      message: 'Run #1 is being deleted. Try again in a moment.',
    })
    expect(r.removed.map((x) => x.displayNo)).toEqual([1, 2])
    expect(w.state.isPinned(id(1))).toBe(false)
    // Once it is gone, the run is simply not in the history.
    expect((await rejects(w.h.pin(id(1), true))).code).toBe('NOT_FOUND')
  })

  it('a run that takes its folder (or is pinned) after the pass chose it stays: checked again right before it goes', async () => {
    const w = await world([old(1), old(2), old(3)], {})
    w.policy.value = { keepRuns: 0, keepDays: 30, rawLogDays: 14 }
    const pinnedMeanwhile = w.state
    const h = createHistory({
      paths: paths(),
      log: silentLogger,
      now: () => w.now.value,
      state: w.state,
      index: w.index,
      summaries: () => w.index.list(),
      readDoc: (runId) => readRunDoc(paths(), runId),
      summarizeDoc: (doc) => toRunSummary(doc.state),
      lockOf: (runId) => w.locks.get(runId),
      detach: () => Promise.resolve(),
      // A Retry takes run 1's folder, and run 2 is pinned (by another path), while the patch copies are saved.
      persistRuns: async () => {
        w.locks.set(id(1), 'held')
        await pinnedMeanwhile.setPinned(id(2), true, NOW)
        return { written: 0, failed: [] }
      },
      folderInUse: () => false,
      lastLockAt: () => undefined,
      policy: () => w.policy.value,
      timers: w.timers,
    })
    const r = await h.retention()
    expect(r.removed.map((x) => x.displayNo)).toEqual([3])
    expect(r.kept.map((x) => x.displayNo).sort()).toEqual([1, 2])
    expect(r.kept.find((x) => x.displayNo === 2)?.reason).toBe('pinned')
    expect(existsSync(runDir(1))).toBe(true)
    expect(existsSync(runDir(2))).toBe(true)
    expect(existsSync(runDir(3))).toBe(false)
  })

  it('carries out a removal whose window passed (a delete that failed earlier is tried again)', async () => {
    const w = await world([seed(1), seed(2)])
    await w.h.remove([id(2)])
    w.h.close() // the timer never fires (this process stopped it)
    w.now.value = NOW + REMOVE_UNDO_MS + 1
    const r = await w.h.retention()
    expect(r.pendingRemoved).toBe(1)
    expect(existsSync(runDir(2))).toBe(false)
  })
})

describe('summaries the index never had', () => {
  it('a removed run is not listed by the runs index even when a late summary arrives', async () => {
    const w = await world([seed(1), seed(2)])
    const before: RunSummary | undefined = w.index.get(id(2))
    await w.h.remove([id(2)])
    if (before !== undefined) await w.index.put(before)
    expect(listed(w)).toEqual([id(1)])
  })
})
