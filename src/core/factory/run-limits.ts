// A run's own limits (config `limits`: the run's overrides or any layer; null: none, the default). The watcher follows
// every run that has a limit through its summaries and stops it, as the user's Stop does, once its cost passes
// `maxCostUsd` or it has worked `maxMinutes`. Working time leaves out the time the run waits for the user (a question,
// a card, an ask, a pause) or for its folder, so walking away from a question never stops a run. The budget rules are
// the factory's (budget.ts duringRun, a per-run limit and no daily one); why a run was stopped is kept beside it
// (`runs/<id>/limit-stop.json`) for the views that say "It stopped at your limit". What the run made stays in the folder.
import { readFile } from 'node:fs/promises'
import type { RunLimits } from '../../shared/config-schema.ts'
import type { LimitStop } from '../../shared/easy.ts'
import type { RunStatus, RunSummary } from '../../shared/run.ts'
import type { EventBus } from '../bus/bus.ts'
import type { Logger } from '../log.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import type { Clock, TimerHandle } from '../supervisor/effects.ts'
import { duringRun } from './budget.ts'

/** Statuses in which a run spends nothing: it waits for the user, for its folder, or has been paused. */
const IDLE: ReadonlySet<RunStatus> = new Set(['queued', 'waiting', 'paused'])
const ENDED: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled'])

export interface RunLimitsDeps {
  clock: Clock
  log: Logger
  bus: Pick<EventBus, 'attach'>
  /** The run's own limits (its resolved config's `limits`); null when it has none or is unknown. */
  limitsOf(runId: string): RunLimits | null
  summary(runId: string): RunSummary | undefined
  /** Stop a run (as the user's Stop does). */
  stopRun(runId: string): Promise<void>
  /** Where a run's stop record goes (`runs/<id>/limit-stop.json`). */
  stopFile(runId: string): string
}

interface Tracked {
  /** Time spent idle so far (closed periods). */
  idleMs: number
  /** When the open idle period began. */
  idleSince?: number
  timer?: TimerHandle
}

export class RunLimitsWatcher {
  readonly #d: RunLimitsDeps
  readonly #runs = new Map<string, Tracked>()
  readonly #stopping = new Set<string>()
  #detach: (() => void) | undefined

  constructor(d: RunLimitsDeps) {
    this.#d = d
  }

  /** Follow run summaries from now on. */
  start(): void {
    this.#detach = this.#d.bus.attach({
      name: 'run-limits',
      global: (ev) => {
        if (ev.kind === 'run-summary') this.onSummary(ev.summary)
      },
    })
  }

  close(): void {
    this.#detach?.()
    for (const t of this.#runs.values()) if (t.timer !== undefined) this.#d.clock.clearTimer(t.timer)
    this.#runs.clear()
  }

  /** A run's working time now: since it was created, less the time it spent idle. */
  workedMs(s: RunSummary, now = this.#d.clock.now()): number {
    const t = this.#runs.get(s.runId)
    const idle = (t?.idleMs ?? 0) + (t?.idleSince !== undefined ? now - t.idleSince : 0)
    return Math.max(0, now - s.createdAt - idle)
  }

  /** Called with every summary a run publishes (the bus), and by tests. */
  onSummary(s: RunSummary): void {
    if (ENDED.has(s.status)) {
      this.#forget(s.runId)
      return
    }
    const limits = this.#d.limitsOf(s.runId)
    if (limits === null || (limits.maxCostUsd === null && limits.maxMinutes === null)) return
    const now = this.#d.clock.now()
    const t = this.#runs.get(s.runId) ?? { idleMs: 0 }
    this.#runs.set(s.runId, t)
    if (IDLE.has(s.status)) t.idleSince ??= now
    else if (t.idleSince !== undefined) {
      t.idleMs += now - t.idleSince
      delete t.idleSince
    }
    if (this.#check(s, limits, now)) return
    this.#arm(s, limits, now)
  }

  /** Stop the run when a limit is reached; true when it was. Time is only checked while the run works. */
  #check(s: RunSummary, limits: RunLimits, now: number): boolean {
    if (this.#stopping.has(s.runId)) return true
    const worked = this.workedMs(s, now)
    const hit = duringRun(
      {
        maxCostPerRunUsd: limits.maxCostUsd,
        maxCostPerDayUsd: null,
        maxMinutesPerRun: IDLE.has(s.status) ? null : limits.maxMinutes,
        stopAfterFailures: null,
      },
      {
        runCostUsd: s.progress.costUsd,
        daySpentUsd: 0,
        startedAt: now - worked,
        now,
        displayNo: s.displayNo,
      },
    )
    if (hit === undefined) return false
    const time = hit.category === 'time_limit'
    const stop: LimitStop = {
      kind: time ? 'time' : 'cost',
      limit: time ? (limits.maxMinutes ?? 0) : (limits.maxCostUsd ?? 0),
      costUsd: s.progress.costUsd,
      workedMs: worked,
      at: now,
    }
    this.#stopping.add(s.runId)
    this.#d.log.info('a run reached its own limit; stopping it', { runId: s.runId, kind: stop.kind })
    void this.#stop(s.runId, stop)
    return true
  }

  async #stop(runId: string, stop: LimitStop): Promise<void> {
    // Recorded first, so the run's end already reads as this stop when its last summary arrives.
    await writeFileAtomic(this.#d.stopFile(runId), `${JSON.stringify({ schemaVersion: 1, ...stop })}\n`, {
      mode: 0o600,
    }).catch((err: unknown) => this.#d.log.warn('the limit stop could not be recorded', { runId, err }))
    await this.#d
      .stopRun(runId)
      .catch((err: unknown) => this.#d.log.warn('stopping a run at its limit failed', { runId, err }))
  }

  /** A time limit is checked again when the run's working time would reach it (re-armed with each summary). */
  #arm(s: RunSummary, limits: RunLimits, now: number): void {
    const t = this.#runs.get(s.runId)
    if (t === undefined) return
    if (t.timer !== undefined) this.#d.clock.clearTimer(t.timer)
    delete t.timer
    if (limits.maxMinutes === null || IDLE.has(s.status)) return
    const left = limits.maxMinutes * 60_000 - this.workedMs(s, now)
    const runId = s.runId
    const timer = this.#d.clock.setTimer(
      () => {
        const cur = this.#d.summary(runId)
        const lim = this.#d.limitsOf(runId)
        if (cur === undefined || lim === null || ENDED.has(cur.status)) return
        if (!this.#check(cur, lim, this.#d.clock.now())) this.#arm(cur, lim, this.#d.clock.now())
      },
      now + Math.max(0, left),
    )
    ;(timer as { unref?: () => void }).unref?.()
    t.timer = timer
  }

  #forget(runId: string): void {
    const t = this.#runs.get(runId)
    if (t?.timer !== undefined) this.#d.clock.clearTimer(t.timer)
    this.#runs.delete(runId)
    this.#stopping.delete(runId)
  }
}

/** A run's limit stop as recorded beside it, or undefined (none, or unreadable). */
export async function readLimitStop(file: string): Promise<LimitStop | undefined> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as Partial<LimitStop> & { schemaVersion?: unknown }
    if (v.schemaVersion !== 1 || (v.kind !== 'cost' && v.kind !== 'time')) return undefined
    if (typeof v.limit !== 'number' || typeof v.workedMs !== 'number' || typeof v.at !== 'number')
      return undefined
    return {
      kind: v.kind,
      limit: v.limit,
      costUsd: typeof v.costUsd === 'number' ? v.costUsd : null,
      workedMs: v.workedMs,
      at: v.at,
    }
  } catch {
    return undefined
  }
}
