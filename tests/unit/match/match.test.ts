// Matches, the parts that need no run: the sides taking turns, what makes a run a side, the record store, the view of
// a match and the tidying of its leftovers, and the command line's words.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contestantText, matchLines, parseContestant, sideStanding } from '../../../src/cli/commands/match.ts'
import { DimFactoryError } from '@core/errors.ts'
import { homePaths } from '@core/home.ts'
import { silentLogger } from '@core/log.ts'
import { batchTotal, chooseBatch } from '@core/match/batch.ts'
import { compareFiles } from '@core/match/compare.ts'
import { sideDetail } from '@core/match/detail.ts'
import { builderOf, rematchUnavailable, startGoneText, startSnapOf } from '@core/match/eligible.ts'
import { sideConfig } from '@core/match/rematch.ts'
import { MatchService, matchView } from '@core/match/service.ts'
import type { MatchDeps, PlannedRun } from '@core/match/service.ts'
import { sharedAbandoned, sharedSettled, sharesSteps } from '@core/match/shared.ts'
import { checkContestants, sideOverrides } from '@core/match/sides.ts'
import { listMatchIds, matchDir, matchFile, readMatch, removeMatch, writeMatch } from '@core/match/store.ts'
import { MatchTurns } from '@core/match/turns.ts'
import { RunOverridesZ } from '@shared/config-schema.ts'
import type { RunState } from '@core/supervisor/types.ts'
import type { FileChange } from '@shared/ipc.ts'
import { MATCH_TEXT, blindNow, sameContestant, shownOrder, splitCompare } from '@shared/match.ts'
import type { BatchPlanItem, MatchRecord } from '@shared/match.ts'
import type { QueueRematch } from '@shared/factory.ts'
import type { RunSummary } from '@shared/run.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempHome = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dim-match-unit-'))
  dirs.push(d)
  return d
}

const MATCH = '20261110T120000Z-ab12'
const RUN_A = '20261110T120001Z-aaaa'
const RUN_B = '20261110T120002Z-bbbb'
/** A run that ended, for a rematch to replay. */
const SRC = '20261109T080000Z-cccc'
const TREE = 'a'.repeat(40)
const COMMIT = 'b'.repeat(40)

const record = (over: Partial<MatchRecord> = {}): MatchRecord => ({
  schemaVersion: 1,
  matchId: MATCH,
  kind: 'headToHead',
  folder: 'C:\\work\\repo',
  folderKey: 'f'.repeat(16),
  task: 'add a --version flag',
  createdAt: 1_800_000_000_000,
  start: { tree: TREE, commit: COMMIT },
  sides: [
    { side: 'a', contestant: { vendor: 'claude' }, runId: RUN_A, displayNo: 12 },
    {
      side: 'b',
      contestant: { vendor: 'codex', model: 'gpt-x', effort: 'high' },
      runId: RUN_B,
      displayNo: 13,
    },
  ],
  ...over,
})

const summary = (runId: string, over: Partial<RunSummary> = {}): RunSummary => ({
  runId,
  displayNo: 1,
  folder: 'C:\\work\\repo',
  folderKey: 'k',
  title: 't',
  status: 'running',
  phase: 'implementing',
  profile: 'balanced',
  auto: false,
  isolation: 'worktree',
  pinned: false,
  createdAt: 1,
  progress: { tokens: 1200, costUsd: 0.4, filesChanged: 3 },
  findings: { must: 0, should: 1 },
  steps: [],
  ...over,
})

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('the sides take turns', () => {
  it('one round at a time per match, first come first served, while other matches go on', async () => {
    const turns = new MatchTurns()
    const log: string[] = []
    const round = (match: string, name: string, ms: number): Promise<string> =>
      turns.run(match, undefined, async () => {
        log.push(`${name} start`)
        await delay(ms)
        log.push(`${name} end`)
        return name
      })
    const all = await Promise.all([
      round('m1', 'a', 40),
      round('m1', 'b', 5),
      round('m2', 'x', 5),
      round('m1', 'c', 5),
    ])
    expect(all).toEqual(['a', 'b', 'x', 'c'])
    const m1 = log.filter((l) => !l.startsWith('x'))
    expect(m1).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end'])
    // The other match never waited for m1's long round.
    expect(log.indexOf('x end')).toBeLessThan(log.indexOf('a end'))
    await delay(0)
    expect(turns.active).toBe(0)
  })

  it('a round that fails gives its turn up, and its error reaches its own caller only', async () => {
    const turns = new MatchTurns()
    const bad = turns.run('m', undefined, () => Promise.reject(new Error('round failed')))
    const next = turns.run('m', undefined, () => Promise.resolve('next ran'))
    await expect(bad).rejects.toThrow('round failed')
    await expect(next).resolves.toBe('next ran')
  })

  it('a stopped round goes ahead at once and keeps its place for the one behind it', async () => {
    const turns = new MatchTurns()
    const log: string[] = []
    const first = turns.run('m', undefined, async () => {
      await delay(60)
      log.push('first end')
    })
    const stop = new AbortController()
    const stopped = turns.run('m', stop.signal, () => {
      log.push('stopped ran')
      return Promise.resolve()
    })
    const third = turns.run('m', undefined, () => {
      log.push('third ran')
      return Promise.resolve()
    })
    stop.abort()
    await stopped
    expect(log).toEqual(['stopped ran'])
    await Promise.all([first, third])
    expect(log).toEqual(['stopped ran', 'first end', 'third ran'])
    // Already stopped before it asked: no waiting at all.
    const held = turns.run('m', undefined, () => delay(40))
    await turns.run('m', stop.signal, () => {
      log.push('at once')
      return Promise.resolve()
    })
    expect(log.at(-1)).toBe('at once')
    await held
  })
})

describe('what makes a run a side', () => {
  it('the building steps take the side’s vendor, model and effort; the copy never applies itself or branches', () => {
    const o = sideOverrides(
      { profile: 'balanced', passes: { review: { vendor: 'gemini' }, implement: { extensions: 'none' } } },
      { vendor: 'codex', model: 'gpt-x', effort: 'high' },
    )
    expect(RunOverridesZ.safeParse(o).success).toBe(true)
    expect(o.profile).toBe('balanced')
    expect(o.passes?.plan).toMatchObject({ vendor: 'codex', model: 'gpt-x', effort: 'high' })
    expect(o.passes?.implement).toEqual({
      extensions: 'none',
      vendor: 'codex',
      model: 'gpt-x',
      effort: 'high',
    })
    expect(o.passes?.fix).toEqual({ vendor: 'codex', model: 'gpt-x', effort: 'high' })
    // The checking steps are the match's own.
    expect(o.passes?.review).toEqual({ vendor: 'gemini' })
    expect(o.passes?.critic).toBeUndefined()
    expect(o.isolation).toEqual({ mode: 'worktree', branch: 'none', worktree: { autoApply: false } })
  })

  it('no model means the vendor’s default, and a side always wins over what the match set for those steps', () => {
    const o = sideOverrides(
      {
        passes: { implement: { vendor: 'claude', model: 'opus' } },
        isolation: { mode: 'inPlace', branch: 'runBranch', worktree: { autoApply: true, install: 'never' } },
      },
      { vendor: 'gemini' },
    )
    expect(o.passes?.implement).toEqual({ vendor: 'gemini', model: null })
    expect(o.isolation).toEqual({
      mode: 'worktree',
      branch: 'none',
      worktree: { autoApply: false, install: 'never' },
    })
  })

  it('side A asks and researches as the person set it; side B has both off, because it is given the answers', () => {
    const base = { passes: { plan: { clarify: true, research: true } } }
    expect(sideOverrides(base, { vendor: 'claude' }, 'asks').passes?.plan).toMatchObject({
      clarify: true,
      research: true,
    })
    expect(sideOverrides(base, { vendor: 'claude' }, 'given').passes?.plan).toMatchObject({
      clarify: false,
      research: false,
    })
    expect(sideOverrides(base, { vendor: 'claude' }).passes?.plan).toMatchObject({ clarify: false })
  })

  it('the shared steps are over when each that is on has reached an end', () => {
    const st = (o: object): RunState => ({ status: 'running', outputs: {}, ...o }) as unknown as RunState
    const none = st({ config: {}, steps: {} })
    expect(sharesSteps(none)).toBe(false)
    expect(sharedSettled(none)).toBe(true)
    const asking = st({ config: { clarify: { questions: 4 } }, steps: { clarify: { status: 'waiting' } } })
    expect(sharesSteps(asking)).toBe(true)
    expect(sharedSettled(asking)).toBe(false)
    expect(sharedAbandoned(asking)).toBe(false)
    expect(sharedAbandoned({ ...asking, status: 'cancelled' })).toBe(true)
    const both = st({
      config: { clarify: { questions: 4 }, research: { lenses: [], web: false } },
      steps: { clarify: { status: 'done' }, research: { status: 'running' } },
    })
    expect(sharedSettled(both)).toBe(false)
    const over = st({
      config: { clarify: { questions: 4 }, research: { lenses: [], web: false } },
      steps: { clarify: { status: 'skipped' }, research: { status: 'done' } },
    })
    expect(sharedSettled(over)).toBe(true)
    expect(sharedAbandoned({ ...over, status: 'failed' })).toBe(false)
  })

  it('two sides, each a known vendor; the same on both is allowed and said', () => {
    const known = (v: string): boolean => v === 'claude' || v === 'codex'
    expect(checkContestants([{ vendor: 'claude' }, { vendor: 'codex' }], known)).toEqual({
      ok: true,
      problems: [],
      notes: [],
    })
    expect(checkContestants([{ vendor: 'claude' }, { vendor: 'claude' }], known).notes).toEqual([
      MATCH_TEXT.sameSides,
    ])
    expect(
      checkContestants([{ vendor: 'claude' }, { vendor: 'claude', model: 'opus' }], known).notes,
    ).toEqual([])
    expect(checkContestants([{ vendor: 'claude' }, { vendor: 'nobody' }], known)).toMatchObject({
      ok: false,
      problems: ['Side B: nobody is not a vendor Dim Factory knows.'],
    })
    expect(checkContestants([{ vendor: 'claude' }], known).problems).toEqual([MATCH_TEXT.twoSides])
    expect(sameContestant({ vendor: 'a', model: null }, { vendor: 'a' })).toBe(true)
    expect(sameContestant({ vendor: 'a', effort: 'low' }, { vendor: 'a' })).toBe(false)
  })
})

