import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sumClaudeModelUsage } from '../../../src/core/adapters/usage.ts'
import type { ClaudeModelUsageEntry } from '../../../src/core/adapters/usage.ts'
import {
  DAY_MS,
  catalogCostUsd,
  costForUsage,
  isPricingStale,
  roundUsd,
  toStepCost,
} from '../../../src/core/catalog/cost.ts'
import { emptyModelsFile, loadSeedPricing, lookupPrice } from '../../../src/core/catalog/store.ts'
import type { PriceEntry } from '../../../src/shared/catalog.ts'

const FETCHED = Date.UTC(2026, 9, 5)

/** $3 in · $15 out · $0.30 cache read · $3.75 cache write per MTok. */
const P: PriceEntry = {
  vendor: 'claude',
  model: 'claude-test',
  aliases: [],
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  fetchedAt: FETCHED,
  confidence: 'unverified',
}

describe('catalogCostUsd', () => {
  it('prices input and output per million tokens', () => {
    expect(catalogCostUsd({ input: 1_000_000, output: 1_000_000 }, P, true)).toBe(18)
    expect(catalogCostUsd({ input: 1000, output: 500 }, P, true)).toBe(0.0105)
  })

  it('prices cache read and cache write separately from input', () => {
    const u = { input: 100_000, output: 0, cacheRead: 1_000_000, cacheWrite: 200_000 }
    // 0.3 (input) + 0.3 (cache read) + 0.75 (cache write)
    expect(catalogCostUsd(u, P, true)).toBe(1.35)
  })

  it('adds reasoning at the output rate only when it is reported outside output', () => {
    const u = { input: 0, output: 100_000, reasoning: 50_000 }
    expect(catalogCostUsd(u, P, true)).toBe(1.5)
    expect(catalogCostUsd(u, P, false)).toBe(2.25)
  })

  it('bills cache tokens at the input rate when the vendor has no separate cache price', () => {
    const noCache = { ...P, cacheReadPerMTok: null, cacheWritePerMTok: null }
    expect(catalogCostUsd({ input: 0, output: 0, cacheRead: 1e6, cacheWrite: 1e6 }, noCache, true)).toBe(6)
  })

  it('ignores negative, NaN and infinite counts', () => {
    const u = { input: -5, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 1e6 }
    expect(catalogCostUsd(u, P, true)).toBe(3.75)
  })

  it('rounds float noise at 1e-10', () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3)
    expect(catalogCostUsd({ input: 1, output: 1 }, P, true)).toBe(0.000018)
  })
})

