// Soak (state and performance): the renderer keeps a run's
// snapshot only while someone may show it: an unfinished run, a focused one (an open Run view, a run with asks) or one
// of the newest FINISHED_SNAPSHOTS_KEPT. A finished run's summary stays, and a view that opens it loads the snapshot
// again. Before, every run of a session kept its snapshot (refetched on each structural envelope) until a restart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunStatus } from '@shared/run.ts'
import { focusRun, resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import {
  FINISHED_SNAPSHOTS_KEPT,
  applySnapshot,
  pruneRunSnapshots,
  setRunLoading,
} from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { makeSnapshot, makeSummary } from '../helpers/fixtures.ts'

const N = FINISHED_SNAPSHOTS_KEPT + 10
const ids = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, i) => `r${from + i}`)
const snapshotIds = (): string[] => Object.keys(useStore.getState().runs.byId).sort()

/** N finished runs r0 (oldest) … r{N-1} (newest), with their snapshots in the store. */
function finishedRuns(status: RunStatus = 'completed'): void {
  for (let i = 0; i < N; i++)
    applySnapshot(makeSnapshot({ runId: `r${i}`, status, displayNo: i + 1, createdAt: 1_000 + i }, 7))
}

describe('pruneRunSnapshots', () => {
  beforeEach(() => resetStore())

  it('keeps unfinished, kept and the newest finished runs; drops the others; every summary stays', () => {
    finishedRuns()
    applySnapshot(makeSnapshot({ runId: 'live', status: 'running', createdAt: 1 }, 3))
    applySnapshot(makeSnapshot({ runId: 'snag', status: 'failed', createdAt: 2 }, 3))
    const dropped = pruneRunSnapshots(new Set(['r0']))
    expect(dropped.sort()).toEqual(ids(1, N - FINISHED_SNAPSHOTS_KEPT).sort())
    expect(snapshotIds()).toEqual(['live', 'r0', ...ids(N - FINISHED_SNAPSHOTS_KEPT, N), 'snag'].sort())
    expect(Object.keys(useStore.getState().summaries.byId)).toHaveLength(N + 2)
    // Nothing more to drop.
    expect(pruneRunSnapshots(new Set(['r0']))).toEqual([])
  })

  it('drops cancelled runs too, never a snapshot being loaded', () => {
    finishedRuns('cancelled')
    setRunLoading('r3')
    const dropped = pruneRunSnapshots(new Set())
    expect(dropped).not.toContain('r3')
    expect(dropped).toHaveLength(N - FINISHED_SNAPSHOTS_KEPT - 1)
    expect(useStore.getState().runs.byId['r3']?.status).toBe('loading')
  })
})

describe('the bridge drops snapshots as runs finish and the focus moves', () => {
  let mock: MockDimFactory

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    resetBridgeForTests()
    resetStore()
    clearToasts()
  })

  afterEach(() => {
    resetBridgeForTests()
    cancelRefetches()
    mock.uninstall()
    clearToasts()
    vi.useRealTimers()
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
  }

  it('a run-summary that finishes a run prunes; an old run opened keeps its snapshot until it is closed', async () => {
    mock = installMockDimFactory({
      handlers: {
        'runs.get': (q) => makeSnapshot({ runId: q.runId, status: 'completed', createdAt: 1_000 }, 7),
      },
    })
    startBridge()
    await settle()
    finishedRuns()
    applySnapshot(makeSnapshot({ runId: 'last', status: 'running', createdAt: 9_000 }, 2))
    expect(snapshotIds()).toHaveLength(N + 1)

    // ---- the newest run finishes: only the newest finished runs keep their snapshots ----
    mock.push({
      kind: 'run-summary',
      summary: makeSummary({ runId: 'last', status: 'completed', createdAt: 9_000 }),
    })
    await settle()
    expect(snapshotIds()).toEqual(['last', ...ids(N - FINISHED_SNAPSHOTS_KEPT + 1, N)].sort())

    // ---- an old finished run opened in a Run view: focused, its snapshot loads and stays ----
    const release = focusRun('r0')
    await settle()
    expect(mock.callsOf('runs.get')).toContainEqual({ runId: 'r0' })
    expect(useStore.getState().runs.byId['r0']?.status).toBe('ready')
    mock.push({
      kind: 'run-summary',
      summary: makeSummary({ runId: 'r5', status: 'completed', createdAt: 1_005 }),
    })
    await settle()
    expect(useStore.getState().runs.byId['r0']?.snapshot).not.toBeNull()

    // ---- the view closes: the next focus sync drops it; its summary stays ----
    release()
    await settle()
    expect(useStore.getState().runs.byId['r0']).toBeUndefined()
    expect(useStore.getState().summaries.byId['r0']?.status).toBe('completed')
  })
})
