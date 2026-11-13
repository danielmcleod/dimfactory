// Review fix (cost: "Cost is frozen at pass end, and resolved.json.pricingRef records the pricing
// used"): a run's passes are costed at the prices its pricingRef recorded, so an apply, an Undo or a manual price during
// the run never reprices it; only a model the run recorded no price for falls back to the live catalog.
import { describe, expect, it } from 'vitest'
import { applyPriceEdit } from '../../../../src/core/catalog/diff.ts'
import { parsePricingRef, pricingRefFor, runPassPrice } from '../../../../src/core/catalog/store.ts'
import type { CatalogData } from '../../../../src/core/catalog/store.ts'
import { NOW, current } from './fixtures.ts'

describe('a run is costed at its own pricingRef', () => {
  const atStart = current()
  const ref = pricingRefFor(atStart, [
    { vendor: 'claude', model: 'opus' },
    { vendor: 'claude', model: 'claude-sonnet-5-5' },
  ])
  // Mid-run, the user raises Opus's output price by hand.
  const live: CatalogData = {
    ...atStart,
    pricing: applyPriceEdit(
      atStart.pricing,
      {
        vendor: 'claude',
        model: 'claude-opus-5-5',
        inputPerMTok: 4,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 8,
      },
      NOW,
    ).pricing,
  }

  it('prices a pass at the price the run recorded for its model as configured', () => {
    const p = runPassPrice(ref, live, 'claude', 'opus', 'claude-opus-5-5')
    expect(p).toMatchObject({ model: 'claude-opus-5-5', outputPerMTok: 20, confidence: 'unverified' })
    // Without the run's record it would be today's price.
    expect(runPassPrice(null, live, 'claude', 'opus', 'claude-opus-5-5')?.outputPerMTok).toBe(25)
  })

  it('a model the run recorded no price for (switched mid-run) is priced from the live catalog', () => {
    expect(runPassPrice(ref, live, 'claude', 'haiku', 'claude-haiku-4-5-20251001')).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
    })
    expect(runPassPrice(ref, undefined, 'claude', 'haiku', 'claude-haiku-4-5-20251001')).toBeNull()
  })

  it('reads pricingRef back from resolved.json, leaving out what is not a price', () => {
    const json: unknown = JSON.parse(JSON.stringify(ref))
    expect(parsePricingRef(json)).toEqual(ref)
    const broken = {
      pricingUpdatedAt: 1,
      entries: [
        { ...ref.entries[0], inputPerMTok: 'x' },
        { ...ref.entries[1], confidence: 'certain' },
        ref.entries[1],
        null,
      ],
      missing: ['claude/default', 3],
    }
    expect(parsePricingRef(broken)).toEqual({
      pricingUpdatedAt: 1,
      entries: [ref.entries[1]],
      missing: ['claude/default'],
    })
    expect(parsePricingRef(null)).toBeNull()
    expect(parsePricingRef({ entries: 'none' })).toBeNull()
  })
})
