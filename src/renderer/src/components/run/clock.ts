// Live step timers between snapshots (one shared 1 s ticker drives all timers). StepView.activeMs is
// core's active time as of the snapshot; a step that is running or stalled keeps counting from when that snapshot
// arrived, so the timer moves every tick without the renderer deciding anything about the step.
import type { RunSnapshot, StepView } from '@shared/run.ts'

const seen = new WeakMap<RunSnapshot, number>()

/** When this snapshot object first reached the view (renderer clock). */
export function receivedAt(snap: RunSnapshot): number {
  let at = seen.get(snap)
  if (at === undefined) {
    at = Date.now()
    seen.set(snap, at)
  }
  return at
}

/** Core counts active time only while a step is running or stalled (supervisor setStatus). */
export function isCounting(view: Pick<StepView, 'status'>): boolean {
  return view.status === 'running' || view.status === 'stalled'
}

/** The step's active time now: core's figure, plus the time since the snapshot while the step is counting. */
export function liveActiveMs(view: StepView, snap: RunSnapshot, now: number): number {
  if (!isCounting(view)) return view.activeMs
  return view.activeMs + Math.max(0, now - receivedAt(snap))
}