describe('the record store', () => {
  it('writes, reads and lists newest first; a damaged or foreign record reads as absent', async () => {
    const paths = homePaths(tempHome())
    expect(await listMatchIds(paths)).toEqual([])
    expect(await readMatch(paths, MATCH)).toBeNull()
    const rec = record()
    await writeMatch(paths, rec)
    expect(await readMatch(paths, MATCH)).toEqual(rec)
    const later = '20261111T090000Z-cd34'
    await writeMatch(paths, record({ matchId: later, cleanedAt: 5 }))
    expect(await listMatchIds(paths)).toEqual([later, MATCH])
    expect((await readMatch(paths, later))?.cleanedAt).toBe(5)
    // Not a match id: never read as a path.
    expect(await readMatch(paths, '..')).toBeNull()
    // Damaged, or a record whose id is not its folder's.
    writeFileSync(matchFile(paths, MATCH), '{ not json')
    expect(await readMatch(paths, MATCH)).toBeNull()
    writeFileSync(matchFile(paths, MATCH), JSON.stringify({ ...rec, matchId: later }))
    expect(await readMatch(paths, MATCH)).toBeNull()
    mkdirSync(join(paths.home, 'matches', 'not-a-match'), { recursive: true })
    expect(await listMatchIds(paths)).toEqual([later, MATCH])
    await removeMatch(paths, later)
    expect(existsSync(matchDir(paths, later))).toBe(false)
  })
})

describe('the view of a match', () => {
  const by =
    (m: Record<string, RunSummary | undefined>) =>
    (id: string): RunSummary | undefined =>
      m[id]

  it('going: one side still building', () => {
    const v = matchView(
      record(),
      by({
        [RUN_A]: summary(RUN_A, { worktree: { state: 'working', notApplied: false } }),
        [RUN_B]: summary(RUN_B, { status: 'waiting', worktree: { state: 'pending', notApplied: true } }),
      }),
    )
    expect(v).toMatchObject({ ready: false, ended: false })
    expect(v.endedAt).toBeUndefined()
    expect(v.sides[0]).toMatchObject({ status: 'running', tokens: 1200, costUsd: 0.4, filesChanged: 3 })
    expect(v.sides[1]).toMatchObject({
      copyState: 'pending',
      notApplied: true,
      findings: { must: 0, should: 1 },
    })
  })

  it('ready: both built and waiting to be applied or discarded', () => {
    const waiting = { status: 'waiting' as const, worktree: { state: 'pending' as const, notApplied: true } }
    const v = matchView(record(), by({ [RUN_A]: summary(RUN_A, waiting), [RUN_B]: summary(RUN_B, waiting) }))
    expect(v).toMatchObject({ ready: true, ended: false })
  })

  it('not ready while a side is still reading what its copy changed, the step before it asks', () => {
    const waiting = { status: 'waiting' as const, worktree: { state: 'pending' as const, notApplied: true } }
    // The run already has its outcome at that point.
    const reading = {
      status: 'running' as const,
      outcome: 'clean' as const,
      worktree: { state: 'preview' as const, notApplied: false },
    }
    const v = matchView(record(), by({ [RUN_A]: summary(RUN_A, waiting), [RUN_B]: summary(RUN_B, reading) }))
    expect(v).toMatchObject({ ready: false, ended: false })
  })

  it('ended: both runs ended, at the later end; a run that is gone counts as ended', () => {
    const v = matchView(
      record(),
      by({
        [RUN_A]: summary(RUN_A, { status: 'completed', outcome: 'clean', endedAt: 50 }),
        [RUN_B]: summary(RUN_B, { status: 'cancelled', endedAt: 90 }),
      }),
    )
    expect(v).toMatchObject({ ready: true, ended: true, endedAt: 90 })
    const gone = matchView(record(), by({}))
    expect(gone).toMatchObject({ ready: true, ended: true })
    expect(gone.sides[0].status).toBeUndefined()
  })

  it('waiting: side B has no run yet, so the match is neither ready nor ended, and its request is not shown', () => {
    const rec = record({
      sides: [record().sides[0], { side: 'b', contestant: { vendor: 'codex' } }],
      pending: { request: { folder: 'C:\\work\\repo', task: 't' } },
    })
    const v = matchView(rec, by({ [RUN_A]: summary(RUN_A, { status: 'waiting' }) }))
    expect(v).toMatchObject({ waiting: true, ready: false, ended: false })
    expect('pending' in v).toBe(false)
    expect(v.sides[1]).toEqual({ side: 'b', contestant: { vendor: 'codex' } })
  })

  it('kept: the side whose copy was applied; hidden names show the sides in their shuffled order', () => {
    const v = matchView(
      record({ blind: { swap: true } }),
      by({
        [RUN_A]: summary(RUN_A, { worktree: { state: 'kept', notApplied: true } }),
        [RUN_B]: summary(RUN_B, { worktree: { state: 'applied', notApplied: false } }),
      }),
    )
    expect(v.kept).toBe('b')
    expect(blindNow(v)).toBe(true)
    expect(shownOrder(v)).toEqual(['b', 'a'])
    // Shown again: the names are back, the order stays.
    expect(shownOrder({ blind: { swap: true, revealedAt: 5 } })).toEqual(['b', 'a'])
    expect(blindNow({ blind: { swap: true, revealedAt: 5 } })).toBe(false)
    expect(shownOrder({})).toEqual(['a', 'b'])
    expect(blindNow({})).toBe(false)
  })
})

