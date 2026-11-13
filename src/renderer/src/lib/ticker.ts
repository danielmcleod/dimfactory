// One shared 1 s ticker for every elapsed time, countdown and ETA. The
// interval runs only while something subscribes, so an idle window does no timer work.
import { useState, useSyncExternalStore } from 'react'

export const TICK_MS = 1000

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function tick(): void {
  now = Date.now()
  for (const l of [...listeners]) l()
}

export function subscribeNow(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    now = Date.now()
    timer = setInterval(tick, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** The time of the last tick (stable between ticks, as useSyncExternalStore requires). */
export function getNow(): number {
  return now
}

const noSubscribe = (): (() => void) => () => {}

/** Current time, re-rendering once a second. With `live` false it is the mount time and never re-renders. */
export function useNow(live = true): number {
  const [mountedAt] = useState(Date.now)
  const ticking = useSyncExternalStore(live ? subscribeNow : noSubscribe, getNow)
  return live ? ticking : mountedAt
}

/** Tests: stop the interval and forget subscribers. */
export function resetTicker(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  listeners.clear()
  now = Date.now()
}
