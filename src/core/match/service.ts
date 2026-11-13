// Matches: starting a Head to head, reading a match as it stands, keeping a result, and tidying a match's leftovers.
//
// Starting one: both sides are checked first, exactly as runs.start would check each (the same preflight, for an
// isolated copy made from a snapshot), and nothing is created unless both pass. Then one snapshot of the folder as it
// is now is taken and held by a ref named for the match, and side A's run is made with that snapshot as the start of
// its copy. Side B's run is made at once when side A asks nothing, and otherwise when side A's questions are answered
// and its research is chosen: it starts from the same Brief and the same notes (shared.ts), so the person answers
// once. Each run is an ordinary isolated run: its own lock, the same cards, checks, guardrails and recovery, and its
// changes reach the folder only when the person keeps them.
//
// Keeping a result is the kept side's own Apply (conflicts, journal and Undo included); the side that was not kept is
// kept for later, and its copy is removed 7 days after the pick, once its changes are saved to read.
//
// A rematch replays a run that ended (eligible.ts): side A is that run as it was recorded (or built again now, when
// asked), side B is built now from the run's own starting snapshot and settings (rematch.ts). Neither is ever applied:
// a pick there is a judgement, kept for the scoreboard, and a side's changes can be saved as a patch.
//
// Leftovers: the starting point's ref is dropped once both sides have made their copies (or ended), and the record
// goes when both runs are gone from the history.
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiffFilePatch, FileChange, RunStartRequest, WorktreeApplyResult } from '../../shared/ipc.ts'
import { RUN_ID_PATTERN, newRunId } from '../../shared/ids.ts'
import {
  BATCH_MAX,
  MATCH_COPY_KEEP_DAYS,
  MATCH_SIDE_LABEL,
  MATCH_TEXT,
  NEW_MODEL_OFFER_DAYS,
} from '../../shared/match.ts'
import type {
  BatchAdded,
  BatchPlan,
  BatchPlanItem,
  MatchCompare,
  MatchContestant,
  MatchPatchSaved,
  MatchPickResult,
  MatchPickSide,
  MatchRecord,
  MatchRef,
  MatchRematchRequest,
  MatchSide,
  MatchSideRecord,
  MatchSideView,
  MatchStarted,
  MatchView,
  NewModelOffer,
  RematchCheck,
} from '../../shared/match.ts'
import type { RunSummary } from '../../shared/run.ts'
import { builderKey, score } from '../../shared/scoreboard.ts'
import type {
  MatchResult,
  MatchResultSide,
  ScoreMatchLine,
  Scoreboard,
  ScoredMatch,
} from '../../shared/scoreboard.ts'
import { DimFactoryError, errorMessage } from '../errors.ts'
import type { HomePaths, RunPaths } from '../home.ts'
import type { Logger } from '../log.ts'
import type { CreatedRun } from '../rerun.ts'
import type { RunInit, RunState, SnapshotCopySource } from '../supervisor/types.ts'
import type { QueueRematch } from '../../shared/factory.ts'
import { readJsonFile, writeJsonAtomic } from '../store/atomic.ts'
import { batchTotal, chooseBatch } from './batch.ts'
import { betweenPatch, bothReadable, compareFiles } from './compare.ts'
import type { SideResult } from './compare.ts'
import { sideDetail } from './detail.ts'
import { builderOf, rematchUnavailable, startGoneText, startSnapOf } from './eligible.ts'
import { initSharedSide, sharedAbandoned, sharedSettled, sharesSteps } from './shared.ts'
import { checkContestants, sideOverrides } from './sides.ts'
import { listMatchIds, matchDir, matchesDir, readMatch, removeMatch, writeMatch } from './store.ts'

/** A run checked and ready to be made: runs.start up to its preflight, which passed. */
export interface PlannedRun {
  /** Make the run. `created` (which starts it) is the caller's to send. */
  create(extra: {
    matchOf: MatchRef
    copyFrom: SnapshotCopySource
    initState?: (init: RunInit) => RunState
    prepare?: (runId: string, run: RunPaths) => Promise<void>
  }): Promise<CreatedRun>
}

export interface MatchStartInput extends RunStartRequest {
  sides: readonly MatchContestant[]
  /** Hide the builders' names on the Match page until a result is picked. */
  blind?: boolean
  /**
   * What the caller knows about the task beyond its words (Easy: a beginner's new project and what it needs), passed
   * to `planRun` for both sides so they are shaped alike. Never read from a request that came over IPC.
   */
  hints?: Record<string, unknown>
}

