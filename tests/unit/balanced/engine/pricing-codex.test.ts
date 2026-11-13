// Pricing for Codex models (cost "`catalog`: tokens × price, with cache read/write priced
// separately; reasoning at the output rate unless reasoningIncludedInOutput"; Labels "Subscription auth shows
// API-equiv."; "pricing.seed.json holds last-known prices for the built-in profile models, marked
// unverified"; local preset "Pricing is 0"):
//   - the shipped seed prices Codex's models, from an official OpenAI page, unverified
//   - a Codex pass is costed from the catalog (no vendor figure), its reasoning tokens not counted twice
//   - a ChatGPT login is subscription auth (API-equiv.); an API key or an unknown login is not
import { describe, expect, it } from 'vitest'
import { costForUsage, isSubscriptionAuth } from '@core/catalog/cost.ts'
import { officialHosts, sourceHostOf } from '@core/catalog/sources.ts'
import { loadSeedPricing, lookupPrice } from '@core/catalog/store.ts'
import type { CatalogData } from '@core/catalog/store.ts'

async function seedCatalog(): Promise<CatalogData> {
  const pricing = await loadSeedPricing()
  return { pricing, models: { schemaVersion: 1, vendors: {} } } as unknown as CatalogData
}

describe('Codex prices (seed)', () => {
  it('every Codex entry comes from an official OpenAI host and is unverified until a refresh confirms it', async () => {
    const seed = await loadSeedPricing()
    const codex = seed.entries.filter((e) => e.vendor === 'codex')
    expect(codex.length).toBeGreaterThan(0)
    for (const e of codex) {
      expect(officialHosts(['codex'])).toContain(sourceHostOf(e.sourceUrl))
      expect(e.confidence).toBe('unverified')
      expect(e.inputPerMTok).toBeGreaterThan(0)
      expect(e.outputPerMTok).toBeGreaterThan(e.inputPerMTok)
    }
  })

  it('the probe’s default model is priced (gpt-5.6-sol), a model with no cache-write rate bills those as input', async () => {
    const catalog = await seedCatalog()
    expect(lookupPrice(catalog, 'codex', 'gpt-5.6-sol')).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 })
    // The CLI default (null) has no price of its own: core resolves it to the probe's isDefault model first.
    expect(lookupPrice(catalog, 'codex', null)).toBeNull()
    const e55 = lookupPrice(catalog, 'codex', 'gpt-5.5')
    expect(e55?.cacheWritePerMTok).toBeNull()
    const c = costForUsage(
      { input: 1_000_000, output: 0, cacheWrite: 1_000_000 },
      { priceEntry: e55, reasoningIncludedInOutput: true },
    )
    expect(c.usd).toBe(10) // both million-token lots at the $5 input rate
  })
})

describe('Codex pass cost', () => {
  it('catalog basis, reasoning already inside output (Codex reports it as part of output tokens)', async () => {
    const price = lookupPrice(await seedCatalog(), 'codex', 'gpt-5.6-sol')
    const usage = { input: 100_000, output: 10_000, cacheRead: 200_000, reasoning: 4_000 }
    const c = costForUsage(usage, { priceEntry: price, reasoningIncludedInOutput: true, subscription: true })
    // 0.1 M × $4 + 0.01 M × $20 + 0.2 M × $0.40 = 0.40 + 0.20 + 0.08
    expect(c).toMatchObject({ basis: 'catalog', apiEquivalent: true, confidence: 'unverified' })
    expect(c.usd).toBeCloseTo(0.68, 10)
    const counted = costForUsage(usage, { priceEntry: price, reasoningIncludedInOutput: false })
    expect(counted.usd).toBeCloseTo(0.68 + 0.08, 10)
  })

  it('a local preset’s free rates make a zero catalog figure', () => {
    const free = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }
    const c = costForUsage(
      { input: 50_000, output: 5_000 },
      {
        priceEntry: {
          ...free,
          vendor: 'codex',
          model: 'qwen3',
          aliases: [],
          sourceUrl: '',
          sourceQuote: '',
          fetchedAt: 0,
          confidence: 'user',
        },
        reasoningIncludedInOutput: true,
      },
    )
    expect(c).toMatchObject({ usd: 0, basis: 'catalog' })
  })
})

describe('isSubscriptionAuth (API-equiv. labels)', () => {
  it.each([
    [{ method: 'chatgpt' }, true],
    [{ method: 'ChatGPT' }, true],
    [{ method: 'claude.ai' }, true],
    [{ method: 'api_key' }, false],
    [{ method: 'apiKey' }, false],
    [{ method: 'api_key', plan: 'pro' }, false],
    [{ method: 'access_token' }, false],
    [{ method: 'unknown' }, false],
    [{ method: 'unknown', plan: 'plus' }, true],
    [undefined, false],
  ] as const)('%j → %s', (account, want) => {
    expect(isSubscriptionAuth(account)).toBe(want)
  })
})
