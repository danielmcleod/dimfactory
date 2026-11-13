// Run totals, spend by vendor and the stats tiles (totals for today/7d/30d with
// failed = status failed OR outcome failed; 7-day spend by vendor; `stats.get{range}` returns the tiles). Pure over
// RunSummary rows (runs/index.jsonl plus the live runs).
// Definitions:
//   - a run belongs to a period by its createdAt. `today` starts at the machine's local midnight; 24h/7d/30d/90d
//     are rolling windows ending now; `all` has no start.
//   - each run is in exactly one class: failed (status failed or outcome failed — a closed failed run is cancelled
//     with outcome failed), else completed, else cancelled, else active (queued/running/waiting/paused).
//   - cost and tokens are RunSummary.progress (every attempt; unpriced runs add 0).
//   - spend by vendor splits each run's progress figures over the vendors of its steps, in proportion to the
//     steps' final-attempt cost (else tokens, else evenly), so the vendors add up to the run totals. A step's
//     final-attempt cost is the vendor's figure, or its usage at the current catalog price (SpendPricing).
//   - successRate = completed / (completed + failed), cancelled excluded; medianDurationMs = the nearest-rank median
//     of completed runs' wall time (endedAt − createdAt).
import type {
  DashboardPeriod,
  PeriodTotals,
  StatsData,
  StatsRange,
  VendorSpend,
} from '../../shared/estimates.ts'
import type { RunSummary, RunSummaryStep } from '../../shared/run.ts'
import { roundUsd } from '../catalog/cost.ts'
import { percentile } from '../estimates/defaults.ts'
import { sampleTokens } from '../estimates/estimate.ts'

export const DAY_MS = 86_400_000

/** Prices a step's final-attempt usage for the spend split (app-core: the vendor's figure or the catalog). */
export interface SpendPricing {
  stepUsd(row: RunSummaryStep): number | null
  /** The vendor is signed in with a subscription: its dollar figures are API-equivalent. */
  apiEquivalent(vendor: string): boolean
}

export type RunClass = 'completed' | 'failed' | 'cancelled' | 'active'

export function runClass(s: Pick<RunSummary, 'status' | 'outcome'>): RunClass {
  if (s.status === 'failed' || s.outcome === 'failed') return 'failed'
  if (s.status === 'completed') return 'completed'
  if (s.status === 'cancelled') return 'cancelled'
  return 'active'
}

/** Local midnight of `now`'s calendar day on this machine. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function periodStart(p: DashboardPeriod, now: number): number {
  switch (p) {
    case 'today':
      return startOfLocalDay(now)
    case 'd7':
      return now - 7 * DAY_MS
    case 'd30':
      return now - 30 * DAY_MS
  }
}

export function rangeStart(r: StatsRange, now: number): number | null {
  switch (r) {
    case '24h':
      return now - DAY_MS
    case '7d':
      return now - 7 * DAY_MS
    case '30d':
      return now - 30 * DAY_MS
    case '90d':
      return now - 90 * DAY_MS
    case 'all':
      return null
  }
}

const since = (summaries: readonly RunSummary[], from: number | null): RunSummary[] =>
  from === null ? [...summaries] : summaries.filter((s) => s.createdAt >= from)

export function periodTotals(runs: readonly RunSummary[]): PeriodTotals {
  const t: PeriodTotals = { runs: 0, completed: 0, failed: 0, costUsd: 0, tokens: 0 }
  for (const s of runs) {
    t.runs++
    const c = runClass(s)
    if (c === 'completed') t.completed++
    else if (c === 'failed') t.failed++
    t.costUsd += s.progress.costUsd ?? 0
    t.tokens += s.progress.tokens
  }
  t.costUsd = roundUsd(t.costUsd)
  return t
}

export function totalsByPeriod(
  summaries: readonly RunSummary[],
  now: number,
): Record<DashboardPeriod, PeriodTotals> {
  return {
    today: periodTotals(since(summaries, periodStart('today', now))),
    d7: periodTotals(since(summaries, periodStart('d7', now))),
    d30: periodTotals(since(summaries, periodStart('d30', now))),
  }
}

/** `weights` normalized; an all-zero (or empty) map gets even shares. */
function shares(weights: ReadonlyMap<string, number>): Map<string, number> {
  const total = [...weights.values()].reduce((a, b) => a + b, 0)
  const out = new Map<string, number>()
  for (const [k, w] of weights) out.set(k, total > 0 ? w / total : 1 / weights.size)
  return out
}

