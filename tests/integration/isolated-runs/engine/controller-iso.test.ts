// Isolated-run controller effects: what RunController does with ISO_API, through
// thin fakes behind the real signatures (the real modules are covered by isolated-run / finalize-flows):
//   - setup: eligibility first (a refusal fails prepare with worktree_failed and makes nothing); the worktree's branch
//     name; its write-ahead in the finalize journal; the long-path warning, uncommitted changes and copy-in notes
//   - the passes spawn with cwd = the worktree's copy of the run's folder; snapshots use the worktree's shadow
//   - the deps decision's error opens depsFailed with its words
//   - [Finish apply] with nothing open in the journal reports an apply that finished unrecorded (never applies twice)
//   - an apply that throws with the journal holding an open apply opens interruptedApply
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Adapter, RunHandle, StartOptions } from '../../../../src/core/adapters/types.ts'
import { EventBus } from '../../../../src/core/bus/bus.ts'
import { resolveBuiltinConfig } from '../../../../src/core/config/builtins.ts'
import type { Shadow, SnapshotRecord } from '../../../../src/core/git/shadow.ts'
import { ensureHome, homePaths } from '../../../../src/core/home.ts'
import { silentLogger } from '../../../../src/core/log.ts'
import { ProcTable } from '../../../../src/core/proc/proc-table.ts'
import { RunStore } from '../../../../src/core/store/run-store.ts'
import { RunController } from '../../../../src/core/supervisor/controller.ts'
import type { RunDoc } from '../../../../src/core/supervisor/controller.ts'
import { toRunSummary } from '../../../../src/core/supervisor/derive.ts'
import { systemClock } from '../../../../src/core/supervisor/effects.ts'
import { ISO_API } from '../../../../src/core/supervisor/isolation.ts'
import type { IsolationApi } from '../../../../src/core/supervisor/isolation.ts'
import { initRunState, runConfigFromResolved } from '../../../../src/core/supervisor/machine.ts'
import { FolderScheduler } from '../../../../src/core/supervisor/scheduler.ts'
import type { RunState } from '../../../../src/core/supervisor/types.ts'
import type { NormalizedEvent } from '../../../../src/shared/events.ts'

const dirs: string[] = []
const controllers: RunController[] = []
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const record = (label: string): SnapshotRecord => ({
  label,
  tree: label === 'run-start' || label === 'S0' ? 't-base' : 't-changed',
  commit: `${label === 'S0' ? 'a' : 'b'}`.repeat(40),
  at: Date.now(),
  unreadable: [],
  reused: false,
  ms: 1,
  warnings: [],
})

/** A pass that reports a session and `done` at once, then exits 0; records its StartOptions. */
function instantAdapter(starts: StartOptions[]): Adapter {
  let n = 0
  const start = (o: StartOptions): RunHandle => {
    starts.push(o)
    n++
    const events: NormalizedEvent[] = [
      { type: 'session', id: `s-${n}` },
      { type: 'done', result: 'implemented', usage: { input: 1, output: 1 } },
    ]
    let resolveExit: (v: { code: number; signal: null; sawTerminal: boolean; ranMs: number }) => void = () =>
      undefined
    const exited = new Promise<{ code: number; signal: null; sawTerminal: boolean; ranMs: number }>(
      (r) => (resolveExit = r),
    )
    return {
      id: `h-${n}`,
      vendor: 'claude',
      route: 'stdio',
      pid: undefined,
      onEvent: (cb: (e: NormalizedEvent) => void) => {
        setImmediate(() => {
          for (const e of events) cb(e)
          setImmediate(() => resolveExit({ code: 0, signal: null, sawTerminal: true, ranMs: 10 }))
        })
        return () => undefined
      },
      onSignal: () => () => undefined,
      sessionId: () => `s-${n}`,
      cumulativeUsage: () => undefined,
      pendingAsks: () => [],
      exited,
    } as unknown as RunHandle
  }
  return {
    id: 'claude',
    displayName: 'Claude',
    transport: 'claude-stdio',
    start,
    stop: () => Promise.resolve(),
    answer: () => undefined,
    canResume: () => Promise.resolve({ ok: true }),
  } as unknown as Adapter
}

interface Calls {
  created: { branch: string; folder: string }[]
  recorded: string[]
  copyIns: { folder: string; worktree: string; globs: readonly string[] }[]
  applies: number
  shadows: string[]
}