export interface MatchDeps {
  paths: HomePaths
  now: () => number
  log: Logger
  /** A vendor id Dim Factory knows (a built-in vendor or a configured one). */
  knownVendor: (vendor: string) => boolean
  /**
   * runs.start up to and including its authoritative preflight, for a run whose isolated copy is made from a snapshot.
   * Throws what runs.start throws (PREFLIGHT_BLOCKED with the report, VALIDATION).
   */
  planRun: (req: RunStartRequest, hints?: Record<string, unknown>) => Promise<PlannedRun>
  /** A snapshot of the folder as it is now, held by a ref named `id` in the folder's shadow. */
  snapshot: (folder: string, id: string) => Promise<{ tree: string; commit: string; folderKey: string }>
  /** Drop that ref (the snapshot's objects go with the shadow's next collection unless a run holds them). */
  dropStartRef: (folderKey: string, id: string) => Promise<void>
  /** A run's summary (live, else the index); undefined when the run is not in the history. */
  summary: (runId: string) => RunSummary | undefined
  /** A run's state (live, else as saved); undefined when the run is not there. */
  state: (runId: string) => Promise<RunState | undefined>
  /** Whether an id is taken by a run (a match's ref shares the runs' namespace). */
  runExists: (id: string) => Promise<boolean>
  /** Stop a run that was started (used when the other side could not be). */
  stopRun: (runId: string) => Promise<void>
  /** An isolated run's Apply, its Undo and Discard (handlers-worktree.ts, through the run's controller). */
  worktree: {
    apply(runId: string, req: Record<string, never>): Promise<WorktreeApplyResult>
    undoApply(runId: string, undoToken: string): Promise<void>
    discard(runId: string): Promise<unknown>
  }
  /** Answer a run's open "apply, keep or discard" card with Keep for later. Nothing when no such card is open. */
  keepForLater: (runId: string) => Promise<void>
  /** A run's changed files against its start (its combined changes); null when they cannot be read. */
  files: (runId: string) => Promise<FileChange[] | null>
  /** Where a run's last result is (compare.ts); null when the run has none. */
  result: (runId: string) => Promise<SideResult | null>
  /** Save a run's changes as patches so they stay readable without its snapshots. False: they could not be saved. */
  saveDiffs: (runId: string) => Promise<boolean>
  /** The small screenshot of a run's page-load check (a data: URL), or null. */
  thumbnail: (runId: string) => Promise<string | null>
  /** The match's record changed (side B started, a pick, the names shown or hidden): views read it again. */
  changed: (matchId: string) => void
  /** 0 ≤ n < 1 (which result a blind match shows first). */
  random: () => number
  /**
   * Start a waiting side B when side A's questions are over, as its summaries come in. The app does; a command-line
   * process does not (it would start a run it is not following, and leave it when it exits).
   */
  autoStart: boolean
  /**
   * A rematch's side, checked and ready to be made: the run `runId`'s recorded settings with `c` as the builder
   * (rematch.ts). Throws what a re-run throws.
   */
  planRematch: (runId: string, c: MatchContestant) => Promise<PlannedRun>
  /** The run's starting snapshot is still in its folder's shadow. */
  hasStart: (src: RunState, commit: string) => Promise<boolean>
  /** The vendors that have run a step in a folder before (by its key). */
  vendorsRanIn: (folderKey: string) => string[]
  /** Pin a run, so the history keeps it and its snapshots. */
  pin: (runId: string) => Promise<void>
  /** A run's whole change against its start as one patch; null when it cannot be read. */
  patchOf: (runId: string) => Promise<string | null>
  /** The prompt check has a hint for this task. */
  openTask: (folder: string, task: string) => Promise<boolean>
  /** Every run in the history. */
  runs: () => RunSummary[]
  /** Put rematches in a folder's queue (the queue starts them, within its budgets and schedule). */
  queueAdd: (folder: string, tasks: { task: string; rematch: QueueRematch }[]) => Promise<void>
  /** The models the catalog's refreshes added that were not undone, newest first. */
  addedModels: () => Promise<{ vendor: string; model: string; at: number }[]>
}

export interface MatchSweep {
  /** Matches whose starting ref was dropped now. */
  refsDropped: string[]
  /** Matches whose record was removed now (both runs are gone). */
  removed: string[]
  /** Runs whose copy was removed now: sides that were not kept, 7 days after the pick. */
  copiesRemoved: string[]
}

const SIDES: readonly [MatchSide, MatchSide] = ['a', 'b']
const KEEP_MS = MATCH_COPY_KEEP_DAYS * 24 * 60 * 60_000
/** The shared steps' files in a run folder (clarify.md, research.md, research.json). */
const SHARED_FILES = ['clarify', 'research', 'research.json'] as const

/** A side's copy exists, could not be made for good, or is no longer needed: the starting ref is not needed for it. */
function copySettled(s: RunSummary | undefined): boolean {
  if (s === undefined || s.endedAt !== undefined) return true
  return s.worktree !== undefined && s.worktree.state !== 'preparing'
}

/** The copy is not yet something a person can decide about: being made, being worked in, or its changes being read. */
const NOT_READY: ReadonlySet<string> = new Set(['preparing', 'working', 'preview'])

/**
 * A side has built and is waiting to be applied or discarded, or has ended, or is gone. Not while the run is still
 * reading what its copy changed (the step before it asks): an Apply then would be refused.
 */
function sideReady(s: RunSummary | undefined): boolean {
  if (s === undefined || s.endedAt !== undefined) return true
  // A run has its outcome before it has read its copy's changes, so the copy's own state decides while there is one.
  if (s.worktree !== undefined) return !NOT_READY.has(s.worktree.state)
  return s.outcome !== undefined
}

export function sideView(rec: MatchSideRecord, s: RunSummary | undefined): MatchSideView {
  if (s === undefined) return { ...rec }
  return {
    ...rec,
    status: s.status,
    ...(s.outcome !== undefined ? { outcome: s.outcome } : {}),
    ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
    tokens: s.progress.tokens,
    costUsd: s.progress.costUsd,
    filesChanged: s.progress.filesChanged,
    findings: { must: s.findings.must, should: s.findings.should },
    ...(s.worktree !== undefined ? { copyState: s.worktree.state, notApplied: s.worktree.notApplied } : {}),
  }
}

