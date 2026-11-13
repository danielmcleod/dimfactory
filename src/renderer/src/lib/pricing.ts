// The pricing behind an estimated cost (the tooltip reads "est. from pricing fetched <date> (verified/unverified)",
// and pricing older than 2× the refresh interval shows amber). The facts are
// core's CatalogStatus (pricingUpdatedAt, confidence, stale) as the store's catalog slice holds it (dashboard.get,
// catalog.get); nothing here decides whether prices are stale. Before core has said, labels keep their plain words.
// A pass's catalog figure carries the facts of the prices it was priced at (StepCost.pricing, the run's
// own pricingRef at the pass's end); labels use those first, and today's catalog only for a figure without them.
import { useMemo } from 'react'
import type { CatalogStatus, PricingConfidenceSummary } from '@shared/catalog.ts'
import type { StepCost } from '@shared/run.ts'
import { useStore } from '../state/store.ts'

export interface PricingFacts {
  fetchedAt: number | null
  confidence: PricingConfidenceSummary
  stale: boolean
}

const CONFIDENCE_WORD: Readonly<Record<PricingConfidenceSummary, string>> = {
  verified: 'verified',
  unverified: 'unverified',
  user: 'edited by you',
  mixed: 'partly verified',
  none: 'unverified',
}

/** Shown with a stale estimate (and in its tooltip). */
export const STALE_PRICING_NOTE = 'Prices are older than twice the refresh interval, so this may be off.'

export function pricingFactsOf(status: CatalogStatus | null | undefined): PricingFacts | null {
  if (status === null || status === undefined) return null
  return {
    fetchedAt: typeof status.pricingUpdatedAt === 'number' ? status.pricingUpdatedAt : null,
    confidence: status.confidence in CONFIDENCE_WORD ? status.confidence : 'none',
    stale: status.stale === true,
  }
}

function day(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** `est. from pricing fetched 3 Oct 2026 (unverified)`; `est. from pricing` before core has said. */
export function pricingBasisText(f: PricingFacts | null): string {
  if (f === null) return 'est. from pricing'
  const when = f.fetchedAt !== null ? ` fetched ${day(f.fetchedAt)}` : ''
  return `est. from pricing${when} (${CONFIDENCE_WORD[f.confidence]})`
}

/** The tooltip for a figure priced from the catalog: the basis, and the stale note when core says so. */
export function pricingTitle(f: PricingFacts | null): string {
  const basis = pricingBasisText(f)
  return f?.stale === true ? `${basis}. ${STALE_PRICING_NOTE}` : basis
}

/**
 * The facts core froze with a catalog-priced figure (StepCost.pricing: the run's own prices at the pass's
 * end), or null when the figure has none (a vendor figure, or an older core).
 */
export function costPricingFacts(cost: Pick<StepCost, 'basis' | 'pricing'> | undefined): PricingFacts | null {
  const p = cost?.basis === 'catalog' ? cost.pricing : undefined
  if (p === undefined || typeof p.fetchedAt !== 'number') return null
  return {
    fetchedAt: p.fetchedAt,
    confidence: p.confidence in CONFIDENCE_WORD ? p.confidence : 'none',
    stale: p.stale === true,
  }
}

/**
 * A run total's facts from its steps' own (core's): the oldest fetch, one confidence word when every
 * catalog-priced step has the same one ("partly verified" otherwise), stale when any was. Null when no step has any.
 */
export function runPricingFacts(costs: readonly (StepCost | undefined)[]): PricingFacts | null {
  const facts = costs.map(costPricingFacts).filter((f): f is PricingFacts => f !== null)
  const first = facts[0]
  if (first === undefined) return null
  return {
    fetchedAt: Math.min(...facts.map((f) => f.fetchedAt ?? Infinity)),
    confidence: facts.every((f) => f.confidence === first.confidence) ? first.confidence : 'mixed',
    stale: facts.some((f) => f.stale),
  }
}

/** Core's facts about the prices estimates use now (null until core has said). */
export function usePricingFacts(): PricingFacts | null {
  const status = useStore((s) => s.catalog.status)
  return useMemo(() => pricingFactsOf(status), [status])
}
