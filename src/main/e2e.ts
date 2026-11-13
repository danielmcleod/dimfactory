// E2E support (`e2e.{state,power,clock}` registered only under DIM_FACTORY_E2E=1):
// the e2e.state snapshot, and a main-process global Playwright can reach through electronApp.evaluate: the
// event-loop histogram, and the recorded desktop notifications (press an action, replay an Action Center
// activation) and a simulated window focus (Playwright's window always has it). One retention pass on demand
// (the daily schedule is off under DIM_FACTORY_E2E=1), on core's clock, which e2e.clock moves.
import type { Core } from '@core/app-core.ts'
import type { RetentionOptions } from '@core/history.ts'
import type { RetentionReport } from '@core/store/retention.ts'
import type { E2EState } from '@shared/ipc.ts'
import { STEP_KEYS } from '@shared/run.ts'
import type { RecordedNotification } from './notification-recorder.ts'
import type { ActivationOutcome } from './notifications.ts'
import type { EventLoopMonitor } from './perf.ts'

/** Live vendor processes of the given runs (cheap: read from the live controllers' state). */
export function liveProcs(core: Pick<Core, 'controller'>, runIds: Iterable<string>): E2EState['procs'] {
  const out: E2EState['procs'] = []
  for (const runId of runIds) {
    const state = core.controller(runId)?.state
    if (state === undefined) continue
    for (const step of STEP_KEYS) {
      const p = state.steps[step].proc
      if (p?.live === true && p.pid !== undefined) out.push({ runId, step, pid: p.pid })
    }
  }
  return out
}

export interface E2EStateInput {
  clock: { now(): number; readonly scale: number }
  activeRuns: number
  procs: E2EState['procs']
  windowFocused: boolean
  tray: { icon: string; tooltip: string } | null
  eventLoop: Pick<EventLoopMonitor, 'read'>
  /** What the recorder stands in for (nothing is shown under E2E). */
  notifications?: E2EState['notifications']
  /** More `extra` fields (taskbar overlay, badge, flash, notification pause). */
  extra?: Record<string, unknown>
}

export function buildE2EState(i: E2EStateInput): E2EState {
  const loop = i.eventLoop.read()
  return {
    now: i.clock.now(),
    timeScale: i.clock.scale,
    activeRuns: i.activeRuns,
    procs: i.procs,
    windowFocused: i.windowFocused,
    notifications: i.notifications ?? [],
    tray: i.tray ?? { icon: '', tooltip: '' },
    extra: { ...i.extra, eventLoopP95Ms: loop.p95Ms, eventLoopMaxMs: loop.maxMs },
  }
}

export const E2E_GLOBAL = '__dimFactoryE2E'

export interface E2ENotificationHooks {
  /** Every recorded notification, oldest first, with its activation arguments. */
  list(): RecordedNotification[]
  /** Press an action (index or label) or 'click' on a recorded notification (index, negative from the end, or id). */
  act(target: number | string, action: number | string): Promise<ActivationOutcome | null>
  /** Replay an activation as Notification.handleActivation reports it (Action Center): the arguments string. */
  activate(args: string): Promise<ActivationOutcome>
  clear(): void
}

export interface E2EFocusHooks {
  /** false: main treats the window as unfocused (true: focused; null: the real focus again). */
  simulate(focused: boolean | null): void
}

export interface E2EHistoryHooks {
  /** One retention pass now, as the app's daily pass runs it (Core.history.retention), and its report. */
  retention(o?: RetentionOptions): Promise<RetentionReport>
}

export interface E2EGlobals {
  eventLoop: { read: EventLoopMonitor['read']; reset: EventLoopMonitor['reset'] }
  notifications?: E2ENotificationHooks
  focus?: E2EFocusHooks
  history?: E2EHistoryHooks
}

/** `await app.evaluate(() => globalThis.__dimFactoryE2E.eventLoop.reset())` from a Playwright test. */
export function installE2EGlobals(g: E2EGlobals): void {
  ;(globalThis as Record<string, unknown>)[E2E_GLOBAL] = g
}

/** The window focus main acts on: the simulated one under E2E when set, else the real one. */
export class FocusOverride {
  #simulated: boolean | null = null

  simulate(focused: boolean | null): void {
    this.#simulated = focused
  }

  get simulated(): boolean | null {
    return this.#simulated
  }

  resolve(real: boolean): boolean {
    return this.#simulated ?? real
  }
}
