// Runs history filters and pages (folder, status, vendor, date, text; 100
// per page; UI standards: nothing moves on its own). Every filter is sent to core as runs.list's
// query; Load more appends below with the first page's query; the list only changes on the user's own input.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunListQuery } from '@shared/ipc.ts'
import type { RunSummary } from '@shared/run.ts'
import { dateBounds, dayEnd, dayStart, listQuery, NO_FILTERS } from '@renderer/pages/runs/filters.ts'
import { resetRemovalsForTests } from '@renderer/pages/runs/removals.ts'
import { RunsPage } from '@renderer/pages/runs/RunsPage.tsx'
import { upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { deferred } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { listOver } from './fixtures.ts'

const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()
const DAY = 86_400_000

let mock: MockDimFactory

const all: RunSummary[] = Array.from({ length: 130 }, (_, i) =>
  makeSummary({
    runId: `r${i}`,
    displayNo: 200 - i,
    title: i === 5 ? 'Fix the login page' : `Task ${i}`,
    folder: i % 2 === 0 ? 'C:\\work\\api' : 'C:\\work\\web',
    status: i % 3 === 0 ? 'failed' : 'completed',
    phase: 'done',
    outcome: i % 3 === 0 ? 'failed' : 'clean',
    createdAt: NOW - i * 3_600_000,
    steps: [{ key: 'implement', vendor: i % 4 === 0 ? 'codex' : 'claude', status: 'done', activeMs: 1 }],
  }),
)

beforeEach(() => {
  mock = setUp({
    handlers: {
      'runs.list': listOver(all),
      'stats.get': () => {
        throw new Error('not under test here')
      },
      'folders.recent': () => [
        { folder: 'C:\\work\\api', scopeRoot: null, lastRunAt: NOW, isGit: true, exists: true },
        { folder: 'C:\\work\\docs', scopeRoot: null, lastRunAt: NOW - DAY, isGit: true, exists: true },
      ],
    },
  })
})

afterEach(() => {
  resetRemovalsForTests()
  tearDown(mock)
})

async function mount(): Promise<void> {
  render(
    <Providers>
      <RunsPage />
    </Providers>,
  )
  await settle()
}

const rows = (): HTMLElement[] => within(screen.getByTestId('runs-list')).getAllByRole('listitem')
const rowIds = (): string[] => rows().map((r) => r.dataset['testid'] ?? '')
const lastList = (): RunListQuery | undefined => mock.callsOf('runs.list').at(-1)

async function choose(testId: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId(testId), { target: { value } })
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

describe('the query each filter sends', () => {
  it('asks for every run, 100 at a time, with no filter', async () => {
    await mount()
    expect(mock.callsOf('runs.list')).toEqual([{ limit: 100 }])
    expect(rows()).toHaveLength(100)
    expect(screen.getByTestId<HTMLButtonElement>('runs-filter-clear').disabled).toBe(true)
  })

  it.each([
    ['active', ['queued', 'running', 'waiting', 'paused']],
    ['completed', ['completed']],
    ['failed', ['failed']],
    ['cancelled', ['cancelled']],
  ])('status %s', async (id, status) => {
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId(`runs-filter-${id}`))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(lastList()).toEqual({ limit: 100, status })
    expect(screen.getByTestId(`runs-filter-${id}`).getAttribute('aria-pressed')).toBe('true')
  })

  it("folder: core's recent folders and the loaded runs' folders, sent as `folder`", async () => {
    await mount()
    const select = screen.getByTestId<HTMLSelectElement>('runs-filter-folder')
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'C:\\work\\api',
      'C:\\work\\docs',
      'C:\\work\\web',
    ])
    expect(select.options[1]?.textContent).toBe('api (C:\\work\\api)')
    await choose('runs-filter-folder', 'C:\\work\\web')
    expect(lastList()).toEqual({ limit: 100, folder: 'C:\\work\\web' })
    expect(rows()).toHaveLength(65)
    expect(select.getAttribute('title')).toBe('C:\\work\\web')
  })

  it('vendor: the built vendors core probed and those the loaded runs used, sent as `vendor`', async () => {
    upsertProbes([probeView('claude', 'ready'), probeView('gemini', 'ready', { built: false })])
    await mount()
    const select = screen.getByTestId<HTMLSelectElement>('runs-filter-vendor')
    expect([...select.options].map((o) => o.value)).toEqual(['', 'claude', 'codex'])
    expect([...select.options].map((o) => o.textContent)).toEqual(['All vendors', 'Claude', 'Codex'])
    await choose('runs-filter-vendor', 'codex')
    expect(lastList()).toEqual({ limit: 100, vendor: 'codex' })
    expect(rows()).toHaveLength(33)
  })

  it('date: Today from local midnight, the last 7 and 30 days from now', async () => {
    await mount()
    await choose('runs-filter-date', 'today')
    const midnight = new Date(2026, 9, 6).getTime()
    expect(lastList()).toEqual({ limit: 100, from: midnight })
    expect(rows()).toHaveLength(16)
    await choose('runs-filter-date', '7d')
    expect(lastList()).toEqual({ limit: 100, from: NOW - 7 * DAY })
    await choose('runs-filter-date', '30d')
    expect(lastList()).toEqual({ limit: 100, from: NOW - 30 * DAY })
    await choose('runs-filter-date', 'any')
    expect(lastList()).toEqual({ limit: 100 })
  })

  it('date: a custom range sends the whole days chosen, either end open', async () => {
    await mount()
    expect(screen.queryByTestId('runs-filter-from')).toBeNull()
    await choose('runs-filter-date', 'custom')
    expect(lastList()).toEqual({ limit: 100 })
    await choose('runs-filter-from', '2026-10-05')
    expect(lastList()).toEqual({ limit: 100, from: new Date(2026, 9, 5).getTime() })
    await choose('runs-filter-to', '2026-10-05')
    expect(lastList()).toEqual({
      limit: 100,
      from: new Date(2026, 9, 5).getTime(),
      to: new Date(2026, 9, 6).getTime() - 1,
    })
    expect(rows()).toHaveLength(24)
  })

  it('text: sent trimmed once typing pauses, at once on Enter', async () => {
    await mount()
    const box = screen.getByTestId('runs-filter-text')
    fireEvent.change(box, { target: { value: '  login ' } })
    await settle(100)
    expect(mock.callsOf('runs.list')).toHaveLength(1)
    await settle(300)
    expect(lastList()).toEqual({ limit: 100, text: 'login' })
    expect(rowIds()).toEqual(['runs-row-r5'])
    fireEvent.change(box, { target: { value: 'Task 12' } })
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(lastList()).toEqual({ limit: 100, text: 'Task 12' })
    await settle(400)
    // The pause after Enter asks nothing more.
    expect(mock.callsOf('runs.list').filter((q) => q.text === 'Task 12')).toHaveLength(1)
  })

  it('every filter together, and Clear filters back to every run', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runs-filter-failed'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await choose('runs-filter-folder', 'C:\\work\\api')
    await choose('runs-filter-vendor', 'claude')
    await choose('runs-filter-date', '7d')
    fireEvent.change(screen.getByTestId('runs-filter-text'), { target: { value: 'Task' } })
    await settle(300)
    // The last 7 days as of this query (the pause before it moved the clock on).
    expect(lastList()).toEqual({
      limit: 100,
      status: ['failed'],
      folder: 'C:\\work\\api',
      vendor: 'claude',
      from: Date.now() - 7 * DAY,
      text: 'Task',
    })
    const clear = screen.getByTestId<HTMLButtonElement>('runs-filter-clear')
    expect(clear.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(clear)
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(lastList()).toEqual({ limit: 100 })
    expect(screen.getByTestId<HTMLInputElement>('runs-filter-text').value).toBe('')
    expect(clear.disabled).toBe(true)
    expect(screen.getByTestId('runs-filter-all').getAttribute('aria-pressed')).toBe('true')
  })

  it('says no runs match (or none yet) when core lists none', async () => {
    await mount()
    fireEvent.change(screen.getByTestId('runs-filter-text'), { target: { value: 'nothing like this' } })
    await settle(300)
    expect(screen.getByText('No runs match these filters')).toBeTruthy()
    expect(screen.queryByTestId('runs-list')).toBeNull()
  })
})

