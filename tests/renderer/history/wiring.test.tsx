// Integration fixes between core and the renderer ("Stop → cancelled. Toast: Run stopped ·
// changes kept [Revert all]", "user_cancelled: its only continuations are Re-run and Re-run from Fix", Sessions
// "Re-run from Fix", state-machine row R14):
//   - The Stop toast appears once core's summary says cancelled; the run's snapshot is refetched a moment later, so the
//     toast takes core's Re-run from Fix facts from that summary (RunSummary.rerunFromFix), not from a snapshot that
//     may still describe the run before the Stop (found by ui-standards.spec.ts' walk: the toast sometimes had no Re-run
//     from Fix).
//   - Core stops a source that still holds its folder for both forms of re-run (R14), so Re-run with same config says
//     so too (the findings picker already did for Re-run from Fix), in the Run view's Re-run ▾ and a Runs row's menu.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSnapshot } from '@shared/run.ts'
import { RunHeader } from '@renderer/components/run/RunHeader.tsx'
import {
  RERUN_HINT,
  RERUN_WAIT_REASON,
  rerunStartHint,
  resetFixPickersForTests,
} from '@renderer/components/run/rerun.ts'
import { resetStopWatches, watchStop } from '@renderer/components/run/stop.ts'
import { RunsPage } from '@renderer/pages/runs/RunsPage.tsx'
import { applySnapshot, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { endedSnap, endedSummary, listOver, REUSE_FIX } from './fixtures.ts'

let mock: MockDimFactory

const STOPS_FIRST = 'Run #7 still holds its folder, so it is stopped when the new run starts.'

beforeEach(() => {
  mock = setUp({})
})

afterEach(() => {
  resetStopWatches()
  resetFixPickersForTests()
  tearDown(mock)
})

const RUN = 'src'
const STILL_GOING = {
  available: false,
  fresh: true,
  unavailable: 'The run is still going. Re-run it once it has finished, failed, paused or stopped.',
}

/** The snapshot as the Run view last loaded it: the run waiting at its gate, before the Stop. */
function beforeStop(): RunSnapshot {
  const snap = endedSnap({ runId: RUN, status: 'waiting', phase: 'findings-review' }, STILL_GOING)
  const { endedAt: _endedAt, outcome: _outcome, ...summary } = snap.summary
  return { ...snap, summary: { ...summary, rerunFromFix: STILL_GOING } }
}

function stoppedToast() {
  return useStore.getState().toasts.items.find((x) => x.id === `stopped:${RUN}`)
}

describe('the Stop toast and core’s Re-run from Fix facts', () => {
  it('offers Re-run from Fix from the cancelled summary while the snapshot still shows the run before the Stop', () => {
    render(<Providers>{null}</Providers>)
    act(() => {
      applySnapshot(beforeStop())
      watchStop(RUN)
    })
    expect(stoppedToast()).toBeUndefined()
    // Core's push: the summary that says cancelled, with what Re-run from Fix of the run would do now.
    act(() => {
      upsertSummaries([
        endedSummary({ runId: RUN, status: 'cancelled', phase: 'done', rerunFromFix: REUSE_FIX }),
      ])
    })
    const t = stoppedToast()
    expect(t?.action?.label).toBe('Revert all')
    expect(t?.secondary?.label).toBe('Re-run from Fix')
  })

  it('leaves it out when the cancelled summary says it is not available, whatever the snapshot said', () => {
    render(<Providers>{null}</Providers>)
    const snap = endedSnap({ runId: RUN, status: 'waiting', phase: 'findings-review' }, REUSE_FIX)
    act(() => {
      applySnapshot(snap)
      watchStop(RUN)
    })
    act(() => {
      upsertSummaries([
        endedSummary({
          runId: RUN,
          status: 'cancelled',
          phase: 'done',
          rerunFromFix: {
            available: false,
            fresh: true,
            unavailable: 'Implement did not finish, so there are no changes for Fix to work on.',
          },
        }),
      ])
    })
    const t = stoppedToast()
    expect(t?.action?.label).toBe('Revert all')
    expect(t?.secondary).toBeUndefined()
  })
})

async function pointerOpen(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(screen.getByTestId(testId), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

const holding = {
  runId: RUN,
  status: 'failed' as const,
  phase: 'needs-attention' as const,
  lock: 'held' as const,
  failure: { step: 'fix' as const, category: 'auth_expired' as const },
}

describe('Re-run with same config says a source holding its folder is stopped first (R14, both forms)', () => {
  it('words it from core’s summary: why it waits, that the source is stopped, or what it does', () => {
    expect(rerunStartHint({ status: 'completed', displayNo: 7 })).toBe(RERUN_HINT)
    expect(rerunStartHint({ status: 'failed', displayNo: 7 })).toBe(RERUN_HINT)
    expect(rerunStartHint({ status: 'failed', lock: 'held', displayNo: 7 })).toBe(STOPS_FIRST)
    expect(rerunStartHint({ status: 'paused', lock: 'held', displayNo: 7 })).toBe(STOPS_FIRST)
    expect(rerunStartHint({ status: 'running', lock: 'held', displayNo: 7 })).toBe(RERUN_WAIT_REASON)
  })

  it('in the Run view’s Re-run ▾', async () => {
    render(
      <Providers>
        <RunHeader snap={endedSnap(holding, REUSE_FIX)} onStop={() => undefined} stopping={false} />
      </Providers>,
    )
    await pointerOpen('rerun-menu')
    expect(screen.getByTestId('rerun-start').getAttribute('data-disabled')).toBeNull()
    expect(screen.getByTestId('rerun-start-hint').textContent).toBe(STOPS_FIRST)
  })

  it('in a Runs row’s menu, whole in its title (the line is cut to fit)', async () => {
    const runs = [endedSummary({ ...holding, displayNo: 7, title: 'Failed and holding' })]
    mock.on('runs.list', (q) => listOver(runs)(q))
    mock.on('folders.recent', () => [])
    render(
      <Providers>
        <RunsPage />
      </Providers>,
    )
    await settle()
    await pointerOpen(`runs-menu-${RUN}`)
    const hint = screen.getByTestId('runs-action-rerun-text')
    expect(hint.textContent).toBe(STOPS_FIRST)
    expect(hint.getAttribute('title')).toBe(STOPS_FIRST)
  })
})