describe('starting and tidying', () => {
  const NOW = 1_800_000_000_000
  interface World {
    deps: MatchDeps
    service: MatchService
    calls: string[]
    summaries: Record<string, RunSummary | undefined>
    runs: Set<string>
    states: Record<string, unknown>
    changed: string[]
    clock: { t: number }
    save: { ok: boolean }
    queued: { folder: string; tasks: { task: string; rematch: QueueRematch }[] }[]
    added: { vendor: string; model: string; at: number }[]
    ranIn: { vendors: string[] }
  }
  const ab = (id: string): string => (id === RUN_A ? 'a' : 'b')
  // Every run has its building steps, run or not.
  const idle = { status: 'queued', activeMs: 0 }
  const plain = { config: {}, steps: { implement: idle, fix: idle }, status: 'running', outputs: {} }
  const asking = (status: string, run = 'waiting'): unknown => ({
    config: { clarify: { questions: 4, inAuto: false } },
    steps: { clarify: { status }, implement: idle, fix: idle },
    status: run,
    outputs: {},
  })
  function world(
    o: {
      blockSide?: number
      failCreate?: number
      autoStart?: boolean
      conflicts?: string[]
      openTask?: boolean
      startGone?: boolean
      patch?: string | null
    } = {},
  ): World {
    const paths = homePaths(tempHome())
    const calls: string[] = []
    const summaries: Record<string, RunSummary | undefined> = {}
    const runs = new Set<string>()
    const states: Record<string, unknown> = {}
    const changed: string[] = []
    const clock = { t: NOW }
    const save = { ok: true }
    const queued: World['queued'] = []
    const added: World['added'] = []
    const ranIn = { vendors: ['claude'] }
    let planned = 0
    let created = 0
    const deps: MatchDeps = {
      paths,
      now: () => clock.t,
      log: silentLogger,
      knownVendor: (v) => v !== 'nobody',
      planRun: (req, hints) => {
        const i = planned++
        const hinted = hints !== undefined ? ` with ${Object.keys(hints).join(',')}` : ''
        calls.push(`plan ${req.overrides?.passes?.implement?.vendor ?? '?'}${hinted}`)
        if (o.blockSide === i) {
          return Promise.reject(
            new DimFactoryError('PREFLIGHT_BLOCKED', 'Codex needs you to log in: run codex login.', {
              details: { blocking: [] },
            }),
          )
        }
        const plan: PlannedRun = {
          create: (extra) => {
            const n = created++
            if (o.failCreate === n) return Promise.reject(new Error('disk full'))
            const runId = n === 0 ? RUN_A : RUN_B
            runs.add(runId)
            const how = extra.initState !== undefined && extra.prepare !== undefined ? ' shared' : ''
            calls.push(`create ${extra.matchOf.side}${how} from ${extra.copyFrom.tree.slice(0, 4)}`)
            return Promise.resolve({
              runId,
              displayNo: 12 + n,
              controller: {
                enqueue: (e: { t: string }) => {
                  calls.push(`${e.t} ${runId === RUN_A ? 'a' : 'b'}`)
                  return Promise.resolve()
                },
              },
            } as never)
          },
        }
        return Promise.resolve(plan)
      },
      snapshot: (_folder, id) => {
        calls.push(`snapshot ${id === '' ? '?' : 'match'}`)
        return Promise.resolve({ tree: TREE, commit: COMMIT, folderKey: 'f'.repeat(16) })
      },
      dropStartRef: () => {
        calls.push('drop ref')
        return Promise.resolve()
      },
      summary: (id) => summaries[id],
      runExists: (id) => Promise.resolve(runs.has(id)),
      stopRun: (id) => {
        calls.push(`stop ${id === RUN_A ? 'a' : 'b'}`)
        return Promise.resolve()
      },
      state: (id) =>
        Promise.resolve((states[id] ?? (runs.has(id) ? plain : undefined)) as RunState | undefined),
      worktree: {
        apply: (id) => {
          calls.push(`apply ${ab(id)}`)
          return Promise.resolve({ applied: ['src/a.ts'], conflicts: o.conflicts ?? [], undoToken: 'tok-1' })
        },
        undoApply: (id, token) => {
          calls.push(`undo ${ab(id)} ${token}`)
          return Promise.resolve()
        },
        discard: (id) => {
          calls.push(`discard ${ab(id)}`)
          return Promise.resolve({})
        },
      },
      keepForLater: (id) => {
        calls.push(`keep ${ab(id)}`)
        return Promise.resolve()
      },
      files: () => Promise.resolve(null),
      result: () => Promise.resolve(null),
      saveDiffs: (id) => {
        calls.push(`save ${ab(id)}`)
        return Promise.resolve(save.ok)
      },
      thumbnail: () => Promise.resolve(null),
      changed: (id) => void changed.push(id),
      random: () => 0.9,
      autoStart: o.autoStart ?? true,
      planRematch: (runId, c) => {
        calls.push(`plan rematch of ${runId === SRC ? 'src' : runId} for ${c.vendor}`)
        const plan: PlannedRun = {
          create: (extra) => {
            const side = extra.matchOf.side
            const id = side === 'a' ? RUN_A : RUN_B
            runs.add(id)
            calls.push(
              `create ${side}${extra.matchOf.rematch === true ? ' rematch' : ''} from ${extra.copyFrom.tree.slice(0, 4)}`,
            )
            return Promise.resolve({
              runId: id,
              displayNo: side === 'a' ? 12 : 13,
              controller: {
                enqueue: (e: { t: string }) => {
                  calls.push(`${e.t} ${side}`)
                  return Promise.resolve()
                },
              },
            } as never)
          },
        }
        return Promise.resolve(plan)
      },
      hasStart: () => Promise.resolve(o.startGone !== true),
      vendorsRanIn: () => ranIn.vendors,
      pin: (id) => {
        calls.push(`pin ${id === SRC ? 'src' : id}`)
        return Promise.resolve()
      },
      patchOf: () => Promise.resolve(o.patch === undefined ? 'diff --git a/x b/x\n' : o.patch),
      openTask: () => Promise.resolve(o.openTask === true),
      runs: () => Object.values(summaries).filter((s): s is RunSummary => s !== undefined),
      queueAdd: (folder, tasks) => {
        queued.push({ folder, tasks })
        return Promise.resolve()
      },
      addedModels: () => Promise.resolve(added),
    }
    return {
      deps,
      service: new MatchService(deps),
      calls,
      summaries,
      runs,
      states,
      changed,
      clock,
      save,
      queued,
      added,
      ranIn,
    }
  }
  const req = {
    folder: 'C:\\work\\repo',
    task: 'add a --version flag',
    sides: [{ vendor: 'claude' }, { vendor: 'codex', model: 'gpt-x' }],
  }

  it('both sides are checked, then one snapshot, then each run is made and started, side A first', async () => {
    const w = world()
    const m = await w.service.start(req)
    expect(w.calls).toEqual([
      'plan claude',
      'plan codex',
      'snapshot match',
      `create a from ${TREE.slice(0, 4)}`,
      'created a',
      `create b from ${TREE.slice(0, 4)}`,
      'created b',
    ])
    expect(m.sides).toEqual([
      { side: 'a', runId: RUN_A, displayNo: 12 },
      { side: 'b', runId: RUN_B, displayNo: 13 },
    ])
    const rec = await readMatch(w.deps.paths, m.matchId)
    expect(rec).toMatchObject({
      kind: 'headToHead',
      task: req.task,
      start: { tree: TREE, commit: COMMIT },
      sides: [
        { side: 'a', contestant: { vendor: 'claude' }, runId: RUN_A },
        { side: 'b', contestant: { vendor: 'codex', model: 'gpt-x' }, runId: RUN_B },
      ],
    })
    expect((await w.service.list()).map((v) => v.matchId)).toEqual([m.matchId])
    expect((await w.service.get(m.matchId)).matchId).toBe(m.matchId)
  })

  it('a side that cannot start stops the match before anything is made, and the error names the side', async () => {
    const w = world({ blockSide: 1 })
    const err = await w.service.start(req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DimFactoryError)
    expect((err as DimFactoryError).code).toBe('PREFLIGHT_BLOCKED')
    expect((err as DimFactoryError).message).toBe(
      'Side B cannot start. Codex needs you to log in: run codex login.',
    )
    expect((err as DimFactoryError).details).toEqual({ blocking: [] })
    expect(w.calls).toEqual(['plan claude', 'plan codex'])
    expect(await w.service.list()).toEqual([])
  })

  it('refuses what is not a match before any check', async () => {
    const w = world()
    await expect(w.service.start({ ...req, task: '  ' })).rejects.toThrow(MATCH_TEXT.noTask)
    await expect(w.service.start({ ...req, folder: '' })).rejects.toThrow(MATCH_TEXT.noFolder)
    await expect(w.service.start({ ...req, sides: [{ vendor: 'claude' }] })).rejects.toThrow(
      MATCH_TEXT.twoSides,
    )
    await expect(
      w.service.start({ ...req, sides: [{ vendor: 'claude' }, { vendor: 'nobody' }] }),
    ).rejects.toThrow('Side B: nobody is not a vendor Dim Factory knows.')
    expect(w.calls).toEqual([])
  })

  it('when the second run cannot be made, the first is started and stopped, and the starting ref is dropped', async () => {
    const w = world({ failCreate: 1 })
    await expect(w.service.start(req)).rejects.toThrow('The match could not be started: disk full')
    expect(w.calls.slice(3)).toEqual([`create a from ${TREE.slice(0, 4)}`, 'created a', 'stop a', 'drop ref'])
    expect(await w.service.list()).toEqual([])
  })

  it('get refuses an id that is not a match', async () => {
    const w = world()
    await expect(w.service.get('nope')).rejects.toThrow(MATCH_TEXT.notFound)
    await expect(w.service.get(MATCH)).rejects.toThrow(MATCH_TEXT.notFound)
  })

  it('the starting ref goes once both copies exist, and the record once both runs are gone', async () => {
    const w = world()
    const m = await w.service.start(req)
    w.calls.length = 0
    // One side is still making its copy: the snapshot is still needed.
    w.summaries[RUN_A] = summary(RUN_A, { worktree: { state: 'preparing', notApplied: false } })
    w.summaries[RUN_B] = summary(RUN_B, { worktree: { state: 'working', notApplied: false } })
    expect(await w.service.sweep()).toEqual({ refsDropped: [], removed: [], copiesRemoved: [] })
    expect(w.calls).toEqual([])
    // Both copies exist.
    w.summaries[RUN_A] = summary(RUN_A, { worktree: { state: 'working', notApplied: false } })
    expect(await w.service.sweep()).toEqual({ refsDropped: [m.matchId], removed: [], copiesRemoved: [] })
    expect(w.calls).toEqual(['drop ref'])
    expect((await w.service.get(m.matchId)).cleanedAt).toBe(1_800_000_000_000)
    // Nothing more to do while a run is still in the history.
    expect(await w.service.sweep()).toEqual({ refsDropped: [], removed: [], copiesRemoved: [] })
    w.summaries[RUN_A] = undefined
    expect(await w.service.sweep()).toEqual({ refsDropped: [], removed: [], copiesRemoved: [] })
    // Both runs gone from the history and from disk: the record goes (the ref was dropped already).
    w.summaries[RUN_B] = undefined
    w.runs.clear()
    expect(await w.service.sweep()).toEqual({ refsDropped: [], removed: [m.matchId], copiesRemoved: [] })
    expect(w.calls).toEqual(['drop ref'])
    expect(await w.service.list()).toEqual([])
  })

  it('a run with no summary but still on disk keeps its match', async () => {
    const w = world()
    const m = await w.service.start(req)
    expect(await w.service.sweep()).toEqual({ refsDropped: [], removed: [], copiesRemoved: [] })
    expect((await w.service.list()).map((v) => v.matchId)).toEqual([m.matchId])
  })

  const ofA = (matchId: string): RunSummary => summary(RUN_A, { matchOf: { matchId, side: 'a' } })
  const built = { status: 'waiting' as const, worktree: { state: 'pending' as const, notApplied: true } }

  it('side B waits while side A asks, and starts from side A’s answers when they are in', async () => {
    const w = world()
    w.states[RUN_A] = asking('waiting')
    const m = await w.service.start(req)
    expect(m.sides[1]).toEqual({ side: 'b' })
    const first = [
      'plan claude',
      'plan codex',
      'snapshot match',
      `create a from ${TREE.slice(0, 4)}`,
      'created a',
    ]
    expect(w.calls).toEqual(first)
    expect(await w.service.get(m.matchId)).toMatchObject({ waiting: true, ready: false, ended: false })
    // Side A still asking: its summaries and a sweep change nothing, and the starting point is kept for side B.
    w.service.onSummary(ofA(m.matchId))
    expect(await w.service.sweep()).toEqual({ refsDropped: [], removed: [], copiesRemoved: [] })
    expect(w.calls).toEqual(first)
    // Answered: side B is checked again and made with side A's answers.
    w.states[RUN_A] = asking('done', 'running')
    w.service.onSummary(ofA(m.matchId))
    await vi.waitFor(() => expect(w.calls.at(-1)).toBe('created b'))
    expect(w.calls.slice(first.length)).toEqual([
      'plan codex',
      `create b shared from ${TREE.slice(0, 4)}`,
      'created b',
    ])
    const v = await w.service.get(m.matchId)
    expect(v).toMatchObject({ waiting: false, shared: true })
    expect(v.sides[1]).toMatchObject({ runId: RUN_B, displayNo: 13 })
    expect(w.changed).toEqual([m.matchId])
    // Later summaries of side A start nothing more.
    w.service.onSummary(ofA(m.matchId))
    await new Promise((r) => setTimeout(r, 20))
    expect(w.calls.at(-1)).toBe('created b')
  })

  it('what the caller knows about the task shapes both sides, and a side B started later still has it', async () => {
    const hints = { easy: true, newProject: true }
    const w = world()
    await w.service.start({ ...req, hints })
    expect(w.calls.slice(0, 2)).toEqual([
      'plan claude with easy,newProject',
      'plan codex with easy,newProject',
    ])
    // Side A asks first: the hints wait with the request, out of the view, and side B is planned with them.
    const late = world()
    late.states[RUN_A] = asking('waiting')
    const m = await late.service.start({ ...req, hints })
    expect((await readMatch(late.deps.paths, m.matchId))?.pending?.hints).toEqual(hints)
    expect(await late.service.get(m.matchId)).not.toHaveProperty('pending')
    late.states[RUN_A] = asking('done', 'running')
    late.service.onSummary(ofA(m.matchId))
    await vi.waitFor(() => expect(late.calls.at(-1)).toBe('created b'))
    expect(late.calls.at(-3)).toBe('plan codex with easy,newProject')
    expect((await readMatch(late.deps.paths, m.matchId))?.pending).toBeUndefined()
  })

  it('side A stopping before its questions are answered leaves side B unstarted, with the reason', async () => {
    const w = world()
    w.states[RUN_A] = asking('waiting')
    const m = await w.service.start(req)
    w.states[RUN_A] = asking('waiting', 'cancelled')
    w.service.onSummary(ofA(m.matchId))
    await vi.waitFor(async () => expect((await w.service.get(m.matchId)).waiting).toBe(false))
    const v = await w.service.get(m.matchId)
    expect(v.sides[1]).toEqual({
      side: 'b',
      contestant: { vendor: 'codex', model: 'gpt-x' },
      notStarted: MATCH_TEXT.aStoppedFirst,
    })
    expect(w.calls).not.toContain('created b')
  })

  it('a command-line process leaves a waiting side B for the app to start', async () => {
    const w = world({ autoStart: false })
    w.states[RUN_A] = asking('waiting')
    const m = await w.service.start(req)
    w.states[RUN_A] = asking('done', 'running')
    w.service.onSummary(ofA(m.matchId))
    await w.service.sweep()
    expect((await w.service.get(m.matchId)).waiting).toBe(true)
    expect(w.calls).not.toContain('created b')
    // The app's next start (the same record, a process that does start it).
    const app = new MatchService({ ...w.deps, autoStart: true })
    await app.sweep()
    expect((await app.get(m.matchId)).sides[1]).toMatchObject({ runId: RUN_B })
  })

  it('keeping a side applies it and keeps the other for later; the pick can be taken back', async () => {
    const w = world()
    const m = await w.service.start(req)
    w.summaries[RUN_A] = summary(RUN_A, { worktree: { state: 'working', notApplied: false } })
    w.summaries[RUN_B] = summary(RUN_B, built)
    await expect(w.service.pick(m.matchId, 'b')).rejects.toThrow(MATCH_TEXT.notReady)
    w.summaries[RUN_A] = summary(RUN_A, built)
    w.calls.length = 0
    const r = await w.service.pick(m.matchId, 'a')
    expect(w.calls).toEqual(['apply a', 'keep b'])
    expect(r.conflicts).toEqual([])
    expect(r.match.pick).toEqual({ side: 'a', at: NOW, undoToken: 'tok-1' })
    await expect(w.service.pick(m.matchId, 'b')).rejects.toThrow(MATCH_TEXT.alreadyPicked)
    w.calls.length = 0
    const undone = await w.service.undoPick(m.matchId)
    expect(w.calls).toEqual(['undo a tok-1'])
    expect(undone.pick).toBeUndefined()
    await expect(w.service.undoPick(m.matchId)).rejects.toThrow(MATCH_TEXT.noPick)
  })

  it('keeping neither keeps both for later; a side with nothing to keep is refused', async () => {
    const w = world()
    const m = await w.service.start(req)
    w.summaries[RUN_A] = summary(RUN_A, built)
    w.summaries[RUN_B] = summary(RUN_B, {
      status: 'completed',
      outcome: 'clean',
      endedAt: 5,
      worktree: { state: 'kept', notApplied: false },
    })
    await expect(w.service.pick(m.matchId, 'b')).rejects.toThrow(MATCH_TEXT.nothingToKeep('Side B'))
    w.calls.length = 0
    const r = await w.service.pick(m.matchId, 'none')
    expect(w.calls).toEqual(['keep a', 'keep b'])
    expect(r.match.pick).toEqual({ side: 'none', at: NOW })
    w.calls.length = 0
    await w.service.undoPick(m.matchId)
    expect(w.calls).toEqual([])
  })

  it('files the folder changed since the match began come back with the pick', async () => {
    const w = world({ conflicts: ['src/a.ts'] })
    const m = await w.service.start(req)
    w.summaries[RUN_A] = summary(RUN_A, built)
    w.summaries[RUN_B] = summary(RUN_B, built)
    const r = await w.service.pick(m.matchId, 'b')
    expect(r.conflicts).toEqual(['src/a.ts'])
    expect(r.match.pick?.side).toBe('b')
  })

  it('a side already in the folder cannot be replaced by picking the other', async () => {
    const w = world()
    const m = await w.service.start(req)
    w.summaries[RUN_A] = summary(RUN_A, {
      status: 'completed',
      endedAt: 5,
      worktree: { state: 'applied', notApplied: false },
    })
    w.summaries[RUN_B] = summary(RUN_B, built)
    await expect(w.service.pick(m.matchId, 'b')).rejects.toThrow('Side A is already in the folder.')
    w.calls.length = 0
    // Picking the side that is already there records the pick and applies nothing again.
    const r = await w.service.pick(m.matchId, 'a')
    expect(w.calls).toEqual(['keep b'])
    expect(r.match.pick).toEqual({ side: 'a', at: NOW })
  })

  it('names are hidden from the start or later, and a pick shows them again for good', async () => {
    const w = world()
    const m = await w.service.start({ ...req, blind: true })
    expect((await w.service.get(m.matchId)).blind).toEqual({ swap: false })
    expect((await w.service.setBlind(m.matchId, false)).blind).toEqual({ swap: false, revealedAt: NOW })
    expect((await w.service.setBlind(m.matchId, true)).blind).toEqual({ swap: false })
    w.summaries[RUN_A] = summary(RUN_A, built)
    w.summaries[RUN_B] = summary(RUN_B, built)
    const r = await w.service.pick(m.matchId, 'a')
    expect(r.match.blind).toEqual({ swap: false, revealedAt: NOW })
    await expect(w.service.setBlind(m.matchId, true)).rejects.toThrow(MATCH_TEXT.blindAfterPick)
  })

  const source = (over: object = {}): unknown => ({
    runId: SRC,
    displayNo: 7,
    folder: 'C:\\work\\repo',
    folderKey: 'f'.repeat(16),
    task: 'add a --version flag',
    title: 'Add a --version flag',
    status: 'completed',
    config: { isolation: 'inPlace' },
    steps: { implement: { status: 'done', activeMs: 5, vendor: 'claude', model: 'opus' }, fix: idle },
    snapshots: { 'run-start': { label: 'run-start', tree: TREE, commit: COMMIT, at: 1 } },
    outputs: {},
    ...over,
  })

  it('a rematch: the run as recorded against a challenger built now from where the run began', async () => {
    const w = world({ openTask: true })
    w.states[SRC] = source()
    const m = await w.service.rematch({ runId: SRC, challenger: { vendor: 'claude', model: 'sonnet' } })
    expect(w.calls).toEqual([
      'plan rematch of src for claude',
      `create b rematch from ${TREE.slice(0, 4)}`,
      'pin src',
      'created b',
    ])
    expect(m.sides).toEqual([
      { side: 'a', runId: SRC, displayNo: 7 },
      { side: 'b', runId: RUN_B, displayNo: 13 },
    ])
    const rec = await readMatch(w.deps.paths, m.matchId)
    expect(rec).toMatchObject({
      kind: 'rematch',
      task: 'add a --version flag',
      start: { tree: TREE, commit: COMMIT },
      source: { runId: SRC, displayNo: 7 },
      openTask: true,
      cleanedAt: NOW,
      sides: [
        { side: 'a', contestant: { vendor: 'claude', model: 'opus' }, runId: SRC, recorded: true },
        { side: 'b', contestant: { vendor: 'claude', model: 'sonnet' }, runId: RUN_B },
      ],
    })
    // The match holds no ref of its own, so there is none to drop; the record stays while a run is there.
    w.summaries[SRC] = summary(SRC, { status: 'completed', endedAt: 5 })
    w.calls.length = 0
    expect(await w.service.sweep()).toEqual({ refsDropped: [], removed: [], copiesRemoved: [] })
    expect(w.calls).toEqual([])
  })

  it('a vendor that has not run in the project is asked about once, before anything is made', async () => {
    const w = world()
    w.states[SRC] = source()
    const err = await w.service
      .rematch({ runId: SRC, challenger: { vendor: 'codex' } })
      .catch((e: unknown) => e)
    expect((err as DimFactoryError).code).toBe('CONFLICT')
    expect((err as DimFactoryError).message).toBe(MATCH_TEXT.newVendor('codex'))
    expect((err as DimFactoryError).details).toEqual({ newVendor: 'codex' })
    expect(w.calls).toEqual([])
    const m = await w.service.rematch({ runId: SRC, challenger: { vendor: 'codex' }, confirmNewVendor: true })
    expect(m.sides[1]).toMatchObject({ runId: RUN_B })
    await expect(
      w.service.rematch({ runId: SRC, challenger: { vendor: 'nobody' }, confirmNewVendor: true }),
    ).rejects.toThrow('Side B: nobody is not a vendor Dim Factory knows.')
  })

  it('run both fresh: the original’s builder builds again too, so both sides are from now', async () => {
    const w = world()
    w.states[SRC] = source()
    const m = await w.service.rematch({
      runId: SRC,
      challenger: { vendor: 'claude' },
      fresh: true,
      blind: true,
    })
    expect(w.calls).toEqual([
      'plan rematch of src for claude',
      'plan rematch of src for claude',
      `create a rematch from ${TREE.slice(0, 4)}`,
      `create b rematch from ${TREE.slice(0, 4)}`,
      'pin src',
      'created a',
      'created b',
    ])
    const rec = await readMatch(w.deps.paths, m.matchId)
    expect(rec?.sides[0]).toEqual({
      side: 'a',
      contestant: { vendor: 'claude', model: 'opus' },
      runId: RUN_A,
      displayNo: 12,
    })
    expect(rec?.blind).toEqual({ swap: false })
    expect(rec?.source).toEqual({ runId: SRC, displayNo: 7 })
  })

  it('a run that cannot be replayed says why, to the check and to the start', async () => {
    const w = world({ startGone: true })
    w.states[SRC] = source()
    expect(await w.service.rematchCheck(SRC)).toEqual({
      displayNo: 7,
      task: 'add a --version flag',
      original: { vendor: 'claude', model: 'opus' },
      knownVendors: ['claude'],
      blocked: "Run #7's starting snapshot was cleared, so there is nothing to replay it from.",
    })
    await expect(w.service.rematch({ runId: SRC, challenger: { vendor: 'claude' } })).rejects.toThrow(
      'starting snapshot was cleared',
    )
    w.states[SRC] = source({ status: 'running' })
    expect((await w.service.rematchCheck(SRC)).blocked).toContain('is still going')
    expect((await w.service.rematchCheck('20200101T000000Z-0000')).blocked).toContain('is not here any more')
    const ok = world()
    ok.states[SRC] = source()
    expect((await ok.service.rematchCheck(SRC)).blocked).toBeUndefined()
    expect(ok.calls).toEqual([])
  })

  it('a rematch’s pick is a judgement: nothing is applied, and after 7 days the built side’s copy goes', async () => {
    const w = world()
    w.states[SRC] = source()
    const m = await w.service.rematch({ runId: SRC, challenger: { vendor: 'claude', model: 'sonnet' } })
    w.summaries[SRC] = summary(SRC, { status: 'completed', endedAt: 5 })
    w.summaries[RUN_B] = summary(RUN_B, {
      status: 'completed',
      endedAt: NOW,
      worktree: { state: 'kept', notApplied: true },
    })
    w.calls.length = 0
    const r = await w.service.pick(m.matchId, 'b')
    expect(r.match.pick).toEqual({ side: 'b', at: NOW })
    expect(r.match.kept).toBeUndefined()
    expect(w.calls.filter((c) => c.startsWith('apply'))).toEqual([])
    // The recorded side can be the pick as well: it has no copy and needs none.
    await w.service.undoPick(m.matchId)
    expect(w.calls.filter((c) => c.startsWith('undo'))).toEqual([])
    expect((await w.service.pick(m.matchId, 'a')).match.pick).toEqual({ side: 'a', at: NOW })
    await w.service.undoPick(m.matchId)
    await w.service.pick(m.matchId, 'b')
    w.calls.length = 0
    w.clock.t = NOW + 7 * 24 * 60 * 60_000
    // The picked side's copy goes too (it is never applied); the recorded run is left alone.
    expect((await w.service.sweep()).copiesRemoved).toEqual([RUN_B])
    expect(w.calls).toEqual(['save b', 'discard b'])
  })

  it('a match that has ended keeps its result in its record, and the scoreboard reads it when the runs are gone', async () => {
    const w = world()
    w.states[SRC] = source({ category: 'documents' })
    const m = await w.service.rematch({ runId: SRC, challenger: { vendor: 'claude', model: 'sonnet' } })
    // Still building: listed, not scored.
    w.summaries[SRC] = summary(SRC, { status: 'completed', endedAt: 5 })
    w.summaries[RUN_B] = summary(RUN_B, { worktree: { state: 'working', notApplied: false } })
    let board = await w.service.scoreboard()
    expect(board.rows).toEqual([])
    expect(board.matches).toEqual([
      {
        matchId: m.matchId,
        kind: 'rematch',
        category: 'software',
        at: NOW,
        task: 'add a --version flag',
        sides: [
          { vendor: 'claude', model: 'opus' },
          { vendor: 'claude', model: 'sonnet' },
        ],
        ended: false,
      },
    ])
    // Both ended: a pick saves how it ended with the record.
    w.states[RUN_B] = {
      ...(plain as object),
      steps: {
        implement: { status: 'done', activeMs: 4000, vendor: 'claude' },
        fix: idle,
        'verify:1': {
          status: 'done',
          activeMs: 1,
          verify: { phase: 'done', commands: [{ status: 'pass' }] },
        },
      },
    }
    w.summaries[RUN_B] = summary(RUN_B, {
      status: 'completed',
      endedAt: NOW,
      progress: { tokens: 10, costUsd: 0.25, filesChanged: 1 },
      worktree: { state: 'kept', notApplied: true },
    })
    await w.service.pick(m.matchId, 'b')
    const rec = await readMatch(w.deps.paths, m.matchId)
    expect(rec?.result).toEqual({
      at: NOW,
      category: 'documents',
      sides: [
        { builder: { vendor: 'claude', model: 'opus' }, finished: true, costUsd: 0.4, buildMs: 5 },
        {
          builder: { vendor: 'claude', model: 'sonnet' },
          finished: true,
          checks: { passed: 1, failed: 0 },
          costUsd: 0.25,
          buildMs: 4000,
        },
      ],
    })
    // The runs go; the scoreboard still has the match.
    w.summaries[SRC] = undefined
    w.summaries[RUN_B] = undefined
    w.states[SRC] = undefined
    w.states[RUN_B] = undefined
    board = await w.service.scoreboard()
    expect(board.matches[0]).toMatchObject({ category: 'documents', pick: 'b', ended: true })
    expect(board.rows.map((r) => [r.category, r.builder.model, r.matches, r.judged, r.picked])).toEqual([
      ['documents', 'opus', 1, 1, 0],
      ['documents', 'sonnet', 1, 1, 1],
    ])
    expect(board.suggestions).toEqual([])
  })

  it('a match nobody picked in keeps its result at the next tidying', async () => {
    const w = world()
    const m = await w.service.start(req)
    w.summaries[RUN_A] = summary(RUN_A, { status: 'completed', endedAt: NOW })
    w.summaries[RUN_B] = summary(RUN_B, { status: 'failed', endedAt: NOW })
    await w.service.sweep()
    const rec = await readMatch(w.deps.paths, m.matchId)
    expect(rec?.result?.sides.map((s) => [s.builder.vendor, s.finished])).toEqual([
      ['claude', true],
      ['codex', false],
    ])
    expect(rec?.result?.category).toBe('software')
  })

  /** Finished runs in the history, each replayable, for a batch to choose from. */
  const past = (w: World, n: number, over: Partial<RunSummary> = {}, state: object = {}): string => {
    const id = `2026110${n}T080000Z-${String(n).repeat(4)}`
    w.summaries[id] = summary(id, {
      displayNo: n,
      title: `Task ${n}`,
      status: 'completed',
      // A run that worked in the folder itself.
      isolation: 'inPlace',
      endedAt: n,
      createdAt: n,
      folderKey: 'f'.repeat(16),
      progress: { tokens: 1, costUsd: n, filesChanged: 1 },
      ...over,
    })
    w.states[id] = source({ runId: id, displayNo: n, ...state })
    return id
  }
  const CODEX = { vendor: 'codex', model: 'gpt-x' }

  it('a batch replays up to five finished runs another builder made, cheapest first, with the total', async () => {
    const w = world()
    w.ranIn.vendors = ['claude', 'codex']
    const ids = [1, 2, 3, 4, 5, 6, 7].map((n) => past(w, n))
    // Not candidates: still going, one side of a match, made in an isolated copy, already built by the challenger.
    past(w, 8, { status: 'running', endedAt: undefined as never })
    past(w, 9, { isolation: 'worktree' })
    w.states[ids[6] ?? ''] = source({
      runId: ids[6],
      displayNo: 7,
      steps: {
        implement: { status: 'done', activeMs: 1, vendor: 'codex', model: 'gpt-x' },
        fix: { status: 'queued' },
      },
    })
    const plan = await w.service.batchPlan(CODEX)
    expect(plan.challenger).toEqual(CODEX)
    // The five newest of the six left, cheapest first.
    expect(plan.items.map((i) => i.displayNo)).toEqual([2, 3, 4, 5, 6])
    expect(plan.items[0]).toEqual({
      runId: ids[1],
      displayNo: 2,
      title: 'Task 2',
      folder: 'C:\\work\\repo',
      category: 'software',
      costUsd: 2,
    })
    expect(plan.totalUsd).toBe(20)
    expect(plan.newVendorLeftOut).toBe(0)
    expect(w.calls).toEqual([])
  })

  it('a project the challenger’s vendor has never run in is left out and counted; a rematch there asks first', async () => {
    const w = world()
    past(w, 1)
    past(w, 2)
    const plan = await w.service.batchPlan(CODEX)
    expect(plan.items).toEqual([])
    expect(plan.newVendorLeftOut).toBe(2)
    expect(plan.totalUsd).toBeNull()
  })

  it('adding a batch queues each rematch in its folder’s queue with the names hidden, and only what the plan still holds', async () => {
    const w = world()
    w.ranIn.vendors = ['claude', 'codex']
    const a = past(w, 1)
    const b = past(w, 2, { folder: 'C:\\work\\other' })
    const r = await w.service.batchAdd(CODEX, [a, b, '20200101T000000Z-0000'])
    expect(r).toEqual({ added: 2, skipped: 1 })
    expect(w.queued).toEqual([
      {
        folder: 'C:\\work\\repo',
        tasks: [{ task: 'Task 1', rematch: { runId: a, displayNo: 1, challenger: CODEX, blind: true } }],
      },
      {
        folder: 'C:\\work\\other',
        tasks: [{ task: 'Task 2', rematch: { runId: b, displayNo: 2, challenger: CODEX, blind: true } }],
      },
    ])
    // Nothing is started here: the queue starts them.
    expect(w.calls).toEqual([])
    await expect(w.service.batchAdd({ vendor: 'nobody' }, [a])).rejects.toThrow('nobody is not a vendor')
  })

  it('a run already replayed against a builder is not in that builder’s next batch', async () => {
    const w = world()
    w.ranIn.vendors = ['claude', 'codex']
    past(w, 1)
    w.states[SRC] = source()
    w.summaries[SRC] = summary(SRC, {
      displayNo: 7,
      status: 'completed',
      isolation: 'inPlace',
      endedAt: 9,
      createdAt: 9,
    })
    // Cheapest first: run #7 cost less than run #1.
    expect((await w.service.batchPlan(CODEX)).items.map((i) => i.displayNo)).toEqual([7, 1])
    await w.service.rematch({ runId: SRC, challenger: CODEX })
    expect((await w.service.batchPlan(CODEX)).items.map((i) => i.displayNo)).toEqual([1])
    // Against another builder it still is.
    expect(
      (await w.service.batchPlan({ vendor: 'codex', model: 'gpt-y' })).items.map((i) => i.displayNo),
    ).toEqual([7, 1])
  })

  it('a model the catalog got lately is offered once: not when a match tried it, it was set aside, or it is old', async () => {
    const w = world()
    w.ranIn.vendors = ['claude', 'codex']
    past(w, 1)
    const day = 24 * 60 * 60_000
    w.added.push(
      { vendor: 'codex', model: 'gpt-new', at: NOW - day },
      { vendor: 'codex', model: 'gpt-new', at: NOW - 2 * day },
      { vendor: 'codex', model: 'gpt-old', at: NOW - 31 * day },
      { vendor: 'nobody', model: 'x', at: NOW - day },
      { vendor: 'claude', model: 'haiku-new', at: NOW - 3 * day },
    )
    const offers = await w.service.offers()
    expect(offers.map((o) => [o.vendor, o.model, o.plan.items.length])).toEqual([
      ['codex', 'gpt-new', 1],
      ['claude', 'haiku-new', 1],
    ])
    expect(offers[0]?.at).toBe(NOW - day)
    // Set aside: not offered again, also by a service started later.
    await w.service.dismissOffer('codex', 'gpt-new')
    expect((await new MatchService(w.deps).offers()).map((o) => o.model)).toEqual(['haiku-new'])
    // Tried in a match: not offered.
    w.states[SRC] = source()
    await w.service.rematch({ runId: SRC, challenger: { vendor: 'claude', model: 'haiku-new' } })
    expect(await w.service.offers()).toEqual([])
  })

  it('with nothing to replay there is no offer', async () => {
    const w = world()
    w.added.push({ vendor: 'claude', model: 'haiku-new', at: NOW })
    expect(await w.service.offers()).toEqual([])
  })

  it('a side’s changes are saved as one patch beside the record', async () => {
    const w = world({ patch: 'diff --git a/src/a.ts b/src/a.ts\n+one\n' })
    w.states[SRC] = source()
    const m = await w.service.rematch({ runId: SRC, challenger: { vendor: 'claude' } })
    const saved = await w.service.savePatch(m.matchId, 'b')
    expect(saved.path).toBe(join(matchDir(w.deps.paths, m.matchId), 'side-b.patch'))
    expect(saved.bytes).toBe(38)
    expect(readFileSync(saved.path, 'utf8')).toBe('diff --git a/src/a.ts b/src/a.ts\n+one\n')
    const gone = world({ patch: null })
    gone.states[SRC] = source()
    const g = await gone.service.rematch({ runId: SRC, challenger: { vendor: 'claude' } })
    await expect(gone.service.savePatch(g.matchId, 'a')).rejects.toThrow(MATCH_TEXT.noPatch)
  })

  it('seven days after a pick the other side’s copy goes, once its changes are saved to read', async () => {
    const w = world()
    const m = await w.service.start(req)
    w.summaries[RUN_A] = summary(RUN_A, built)
    w.summaries[RUN_B] = summary(RUN_B, built)
    await w.service.pick(m.matchId, 'a')
    w.summaries[RUN_A] = summary(RUN_A, {
      status: 'completed',
      endedAt: NOW,
      worktree: { state: 'applied', notApplied: false },
    })
    w.summaries[RUN_B] = summary(RUN_B, {
      status: 'completed',
      endedAt: NOW,
      worktree: { state: 'kept', notApplied: true },
    })
    w.calls.length = 0
    expect(await w.service.sweep()).toEqual({ refsDropped: [m.matchId], removed: [], copiesRemoved: [] })
    w.clock.t = NOW + 7 * 24 * 60 * 60_000 - 1
    expect((await w.service.sweep()).copiesRemoved).toEqual([])
    expect(w.calls).toEqual(['drop ref'])
    // Due, but the changes cannot be saved: the copy stays, and it is tried again next time.
    w.clock.t += 1
    w.save.ok = false
    expect((await w.service.sweep()).copiesRemoved).toEqual([])
    expect(w.calls).toEqual(['drop ref', 'save b'])
    w.save.ok = true
    expect((await w.service.sweep()).copiesRemoved).toEqual([RUN_B])
    expect(w.calls).toEqual(['drop ref', 'save b', 'save b', 'discard b'])
    expect((await w.service.get(m.matchId)).pick?.copiesRemovedAt).toBe(w.clock.t)
    expect((await w.service.sweep()).copiesRemoved).toEqual([])
    expect(w.calls).toHaveLength(4)
  })

  it('a copy the person did something with since the pick is left to them', async () => {
    const w = world()
    const m = await w.service.start(req)
    w.summaries[RUN_A] = summary(RUN_A, built)
    w.summaries[RUN_B] = summary(RUN_B, built)
    await w.service.pick(m.matchId, 'none')
    w.summaries[RUN_A] = summary(RUN_A, {
      status: 'completed',
      endedAt: NOW,
      worktree: { state: 'applied', notApplied: false },
    })
    w.summaries[RUN_B] = summary(RUN_B, built)
    w.clock.t = NOW + 8 * 24 * 60 * 60_000
    w.calls.length = 0
    expect((await w.service.sweep()).copiesRemoved).toEqual([])
    expect(w.calls).toEqual(['drop ref'])
  })
})

