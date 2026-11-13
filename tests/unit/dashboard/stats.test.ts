// Totals, spend by vendor and the stats tiles (src/core/dashboard/stats.ts): failed =
// status failed OR outcome failed, today from local midnight, rolling 7/30-day windows, the per-vendor split that
// adds up to the run totals, successRate (cancelled excluded) and the median duration.
import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  buildStats,
  periodTotals,
  runClass,
  runVendorSplit,
  spendByVendor,
  startOfLocalDay,
  totalsByPeriod,
} from '@core/dashboard/stats.ts'
import type { SpendPricing } from '@core/dashboard/stats.ts'
import type { RunSummary, RunSummaryStep } from '@shared/run.ts'
import { MIN, run, step, usage } from '../estimates/helpers.ts'

// Local 15:00 on 2026-10-06: "today" starts at local midnight whatever the machine's zone.
const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()
const H = 3_600_000

/** A run created at `createdAt`, ended 10 min later unless `open`. */
const at = (createdAt: number, over: Partial<RunSummary> = {}, open = false): RunSummary => {
  const r = run([], { createdAt, endedAt: createdAt + 10 * MIN, ...over })
  if (open) delete r.endedAt
  return r
}

/** stepUsd = usage.costUsd (a stand-in for the vendor's figure or the catalog's). */
const pricing = (subscription: string[] = []): SpendPricing => ({
  stepUsd: (row) => row.usage?.costUsd ?? null,
  apiEquivalent: (v) => subscription.includes(v),
})

const vendorRow = (vendor: string, tokens: number, usd?: number): RunSummaryStep =>
  step('implement', 1, { vendor, usage: usage(tokens, 0, usd !== undefined ? { costUsd: usd } : {}) })

describe('run classes', () => {
  it('failed = status failed or outcome failed; then completed, cancelled, active', () => {
    expect(runClass({ status: 'failed' })).toBe('failed')
    expect(runClass({ status: 'cancelled', outcome: 'failed' })).toBe('failed')
    expect(runClass({ status: 'completed', outcome: 'verify-failed' })).toBe('completed')
    expect(runClass({ status: 'cancelled' })).toBe('cancelled')
    for (const s of ['queued', 'running', 'waiting', 'paused'] as const)
      expect(runClass({ status: s })).toBe('active')
  })
})

describe('totals', () => {
  it('runs, completed, failed (by status or outcome), cost (unpriced adds 0) and tokens', () => {
    const t = periodTotals([
      at(NOW, { status: 'completed', progress: { tokens: 100, costUsd: 0.1, filesChanged: 0 } }),
      at(NOW, { status: 'failed', progress: { tokens: 50, costUsd: null, filesChanged: 0 } }),
      at(NOW, {
        status: 'cancelled',
        outcome: 'failed',
        progress: { tokens: 5, costUsd: 0.2, filesChanged: 0 },
      }),
      at(NOW, { status: 'cancelled' }),
      at(NOW, { status: 'running', progress: { tokens: 1, costUsd: 0.05, filesChanged: 0 } }),
    ])
    expect(t).toEqual({ runs: 5, completed: 1, failed: 2, costUsd: 0.35, tokens: 156 })
  })

  it('today starts at local midnight; 7d and 30d are rolling windows', () => {
    const midnight = startOfLocalDay(NOW)
    expect(new Date(midnight).getHours()).toBe(0)
    const all = [
      at(midnight + H), // today
      at(midnight - H), // yesterday 23:00: 7d, 30d
      at(NOW - 10 * DAY_MS), // 30d only
      at(NOW - 40 * DAY_MS), // none
    ]
    const t = totalsByPeriod(all, NOW)
    expect(t.today.runs).toBe(1)
    expect(t.d7.runs).toBe(2)
    expect(t.d30.runs).toBe(3)
  })
})

describe('spend by vendor', () => {
  it("splits the run's totals by the steps' final-attempt cost, so the vendors add up to the run", () => {
    const r = run([vendorRow('claude', 300, 3), vendorRow('codex', 100, 1), step('verify:1', 1)], {
      progress: { tokens: 1000, costUsd: 8, filesChanged: 0 },
    })
    const split = runVendorSplit(r, pricing())
    expect(split.get('claude')).toMatchObject({ costUsd: 6, tokens: 750 })
    expect(split.get('codex')).toMatchObject({ costUsd: 2, tokens: 250 })
    expect(split.has('verify:1')).toBe(false)
  })

  it('without step costs the cost follows the tokens; without either, an even split', () => {
    const byTokens = run([vendorRow('claude', 300), vendorRow('codex', 100)], {
      progress: { tokens: 400, costUsd: 4, filesChanged: 0 },
    })
    expect(runVendorSplit(byTokens, pricing()).get('codex')).toMatchObject({ costUsd: 1, tokens: 100 })
    const even = run([step('plan', 1, { vendor: 'claude' }), step('implement', 1, { vendor: 'codex' })], {
      progress: { tokens: 10, costUsd: 2, filesChanged: 0 },
    })
    expect(runVendorSplit(even, pricing()).get('claude')).toMatchObject({ costUsd: 1, tokens: 5 })
  })

  it('sums vendors over runs, largest cost first, marks API-equivalent figures, drops empty vendors', () => {
    const runs = [
      run([vendorRow('claude', 10, 1)], { progress: { tokens: 10, costUsd: 1, filesChanged: 0 } }),
      run([vendorRow('codex', 30, 3)], { progress: { tokens: 30, costUsd: 3, filesChanged: 0 } }),
      run([vendorRow('claude', 10, 1)], { progress: { tokens: 10, costUsd: 1, filesChanged: 0 } }),
      run([step('plan', 1, { vendor: 'gemini' })], {
        progress: { tokens: 0, costUsd: null, filesChanged: 0 },
      }),
    ]
    expect(spendByVendor(runs, pricing(['claude']))).toEqual([
      { vendor: 'codex', costUsd: 3, tokens: 30, apiEquivalent: false },
      { vendor: 'claude', costUsd: 2, tokens: 20, apiEquivalent: true },
    ])
  })
})

describe('stats.get tiles', () => {
  it('successRate = completed / (completed + failed), cancelled excluded; nearest-rank median of completed runs', () => {
    const runs = [
      at(NOW - H, { status: 'completed', endedAt: NOW - H + 10 * MIN }),
      at(NOW - H, { status: 'completed', endedAt: NOW - H + 20 * MIN }),
      at(NOW - H, { status: 'completed', endedAt: NOW - H + 30 * MIN }),
      at(NOW - H, { status: 'failed' }, true),
      at(NOW - H, { status: 'cancelled' }),
      at(NOW - H, { status: 'running' }, true),
      at(NOW - 3 * DAY_MS, { status: 'failed' }),
    ]
    const s = buildStats(runs, '24h', NOW, pricing())
    expect(s).toMatchObject({
      range: '24h',
      from: NOW - DAY_MS,
      to: NOW,
      runs: 6,
      completed: 3,
      failed: 1,
      cancelled: 1,
      successRate: 0.75,
      successSamples: 4,
      medianDurationMs: 20 * MIN,
    })
    const all = buildStats(runs, 'all', NOW, pricing())
    expect(all).toMatchObject({ from: null, runs: 7, failed: 2, successRate: 0.6 })
  })

  it('no decided runs: no rate and no median', () => {
    const s = buildStats([at(NOW, { status: 'running' })], '7d', NOW, pricing())
    expect(s).toMatchObject({
      successRate: null,
      successSamples: 0,
      medianDurationMs: null,
      spendByVendor: [],
    })
  })
})
