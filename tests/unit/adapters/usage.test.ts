import fc from 'fast-check'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'
import {
  UsageTracker,
  addUsage,
  isZeroUsage,
  mergeUsage,
  normalizeUsage,
  perPassUsage,
  sumClaudeModelUsage,
  sumUsage,
  totalTokens,
  zeroUsage,
} from '@core/adapters/usage.ts'
import type { ClaudeModelUsageEntry } from '@core/adapters/usage.ts'
import type { Usage } from '@shared/events.ts'

describe('perPassUsage', () => {
  it('fresh session: the reported totals are the delta, exact', () => {
    expect(perPassUsage({ reported: { input: 10, output: 5 }, resumed: false })).toEqual({
      usage: { input: 10, output: 5 },
      approx: false,
      resetFields: [],
    })
  })

  it('resume without a known base: reported totals, approx', () => {
    const d = perPassUsage({ reported: { input: 10, output: 5, costUsd: 0.2 }, resumed: true })
    expect(d.usage).toEqual({ input: 10, output: 5, costUsd: 0.2 })
    expect(d.approx).toBe(true)
  })

  it('subtracts the base per field', () => {
    const d = perPassUsage({
      reported: { input: 300, output: 120, cacheRead: 5000, cacheWrite: 800, costUsd: 0.3 },
      base: { input: 100, output: 20, cacheRead: 4000, cacheWrite: 800, costUsd: 0.1 },
      resumed: true,
    })
    expect(d).toEqual({
      usage: { input: 200, output: 100, cacheRead: 1000, cacheWrite: 0, costUsd: 0.2 },
      approx: false,
      resetFields: [],
    })
  })

  it('a field that went backwards is reported as-is with approx', () => {
    const d = perPassUsage({
      reported: { input: 50, output: 200, costUsd: 0.05 },
      base: { input: 100, output: 20, costUsd: 0.1 },
      resumed: true,
    })
    expect(d.usage).toEqual({ input: 50, output: 180, costUsd: 0.05 })
    expect(d.approx).toBe(true)
    expect(d.resetFields).toEqual(['input', 'costUsd'])
  })

  it('treats a base field the vendor did not report as 0 and keeps absent fields absent', () => {
    const d = perPassUsage({
      reported: { input: 10, output: 1, cacheRead: 7 },
      base: { input: 4, output: 1 },
      resumed: true,
    })
    expect(d.usage).toEqual({ input: 6, output: 0, cacheRead: 7 })
    expect('costUsd' in d.usage).toBe(false)
  })

  it('never yields negative or NaN fields', () => {
    const d = perPassUsage({
      reported: { input: Number.NaN, output: -5, reasoning: Infinity },
      base: { input: 3, output: 1 },
      resumed: true,
    })
    for (const v of Object.values(d.usage)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(v)).toBe(true)
    }
  })
})

const usageArb = fc.record(
  {
    input: fc.nat({ max: 1e7 }),
    output: fc.nat({ max: 1e7 }),
    cacheRead: fc.nat({ max: 1e7 }),
    cacheWrite: fc.nat({ max: 1e7 }),
    costUsd: fc.integer({ min: 0, max: 1e6 }).map((c) => c / 1e4),
  },
  { requiredKeys: ['input', 'output'] },
) as fc.Arbitrary<Usage>

describe('perPassUsage properties', () => {
  it('Σ per-pass deltas == final cumulative for monotone sequences (fresh, then resumes)', () => {
    fc.assert(
      fc.property(fc.array(usageArb, { minLength: 1, maxLength: 12 }), (increments) => {
        let cumulative: Usage | undefined
        const deltas: Usage[] = []
        for (const inc of increments) {
          const next = cumulative ? addUsage(cumulative, inc) : inc
          const d = perPassUsage({ reported: next, base: cumulative, resumed: cumulative !== undefined })
          expect(d.approx).toBe(false)
          deltas.push(d.usage)
          cumulative = next
        }
        const total = sumUsage(deltas)
        const final = cumulative!
        expect(total.input).toBe(final.input)
        expect(total.output).toBe(final.output)
        expect(total.cacheRead ?? 0).toBe(final.cacheRead ?? 0)
        expect(total.cacheWrite ?? 0).toBe(final.cacheWrite ?? 0)
        expect(total.costUsd ?? 0).toBeCloseTo(final.costUsd ?? 0, 6)
      }),
    )
  })

  it('every delta field is ≥ 0, whatever the inputs', () => {
    fc.assert(
      fc.property(
        usageArb,
        fc.option(usageArb, { nil: undefined }),
        fc.boolean(),
        (reported, base, resumed) => {
          const d = perPassUsage({ reported, base, resumed })
          for (const v of Object.values(d.usage)) expect(v).toBeGreaterThanOrEqual(0)
          if (base === undefined) expect(d.approx).toBe(resumed)
        },
      ),
    )
  })
})

