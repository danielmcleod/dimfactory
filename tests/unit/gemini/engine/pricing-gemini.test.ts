// Pricing for Gemini models (cost "`catalog`: tokens × price, with cache read/write priced
// separately; reasoning at the output rate unless reasoningIncludedInOutput", Labels "Subscription auth shows
// API-equiv."; "pricing.seed.json holds last-known prices for the built-in profile models"; estimates
// "model:null resolves to the probe's isDefault model", "If there is none, … cost — (CLI default unknown)"):
//   - the seed holds no Gemini price (no built-in profile runs Gemini): a Gemini pass is priced only once the catalog
//     has its model (a refresh or a price the user added), else its cost is unknown, never invented
//   - a Gemini pass is costed at the catalog's rates; its thought tokens are billed at the output rate
//   - a Google login ("oauth-personal") is subscription auth (API-equiv.); a Gemini API key or Vertex AI is not
//   - estimates price a Gemini pass at the catalog's rate, and name the model when it has none
//   - the real Gemini probe reports how it signs in (method only, from the environment and the sign-in file's
//     existence, never its contents), which is what the label reads
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PriceEntry } from '@shared/catalog.ts'
import type { AcpHandshake } from '@core/adapters/acp-base/config.ts'
import { geminiAccount } from '@core/adapters/gemini/auth.ts'
import { geminiConfig } from '@core/adapters/gemini/config.ts'
import { costForUsage, isSubscriptionAuth } from '@core/catalog/cost.ts'
import { loadSeedPricing, lookupPrice } from '@core/catalog/store.ts'
import type { CatalogData } from '@core/catalog/store.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { EstimateAggregate } from '@core/estimates/aggregate.ts'
import { estimateRun } from '@core/estimates/estimate.ts'
import type { PriceLookup } from '@core/estimates/estimate.ts'
import { GEMINI_DEFAULT_MODEL, geminiCaps } from './helpers.ts'

const GEMINI_PRICE: PriceEntry = {
  vendor: 'gemini',
  model: GEMINI_DEFAULT_MODEL,
  aliases: [],
  inputPerMTok: 2,
  outputPerMTok: 12,
  cacheReadPerMTok: 0.2,
  cacheWritePerMTok: null,
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  sourceQuote: '',
  fetchedAt: 1_791_158_400_000,
  confidence: 'user',
}

describe('Gemini prices', () => {
  it('the seed has none (it seeds the built-in profile models only): the catalog says unknown, not a guess', async () => {
    const pricing = await loadSeedPricing()
    expect(pricing.entries.filter((e) => e.vendor === 'gemini')).toEqual([])
    const catalog = { pricing, models: { schemaVersion: 1, vendors: {} } } as unknown as CatalogData
    expect(lookupPrice(catalog, 'gemini', GEMINI_DEFAULT_MODEL)).toBeNull()
    const c = costForUsage(
      { input: 1_000, output: 100 },
      { priceEntry: null, reasoningIncludedInOutput: false },
    )
    expect(c).toMatchObject({ usd: null, basis: 'none' })
  })

  it('catalog basis; thought tokens at the output rate (Gemini reports them apart from output)', () => {
    const caps = geminiCaps()
    expect(caps.reasoningIncludedInOutput).toBe(false)
    const c = costForUsage(
      { input: 100_000, output: 10_000, cacheRead: 50_000, reasoning: 5_000 },
      {
        priceEntry: GEMINI_PRICE,
        reasoningIncludedInOutput: caps.reasoningIncludedInOutput,
        subscription: true,
      },
    )
    // 0.1 M × $2 + 0.01 M × $12 + 0.05 M × $0.20 + 0.005 M × $12
    expect(c).toMatchObject({ basis: 'catalog', apiEquivalent: true, confidence: 'user' })
    expect(c.usd).toBeCloseTo(0.39, 10)
  })

  it.each([
    [{ method: 'oauth-personal' }, true],
    [{ method: 'Login with Google' }, true],
    [{ method: 'gemini-api-key' }, false],
    [{ method: 'vertex-ai' }, false],
  ] as const)('%j → API-equiv. %s', (account, want) => {
    expect(isSubscriptionAuth(account)).toBe(want)
  })
})