describe('pages and what never moves on its own', () => {
  it('Load more appends below with the first page’s query and keeps the rows already shown', async () => {
    await mount()
    await choose('runs-filter-date', '30d')
    const first = rows()
    expect(first).toHaveLength(100)
    // Time passes before the user asks for more: the page keeps its listing's bounds.
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      fireEvent.click(screen.getByTestId('runs-load-more'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(lastList()).toEqual({ limit: 100, from: NOW - 30 * DAY, cursor: '100' })
    expect(rows()).toHaveLength(130)
    // The first hundred are the same nodes, in the same order, with the new ones after them.
    expect(rows().slice(0, 100)).toEqual(first)
    expect(rowIds().slice(100)).toEqual(all.slice(100).map((s) => `runs-row-${s.runId}`))
    expect(screen.queryByTestId('runs-load-more')).toBeNull()
    expect(screen.getByTestId('runs-count').textContent).toBe('130 runs')
  })

  it('a run that starts while the list is open is not inserted above the rows', async () => {
    await mount()
    const before = rowIds()
    act(() => upsertSummaries([makeSummary({ runId: 'new', status: 'running', createdAt: NOW + 1000 })]))
    expect(rowIds()).toEqual(before)
  })

  it('keeps the rows on screen until core answers a new filter, and drops a reply that came too late', async () => {
    const slow = deferred<{ items: RunSummary[]; nextCursor: string | null }>()
    const list = listOver(all)
    mock.on('runs.list', (q) => (q.status?.includes('failed') === true ? slow.promise : list(q)))
    await mount()
    const before = rowIds()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runs-filter-failed'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(rowIds()).toEqual(before)
    expect(screen.getByTestId('runs-list').getAttribute('aria-busy')).toBe('true')
    // The user moves on to Cancelled before Failed's answer comes.
    await act(async () => {
      fireEvent.click(screen.getByTestId('runs-filter-cancelled'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('No runs match these filters')).toBeTruthy()
    await act(async () => {
      slow.resolve(list({ status: ['failed'], limit: 100 }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('No runs match these filters')).toBeTruthy()
  })
})

describe('filters.ts', () => {
  it('builds only what is set', () => {
    expect(listQuery(NO_FILTERS, NOW)).toEqual({})
    expect(listQuery({ ...NO_FILTERS, text: '   ' }, NOW)).toEqual({})
    expect(dateBounds({ date: 'custom', fromDay: '', toDay: '2026-13-40' }, NOW)).toEqual({})
    expect(dayStart('2026-10-05')).toBe(new Date(2026, 9, 5).getTime())
    expect(dayEnd('2026-10-05')).toBe(new Date(2026, 9, 6).getTime() - 1)
    expect(dayStart('yesterday')).toBeNull()
  })
})

describe('a list core cannot give', () => {
  it('keeps the rows where they are and says so below them (never above, where it would push them down)', async () => {
    await mount()
    const before = rowIds()
    expect(before).toHaveLength(100)
    mock.on('runs.list', () => {
      throw new Error('the index is busy')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runs-filter-failed'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Could not load runs')
    expect(rowIds()).toEqual(before)
    // After the list in the page's order: nothing above the rows moved.
    expect(
      screen.getByTestId('runs-list').compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByTestId('runs-load-more')).toBeNull()
  })
})
