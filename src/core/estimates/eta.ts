// Live ETA from the estimate frozen at run start (runs/<id>/estimate.json):
//   - StepView.eta = the step's frozen {p50, p80} (every planned step, whatever its status: the mini timeline sizes
//     its segments by p50 and the timeline tooltip says "Usually p50–p80");
//   - a live step's remaining time is p50 − elapsed, past p50 it is p80 − elapsed, and past p80 the step runs
//     "longer than usual": the run's remaining time is then unknown;
//   - RunSummary.progress.etaMs = the run's remaining active time (user waits excluded, as in the estimate) while it
//     is queued, running or waiting. It is left undefined when a live step is past its p80, when the run is paused,
//     failed or finished, and when the run has no frozen estimate (started before estimates existed).
//   - RunSummary.progress.etaState says which: 'ok' with etaMs, 'longer-than-usual' once a live step is past its
//     p80; `etaEndsAt` (= the summary's time + etaMs) is set while the remaining time runs down with the clock, so a
//     reader formats `etaEndsAt − now` without deriving anything. Core republishes a live run's summary when an
//     active step crosses its p50 or p80 (`nextChangeMs`), where the rule changes.
//   - Every step's activeMs is its final attempt's (derive.ts attemptActiveMsAt).
//   - A queued run's own etaMs is its whole remaining work; "starts after run #N (~ETA)" reads the blocker's
//     (RunSummary.blockedBy) etaMs.
import type { Percentiles, RunEstimate } from '../../shared/estimates.ts'
import type { PassStatus, RunStatus, StepKey } from '../../shared/run.ts'

/** What the ETA needs of one step: its status and active time (final attempt) at the moment of the view. */
export interface EtaStep {
  status: PassStatus
  activeMs: number
  /** Its active time is growing right now (running or stalled). */
  active?: boolean
}

/** The run's live ETA at one moment (RunSummary.progress.etaMs / etaState / etaEndsAt). */
export interface RunEta {
  /** Remaining active ms; undefined while a live step runs longer than usual. */
  remainingMs?: number
  /** 'longer-than-usual' once a live step is past its p80. */
  state: 'ok' | 'longer-than-usual'
  /** The remaining time runs down 1:1 with the clock (an active step is on the path). */
  countsDown: boolean
  /** Ms until an active step crosses its p50 or p80: the remaining time changes rule then (core republishes). */
  nextChangeMs?: number
}

/** Runs whose summary carries `progress.etaMs`. */
export const ETA_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting']

/** StepView.eta. */
export function stepEta(est: RunEstimate | null | undefined, key: StepKey): Percentiles | undefined {
  const d = est?.steps[key]?.durationMs
  return d !== undefined ? { p50: d.p50, p80: d.p80 } : undefined
}

/** A live step's remaining ms, or null once it is past its p80 ("longer than usual"). */
export function liveRemainingMs(eta: Percentiles, activeMs: number): number | null {
  if (activeMs <= eta.p50) return eta.p50 - activeMs
  if (activeMs <= eta.p80) return eta.p80 - activeMs
  return null
}

const DECIDED: readonly PassStatus[] = ['done', 'skipped', 'cancelled']

/** Remaining ms of one planned step; null = past p80. Done/skipped/cancelled and a failed step (it waits on the
 * user's choice, not on the vendor) count 0; a queued step its p50. */
function remaining(est: RunEstimate, steps: Partial<Record<StepKey, EtaStep>>, key: StepKey): number | null {
  const e = est.steps[key]
  if (e === undefined) return 0
  const st = steps[key]
  switch (st?.status ?? 'queued') {
    case 'queued':
      return e.durationMs.p50
    case 'done':
    case 'skipped':
    case 'cancelled':
    case 'failed':
      return 0
    case 'running':
    case 'stalled':
    case 'waiting':
    case 'paused':
      return liveRemainingMs(e.durationMs, st?.activeMs ?? 0)
  }
}

