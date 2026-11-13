// Estimates (src/core/estimates/{aggregate,estimate}.ts): each lookup level, the
// n ≥ 5 threshold over the last-50 window, final rows of finished runs only, the input-size bucket, priors, cost at
// the catalog price (model:null, missing pricing) and the run-total formula with its P(fix) bases and verify terms.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EstimateAggregate } from '@core/estimates/aggregate.ts'
import { PRIOR_MS, percentile } from '@core/estimates/defaults.ts'
import {
  PRIOR_BASIS,
  estimateRun,
  estimateStep,
  parseRunEstimate,
  plannedSteps,
  readRunEstimate,
  writeRunEstimate,
} from '@core/estimates/estimate.ts'
import type { EstimateConfig, PriceLookup, StepPrice } from '@core/estimates/estimate.ts'
import type { RunSummary, RunSummaryStep } from '@shared/run.ts'
import { claude, run, step, usage } from './helpers.ts'

const S = 1000

function config(over: Partial<EstimateConfig> = {}): EstimateConfig {
  return {
    passes: {
      plan: { enabled: true, vendor: 'claude', model: 'opus', mode: 'readonly' },
      implement: { enabled: true, vendor: 'claude', model: null, mode: 'autoedit' },
      review: { enabled: true, vendor: 'claude', model: 'sonnet', mode: 'readonly' },
      critic: { enabled: true, vendor: 'claude', model: 'opus', mode: 'readonly' },
      fix: { enabled: true, vendor: 'claude', model: null, mode: 'autoedit' },
    },
    verify: { enabled: false, runAfter: ['implement', 'fix'] },
    isolation: { mode: 'inPlace' },
    ...over,
  }
}

/** $1 per million input tokens, $10 per million output tokens, cache billed as input. */
const RATES: StepPrice = {
  rates: { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: null, cacheWritePerMTok: null },
  reasoningIncludedInOutput: true,
}
const priced: PriceLookup = () => RATES

const agg = (...runs: RunSummary[]): EstimateAggregate => EstimateAggregate.from(runs)

/** n completed runs, each with one row from `row(i)`. */
const runs = (n: number, row: (i: number) => RunSummaryStep, over: Partial<RunSummary> = {}): RunSummary[] =>
  Array.from({ length: n }, (_, i) => run([row(i)], over))

describe('percentile (nearest rank)', () => {
  it('p50 of five is the third value, p80 the fourth; one value is every percentile', () => {
    expect(percentile([50, 10, 40, 20, 30], 50)).toBe(30)
    expect(percentile([50, 10, 40, 20, 30], 80)).toBe(40)
    expect(percentile([7], 50)).toBe(7)
    expect(percentile([7], 80)).toBe(7)
    expect(percentile([1, 2, 3, 4, 5, 6], 50)).toBe(3)
  })
})

