// dashboard.get (src/core/dashboard/dashboard.ts; the Dashboard data): active runs, the 20
// most recent others, totals, spend, health and attention passed through, and the catalog status (due, snoozed,
// off) from the schedule and state.json.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DAY_MS } from '@core/catalog/cost.ts'
import { RECENT_LIMIT, buildDashboard, catalogStatus, readCatalogState } from '@core/dashboard/dashboard.ts'
import type { CatalogStatus, PricingFile } from '@shared/catalog.ts'
import type { AttentionItem } from '@shared/estimates.ts'
import type { RunSummary } from '@shared/run.ts'
import { MIN, T0, run } from '../estimates/helpers.ts'

const NOW = T0 + 30 * DAY_MS
const CATALOG = { refreshDue: false } as CatalogStatus
const pricing = { stepUsd: () => null, apiEquivalent: () => false }

const r = (status: RunSummary['status'], createdAt: number, endedAt?: number): RunSummary => {
  const s = run([], { status, createdAt })
  delete s.endedAt
  if (endedAt !== undefined) s.endedAt = endedAt
  return s
}

describe('buildDashboard', () => {
  it('active = queued/running/waiting/paused newest first; failed runs are recent, by when they ended', () => {
    const queued = r('queued', NOW - 1 * MIN)
    const running = r('running', NOW - 5 * MIN)
    const paused = r('paused', NOW - 60 * MIN)
    const waiting = r('waiting', NOW - 2 * MIN)
    const failed = r('failed', NOW - 30 * MIN)
    const doneLate = r('completed', NOW - 90 * MIN, NOW - 3 * MIN)
    const cancelled = r('cancelled', NOW - 20 * MIN, NOW - 10 * MIN)
    const item = { id: 'card:x', kind: 'card' } as AttentionItem
    const d = buildDashboard({
      now: NOW,
      summaries: [queued, running, paused, waiting, failed, doneLate, cancelled],
      attention: { needsYou: 1, items: [item] },
      vendorHealth: [],
      catalog: CATALOG,
      pricing,
    })
    expect(d.generatedAt).toBe(NOW)
    expect(d.active.map((s) => s.runId)).toEqual([queued, waiting, running, paused].map((s) => s.runId))
    // Ended 3 min ago, ended 10 min ago, created 30 min ago (still failed, not ended).
    expect(d.recent.map((s) => s.runId)).toEqual([doneLate, cancelled, failed].map((s) => s.runId))
    expect(d.attention).toEqual({ needsYou: 1, items: [item] })
    expect(d.catalog).toBe(CATALOG)
    expect(d.totals.d30).toMatchObject({ runs: 7, completed: 1, failed: 1 })
    expect(d.spendByVendor7d).toEqual([])
  })

  it('recent keeps the 20 most recent', () => {
    const many = Array.from({ length: 25 }, (_, i) => r('completed', NOW - 100 * MIN, NOW - i * MIN))
    const d = buildDashboard({
      now: NOW,
      summaries: many,
      attention: { needsYou: 0, items: [] },
      vendorHealth: [],
      catalog: CATALOG,
      pricing,
    })
    expect(d.recent).toHaveLength(RECENT_LIMIT)
    expect(d.recent[0]?.runId).toBe(many[0]?.runId)
    expect(d.recent.at(-1)?.runId).toBe(many[19]?.runId)
  })
})

describe('catalog status', () => {
  const PRICES: PricingFile = {
    schemaVersion: 1,
    updatedAt: NOW - 20 * DAY_MS,
    entries: [
      {
        vendor: 'claude',
        model: 'claude-opus-5-5',
        aliases: ['opus'],
        inputPerMTok: 4,
        outputPerMTok: 20,
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 8,
        sourceUrl: 'https://example.invalid/pricing',
        fetchedAt: NOW - 20 * DAY_MS,
        confidence: 'unverified',
      },
    ],
  }
  const on = { enabled: true, intervalDays: 14 }

  it('never refreshed: due once the interval passed since the shipped prices', () => {
    const s = catalogStatus({
      pricing: PRICES,
      refresh: on,
      state: { lastRefreshAt: null, snoozedUntil: null },
      now: NOW,
    })
    expect(s).toEqual({
      pricingUpdatedAt: NOW - 20 * DAY_MS,
      confidence: 'unverified',
      stale: false,
      refreshDue: true,
      jobRunning: false,
      schedule: {
        enabled: true,
        intervalDays: 14,
        lastRefreshAt: null,
        snoozedUntil: null,
        nextDueAt: NOW - 6 * DAY_MS,
      },
    })
  })

  it('a recent refresh is not due; "Not now" snoozes; Off has no due date', () => {
    const recent = catalogStatus({
      pricing: PRICES,
      refresh: on,
      state: { lastRefreshAt: NOW - DAY_MS, snoozedUntil: null },
      now: NOW,
    })
    expect(recent.refreshDue).toBe(false)
    expect(recent.schedule.nextDueAt).toBe(NOW + 13 * DAY_MS)
    const snoozed = catalogStatus({
      pricing: PRICES,
      refresh: on,
      state: { lastRefreshAt: null, snoozedUntil: NOW + 7 * DAY_MS },
      now: NOW,
    })
    expect(snoozed).toMatchObject({ refreshDue: false, schedule: { nextDueAt: NOW + 7 * DAY_MS } })
    const off = catalogStatus({
      pricing: PRICES,
      refresh: { enabled: false, intervalDays: 14 },
      state: { lastRefreshAt: null, snoozedUntil: null },
      now: NOW,
    })
    expect(off).toMatchObject({ refreshDue: false, schedule: { enabled: false, nextDueAt: null } })
  })

  it('stale prices (older than 2 × the interval) and no catalog at all', () => {
    // Staleness counts from when the prices were read (their fetchedAt), not pricing.json's write time.
    const old = catalogStatus({
      pricing: {
        ...PRICES,
        updatedAt: NOW - 40 * DAY_MS,
        entries: PRICES.entries.map((e) => ({ ...e, fetchedAt: NOW - 40 * DAY_MS })),
      },
      refresh: on,
      state: { lastRefreshAt: null, snoozedUntil: null },
      now: NOW,
    })
    expect(old.stale).toBe(true)
    const none = catalogStatus({
      pricing: null,
      refresh: on,
      state: { lastRefreshAt: null, snoozedUntil: null },
      now: NOW,
    })
    expect(none).toMatchObject({ pricingUpdatedAt: null, confidence: 'none', stale: false, refreshDue: true })
  })

  it("reads state.json's catalog fields; defaults when missing or corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'state-'))
    const file = join(dir, 'state.json')
    expect(await readCatalogState(file)).toEqual({ lastRefreshAt: null, snoozedUntil: null })
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, catalog: { lastRefreshAt: 5, snoozedUntil: 'x' } }),
    )
    expect(await readCatalogState(file)).toEqual({ lastRefreshAt: 5, snoozedUntil: null })
    await writeFile(file, '{oops')
    expect(await readCatalogState(file)).toEqual({ lastRefreshAt: null, snoozedUntil: null })
  })
})
