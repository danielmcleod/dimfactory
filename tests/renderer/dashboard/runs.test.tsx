// Runs history v0: runs.list 100 per page with Load more, status chips through
// runs.list, rows that open the run. Three cases changed since: the text filter goes to core (runs.list `text`, titles),
// a row whose run changes status stays where it is (nothing moves on its own), and Pin / Remove / the actions menu
// are live (their behaviour is tested in tests/renderer/history/*).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunListQuery } from '@shared/ipc.ts'
import type { RunSummary } from '@shared/run.ts'
import { RunsPage } from '@renderer/pages/runs/RunsPage.tsx'
import { upsertSummaries } from '@renderer/state/actions.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory

const all: RunSummary[] = Array.from({ length: 150 }, (_, i) =>
  makeSummary({
    runId: `r${i}`,
    displayNo: i + 1,
    title: i === 3 ? 'Fix the login page' : `Task ${i}`,
    folder: i % 2 === 0 ? 'C:\\work\\api' : 'C:\\work\\web',
    status: i % 3 === 0 ? 'failed' : 'completed',
    outcome: i % 3 === 0 ? 'failed' : 'clean',
    createdAt: 1_000_000 - i,
  }),
)

function page(q: RunListQuery): { items: RunSummary[]; nextCursor: string | null } {
  // As core's filterSummaries: status, and text over titles, ignoring case.
  const text = q.text?.toLowerCase()
  const rows = all.filter(
    (s) =>
      (q.status === undefined || q.status.includes(s.status)) &&
      (text === undefined || s.title.toLowerCase().includes(text)),
  )
  const offset = q.cursor !== undefined ? Number(q.cursor) : 0
  const limit = q.limit ?? 100
  const items = rows.slice(offset, offset + limit)
  return { items, nextCursor: offset + limit < rows.length ? String(offset + limit) : null }
}

beforeEach(() => {
  mock = setUp({ handlers: { 'runs.list': (q) => page(q) } })
})

afterEach(() => tearDown(mock))

async function mount(): Promise<void> {
  render(
    <Providers>
      <RunsPage />
    </Providers>,
  )
  await settle()
}

const rows = (): HTMLElement[] => within(screen.getByTestId('runs-list')).getAllByRole('listitem')

describe('Runs page', () => {
  it('loads 100 runs, then the rest with Load more', async () => {
    await mount()
    expect(mock.callsOf('runs.list')).toEqual([{ limit: 100 }])
    expect(rows()).toHaveLength(100)
    expect(rows()[0]?.dataset['testid']).toBe('runs-row-r0')
    expect(
      within(rows()[0] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe('#/runs/r0')
    await act(async () => {
      fireEvent.click(screen.getByTestId('runs-load-more'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.list').at(-1)).toEqual({ limit: 100, cursor: '100' })
    expect(rows()).toHaveLength(150)
    expect(screen.queryByTestId('runs-load-more')).toBeNull()
    expect(screen.getByTestId('runs-count').textContent).toBe('150 runs')
  })

  it('says a title cut to one line in full as a tooltip', async () => {
    await mount()
    const title = within(rows()[3] as HTMLElement)
      .getByText('Fix the login page')
      .closest('p')
    expect(title?.className).toContain('truncate')
    expect(title?.getAttribute('title')).toBe('#4 Fix the login page')
  })

  it('filters by status and by title text through runs.list', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runs-filter-failed'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.list').at(-1)).toEqual({ limit: 100, status: ['failed'] })
    expect(screen.getByTestId('runs-filter-failed').getAttribute('aria-pressed')).toBe('true')
    expect(rows().every((r) => r.dataset['status'] === 'failed')).toBe(true)
    expect(rows()).toHaveLength(50)

    fireEvent.click(screen.getByTestId('runs-filter-all'))
    await settle()
    fireEvent.change(screen.getByTestId('runs-filter-text'), { target: { value: 'LOGIN' } })
    await settle(300)
    expect(mock.callsOf('runs.list').at(-1)).toEqual({ limit: 100, text: 'LOGIN' })
    expect(rows().map((r) => r.dataset['testid'])).toEqual(['runs-row-r3'])
    expect(screen.getByTestId('runs-count').textContent).toBe('1 run')
    fireEvent.change(screen.getByTestId('runs-filter-text'), { target: { value: 'nothing like this' } })
    await settle(300)
    expect(screen.getByText('No runs match these filters')).toBeTruthy()
  })

  it('shows active runs under Active and updates rows from live summaries', async () => {
    mock.on('runs.list', (q) =>
      q.status?.includes('running') === true
        ? {
            items: [makeSummary({ runId: 'live', status: 'running', createdAt: 2_000_000 })],
            nextCursor: null,
          }
        : page(q),
    )
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runs-filter-active'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.list').at(-1)).toEqual({
      limit: 100,
      status: ['queued', 'running', 'waiting', 'paused'],
    })
    expect(rows().map((r) => r.dataset['testid'])).toEqual(['runs-row-live'])
    act(() => upsertSummaries([makeSummary({ runId: 'live', status: 'completed', createdAt: 2_000_000 })]))
    // Nothing moves on its own: the row stays where it is and shows the run's new status.
    expect(rows().map((r) => r.dataset['testid'])).toEqual(['runs-row-live'])
    expect(rows()[0]?.dataset['status']).toBe('completed')
  })

  it('Pin, Remove and the actions menu are live', async () => {
    await mount()
    const row = rows()[0] as HTMLElement
    for (const name of ['Pin', 'Remove', 'More actions']) {
      expect(within(row).getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(false)
    }
    expect(within(row).queryByLabelText(/available in a later version/)).toBeNull()
  })

  it('says so when there are no runs yet', async () => {
    mock.on('runs.list', () => ({ items: [], nextCursor: null }))
    await mount()
    expect(screen.getByText('No runs yet')).toBeTruthy()
  })
})
