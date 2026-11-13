// The estimates' data (from RunSummary.steps[], final attempt only). Built once
// from runs/index.jsonl and kept current from the index's own put/del changes, so `estimates.get` never re-reads the
// index. Each finished run contributes one sample per step row to every lookup level's key, and one entry to the
// P(fix) lists when a reviewer finished.
//
// Definitions (they pin down what the estimate rules leave open):
//   - finished run = status completed or cancelled (endedAt set). A failed run still holds its lock and may be
//     retried, so its rows are not final yet.
//   - sample = a step row whose final attempt ended `done` (a success) or `failed`. Skipped and cancelled rows say
//     nothing about how long the step takes and are left out. preflight and finalize are not sampled.
//   - window = a key's SAMPLE_WINDOW most recent samples (run createdAt, then displayNo); a level is used when the
//     window holds MIN_SUCCESSES successes, and its figures come from those successes.
//   - P(fix) = among the most recent SAMPLE_WINDOW finished runs where Review or Critic finished `done`, the share in
//     which Fix ran (a fix row that was not skipped).
//   - Fix until green's rounds = among the most recent SAMPLE_WINDOW finished runs whose Fix ran with the loop on
//     (RunSummary.fixLoop, a cap above 1), the rounds each took.
import type { Usage } from '../../shared/events.ts'
import type { InputBytesBucket, Mode, RunSummary } from '../../shared/run.ts'
import type { IndexChange } from '../store/index-store.ts'
import { MIN_SUCCESSES, P_FIX_PRIOR, SAMPLE_WINDOW, estimateStepOf, percentile } from './defaults.ts'
import type { EstimateStep } from './defaults.ts'

export interface StepSample {
  runId: string
  /** The run's createdAt; with `no` (displayNo) the order windows are taken in. */
  at: number
  no: number
  /** The final attempt ended `done`. */
  ok: boolean
  activeMs: number
  /** The final attempt's usage; absent when unreported or approximate (then no tokens or cost from it). */
  usage?: Usage
}

/** `null` model = the CLI's default model, recorded as configured. */
const modelKey = (model: string | null | undefined): string => model ?? ''

/** Lookup keys, most specific first (levels 1–4). */
export const sampleKey = {
  exact: (vendor: string, model: string | null, mode: Mode, step: EstimateStep, bucket: InputBytesBucket) =>
    JSON.stringify(['x', vendor, modelKey(model), mode, step, bucket]),
  /** Level 1 when the input size is not known yet (see estimate.ts). */
  exactAnyBucket: (vendor: string, model: string | null, mode: Mode, step: EstimateStep) =>
    JSON.stringify(['xm', vendor, modelKey(model), mode, step]),
  model: (vendor: string, model: string | null, step: EstimateStep) =>
    JSON.stringify(['m', vendor, modelKey(model), step]),
  vendor: (vendor: string, step: EstimateStep) => JSON.stringify(['v', vendor, step]),
  step: (step: EstimateStep) => JSON.stringify(['s', step]),
}

interface ReviewedRun {
  runId: string
  at: number
  no: number
  fixed: boolean
}

/** A finished Fix until green run: how many rounds it took (RunSummary.fixLoop.rounds). */
interface LoopedRun {
  runId: string
  at: number
  no: number
  rounds: number
}

interface Contribution {
  keys: string[]
  folderKey: string
  reviewed: boolean
  looped: boolean
}

/** Fix until green's expected rounds (estimate.ts weighs Fix, its verify round and its re-check by them). */
export interface FixRoundsExpectation {
  /** The mean rounds a looped run took (each clamped to the cap now). */
  p50: number
  /** The rounds 80% of them stayed within (at least p50). */
  p80: number
  basis: 'folder' | 'global' | 'prior'
}

type Ordered = { at: number; no: number }

const before = (a: Ordered, b: Ordered): boolean => a.at < b.at || (a.at === b.at && a.no < b.no)

/**
 * Insert keeping oldest → newest, after any equal entries. A run finishing now is the newest, so the common case
 * appends; otherwise the position is found by binary search (no scan per insert).
 */
function insertOrdered<T extends Ordered>(list: T[], item: T): void {
  const last = list[list.length - 1]
  if (last === undefined || !before(item, last)) {
    list.push(item)
    return
  }
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (before(item, list[mid] as T)) hi = mid
    else lo = mid + 1
  }
  list.splice(lo, 0, item)
}

