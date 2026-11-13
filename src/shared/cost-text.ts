// The words for a run's total cost when it has no figure (RunSummary.progress.costUsd is null), shared by the app
// (renderer lib/format.ts) and the dev CLI (src/cli) so both say the same thing. UI copy standard: an empty value
// gets a word, never a dash. "No figure yet" and "no price known" are different facts, so
// they get different words.
import type { RunStatus, RunSummary } from './run.ts'

export const NO_RUN_COST = {
  /** The run is still going and no step has reported usage yet. */
  pending: 'No cost yet',
  /** The run ended and no step reported usage. */
  unreported: 'No cost reported',
  /** Steps reported usage, but neither the vendor nor the price list gave a price for it. */
  unpriced: 'No price',
} as const
export type NoRunCost = keyof typeof NO_RUN_COST

const ENDED: ReadonlySet<RunStatus> = new Set<RunStatus>(['completed', 'failed', 'cancelled'])

/** Which NO_RUN_COST words fit a run whose cost has no figure. */
export function noRunCost(o: { status: RunStatus; usageReported: boolean }): NoRunCost {
  if (o.usageReported) return 'unpriced'
  return ENDED.has(o.status) ? 'unreported' : 'pending'
}

/** Why a run summary's total has no figure, or null when it has one. */
export function runCostGap(s: Pick<RunSummary, 'status' | 'steps' | 'progress'>): NoRunCost | null {
  if (s.progress.costUsd !== null) return null
  const usageReported = s.progress.tokens > 0 || s.steps.some((st) => st.usage !== undefined)
  return noRunCost({ status: s.status, usageReported })
}
