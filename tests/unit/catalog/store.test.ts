import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DAY_MS } from '../../../src/core/catalog/cost.ts'
import {
  CatalogStore,
  SEED_PRICING_PATH,
  emptyModelsFile,
  isEntryStale,
  loadSeedPricing,
  lookupPrice,
  normalizeModelId,
  pricingConfidenceSummary,
  pricingRefFor,
  pricingStatus,
  readCatalog,
  resolveModelId,
} from '../../../src/core/catalog/store.ts'
import type { CatalogData } from '../../../src/core/catalog/store.ts'
import { homePaths } from '../../../src/core/home.ts'
import type { ModelsFile, PriceEntry, PricingFile } from '../../../src/shared/catalog.ts'

const paths = () => homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
const NOW = Date.UTC(2026, 9, 6)

function price(over: Partial<PriceEntry> & Pick<PriceEntry, 'vendor' | 'model'>): PriceEntry {
  return {
    aliases: [],
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    fetchedAt: NOW,
    confidence: 'unverified',
    ...over,
  }
}

function data(entries: PriceEntry[], models: ModelsFile = emptyModelsFile(NOW)): CatalogData {
  return { pricing: { schemaVersion: 1, updatedAt: NOW, entries }, models }
}

function cliModels(vendor: string, list: { id: string; aliases?: string[] }[]): ModelsFile {
  return {
    schemaVersion: 1,
    updatedAt: NOW,
    vendors: {
      [vendor]: {
        source: 'cli',
        fetchedAt: NOW,
        models: list.map((m) => ({ ...m, source: 'cli' as const, fetchedAt: NOW })),
      },
    },
  }
}