describe('a rematch', () => {
  const idle = { status: 'queued', activeMs: 0 }
  const ended = (over: object = {}): RunState =>
    ({
      runId: SRC,
      displayNo: 7,
      folder: 'C:\\work\\repo',
      folderKey: 'f'.repeat(16),
      task: 'add a --version flag',
      title: 'Add a --version flag',
      status: 'completed',
      config: { isolation: 'inPlace' },
      steps: {
        plan: { status: 'done', activeMs: 1, vendor: 'claude' },
        implement: { status: 'done', activeMs: 5, vendor: 'claude', model: 'opus', effort: 'high' },
        fix: idle,
      },
      snapshots: { 'run-start': { label: 'run-start', tree: TREE, commit: COMMIT, at: 1 } },
      outputs: {},
      ...over,
    }) as unknown as RunState

  it('replays a run that ended, started from a task and worked in the folder itself', () => {
    expect(rematchUnavailable(ended())).toBeUndefined()
    expect(rematchUnavailable(ended({ status: 'running' }))).toBe(
      'Run #7 is still going. A rematch replays a run that has ended.',
    )
    expect(rematchUnavailable(ended({ status: 'failed' }))).toBeUndefined()
    expect(rematchUnavailable(ended({ rerunOf: { runId: 'x', displayNo: 3, from: 'fix' } }))).toContain(
      'was a Re-run from Fix',
    )
    expect(
      rematchUnavailable(ended({ rerunOf: { runId: 'x', displayNo: 3, from: 'start' } })),
    ).toBeUndefined()
    expect(rematchUnavailable(ended({ matchOf: { matchId: MATCH, side: 'a' } }))).toBe(
      'Run #7 is already one side of a match.',
    )
    expect(rematchUnavailable(ended({ config: { isolation: 'worktree' } }))).toContain(
      'worked in an isolated copy',
    )
    expect(rematchUnavailable(ended({ steps: { plan: idle, implement: idle, fix: idle } }))).toContain(
      'never started building',
    )
    expect(rematchUnavailable(ended({ snapshots: {} }))).toContain('ended before it took a snapshot')
    expect(startGoneText(ended())).toBe(
      "Run #7's starting snapshot was cleared, so there is nothing to replay it from.",
    )
  })

  it('starts from where the run began, and knows who built it', () => {
    expect(startSnapOf(ended())?.tree).toBe(TREE)
    // No run-start snapshot: the start of its first building step.
    const s0 = { label: 'S0', tree: 'c'.repeat(40), commit: 'd'.repeat(40), at: 2 }
    expect(startSnapOf(ended({ snapshots: { S0: s0 } }))?.tree).toBe('c'.repeat(40))
    expect(builderOf(ended())).toEqual({ vendor: 'claude', model: 'opus', effort: 'high' })
    // A run that failed in Plan: Plan's vendor.
    expect(
      builderOf(
        ended({ steps: { plan: { status: 'failed', vendor: 'codex' }, implement: idle, fix: idle } }),
      ),
    ).toEqual({ vendor: 'codex' })
  })

  it('a side keeps the recorded settings but for who builds, its copy, and the questions already answered', () => {
    const recorded = {
      profile: 'balanced',
      passes: {
        plan: {
          vendor: 'claude',
          model: 'opus',
          effort: 'high',
          clarify: true,
          research: true,
          enabled: true,
        },
        implement: { vendor: 'claude', model: 'opus', extensions: 'none' },
        fix: { vendor: 'claude', model: null },
        review: { vendor: 'gemini', model: 'pro' },
      },
      isolation: { mode: 'inPlace', branch: 'runBranch', worktree: { autoApply: true, install: 'ask' } },
      verify: { enabled: true },
    }
    const next = sideConfig(recorded as never, {
      vendor: 'codex',
      model: 'gpt-x',
    }) as unknown as typeof recorded
    expect(next.passes.plan).toEqual({
      vendor: 'codex',
      model: 'gpt-x',
      effort: null,
      clarify: false,
      research: false,
      enabled: true,
    })
    expect(next.passes.implement).toEqual({
      vendor: 'codex',
      model: 'gpt-x',
      effort: null,
      extensions: 'none',
    })
    expect(next.passes.fix).toMatchObject({ vendor: 'codex', model: 'gpt-x' })
    // The checks are the original's.
    expect(next.passes.review).toEqual({ vendor: 'gemini', model: 'pro' })
    expect(next.verify).toEqual({ enabled: true })
    expect(next.isolation).toEqual({
      mode: 'worktree',
      branch: 'none',
      worktree: { autoApply: false, install: 'ask' },
    })
    // The record is not changed.
    expect(recorded.passes.plan.vendor).toBe('claude')
  })
})