/** Oldest first (createdAt, then displayNo): the order the lists keep, so a bulk build only appends. */
const oldestFirst = (a: RunSummary, b: RunSummary): number =>
  a.createdAt - b.createdAt || a.displayNo - b.displayNo

function removeRun<T extends { runId: string }>(list: T[] | undefined, runId: string): void {
  if (list === undefined) return
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.runId === runId) list.splice(i, 1)
}

const SAMPLED_STATUSES = new Set(['done', 'failed'])
const SKIPPED_STEPS = new Set(['preflight', 'finalize'])

export function isFinishedSummary(s: RunSummary): boolean {
  return s.status === 'completed' || s.status === 'cancelled'
}

export class EstimateAggregate {
  readonly #byKey = new Map<string, StepSample[]>()
  readonly #runs = new Map<string, Contribution>()
  readonly #reviewed: ReviewedRun[] = []
  readonly #reviewedByFolder = new Map<string, ReviewedRun[]>()
  readonly #looped: LoopedRun[] = []
  readonly #loopedByFolder = new Map<string, LoopedRun[]>()

  /** Start from the index's summaries (any order). */
  static from(summaries: Iterable<RunSummary>): EstimateAggregate {
    const a = new EstimateAggregate()
    a.putAll(summaries)
    return a
  }

  /**
   * Add many runs at once (the boot build from the runs index, which lists newest first): sorted oldest first so
   * every list only appends, O(n log n) for the whole build.
   */
  putAll(summaries: Iterable<RunSummary>): void {
    for (const s of [...summaries].sort(oldestFirst)) this.put(s)
  }

  /** Feed an index change (IndexStore `onChange`). */
  apply(change: IndexChange): void {
    if (change.op === 'put') this.put(change.summary)
    else this.del(change.runId)
  }