export function matchView(rec: MatchRecord, summary: (runId: string) => RunSummary | undefined): MatchView {
  const of = (s: MatchSideRecord): RunSummary | undefined =>
    s.runId !== undefined ? summary(s.runId) : undefined
  const sums = [of(rec.sides[0]), of(rec.sides[1])] as const
  const waiting = rec.pending !== undefined
  const ended = !waiting && sums.every((s) => s === undefined || s.endedAt !== undefined)
  const ends = sums.map((s) => s?.endedAt).filter((t): t is number => t !== undefined)
  const sides: [MatchSideView, MatchSideView] = [
    sideView(rec.sides[0], sums[0]),
    sideView(rec.sides[1], sums[1]),
  ]
  const kept = sides.find((s) => s.copyState === 'applied')?.side
  const { pending: _pending, ...shown } = rec
  void _pending
  return {
    ...shown,
    sides,
    waiting,
    ready: !waiting && sums.every(sideReady),
    ended,
    ...(ended && ends.length > 0 ? { endedAt: Math.max(...ends) } : {}),
    ...(kept !== undefined ? { kept } : {}),
  }
}

const contestantOf = (c: MatchContestant): MatchContestant => ({
  vendor: c.vendor,
  ...(c.model !== undefined ? { model: c.model } : {}),
  ...(c.effort !== undefined ? { effort: c.effort } : {}),
})

export class MatchService {
  readonly #d: MatchDeps
  /** Matches whose side B waits for side A (so a summary of any other run costs nothing). */
  readonly #waiting = new Set<string>()
  /** Matches whose side B is being started right now. */
  readonly #starting = new Set<string>()

  constructor(deps: MatchDeps) {
    this.#d = deps
  }

