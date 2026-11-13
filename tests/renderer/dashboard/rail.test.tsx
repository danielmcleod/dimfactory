// Dashboard rail on core's data (the Dashboard data, the right rail): today's
// tiles and 7-day spend from dashboard.get, debounced refresh after run/attention/probe changes, vendor health kept
// fresh without moving backwards, the catalog consent card (live), Re-probe with "Checking…", the
// Settings dot when prices are due, and the fallback tiles when core has no dashboard.get.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardData } from '@shared/estimates.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { Shell } from '@renderer/components/shell/Shell.tsx'
import { RAIL_WAIT_MS } from '@renderer/pages/dashboard/RightRail.tsx'
import {
  DASHBOARD_REFRESH_MAX_MS,
  DASHBOARD_REFRESH_MS,
  resetDashboardForTests,
  useDashboardStore,
} from '@renderer/pages/dashboard/rail/dashboardData.ts'
import { setAttention, upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, settle, setUp, tearDown } from './setup.tsx'
import { dashboardData, RailWithData, totals } from './fixtures.tsx'

let mock: MockDimFactory
let data: DashboardData

beforeEach(() => {
  data = dashboardData()
  mock = setUp({ handlers: { 'dashboard.get': () => data } })
  resetDashboardForTests()
})

afterEach(() => {
  tearDown(mock)
  resetDashboardForTests()
})

async function mount(): Promise<void> {
  render(
    <Providers>
      <RailWithData />
    </Providers>,
  )
  await settle()
}

const tile = (name: string): string | null =>
  within(screen.getByTestId(`summary-tile-${name}`)).getByRole('definition').textContent

const withProbe = (p: ProbeView, at: number): ProbeView => ({
  ...p,
  probe: {
    vendor: p.vendor,
    at,
    ok: p.health === 'ready',
    checks: [],
    capabilities: {} as never,
    models: [],
  },
})

describe('summary tiles', () => {
  it("shows today's runs, completed, failed and cost from core, and 7-day spend by vendor", async () => {
    data = dashboardData({
      totals: {
        today: totals({ runs: 5, completed: 3, failed: 1, costUsd: 1.234, tokens: 120_000 }),
        d7: totals({ runs: 12, costUsd: 1.2 }),
        d30: totals(),
      },
      spendByVendor7d: [
        { vendor: 'claude', costUsd: 0.8, tokens: 90_000, apiEquivalent: true },
        { vendor: 'codex', costUsd: 0.4, tokens: 30_000, apiEquivalent: false },
      ],
    })
    await mount()
    expect(mock.callsOf('dashboard.get')).toHaveLength(1)
    expect(tile('runs')).toBe('5')
    expect(tile('completed')).toBe('3')
    expect(tile('failed')).toBe('1')
    expect(tile('cost')).toBe('$1.23')
    const spend = screen.getByTestId('spend-by-vendor')
    expect(spend.textContent).toContain('$1.20 · 12 runs')
    const rows = within(spend).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      'Claude$0.80 · API-equiv.90.0k tok',
      'Codex$0.40' + '30.0k tok',
    ])
    const bars = rows.map((r) => (r.querySelector('[aria-hidden] > div') as HTMLElement).style.width)
    expect(bars).toEqual(['100%', '50%'])
  })

  it('says when there was no spend', async () => {
    await mount()
    expect(screen.getByTestId('spend-by-vendor').textContent).toContain('No spend in the last 7 days.')
    expect(tile('cost')).toBe('$0.00')
  })

  it('says Loading… before core answers and Not available when it fails: a word, never a dash', async () => {
    const hold = deferred<void>()
    mock.on('dashboard.get', async () => {
      await hold.promise
      throw mockError('INTERNAL', 'runs.jsonl could not be read')
    })
    await mount()
    // The rail waits (invisible) for core's answer, at most RAIL_WAIT_MS, then shows what it has.
    expect(screen.getByTestId('right-rail').style.visibility).toBe('hidden')
    await settle(RAIL_WAIT_MS)
    expect(screen.getByTestId('right-rail').style.visibility).toBe('')
    expect(tile('runs')).toBe('Loading…')
    expect(tile('cost')).toBe('Loading…')
    await act(async () => {
      hold.resolve()
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(screen.getByText(/Totals could not be loaded/)).toBeTruthy()
    expect(tile('runs')).toBe('Not available')
    expect(tile('failed')).toBe('Not available')
  })

  it('keeps the older disabled tiles when core has no dashboard.get, and stops asking', async () => {
    mock.on('dashboard.get', () => {
      throw mockError('UNSUPPORTED', 'dashboard.get is not available in this build.')
    })
    await mount()
    expect(screen.getByTestId('today-runs').textContent).toBe('Not available')
    expect(screen.getByRole('group', { name: /Runs .*Cost .*Available in a later version$/ })).toBeTruthy()
    expect(screen.queryByTestId('summary-tile-runs')).toBeNull()
    act(() => upsertSummaries([makeSummary({ runId: 'r1' })]))
    await settle(DASHBOARD_REFRESH_MAX_MS)
    expect(mock.callsOf('dashboard.get')).toHaveLength(1)
  })

  it("keeps the last figures and shows core's message when a refresh fails", async () => {
    data = dashboardData({ totals: { today: totals({ runs: 2 }), d7: totals(), d30: totals() } })
    await mount()
    mock.on('dashboard.get', () => {
      throw mockError('STORAGE', 'The run index could not be read.')
    })
    act(() => setAttention(1, []))
    await settle(DASHBOARD_REFRESH_MS)
    expect(tile('runs')).toBe('2')
    expect(screen.getByRole('status').textContent).toBe(
      'Totals could not be loaded: The run index could not be read.',
    )
  })
})