  /** Upsert one run's contribution (replaces what it contributed before). */
  put(s: RunSummary): void {
    this.del(s.runId)
    if (!isFinishedSummary(s)) return
    const keys: string[] = []
    const add = (key: string, sample: StepSample): void => {
      let list = this.#byKey.get(key)
      if (list === undefined) {
        list = []
        this.#byKey.set(key, list)
      }
      insertOrdered(list, sample)
      keys.push(key)
    }
    for (const row of s.steps) {
      if (SKIPPED_STEPS.has(row.key) || !SAMPLED_STATUSES.has(row.status)) continue
      const step = estimateStepOf(row.key)
      const sample: StepSample = {
        runId: s.runId,
        at: s.createdAt,
        no: s.displayNo,
        ok: row.status === 'done',
        activeMs: Math.max(0, row.activeMs),
        ...(row.usage !== undefined && row.usageApprox !== true ? { usage: row.usage } : {}),
      }
      add(sampleKey.step(step), sample)
      if (row.vendor === undefined) continue
      const model = row.model ?? null
      add(sampleKey.vendor(row.vendor, step), sample)
      add(sampleKey.model(row.vendor, model, step), sample)
      if (row.mode !== undefined) {
        add(sampleKey.exactAnyBucket(row.vendor, model, row.mode, step), sample)
        if (row.inBytesBucket !== undefined)
          add(sampleKey.exact(row.vendor, model, row.mode, step, row.inBytesBucket), sample)
      }
    }
    const reviewed = s.steps.some((r) => (r.key === 'review' || r.key === 'critic') && r.status === 'done')
    if (reviewed) {
      const fixed = s.steps.some((r) => r.key === 'fix' && r.status !== 'skipped')
      const entry: ReviewedRun = { runId: s.runId, at: s.createdAt, no: s.displayNo, fixed }
      insertOrdered(this.#reviewed, entry)
      let folder = this.#reviewedByFolder.get(s.folderKey)
      if (folder === undefined) {
        folder = []
        this.#reviewedByFolder.set(s.folderKey, folder)
      }
      insertOrdered(folder, { ...entry })
    }
    // Fix until green: the rounds a looped run took (a run whose Fix never ran has none).
    const fixRan = s.steps.some((r) => r.key === 'fix' && r.status !== 'skipped')
    const looped = s.fixLoop !== undefined && s.fixLoop.max > 1 && s.fixLoop.rounds >= 1 && fixRan
    if (looped && s.fixLoop !== undefined) {
      const entry: LoopedRun = { runId: s.runId, at: s.createdAt, no: s.displayNo, rounds: s.fixLoop.rounds }
      insertOrdered(this.#looped, entry)
      let folder = this.#loopedByFolder.get(s.folderKey)
      if (folder === undefined) {
        folder = []
        this.#loopedByFolder.set(s.folderKey, folder)
      }
      insertOrdered(folder, { ...entry })
    }
    if (keys.length > 0 || reviewed || looped)
      this.#runs.set(s.runId, { keys, folderKey: s.folderKey, reviewed, looped })
  }

  del(runId: string): void {
    const c = this.#runs.get(runId)
    if (c === undefined) return
    this.#runs.delete(runId)
    for (const key of new Set(c.keys)) {
      const list = this.#byKey.get(key)
      removeRun(list, runId)
      if (list !== undefined && list.length === 0) this.#byKey.delete(key)
    }
    if (c.reviewed) {
      removeRun(this.#reviewed, runId)
      removeRun(this.#reviewedByFolder.get(c.folderKey), runId)
    }
    if (c.looped) {
      removeRun(this.#looped, runId)
      removeRun(this.#loopedByFolder.get(c.folderKey), runId)
    }
  }

  /**
   * Fix until green's expected rounds under a cap of `max`: from the folder's most recent SAMPLE_WINDOW looped runs
   * (at least MIN_SUCCESSES of them), else every folder's, else the prior: one round at p50 (a run is often green after
   * it) and every round at p80 (later rounds may run).
   */
  fixRounds(folderKey: string | null, max: number): FixRoundsExpectation {
    const cap = Math.max(1, Math.floor(max))
    const from = (list: readonly LoopedRun[] | undefined): Omit<FixRoundsExpectation, 'basis'> | null => {
      if (list === undefined) return null
      const w = list.length <= SAMPLE_WINDOW ? list : list.slice(list.length - SAMPLE_WINDOW)
      if (w.length < MIN_SUCCESSES) return null
      const rounds = w.map((r) => Math.min(cap, Math.max(1, r.rounds)))
      const mean = rounds.reduce((a, b) => a + b, 0) / rounds.length
      return { p50: mean, p80: Math.max(mean, percentile(rounds, 80)) }
    }
    const folder = folderKey !== null ? from(this.#loopedByFolder.get(folderKey)) : null
    if (folder !== null) return { ...folder, basis: 'folder' }
    const global = from(this.#looped)
    if (global !== null) return { ...global, basis: 'global' }
    return { p50: 1, p80: cap, basis: 'prior' }
  }

  /** Runs contributing samples or a P(fix) entry. */
  get runs(): number {
    return this.#runs.size
  }

  /** A key's most recent SAMPLE_WINDOW samples, oldest first. */
  window(key: string): readonly StepSample[] {
    const list = this.#byKey.get(key)
    if (list === undefined) return []
    return list.length <= SAMPLE_WINDOW ? list : list.slice(list.length - SAMPLE_WINDOW)
  }

  /** The successes of a key's window when there are at least MIN_SUCCESSES of them, else null. */
  successes(key: string): StepSample[] | null {
    const ok = this.window(key).filter((x) => x.ok)
    return ok.length >= MIN_SUCCESSES ? ok : null
  }

  /** P(fix) from the folder's reviewed runs, else every folder's, else the prior (the run total's P(fix)). */
  pFix(folderKey: string | null): { value: number; basis: 'folder' | 'global' | 'prior' } {
    const share = (list: readonly ReviewedRun[] | undefined): number | null => {
      if (list === undefined) return null
      const w = list.length <= SAMPLE_WINDOW ? list : list.slice(list.length - SAMPLE_WINDOW)
      if (w.length < MIN_SUCCESSES) return null
      return w.filter((r) => r.fixed).length / w.length
    }
    const folder = folderKey !== null ? share(this.#reviewedByFolder.get(folderKey)) : null
    if (folder !== null) return { value: folder, basis: 'folder' }
    const global = share(this.#reviewed)
    if (global !== null) return { value: global, basis: 'global' }
    return { value: P_FIX_PRIOR, basis: 'prior' }
  }
}
