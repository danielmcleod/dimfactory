// Which steps the Run view shows, and where open cards sit in the flow (steps a run doesn't use are omitted).
// Presentation only: statuses and reasons are core's. A step is left out when core
// skipped it as unused (NOT_USED_REASONS); runner steps (prepare, verify:0, finalize) appear once they start, since
// before that the snapshot cannot tell a step that will run from one that will be skipped. verify:1 / verify:2 appear
// from the start when core says the run's config runs them (StepView.planned), and so do a Test-first run's Tests step
// and its red check (in other runs they stay queued and hidden: Tests is not one of the configured passes); an
// isolated run's Prepare and Finalize (and its baseline check when core's prepare view lists it) from its start. UI
// standard (nothing moves on its own): the Run view passes `keep`, the steps it has already shown, so a step that
// turns out unused mid-run stays in place as one "Skipped" line instead of disappearing.
import type { CardView, PassStatus, RunSnapshot, StepKey, StepView } from '@shared/run.ts'
import { STEP_KEYS, isStepKey } from '@shared/run.ts'
import { plansBaseline } from './isolation.ts'
import { NOT_USED_REASONS, isPass } from './text.ts'

/** The step is over: done, skipped or cancelled (PassCard collapses such a card when the Run view opens on it). */
export function isFinishedStatus(s: PassStatus): boolean {
  return s === 'done' || s === 'skipped' || s === 'cancelled'
}

export function isShownStep(v: StepView): boolean {
  if (v.status === 'skipped' && v.attempt === 0 && v.reason !== undefined && NOT_USED_REASONS.has(v.reason)) {
    return false
  }
  if (v.key === 'preflight' || isPass(v.key)) return true
  // A verify round the run's config runs is shown from the start (core's `planned`), so its node is never
  // inserted mid-row when the round begins.
  if (v.planned === true) return true
  return v.attempt > 0 || (v.status !== 'queued' && v.status !== 'skipped' && v.status !== 'cancelled')
}

/**
 * Nothing moves on its own: an isolated run always prepares its copy and
 * ends with Finalize, so both steps are shown from the run's start (Prepare sits between Preflight and Plan; inserting
 * it when it began would move the row). The baseline check (verify:0) is shown from the start when core's prepare view
 * lists it as a step it will run, or core marks it `planned`. A step core settled as not used is still left out.
 */
export function isPlannedIsolatedStep(snap: RunSnapshot, v: StepView): boolean {
  if (snap.summary.isolation !== 'worktree') return false
  if (v.status === 'skipped' && v.attempt === 0 && v.reason !== undefined && NOT_USED_REASONS.has(v.reason)) {
    return false
  }
  if (v.key === 'prepare' || v.key === 'finalize') return true
  return v.key === 'verify:0' && plansBaseline(snap.steps.prepare)
}

/** The steps the Run view shows: those in use, plus `keep` (steps it has shown before). */
export function shownSteps(snap: RunSnapshot, keep?: ReadonlySet<StepKey>): StepView[] {
  return STEP_KEYS.map((k) => snap.steps[k]).filter(
    (v) => isShownStep(v) || isPlannedIsolatedStep(snap, v) || keep?.has(v.key) === true,
  )
}

/** The step has begun (or core settled it without running it: skipped, cancelled), so it has something to say. */
export function hasBegun(v: StepView): boolean {
  return v.attempt > 0 || v.status !== 'queued'
}

/**
 * The steps the Flow tab shows: those of shownSteps that have begun. A queued step is only a node in the timeline
 * until it starts (UI standard: nothing moves on its own). Steps begin in flow order, so each new card
 * lands after everything already on the page instead of growing a card in the middle and pushing the rest down.
 */
export function flowSteps(snap: RunSnapshot, keep?: ReadonlySet<StepKey>): StepView[] {
  return shownSteps(snap, keep).filter(hasBegun)
}

/** A timeline column: one step, or Review ‖ Critic ‖ Security side by side. `auto`: a gate Auto skips. */
export type TimelineColumn =
  { kind: 'step'; steps: StepView[] } | { kind: 'gate'; gate: 'afterPlan' | 'beforeFix'; auto?: true }

/**
 * preflight → prepare(+verify:0) → clarify → research → plan → ◇ → tests → verify:red → implement → verify:1 → scan →
 * acceptance → review‖critic‖security → ◇ → fix → verify:2 → recheck → deploy → explain → finalize (deploy only with
 * the Deploy step; acceptance only with the acceptance review; explain only with Explain it to me; clarify only when
 * the run asks questions before
 * Plan; research only when the run researches before Plan; tests and verify:red only in a Test-first run; scan and security only with the security advisor; recheck with
 * the advisor or with Fix until green).
 * In Auto the gates are off: they are left out, or with `autoGates` (the timeline) kept as skipped-by-Auto.
 */
export function timelineColumns(
  snap: RunSnapshot,
  opts: { autoGates?: boolean; keep?: ReadonlySet<StepKey> } = {},
): TimelineColumn[] {
  const shown = new Map(shownSteps(snap, opts.keep).map((v) => [v.key, v]))
  const cols: TimelineColumn[] = []
  const step = (...keys: StepKey[]): void => {
    const steps = keys.map((k) => shown.get(k)).filter((v): v is StepView => v !== undefined)
    if (steps.length > 0) cols.push({ kind: 'step', steps })
  }
  const auto = snap.summary.auto
  const gates = !auto || opts.autoGates === true
  const gate = (g: 'afterPlan' | 'beforeFix'): TimelineColumn =>
    auto ? { kind: 'gate', gate: g, auto: true } : { kind: 'gate', gate: g }
  step('preflight')
  step('prepare', 'verify:0')
  step('clarify')
  step('research')
  step('plan')
  if (gates && shown.has('plan')) cols.push(gate('afterPlan'))
  step('tests')
  step('verify:red')
  step('implement')
  step('verify:1')
  step('scan')
  step('acceptance')
  step('review', 'critic', 'security')
  if (gates && shown.has('fix')) cols.push(gate('beforeFix'))
  step('fix')
  step('verify:2')
  step('recheck')
  step('deploy')
  step('explain')
  step('finalize')
  return cols
}

/** The step a card belongs with in the flow (its payload's `step` when core set one). */
export function cardStep(card: CardView): StepKey | null {
  switch (card.kind) {
    case 'gate:afterPlan':
    case 'insufficientContext':
    case 'planMutated':
      return 'plan'
    case 'gate:beforeFix':
      return 'fix'
    case 'preflight':
      return 'preflight'
    case 'stall':
    case 'restartFresh':
    case 'loop':
    case 'emptyFindings':
    case 'retryPartial':
    case 'reconcile':
    case 'trust':
    case 'depsConsent':
    case 'depsFailed':
    case 'verifyEnv':
    case 'finalize':
    case 'finalizeConflicts':
    case 'interruptedApply':
    case 'testsNotRed':
    case 'clarify':
    case 'research': {
      const p = card.payload
      const s = typeof p === 'object' && p !== null ? (p as { step?: unknown }).step : undefined
      return isStepKey(s) ? s : null
    }
  }
}

/** Cards that open before their step's card (the gate before Fix); the rest follow it. */
export function cardGoesBefore(card: CardView): boolean {
  return card.kind === 'gate:beforeFix'
}