describe('estimates for Gemini passes', () => {
  const config = resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: {
      passes: { implement: { vendor: 'gemini', model: null }, review: { vendor: 'gemini', model: null } },
    },
  })
  /** model null → the probe's isDefault model (as app-core's estimatePrice resolves it). */
  const price =
    (entry: PriceEntry | null): PriceLookup =>
    (vendor, model) => {
      if (vendor !== 'gemini') return { rates: { ...GEMINI_PRICE, vendor }, reasoningIncludedInOutput: true }
      const concrete = model ?? GEMINI_DEFAULT_MODEL
      return entry !== null && concrete === entry.model
        ? { rates: entry, reasoningIncludedInOutput: false }
        : { missing: `gemini/${model ?? concrete}` }
    }

  it('priced at the catalog rate once the model has a price', () => {
    const e = estimateRun(new EstimateAggregate(), { config, folderKey: null, price: price(GEMINI_PRICE) })
    expect(e.steps.implement?.missingPricing).toEqual([])
    expect(e.steps.implement?.costUsd?.p50 ?? 0).toBeGreaterThan(0)
    expect(e.steps.review?.costUsd).not.toBeNull()
    expect(e.total.missingPricing).toEqual([])
  })

  it('without a price: tokens only, cost null, and the estimate names the Gemini model it lacks', () => {
    const e = estimateRun(new EstimateAggregate(), { config, folderKey: null, price: price(null) })
    expect(e.steps.implement?.costUsd).toBeNull()
    expect(e.steps.implement?.missingPricing).toEqual([`gemini/${GEMINI_DEFAULT_MODEL}`])
    expect(e.total.missingPricing).toContain(`gemini/${GEMINI_DEFAULT_MODEL}`)
  })
})

describe("the real Gemini probe's account (what the API-equiv. label reads)", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  /** An empty Gemini home (GEMINI_CLI_HOME), with a Google sign-in file when `signedIn` (empty: never read). */
  function home(signedIn: boolean): string {
    const root = mkdtempSync(join(tmpdir(), 'gemini-account-'))
    dirs.push(root)
    mkdirSync(join(root, '.gemini'), { recursive: true })
    if (signedIn) writeFileSync(join(root, '.gemini', 'oauth_creds.json'), '')
    return root
  }
  const input = (env: Record<string, string>, o: { authRequired?: boolean } = {}) => ({
    env,
    home: tmpdir(),
    handshake: o.authRequired === true ? ({ authRequired: true } as unknown as AcpHandshake) : undefined,
    at: 1,
  })

  it('a Google sign-in (the file exists, or Code Assist): oauth-personal, so API-equiv.', () => {
    const a = geminiAccount(input({ GEMINI_CLI_HOME: home(true) }))
    expect(a).toEqual({ method: 'oauth-personal' })
    expect(isSubscriptionAuth(a)).toBe(true)
    const gca = geminiAccount(input({ GEMINI_CLI_HOME: home(false), GOOGLE_GENAI_USE_GCA: 'true' }))
    expect(gca).toEqual({ method: 'oauth-personal' })
  })

  it('an API key or Vertex AI is billed per token: not API-equiv. (the key wins over the file, as the check says)', () => {
    const key = geminiAccount(input({ GEMINI_CLI_HOME: home(true), GEMINI_API_KEY: 'k' }))
    expect(key).toEqual({ method: 'gemini-api-key' })
    expect(isSubscriptionAuth(key)).toBe(false)
    const vertex = geminiAccount(
      input({ GEMINI_CLI_HOME: home(false), GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'p' }),
    )
    expect(vertex).toEqual({ method: 'vertex-ai' })
    expect(isSubscriptionAuth(vertex)).toBe(false)
  })

  it('not signed in, or a sign-in the agent refused: no account, so no label is claimed', () => {
    expect(geminiAccount(input({ GEMINI_CLI_HOME: home(false) }))).toBeUndefined()
    expect(geminiAccount(input({ GEMINI_CLI_HOME: home(true) }, { authRequired: true }))).toBeUndefined()
    expect(isSubscriptionAuth(undefined)).toBe(false)
  })

  it('the Gemini config hands the probe this account', () => {
    const signedIn = input({ GEMINI_CLI_HOME: home(true) })
    expect(geminiConfig.probe.account?.(signedIn)).toEqual({ method: 'oauth-personal' })
  })
})
