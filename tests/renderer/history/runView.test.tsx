// Re-runs in the Run view (RunHeader "[Re-run ▾]", "After the run", Stop toast; Sessions
// "Re-run from Fix … the tooltip says whether the run will start fresh, and why"; state-machine row R14): the header's
// Re-run ▾ (Re-run with same config, Re-run from Fix with core's facts or reason), the findings picker at the end of
// the Flow tab, "After the run"'s [Re-run] [Re-run from Fix], and the Stop toast's Re-run from Fix.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSnapshot } from '@shared/run.ts'
import { RunHeader, rerunTooltip } from '@renderer/components/run/RunHeader.tsx'
import { RUN_AGAIN_TEXT } from '@renderer/components/run/RunEndPanel.tsx'
import { RERUN_WAIT_REASON, closeFixPicker, resetFixPickersForTests } from '@renderer/components/run/rerun.ts'
import { resetStopWatches, STOPPED_MESSAGE, watchStop } from '@renderer/components/run/stop.ts'
import { FlowTab } from '@renderer/pages/run/FlowTab.tsx'
import { applySnapshot, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { toast } from '@renderer/state/toasts.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { endedSnap, finding, findingsFile, FRESH_FIX, REUSE_FIX } from './fixtures.ts'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({
    handlers: {
      'runs.rerun': () => ({ runId: 'next', displayNo: 12 }),
      'runs.output': () => ({ text: findingsFile(), mtime: 1, version: 1 }),
      'runs.get': () => {
        throw mockError('NOT_FOUND', 'not loaded here')
      },
    },
  })
})

afterEach(() => {
  resetStopWatches()
  resetFixPickersForTests()
  tearDown(mock)
})

const RUN = 'src'

/** The header above the Flow tab, as the Run view lays them out. */
function view(snap: RunSnapshot): void {
  render(
    <Providers>
      <RunHeader snap={snap} onStop={() => undefined} stopping={false} />
      <FlowTab snap={snap} />
    </Providers>,
  )
}

