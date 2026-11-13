// `dashboard.get` (the Dashboard's data): active runs, the 20 most recent
// others, totals for today/7d/30d, 7-day spend by vendor, vendor health, attention and the catalog status. Pure
// except readCatalogState (state.json).
// Definitions:
//   - active = queued, running, waiting or paused (the tray's and the renderer's ACTIVE_RUN_STATUSES), newest
//     first. A failed run holds its folder lock but waits on the user: it is in `recent` (its outcome line
//     "Failed at Implement · …") and in attention (its snag).
//   - recent = every other run (completed, failed, cancelled), most recently ended first (createdAt when it has
//     not ended), 20 at most.
//   - catalog status: pricing from catalog/pricing.json; the schedule from `catalog.refresh` (user config) and
//     state.json (`catalog.lastRefreshAt`, `catalog.snoozedUntil`). A refresh is due when the schedule is on and
//     `intervalDays` passed since the last refresh — or since the shipped prices' date when there was none — and
//     no snooze runs (the rule lives in catalog/scheduler.ts); `jobRunning` comes from the caller.
import type { CatalogStatus, PricingFile } from '../../shared/catalog.ts'
import type { AttentionItem, DashboardData } from '../../shared/estimates.ts'
import type { RunStatus, RunSummary } from '../../shared/run.ts'
import type { ProbeView } from '../../shared/vendors.ts'
import { catalogNextDueAt, readCatalogScheduleState } from '../catalog/scheduler.ts'
import type { CatalogScheduleState } from '../catalog/scheduler.ts'
import { pricesFetchedAt, pricingStatus } from '../catalog/store.ts'
import { compareSummaries } from '../store/index-store.ts'
import type { SpendPricing } from './stats.ts'
import { spendByVendor7d, totalsByPeriod } from './stats.ts'

export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting', 'paused']
export const RECENT_LIMIT = 20

export interface DashboardInput {
  now: number
  summaries: readonly RunSummary[]
  attention: { needsYou: number; items: AttentionItem[] }
  vendorHealth: ProbeView[]
  catalog: CatalogStatus
  pricing: SpendPricing
}

const endOf = (s: RunSummary): number => s.endedAt ?? s.createdAt

export function buildDashboard(i: DashboardInput): DashboardData {
  const active = i.summaries.filter((s) => ACTIVE_STATUSES.includes(s.status)).sort(compareSummaries)
  const recent = i.summaries
    .filter((s) => !ACTIVE_STATUSES.includes(s.status))
    .sort((a, b) => endOf(b) - endOf(a) || b.displayNo - a.displayNo)
    .slice(0, RECENT_LIMIT)
  return {
    generatedAt: i.now,
    active,
    recent,
    totals: totalsByPeriod(i.summaries, i.now),
    spendByVendor7d: spendByVendor7d(i.summaries, i.now, i.pricing),
    vendorHealth: i.vendorHealth,
    attention: { needsYou: i.attention.needsYou, items: i.attention.items },
    catalog: i.catalog,
  }
}

// ---- catalog status --------------------------------------------------------------------------------------------

export type { CatalogScheduleState }

export interface CatalogStatusInput {
  /** catalog/pricing.json as loaded; null when the catalog is unavailable. */
  pricing: PricingFile | null
  /** `catalog.refresh` (user config). */
  refresh: { enabled: boolean; intervalDays: number }
  state: CatalogScheduleState
  now: number
  jobRunning?: boolean
}

export function catalogStatus(i: CatalogStatusInput): CatalogStatus {
  const { enabled, intervalDays } = i.refresh
  const prices =
    i.pricing !== null
      ? pricingStatus(i.pricing, intervalDays, i.now, i.state.lastRefreshAt)
      : { pricingUpdatedAt: null, confidence: 'none' as const, stale: false }
  // One due rule for this status, the scheduler and the consent card (catalog/scheduler.ts). Before
  // the first refresh it counts from the shipped prices' date, never from a manual edit (store.ts pricesFetchedAt).
  const nextDueAt = catalogNextDueAt(
    i.state,
    i.refresh,
    i.now,
    i.pricing !== null ? pricesFetchedAt(i.pricing) : null,
  )
  return {
    ...prices,
    refreshDue: nextDueAt !== null && i.now >= nextDueAt,
    jobRunning: i.jobRunning ?? false,
    schedule: {
      enabled,
      intervalDays,
      lastRefreshAt: i.state.lastRefreshAt,
      snoozedUntil: i.state.snoozedUntil,
      nextDueAt,
    },
  }
}

/** state.json's catalog fields (defaults when the file is missing, corrupt or newer). Reads only. */
export function readCatalogState(stateFile: string): Promise<CatalogScheduleState> {
  return readCatalogScheduleState(stateFile)
}
