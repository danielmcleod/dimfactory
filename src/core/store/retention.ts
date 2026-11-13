// Run retention (`storage` {keepRuns, keepDays, rawLogDays}; shadow GC; background probes and retention at boot).
// This module holds the pure planner, the raw-log
// pruning, the report `dimf gc` prints and the scheduler (2 minutes after boot, then daily, only while idle).
// Deleting runs, their snapshot refs and isolated copies is history.ts's (the same path Remove uses).
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunSummary } from '../../shared/run.ts'
import type { ShadowGcResult } from '../git/shadow.ts'
import type { HomePaths } from '../home.ts'
import { silentLogger } from '../log.ts'
import type { Logger } from '../log.ts'

export interface RetentionPolicy {
  /** storage.keepRuns */
  keepRuns: number
  /** storage.keepDays */
  keepDays: number
  /** storage.rawLogDays */
  rawLogDays: number
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepRuns: 300, keepDays: 60, rawLogDays: 14 }
/** First retention pass after boot, when idle. */
export const RETENTION_BOOT_DELAY_MS = 2 * 60 * 1000
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
/** A pass due while runs are working waits this long before it looks again. */
export const RETENTION_RETRY_MS = 5 * 60 * 1000
/** A shadow gc that had to wait (its folder was used in the last 5 minutes) is tried again after this. */
export const RETENTION_GC_RETRY_MS = 10 * 60 * 1000
/** At most this many gc retries between two daily passes. */
const GC_RETRIES_MAX = 12

const DAY_MS = 24 * 60 * 60 * 1000

/** The policy from a config's `storage` section (user-only), missing keys from the builtin defaults. */
export function retentionPolicyOf(
  storage: { [K in keyof RetentionPolicy]?: number | undefined } | undefined,
): RetentionPolicy {
  return {
    keepRuns: storage?.keepRuns ?? DEFAULT_RETENTION.keepRuns,
    keepDays: storage?.keepDays ?? DEFAULT_RETENTION.keepDays,
    rawLogDays: storage?.rawLogDays ?? DEFAULT_RETENTION.rawLogDays,
  }
}

/** Why a run past keepRuns and keepDays is kept anyway. */
export type RetentionExemption = 'pinned' | 'active' | 'lock'

export interface RetentionPlan {
  /** Run ids to delete, oldest first. */
  remove: string[]
  /** Run ids kept. */
  keep: string[]
  /** Kept although past both rules: pinned, not finished, or holding its folder's lock (oldest first). */
  exempt: { runId: string; reason: RetentionExemption }[]
}

export interface PlanRetentionOptions {
  now: number
  /** Runs whose folder lock is held (a failed run holding its lock is not a candidate). */
  lockHeld?: ReadonlySet<string>
}

/**
 * Candidates are terminal (completed, cancelled) or lock-free failed runs that are not pinned. Keep the newest
 * `keepRuns` of all runs plus anything newer than `keepDays`; the remaining candidates are removed.
 */
export function planRetention(
  summaries: readonly RunSummary[],
  policy: RetentionPolicy,
  opts: PlanRetentionOptions,
): RetentionPlan {
  const newestFirst = [...summaries].sort((a, b) => b.createdAt - a.createdAt || b.displayNo - a.displayNo)
  const cutoff = opts.now - policy.keepDays * DAY_MS
  const remove: string[] = []
  const keep: string[] = []
  const exempt: { runId: string; reason: RetentionExemption }[] = []
  newestFirst.forEach((s, i) => {
    const locked = opts.lockHeld?.has(s.runId) ?? false
    const finished =
      s.status === 'completed' || s.status === 'cancelled' || (s.status === 'failed' && !locked)
    const candidate = !s.pinned && finished && !locked
    const protectedByRule = i < policy.keepRuns || s.createdAt >= cutoff
    if (candidate && !protectedByRule) remove.push(s.runId)
    else {
      keep.push(s.runId)
      if (!protectedByRule) {
        const ended = s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'
        exempt.push({ runId: s.runId, reason: s.pinned ? 'pinned' : ended ? 'lock' : 'active' })
      }
    }
  })
  return { remove: remove.reverse(), keep, exempt: exempt.reverse() }
}

/** UI copy for an exemption (dimf gc's plan). */
export const EXEMPTION_TEXT: Readonly<Record<RetentionExemption, string>> = {
  pinned: 'pinned',
  active: 'not finished',
  lock: 'still holds its folder',
}

export interface RawLogPrune {
  /** Files deleted (or that would be). */
  files: number
  bytes: number
}

/**
 * Delete each listed run's raw vendor logs (`runs/<id>/raw/*`) last written before `cutoff` (rawLogDays applies even
 * for runs retention keeps). The caller lists only finished, lock-free runs.
 */
