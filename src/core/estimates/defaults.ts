// Estimate constants: the lookup thresholds, the priors table, the P(fix) prior and
// the percentile rule every figure uses.
import type { Usage } from '../../shared/events.ts'
import type { StepKey } from '../../shared/run.ts'

/** A lookup level is used once it has this many successes among its window. */
export const MIN_SUCCESSES = 5
/** The most recent samples a level looks at (successes and failures; see aggregate.ts). */
export const SAMPLE_WINDOW = 50
/** P(fix) when neither the folder nor all runs have MIN_SUCCESSES reviewed runs. */
export const P_FIX_PRIOR = 0.6

/**
 * The step family estimates group by. The verify rounds run the same commands, so verify:0/1/2 and Test-first's
 * verify:red share one family;
 * every other step is its own.
 */
export type EstimateStep = Exclude<StepKey, 'verify:0' | 'verify:1' | 'verify:2' | 'verify:red'> | 'verify'

export function estimateStepOf(key: StepKey): EstimateStep {
  return key === 'verify:0' || key === 'verify:1' || key === 'verify:2' || key === 'verify:red'
    ? 'verify'
    : key
}

const S = 1000

/**
 * Priors (activeMs), read as each step's typical upper end: a prior's p80 is the table value and its p50
 * PRIOR_P50_SHARE of it. The expected first run for claude-only, `≈ 6–10 min`, is exactly that over the table
 * (60 + 360 + 90 + 0.6 × 180 = 618 s → p80 10 min, p50 6 min). preflight and finalize are not in the run total;
 * their prior is never consulted.
 */
export const PRIOR_MS: Readonly<Record<EstimateStep, number>> = {
  preflight: 0,
  prepare: 90 * S,
  // Clarify: a short read-only pass before Plan (the user's answers are not counted: a wait on the user).
  clarify: 45 * S,
  // Research: web searches and page reads before Plan (the user's review at its card is not counted).
  research: 300 * S,
  plan: 60 * S,
  // Test-first: writing the tests from the plan's acceptance criteria.
  tests: 240 * S,
  implement: 360 * S,
  review: 90 * S,
  critic: 90 * S,
  // The security advisor: its scan (the secret scanner and any dependency audits; no tokens), the Security pass
  // (the strongest reasoning model, a careful read) and the short re-check after Fix.
  scan: 45 * S,
  // The acceptance review: a read-only check of each plan criterion against the diff and the checks.
  acceptance: 90 * S,
  security: 150 * S,
  recheck: 60 * S,
  fix: 180 * S,
  verify: 60 * S,
  // The Deploy step: reading the project and writing a few config files (its planning takes no tokens).
  deploy: 150 * S,
  // Explain it to me: a short read-only pass writing a plain-language summary at the end.
  explain: 60 * S,
  finalize: 0,
}

/** A prior's p50 as a share of its p80 (the table value); see PRIOR_MS. */
export const PRIOR_P50_SHARE = 0.6

/**
 * Token priors per pass (p80, the Usage a small task's pass typically reports), so a run without history still
 * has a cost: they are priced at the current catalog rate of the pass's model, like samples are (a missing price
 * still leaves the cost unknown and names the model). Calibrated on the recorded Claude fixtures: a pass writes
 * ~8–12k tokens of cache (system prompt and tools) and reads the context back on every turn. The expected
 * first run for claude-only comes to about $0.30 at p50 with the seed prices.
 */
export const PRIOR_USAGE: Readonly<Partial<Record<EstimateStep, Usage>>> = {
  clarify: { input: 10, output: 600, cacheRead: 30_000, cacheWrite: 8_000 },
  // Research is token-heavy: every search result and page it reads goes back into the context on each turn.
  research: { input: 40, output: 6_000, cacheRead: 600_000, cacheWrite: 80_000 },
  plan: { input: 10, output: 1_200, cacheRead: 40_000, cacheWrite: 8_000 },
  tests: { input: 15, output: 3_000, cacheRead: 100_000, cacheWrite: 10_000 },
  implement: { input: 20, output: 4_000, cacheRead: 150_000, cacheWrite: 12_000 },
  review: { input: 10, output: 1_200, cacheRead: 40_000, cacheWrite: 8_000 },
  critic: { input: 10, output: 1_200, cacheRead: 40_000, cacheWrite: 8_000 },
  security: { input: 10, output: 1_800, cacheRead: 60_000, cacheWrite: 8_000 },
  recheck: { input: 10, output: 400, cacheRead: 25_000, cacheWrite: 6_000 },
  fix: { input: 15, output: 2_000, cacheRead: 80_000, cacheWrite: 8_000 },
  deploy: { input: 15, output: 2_500, cacheRead: 70_000, cacheWrite: 8_000 },
  acceptance: { input: 10, output: 1_000, cacheRead: 40_000, cacheWrite: 8_000 },
  explain: { input: 10, output: 1_200, cacheRead: 30_000, cacheWrite: 8_000 },
}

/** A Usage scaled by `k` (a prior's p50 from its p80), rounded to whole tokens. */
export function scaleUsage(u: Usage, k: number): Usage {
  const r = (n: number | undefined): number => Math.round((n ?? 0) * k)
  return { input: r(u.input), output: r(u.output), cacheRead: r(u.cacheRead), cacheWrite: r(u.cacheWrite) }
}

/** Steps Dim Factory runs itself: no vendor, so no tokens and no cost; only the (step) level and the prior apply. */
export function isRunnerFamily(step: EstimateStep): boolean {
  return (
    step === 'preflight' || step === 'prepare' || step === 'verify' || step === 'scan' || step === 'finalize'
  )
}

/**
 * Nearest-rank percentile of `values` (unsorted; at least one). p50 of 5 values is the 3rd smallest, p80 the 4th.
 * Deterministic and always one of the observed values.
 */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1] ?? 0
}