describe('choosing a batch (pure)', () => {
  const item = (n: number, category: string, costUsd: number | null): BatchPlanItem => ({
    runId: `r${n}`,
    displayNo: n,
    title: `t${n}`,
    folder: 'f',
    category,
    costUsd,
  })

  it('takes one of each kind first, newest first, then the newest of the rest, and queues the cheapest first', () => {
    // Newest first.
    const all = [
      item(9, 'software', 5),
      item(8, 'software', 1),
      item(7, 'documents', 3),
      item(6, 'software', 2),
      item(5, 'data', null),
      item(4, 'software', 4),
      item(3, 'games', 9),
    ]
    const chosen = chooseBatch(all)
    // One per kind: 9, 7, 5, 3; then the newest left: 8. Cheapest first, the unpriced one last.
    expect(chosen.map((c) => c.displayNo)).toEqual([8, 7, 9, 3, 5])
    expect(batchTotal(chosen)).toBe(18)
    expect(chooseBatch(all, 2).map((c) => c.displayNo)).toEqual([7, 9])
    expect(chooseBatch([])).toEqual([])
    expect(batchTotal([item(1, 'software', null)])).toBeNull()
    // The same cost keeps the newer one first.
    expect(chooseBatch([item(2, 'a', 1), item(1, 'b', 1)]).map((c) => c.displayNo)).toEqual([2, 1])
  })
})