export async function pruneRawLogs(
  paths: HomePaths,
  runIds: readonly string[],
  cutoff: number,
  o: { dryRun?: boolean } = {},
): Promise<RawLogPrune> {
  const out: RawLogPrune = { files: 0, bytes: 0 }
  for (const runId of runIds) {
    let dir: string
    try {
      dir = paths.run(runId).rawDir
    } catch {
      continue
    }
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      const file = join(dir, name)
      const st = await stat(file).catch(() => null)
      if (st === null || !st.isFile() || st.mtimeMs >= cutoff) continue
      if (o.dryRun !== true) {
        const gone = await rm(file, { force: true, maxRetries: 3, retryDelay: 100 }).then(
          () => true,
          () => false,
        )
        if (!gone) continue
      }
      out.files++
      out.bytes += st.size
    }
  }
  return out
}

/** One run in a retention report. */
export interface RetentionRunRow {
  runId: string
  displayNo: number
  title: string
  folder: string
  createdAt: number
}

/** What a retention pass did (or, with `dryRun`, would do). */
export interface RetentionReport {
  dryRun: boolean
  at: number
  policy: RetentionPolicy
  /** Runs deleted (or that would be), with their snapshots, raw logs and finalized isolated copies. */
  removed: RetentionRunRow[]
  /** Runs past keepRuns and keepDays that stay, and why. */
  kept: (RetentionRunRow & { reason: string })[]
  /** Runs whose deletion failed this time (tried again by the next pass). */
  failed: (RetentionRunRow & { reason: string })[]
  /** Isolated copies of kept runs removed (applied, or with no changes, more than a day ago). */
  copies: RetentionRunRow[]
  rawLogs: RawLogPrune
  /** Pending removals (Remove's deferred delete) carried out by this pass. */
  pendingRemoved: number
  gc: ShadowGcResult[]
  /** A shadow gc had to wait for its folder to be idle: try again later. */
  gcPending: boolean
}

export const rowOf = (s: RunSummary): RetentionRunRow => ({
  runId: s.runId,
  displayNo: s.displayNo,
  title: s.title,
  folder: s.folder,
  createdAt: s.createdAt,
})

export interface SchedulerTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** Real timers that never keep the process alive. */
export const unrefTimers: SchedulerTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, Math.max(0, ms))
    t.unref()
    return t
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface RetentionSchedulerOptions {
  /** A full pass (retention, then gc). */
  run: () => Promise<{ gcPending: boolean }>
  /** A gc-only pass over the shadows still waiting. */
  gc: () => Promise<{ gcPending: boolean }>
  /** No run is working (a pass due while one is waits RETENTION_RETRY_MS). */
  idle: () => boolean
  bootDelayMs?: number
  intervalMs?: number
  retryMs?: number
  gcRetryMs?: number
  timers?: SchedulerTimers
  log?: Logger
}

/**
 * Background retention: the first pass 2 minutes after boot, then every 24 hours, each only
 * while idle; a shadow gc that had to wait is tried again every 10 minutes (at most 12 times a day).
 */
export class RetentionScheduler {
  readonly #o: RetentionSchedulerOptions
  readonly #timers: SchedulerTimers
  readonly #log: Logger
  #full: unknown = undefined
  #gc: unknown = undefined
  #gcTries = 0
  #busy: Promise<void> | undefined
  #stopped = true

  constructor(o: RetentionSchedulerOptions) {
    this.#o = o
    this.#timers = o.timers ?? unrefTimers
    this.#log = o.log ?? silentLogger
  }

  get started(): boolean {
    return !this.#stopped
  }

  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.#armFull(this.#o.bootDelayMs ?? RETENTION_BOOT_DELAY_MS)
  }

  stop(): void {
    this.#stopped = true
    if (this.#full !== undefined) this.#timers.clear(this.#full)
    if (this.#gc !== undefined) this.#timers.clear(this.#gc)
    this.#full = undefined
    this.#gc = undefined
  }

  /** The pass in progress, if any (tests, shutdown). */
  async settled(): Promise<void> {
    await this.#busy
  }

  #armFull(ms: number): void {
    if (this.#stopped) return
    if (this.#full !== undefined) this.#timers.clear(this.#full)
    this.#full = this.#timers.set(() => {
      this.#full = undefined
      this.#busy = this.#tick('full')
    }, ms)
  }

  #armGc(): void {
    if (this.#stopped || this.#gc !== undefined || this.#gcTries >= GC_RETRIES_MAX) return
    this.#gcTries++
    this.#gc = this.#timers.set(() => {
      this.#gc = undefined
      this.#busy = this.#tick('gc')
    }, this.#o.gcRetryMs ?? RETENTION_GC_RETRY_MS)
  }

  async #tick(kind: 'full' | 'gc'): Promise<void> {
    if (this.#stopped) return
    if (!this.#o.idle()) {
      if (kind === 'full') this.#armFull(this.#o.retryMs ?? RETENTION_RETRY_MS)
      else this.#armGc()
      return
    }
    try {
      const r = kind === 'full' ? await this.#o.run() : await this.#o.gc()
      if (kind === 'full') this.#gcTries = 0
      if (r.gcPending) this.#armGc()
    } catch (err) {
      this.#log.error(`retention ${kind} pass failed`, { err })
    }
    if (kind === 'full') this.#armFull(this.#o.intervalMs ?? RETENTION_INTERVAL_MS)
  }
}