describe('priors', () => {
  it('without history every step is its prior and the run is "typical (no history yet)"', () => {
    const est = estimateRun(new EstimateAggregate(), { config: config(), folderKey: 'f', price: priced })
    expect(Object.keys(est.steps)).toEqual(['plan', 'implement', 'review', 'critic', 'fix'])
    // The table is each prior's p80; its p50 is 0.6 × that (the first-run `≈ 6–10 min`). Passes have a token prior,
    // priced at the queried rate: a first run has a cost.
    for (const [k, e] of Object.entries(est.steps)) {
      expect(e).toMatchObject({ level: 'prior', samples: 0, basis: PRIOR_BASIS })
      expect(e.durationMs.p80).toBe(PRIOR_MS[k as 'plan'])
      expect(e.durationMs.p50).toBe(Math.round(PRIOR_MS[k as 'plan'] * 0.6))
      expect(e.costUsd?.p80).toBeGreaterThan(e.costUsd?.p50 ?? Infinity)
      expect(e.tokens?.p80).toBeGreaterThan(e.tokens?.p50 ?? Infinity)
    }
    expect(est.steps.plan?.durationMs).toEqual({ p50: 36 * S, p80: 60 * S })
    expect(est.steps.implement?.durationMs).toEqual({ p50: 216 * S, p80: 360 * S })
    expect(est.steps.review?.durationMs.p80).toBe(90 * S)
    expect(est.steps.critic?.durationMs.p80).toBe(90 * S)
    expect(est.steps.fix?.durationMs.p80).toBe(180 * S)
    expect(est.pFix).toEqual({ value: 0.6, basis: 'prior' })
    // 60 + 360 + max(90, 90) + 0.6 × 180 = 618 s at p80, 0.6 × that at p50.
    expect(est.total).toMatchObject({
      durationMs: { p50: 370.8 * S, p80: 618 * S },
      samples: 0,
      basis: PRIOR_BASIS,
      missingPricing: [],
    })
    expect(est.total.costUsd?.p50).toBeGreaterThan(0)
    expect(est.total.costUsd?.p80).toBeGreaterThan(est.total.costUsd?.p50 ?? Infinity)
  })

  it('prepare (isolated only) and the verify rounds join the total; Dim Factory steps cost nothing', () => {
    const est = estimateRun(new EstimateAggregate(), {
      config: config({
        isolation: { mode: 'worktree' },
        verify: { enabled: true, runAfter: ['implement', 'fix'] },
      }),
      folderKey: null,
      price: priced,
    })
    expect(Object.keys(est.steps)).toEqual([
      'prepare',
      'plan',
      'implement',
      'verify:1',
      'review',
      'critic',
      'fix',
      'verify:2',
    ])
    expect(est.steps.prepare).toMatchObject({
      durationMs: { p50: 54 * S, p80: 90 * S },
      costUsd: { p50: 0, p80: 0 },
      tokens: { p50: 0, p80: 0 },
    })
    expect(est.steps['verify:1']?.durationMs).toEqual({ p50: 36 * S, p80: 60 * S })
    // 90 + 60 + 360 + 60 + 90 + 0.6 × (180 + 60) at p80; p50 is 0.6 × each prior
    expect(est.total.durationMs).toEqual({ p50: 482.4 * S, p80: 804 * S })
  })

  it('verify counts only after the passes in runAfter, and only when verify is on', () => {
    const fixOnly = config({ verify: { enabled: true, runAfter: ['fix'] } })
    expect(plannedSteps(fixOnly).map((q) => q.key)).toEqual([
      'plan',
      'implement',
      'review',
      'critic',
      'fix',
      'verify:2',
    ])
    const off = config({ verify: { enabled: false, runAfter: ['implement', 'fix'] } })
    expect(plannedSteps(off).map((q) => q.key)).not.toContain('verify:1')
    const est = estimateRun(new EstimateAggregate(), { config: fixOnly, folderKey: null, price: priced })
    // 60 + 360 + 90 + 0.6 × (180 + 60) at p80; p50 is 0.6 × each prior
    expect(est.total.durationMs).toEqual({ p50: 392.4 * S, p80: 654 * S })
  })

  it('Fix needs a reviewer; disabled passes are left out', () => {
    const c = config()
    c.passes.review.enabled = false
    c.passes.critic.enabled = false
    c.passes.plan.enabled = false
    expect(plannedSteps(c).map((q) => q.key)).toEqual(['implement'])
    const est = estimateRun(new EstimateAggregate(), { config: c, folderKey: null, price: priced })
    expect(est.total.durationMs).toEqual({ p50: 216 * S, p80: 360 * S })
  })
})

