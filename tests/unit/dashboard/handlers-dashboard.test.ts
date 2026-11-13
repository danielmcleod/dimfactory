// The dashboard commands through createHandlers (src/core/handlers-dashboard.ts): request checks, the deps they
// read when they run (a context without them answers UNSUPPORTED), and the data they assemble.
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_COMMANDS, createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import type { DashboardDeps } from '@core/handlers-dashboard.ts'
import type { CatalogStatus } from '@shared/catalog.ts'
import type { RunEstimate } from '@shared/estimates.ts'
import type { RunSummary } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { MIN, T0, run } from '../estimates/helpers.ts'

const NOW = T0 + 60 * MIN
const ESTIMATE = { total: { basis: 'typical (no history yet)' } } as RunEstimate
const CATALOG = { refreshDue: true } as CatalogStatus
const HEALTH = [{ vendor: 'claude', health: 'ready' }] as ProbeView[]

function handlers(summaries: RunSummary[], dashboard?: Partial<DashboardDeps>) {
  const calls: { folder: string; overrides: unknown }[] = []
  const deps: DashboardDeps = {
    attention: () => ({ needsYou: 0, items: [] }),
    vendorHealth: () => HEALTH,
    catalogStatus: () => Promise.resolve(CATALOG),
    pricing: { stepUsd: () => null, apiEquivalent: () => false },
    estimate: (folder, overrides) => {
      calls.push({ folder, overrides })
      return Promise.resolve(ESTIMATE)
    },
    folderFacts: () => Promise.resolve({ exists: true, isGit: true, scopeRoot: 'C:\\work' }),
    ...dashboard,
  }
  const ctx = {
    now: () => NOW,
    summaries: () => summaries,
    ...(dashboard !== undefined ? { dashboard: deps } : {}),
  } as unknown as HandlerContext
  return { h: createHandlers(ctx), calls }
}

describe('dashboard commands', () => {
  it('are the dashboard commands, built in this core', () => {
    const { h } = handlers([], {})
    for (const cmd of ['estimates.get', 'dashboard.get', 'stats.get', 'folders.recent'] as const) {
      expect(DASHBOARD_COMMANDS).toContain(cmd)
      expect(h[cmd]).toBeTypeOf('function')
    }
  })

  it('without the dashboard deps they answer UNSUPPORTED (folders.recent needs none)', async () => {
    const { h } = handlers([run([], { folder: 'C:\\work\\app' })])
    const d = await dispatch(h, 'dashboard.get', undefined)
    expect(d.ok ? null : d.error.code).toBe('UNSUPPORTED')
    const e = await dispatch(h, 'estimates.get', { folder: 'C:\\work' })
    expect(e.ok ? null : e.error.code).toBe('UNSUPPORTED')
    const f = await dispatch(h, 'folders.recent', undefined)
    expect(f.ok && f.value.map((x) => x.folder)).toEqual(['C:\\work\\app'])
  })

  it('estimates.get resolves the folder and passes the overrides through', async () => {
    const { h, calls } = handlers([], {})
    const r = await dispatch(h, 'estimates.get', { folder: 'rel/dir', overrides: { profile: 'fast' } })
    expect(r.ok && r.value).toBe(ESTIMATE)
    expect(calls).toEqual([{ folder: resolve('rel/dir'), overrides: { profile: 'fast' } }])
    const bad = await dispatch(h, 'estimates.get', { folder: '  ' })
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')
  })

  it('dashboard.get assembles the data from the summaries and the deps', async () => {
    const active = run([], { status: 'running', createdAt: NOW - MIN })
    const done = run([], { status: 'completed', createdAt: NOW - 30 * MIN, endedAt: NOW - 5 * MIN })
    const { h } = handlers([done, active], { attention: () => ({ needsYou: 2, items: [] }) })
    const r = await dispatch(h, 'dashboard.get', undefined)
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value).toMatchObject({
      generatedAt: NOW,
      vendorHealth: HEALTH,
      catalog: CATALOG,
      attention: { needsYou: 2, items: [] },
      totals: { d7: { runs: 2, completed: 1, failed: 0 } },
    })
    expect(r.value.active.map((s) => s.runId)).toEqual([active.runId])
    expect(r.value.recent.map((s) => s.runId)).toEqual([done.runId])
  })

  it('stats.get checks the range', async () => {
    const { h } = handlers([run([], { createdAt: NOW - MIN })], {})
    const ok = await dispatch(h, 'stats.get', { range: '7d' })
    expect(ok.ok && ok.value).toMatchObject({ range: '7d', runs: 1, completed: 1, successRate: 1 })
    const bad = await dispatch(h, 'stats.get', { range: '1y' } as unknown as { range: '7d' })
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')
  })

  it('folders.recent uses the deps’ folder facts', async () => {
    const { h } = handlers([run([], { folder: 'C:\\work\\app' })], {})
    const r = await dispatch(h, 'folders.recent', undefined)
    expect(r.ok && r.value[0]).toMatchObject({ isGit: true, scopeRoot: 'C:\\work', exists: true })
  })
})