describe('UsageTracker', () => {
  it('reports the pass delta from the latest cumulative report', () => {
    const t = new UsageTracker({ base: { input: 100, output: 10 }, resumed: true })
    expect(t.delta().usage).toEqual(zeroUsage())
    expect(t.cumulative()).toBeUndefined()
    t.report({ input: 150, output: 20 })
    expect(t.report({ input: 180, output: 30 }).usage).toEqual({ input: 80, output: 20 })
    expect(t.cumulative()).toEqual({ input: 180, output: 30 })
  })
})

describe('sum / merge / helpers', () => {
  it('adds field-wise and keeps optional fields present in any operand', () => {
    expect(addUsage({ input: 1, output: 2 }, { input: 3, output: 4, reasoning: 5 })).toEqual({
      input: 4,
      output: 6,
      reasoning: 5,
    })
    expect(sumUsage([{ input: 1, output: 1 }, undefined, { input: 2, output: 3, costUsd: 0.5 }])).toEqual({
      input: 3,
      output: 4,
      costUsd: 0.5,
    })
    expect(mergeUsage([])).toEqual(zeroUsage())
  })

  it('totalTokens counts reasoning only when reported outside output', () => {
    const u: Usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, reasoning: 3 }
    expect(totalTokens(u)).toBe(135)
    expect(totalTokens(u, false)).toBe(138)
  })

  it('normalizes and detects zero', () => {
    expect(normalizeUsage({ input: -1, output: 2, cacheRead: Number.NaN })).toEqual({
      input: 0,
      output: 2,
      cacheRead: 0,
    })
    expect(isZeroUsage({ input: 0, output: 0, costUsd: 0 })).toBe(true)
    expect(isZeroUsage({ input: 0, output: 0, cacheRead: 1 })).toBe(false)
  })
})

describe('sumClaudeModelUsage', () => {
  it('sums every model in result.modelUsage', () => {
    const modelUsage: Record<string, ModelUsage> = {
      'claude-sonnet-5': {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 40000,
        cacheCreationInputTokens: 5000,
        webSearchRequests: 0,
        costUSD: 0.1234,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
      'claude-haiku-4-5': {
        inputTokens: 800,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 1000,
        webSearchRequests: 0,
        costUSD: 0.0066,
        contextWindow: 200000,
        maxOutputTokens: 32000,
      },
    }
    expect(sumClaudeModelUsage(modelUsage)).toEqual({
      input: 2000,
      output: 400,
      cacheRead: 40000,
      cacheWrite: 6000,
      costUsd: 0.13,
    })
  })

  it('handles zeroed, partial and missing modelUsage', () => {
    expect(sumClaudeModelUsage(undefined)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    })
    expect(sumClaudeModelUsage({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 })
    expect(sumClaudeModelUsage({ m: { inputTokens: 5 } })).toEqual({
      input: 5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    })
  })

  it('feeds a resumed Fix delta (cumulative across the Implement → Fix resume)', () => {
    const implement = sumClaudeModelUsage({ s: { inputTokens: 100, outputTokens: 50, costUSD: 0.02 } })
    const fix = sumClaudeModelUsage({ s: { inputTokens: 160, outputTokens: 90, costUSD: 0.035 } })
    const d = perPassUsage({ reported: fix, base: implement, resumed: true })
    expect(d.usage).toEqual({ input: 60, output: 40, cacheRead: 0, cacheWrite: 0, costUsd: 0.015 })
  })

  it('accepts the SDK ModelUsage shape', () => {
    expectTypeOf<ModelUsage>().toExtend<ClaudeModelUsageEntry>()
  })
})