describe('lookup levels', () => {
  const plan = { key: 'plan' as const, vendor: 'claude', model: 'opus', mode: 'readonly' as const }

  it('1 (vendor, model, mode, step): five successes with the same vendor, model and mode', () => {
    const a = agg(...runs(5, (i) => claude('plan', (i + 1) * 10 * S, 'opus', 'readonly')))
    const e = estimateStep(a, plan)
    expect(e).toMatchObject({ level: 'exact', samples: 5, basis: 'from 5 runs (claude · opus · readonly)' })
    expect(e.durationMs).toEqual({ p50: 30 * S, p80: 40 * S })
  })

  it('2 (vendor, model, step): another mode does not count at level 1', () => {
    const a = agg(...runs(5, () => claude('implement', 100 * S, null, 'full')))
    const e = estimateStep(a, { key: 'implement', vendor: 'claude', model: null, mode: 'autoedit' })
    expect(e).toMatchObject({ level: 'model', samples: 5, basis: 'from 5 runs (claude · default model)' })
    expect(e.durationMs.p50).toBe(100 * S)
  })

  it('2 also wins when level 1 has fewer than five', () => {
    const a = agg(
      ...runs(3, () => claude('plan', 10 * S, 'opus', 'readonly')),
      ...runs(2, () => claude('plan', 50 * S, 'opus', 'autoedit')),
    )
    expect(estimateStep(a, plan)).toMatchObject({ level: 'model', samples: 5 })
  })

  it('3 (vendor, step): other models of the vendor', () => {
    const a = agg(...runs(5, () => claude('plan', 20 * S, 'sonnet', 'readonly')))
    expect(estimateStep(a, plan)).toMatchObject({ level: 'vendor', basis: 'from 5 runs (claude, any model)' })
  })

  it('4 (step): any vendor', () => {
    const a = agg(
      ...runs(5, () => step('plan', 20 * S, { vendor: 'codex', model: 'gpt-5', mode: 'readonly' })),
    )
    expect(estimateStep(a, plan)).toMatchObject({
      level: 'step',
      basis: 'from 5 runs (any vendor)',
      samples: 5,
    })
  })

  it('5 prior: fewer than five successes anywhere, failures do not count as successes', () => {
    const a = agg(
      ...runs(4, () => claude('plan', 20 * S, 'opus', 'readonly')),
      ...runs(3, () => claude('plan', 20 * S, 'opus', 'readonly', { status: 'failed' })),
    )
    expect(estimateStep(a, plan)).toMatchObject({ level: 'prior', durationMs: { p50: 36 * S, p80: 60 * S } })
    a.put(run([claude('plan', 20 * S, 'opus', 'readonly')]))
    expect(estimateStep(a, plan)).toMatchObject({ level: 'exact', samples: 5 })
  })

  it('the window is the last 50 samples: older successes fall out behind newer failures', () => {
    const a = agg(
      ...runs(10, () => claude('plan', 20 * S, 'opus', 'readonly')),
      ...runs(45, () => claude('plan', 99 * S, 'opus', 'readonly', { status: 'failed' })),
    )
    // The window holds the 5 newest successes and the 45 failures.
    expect(estimateStep(a, plan)).toMatchObject({ level: 'exact', samples: 5 })
    a.put(run([claude('plan', 99 * S, 'opus', 'readonly', { status: 'failed' })]))
    expect(estimateStep(a, plan).level).toBe('prior')
  })

  it('the window follows createdAt even when runs arrive out of order', () => {
    const newer = runs(45, () => claude('plan', 99 * S, 'opus', 'readonly', { status: 'failed' }))
    const older = runs(5, () => claude('plan', 20 * S, 'opus', 'readonly')).map((r, i) => ({
      ...r,
      createdAt: 1000 + i,
    }))
    const a = agg(...newer, ...older, run([claude('plan', 99 * S, 'opus', 'readonly', { status: 'failed' })]))
    // The 5 successes are the oldest of 51 samples: one of them is outside the window.
    expect(estimateStep(a, plan).level).toBe('prior')
  })

  it('only final rows of finished runs: unfinished runs, skipped and cancelled rows are not samples', () => {
    const pending = runs(5, () => claude('plan', 20 * S, 'opus', 'readonly'), { status: 'failed' })
    const a = agg(
      ...pending,
      ...runs(5, () => claude('plan', 20 * S, 'opus', 'readonly', { status: 'skipped' })),
      ...runs(5, () => claude('plan', 20 * S, 'opus', 'readonly', { status: 'cancelled' })),
    )
    expect(estimateStep(a, plan).level).toBe('prior')
    // The failed runs are closed later: their rows count from then on.
    for (const r of pending) a.apply({ op: 'put', summary: { ...r, status: 'cancelled', outcome: 'failed' } })
    expect(estimateStep(a, plan)).toMatchObject({ level: 'exact', samples: 5 })
    a.apply({ op: 'del', runId: pending[0]?.runId ?? '' })
    expect(estimateStep(a, plan).level).toBe('prior')
  })

  it('a re-put run replaces its samples instead of adding them twice', () => {
    const r = runs(4, () => claude('plan', 20 * S, 'opus', 'readonly'))
    const a = agg(...r)
    for (const x of r) a.put({ ...x, pinned: true })
    expect(estimateStep(a, plan).level).toBe('prior')
    expect(a.runs).toBe(4)
  })

  it('the bucket: a known bucket matches level 1 on it, an unknown one across buckets', () => {
    const a = agg(
      ...runs(5, () => claude('plan', 10 * S, 'opus', 'readonly', { inBytesBucket: 0 })),
      ...runs(5, () => claude('plan', 100 * S, 'opus', 'readonly', { inBytesBucket: 3 })),
    )
    expect(estimateStep(a, { ...plan, bucket: 3 })).toMatchObject({
      level: 'exact',
      samples: 5,
      durationMs: { p50: 100 * S, p80: 100 * S },
    })
    expect(estimateStep(a, { ...plan, bucket: 0 }).durationMs.p50).toBe(10 * S)
    expect(estimateStep(a, plan)).toMatchObject({ level: 'exact', samples: 10 })
    // No sample in bucket 2: level 2 (the model's every bucket).
    expect(estimateStep(a, { ...plan, bucket: 2 })).toMatchObject({ level: 'model', samples: 10 })
    // estimateRun passes per-step buckets through.
    const est = estimateRun(a, { config: config(), folderKey: null, price: priced, buckets: { plan: 3 } })
    expect(est.steps.plan?.durationMs.p50).toBe(100 * S)
  })

  it('runner steps use only the (step) level: verify:1 and verify:2 share the verify family', () => {
    const a = agg(...runs(5, () => step('verify:2', 30 * S)))
    expect(estimateStep(a, { key: 'verify:1' })).toMatchObject({
      level: 'step',
      basis: 'from 5 runs',
      costUsd: { p50: 0, p80: 0 },
      tokens: { p50: 0, p80: 0 },
    })
  })
})

