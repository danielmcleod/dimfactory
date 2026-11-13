// state/: the debounced per-run snapshot refetch, snapshot ordering, summaries order and the stable selectors.
import './helpers/rtl.ts'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSnapshot } from '@shared/run.ts'
import { applySnapshot, removeRuns, upsertSummaries } from '@renderer/state/actions.ts'
import {
  REFETCH_DEBOUNCE_MS,
  REFETCH_MAX_WAIT_MS,
  cancelRefetches,
  ensureRun,
  fetchSnapshot,
  scheduleRefetch,
} from '@renderer/state/runs.ts'
import { useActiveRunCount, useRun, useRunIds } from '@renderer/state/selectors.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { deferred, installMockDimFactory, mockError } from './helpers/mockDimFactory.ts'
import type { MockDimFactory } from './helpers/mockDimFactory.ts'
import { makeSnapshot, makeSummary } from './helpers/fixtures.ts'

let mock: MockDimFactory
let seq = 0

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  resetStore()
  seq = 0
  mock = installMockDimFactory({ handlers: { 'runs.get': (q) => makeSnapshot({ runId: q.runId }, ++seq) } })
})

afterEach(() => {
  cancelRefetches()
  mock.uninstall()
  vi.useRealTimers()
})

describe('snapshot refetch', () => {
  it('coalesces a burst into one trailing runs.get per run', async () => {
    for (let i = 0; i < 5; i++) {
      scheduleRefetch('r1')
      await vi.advanceTimersByTimeAsync(20)
    }
    scheduleRefetch('r2')
    expect(mock.callsOf('runs.get')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(REFETCH_DEBOUNCE_MS)
    expect(mock.callsOf('runs.get')).toEqual([{ runId: 'r1' }, { runId: 'r2' }])
    expect(useStore.getState().runs.byId['r1']?.status).toBe('ready')
  })

  it(`still fetches at least every ${REFETCH_MAX_WAIT_MS} ms under a steady stream of changes`, async () => {
    for (let t = 0; t < 2050; t += 50) {
      scheduleRefetch('r1')
      await vi.advanceTimersByTimeAsync(50)
    }
    const n = mock.callsOf('runs.get').length
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(3)
  })

  it('runs one request at a time and exactly one more for changes that arrived meanwhile', async () => {
    const gate = deferred<void>()
    mock.on('runs.get', async (q) => {
      await gate.promise
      return makeSnapshot({ runId: q.runId }, ++seq)
    })
    void fetchSnapshot('r1')
    await vi.advanceTimersByTimeAsync(0)
    scheduleRefetch('r1')
    scheduleRefetch('r1')
    void fetchSnapshot('r1')
    gate.resolve()
    await vi.advanceTimersByTimeAsync(REFETCH_DEBOUNCE_MS * 2)
    expect(mock.callsOf('runs.get')).toHaveLength(2)
  })

  it('keeps the error for a run that never loaded, and keeps an existing snapshot on a later error', async () => {
    mock.on('runs.get', () => {
      throw mockError('NOT_FOUND', 'Run r9 not found.')
    })
    await fetchSnapshot('r9')
    expect(useStore.getState().runs.byId['r9']).toMatchObject({ status: 'error', error: 'Run r9 not found.' })
    applySnapshot(makeSnapshot({ runId: 'r8' }, 3))
    await fetchSnapshot('r8')
    expect(useStore.getState().runs.byId['r8']).toMatchObject({ status: 'ready', lastSeq: 3 })
  })

  it('ensureRun loads once', async () => {
    ensureRun('r1')
    ensureRun('r1')
    await vi.advanceTimersByTimeAsync(0)
    ensureRun('r1')
    expect(mock.callsOf('runs.get')).toHaveLength(1)
  })
})

describe('snapshots and summaries', () => {
  it('never replaces a snapshot with an older one, and carries the summary over', () => {
    const newer: RunSnapshot = makeSnapshot({ runId: 'r1', phase: 'reviewing' }, 10)
    const older: RunSnapshot = makeSnapshot({ runId: 'r1', phase: 'planning' }, 4)
    expect(applySnapshot(newer)).toBe(true)
    expect(applySnapshot(older)).toBe(false)
    const s = useStore.getState()
    expect(s.runs.byId['r1']?.snapshot?.summary.phase).toBe('reviewing')
    expect(s.summaries.byId['r1']?.phase).toBe('reviewing')
  })

  it('orders summaries newest first and removes runs', () => {
    upsertSummaries([
      makeSummary({ runId: 'a', createdAt: 1, displayNo: 1 }),
      makeSummary({ runId: 'c', createdAt: 3, displayNo: 3 }),
      makeSummary({ runId: 'b', createdAt: 3, displayNo: 2 }),
    ])
    expect(useStore.getState().summaries.order).toEqual(['c', 'b', 'a'])
    removeRuns(['c'])
    expect(useStore.getState().summaries.order).toEqual(['b', 'a'])
  })
})

describe('selectors', () => {
  it('useRunIds splits active from finished and keeps the array identity when nothing relevant changed', () => {
    upsertSummaries([
      makeSummary({ runId: 'a', status: 'running', createdAt: 2 }),
      makeSummary({ runId: 'b', status: 'completed', createdAt: 1 }),
    ])
    const active = renderHook(() => useRunIds('active'))
    const finished = renderHook(() => useRunIds('finished'))
    const count = renderHook(() => useActiveRunCount())
    expect(active.result.current).toEqual(['a'])
    expect(finished.result.current).toEqual(['b'])
    expect(count.result.current).toBe(1)
    const first = active.result.current
    act(() =>
      upsertSummaries([makeSummary({ runId: 'b', status: 'completed', createdAt: 1, title: 'renamed' })]),
    )
    expect(active.result.current).toBe(first)
    act(() => upsertSummaries([makeSummary({ runId: 'b', status: 'running', createdAt: 1 })]))
    expect(active.result.current).toEqual(['a', 'b'])
  })

  it('useRun loads the snapshot on mount', async () => {
    const { result } = renderHook(() => useRun('r5'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current?.status).toBe('ready')
    expect(mock.callsOf('runs.get')).toEqual([{ runId: 'r5' }])
  })
})
