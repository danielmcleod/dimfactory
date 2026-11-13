// Builders and a harness for the Dashboard rail tests: core's DashboardData, and the right rail mounted with the
// dashboard.get hook the way DashboardPage mounts it (without the composer, which these tests do not cover).
import type { DashboardData, PeriodTotals } from '@shared/estimates.ts'
import { RightRail } from '@renderer/pages/dashboard/RightRail.tsx'
import { useDashboardData } from '@renderer/pages/dashboard/rail/dashboardData.ts'

export function totals(over: Partial<PeriodTotals> = {}): PeriodTotals {
  return { runs: 0, completed: 0, failed: 0, costUsd: 0, tokens: 0, ...over }
}

export function dashboardData(over: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: 1_700_000_000_000,
    active: [],
    recent: [],
    totals: { today: totals(), d7: totals(), d30: totals() },
    spendByVendor7d: [],
    vendorHealth: [],
    attention: { needsYou: 0, items: [] },
    catalog: {
      pricingUpdatedAt: null,
      confidence: 'unverified',
      stale: false,
      refreshDue: false,
      jobRunning: false,
      schedule: { enabled: true, intervalDays: 14, lastRefreshAt: null, snoozedUntil: null, nextDueAt: null },
    },
    ...over,
  }
}

/** The rail fed by the Dashboard's data hook. */
export function RailWithData(): React.JSX.Element {
  const dashboard = useDashboardData()
  return <RightRail dashboard={dashboard} />
}
