// AI usage per vendor and per model over the last 7 or 30 days (`usage.get{range}`, the Plops page). Core aggregates
// it from the runs' per-step usage (RunSummary.steps in runs/index.jsonl plus the live runs); see
// src/core/dashboard/usage.ts for the definitions.

export const USAGE_RANGES = ['7d', '30d'] as const
export type UsageRange = (typeof USAGE_RANGES)[number]

/** Tokens, cost and runs over one period. */
export interface UsageFigures {
  /** Input + output + cache read + cache write, over the steps' final attempts. */
  tokens: number
  /** USD over the steps that have a price; null when none of them has one. */
  costUsd: number | null
  /** Some step with tokens had no price: costUsd counts the priced steps only. */
  costPartial: boolean
  /** Distinct runs with at least one counted step. */
  runs: number
}

/** What the Plops' moods and emissions read, over the current period. */
export interface UsageSignals {
  /** Steps counted (a step with usage, a failed step or a step running now). */
  steps: number
  /** Steps that failed (status failed, or a failure category recorded). */
  failedSteps: number
  /** Runs started as a re-run of another run (a retry of the work). */
  reruns: number
  /** Steps stopped by a rate, quota or billing limit in the last 24 hours. */
  limitHits24h: number
  /** Steps running right now (in an active run). */
  live: number
  /** When the newest run with tokens (or running now) last did work; null without one. */
  lastUsedAt: number | null
}

export interface ModelUsage extends UsageFigures, UsageSignals {
  /** The model id the steps ran with; null for the vendor's default model. */
  model: string | null
  /** The previous period of equal length (for the mood). */
  previous: UsageFigures
  /** Tokens over every run up to now, whatever the period (a puddle's size). Always above 0: a model that never
   * reported tokens is not listed (its steps count toward the vendor). */
  lifetimeTokens: number
}

export interface VendorUsage extends UsageFigures, UsageSignals {
  vendor: string
  /** The vendor is signed in with a subscription: its dollar figures are API-equivalent. */
  apiEquivalent: boolean
  previous: UsageFigures
  /** Tokens over every run up to now, whatever the period (a puddle's size). */
  lifetimeTokens: number
  /** Largest first. */
  models: ModelUsage[]
}

export interface UsageData {
  range: UsageRange
  /** Start of the period (inclusive) and now; the previous period is [from − (to − from), from). */
  from: number
  to: number
  totals: UsageFigures
  previous: UsageFigures
  /** Vendors with a counted step in the period or tokens before it (puddles), largest first. */
  vendors: VendorUsage[]
}
