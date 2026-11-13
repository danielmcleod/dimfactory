// Runs page tiles ("stats.get{range} returns the tiles"; UI standards:
// async content never shifts the page, an empty value gets a word). The range's request, core's figures formatted,
// the tiles' room kept while core answers or when it cannot, and no em dash anywhere on the page.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatsData, StatsRange } from '@shared/estimates.ts'
import { resetFixPickersForTests } from '@renderer/components/run/rerun.ts'
import { resetRemovalsForTests } from '@renderer/pages/runs/removals.ts'
import { RunsPage } from '@renderer/pages/runs/RunsPage.tsx'
import {
  STATS_LOADING,
  STATS_NONE,
  STATS_NOT_AVAILABLE,
  STATS_SUB_PLACEHOLDER,
  StatsTiles,
} from '@renderer/pages/runs/StatsTiles.tsx'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { endedSummary, listOver } from './fixtures.ts'

let mock: MockDimFactory

function stats(range: StatsRange, over: Partial<StatsData> = {}): StatsData {
  return {
    range,
    from: 0,
    to: 1,
    runs: 14,
    completed: 9,
    failed: 3,
    cancelled: 2,
    successRate: 0.75,
    successSamples: 12,
    medianDurationMs: 372_000,
    costUsd: 4.2,
    tokens: 1_250_000,
    spendByVendor: [],
    ...over,
  }
}

beforeEach(() => {
  mock = setUp({ handlers: { 'stats.get': ({ range }) => stats(range) } })
})

afterEach(() => {
  resetRemovalsForTests()
  resetFixPickersForTests()
  tearDown(mock)
})

const TILES = ['runs', 'success', 'median', 'cost'] as const
const value = (name: string): string => screen.getByTestId(`runs-stat-${name}-value`).textContent ?? ''
const sub = (name: string): string => screen.getByTestId(`runs-stat-${name}-sub`).textContent ?? ''
/** Each tile's lines, as elements: the same three from the first paint on. */
const shape = (): string[] =>
  TILES.map((n) =>
    [...screen.getByTestId(`runs-stat-${n}`).children].map((c) => `${c.tagName}.${c.className}`).join('|'),
  )

describe('the tiles', () => {
  it('ask core for the last 7 days and format its figures', async () => {
    render(<StatsTiles />)
    await settle()
    expect(mock.callsOf('stats.get')).toEqual([{ range: '7d' }])
    expect(screen.getByTestId('runs-stats-range-7d').getAttribute('aria-pressed')).toBe('true')
    expect(value('runs')).toBe('14')
    expect(sub('runs')).toBe('9 completed · 3 failed · 2 cancelled')
    expect(value('success')).toBe('75%')
    expect(sub('success')).toBe('of 12 finished runs')
    expect(value('median')).toBe('6m 12s')
    // Core's median is over completed runs only (not failed ones), and the tile says so.
    expect(sub('median')).toBe('per completed run')
    expect(screen.getByTestId('runs-stat-median').getAttribute('title')).toBe(
      'The middle run time of completed runs',
    )
    expect(value('cost')).toBe('$4.20')
    expect(sub('cost')).toBe('1.25M tokens')
  })

  it('the second line has one fixed height in every state (loading, figures, not available)', async () => {
    const held = deferred<StatsData>()
    mock.on('stats.get', () => held.promise)
    render(<StatsTiles />)
    await settle()
    const fixed = (): void => {
      for (const n of TILES) {
        const line = screen.getByTestId(`runs-stat-${n}-sub`)
        expect(line.className.split(' ')).toEqual(expect.arrayContaining(['h-4', 'leading-4', 'truncate']))
        // Never a collapsible space only (a plain space would make a 0 px line in a nowrap box).
        expect(line.textContent).not.toBe('')
        expect(line.textContent?.replace(/\u00a0/g, 'x').trim()).not.toBe('')
      }
    }
    expect(STATS_SUB_PLACEHOLDER).toBe('\u00a0')
    fixed()
    await act(async () => {
      held.resolve(stats('7d'))
      await vi.advanceTimersByTimeAsync(0)
    })
    fixed()
    mock.on('stats.get', () => {
      throw mockError('UNSUPPORTED', 'stats.get is not available')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runs-stats-range-30d'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(value('runs')).toBe(STATS_NOT_AVAILABLE)
    fixed()
  })

  it('switch range on the user’s click', async () => {
    render(<StatsTiles />)
    await settle()
    for (const r of ['24h', '30d'] as const) {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`runs-stats-range-${r}`))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(mock.callsOf('stats.get').at(-1)).toEqual({ range: r })
      expect(screen.getByTestId(`runs-stats-range-${r}`).getAttribute('aria-pressed')).toBe('true')
    }
  })

  it('keep their lines while core answers (a word in the figure’s place), then fill them in', async () => {
    const held = deferred<StatsData>()
    mock.on('stats.get', () => held.promise)
    render(<StatsTiles />)
    await settle()
    const before = shape()
    expect(screen.getByTestId('runs-stats').getAttribute('aria-busy')).toBe('true')
    for (const n of TILES) {
      expect(value(n)).toBe(STATS_LOADING)
      // The second line is there, holding its room.
      expect(sub(n)).toBe(' ')
    }
    // The word keeps the figure's line height.
    expect(screen.getByTestId('runs-stat-runs-value').className).toContain('leading-7')
    await act(async () => {
      held.resolve(stats('7d'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(value('runs')).toBe('14')
    expect(shape().map((s) => s.split('|').length)).toEqual(before.map((s) => s.split('|').length))
    expect(screen.getByTestId('runs-stat-runs-value').className).toContain('leading-7')
  })

  it('say "None yet" without finished runs, never a dash', async () => {
    mock.on('stats.get', ({ range }) =>
      stats(range, {
        runs: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        successRate: null,
        successSamples: 0,
        medianDurationMs: null,
        costUsd: 0,
        tokens: 0,
      }),
    )
    render(<StatsTiles />)
    await settle()
    expect(value('success')).toBe(STATS_NONE)
    expect(value('median')).toBe(STATS_NONE)
    expect(sub('median')).toBe('No completed runs')
    expect(value('cost')).toBe('$0.00')
  })

  it('say "Not available" with core’s reason when it cannot answer', async () => {
    mock.on('stats.get', () => {
      throw mockError('UNSUPPORTED', 'stats.get is not available')
    })
    render(<StatsTiles />)
    await settle()
    for (const n of TILES) expect(value(n)).toBe(STATS_NOT_AVAILABLE)
    expect(screen.getByTestId('runs-stat-runs').getAttribute('title')).toContain('stats.get is not available')
  })
})

describe('the Runs page', () => {
  it('has the tiles in its header and no em dash in any text', async () => {
    mock.on('runs.list', (q) =>
      listOver([
        endedSummary({ runId: 'a', title: 'One' }),
        endedSummary({
          runId: 'b',
          displayNo: 8,
          status: 'failed',
          failure: { step: 'fix', category: 'unknown' },
        }),
      ])(q),
    )
    mock.on('folders.recent', () => [])
    render(
      <Providers>
        <RunsPage />
      </Providers>,
    )
    await settle()
    const stats = screen.getByTestId('runs-stats')
    const filters = screen.getByTestId('runs-filters')
    expect(stats.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('—')
    for (const el of document.body.querySelectorAll('[title],[aria-label],[placeholder]')) {
      for (const a of ['title', 'aria-label', 'placeholder'])
        expect(el.getAttribute(a) ?? '').not.toContain('—')
    }
  })
})