describe('readCatalog: seeding on first read', () => {
  it('copies the seed to pricing.json and writes an empty models.json', async () => {
    const p = paths()
    const r = await readCatalog(p, { now: () => NOW })
    expect(r.seeded).toEqual({ pricing: true, models: true })
    expect(r.fallback).toEqual({ pricing: false, models: false })
    expect(r.warnings).toEqual([])

    const seed = await loadSeedPricing()
    expect(r.pricing).toEqual(seed)
    expect(JSON.parse(await readFile(p.catalogPricing, 'utf8'))).toEqual(seed)
    expect(JSON.parse(await readFile(p.catalogModels, 'utf8'))).toEqual({
      schemaVersion: 1,
      updatedAt: NOW,
      vendors: {},
    })
    expect(r.models).toEqual(emptyModelsFile(NOW))
    // No temp files left behind.
    expect((await readdir(p.catalogDir)).sort()).toEqual(['models.json', 'pricing.json'])
  })

  it('does not rewrite existing files on later reads', async () => {
    const p = paths()
    await readCatalog(p)
    const before = (await stat(p.catalogPricing)).mtimeMs
    const r = await readCatalog(p)
    expect(r.seeded).toEqual({ pricing: false, models: false })
    expect((await stat(p.catalogPricing)).mtimeMs).toBe(before)
  })

  it('reads the file on disk, not the seed, once it exists', async () => {
    const p = paths()
    const mine: PricingFile = {
      schemaVersion: 1,
      updatedAt: 5,
      entries: [price({ vendor: 'claude', model: 'claude-x', confidence: 'user', sourceUrl: '' })],
    }
    await mkdir(p.catalogDir, { recursive: true })
    await writeFile(p.catalogPricing, JSON.stringify(mine))
    const r = await readCatalog(p)
    expect(r.pricing).toEqual(mine)
    expect(r.seeded.pricing).toBe(false)
  })

  it('a corrupt pricing.json falls back to the seed in memory and is left untouched', async () => {
    const p = paths()
    await mkdir(p.catalogDir, { recursive: true })
    await writeFile(p.catalogPricing, '{ not json')
    const r = await readCatalog(p)
    expect(r.fallback.pricing).toBe(true)
    expect(r.pricing).toEqual(await loadSeedPricing())
    expect(r.warnings.join('\n')).toMatch(/pricing\.json is unreadable/)
    expect(await readFile(p.catalogPricing, 'utf8')).toBe('{ not json')
  })

  it('a corrupt models.json falls back to an empty list', async () => {
    const p = paths()
    await mkdir(p.catalogDir, { recursive: true })
    await writeFile(p.catalogModels, JSON.stringify({ schemaVersion: 1, updatedAt: 'x', vendors: {} }))
    const r = await readCatalog(p, { now: () => NOW })
    expect(r.fallback.models).toBe(true)
    expect(r.models).toEqual(emptyModelsFile(NOW))
    expect(r.warnings.join('\n')).toMatch(/models\.json is unreadable/)
  })

  it('skips invalid and duplicate entries with a warning, keeping the rest', async () => {
    const p = paths()
    await mkdir(p.catalogDir, { recursive: true })
    const good = price({ vendor: 'claude', model: 'claude-a' })
    await writeFile(
      p.catalogPricing,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: 1,
        entries: [
          good,
          { ...good, model: 'claude-b', inputPerMTok: -1 },
          { ...good, model: 'CLAUDE-A' },
          { ...good, model: 'claude-c', extra: 'dropped' },
        ],
      }),
    )
    const r = await readCatalog(p)
    expect(r.pricing.entries.map((e) => e.model)).toEqual(['claude-a', 'claude-c'])
    expect(r.pricing.entries[1]).not.toHaveProperty('extra')
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toMatch(/entry #2 ignored \(inputPerMTok/)
    expect(r.warnings[1]).toMatch(/entry #3 ignored \(duplicate claude\/CLAUDE-A\)/)
  })

  it('a newer schemaVersion is read read-only', async () => {
    const p = paths()
    await mkdir(p.catalogDir, { recursive: true })
    await writeFile(
      p.catalogPricing,
      JSON.stringify({ schemaVersion: 2, updatedAt: 1, entries: [price({ vendor: 'claude', model: 'm' })] }),
    )
    const r = await readCatalog(p)
    expect(r.readOnly.pricing).toBe(true)
    expect(r.pricing.entries).toHaveLength(1)
  })

  it('validates models.json per vendor', async () => {
    const p = paths()
    await mkdir(p.catalogDir, { recursive: true })
    const models = cliModels('claude', [{ id: 'claude-opus-5-5', aliases: ['opus'] }])
    await writeFile(
      p.catalogModels,
      JSON.stringify({ ...models, vendors: { ...models.vendors, 'Bad Id': {}, codex: { source: 'x' } } }),
    )
    const r = await readCatalog(p)
    expect(Object.keys(r.models.vendors)).toEqual(['claude'])
    expect(r.warnings).toHaveLength(2)
  })

  it('a broken seed is an INTERNAL error', async () => {
    const p = paths()
    const bad = join(p.home, 'bad-seed.json')
    await writeFile(bad, JSON.stringify({ schemaVersion: 1, updatedAt: 0, entries: [{ vendor: 'claude' }] }))
    await expect(readCatalog(p, { seedPath: bad })).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('uses the seed path next to the module', () => {
    expect(SEED_PRICING_PATH.replace(/\\/g, '/')).toMatch(/src\/core\/catalog\/seed\/pricing\.seed\.json$/)
  })
})

describe('CatalogStore', () => {
  it('caches the first read, shares concurrent loads, and reloads on request', async () => {
    const store = new CatalogStore({ paths: paths(), now: () => NOW })
    const [a, b] = await Promise.all([store.read(), store.read()])
    expect(a).toBe(b)
    expect(a.seeded.pricing).toBe(true)
    expect(await store.read()).toBe(a)

    const changed: PricingFile = { schemaVersion: 1, updatedAt: 9, entries: [] }
    await writeFile(store.paths.catalogPricing, JSON.stringify(changed))
    expect((await store.read()).pricing.updatedAt).toBe(a.pricing.updatedAt)
    expect((await store.read({ reload: true })).pricing).toEqual(changed)
    await writeFile(store.paths.catalogPricing, JSON.stringify({ ...changed, updatedAt: 10 }))
    store.invalidate()
    expect((await store.read()).pricing.updatedAt).toBe(10)
  })

  it('lookup resolves the built-in aliases from the seeded file', async () => {
    const store = new CatalogStore({ paths: paths() })
    expect((await store.lookup('claude', 'opus'))?.model).toBe('claude-opus-5-5')
    expect((await store.lookup('claude', 'sonnet'))?.inputPerMTok).toBe(2)
    expect(await store.lookup('claude', 'nope')).toBeNull()
  })
})

describe('lookupPrice', () => {
  const opus = price({ vendor: 'claude', model: 'claude-opus-5-5', aliases: ['opus'] })
  const haiku = price({ vendor: 'claude', model: 'claude-haiku-4-5-20251001', aliases: ['haiku'] })
  const gpt = price({ vendor: 'codex', model: 'gpt-5.5', aliases: ['opus'] })
  const d = data([opus, haiku, gpt])

  it('by concrete id and by alias, scoped to the vendor', () => {
    expect(lookupPrice(d, 'claude', 'claude-opus-5-5')).toBe(opus)
    expect(lookupPrice(d, 'claude', 'opus')).toBe(opus)
    expect(lookupPrice(d, 'codex', 'opus')).toBe(gpt)
    expect(lookupPrice(d, 'gemini', 'opus')).toBeNull()
  })

  it('ignores case, whitespace and a context suffix such as [1m]', () => {
    expect(lookupPrice(d, 'claude', ' Claude-Opus-5-5[1m] ')).toBe(opus)
    expect(lookupPrice(d, 'claude', 'OPUS')).toBe(opus)
    expect(normalizeModelId('claude-opus-5-5[1M]')).toBe('claude-opus-5-5')
  })

  it('matches a dated snapshot to its base id and back', () => {
    expect(lookupPrice(d, 'claude', 'claude-haiku-4-5')).toBe(haiku)
    expect(lookupPrice(d, 'claude', 'claude-opus-5-5-20260901')).toBe(opus)
  })

  it('null/undefined/empty model (CLI default) has no price', () => {
    expect(lookupPrice(d, 'claude', null)).toBeNull()
    expect(lookupPrice(d, 'claude', undefined)).toBeNull()
    expect(lookupPrice(d, 'claude', '  ')).toBeNull()
  })

  it('prefers a non-deprecated entry when an alias is shared', () => {
    const old = price({ vendor: 'claude', model: 'claude-old', aliases: ['x'], deprecated: true })
    const cur = price({ vendor: 'claude', model: 'claude-new', aliases: ['x'] })
    expect(lookupPrice(data([old, cur]), 'claude', 'x')).toBe(cur)
  })

  it('a CLI-reported alias (models.json) wins over the alias stored with a price', () => {
    const opus6 = price({ vendor: 'claude', model: 'claude-opus-6' })
    const moved = cliModels('claude', [{ id: 'claude-opus-6', aliases: ['opus'] }])
    expect(lookupPrice(data([opus, opus6], moved), 'claude', 'opus')).toBe(opus6)
    // The CLI moved the alias to a model without a price: no price, never the stale alias.
    expect(lookupPrice(data([opus], moved), 'claude', 'opus')).toBeNull()
    expect(resolveModelId(moved, 'claude', 'OPUS')).toBe('claude-opus-6')
    expect(resolveModelId(moved, 'codex', 'opus')).toBeNull()
  })

  it('a CLI-reported concrete id without its own price still falls back to price aliases', () => {
    const models = cliModels('claude', [{ id: 'haiku' }])
    expect(lookupPrice(data([haiku], models), 'claude', 'haiku')).toBe(haiku)
  })
})

describe('status and staleness', () => {
  it('stale only when older than 2× the refresh interval', () => {
    const e = { fetchedAt: NOW - 28 * DAY_MS }
    expect(isEntryStale(e, 14, NOW)).toBe(false)
    expect(isEntryStale({ fetchedAt: NOW - 28 * DAY_MS - 1 }, 14, NOW)).toBe(true)
    expect(isEntryStale({ fetchedAt: NOW - 15 * DAY_MS }, 7, NOW)).toBe(true)
    expect(isEntryStale({ fetchedAt: NOW - 59 * DAY_MS }, 30, NOW)).toBe(false)
    // An unusable interval falls back to the 14-day default.
    expect(isEntryStale({ fetchedAt: NOW - 29 * DAY_MS }, 0, NOW)).toBe(true)
    expect(isEntryStale({ fetchedAt: NOW - 27 * DAY_MS }, Number.NaN, NOW)).toBe(false)
  })

  it('pricingStatus summarizes updatedAt, confidence and staleness', async () => {
    const seed = await loadSeedPricing()
    expect(pricingStatus(seed, 14, seed.updatedAt + DAY_MS)).toEqual({
      pricingUpdatedAt: seed.updatedAt,
      confidence: 'unverified',
      stale: false,
    })
    expect(pricingStatus(seed, 14, seed.updatedAt + 29 * DAY_MS).stale).toBe(true)
    expect(pricingStatus({ schemaVersion: 1, updatedAt: 0, entries: [] }, 14, NOW)).toEqual({
      pricingUpdatedAt: null,
      confidence: 'none',
      stale: false,
    })
  })

  it('confidence summary', () => {
    const a = price({ vendor: 'claude', model: 'a' })
    expect(pricingConfidenceSummary([])).toBe('none')
    expect(pricingConfidenceSummary([a, { ...a, model: 'b' }])).toBe('unverified')
    expect(pricingConfidenceSummary([a, { ...a, confidence: 'user' }])).toBe('mixed')
    expect(pricingConfidenceSummary([{ ...a, confidence: 'verified' }])).toBe('verified')
  })
})

describe('pricingRefFor', () => {
  it('records the prices for the configured passes and lists the missing ones', async () => {
    const d = { pricing: await loadSeedPricing(), models: emptyModelsFile(NOW) }
    const ref = pricingRefFor(d, [
      { vendor: 'claude', model: 'opus' },
      { vendor: 'claude', model: 'opus' },
      { vendor: 'claude', model: 'sonnet' },
      { vendor: 'codex', model: null },
      { vendor: 'claude', model: 'claude-unknown' },
    ])
    expect(ref.pricingUpdatedAt).toBe(d.pricing.updatedAt)
    expect(ref.entries.map((e) => [e.requested, e.model])).toEqual([
      ['opus', 'claude-opus-5-5'],
      ['sonnet', 'claude-sonnet-5-5'],
    ])
    expect(ref.entries[0]).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20, confidence: 'unverified' })
    expect(ref.missing).toEqual(['codex/default', 'claude/claude-unknown'])
  })
})
