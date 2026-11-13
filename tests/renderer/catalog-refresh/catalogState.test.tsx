// Catalog state in the renderer (src/renderer/src/state/catalog.ts; the catalog refresh, the AppEvent
// `catalog`): the bridge routes `catalog` events into the store; a due refresh and a job's start and end read core's
// whole catalog, a job's progress is taken as it comes; an applied update bumps the epoch estimates and pickers watch;
// overlapping reads share one request; the Settings dot follows core's newest status. Nothing here ever sends
// catalog.refresh.
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogState } from '@shared/catalog.ts'
import { Shell } from '@renderer/components/shell/Shell.tsx'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { resetDashboardForTests, useDashboardStore } from '@renderer/pages/dashboard/rail/dashboardData.ts'
import {
  loadCatalog,
  noteCatalogStatus,
  onCatalogEvent,
  resetCatalogForTests,
  setCatalogSchedule,
} from '@renderer/state/catalog.ts'
import { useStore } from '@renderer/state/store.ts'
import { deferred } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { dashboardData } from '../dashboard/fixtures.tsx'
import { catalogState, diff, job, row, schedule, status } from './fixtures.ts'

let mock: MockDimFactory
let state: CatalogState

beforeEach(() => {
  resetCatalogForTests()
  resetDashboardForTests()
  state = catalogState()
  mock = setUp({ handlers: { 'catalog.get': () => state } })
})

afterEach(() => {
  resetBridgeForTests()
  resetDashboardForTests()
  tearDown(mock)
  resetCatalogForTests()
})

const slice = () => useStore.getState().catalog

describe('events', () => {
  it('a due refresh marks the status due at once, then reads core’s catalog', async () => {
    noteCatalogStatus(status())
    state = catalogState({ status: status({ refreshDue: true }) })
    onCatalogEvent({ kind: 'catalog', state: 'due' })
    expect(slice().status?.refreshDue).toBe(true)
    await settle()
    expect(mock.callsOf('catalog.get')).toHaveLength(1)
    expect(slice().state).toEqual(state)
  })

  it('a new job is shown running at once and read whole; its progress is taken without reading again', async () => {
    state = catalogState({ job: job({ startedAt: 123 }) })
    onCatalogEvent({ kind: 'catalog', state: 'running', jobId: 'j1' })
    expect(slice().job?.state).toBe('running')
    await settle()
    expect(mock.callsOf('catalog.get')).toHaveLength(1)
    expect(slice().job?.startedAt).toBe(123)
    onCatalogEvent({ kind: 'catalog', state: 'running', jobId: 'j1', progress: 'Reading claude.com' })
    expect(slice().job?.progress).toBe('Reading claude.com')
    expect(slice().job?.startedAt).toBe(123)
    await settle()
    expect(mock.callsOf('catalog.get')).toHaveLength(1)
  })

  it('a diff that comes with the event is shown before the read answers; the end of a job is read whole', async () => {
    const hold = deferred<CatalogState>()
    mock.on('catalog.get', () => hold.promise)
    const d = diff([row({ id: 'a' })])
    onCatalogEvent({ kind: 'catalog', state: 'diff-ready', jobId: 'j1', diff: d })
    expect(slice().job?.diff).toEqual(d)
    expect(slice().job?.state).toBe('diff-ready')
    hold.resolve(catalogState({ job: job({ state: 'diff-ready', diff: d }) }))
    await settle()
    expect(mock.callsOf('catalog.get')).toHaveLength(1)
  })

  it('a failed job keeps the reason core’s event gives', () => {
    onCatalogEvent({ kind: 'catalog', state: 'failed', jobId: 'j1', error: 'The CLI is not logged in.' })
    expect(slice().job).toMatchObject({ id: 'j1', state: 'failed', error: 'The CLI is not logged in.' })
  })

  it('an applied update bumps the epoch (estimates and pickers ask again); a failure does not', async () => {
    const epoch = slice().epoch
    onCatalogEvent({ kind: 'catalog', state: 'failed', jobId: 'j1' })
    expect(slice().epoch).toBe(epoch)
    onCatalogEvent({ kind: 'catalog', state: 'applied', jobId: 'j1' })
    expect(slice().epoch).toBe(epoch + 1)
    await settle()
    expect(mock.callsOf('catalog.refresh')).toEqual([])
  })

  it('the bridge routes `catalog` events into the store', async () => {
    resetBridgeForTests()
    startBridge()
    await settle()
    state = catalogState({ job: job({ startedAt: 5 }) })
    mock.push({ kind: 'catalog', state: 'running', jobId: 'j1', progress: 'Searching the web' })
    expect(slice().job).toMatchObject({ id: 'j1', state: 'running', progress: 'Searching the web' })
    await settle()
    expect(mock.callsOf('catalog.get')).toHaveLength(1)
  })
})

describe('reads and writes', () => {
  it('overlapping reads share one request and one more follows, so the newest answer wins', async () => {
    const first = deferred<CatalogState>()
    let n = 0
    mock.on('catalog.get', () => (++n === 1 ? first.promise : state))
    const a = loadCatalog()
    const b = loadCatalog()
    const c = loadCatalog()
    expect(mock.callsOf('catalog.get')).toHaveLength(1)
    first.resolve(catalogState({ job: job({ state: 'running' }) }))
    state = catalogState({ job: job({ state: 'cancelled' }) })
    await settle()
    const results = await Promise.all([a, b, c])
    expect(mock.callsOf('catalog.get')).toHaveLength(2)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(slice().job?.state).toBe('cancelled')
  })

  it('a schedule change keeps core’s schedule, then reads whether a refresh is still due', async () => {
    noteCatalogStatus(status({ refreshDue: true }))
    mock.on('catalog.setSchedule', () => schedule({ snoozedUntil: 99 }))
    state = catalogState({ status: status({ refreshDue: false, schedule: schedule({ snoozedUntil: 99 }) }) })
    const answer = await setCatalogSchedule({ snoozeDays: 7 }, 'Snoozed')
    expect(answer?.snoozedUntil).toBe(99)
    expect(mock.callsOf('catalog.get')).toHaveLength(1)
    expect(slice().status?.refreshDue).toBe(false)
  })
})

describe('the Settings dot', () => {
  it('follows core’s newest status (Not now, a due event) over the Dashboard’s last answer', async () => {
    useDashboardStore.setState({
      status: 'ready',
      data: dashboardData({ catalog: { ...dashboardData().catalog, refreshDue: true } }),
    })
    const { rerender } = render(
      <Providers>
        <Shell>
          <p>page</p>
        </Shell>
      </Providers>,
    )
    expect(screen.getByTestId('settings-attention-dot')).toBeTruthy()
    noteCatalogStatus(status({ refreshDue: false }))
    rerender(
      <Providers>
        <Shell>
          <p>page</p>
        </Shell>
      </Providers>,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.queryByTestId('settings-attention-dot')).toBeNull()
  })
})
