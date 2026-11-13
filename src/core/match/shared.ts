// What a match asks the person once (pure). Clarify's questions and Research's notes run on side A only; side B is
// made when both are over, with the same Brief (Clarify's answers are part of it), the same research and the same
// choices, so the two builders start from equal inputs and the person answers once.
//
// The seeded steps are skipped "Shared from side A": a skipped step is over for the run's flow, the Plan prompt reads
// the Brief and the kept research from the state, and the step rows say where the answers came from.
import { MATCH_TEXT } from '../../shared/match.ts'
import type { RunOutputFile } from '../../shared/run.ts'
import { isTerminalPassStatus } from '../supervisor/derive.ts'
import { initRunState } from '../supervisor/machine.ts'
import type { RunInit, RunState, StepState } from '../supervisor/types.ts'

/** The run folder's files that go with the shared steps (runs.output serves them on side B too). */
export const SHARED_OUTPUTS: readonly RunOutputFile[] = ['clarify', 'research', 'research.json']

const clone = <T>(v: T): T => structuredClone(v)

/** Side A asks or researches at all (its settings have Clarify or Research on). */
export function sharesSteps(a: Pick<RunState, 'config'>): boolean {
  return a.config.clarify !== undefined || a.config.research !== undefined
}

/**
 * Side A's questions and research are over: each step that is on has reached an end (answered, skipped, nothing to
 * ask, failed for good). True at once when neither is on.
 */
export function sharedSettled(a: Pick<RunState, 'config' | 'steps'>): boolean {
  const over = (k: 'clarify' | 'research'): boolean => {
    const st = a.steps[k] as StepState | undefined
    return st === undefined || isTerminalPassStatus(st.status)
  }
  return (
    (a.config.clarify === undefined || over('clarify')) &&
    (a.config.research === undefined || over('research'))
  )
}

/** Side A will never finish them: it ended first. */
export function sharedAbandoned(a: Pick<RunState, 'config' | 'steps' | 'status'>): boolean {
  if (sharedSettled(a)) return false
  return a.status === 'completed' || a.status === 'failed' || a.status === 'cancelled'
}

function shareStep(dst: StepState, src: StepState | undefined): void {
  dst.status = 'skipped'
  dst.reason = MATCH_TEXT.sharedStep
  if (src?.vendor !== undefined) dst.vendor = src.vendor
  if (src?.model !== undefined) dst.model = src.model
}

/**
 * Side B's first state: an ordinary new run with side A's Clarify and Research as its own, already over. `init` is
 * the run's own (its settings have Clarify and Research off); the shared steps' settings are side A's.
 */
export function initSharedSide(init: RunInit, a: RunState, o: { note?: string } = {}): RunState {
  const config = { ...init.config }
  if (a.config.clarify !== undefined) config.clarify = clone(a.config.clarify)
  else delete config.clarify
  if (a.config.research !== undefined) config.research = clone(a.config.research)
  else delete config.research
  const s = initRunState({ ...init, config })
  if (s.config.clarify !== undefined) shareStep(s.steps.clarify, a.steps.clarify)
  if (s.config.research !== undefined) shareStep(s.steps.research, a.steps.research)
  if (a.clarify !== undefined) s.clarify = clone(a.clarify)
  if (a.research !== undefined) s.research = clone(a.research)
  // Clarify's answers are appended to the Brief: side A's Brief as it stands is what both builders read.
  if (a.brief !== undefined && a.brief !== '') s.brief = a.brief
  for (const f of SHARED_OUTPUTS) if (a.outputs[f] !== undefined) s.outputs[f] = 1
  if (sharesSteps(a)) s.notes = [...s.notes, o.note ?? MATCH_TEXT.sharedNote]
  return s
}