describe('tokens and cost', () => {
  const impl = { key: 'implement' as const, vendor: 'claude', model: null, mode: 'autoedit' as const }

  it('p50/p80 of the tokens and of each sample priced at the queried model', () => {
    // Sample i: 100k·i input, 10k·i output → $0.1·i + $0.1·i.
    const a = agg(
      ...runs(5, (i) =>
        claude('implement', 60 * S, null, 'autoedit', { usage: usage(100_000 * (i + 1), 10_000 * (i + 1)) }),
      ),
    )
    const calls: [string, string | null][] = []
    const e = estimateStep(a, impl, (v, m) => (calls.push([v, m]), RATES))
    expect(calls).toEqual([['claude', null]])
    expect(e.tokens).toEqual({ p50: 330_000, p80: 440_000 })
    expect(e.costUsd?.p50).toBeCloseTo(0.6, 10)
    expect(e.costUsd?.p80).toBeCloseTo(0.8, 10)
    expect(e.missingPricing).toEqual([])
  })

  it('cache tokens count and are priced; approximate usage is left out of tokens and cost', () => {
    const a = agg(
      ...runs(5, () =>
        claude('implement', 60 * S, null, 'autoedit', { usage: usage(0, 0, { cacheRead: 1_000_000 }) }),
      ),
      ...runs(5, () =>
        claude('implement', 60 * S, null, 'autoedit', { usage: usage(9e9, 9e9), usageApprox: true }),
      ),
    )
    const e = estimateStep(a, impl, priced)
    expect(e.samples).toBe(10)
    expect(e.tokens).toEqual({ p50: 1_000_000, p80: 1_000_000 })
    expect(e.costUsd).toEqual({ p50: 1, p80: 1 })
  })

  it('model:null without a known default, or a model without a price: tokens only, the pair is named', () => {
    const a = agg(
      ...runs(5, () => claude('implement', 60 * S, null, 'autoedit', { usage: usage(1000, 100) })),
    )
    const e = estimateStep(a, impl, () => ({ missing: 'claude/default' }))
    expect(e).toMatchObject({
      level: 'exact',
      costUsd: null,
      tokens: { p50: 1100 },
      missingPricing: ['claude/default'],
    })
    // Named at the prior level too: the price stays missing whatever the history.
    const prior = estimateStep(new EstimateAggregate(), impl, () => ({ missing: 'claude/default' }))
    expect(prior).toMatchObject({ level: 'prior', costUsd: null, missingPricing: ['claude/default'] })
  })

  it('no usage reported: duration only', () => {
    const a = agg(...runs(5, () => claude('implement', 60 * S, null, 'autoedit')))
    const e = estimateStep(a, impl, priced)
    expect(e.costUsd).toBeNull()
    expect(e.tokens).toBeUndefined()
  })
})

