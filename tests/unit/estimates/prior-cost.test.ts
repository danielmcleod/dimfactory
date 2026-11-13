// The first-run estimate (the priors; the first-run script at 0:40: "`≈ 6–10 min ·
// ~$0.30 est. · typical (no history yet)`"): without history the claude-only run reads 6–10 min (the priors table is
// each step's p80, its p50 is 0.6 × that) and has a cost, from the token priors priced at the current catalog rate
// (the seed prices here, the CLI default model being Opus as the fake's probe reports). A missing price still leaves
// the cost unknown and names the model; tokens are then the figure.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EstimateAggregate } from '@core/estimates/aggregate.ts'
import { PRIOR_P50_SHARE, PRIOR_USAGE } from '@core/estimates/defaults.ts'
import { PRIOR_BASIS, estimateRun, estimateStep } from '@core/estimates/estimate.ts'
import type { EstimateConfig, PriceLookup } from '@core/estimates/estimate.ts'
import type { PriceEntry } from '@shared/catalog.ts'

const SEED = fileURLToPath(new URL('../../../src/core/catalog/seed/pricing.seed.json', import.meta.url))
const entries = (JSON.parse(readFileSync(SEED, 'utf8')) as { entries: PriceEntry[] }).entries

/** The seed price of a Claude model or alias; `null` = the CLI default (Opus, as the fake Claude's probe says). */
const seedPrice: PriceLookup = (vendor, model) => {
  const m = model ?? 'claude-opus-5-5'
  const e = entries.find((x) => x.vendor === vendor && (x.model === m || x.aliases.includes(m)))
  return e !== undefined ? { rates: e, reasoningIncludedInOutput: true } : { missing: `${vendor}/${m}` }
}

/** The claude-only built-in profile. */
const CLAUDE_ONLY: EstimateConfig = {
  passes: {
    plan: { enabled: true, vendor: 'claude', model: 'opus', mode: 'readonly' },
    implement: { enabled: true, vendor: 'claude', model: null, mode: 'autoedit' },
    review: { enabled: true, vendor: 'claude', model: 'sonnet', mode: 'readonly' },
    critic: { enabled: true, vendor: 'claude', model: 'opus', mode: 'readonly' },
    fix: { enabled: true, vendor: 'claude', model: null, mode: 'autoedit' },
  },
  verify: { enabled: false, runAfter: ['implement', 'fix'] },
  isolation: { mode: 'inPlace' },
}

/** The composer's minutes (renderer lib/format.ts rounds to whole minutes). */
const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

describe('the first-run estimate (first-run script)', () => {
  it('claude-only without history: ≈ 6–10 min, about $0.30 at p50, typical (no history yet)', () => {
    const est = estimateRun(new EstimateAggregate(), {
      config: CLAUDE_ONLY,
      folderKey: null,
      price: seedPrice,
    })
    expect(est.total.basis).toBe(PRIOR_BASIS)
    expect(minutes(est.total.durationMs.p50)).toBe(6)
    expect(minutes(est.total.durationMs.p80)).toBe(10)
    const cost = est.total.costUsd
    expect(cost).not.toBeNull()
    expect(cost?.p50).toBeGreaterThan(0.25)
    expect(cost?.p50).toBeLessThan(0.35)
    expect(cost?.p80).toBeGreaterThan(cost?.p50 ?? Infinity)
    expect(est.total.missingPricing).toEqual([])
    expect(est.total.tokens?.p80).toBeGreaterThan(est.total.tokens?.p50 ?? Infinity)
  })

  it("a pass's prior cost is its token prior at the pass model's current rate, p50 at 0.6 of it", () => {
    const plan = estimateStep(
      new EstimateAggregate(),
      { key: 'plan', vendor: 'claude', model: 'opus', mode: 'readonly' },
      seedPrice,
    )
    const u = PRIOR_USAGE.plan
    if (u === undefined) throw new Error('no plan token prior')
    // Opus seed: $4 in, $20 out, $0.20 cache read, $8 cache write per million tokens.
    const p80 = (u.input * 4 + u.output * 20 + (u.cacheRead ?? 0) * 0.2 + (u.cacheWrite ?? 0) * 8) / 1e6
    expect(plan.costUsd?.p80).toBeCloseTo(p80, 6)
    expect(plan.costUsd?.p50).toBeCloseTo(p80 * PRIOR_P50_SHARE, 4)
    expect(plan.tokens?.p80).toBe(u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0))
    // A cheaper model costs less for the same prior.
    const review = estimateStep(
      new EstimateAggregate(),
      { key: 'review', vendor: 'claude', model: 'sonnet', mode: 'readonly' },
      seedPrice,
    )
    expect(review.costUsd?.p80).toBeLessThan(plan.costUsd?.p80 ?? 0)
  })

  it('a model without a price: no cost, the model named, tokens still given', () => {
    const est = estimateRun(new EstimateAggregate(), {
      config: {
        ...CLAUDE_ONLY,
        passes: { ...CLAUDE_ONLY.passes, review: { ...CLAUDE_ONLY.passes.review, model: 'nope' } },
      },
      folderKey: null,
      price: seedPrice,
    })
    expect(est.steps.review).toMatchObject({ level: 'prior', costUsd: null, missingPricing: ['claude/nope'] })
    expect(est.steps.review?.tokens?.p50).toBeGreaterThan(0)
    expect(est.total.costUsd).toBeNull()
    expect(est.total.missingPricing).toEqual(['claude/nope'])
    expect(est.total.tokens?.p50).toBeGreaterThan(0)
  })
})