async function setup(
  iso: (calls: Calls, home: string) => Partial<IsolationApi>,
  o: { copy?: string[]; e2eApplyHold?: (home: string) => string } = {},
): Promise<{ c: RunController; calls: Calls; starts: StartOptions[]; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'controller-'))
  dirs.push(home)
  const paths = homePaths(home)
  await ensureHome(paths)
  const folder = join(home, 'project')
  const config = resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: {
      gates: { afterPlan: false, beforeFix: false },
      passes: {
        plan: { enabled: false },
        review: { enabled: false },
        critic: { enabled: false },
        fix: { enabled: false },
      },
      isolation: { mode: 'worktree', worktree: { copy: o.copy ?? [], install: 'ask' } },
    },
  })
  const runId = '20261009T120000Z-iso1'
  const state: RunState = initRunState({
    runId,
    displayNo: 1,
    folder,
    folderKey: '0123456789abcdef',
    task: 'add a --version flag',
    profile: 'claude-only',
    createdAt: Date.UTC(2026, 9, 9, 12),
    config: runConfigFromResolved(config, 'emulated'),
  })
  const scope = { folder, scopeRoot: folder, lockKey: folder, folderKey: '0123456789abcdef', isRepo: true }
  const doc: RunDoc = { runId, state, lastSeq: 0, scope, createdBy: 'cli' }
  const store = await RunStore.create<RunDoc>(paths, runId, doc, { log: silentLogger })
  const bus = new EventBus({ home: paths, log: silentLogger })
  await bus.openRun(runId, { createdAt: state.createdAt })
  const calls: Calls = { created: [], recorded: [], copyIns: [], applies: 0, shadows: [] }
  const shadow = (where: string): Shadow =>
    ({
      snapshot: (_id: string, label: string): Promise<SnapshotRecord> => {
        calls.shadows.push(`${where}:${label}`)
        return Promise.resolve(record(label))
      },
      liveChanged: () => Promise.resolve(null),
      treeNow: () => Promise.resolve({ tree: 't-changed' }),
      changes: () => Promise.resolve([]),
      patch: () => Promise.resolve({ text: '', truncated: false }),
      scope: {
        scopeRoot: join(home, 'worktrees', runId),
        lockKey: 'wt',
        folderKey: 'fedcba9876543210',
        isRepo: true,
      },
    }) as unknown as Shadow
  const starts: StartOptions[] = []
  const c = new RunController(state, {
    paths,
    bus,
    store,
    config,
    scope,
    createdBy: 'cli',
    adapters: { get: () => instantAdapter(starts) },
    preflight: (mode) => Promise.resolve({ mode, ok: true, blocking: [], warnings: [], info: [] }),
    scheduler: new FolderScheduler(),
    summarize: (s) => toRunSummary(s),
    clock: systemClock(),
    log: silentLogger,
    shadow: () => Promise.resolve(shadow('folder')),
    workShadow: () => Promise.resolve(shadow('worktree')),
    procTable: await ProcTable.open(paths.run(runId).procsJson),
    isolation: { ...ISO_API, ...iso(calls, home) },
    ...(o.e2eApplyHold !== undefined ? { e2eApplyHold: o.e2eApplyHold(home) } : {}),
  })
  controllers.push(c)
  await c.enqueue({ t: 'created' })
  return { c, calls, starts, home }
}

/** A fake worktree made under the home (no git involved). */
function fakeWorktree(calls: Calls, home: string): Partial<IsolationApi> {
  return {
    checkEligibility: () => Promise.resolve({ ok: true, reasons: [], blockers: [] }),
    createWorktree: (o) => {
      calls.created.push({ branch: o.branch, folder: o.folder })
      const path = join(home, 'worktrees', o.runId)
      return Promise.resolve({
        path,
        branch: o.branch,
        base: 'c'.repeat(40),
        folderKey: 'fedcba9876543210',
        commonDir: join(home, 'project', '.git'),
        folder: o.folder,
      })
    },
    recordWorktree: (_io, _w, state) => {
      calls.recorded.push(state)
      return Promise.resolve({ schemaVersion: 1, ops: [] })
    },
    uncommittedCount: () => Promise.resolve(2),
    copyIns: (folder, worktree, globs) => {
      calls.copyIns.push({ folder, worktree, globs })
      return Promise.resolve({
        copied: ['.env'],
        skipped: [{ path: 'secrets/key.pem', reason: 'it is tracked' }],
        refused: [{ glob: '../x', reason: 'it leaves the folder' }],
        bytes: 10,
      })
    },
    decideDepsStage: () => Promise.resolve({ plan: null, skip: 'Nothing to install was found' }),
    // The run changed one file (a preview of no files finishes finalize without its card).
    previewApply: () =>
      Promise.resolve({
        files: [
          {
            status: 'A',
            path: 'src/version.ts',
            oldMode: '000000',
            newMode: '100644',
            oldSha: '0'.repeat(40),
            newSha: 'd'.repeat(40),
            added: 1,
            deleted: 0,
            binary: false,
            gitlink: false,
            eolOnly: false,
          },
        ],
        conflicts: [],
        actions: [{ path: 'src/version.ts', action: 'write' }],
      }),
  }
}

