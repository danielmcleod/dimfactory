// `catalog.get` (Settings → Catalog, the read-only answer; src/core/handlers-dashboard.ts): the prices and models the
// core loaded with their status, no job and no history yet; UNSUPPORTED without the dashboard deps or without a loaded
// catalog (a read-only core). The built-in seed through a real core is the integration side: the seed itself is
// covered by the catalog store's own tests.
import { describe, expect, it } from 'vitest'
import type { CatalogData } from '@core/catalog/store.ts'
import { createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import type { DashboardDeps } from '@core/handlers-dashboard.ts'
import type { CatalogStatus } from '@shared/catalog.ts'

const STATUS = { confidence: 'unverified', stale: false, pricingUpdatedAt: 1 } as CatalogStatus
const DATA: CatalogData = {
  models: { schemaVersion: 1, updatedAt: 1, vendors: {} },
  pricing: {
    schemaVersion: 1,
    updatedAt: 1,
    entries: [
      {
        vendor: 'claude',
        model: 'claude-opus-5-5',
        aliases: ['opus'],
        inputPerMTok: 4,
        outputPerMTok: 20,
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 8,
        sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
        fetchedAt: 1,
        confidence: 'unverified',
      },
    ],
  },
}

function handlers(dashboard?: Partial<DashboardDeps>) {
  const deps = {
    attention: () => ({ needsYou: 0, items: [] }),
    vendorHealth: () => [],
    catalogStatus: () => Promise.resolve(STATUS),
    pricing: { stepUsd: () => null, apiEquivalent: () => false },
    estimate: () => Promise.reject(new Error('not used')),
    ...dashboard,
  }
  const ctx = { ...(dashboard !== undefined ? { dashboard: deps } : {}) } as unknown as HandlerContext
  return createHandlers(ctx)
}

describe('catalog.get', () => {
  it('answers the loaded prices and models with their status, and no job or history without a live catalog', async () => {
    const r = await dispatch(handlers({ catalogData: () => DATA }), 'catalog.get', undefined)
    expect(r).toEqual({
      ok: true,
      value: { models: DATA.models, pricing: DATA.pricing, status: STATUS, job: null, history: [] },
    })
  })

  it('is UNSUPPORTED without the dashboard deps, or without a loaded catalog', async () => {
    const none = await dispatch(handlers(), 'catalog.get', undefined)
    expect(none.ok ? null : none.error.code).toBe('UNSUPPORTED')
    const notLoaded = await dispatch(handlers({ catalogData: () => undefined }), 'catalog.get', undefined)
    expect(notLoaded.ok ? null : notLoaded.error).toEqual({
      code: 'UNSUPPORTED',
      message: 'The model catalog is not available here.',
    })
    const older = await dispatch(handlers({}), 'catalog.get', undefined)
    expect(older.ok ? null : older.error.code).toBe('UNSUPPORTED')
  })
})