describe('what the two sides are compared by', () => {
  const change = (path: string, sha: string, over: Partial<FileChange> = {}): FileChange => ({
    status: 'M',
    path,
    oldMode: '100644',
    newMode: '100644',
    oldSha: '0'.repeat(40),
    newSha: sha.repeat(40),
    added: 1,
    deleted: 0,
    binary: false,
    gitlink: false,
    eolOnly: false,
    ...over,
  })

  it('each changed path is only A’s, only B’s, or both, and both may have ended the same', () => {
    const c = compareFiles(
      [change('b.ts', '1'), change('same.ts', '2'), change('onlyA.ts', '3'), change('mode.sh', '6')],
      [
        change('same.ts', '2'),
        change('b.ts', '4'),
        change('onlyB.ts', '5'),
        change('mode.sh', '6', { newMode: '100755' }),
      ],
      true,
    )
    expect(c.files.map((f) => f.path)).toEqual(['b.ts', 'mode.sh', 'onlyA.ts', 'onlyB.ts', 'same.ts'])
    expect(c.available).toEqual({ a: true, b: true, between: true })
    const s = splitCompare(c.files)
    const paths = (l: { path: string }[]): string[] => l.map((f) => f.path)
    expect(paths(s.onlyA)).toEqual(['onlyA.ts'])
    expect(paths(s.onlyB)).toEqual(['onlyB.ts'])
    expect(paths(s.both)).toEqual(['b.ts', 'mode.sh'])
    expect(paths(s.same)).toEqual(['same.ts'])
  })

  it('a side whose changes cannot be read is said, and the other is still listed', () => {
    const c = compareFiles(null, [change('x.ts', '1')], false)
    expect(c.available).toEqual({ a: false, b: true, between: false })
    expect(splitCompare(c.files).onlyB).toHaveLength(1)
  })

  it('a side’s numbers come from its run: lines, checks, time building, who reviewed, what it said', () => {
    const st = (o: object = {}): object => ({ status: 'done', activeMs: 1000, ...o })
    const state = {
      folder: 'C:\\work\\repo',
      diffStats: { files: 2, added: 10, deleted: 3, live: false },
      grounding: { checks: { implement: { phase: 'done', findings: [{}], notes: [] } } },
      steps: {
        clarify: st({ usage: { input: 10, output: 5, costUsd: 0.02 } }),
        research: st({ status: 'skipped', activeMs: 0 }),
        plan: st({ vendor: 'codex' }),
        implement: st({ vendor: 'codex', result: 'Added the flag.' }),
        fix: st({ status: 'skipped', activeMs: 0 }),
        review: st({ vendor: 'codex' }),
        critic: st({ vendor: 'gemini' }),
        'verify:1': st({
          verify: { phase: 'done', commands: [{ status: 'pass' }, { status: 'fail' }, { status: 'pass' }] },
        }),
      },
    } as unknown as RunState
    expect(sideDetail(state, { shared: true, thumbnail: 'data:image/jpeg;base64,xx' })).toEqual({
      closing: 'Added the flag.',
      lines: { added: 10, deleted: 3 },
      checks: { passed: 2, failed: 1 },
      grounding: 1,
      buildMs: 2000,
      sharedCostUsd: 0.02,
      reviewers: ['codex', 'gemini'],
      selfReviewed: true,
      thumbnail: 'data:image/jpeg;base64,xx',
    })
    // Not the side that asked: no shared cost; nothing said, nothing checked, nobody reviewed.
    const bare = {
      steps: { implement: st({ vendor: 'claude' }), fix: st({ status: 'queued', activeMs: 0 }) },
    } as unknown as RunState
    expect(sideDetail(bare)).toEqual({ buildMs: 1000 })
  })
})

