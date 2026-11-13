// Main event-loop monitor (if main's event-loop p95 exceeds 100 ms, core moves into a
// utilityProcess). perf_hooks histograms at 10 ms resolution: one window is
// logged (p50/p95/max) and reset every 60 s; a second one runs since boot or the last reset() and feeds the smoke
// line and e2e.state.
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { Histogram } from 'node:perf_hooks'
import { EVENT_LOOP_LOG_MS, EVENT_LOOP_RESOLUTION_MS } from './constants.ts'

export interface EventLoopStats {
  p50Ms: number
  p95Ms: number
  maxMs: number
  samples: number
}

export interface EventLoopMonitor {
  /** Since boot or the last reset(). */
  read(): EventLoopStats
  reset(): void
  /** Where the 60 s summaries go (the core logger exists only after createCore). */
  setLog(log: (msg: string, data: Record<string, unknown>) => void): void
  stop(): void
}

const NS_PER_MS = 1e6
const round = (ms: number): number => Math.round(ms * 10) / 10

export function statsOf(h: Pick<Histogram, 'count' | 'percentile' | 'max'>): EventLoopStats {
  if (h.count === 0) return { p50Ms: 0, p95Ms: 0, maxMs: 0, samples: 0 }
  return {
    p50Ms: round(h.percentile(50) / NS_PER_MS),
    p95Ms: round(h.percentile(95) / NS_PER_MS),
    maxMs: round(h.max / NS_PER_MS),
    samples: h.count,
  }
}

export function startEventLoopMonitor(
  o: { resolutionMs?: number; logEveryMs?: number } = {},
): EventLoopMonitor {
  const resolution = o.resolutionMs ?? EVENT_LOOP_RESOLUTION_MS
  const total = monitorEventLoopDelay({ resolution })
  const window = monitorEventLoopDelay({ resolution })
  total.enable()
  window.enable()
  let log: ((msg: string, data: Record<string, unknown>) => void) | undefined
  const timer = setInterval(() => {
    const s = statsOf(window)
    window.reset()
    log?.('event loop delay (60 s window)', { ...s })
  }, o.logEveryMs ?? EVENT_LOOP_LOG_MS)
  timer.unref()
  return {
    read: () => statsOf(total),
    reset: () => total.reset(),
    setLog: (fn) => {
      log = fn
    },
    stop: () => {
      clearInterval(timer)
      total.disable()
      window.disable()
    },
  }
}
