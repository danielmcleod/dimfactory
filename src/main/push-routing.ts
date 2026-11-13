// Push rules for `dimf:evt` (events.focus limits full streams to the open run and runs with asks). Pure:
// which run envelopes reach the renderer, what survives a batch
// overflow, and the per-run `run-summary` window.
import type { AppEvent } from '@shared/ipc.ts'
import type { RunEnvelope, RunStatus, RunSummary } from '@shared/run.ts'

/**
 * Stream focus protocol: `{t:'ev'}` bodies only for focused runs, except asks (always); every other body for every
 * run. The renderer checks seq continuity only for focused runs and replays a run's log when it focuses it.
 */
export function forwardsRunEnvelope(env: RunEnvelope, focused: ReadonlySet<string>): boolean {
  if (env.body.t !== 'ev') return true
  return env.body.ev.type === 'ask' || focused.has(env.runId)
}

/**
 * Batch overflow: drop the queued run envelopes (the renderer refetches them with runs.events) and keep everything
 * else, plus one `resync` naming every run that lost envelopes (merged with a resync already queued).
 */
export function keepOnOverflow(queued: readonly AppEvent[]): AppEvent[] {
  const runIds = new Set<string>()
  const keep: AppEvent[] = []
  for (const ev of queued) {
    if (ev.kind === 'run') runIds.add(ev.env.runId)
    else if (ev.kind === 'resync') for (const id of ev.runIds) runIds.add(id)
    else keep.push(ev)
  }
  if (runIds.size > 0) keep.push({ kind: 'resync', runIds: [...runIds] })
  return keep
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'failed',
  'cancelled',
])

export interface TimerApi {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * `run-summary` per run: the first summary opens a window of `delayMs`; when it closes the latest summary is sent
 * (trailing, latest wins). A busy run therefore updates at most once per window instead of never. A terminal status
 * is sent at once (and cancels the window).
 */
export class SummaryDebouncer {
  readonly #delayMs: number
  readonly #emit: (s: RunSummary) => void
  readonly #timers: TimerApi
  readonly #pending = new Map<string, { summary: RunSummary; timer: unknown }>()

  constructor(o: { delayMs: number; emit: (s: RunSummary) => void; timers?: TimerApi }) {
    this.#delayMs = o.delayMs
    this.#emit = o.emit
    this.#timers = o.timers ?? realTimers
  }

  get pendingRuns(): number {
    return this.#pending.size
  }

  push(summary: RunSummary): void {
    const runId = summary.runId
    const hit = this.#pending.get(runId)
    if (TERMINAL_RUN_STATUSES.has(summary.status)) {
      if (hit !== undefined) {
        this.#timers.clear(hit.timer)
        this.#pending.delete(runId)
      }
      this.#emit(summary)
      return
    }
    if (hit !== undefined) {
      hit.summary = summary
      return
    }
    const timer = this.#timers.set(() => this.#fire(runId), this.#delayMs)
    this.#pending.set(runId, { summary, timer })
  }

  /** Send every pending summary now. */
  flushAll(): void {
    for (const runId of [...this.#pending.keys()]) {
      const hit = this.#pending.get(runId)
      if (hit !== undefined) this.#timers.clear(hit.timer)
      this.#fire(runId)
    }
  }

  dispose(): void {
    for (const hit of this.#pending.values()) this.#timers.clear(hit.timer)
    this.#pending.clear()
  }

  #fire(runId: string): void {
    const hit = this.#pending.get(runId)
    if (hit === undefined) return
    this.#pending.delete(runId)
    this.#emit(hit.summary)
  }
}