describe('RunController isolation effects (fake ISO_API)', () => {
  it('eligibility refused: prepare fails with worktree_failed and no worktree is made', async () => {
    const t = await setup((calls, home) => ({
      ...fakeWorktree(calls, home),
      checkEligibility: () =>
        Promise.resolve({
          ok: false,
          reasons: ['Not a git repository. Run in place instead.'],
          blockers: [],
        }),
    }))
    const s = await t.c.waitFor((x) => x.steps.prepare.status === 'failed', 30_000)
    expect(s.steps.prepare.failure).toMatchObject({
      category: 'worktree_failed',
      message: 'Not a git repository. Run in place instead.',
    })
    expect(t.calls.created).toEqual([])
  })

  it('setup: branch, write-ahead, notes; the passes run in the worktree and snapshot its shadow', async () => {
    const t = await setup((calls, home) => fakeWorktree(calls, home), { copy: ['.env', 'secrets/*'] })
    const s = await t.c.waitFor((x) => x.isolation?.finalize?.state === 'pending', 60_000)
    expect(t.calls.created).toEqual([
      { branch: 'dim/20261009-add-a-version-flag-iso1', folder: join(t.home, 'project') },
    ])
    expect(t.calls.recorded).toEqual(['created'])
    const wt = join(t.home, 'worktrees', '20261009T120000Z-iso1')
    expect(t.calls.copyIns).toEqual([
      { folder: join(t.home, 'project'), worktree: wt, globs: ['.env', 'secrets/*'] },
    ])
    expect(s.notes).toEqual(
      expect.arrayContaining([
        '2 uncommitted changes not included: the isolated run starts from the last commit.',
        'Copy-in ../x was not used: it leaves the folder',
        'Not copied into the isolated copy: secrets/key.pem (it is tracked).',
      ]),
    )
    expect(s.isolation?.rows.find((r) => r.id === 'copy')).toMatchObject({ status: 'done' })
    expect(t.starts.map((x) => [x.step, x.cwd])).toEqual([['implement', wt]])
    expect(t.calls.shadows.every((x) => x.startsWith('worktree:'))).toBe(true)
    expect(t.calls.shadows).toEqual(
      expect.arrayContaining(['worktree:run-start', 'worktree:S0', 'worktree:S1']),
    )
    // RunDoc.work records the worktree's scope (its shadow's folder key) for the Diff tab.
    expect(t.c.doc().work).toMatchObject({ folder: wt, folderKey: 'fedcba9876543210' })
  })

  it("the deps decision's error opens depsFailed with its words", async () => {
    const t = await setup((calls, home) => ({
      ...fakeWorktree(calls, home),
      decideDepsStage: () =>
        Promise.resolve({ plan: null, source: 'config', error: '`|` needs a shell: use a package script' }),
    }))
    const s = await t.c.waitFor((x) => x.cards.some((c) => c.view.kind === 'depsFailed'), 30_000)
    expect(s.cards.find((c) => c.view.kind === 'depsFailed')?.view.body).toContain('`|` needs a shell')
  })

  it('an apply that throws with an open journal apply → interruptedApply; [Finish apply] never applies twice', async () => {
    let reads = 0
    const t = await setup((calls, home) => ({
      ...fakeWorktree(calls, home),
      applyRun: () => {
        calls.applies++
        return Promise.reject(new Error('EIO: the drive went away'))
      },
      // The finish finds nothing open: the crashed apply had finished, unrecorded by the run.
      finishApply: () => Promise.resolve(null),
      journalState: () =>
        Promise.resolve(
          reads++ === 0
            ? { open: 'apply-1' }
            : { lastApplied: { token: 'apply-1', applied: ['src/version.ts'], conflicts: [] } },
        ),
    }))
    await t.c.waitFor((x) => x.isolation?.finalize?.state === 'pending', 60_000)
    const choose = async (kind: string, choiceId: string): Promise<void> => {
      const id = t.c.state.cards.find((c) => c.view.kind === kind)?.view.id ?? ''
      const r = await t.c.command({ kind: 'card', cardId: id, choiceId })
      expect(r.ok).toBe(true)
    }
    await choose('finalize', 'apply')
    const s = await t.c.waitFor((x) => x.cards.some((c) => c.view.kind === 'interruptedApply'), 30_000)
    expect(s.cards.find((c) => c.view.kind === 'interruptedApply')?.view.body).toContain(
      'EIO: the drive went away',
    )
    await choose('interruptedApply', 'finish-apply')
    const done = await t.c.waitFor((x) => x.status === 'completed', 30_000)
    expect(done.isolation?.finalize?.applies).toEqual([
      expect.objectContaining({ token: 'apply-1', applied: ['src/version.ts'] }),
    ])
    expect(t.calls.applies).toBe(1)
  })

  it("integration: an apply's conflicts reach the finalizeConflicts card with git/finalize's reasons", async () => {
    const t = await setup((calls, home) => ({
      ...fakeWorktree(calls, home),
      applyRun: () => {
        calls.applies++
        return Promise.resolve({
          applied: ['src/a.ts'],
          conflicts: ['src/version.ts'],
          undoToken: 'apply-1',
          written: ['src/a.ts'],
          deleted: [],
          unchanged: [],
          kept: [],
          skipped: [],
          resumed: false,
          preApply: 'p'.repeat(40),
          conflictDetails: [
            { path: 'src/version.ts', reason: 'It was changed in the folder after the run started.' },
          ],
        })
      },
    }))
    await t.c.waitFor((x) => x.isolation?.finalize?.state === 'pending', 60_000)
    const id = t.c.state.cards.find((c) => c.view.kind === 'finalize')?.view.id ?? ''
    expect((await t.c.command({ kind: 'card', cardId: id, choiceId: 'apply' })).ok).toBe(true)
    const s = await t.c.waitFor((x) => x.cards.some((c) => c.view.kind === 'finalizeConflicts'), 30_000)
    const card = s.cards.find((c) => c.view.kind === 'finalizeConflicts')?.view
    expect(card?.payload).toMatchObject({
      files: [{ path: 'src/version.ts', reason: 'It was changed in the folder after the run started.' }],
    })
    expect(card?.body).toContain('- src/version.ts (It was changed in the folder after the run started.)')
  })

  it('integration (E2E hook): while the hold file exists, an apply waits after each file it wrote', async () => {
    const steps: string[] = []
    let hold = ''
    const t = await setup(
      (calls, home) => ({
        ...fakeWorktree(calls, home),
        applyRun: async (_t, opts) => {
          calls.applies++
          for (const f of ['a.ts', 'b.ts']) {
            steps.push(`wrote ${f}`)
            await opts?.onStep?.('file')
          }
          steps.push('done')
          return {
            applied: ['a.ts', 'b.ts'],
            conflicts: [],
            undoToken: 'apply-1',
            written: ['a.ts', 'b.ts'],
            deleted: [],
            unchanged: [],
            kept: [],
            skipped: [],
            resumed: false,
            preApply: 'p'.repeat(40),
            conflictDetails: [],
          }
        },
      }),
      {
        e2eApplyHold: (home) => {
          hold = join(home, 'e2e', 'apply-hold')
          return hold
        },
      },
    )
    await t.c.waitFor((x) => x.isolation?.finalize?.state === 'pending', 60_000)
    mkdirSync(join(t.home, 'e2e'), { recursive: true })
    writeFileSync(hold, 'hold')
    const id = t.c.state.cards.find((c) => c.view.kind === 'finalize')?.view.id ?? ''
    expect((await t.c.command({ kind: 'card', cardId: id, choiceId: 'apply' })).ok).toBe(true)
    await t.c.waitFor(() => steps.length > 0, 30_000)
    await new Promise((r) => setTimeout(r, 500))
    // Held after the first file: the second is not written while the hold file exists.
    expect(steps).toEqual(['wrote a.ts'])
    expect(t.c.state.isolation?.finalize?.state).toBe('applying')
    unlinkSync(hold)
    const done = await t.c.waitFor((x) => x.status === 'completed', 30_000)
    expect(steps).toEqual(['wrote a.ts', 'wrote b.ts', 'done'])
    expect(done.isolation?.finalize?.state).toBe('applied')
  })
})