describe('refresh', () => {
  it('refetches once, debounced, after run summaries, attention and probes change', async () => {
    await mount()
    act(() => upsertSummaries([makeSummary({ runId: 'r1' })]))
    await settle(DASHBOARD_REFRESH_MS - 100)
    act(() => setAttention(1, []))
    await settle(DASHBOARD_REFRESH_MS - 100)
    act(() => upsertProbes([probeView('claude', 'ready')]))
    await settle(DASHBOARD_REFRESH_MS - 1)
    expect(mock.callsOf('dashboard.get')).toHaveLength(1)
    await settle(1)
    expect(mock.callsOf('dashboard.get')).toHaveLength(2)
  })

  it('does not hold a refresh back longer than the maximum under a steady stream of events', async () => {
    await mount()
    for (let i = 0; i < 10; i++) {
      act(() => upsertSummaries([makeSummary({ runId: `r${i}` })]))
      await settle(400)
    }
    expect(mock.callsOf('dashboard.get').length).toBeGreaterThanOrEqual(2)
  })

  it('asks again after a refresh that was requested while one was in flight', async () => {
    const hold = deferred<DashboardData>()
    mock.on('dashboard.get', () => hold.promise)
    await mount()
    act(() => upsertSummaries([makeSummary({ runId: 'r1' })]))
    await settle(DASHBOARD_REFRESH_MS)
    expect(mock.callsOf('dashboard.get')).toHaveLength(1)
    mock.on('dashboard.get', () => data)
    await act(async () => {
      hold.resolve(data)
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(DASHBOARD_REFRESH_MS)
    expect(mock.callsOf('dashboard.get')).toHaveLength(2)
  })
})

describe('store sync', () => {
  it('takes newer vendor views from core but never older ones, without a refetch loop', async () => {
    upsertProbes([withProbe(probeView('claude', 'login-needed'), 100)])
    data = dashboardData({
      vendorHealth: [
        withProbe(probeView('claude', 'ready'), 200),
        probeView('codex', 'not-built', { built: false }),
      ],
    })
    await mount()
    expect(useStore.getState().probes.byVendor['claude']?.health).toBe('ready')
    expect(useStore.getState().probes.byVendor['codex']?.health).toBe('not-built')
    await settle(DASHBOARD_REFRESH_MAX_MS)
    expect(mock.callsOf('dashboard.get')).toHaveLength(1)

    // A probe event newer than the next answer: the answer does not move it back.
    act(() => upsertProbes([withProbe(probeView('claude', 'login-needed'), 300)]))
    await settle(DASHBOARD_REFRESH_MS)
    expect(mock.callsOf('dashboard.get')).toHaveLength(2)
    expect(useStore.getState().probes.byVendor['claude']?.health).toBe('login-needed')
  })

  it("adds active runs the store does not have, and leaves the bridge's live summaries alone", async () => {
    upsertSummaries([makeSummary({ runId: 'live', title: 'Live title', status: 'running' })], {
      loaded: true,
    })
    data = dashboardData({
      active: [
        makeSummary({ runId: 'live', title: 'Older title', status: 'running' }),
        makeSummary({ runId: 'paused-at-boot', status: 'paused' }),
      ],
      recent: [makeSummary({ runId: 'old', status: 'completed', outcome: 'clean' })],
    })
    await mount()
    const byId = useStore.getState().summaries.byId
    expect(byId['live']?.title).toBe('Live title')
    expect(byId['paused-at-boot']?.status).toBe('paused')
    // The bridge loaded its own recent runs: one missing from it was removed meanwhile, not brought back.
    expect(byId['old']).toBeUndefined()
  })

  it('takes recent runs too before the bridge has loaded any', async () => {
    data = dashboardData({ recent: [makeSummary({ runId: 'old', status: 'completed', outcome: 'clean' })] })
    await mount()
    expect(useStore.getState().summaries.byId['old']?.status).toBe('completed')
  })
})

describe('catalog consent card', () => {
  // The card is live (tests/renderer/catalog-refresh/consentCard.test.tsx covers its states and requests): it says what an
  // update runs in the refresh job's words and its buttons work, and it runs nothing by itself.
  it('is shown only when a price refresh is due, with its buttons live and nothing run', async () => {
    await mount()
    expect(screen.queryByTestId('catalog-card')).toBeNull()
    data = dashboardData({
      catalog: { ...dashboardData().catalog, refreshDue: true, pricingUpdatedAt: null },
    })
    act(() => setAttention(1, []))
    await settle(DASHBOARD_REFRESH_MS)
    const card = screen.getByTestId('catalog-card')
    expect(card.textContent).toContain('Model prices may be out of date')
    expect(card.textContent?.toLowerCase()).toContain('read-only, web search, cannot change files')
    for (const name of ['Update now', 'Not now (7 days)', 'Turn off'])
      expect(within(card).getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(false)
    expect(within(card).queryByRole('group', { name: 'Update now Available in a later version' })).toBeNull()
    expect(mock.callsOf('catalog.refresh')).toEqual([])
  })

  it('puts a dot on Settings while prices are due', () => {
    useDashboardStore.setState({
      status: 'ready',
      data: dashboardData({ catalog: { ...dashboardData().catalog, refreshDue: true } }),
    })
    render(
      <Providers>
        <Shell>
          <p>page</p>
        </Shell>
      </Providers>,
    )
    expect(screen.getByTestId('settings-attention-dot').getAttribute('aria-label')).toBe(
      'Model prices may be out of date',
    )
  })
})

describe('vendor health', () => {
  it('re-probes with "Checking…" until core answers, and links to the vendor in Settings', async () => {
    upsertProbes([probeView('claude', 'login-needed')])
    const hold = deferred<ProbeView[]>()
    mock.on('vendors.probe', () => hold.promise)
    await mount()
    const row = screen.getByTestId('vendor-health-claude')
    expect(within(row).getByRole('link', { name: 'Claude' }).getAttribute('href')).toBe(
      '#/settings/vendors/claude',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('vendor-reprobe-claude'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(row.textContent).toContain('Checking…')
    expect(screen.getByTestId<HTMLButtonElement>('vendor-reprobe-claude').disabled).toBe(true)
    await act(async () => {
      hold.resolve([probeView('claude', 'ready')])
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(screen.getByTestId('vendor-health-claude').textContent).toContain('Ready')
    expect(screen.getByTestId('vendor-health-claude').dataset['health']).toBe('ready')
  })
})