async function openMenu(): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(screen.getByTestId('rerun-menu'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

describe('the header’s Re-run ▾', () => {
  it('Re-run with same config: runs.rerun from the start, then the new run', async () => {
    view(endedSnap({ runId: RUN }))
    await openMenu()
    const item = screen.getByTestId('rerun-start')
    expect(item.getAttribute('data-disabled')).toBeNull()
    expect(item.textContent).toContain('Re-run with same config')
    await click(item)
    expect(mock.callsOf('runs.rerun')).toEqual([{ runId: RUN, from: 'start' }])
    expect(window.location.hash).toBe('#/runs/next')
  })

  it('while the run goes on, both wait with their reasons', async () => {
    view(
      endedSnap(
        { runId: RUN, status: 'running', phase: 'implementing' },
        { available: false, fresh: true, unavailable: 'Available once the run has ended.' },
      ),
    )
    await openMenu()
    const start = screen.getByTestId('rerun-start')
    expect(start.getAttribute('data-disabled')).toBe('')
    expect(start.textContent).toContain(RERUN_WAIT_REASON)
    const fix = screen.getByTestId('rerun-from-fix')
    expect(fix.getAttribute('data-disabled')).toBe('')
    expect(fix.textContent).toContain('Available once the run has ended')
    expect(screen.queryByTestId('rerun-from-fix-why')).toBeNull()
  })

  it.each([
    [REUSE_FIX, 'Fix would continue the Implement session.'],
    [
      FRESH_FIX,
      'Fix would start a fresh session: Fix vendor differs. ' +
        'Fix runs on Codex, Implement ran on Claude; a session cannot move between vendors.',
    ],
    [
      { available: false, fresh: true, unavailable: 'The run made no changes.' },
      'Re-run from Fix is not available: The run made no changes.',
    ],
  ])('its tooltip says fresh or why (%o)', async (facts, tip) => {
    const snap = endedSnap({ runId: RUN }, facts)
    expect(rerunTooltip(snap)).toBe(tip)
    view(snap)
    fireEvent.focus(screen.getByTestId('rerun-menu'))
    await settle(400)
    expect(screen.getByRole('tooltip').textContent).toBe(tip)
  })

  it('Re-run from Fix opens the findings picker last in the Flow tab, focused, and starts from it', async () => {
    window.location.hash = `#/runs/${RUN}/diff`
    view(endedSnap({ runId: RUN }, FRESH_FIX))
    await openMenu()
    const item = screen.getByTestId('rerun-from-fix')
    expect(item.getAttribute('data-disabled')).toBeNull()
    expect(within(item).getByTestId('rerun-from-fix-why').textContent).toBe(
      'Fix runs on Codex, Implement ran on Claude; a session cannot move between vendors.',
    )
    await click(item)
    expect(window.location.hash).toBe(`#/runs/${RUN}`)
    expect(mock.callsOf('runs.output')).toEqual([{ runId: RUN, file: 'findings' }])
    const flow = screen.getByTestId('flow-tab')
    const picker = screen.getByTestId(`fix-picker-${RUN}`)
    // Last in the flow, after "After the run".
    expect(flow.lastElementChild).toBe(picker)
    expect(
      screen.getByTestId('run-end').compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(document.activeElement).toBe(picker)
    expect(screen.queryByRole('dialog')).toBeNull()
    await click(within(picker).getByTestId('fix-picker-start'))
    expect(mock.callsOf('runs.rerun')).toEqual([
      { runId: RUN, from: 'fix', findingIds: ['f1', 'f2', 'f3', 'f4'] },
    ])
    expect(window.location.hash).toBe('#/runs/next')
    expect(screen.queryByTestId(`fix-picker-${RUN}`)).toBeNull()
  })

  it('a failed run (still holding its folder) offers it too, and says it is stopped first', async () => {
    view(
      endedSnap(
        {
          runId: RUN,
          status: 'failed',
          phase: 'needs-attention',
          lock: 'held',
          failure: { step: 'fix', category: 'auth_expired' },
        },
        REUSE_FIX,
      ),
    )
    await openMenu()
    expect(screen.getByTestId('rerun-start').getAttribute('data-disabled')).toBeNull()
    await click(screen.getByTestId('rerun-from-fix'))
    const picker = screen.getByTestId(`fix-picker-${RUN}`)
    expect(within(picker).getByTestId('fix-picker-stops-source').textContent).toBe(
      'Run #7 still holds its folder, so it is stopped when the new run starts.',
    )
    expect(screen.queryByTestId('run-end')).toBeNull()
    act(() => closeFixPicker(RUN))
    expect(screen.queryByTestId(`fix-picker-${RUN}`)).toBeNull()
  })
})

describe('a run whose Review/Critic join never ran (no findings.json)', () => {
  // Stopped while Critic ran, after Review reported: core offers Re-run from Fix with Review's findings in the snapshot
  // (RerunFromFix.findings, with the ids runs.rerun takes); runs.output has no findings file to give.
  const carried = [finding(1, 'must', 'Null check missing', 'm1'), finding(2, 'should', 'Rename it', 's1')]
  const facts = { available: true, fresh: false, findingIds: ['m1', 's1'], findings: carried }
  const stoppedAtReview = (): RunSnapshot =>
    endedSnap({ runId: RUN, status: 'cancelled', phase: 'done' }, facts)

  beforeEach(() => {
    mock.on('runs.get', () => stoppedAtReview())
    mock.on('runs.output', () => {
      throw mockError('NOT_FOUND', `Run ${RUN} has no findings yet.`)
    })
  })

  it('the header’s Re-run from Fix opens the picker with core’s findings and starts from it', async () => {
    view(stoppedAtReview())
    await openMenu()
    await click(screen.getByTestId('rerun-from-fix'))
    const picker = screen.getByTestId(`fix-picker-${RUN}`)
    expect(within(picker).getAllByRole('checkbox')).toHaveLength(2)
    expect(within(picker).getByTestId('fix-picker-receives').textContent).toBe(
      'Fix will receive 1 must · 1 should',
    )
    expect(mock.callsOf('runs.output')).toEqual([])
    expect(useStore.getState().toasts.items).toEqual([])
    await click(within(picker).getByTestId('fix-picker-start'))
    expect(mock.callsOf('runs.rerun')).toEqual([{ runId: RUN, from: 'fix', findingIds: ['m1', 's1'] }])
  })

  it('the Stop toast’s Re-run from Fix opens the picker too', async () => {
    view(stoppedAtReview())
    act(() => {
      applySnapshot(stoppedAtReview())
      upsertSummaries([stoppedAtReview().summary])
      watchStop(RUN)
    })
    const card = screen
      .getByTestId('toaster')
      .querySelector(`[data-toast-card="stopped:${RUN}"]`) as HTMLElement
    await click(within(card).getByRole('button', { name: 'Re-run from Fix' }))
    const picker = screen.getByTestId(`fix-picker-${RUN}`)
    expect(within(picker).getAllByRole('checkbox')).toHaveLength(2)
    expect(useStore.getState().toasts.items.map((t) => t.level)).not.toContain('error')
  })
})

describe('After the run', () => {
  it('[Re-run] and [Re-run from Fix], the latter opening the picker after the panel', async () => {
    view(endedSnap({ runId: RUN }, FRESH_FIX))
    const again = screen.getByTestId('run-end-rerun')
    expect(again.textContent).toContain(RUN_AGAIN_TEXT)
    await click(within(again).getByTestId('run-end-rerun-fix'))
    expect(screen.getByTestId('flow-tab').lastElementChild).toBe(screen.getByTestId(`fix-picker-${RUN}`))
    // Pressed again while open: nothing read again, the picker brought back into view.
    await click(within(again).getByTestId('run-end-rerun-fix'))
    expect(mock.callsOf('runs.output')).toHaveLength(1)
    await click(within(again).getByTestId('run-end-rerun-start'))
    expect(mock.callsOf('runs.rerun')).toEqual([{ runId: RUN, from: 'start' }])
  })

  it('Re-run from Fix disabled with core’s reason when not available', () => {
    view(
      endedSnap({ runId: RUN }, { available: false, fresh: true, unavailable: 'The run has no findings.' }),
    )
    const fix = screen.getByTestId<HTMLButtonElement>('run-end-rerun-fix')
    expect(fix.disabled).toBe(true)
    expect(within(screen.getByTestId('run-end-rerun')).getByText('The run has no findings')).toBeTruthy()
  })
})

describe('the Stop toast', () => {
  function stopped(snap: RunSnapshot): void {
    act(() => {
      applySnapshot(snap)
      upsertSummaries([snap.summary])
      watchStop(snap.summary.runId)
    })
  }

  it('offers Re-run from Fix beside Revert all while core says it is available', async () => {
    render(<Providers>{null}</Providers>)
    stopped(endedSnap({ runId: RUN, status: 'cancelled', phase: 'done' }, REUSE_FIX))
    const t = useStore.getState().toasts.items.find((x) => x.id === `stopped:${RUN}`)
    expect(t?.message).toBe(STOPPED_MESSAGE)
    expect(t?.action?.label).toBe('Revert all')
    expect(t?.secondary?.label).toBe('Re-run from Fix')
    const card = screen
      .getByTestId('toaster')
      .querySelector(`[data-toast-card="stopped:${RUN}"]`) as HTMLElement
    const buttons = within(card)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(buttons).toEqual(['Revert all', 'Re-run from Fix', ''])
    await click(within(card).getByRole('button', { name: 'Re-run from Fix' }))
    expect(window.location.hash).toBe(`#/runs/${RUN}`)
    expect(mock.callsOf('runs.output')).toEqual([{ runId: RUN, file: 'findings' }])
    expect(useStore.getState().toasts.items.find((x) => x.id === `stopped:${RUN}`)).toBeUndefined()
  })

  it('leaves it out when core says it is not available', () => {
    render(<Providers>{null}</Providers>)
    stopped(endedSnap({ runId: RUN, status: 'cancelled', phase: 'done' }, { available: false, fresh: true }))
    const t = useStore.getState().toasts.items.find((x) => x.id === `stopped:${RUN}`)
    expect(t?.action?.label).toBe('Revert all')
    expect(t?.secondary).toBeUndefined()
  })

  it('a toast with one action keeps it beside the message', () => {
    render(<Providers>{null}</Providers>)
    act(() => {
      toast({
        id: 'one',
        level: 'info',
        message: 'Done',
        action: { label: 'Undo', onClick: () => undefined },
      })
    })
    const card = screen.getByTestId('toaster').querySelector('[data-toast-card="one"]') as HTMLElement
    expect(card.querySelector('p')?.parentElement).toBe(card)
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Undo', ''])
  })
})
