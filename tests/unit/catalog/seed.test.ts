import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isOfficialSource } from '../../../src/core/catalog/sources.ts'
import {
  PricingFileStrictZ,
  SEED_PRICING_PATH,
  emptyModelsFile,
  loadSeedPricing,
  lookupPrice,
} from '../../../src/core/catalog/store.ts'
import { BUILTIN_PROFILES } from '../../../src/core/config/builtins.ts'
import type { PricingFile } from '../../../src/shared/catalog.ts'

const SEED_DAY = Date.UTC(2026, 9, 5)
const rawSeed = (): unknown => JSON.parse(readFileSync(SEED_PRICING_PATH, 'utf8')) as unknown

/** Every `$<number>` in a quote, as numbers. */
const dollars = (quote: string): number[] =>
  [...quote.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))

describe('pricing.seed.json', () => {
  it('validates against the strict PricingFile schema', () => {
    const r = PricingFileStrictZ.safeParse(rawSeed())
    expect(r.success ? [] : r.error.issues).toEqual([])
  })

  it('rejects a typo-ed key (strict schema)', () => {
    const doc = rawSeed() as PricingFile
    const bad = { ...doc, entries: [{ ...doc.entries[0], sourceQoute: 'x' }] }
    expect(PricingFileStrictZ.safeParse(bad).success).toBe(false)
  })

  it('every entry is unverified, fetched 2026-10-05, from an official page of its vendor, with a short quote', async () => {
    const seed = await loadSeedPricing()
    expect(seed.updatedAt).toBe(SEED_DAY)
    expect(seed.entries.length).toBeGreaterThan(0)
    for (const e of seed.entries) {
      expect(e.confidence, e.model).toBe('unverified')
      expect(e.fetchedAt, e.model).toBe(SEED_DAY)
      expect(isOfficialSource(e.sourceUrl, e.vendor), e.sourceUrl).toBe(true)
      expect(e.sourceQuote, e.model).toBeTypeOf('string')
      expect((e.sourceQuote ?? '').length, e.model).toBeLessThanOrEqual(200)
    }
  })

  it("each quote contains the entry's prices (guards transcription typos)", async () => {
    for (const e of (await loadSeedPricing()).entries) {
      const found = dollars(e.sourceQuote ?? '')
      for (const v of [e.inputPerMTok, e.outputPerMTok, e.cacheReadPerMTok, e.cacheWritePerMTok]) {
        if (v !== null) expect(found, `${e.model}: ${v}`).toContain(v)
      }
    }
  })

  it('is internally consistent: output ≥ input, cache read ≤ input, Anthropic cache write = 1-hour tier', async () => {
    for (const e of (await loadSeedPricing()).entries) {
      expect(e.outputPerMTok, e.model).toBeGreaterThanOrEqual(e.inputPerMTok)
      if (e.cacheReadPerMTok !== null) expect(e.cacheReadPerMTok, e.model).toBeLessThanOrEqual(e.inputPerMTok)
      // Claude Code bills cache writes at the 1-hour tier (2× base input).
      if (e.vendor === 'claude') expect(e.cacheWritePerMTok, e.model).toBeCloseTo(e.inputPerMTok * 2, 10)
    }
  })

  it('has unique vendor/model ids and no alias shared by two entries of a vendor', async () => {
    const seed = await loadSeedPricing()
    const ids = new Set<string>()
    for (const e of seed.entries) {
      for (const name of [e.model, ...e.aliases]) {
        const k = `${e.vendor}/${name.toLowerCase()}`
        expect(ids.has(k), k).toBe(false)
        ids.add(k)
      }
    }
  })

  it('prices every Claude model the built-in profiles name, plus the ids the C16 probe listed', async () => {
    const data = { pricing: await loadSeedPricing(), models: emptyModelsFile(0) }
    const profileModels = new Set<string>()
    for (const profile of Object.values(BUILTIN_PROFILES)) {
      for (const pass of Object.values(profile)) {
        if (pass && 'vendor' in pass && pass.vendor === 'claude' && typeof pass.model === 'string') {
          profileModels.add(pass.model)
        }
      }
    }
    expect([...profileModels].sort()).toEqual(['opus', 'sonnet'])
    // C16-probe-handshake initialize.models (value → resolvedModel).
    const probe: Record<string, string> = {
      opus: 'claude-opus-5-5',
      sonnet: 'claude-sonnet-5-5',
      fable: 'claude-fable-5-1',
      haiku: 'claude-haiku-4-5-20251001',
      'claude-sonnet-5': 'claude-sonnet-5',
      'claude-opus-5': 'claude-opus-5',
      'claude-fable-5': 'claude-fable-5',
      'claude-opus-4-8': 'claude-opus-4-8',
      'claude-opus-4-7': 'claude-opus-4-7',
      'claude-opus-4-6': 'claude-opus-4-6',
      'claude-sonnet-4-6': 'claude-sonnet-4-6',
    }
    for (const [value, resolved] of Object.entries(probe)) {
      expect(lookupPrice(data, 'claude', value)?.model, value).toBe(resolved)
    }
  })

  it('prices the Codex models the installed CLI lists (gpt-6-luna default, 5.6 family, 5.5)', async () => {
    const data = { pricing: await loadSeedPricing(), models: emptyModelsFile(0) }
    for (const m of ['gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']) {
      expect(lookupPrice(data, 'codex', m)?.model, m).toBe(m)
    }
    expect(lookupPrice(data, 'codex', 'gpt-5.5')?.cacheWritePerMTok).toBeNull()
  })

  it('loadSeedPricing returns independent copies', async () => {
    const a = await loadSeedPricing()
    const first = a.entries[0]
    if (first) first.inputPerMTok = 999
    const b = await loadSeedPricing()
    expect(b.entries[0]?.inputPerMTok).not.toBe(999)
  })
})
