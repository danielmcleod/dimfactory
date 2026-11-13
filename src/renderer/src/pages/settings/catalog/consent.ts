// What a price refresh says before it runs and while it runs (the consent card names the vendor and model, says
// "read-only, web search, cannot change files", and shows ~time and ≈cost). The
// Dashboard's consent card and Settings → Catalog's Update now share these words, so both ask the same way. Every
// figure is core's (catalog.refreshPlan, the job); this file only words them.
import { useEffect, useState } from 'react'
import type { CatalogJob, CatalogRefreshPlan } from '@shared/catalog.ts'
import { invoke } from '../../../ipc/client.ts'
import { API_EQUIVALENT, formatDuration, formatEta, formatUsd, vendorName } from '../../../lib/format.ts'
import { useConfigEpoch } from '../../../state/selectors.ts'
import { useCatalogEpoch } from '../../../state/catalog.ts'

/** The consent words, as the card and Settings show them. */
export const CONSENT_FACTS = 'read-only, web search, cannot change files'
/** The card's title (the same words as the `catalog` notification). */
export const CATALOG_CARD_TITLE = 'Model prices may be out of date'
/** Where the diff review is (the card's Review changes, the Refresh group's link). */
export const REVIEW_FIELD = 'review'
export const REVIEW_HREF = `#/settings/catalog?field=${REVIEW_FIELD}`

/**
 * `Claude (sonnet)`; for the CLI's default model, `Claude (CLI default: claude-opus-5-5)` when core named it (the
 * consent card always names the model it prices), else `Claude`; core's own name for the vendor when it
 * gives one.
 */
export function refresherName(
  vendor: string,
  model: string | null,
  name?: string,
  defaultModel?: string,
): string {
  const who = typeof name === 'string' && name !== '' ? name : vendorName(vendor)
  if (model !== null && model !== '') return `${who} (${model})`
  return typeof defaultModel === 'string' && defaultModel !== ''
    ? `${who} (CLI default: ${defaultModel})`
    : who
}

/** The consent line: `Claude (sonnet): read-only, web search, cannot change files`. */
export function consentLine(plan: CatalogRefreshPlan | null): string {
  if (plan === null) return `${CONSENT_FACTS.charAt(0).toUpperCase()}${CONSENT_FACTS.slice(1)}`
  return `${refresherName(plan.vendor, plan.model, plan.vendorName, plan.defaultModel)}: ${CONSENT_FACTS}`
}

/**
 * The consent line's tooltip: the line, then the official hosts the job may read pages from (core's list).
 * "Only" where core says the job is confined to them (`hostsConfined`, Claude); where it is not (Codex's
 * web search takes no domain list) the tooltip says so, and that a price sourced elsewhere is flagged in the review.
 */
export function consentTitle(plan: CatalogRefreshPlan | null): string {
  const line = consentLine(plan)
  const hosts = Array.isArray(plan?.hosts) ? plan.hosts.filter((h) => typeof h === 'string' && h !== '') : []
  if (hosts.length === 0) return line
  if (plan?.hostsConfined === false) {
    const who =
      typeof plan.vendorName === 'string' && plan.vendorName !== ''
        ? plan.vendorName
        : vendorName(plan.vendor)
    return `${line}. It looks for prices on ${hosts.join(', ')}. ${who}'s web search is not limited to these sites, so a price it finds anywhere else is marked "Unofficial source" for you to check.`
  }
  return `${line}. It reads pages only on ${hosts.join(', ')}.`
}

/** `≈$0.05`, `under $0.01`. */
export function approxUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? 'under $0.01' : `≈${formatUsd(usd)}`
}

export type PlanState =
  { status: 'loading' } | { status: 'ok'; plan: CatalogRefreshPlan } | { status: 'error' }

/** `~2 min · ≈$0.05` from core's plan; words where core has no figure. */
export function planFacts(p: PlanState): string {
  if (p.status === 'loading') return 'Estimating the time and cost…'
  if (p.status === 'error') return 'Time and cost not known'
  const { estDurationMs, estCostUsd } = p.plan
  const time = estDurationMs !== null ? formatEta(estDurationMs) : 'Time not known'
  const cost =
    estCostUsd !== null
      ? `${approxUsd(estCostUsd)}${p.plan.apiEquivalent === true ? ` ${API_EQUIVALENT}` : ''}`
      : 'cost not known'
  return `${time} · ${cost}`
}

/** The day prices were last fetched, in words. */
export function pricesFromText(at: number | null): string {
  if (at === null) return 'The model prices Dim Factory estimates costs with have never been refreshed.'
  return `The model prices Dim Factory estimates costs with are from ${new Date(at).toLocaleDateString()}.`
}

/** Changes the job found (the diff's offered rows). */
export function changesText(n: number): string {
  if (n === 0) return 'No price changes found'
  return n === 1 ? '1 change ready to review' : `${n} changes ready to review`
}

/** One line about the job: `Claude (sonnet) is reading the price pages · 1m 12s`, its end, or what it found. */
export function jobLine(job: CatalogJob, now: number): string {
  const who = refresherName(job.vendor, job.model)
  switch (job.state) {
    case 'running':
      return `${who} is reading the price pages · ${formatDuration(Math.max(0, now - job.startedAt))}`
    case 'diff-ready':
      return changesText(job.diff?.rows.length ?? 0)
    case 'failed':
      return job.error !== undefined && job.error !== ''
        ? `The price update failed: ${job.error}`
        : 'The price update failed'
    case 'cancelled':
      return 'The price update was cancelled'
    case 'applied':
      return 'The price update was applied'
  }
}

/**
 * catalog.refreshPlan while `active` (the card asking for consent, Settings → Catalog once open), read again when the
 * configuration (the refresh vendor or model) or the catalog changes.
 */
export function useRefreshPlan(active: boolean): PlanState {
  const configEpoch = useConfigEpoch()
  const catalogEpoch = useCatalogEpoch()
  const [state, setState] = useState<PlanState>({ status: 'loading' })
  useEffect(() => {
    if (!active) return
    let alive = true
    void invoke('catalog.refreshPlan').then((r) => {
      if (!alive) return
      setState(r.ok ? { status: 'ok', plan: r.value } : { status: 'error' })
    })
    return () => {
      alive = false
    }
  }, [active, configEpoch, catalogEpoch])
  return state
}
