// Core's clock in the renderer (core's timers; one shared 1 s ticker). Deadlines core sends
// (an ask's expiresAt, a pending deny, wait_until) are core times, and under DIM_FACTORY_E2E_TIME_SCALE core's clock
// runs `scale`× faster than this window's, so every countdown reads coreNow(), never Date.now().
// The mapping is an anchor (core time at a local instant) plus a scale. It moves only when core says otherwise by
// more than a small tolerance: a heartbeat that disagrees, a live envelope stamped later than core's predicted
// "now" (a suspend, `e2e.clock`), or under E2E an `e2e.state` reading, which carries core's own now and scale.
import type { AppEvent, AppInfo, E2EState, Result } from '@shared/ipc.ts'
import { useNow } from './ticker.ts'

/** Real milliseconds of disagreement tolerated before the anchor moves (IPC batching is 16–33 ms). */
export const DRIFT_TOLERANCE_MS = 250

interface Anchor {
  core: number
  local: number
}

/** Reads `e2e.state` (only under DIM_FACTORY_E2E=1). */
export type E2EClockSource = () => Promise<Result<Pick<E2EState, 'now' | 'timeScale'>>>

let anchor: Anchor | null = null
let scale = 1
let e2eSource: E2EClockSource | null = null
let syncing = false
let generation = 0

const validScale = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/** Core's time at the local instant `local` (default: now). Identity until core says otherwise. */
export function coreNow(local: number = Date.now()): number {
  return anchor === null ? local : anchor.core + (local - anchor.local) * scale
}

/** Core milliseconds per local millisecond (1 outside compressed-time E2E runs). */
export function coreTimeScale(): number {
  return scale
}

/** Core ms left until a core deadline (never negative). */
export function coreRemainingMs(deadline: number, local: number = Date.now()): number {
  return Math.max(0, deadline - coreNow(local))
}

/** Core's time now, re-rendering once a second with the shared ticker (`live` false: as of mount). */
export function useCoreNow(live = true): number {
  return coreNow(useNow(live))
}

function setAnchor(core: number, local: number): void {
  anchor = { core, local }
}

/** The tolerance in core milliseconds at the current scale. */
function tolerance(): number {
  return DRIFT_TOLERANCE_MS * scale
}

/** An exact reading of core's clock (a heartbeat's `at`): re-anchor when it disagrees beyond the tolerance. */
export function observeCoreTime(at: number, local: number = Date.now()): void {
  if (!Number.isFinite(at)) return
  if (Math.abs(at - coreNow(local)) > tolerance()) setAnchor(at, local)
}

/**
 * A lower bound: something core stamped `ts` has already happened, so core's now is at least `ts`. Core time
 * jumping ahead (resume from sleep, `e2e.clock`) shows here first. Returns whether the anchor moved.
 */
export function observeCoreLowerBound(ts: number, local: number = Date.now()): boolean {
  if (!Number.isFinite(ts) || ts - coreNow(local) <= tolerance()) return false
  setAnchor(ts, local)
  return true
}

/**
 * Ask core for its clock under E2E (now + scale). The reply anchors at the moment the request was sent: core read its
 * clock at some point of the round trip, so this estimate is never behind core and a countdown never shows more
 * time than core gives.
 */
async function syncFromE2E(): Promise<void> {
  const source = e2eSource
  if (source === null || syncing) return
  syncing = true
  const gen = generation
  const sent = Date.now()
  try {
    const r = await source()
    if (gen !== generation || !r.ok) return
    scale = validScale(r.value.timeScale) ?? 1
    if (Number.isFinite(r.value.now)) setAnchor(r.value.now, sent)
  } catch {
    // A failed reading leaves the clock as it was; the next heartbeat asks again.
  } finally {
    if (gen === generation) syncing = false
  }
}

/**
 * Set up from app.info: the time scale (an additive `AppInfo.timeScale` when main sends one; 1 otherwise) and, when
 * the app runs under E2E, `e2e.state` as the authority for core's clock.
 */
export function configureCoreClock(info: AppInfo, e2e?: E2EClockSource): void {
  const fromInfo = validScale((info as AppInfo & { timeScale?: unknown }).timeScale)
  if (fromInfo !== null && fromInfo !== scale) {
    // Keep core's current reading continuous across the change of rate.
    const local = Date.now()
    setAnchor(coreNow(local), local)
    scale = fromInfo
  }
  e2eSource = info.e2e && e2e !== undefined ? e2e : null
  if (e2eSource !== null) void syncFromE2E()
}

/**
 * Feed pushed events, at arrival (the bridge calls this before it buffers or routes a batch). Heartbeats carry
 * core's time; live run envelopes bound it from below. Under E2E a heartbeat re-reads `e2e.state` instead, since
 * main may stamp heartbeats with wall-clock time.
 */
export function observeCoreEvents(batch: readonly AppEvent[], local: number = Date.now()): void {
  let resync = false
  for (const ev of batch) {
    if (ev.kind === 'heartbeat') {
      if (e2eSource !== null) resync = true
      else observeCoreTime(ev.at, local)
    } else if (ev.kind === 'run') {
      if (observeCoreLowerBound(ev.env.ts, local) && e2eSource !== null) resync = true
    }
  }
  if (resync) void syncFromE2E()
}

/** Back to the identity clock (bridge stop, tests). */
export function resetCoreClock(): void {
  generation++
  anchor = null
  scale = 1
  e2eSource = null
  syncing = false
}