/**
 * The run's remaining active ms (see the header), following the run-total formula: sequential steps add, Review ∥
 * Critic take the larger, and Fix (with its verify round) counts P(fix) until the reviewers are decided; once they
 * are and Fix is still queued, Fix is coming (a gate or its launch is pending), so it counts in full.
 */
export function runRemainingMs(
  est: RunEstimate,
  steps: Partial<Record<StepKey, EtaStep>>,
  status: RunStatus,
): number | undefined {
  if (!ETA_RUN_STATUSES.includes(status)) return undefined
  const parts: (number | null)[] = []
  for (const k of ['prepare', 'plan', 'tests', 'verify:red', 'implement', 'verify:1'] as const)
    parts.push(remaining(est, steps, k))
  const reviewers = (['review', 'critic'] as const).filter((k) => est.steps[k] !== undefined)
  const rv = reviewers.map((k) => remaining(est, steps, k))
  if (rv.includes(null)) return undefined
  parts.push(rv.length > 0 ? Math.max(...(rv as number[])) : 0)
  const fixStatus = steps.fix?.status ?? 'queued'
  const decided = reviewers.every((k) => DECIDED.includes(steps[k]?.status ?? 'queued'))
  const w = fixStatus !== 'queued' || decided ? 1 : est.pFix.value
  for (const k of ['fix', 'verify:2'] as const) {
    const r = remaining(est, steps, k)
    parts.push(r === null ? null : w * r)
  }
  if (parts.includes(null)) return undefined
  return Math.max(0, Math.round((parts as number[]).reduce((a, b) => a + b, 0)))
}

/** The longest step a countdown check advances the clock by (any step shorter than its next threshold works). */
const COUNTDOWN_PROBE_MS = 1000

/**
 * The run's live ETA (see the header) with what a summary-only reader needs: the state ("longer than usual" is a
 * state, not a missing figure), whether the remaining time runs down with the clock, and when it next changes rule
 * (an active step crossing its p50 or p80). Undefined outside queued/running/waiting.
 */
export function runEta(
  est: RunEstimate,
  steps: Partial<Record<StepKey, EtaStep>>,
  status: RunStatus,
): RunEta | undefined {
  if (!ETA_RUN_STATUSES.includes(status)) return undefined
  let next: number | undefined
  for (const [k, st] of Object.entries(steps) as [StepKey, EtaStep | undefined][]) {
    const e = est.steps[k]
    if (st?.active !== true || e === undefined) continue
    for (const t of [e.durationMs.p50, e.durationMs.p80]) {
      // A step exactly on a threshold has not passed it yet (the rule changes just after): its change is now, so
      // the republish that lands there (a timer may fire a millisecond early) arms the next one instead of none.
      const d = t - st.activeMs
      if (d >= 0 && (next === undefined || d < next)) next = d
    }
  }
  const at = next !== undefined ? { nextChangeMs: next } : {}
  const remaining = runRemainingMs(est, steps, status)
  if (remaining === undefined) return { state: 'longer-than-usual', countsDown: false, ...at }
  // Advance the active steps by less than their next threshold: the rule stays the same, so a smaller remaining
  // time means it runs down with the clock.
  const h = Math.min(COUNTDOWN_PROBE_MS, next ?? COUNTDOWN_PROBE_MS)
  const later: Partial<Record<StepKey, EtaStep>> = {}
  let anyActive = false
  for (const [k, st] of Object.entries(steps) as [StepKey, EtaStep | undefined][]) {
    if (st === undefined) continue
    anyActive ||= st.active === true
    later[k] = st.active === true ? { ...st, activeMs: st.activeMs + h } : st
  }
  const after = anyActive ? runRemainingMs(est, later, status) : remaining
  const countsDown = after !== undefined && after < remaining
  return { remainingMs: remaining, state: 'ok', countsDown, ...at }
}