describe('the command line’s words', () => {
  it('a side is vendor[:model[:effort]]', () => {
    expect(parseContestant('--a', 'claude')).toEqual({ vendor: 'claude' })
    expect(parseContestant('--a', 'claude:opus')).toEqual({ vendor: 'claude', model: 'opus' })
    expect(parseContestant('--b', 'codex::high')).toEqual({ vendor: 'codex', effort: 'high' })
    expect(parseContestant('--b', 'claude:default:low')).toEqual({
      vendor: 'claude',
      model: null,
      effort: 'low',
    })
    expect(() => parseContestant('--a', undefined)).toThrow('--a names who builds that side')
    expect(() => parseContestant('--a', ':opus')).toThrow('--a expects vendor[:model[:effort]]')
    expect(() => parseContestant('--a', 'a:b:c:d')).toThrow('expects vendor')
  })

  it('names a side and says how it stands, with no em dashes', () => {
    expect(contestantText({ vendor: 'claude' })).toBe('Claude Code')
    expect(contestantText({ vendor: 'claude', model: 'opus' })).toBe('Claude Code (opus)')
    expect(contestantText({ vendor: 'codex', effort: 'high' })).toBe('Codex (default model, high)')
    const base = record().sides[0]
    expect(sideStanding({ ...base })).toBe('its run is not here any more')
    expect(sideStanding({ ...base, status: 'waiting', notApplied: true, copyState: 'pending' })).toBe(
      'built, not applied',
    )
    expect(sideStanding({ ...base, status: 'completed', outcome: 'clean', copyState: 'applied' })).toBe(
      'applied to the folder',
    )
    expect(sideStanding({ ...base, status: 'completed', copyState: 'discarded' })).toBe('discarded')
    expect(sideStanding({ ...base, status: 'failed', outcome: 'failed' })).toBe('failed (failed)')
    expect(sideStanding({ ...base, status: 'running' })).toBe('running')
    const waiting = { status: 'waiting' as const, worktree: { state: 'pending' as const, notApplied: true } }
    const lines = matchLines(matchView(record(), (id) => summary(id, waiting)))
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('both sides built')
    expect(lines[2]).toContain('Side A  Claude Code')
    expect(lines[3]).toContain('Codex (gpt-x, high)')
    expect(lines[3]).toContain('3 files changed · $0.40')
    for (const s of [
      ...lines,
      ...(Object.values(MATCH_TEXT) as unknown[]).filter((x): x is string => typeof x === 'string'),
    ]) {
      expect(s).not.toMatch(/[—–]/)
    }
  })
})