describe('run total', () => {
  /** A finished, reviewed run in `folderKey`; Fix ran when `fixed`. */
  const reviewed = (folderKey: string, fixed: boolean): RunSummary =>
    run(
      [
        claude('plan', 100 * S, 'opus', 'readonly'),
        claude('implement', 200 * S, null, 'autoedit'),
        claude('review', 50 * S, 'sonnet', 'readonly'),
        claude('critic', 70 * S, 'opus', 'readonly'),
        ...(fixed ? [claude('fix', 30 * S, null, 'autoedit')] : []),
      ],
      { folderKey },
    )

  it('sequential steps add, Review ∥ Critic take the larger, Fix is weighted by P(fix) of the folder', () => {
    const a = agg(
      reviewed('folder-a', true),
      reviewed('folder-a', true),
      reviewed('folder-a', false),
      reviewed('folder-a', false),
      reviewed('folder-a', false),
    )
    const est = estimateRun(a, { config: config(), folderKey: 'folder-a', price: priced })
    expect(est.pFix).toEqual({ value: 0.4, basis: 'folder' })
    // Fix has 2 samples only: its prior (p50 108 s, p80 180 s). 100 + 200 + max(50, 70) + 0.4 × Fix
    expect(est.steps.fix?.level).toBe('prior')
    expect(est.total.durationMs).toEqual({ p50: 413.2 * S, p80: 442 * S })
    expect(est.total.samples).toBe(5)
    expect(est.total.basis).toBe('from 5 runs (some steps typical)')
  })

  it('P(fix) bases: the folder with five reviewed runs, else every folder, else 0.6', () => {
    const a = agg(...Array.from({ length: 5 }, (_, i) => reviewed('folder-a', i < 2)))
    expect(a.pFix('folder-a')).toEqual({ value: 0.4, basis: 'folder' })
    expect(a.pFix('folder-b')).toEqual({ value: 0.4, basis: 'global' })
    expect(a.pFix(null)).toEqual({ value: 0.4, basis: 'global' })
    for (let i = 0; i < 4; i++) a.put(reviewed('folder-b', true))
    // folder-b has 4: global over all 9.
    expect(a.pFix('folder-b')).toEqual({ value: 6 / 9, basis: 'global' })
    a.put(reviewed('folder-b', true))
    expect(a.pFix('folder-b')).toEqual({ value: 1, basis: 'folder' })
    expect(agg(...Array.from({ length: 4 }, () => reviewed('folder-a', true))).pFix('folder-a')).toEqual({
      value: 0.6,
      basis: 'prior',
    })
  })

  it('a run is reviewed when Review or Critic finished done; a skipped Fix row is no Fix', () => {
    const a = agg(
      ...Array.from({ length: 5 }, () =>
        run([
          claude('review', 1, 'sonnet', 'readonly', { status: 'failed' }),
          claude('fix', 1, null, 'autoedit'),
        ]),
      ),
    )
    expect(a.pFix(null).basis).toBe('prior')
    const b = agg(
      ...Array.from({ length: 5 }, () =>
        run([
          claude('critic', 1, 'opus', 'readonly'),
          claude('fix', 1, null, 'autoedit', { status: 'skipped' }),
        ]),
      ),
    )
    expect(b.pFix(null)).toEqual({ value: 0, basis: 'global' })
  })

  it('tokens and cost add for Review and Critic while the duration takes the larger; full history → "from N runs"', () => {
    const c = config()
    c.passes.plan.enabled = false
    c.passes.fix.enabled = false
    const rows = (): RunSummaryStep[] => [
      claude('implement', 200 * S, null, 'autoedit', { usage: usage(1_000_000, 0) }),
      claude('review', 50 * S, 'sonnet', 'readonly', { usage: usage(2_000_000, 0) }),
      claude('critic', 70 * S, 'opus', 'readonly', { usage: usage(3_000_000, 0) }),
    ]
    const a = agg(...Array.from({ length: 6 }, () => run(rows())))
    const est = estimateRun(a, { config: c, folderKey: null, price: priced })
    expect(est.total).toEqual({
      durationMs: { p50: 270 * S, p80: 270 * S },
      costUsd: { p50: 6, p80: 6 },
      tokens: { p50: 6_000_000, p80: 6_000_000 },
      samples: 6,
      basis: 'from 6 runs',
      missingPricing: [],
    })
  })

  describe('Fix until green', () => {
    /** A reviewed run in `folderKey` whose Fix ran with the loop on (cap `max`) and took `rounds` rounds. */
    const looped = (folderKey: string, rounds: number, max = 3): RunSummary => ({
      ...reviewed(folderKey, true),
      fixLoop: { rounds, max, stop: 'green' },
    })
    const loopConfig = (rounds: number): EstimateConfig => {
      const c = config()
      c.passes.fix = { ...c.passes.fix, rounds }
      return c
    }
    // Without Fix the total is 100 + 200 + 70 = 370 s; Fix (30 s from its samples) and the re-check are per round.
    const fixP50 = 30 * S
    const fixP80 = 30 * S

    it('counts every round: without history one at p50 and every round up to the cap at p80', () => {
      const a = agg(...Array.from({ length: 5 }, () => reviewed('folder-a', true)))
      const one = estimateRun(a, { config: loopConfig(1), folderKey: 'folder-a', price: priced })
      expect(one.fixRounds).toBeUndefined()
      expect(one.total.durationMs).toEqual({ p50: 370 * S + fixP50, p80: 370 * S + fixP80 })
      const three = estimateRun(a, { config: loopConfig(3), folderKey: 'folder-a', price: priced })
      expect(three.fixRounds).toEqual({ p50: 1, p80: 3, basis: 'prior' })
      // P(fix) is 1 here; the re-check (on Review's config) runs each round too.
      const recheck = three.steps.recheck?.durationMs
      expect(recheck).toBeDefined()
      expect(three.total.durationMs).toEqual({
        p50: 370 * S + fixP50 + (recheck?.p50 ?? 0),
        p80: 370 * S + 3 * (fixP80 + (recheck?.p80 ?? 0)),
      })
    })

    it('uses the rounds the history expects: the folder’s looped runs, else every folder’s, clamped to the cap', () => {
      const list = [1, 2, 2, 3, 2].map((n) => looped('folder-a', n))
      const a = agg(...list)
      expect(a.fixRounds('folder-a', 3)).toEqual({ p50: 2, p80: 2, basis: 'folder' })
      expect(a.fixRounds('folder-b', 3)).toEqual({ p50: 2, p80: 2, basis: 'global' })
      // A cap of 2 now: the 3-round run counts as 2.
      expect(a.fixRounds('folder-a', 2)).toEqual({ p50: 1.8, p80: 2, basis: 'folder' })
      // Too few looped runs: the prior.
      expect(agg(looped('folder-a', 3)).fixRounds('folder-a', 3)).toEqual({ p50: 1, p80: 3, basis: 'prior' })
      const est = estimateRun(a, { config: loopConfig(3), folderKey: 'folder-a', price: priced })
      expect(est.fixRounds).toEqual({ p50: 2, p80: 2, basis: 'folder' })
      const recheck = est.steps.recheck?.durationMs
      expect(est.total.durationMs).toEqual({
        p50: 370 * S + 2 * (fixP50 + (recheck?.p50 ?? 0)),
        p80: 370 * S + 2 * (fixP80 + (recheck?.p80 ?? 0)),
      })
      // A run removed from the history no longer counts (four looped runs are too few: the prior).
      a.del(list[3]?.runId ?? '')
      expect(a.fixRounds('folder-a', 3)).toEqual({ p50: 1, p80: 3, basis: 'prior' })
    })

    it('a looped run whose Fix never ran, or a single-Fix run, says nothing about rounds', () => {
      const noFix = { ...reviewed('folder-a', false), fixLoop: { rounds: 1, max: 3 } }
      const single = { ...reviewed('folder-a', true), fixLoop: { rounds: 1, max: 1 } }
      const a = agg(...Array.from({ length: 5 }, () => noFix), ...Array.from({ length: 5 }, () => single))
      expect(a.fixRounds('folder-a', 3).basis).toBe('prior')
    })
  })

  it("a step without a price leaves the total's cost unknown and names the pair once", () => {
    const c = config()
    c.passes.plan.enabled = false
    const price: PriceLookup = (v, m) => (m === null ? { missing: `${v}/default` } : RATES)
    const est = estimateRun(new EstimateAggregate(), { config: c, folderKey: null, price })
    expect(est.total.costUsd).toBeNull()
    expect(est.total.missingPricing).toEqual(['claude/default'])
  })
})

describe('the persisted estimate (estimate.json)', () => {
  it('round-trips, and anything malformed reads as no estimate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'est-'))
    const est = estimateRun(new EstimateAggregate(), { config: config(), folderKey: null, price: priced })
    expect(await readRunEstimate(dir)).toBeNull()
    await writeRunEstimate(dir, est)
    expect(await readRunEstimate(dir)).toEqual(est)
    await writeFile(join(dir, 'estimate.json'), JSON.stringify({ schemaVersion: 1, estimate: { total: {} } }))
    expect(await readRunEstimate(dir)).toBeNull()
    await writeFile(join(dir, 'estimate.json'), '{not json')
    expect(await readRunEstimate(dir)).toBeNull()
    expect(parseRunEstimate(null)).toBeNull()
    expect(parseRunEstimate({ ...est, steps: { plan: { durationMs: { p50: 'x', p80: 1 } } } })).toBeNull()
    expect(parseRunEstimate(est)).toEqual(est)
  })
})