describe('costForUsage', () => {
  const usage = { input: 1000, output: 500 }

  it('vendor-reported cost wins over the catalog', () => {
    const c = costForUsage(usage, { vendorReportedUsd: 0.42, priceEntry: P, reasoningIncludedInOutput: true })
    expect(c).toEqual({ usd: 0.42, basis: 'vendor', apiEquivalent: false })
  })

  it('takes the vendor figure from usage.costUsd when no explicit one is given', () => {
    const c = costForUsage(
      { ...usage, costUsd: 0.0488110000001 },
      { priceEntry: P, reasoningIncludedInOutput: true },
    )
    expect(c).toEqual({ usd: 0.048811, basis: 'vendor', apiEquivalent: false })
  })

  it('a vendor-reported $0 is still the vendor figure', () => {
    expect(costForUsage({ input: 0, output: 0, costUsd: 0 }, { reasoningIncludedInOutput: true })).toEqual({
      usd: 0,
      basis: 'vendor',
      apiEquivalent: false,
    })
  })

  it('vendorReportedUsd:null ignores usage.costUsd; invalid vendor figures fall through to the catalog', () => {
    const viaCatalog = { ...usage, costUsd: 9 }
    expect(
      costForUsage(viaCatalog, { vendorReportedUsd: null, priceEntry: P, reasoningIncludedInOutput: true }),
    ).toMatchObject({ usd: 0.0105, basis: 'catalog' })
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        costForUsage(usage, { vendorReportedUsd: bad, priceEntry: P, reasoningIncludedInOutput: true }).basis,
      ).toBe('catalog')
    }
  })

  it('catalog figure carries the pricing date, confidence and priced model', () => {
    const c = costForUsage(usage, { priceEntry: P, reasoningIncludedInOutput: true })
    expect(c).toEqual({
      usd: 0.0105,
      basis: 'catalog',
      apiEquivalent: false,
      pricingFetchedAt: FETCHED,
      confidence: 'unverified',
      pricedModel: 'claude-test',
    })
    expect(toStepCost(c)).toEqual({ usd: 0.0105, basis: 'catalog', apiEquivalent: false })
  })

  it('reasoning flag flows through to the catalog math', () => {
    const u = { input: 0, output: 1000, reasoning: 1000 }
    expect(costForUsage(u, { priceEntry: P, reasoningIncludedInOutput: true }).usd).toBe(0.015)
    expect(costForUsage(u, { priceEntry: P, reasoningIncludedInOutput: false }).usd).toBe(0.03)
  })

  it('missing price → none ("No price")', () => {
    expect(costForUsage(usage, { reasoningIncludedInOutput: true })).toEqual({
      usd: null,
      basis: 'none',
      apiEquivalent: false,
    })
    expect(
      costForUsage(usage, { priceEntry: null, reasoningIncludedInOutput: true, subscription: true }),
    ).toEqual({ usd: null, basis: 'none', apiEquivalent: false })
  })

  it('approximate usage → none, even with a vendor figure', () => {
    expect(
      costForUsage(
        { ...usage, costUsd: 1 },
        { priceEntry: P, reasoningIncludedInOutput: true, usageApprox: true },
      ),
    ).toEqual({ usd: null, basis: 'none', apiEquivalent: false })
  })

  it('subscription auth marks any figure as API-equivalent', () => {
    expect(
      costForUsage(usage, { priceEntry: P, reasoningIncludedInOutput: true, subscription: true })
        .apiEquivalent,
    ).toBe(true)
    expect(
      costForUsage({ ...usage, costUsd: 0.1 }, { reasoningIncludedInOutput: true, subscription: true }),
    ).toEqual({ usd: 0.1, basis: 'vendor', apiEquivalent: true })
  })

  it('flags stale pricing (older than 2× the interval) when `now` is given', () => {
    const base = { priceEntry: P, reasoningIncludedInOutput: true }
    expect(costForUsage(usage, base)).not.toHaveProperty('pricingStale')
    expect(costForUsage(usage, { ...base, now: FETCHED + 28 * DAY_MS }).pricingStale).toBe(false)
    expect(costForUsage(usage, { ...base, now: FETCHED + 29 * DAY_MS }).pricingStale).toBe(true)
    expect(costForUsage(usage, { ...base, now: FETCHED + 15 * DAY_MS, intervalDays: 7 }).pricingStale).toBe(
      true,
    )
    expect(isPricingStale(FETCHED, 30, FETCHED + 60 * DAY_MS)).toBe(false)
  })
})

describe('against a real Claude result (C08a)', () => {
  const recording = fileURLToPath(
    new URL('../../fixtures/claude/stdio/C08a-session-id-implement/recording.jsonl', import.meta.url),
  )
  function result(): { modelUsage: Record<string, ClaudeModelUsageEntry>; total_cost_usd: number } {
    for (const line of readFileSync(recording, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const rec = JSON.parse(line) as { dir?: string; line?: string }
      if (rec.dir !== 'out' || typeof rec.line !== 'string' || !rec.line.includes('"type":"result"')) continue
      return JSON.parse(rec.line) as {
        modelUsage: Record<string, ClaudeModelUsageEntry>
        total_cost_usd: number
      }
    }
    throw new Error('no result line in C08a')
  }

  it('the vendor figure is used as reported', () => {
    const r = result()
    const usage = sumClaudeModelUsage(r.modelUsage)
    const cost = costForUsage(usage, { reasoningIncludedInOutput: true })
    expect(cost).toMatchObject({ basis: 'vendor' })
    // The live C08a reports 0.050671200000000007; the figure is kept as reported (to the rounding of a cost).
    expect(cost.usd).toBeCloseTo(r.total_cost_usd, 9)
  })

  it('catalog math reproduces the CLI figure exactly at the 1-hour cache-write rate Claude Code uses', async () => {
    const r = result()
    const usage = { ...sumClaudeModelUsage(r.modelUsage) }
    delete usage.costUsd
    const seeded = lookupPrice(
      { pricing: await loadSeedPricing(), models: emptyModelsFile(0) },
      'claude',
      'sonnet',
    )
    expect(seeded?.model).toBe('claude-sonnet-5-5')
    if (!seeded) return
    // The seed stores the 1-hour cache-write tier ($4 / MTok for Sonnet 5.5), so catalog math matches the CLI.
    expect(seeded.cacheWritePerMTok).toBe(4)
    expect(catalogCostUsd(usage, seeded, true)).toBeCloseTo(r.total_cost_usd, 9)
    const fiveMinute = { ...seeded, cacheWritePerMTok: 2.5 }
    expect(catalogCostUsd(usage, fiveMinute, true)).toBeLessThan(r.total_cost_usd)
  })
})
