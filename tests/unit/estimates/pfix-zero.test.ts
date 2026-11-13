// The run total with P(fix) = 0 (src/core/estimates/estimate.ts; run total: P(fix)·(fix + verify)):
// a folder whose reviews never needed Fix weights Fix by 0, so Fix's unknown cost (here: Fix runs on a model without
// a price) leaves the total's cost known; with P(fix) > 0 the same unpriced Fix makes it unknown.
import { describe, expect, it } from 'vitest'
import { EstimateAggregate } from '@core/estimates/aggregate.ts'
import { estimateRun } from '@core/estimates/estimate.ts'
import type { EstimateConfig, PriceLookup } from '@core/estimates/estimate.ts'
import type { RunSummary } from '@shared/run.ts'
import { claude, run, usage } from './helpers.ts'

const S = 1000

const config: EstimateConfig = {
  passes: {
    plan: { enabled: true, vendor: 'claude', model: 'opus', mode: 'readonly' },
    implement: { enabled: true, vendor: 'claude', model: null, mode: 'autoedit' },
    review: { enabled: true, vendor: 'claude', model: 'sonnet', mode: 'readonly' },
    critic: { enabled: true, vendor: 'claude', model: 'opus', mode: 'readonly' },
    fix: { enabled: true, vendor: 'claude', model: 'unpriced-model', mode: 'autoedit' },
  },
  verify: { enabled: false, runAfter: ['implement', 'fix'] },
  isolation: { mode: 'inPlace' },
}

/** $1 per million input tokens, $10 per million output tokens; Fix's model has no price. */
const priced: PriceLookup = (vendor, model) =>
  model === 'unpriced-model'
    ? { missing: `${vendor}/${model}` }
    : {
        rates: { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: null, cacheWritePerMTok: null },
        reasoningIncludedInOutput: true,
      }

/** A clean run: every pass but Fix done with usage; Fix skipped (no findings) or done without history. */
function cleanRun(implementInput: number, fixRan: boolean): RunSummary {
  return run([
    claude('plan', 20 * S, 'opus', 'readonly', { usage: usage(1_000_000, 0) }),
    claude('implement', 40 * S, null, 'autoedit', { usage: usage(implementInput, 0) }),
    claude('review', 10 * S, 'sonnet', 'readonly', { usage: usage(1_000_000, 0) }),
    claude('critic', 12 * S, 'opus', 'readonly', { usage: usage(1_000_000, 0) }),
    claude(
      'fix',
      fixRan ? 30 * S : 0,
      'unpriced-model',
      'autoedit',
      fixRan ? { status: 'failed' } : { status: 'skipped' },
    ),
  ])
}

describe('P(fix) = 0', () => {
  it("leaves Fix's unknown cost out of the total; the Implement spread shows as a cost range", () => {
    const runs = [1, 1, 1, 2, 2].map((m) => cleanRun(m * 1_000_000, false))
    const est = estimateRun(EstimateAggregate.from(runs), { config, folderKey: 'folder-a', price: priced })
    expect(est.pFix).toEqual({ value: 0, basis: 'folder' })
    expect(est.steps.fix?.level).toBe('prior')
    expect(est.steps.fix?.costUsd).toBeNull()
    expect(est.steps.fix?.missingPricing).toEqual(['claude/unpriced-model'])
    // plan 1 + implement 1|2 + review 1 + critic 1 (dollars at $1/M input).
    expect(est.total.costUsd).toEqual({ p50: 4, p80: 5 })
    expect(est.total.durationMs).toEqual({ p50: 72 * S, p80: 72 * S })
    expect(est.total.basis).toBe('from 5 runs (some steps typical)')
  })

  it('with P(fix) > 0 the unpriced Fix makes the total cost unknown', () => {
    const runs = [...[1, 1, 1, 2].map((m) => cleanRun(m * 1_000_000, false)), cleanRun(1_000_000, true)]
    const est = estimateRun(EstimateAggregate.from(runs), { config, folderKey: 'folder-a', price: priced })
    expect(est.pFix.value).toBeGreaterThan(0)
    expect(est.total.costUsd).toBeNull()
  })
})
