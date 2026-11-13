// The IPC push sink (16–33 ms batched IPC): a
// BusSink on core.bus plus main's own events, batched by TimeWindowBatcher and sent as one `dimf:evt` message
// per window. Electron-free: the target (the window's webContents) is injected.
import type { BusSink, GlobalEvent } from '@core/bus/bus.ts'
import { TimeWindowBatcher } from '@core/bus/batcher.ts'
import type { BatcherOptions } from '@core/bus/batcher.ts'
import type { Logger } from '@core/log.ts'
import type { AppEvent } from '@shared/ipc.ts'
import { EVT_CHANNEL } from '@shared/ipc.ts'
import type { RunEnvelope } from '@shared/run.ts'
import { HEARTBEAT_MS, SUMMARY_DEBOUNCE_MS } from './constants.ts'
import { SummaryDebouncer, forwardsRunEnvelope, keepOnOverflow, realTimers } from './push-routing.ts'
import type { TimerApi } from './push-routing.ts'

export interface PushTarget {
  send(channel: string, batch: AppEvent[]): void
}

export interface PushSinkOptions {
  /** The live renderer, or null (no window, destroyed): the batch is dropped. */
  target: () => PushTarget | null
  log?: Pick<Logger, 'warn' | 'error'>
  summaryDelayMs?: number
  timers?: TimerApi
  /** Test seams for the batcher windows and bounds. */
  batcher?: Omit<BatcherOptions<AppEvent>, 'flush' | 'sizeOf' | 'onOverflow' | 'onError'>
}

/** JSON size of one event: the batcher's 2 MB overflow bound. */
export function eventSize(ev: AppEvent): number {
  try {
    return JSON.stringify(ev).length
  } catch {
    return 0
  }
}

export class PushSink implements BusSink {
  readonly name = 'ipc-push'
  readonly #o: PushSinkOptions
  readonly #batcher: TimeWindowBatcher<AppEvent>
  readonly #summaries: SummaryDebouncer
  #focused = new Set<string>()
  #disposed = false
  #sentBatches = 0

  constructor(o: PushSinkOptions) {
    this.#o = o
    this.#batcher = new TimeWindowBatcher<AppEvent>({
      ...o.batcher,
      flush: (items) => this.#deliver(items),
      sizeOf: eventSize,
      onOverflow: (queued) => {
        o.log?.warn('push queue overflow; run envelopes dropped, renderer resyncs', { queued: queued.length })
        return keepOnOverflow(queued)
      },
      onError: (err) => o.log?.error('push batch failed', { err }),
    })
    this.#summaries = new SummaryDebouncer({
      delayMs: o.summaryDelayMs ?? SUMMARY_DEBOUNCE_MS,
      emit: (summary) => this.#batcher.push({ kind: 'run-summary', summary }),
      timers: o.timers ?? realTimers,
    })
  }

  // ---- BusSink (synchronous, enqueue only) ----

  run(env: RunEnvelope): void {
    if (this.#disposed || !forwardsRunEnvelope(env, this.#focused)) return
    this.#batcher.push({ kind: 'run', env })
  }

  global(ev: GlobalEvent): void {
    this.emit(ev)
  }

  /** Main's own events (theme, app, heartbeat, toast) and bus globals. */
  emit(ev: AppEvent): void {
    if (this.#disposed) return
    if (ev.kind === 'run-summary') this.#summaries.push(ev.summary)
    else if (ev.kind === 'run') this.run(ev.env)
    else this.#batcher.push(ev)
  }

  // ---- focus / renderer lifecycle ----

  /** events.focus: the runs the renderer shows in full. */
  setFocus(runIds: readonly string[]): void {
    this.#focused = new Set(runIds)
  }

  get focused(): ReadonlySet<string> {
    return this.#focused
  }

  /** The renderer is reloading: nothing queued is useful to the new page, which focuses again itself. */
  resetForReload(): void {
    this.#batcher.clear()
    this.#focused = new Set()
  }

  /** Deliver everything queued now (pending summaries included), e.g. before quitting. */
  flush(): void {
    this.#summaries.flushAll()
    this.#batcher.flushNow()
  }

  get queued(): number {
    return this.#batcher.length
  }

  get sentBatches(): number {
    return this.#sentBatches
  }

  dispose(): void {
    this.#disposed = true
    this.#summaries.dispose()
    this.#batcher.dispose()
  }

  #deliver(items: AppEvent[]): void {
    const target = this.#o.target()
    if (target === null) return
    target.send(EVT_CHANNEL, items)
    this.#sentBatches++
  }
}

export interface HeartbeatOptions {
  /** Window visible or a run active (the heartbeat). */
  shouldBeat: () => boolean
  beat: (at: number) => void
  intervalMs?: number
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (h: unknown) => void
}

/** Starts beating at once, then every 5 s while `shouldBeat()`. Returns the stop function. */
export function startHeartbeat(o: HeartbeatOptions): () => void {
  const now = o.now ?? Date.now
  const tick = (): void => {
    if (o.shouldBeat()) o.beat(now())
  }
  const set = o.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clear = o.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
  tick()
  const h = set(tick, o.intervalMs ?? HEARTBEAT_MS)
  return () => clear(h)
}