  /** An id no run and no match has (the starting ref lives beside the runs' refs). */
  async #newId(): Promise<string> {
    const d = this.#d
    for (let i = 0; i < 8; i++) {
      const id = newRunId(new Date(d.now()))
      if (!(await d.runExists(id)) && (await readMatch(d.paths, id)) === null) return id
    }
    throw new DimFactoryError('INTERNAL', 'Dim Factory could not name the match.')
  }

  async #record(matchId: string): Promise<MatchRecord> {
    const rec = RUN_ID_PATTERN.test(matchId) ? await readMatch(this.#d.paths, matchId) : null
    if (rec === null) throw new DimFactoryError('NOT_FOUND', MATCH_TEXT.notFound)
    return rec
  }

  async #plan(
    run: RunStartRequest,
    c: MatchContestant,
    side: MatchSide,
    hints?: Record<string, unknown>,
  ): Promise<PlannedRun> {
    try {
      return await this.#d.planRun(
        {
          ...run,
          overrides: sideOverrides(run.overrides, c, side === 'a' ? 'asks' : 'given'),
        },
        hints,
      )
    } catch (err) {
      if (err instanceof DimFactoryError) {
        throw new DimFactoryError(err.code, MATCH_TEXT.blocked(MATCH_SIDE_LABEL[side], err.message), {
          ...(err.details !== undefined ? { details: err.details } : {}),
        })
      }
      throw err
    }
  }

  /** Start a Head to head: both sides checked, one snapshot, side A's run, and side B's when it has nothing to wait for. */
  async start(req: MatchStartInput): Promise<MatchStarted> {
    const d = this.#d
    if (typeof req.folder !== 'string' || req.folder.trim() === '') {
      throw new DimFactoryError('VALIDATION', MATCH_TEXT.noFolder)
    }
    if (typeof req.task !== 'string' || req.task.trim() === '') {
      throw new DimFactoryError('VALIDATION', MATCH_TEXT.noTask)
    }
    const check = checkContestants(req.sides, d.knownVendor)
    if (!check.ok) throw new DimFactoryError('VALIDATION', check.problems.join(' '))
    const [ca, cb] = req.sides as readonly [MatchContestant, MatchContestant]
    const { sides: _sides, blind, hints, ...run } = req
    void _sides

    // Both sides are checked before anything is made: a match with one side is no match.
    const plannedA = await this.#plan(run, ca, 'a', hints)
    const plannedB = await this.#plan(run, cb, 'b', hints)

    const matchId = await this.#newId()
    const start = await d.snapshot(req.folder, matchId)
    let a: CreatedRun | undefined
    try {
      a = await plannedA.create({ matchOf: { matchId, side: 'a' }, copyFrom: { tree: start.tree } })
      const rec: MatchRecord = {
        schemaVersion: 1,
        matchId,
        kind: 'headToHead',
        folder: req.folder,
        folderKey: start.folderKey,
        task: req.task.replace(/\r\n?/g, '\n'),
        createdAt: d.now(),
        start: { tree: start.tree, commit: start.commit },
        sides: [
          { side: 'a', contestant: contestantOf(ca), runId: a.runId, displayNo: a.displayNo },
          { side: 'b', contestant: contestantOf(cb) },
        ],
        pending: { request: run, ...(hints !== undefined ? { hints } : {}) },
        ...(blind === true ? { blind: { swap: d.random() < 0.5 } } : {}),
      }
      await writeMatch(d.paths, rec)
    } catch (err) {
      // A side that was made is started and stopped, so it ends as a stopped run and not as a run nobody can reach.
      if (a !== undefined) await this.#abandon(a)
      await d.dropStartRef(start.folderKey, matchId).catch(() => undefined)
      await removeMatch(d.paths, matchId).catch(() => undefined)
      throw new DimFactoryError(
        err instanceof DimFactoryError ? err.code : 'INTERNAL',
        `The match could not be started: ${errorMessage(err)}`,
      )
    }
    this.#waiting.add(matchId)
    await a.controller.enqueue({ t: 'created' })
    // Side B starts now unless side A has questions or research to do first.
    const failed = await this.#advance(matchId, plannedB)
    if (failed !== undefined) {
      // Side B could not be made at the start: a match with one side is no match.
      await d.stopRun(a.runId).catch((e: unknown) => d.log.warn('match: a side could not be stopped', { e }))
      await d.dropStartRef(start.folderKey, matchId).catch(() => undefined)
      await removeMatch(d.paths, matchId).catch(() => undefined)
      throw new DimFactoryError('INTERNAL', `The match could not be started: ${failed}`)
    }
    const rec = await this.#record(matchId)
    const b = rec.sides[1]
    d.log.info('match started', { matchId, a: a.runId, b: b.runId ?? 'waiting' })
    return {
      matchId,
      sides: [
        { side: 'a', runId: a.runId, displayNo: a.displayNo },
        {
          side: 'b',
          ...(b.runId !== undefined ? { runId: b.runId } : {}),
          ...(b.displayNo !== undefined ? { displayNo: b.displayNo } : {}),
        },
      ],
    }
  }

  /** Whether a run can be replayed, and what a rematch of it would start from (the Rematch page's first read). */
  async rematchCheck(runId: string): Promise<RematchCheck> {
    const d = this.#d
    const src = await d.state(runId)
    if (src === undefined) return { blocked: `Run ${runId} is not here any more.` }
    const original = builderOf(src)
    const facts = {
      displayNo: src.displayNo,
      task: src.task,
      ...(original !== undefined ? { original } : {}),
      knownVendors: d.vendorsRanIn(src.folderKey),
    }
    const why = rematchUnavailable(src)
    if (why !== undefined) return { ...facts, blocked: why }
    const start = startSnapOf(src)
    if (start === undefined || !(await d.hasStart(src, start.commit).catch(() => false))) {
      return { ...facts, blocked: startGoneText(src) }
    }
    return facts
  }

  async #planRematch(runId: string, c: MatchContestant, side: MatchSide): Promise<PlannedRun> {
    try {
      return await this.#d.planRematch(runId, c)
    } catch (err) {
      if (err instanceof DimFactoryError) {
        throw new DimFactoryError(err.code, MATCH_TEXT.blocked(MATCH_SIDE_LABEL[side], err.message), {
          ...(err.details !== undefined ? { details: err.details } : {}),
        })
      }
      throw err
    }
  }

  /**
   * Start a rematch of a run that ended: side B is built now by the challenger from the run's own starting snapshot
   * and settings; side A is the run as recorded, or is built again now too (`fresh`). The run is pinned, so its
   * snapshots stay.
   */
  async rematch(req: MatchRematchRequest): Promise<MatchStarted> {
    const d = this.#d
    const src = await d.state(req.runId)
    if (src === undefined) throw new DimFactoryError('NOT_FOUND', `Run ${req.runId} not found.`)
    const why = rematchUnavailable(src)
    if (why !== undefined) throw new DimFactoryError('CONFLICT', why)
    const start = startSnapOf(src)
    const original = builderOf(src)
    if (start === undefined || original === undefined || !(await d.hasStart(src, start.commit))) {
      throw new DimFactoryError('CONFLICT', startGoneText(src))
    }
    const challenger = contestantOf(req.challenger)
    if (typeof challenger.vendor !== 'string' || !d.knownVendor(challenger.vendor)) {
      throw new DimFactoryError(
        'VALIDATION',
        MATCH_TEXT.unknownVendor(MATCH_SIDE_LABEL.b, String(challenger.vendor)),
      )
    }
    // The project's files go to whoever builds: a vendor that has never run here is asked about once.
    if (req.confirmNewVendor !== true && !d.vendorsRanIn(src.folderKey).includes(challenger.vendor)) {
      throw new DimFactoryError('CONFLICT', MATCH_TEXT.newVendor(challenger.vendor), {
        details: { newVendor: challenger.vendor },
      })
    }
    const planB = await this.#planRematch(src.runId, challenger, 'b')
    const planA = req.fresh === true ? await this.#planRematch(src.runId, original, 'a') : undefined
    const matchId = await this.#newId()
    const copyFrom = { tree: start.tree }
    const made: CreatedRun[] = []
    let rec: MatchRecord
    try {
      const a =
        planA !== undefined
          ? await planA.create({ matchOf: { matchId, side: 'a', rematch: true }, copyFrom })
          : undefined
      if (a !== undefined) made.push(a)
      const b = await planB.create({ matchOf: { matchId, side: 'b', rematch: true }, copyFrom })
      made.push(b)
      const openTask = await d.openTask(src.folder, src.task).catch(() => false)
      const now = d.now()
      rec = {
        schemaVersion: 1,
        matchId,
        kind: 'rematch',
        folder: src.folder,
        folderKey: src.folderKey,
        task: src.task,
        createdAt: now,
        start: { tree: start.tree, commit: start.commit },
        sides: [
          a !== undefined
            ? { side: 'a', contestant: original, runId: a.runId, displayNo: a.displayNo }
            : { side: 'a', contestant: original, runId: src.runId, displayNo: src.displayNo, recorded: true },
          { side: 'b', contestant: challenger, runId: b.runId, displayNo: b.displayNo },
        ],
        source: { runId: src.runId, displayNo: src.displayNo },
        ...(openTask ? { openTask: true } : {}),
        ...(req.blind === true ? { blind: { swap: d.random() < 0.5 } } : {}),
        // The starting point is the original run's own snapshot, held by that run: the match holds no ref of its own.
        cleanedAt: now,
      }
      await writeMatch(d.paths, rec)
    } catch (err) {
      for (const m of made) await this.#abandon(m)
      await removeMatch(d.paths, matchId).catch(() => undefined)
      throw new DimFactoryError(
        err instanceof DimFactoryError ? err.code : 'INTERNAL',
        `The rematch could not be started: ${errorMessage(err)}`,
      )
    }
    await d
      .pin(src.runId)
      .catch((err: unknown) => d.log.warn('rematch: the run could not be pinned', { err }))
    for (const m of made) await m.controller.enqueue({ t: 'created' })
    d.log.info('rematch started', { matchId, source: src.runId, runs: made.map((m) => m.runId) })
    const [sa, sb] = rec.sides
    return {
      matchId,
      sides: [
        { side: 'a', runId: sa.runId ?? src.runId, displayNo: sa.displayNo ?? src.displayNo },
        {
          side: 'b',
          ...(sb.runId !== undefined ? { runId: sb.runId } : {}),
          ...(sb.displayNo !== undefined ? { displayNo: sb.displayNo } : {}),
        },
      ],
    }
  }

  /**
   * Which past runs a batch of rematches against `challenger` would replay: completed runs that can be replayed, that
   * another builder made, that were not replayed against it already, in projects its vendor has run in before.
   */
  async batchPlan(challenger: MatchContestant): Promise<BatchPlan> {
    const d = this.#d
    const c = contestantOf(challenger)
    const key = builderKey(c)
    const replayed = new Set<string>()
    for (const id of await listMatchIds(d.paths)) {
      const rec = await readMatch(d.paths, id)
      if (rec?.source !== undefined && builderKey(rec.sides[1].contestant) === key)
        replayed.add(rec.source.runId)
    }
    const ended = d
      .runs()
      .filter((s) => s.status === 'completed' && s.endedAt !== undefined && s.matchOf === undefined)
      .filter((s) => s.isolation !== 'worktree' && !replayed.has(s.runId))
      .sort((a, b) => b.createdAt - a.createdAt)
    const candidates: BatchPlanItem[] = []
    let newVendorLeftOut = 0
    // Enough to choose from, without reading the whole history.
    for (const s of ended.slice(0, 60)) {
      if (candidates.length >= BATCH_MAX * 4) break
      const state = await d.state(s.runId).catch(() => undefined)
      if (state === undefined || rematchUnavailable(state) !== undefined) continue
      const original = builderOf(state)
      const start = startSnapOf(state)
      if (original === undefined || builderKey(original) === key || start === undefined) continue
      if (!(await d.hasStart(state, start.commit).catch(() => false))) continue
      if (!d.vendorsRanIn(s.folderKey).includes(c.vendor)) {
        newVendorLeftOut++
        continue
      }
      candidates.push({
        runId: s.runId,
        displayNo: s.displayNo,
        title: s.title,
        folder: s.folder,
        category: state.category ?? 'software',
        costUsd: s.progress.costUsd,
      })
    }
    const items = chooseBatch(candidates)
    return { challenger: c, items, totalUsd: batchTotal(items), newVendorLeftOut }
  }

  /**
   * Put a batch's rematches in the queue: the runs asked for that the plan still holds, each in its own folder's
   * queue, names hidden on their Match pages. The queue starts them, so its budgets, schedule and stop rules apply.
   */
  async batchAdd(challenger: MatchContestant, runIds: readonly string[]): Promise<BatchAdded> {
    const d = this.#d
    if (!d.knownVendor(challenger.vendor)) {
      throw new DimFactoryError('VALIDATION', MATCH_TEXT.unknownVendor(MATCH_SIDE_LABEL.b, challenger.vendor))
    }
    const plan = await this.batchPlan(challenger)
    const want = new Set(runIds)
    const items = plan.items.filter((i) => want.has(i.runId))
    const byFolder = new Map<string, BatchPlanItem[]>()
    for (const i of items) byFolder.set(i.folder, [...(byFolder.get(i.folder) ?? []), i])
    for (const [folder, list] of byFolder) {
      await d.queueAdd(
        folder,
        list.map((i) => ({
          task: i.title.trim() !== '' ? i.title : `Rematch of run #${i.displayNo}`,
          rematch: { runId: i.runId, displayNo: i.displayNo, challenger: plan.challenger, blind: true },
        })),
      )
    }
    return { added: items.length, skipped: want.size - items.length }
  }

  async #dismissed(): Promise<Set<string>> {
    const r = await readJsonFile(join(matchesDir(this.#d.paths), 'offers.json')).catch(() => null)
    const list = r?.kind === 'ok' ? (r.value as { dismissed?: unknown }).dismissed : undefined
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  }

  /**
   * Models the catalog got in the last 30 days that no match has tried and that were not set aside, each with the
   * batch that would try it. Only those with something to replay.
   */
  async offers(): Promise<NewModelOffer[]> {
    const d = this.#d
    const dismissed = await this.#dismissed()
    const played = new Set<string>()
    for (const id of await listMatchIds(d.paths)) {
      const rec = await readMatch(d.paths, id)
      for (const s of rec?.sides ?? []) played.add(builderKey(s.contestant))
    }
    const since = d.now() - NEW_MODEL_OFFER_DAYS * 24 * 60 * 60_000
    const out: NewModelOffer[] = []
    const seen = new Set<string>()
    for (const m of await d.addedModels().catch(() => [])) {
      if (out.length >= 3) break
      const c: MatchContestant = { vendor: m.vendor, model: m.model }
      const key = builderKey(c)
      if (m.at < since || seen.has(key) || dismissed.has(key) || played.has(key)) continue
      seen.add(key)
      if (!d.knownVendor(m.vendor)) continue
      const plan = await this.batchPlan(c)
      if (plan.items.length > 0) out.push({ vendor: m.vendor, model: m.model, at: m.at, plan })
    }
    return out
  }

  /** Set a new model's offer aside for good. */
  async dismissOffer(vendor: string, model: string): Promise<void> {
    const d = this.#d
    const dismissed = await this.#dismissed()
    dismissed.add(builderKey({ vendor, model }))
    await mkdir(matchesDir(d.paths), { recursive: true })
    await writeJsonAtomic(join(matchesDir(d.paths), 'offers.json'), { dismissed: [...dismissed].slice(-200) })
  }

  /**
   * How the match ended, read from its two runs: each side's builder, checks, cost and building time, and the kind of
   * task. Undefined while a side has not ended, or when a run is not there to read.
   */
  async #result(rec: MatchRecord): Promise<MatchResult | undefined> {
    const d = this.#d
    const sides: MatchResultSide[] = []
    let category: string | undefined
    for (const s of rec.sides) {
      if (s.runId === undefined) return undefined
      const sum = d.summary(s.runId)
      const state = await d.state(s.runId).catch(() => undefined)
      if (sum?.endedAt === undefined || state === undefined) return undefined
      category ??= state.category
      const detail = sideDetail(state)
      sides.push({
        builder: s.contestant,
        finished: sum.status === 'completed',
        ...(detail.checks !== undefined ? { checks: detail.checks } : {}),
        costUsd: sum.progress.costUsd,
        ...(detail.buildMs !== undefined ? { buildMs: detail.buildMs } : {}),
      })
    }
    return {
      at: d.now(),
      category: category ?? 'software',
      sides: sides as [MatchResultSide, MatchResultSide],
    }
  }

  /** Keep the match's result in its record once both sides have ended (the runs may be removed later). */
  async #keepResult(rec: MatchRecord): Promise<MatchRecord> {
    if (rec.result !== undefined || rec.pending !== undefined) return rec
    const result = await this.#result(rec).catch(() => undefined)
    if (result === undefined) return rec
    const next = { ...rec, result }
    await writeMatch(this.#d.paths, next)
    return next
  }

  /** What the matches played so far say about the builders, and the matches themselves, newest first. */
  async scoreboard(): Promise<Scoreboard> {
    const d = this.#d
    const scored: ScoredMatch[] = []
    const lines: ScoreMatchLine[] = []
    for (const id of await listMatchIds(d.paths)) {
      const rec = await readMatch(d.paths, id)
      if (rec === null) continue
      const result = rec.result ?? (await this.#result(rec).catch(() => undefined))
      lines.push({
        matchId: rec.matchId,
        kind: rec.kind,
        category: result?.category ?? 'software',
        at: rec.createdAt,
        task: rec.task.split('\n')[0]?.slice(0, 200) ?? '',
        sides: [rec.sides[0].contestant, rec.sides[1].contestant],
        ...(rec.pick !== undefined ? { pick: rec.pick.side } : {}),
        ended: result !== undefined,
      })
      if (result === undefined) continue
      scored.push({
        ...result,
        matchId: rec.matchId,
        kind: rec.kind,
        at: rec.createdAt,
        ...(rec.pick !== undefined ? { pick: rec.pick.side } : {}),
      })
    }
    return { ...score(scored), matches: lines }
  }

  /** Save one side's whole change as a patch file beside the match's record, and say where. */
  async savePatch(matchId: string, side: MatchSide): Promise<MatchPatchSaved> {
    const d = this.#d
    const rec = await this.#record(matchId)
    const runId = rec.sides[SIDES.indexOf(side)]?.runId
    const text = runId !== undefined ? await d.patchOf(runId).catch(() => null) : null
    if (text === null) throw new DimFactoryError('NOT_FOUND', MATCH_TEXT.noPatch)
    const path = join(matchDir(d.paths, matchId), `side-${side}.patch`)
    await writeFile(path, text, 'utf8')
    return { path, bytes: Buffer.byteLength(text, 'utf8') }
  }

  async #abandon(run: CreatedRun): Promise<void> {
    await run.controller.enqueue({ t: 'created' }).catch(() => undefined)
    await this.#d
      .stopRun(run.runId)
      .catch((e: unknown) => this.#d.log.warn('match: a side could not be stopped', { e }))
  }

  /**
   * Start side B if it is waiting and side A's questions and research are over. `planned`: side B as it was checked a
   * moment ago (the start); otherwise it is checked again now. Answers why side B could not be made, when it was tried
   * and failed.
   */
  async #advance(matchId: string, planned?: PlannedRun): Promise<string | undefined> {
    const d = this.#d
    if (this.#starting.has(matchId)) return undefined
    this.#starting.add(matchId)
    try {
      const rec = await readMatch(d.paths, matchId)
      if (rec?.pending === undefined) {
        this.#waiting.delete(matchId)
        return undefined
      }
      const aId = rec.sides[0].runId
      const a = aId !== undefined ? await d.state(aId) : undefined
      const settle = async (side: MatchSideRecord, shared: boolean): Promise<void> => {
        const { pending: _p, ...rest } = rec
        void _p
        await writeMatch(d.paths, {
          ...rest,
          sides: [rec.sides[0], side],
          ...(shared ? { shared: true } : {}),
        })
        this.#waiting.delete(matchId)
        d.changed(matchId)
      }
      if (a === undefined || aId === undefined || sharedAbandoned(a)) {
        await settle({ ...rec.sides[1], notStarted: MATCH_TEXT.aStoppedFirst }, false)
        return undefined
      }
      if (!sharedSettled(a)) return undefined
      const shares = sharesSteps(a)
      let made: CreatedRun | undefined
      try {
        const request = rec.pending.request as unknown as RunStartRequest
        const p = planned ?? (await this.#plan(request, rec.sides[1].contestant, 'b', rec.pending.hints))
        made = await p.create({
          matchOf: { matchId, side: 'b' },
          copyFrom: { tree: rec.start.tree },
          ...(shares
            ? {
                initState: (init: RunInit) => initSharedSide(init, a),
                prepare: async (_runId: string, run: RunPaths) => {
                  const from = d.paths.run(aId)
                  for (const f of SHARED_FILES) {
                    await copyFile(from.output(f), run.output(f)).catch(() => undefined)
                  }
                },
              }
            : {}),
        })
        await settle({ ...rec.sides[1], runId: made.runId, displayNo: made.displayNo }, shares)
        await made.controller.enqueue({ t: 'created' })
        return undefined
      } catch (err) {
        d.log.warn('match: side B could not start', { matchId, err })
        if (made !== undefined) await this.#abandon(made)
        await settle({ ...rec.sides[1], notStarted: MATCH_TEXT.lateStart(errorMessage(err)) }, false).catch(
          () => undefined,
        )
        return errorMessage(err)
      }
    } finally {
      this.#starting.delete(matchId)
    }
  }

  /** A run's summary changed: a waiting side B may be due. */
  onSummary(s: RunSummary): void {
    const m = s.matchOf
    if (!this.#d.autoStart || m === undefined || m.side !== 'a' || !this.#waiting.has(m.matchId)) return
    void this.#advance(m.matchId).catch((err: unknown) =>
      this.#d.log.warn('match: advancing a match failed', { matchId: m.matchId, err }),
    )
  }

  async get(matchId: string): Promise<MatchView> {
    const d = this.#d
    const rec = await this.#record(matchId)
    const view = matchView(rec, d.summary)
    for (const side of view.sides) {
      if (side.runId === undefined) continue
      const state = await d.state(side.runId).catch(() => undefined)
      if (state === undefined) continue
      const thumbnail = await d.thumbnail(side.runId).catch(() => null)
      side.detail = sideDetail(state, { thumbnail, shared: rec.shared === true && side.side === 'a' })
    }
    return view
  }

  /** Every match, newest first. */
  async list(): Promise<MatchView[]> {
    const out: MatchView[] = []
    for (const id of await listMatchIds(this.#d.paths)) {
      const rec = await readMatch(this.#d.paths, id)
      if (rec !== null) out.push(matchView(rec, this.#d.summary))
    }
    return out
  }

  /**
   * Keep one side's result (its changes are applied to the folder, with an undo), or neither. The sides that are not
   * kept are kept for later; their copies go 7 days after the pick. A blind match shows its names from here on.
   */
  async pick(matchId: string, side: MatchPickSide): Promise<MatchPickResult> {
    const d = this.#d
    const rec = await this.#record(matchId)
    if (rec.pick !== undefined) throw new DimFactoryError('CONFLICT', MATCH_TEXT.alreadyPicked)
    const view = matchView(rec, d.summary)
    if (!view.ready) throw new DimFactoryError('CONFLICT', MATCH_TEXT.notReady)
    if (view.kept !== undefined && view.kept !== side) {
      throw new DimFactoryError(
        'CONFLICT',
        `${MATCH_SIDE_LABEL[view.kept]} is already in the folder. Undo that in its run first.`,
      )
    }
    let conflicts: string[] = []
    let undoToken: string | undefined
    if (rec.kind !== 'rematch' && side !== 'none' && view.kept !== side) {
      const sv = view.sides[SIDES.indexOf(side)] as MatchSideView
      if (sv.runId === undefined || sv.notApplied !== true) {
        throw new DimFactoryError('VALIDATION', MATCH_TEXT.nothingToKeep(MATCH_SIDE_LABEL[side]))
      }
      const r = await d.worktree.apply(sv.runId, {})
      conflicts = r.conflicts
      undoToken = r.undoToken
    }
    for (const s of view.sides) {
      if (s.side === side || s.runId === undefined) continue
      await d
        .keepForLater(s.runId)
        .catch((err: unknown) => d.log.warn('match: a side could not be kept for later', { matchId, err }))
    }
    const now = d.now()
    const result = rec.result ?? (await this.#result(rec).catch(() => undefined))
    await writeMatch(d.paths, {
      ...rec,
      ...(result !== undefined ? { result } : {}),
      pick: { side, at: now, ...(undoToken !== undefined ? { undoToken } : {}) },
      ...(rec.blind !== undefined
        ? { blind: { ...rec.blind, revealedAt: rec.blind.revealedAt ?? now } }
        : {}),
    })
    d.changed(matchId)
    return { match: await this.get(matchId), conflicts }
  }

  /** Take the pick back: the kept side's changes leave the folder again (its Undo), and both sides can be picked. */
  async undoPick(matchId: string): Promise<MatchView> {
    const d = this.#d
    const rec = await this.#record(matchId)
    const pick = rec.pick
    if (pick === undefined) throw new DimFactoryError('CONFLICT', MATCH_TEXT.noPick)
    if (pick.side !== 'none' && pick.undoToken !== undefined) {
      const runId = rec.sides[SIDES.indexOf(pick.side)]?.runId
      if (runId !== undefined) await d.worktree.undoApply(runId, pick.undoToken)
    }
    const { pick: _pick, ...rest } = rec
    void _pick
    await writeMatch(d.paths, rest)
    d.changed(matchId)
    return this.get(matchId)
  }

  /** Hide the builders' names until a result is picked, or show them again. */
  async setBlind(matchId: string, on: boolean): Promise<MatchView> {
    const d = this.#d
    const rec = await this.#record(matchId)
    if (on) {
      if (rec.pick !== undefined || matchView(rec, d.summary).kept !== undefined) {
        throw new DimFactoryError('CONFLICT', MATCH_TEXT.blindAfterPick)
      }
      if (rec.blind === undefined || rec.blind.revealedAt !== undefined) {
        await writeMatch(d.paths, { ...rec, blind: { swap: d.random() < 0.5 } })
      }
    } else if (rec.blind !== undefined && rec.blind.revealedAt === undefined) {
      await writeMatch(d.paths, { ...rec, blind: { ...rec.blind, revealedAt: d.now() } })
    }
    d.changed(matchId)
    return this.get(matchId)
  }

  async #results(rec: MatchRecord): Promise<[SideResult | null, SideResult | null]> {
    const of = async (s: MatchSideRecord): Promise<SideResult | null> =>
      s.runId !== undefined ? await this.#d.result(s.runId).catch(() => null) : null
    return [await of(rec.sides[0]), await of(rec.sides[1])]
  }

  /** What each side changed against the start, path by path. */
  async compare(matchId: string): Promise<MatchCompare> {
    const d = this.#d
    const rec = await this.#record(matchId)
    const files = async (s: MatchSideRecord): Promise<FileChange[] | null> =>
      s.runId !== undefined ? await d.files(s.runId).catch(() => null) : null
    const [fa, fb] = [await files(rec.sides[0]), await files(rec.sides[1])]
    const [ra, rb] = await this.#results(rec)
    const between = ra !== null && rb !== null && (await bothReadable(ra, rb).catch(() => false))
    return compareFiles(fa, fb, between)
  }

  /** One file of side A's result against side B's. */
  async compareFile(matchId: string, path: string, o: { ignoreEol?: boolean } = {}): Promise<DiffFilePatch> {
    const rec = await this.#record(matchId)
    const [ra, rb] = await this.#results(rec)
    const patch = ra !== null && rb !== null ? await betweenPatch(ra, rb, path, o) : null
    if (patch === null) {
      throw new DimFactoryError(
        'NOT_FOUND',
        'One of the two results is not kept any more, so they cannot be put against each other.',
      )
    }
    return patch
  }

  /**
   * Tidy the matches' leftovers (boot, and after each retention pass): a side B that is due, the starting ref once
   * both copies are made, the copies of sides that were not kept 7 days after the pick, and the record once both runs
   * are gone.
   */
  async sweep(): Promise<MatchSweep> {
    const d = this.#d
    const out: MatchSweep = { refsDropped: [], removed: [], copiesRemoved: [] }
    for (const id of await listMatchIds(d.paths)) {
      let rec = await readMatch(d.paths, id)
      if (rec === null) continue
      try {
        if (rec.pending !== undefined) {
          this.#waiting.add(id)
          if (d.autoStart) await this.#advance(id)
          rec = (await readMatch(d.paths, id)) ?? rec
          if (rec.pending !== undefined) continue
        }
        rec = await this.#keepResult(rec)
        const withRun = rec.sides.filter(
          (s): s is MatchSideRecord & { runId: string } => s.runId !== undefined,
        )
        const sums = withRun.map((s) => d.summary(s.runId))
        if (sums.every((s) => s === undefined)) {
          const gone = await Promise.all(withRun.map(async (s) => !(await d.runExists(s.runId))))
          if (gone.every(Boolean)) {
            if (rec.cleanedAt === undefined) await d.dropStartRef(rec.folderKey, id)
            await removeMatch(d.paths, id)
            out.removed.push(id)
          }
          continue
        }
        if (rec.cleanedAt === undefined && sums.every(copySettled)) {
          await d.dropStartRef(rec.folderKey, id)
          rec = { ...rec, cleanedAt: d.now() }
          await writeMatch(d.paths, rec)
          out.refsDropped.push(id)
        }
        const pick = rec.pick
        if (pick !== undefined && pick.copiesRemovedAt === undefined && d.now() - pick.at >= KEEP_MS) {
          let left = false
          for (const s of withRun) {
            // A rematch's sides are never applied: the picked one's copy goes too.
            if (rec.kind !== 'rematch' && s.side === pick.side) continue
            if (s.recorded === true) continue
            const sum = d.summary(s.runId)
            // Only a copy that was kept for later and still holds what the side built: anything the person did with
            // it since (applied it, discarded it, started on it again) is theirs.
            if (sum?.worktree?.state !== 'kept' || !sum.worktree.notApplied || sum.endedAt === undefined)
              continue
            if (!(await d.saveDiffs(s.runId).catch(() => false))) {
              left = true
              continue
            }
            await d.worktree.discard(s.runId)
            out.copiesRemoved.push(s.runId)
          }
          if (!left) {
            rec = { ...rec, pick: { ...pick, copiesRemovedAt: d.now() } }
            await writeMatch(d.paths, rec)
          }
        }
      } catch (err) {
        d.log.warn('match sweep: a match was left as it is', { matchId: id, err })
      }
    }
    return out
  }
}