/** One run's cost and tokens split over the vendors of its steps (see the header). Empty without vendor steps. */
export function runVendorSplit(
  s: RunSummary,
  pricing: SpendPricing,
): Map<string, { costUsd: number; tokens: number; priced: boolean }> {
  const usd = new Map<string, number>()
  const tok = new Map<string, number>()
  for (const row of s.steps) {
    if (row.vendor === undefined) continue
    usd.set(row.vendor, (usd.get(row.vendor) ?? 0) + Math.max(0, pricing.stepUsd(row) ?? 0))
    tok.set(row.vendor, (tok.get(row.vendor) ?? 0) + (row.usage !== undefined ? sampleTokens(row.usage) : 0))
  }
  const out = new Map<string, { costUsd: number; tokens: number; priced: boolean }>()
  if (usd.size === 0) return out
  const usdTotal = [...usd.values()].reduce((a, b) => a + b, 0)
  const costShare = shares(usdTotal > 0 ? usd : tok)
  const tokShare = shares(tok)
  const cost = s.progress.costUsd ?? 0
  for (const v of usd.keys()) {
    out.set(v, {
      costUsd: cost * (costShare.get(v) ?? 0),
      tokens: s.progress.tokens * (tokShare.get(v) ?? 0),
      priced: s.progress.costUsd !== null && (costShare.get(v) ?? 0) > 0,
    })
  }
  return out
}

/** Spend per vendor over `runs`, largest cost first (then tokens, then id). */
export function spendByVendor(runs: readonly RunSummary[], pricing: SpendPricing): VendorSpend[] {
  const acc = new Map<string, VendorSpend>()
  for (const s of runs) {
    for (const [vendor, part] of runVendorSplit(s, pricing)) {
      const v = acc.get(vendor) ?? { vendor, costUsd: 0, tokens: 0, apiEquivalent: false }
      v.costUsd += part.costUsd
      v.tokens += part.tokens
      if (part.priced && part.costUsd > 0 && pricing.apiEquivalent(vendor)) v.apiEquivalent = true
      acc.set(vendor, v)
    }
  }
  return [...acc.values()]
    .map((v) => ({ ...v, costUsd: roundUsd(v.costUsd), tokens: Math.round(v.tokens) }))
    .filter((v) => v.costUsd > 0 || v.tokens > 0)
    .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.vendor.localeCompare(b.vendor))
}

export function spendByVendor7d(
  summaries: readonly RunSummary[],
  now: number,
  pricing: SpendPricing,
): VendorSpend[] {
  return spendByVendor(since(summaries, periodStart('d7', now)), pricing)
}

/** `stats.get{range}`. */
export function buildStats(
  summaries: readonly RunSummary[],
  range: StatsRange,
  now: number,
  pricing: SpendPricing,
): StatsData {
  const from = rangeStart(range, now)
  const runs = since(summaries, from)
  const t = periodTotals(runs)
  const cancelled = runs.filter((s) => runClass(s) === 'cancelled').length
  const durations = runs
    .filter((s) => runClass(s) === 'completed' && s.endedAt !== undefined)
    .map((s) => Math.max(0, (s.endedAt ?? s.createdAt) - s.createdAt))
  const decided = t.completed + t.failed
  return {
    range,
    from,
    to: now,
    runs: t.runs,
    completed: t.completed,
    failed: t.failed,
    cancelled,
    successRate: decided > 0 ? t.completed / decided : null,
    successSamples: decided,
    medianDurationMs: durations.length > 0 ? percentile(durations, 50) : null,
    costUsd: t.costUsd,
    tokens: t.tokens,
    spendByVendor: spendByVendor(runs, pricing),
  }
}
