// Runs history rows ("Row actions: Open · Re-run with same config · Re-run from Fix
// (session rules; tooltip says fresh/why) · Open diff · Reveal folder · Pin / Remove (undo)"; UI copy and control
// standards": a removed row leaves an undo row in place). Each action's core call, the disabled reasons, the Pin
// toggle, Remove → the row in place → Undo (from the row or the toast), and Re-run from Fix's picker under the row.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSnapshot, RunSummary } from '@shared/run.ts'
import { RERUN_WAIT_REASON } from '@renderer/components/run/rerun.ts'
import { resetFixPickersForTests } from '@renderer/components/run/rerun.ts'
import { ISOLATED_NOT_APPLIED } from '@renderer/components/run/isolation.ts'
import { resetRemovalsForTests } from '@renderer/pages/runs/removals.ts'
import {
  ACTIVE_REMOVE_REASON,
  LOCKED_REMOVE_REASON,
  PINNED_REMOVE_REASON,
} from '@renderer/pages/runs/RunRow.tsx'
import { RunsPage } from '@renderer/pages/runs/RunsPage.tsx'
import { useStore } from '@renderer/state/store.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { endedSnap, endedSummary, finding, FINDINGS, findingsFile, FRESH_FIX, listOver } from './fixtures.ts'

let mock: MockDimFactory
let runs: RunSummary[]
let snaps: Record<string, RunSnapshot>

const T0 = new Date(2026, 9, 6, 14, 0, 0).getTime()

beforeEach(() => {
  runs = [
    endedSummary({ runId: 'done', displayNo: 7, title: 'Add a --version flag', createdAt: T0, auto: true }),
    makeSummary({ runId: 'live', displayNo: 8, title: 'Live one', createdAt: T0 - 1000, status: 'running' }),
    endedSummary({
      runId: 'iso',
      displayNo: 6,
      title: 'Isolated one',
      createdAt: T0 - 2000,
      isolation: 'worktree',
      worktree: { state: 'kept', notApplied: true },
    }),
    endedSummary({
      runId: 'stuck',
      displayNo: 5,
      title: 'Failed and holding',
      createdAt: T0 - 3000,
      status: 'failed',
      lock: 'held',
      failure: { step: 'implement', category: 'auth_expired' },
    }),
    endedSummary({ runId: 'pinned', displayNo: 4, title: 'Pinned one', createdAt: T0 - 4000, pinned: true }),
    endedSummary({
      runId: 'again',
      displayNo: 9,
      title: 'Second try',
      createdAt: T0 - 5000,
      isolation: 'worktree',
      rerunOf: { runId: 'done', displayNo: 7, from: 'fix' },
    }),
  ]
  snaps = { done: endedSnap({ runId: 'done', displayNo: 7 }, FRESH_FIX) }
  mock = setUp({
    handlers: {
      'runs.list': (q) => listOver(runs)(q),
      'runs.get': ({ runId }) => {
        const s = snaps[runId]
        if (s === undefined) throw mockError('NOT_FOUND', `Run ${runId} not found.`)
        return s
      },
      'runs.rerun': () => ({ runId: 'new-run', displayNo: 10 }),
      'runs.pin': ({ runId, pinned }) => {
        const s = snaps[runId]
        if (s !== undefined)
          snaps[runId] = { ...s, summary: { ...s.summary, pinned }, lastSeq: s.lastSeq + 1 }
      },
      'runs.remove': ({ runIds }) => ({ undoToken: 'undo-1', removed: runIds }),
      'runs.undoRemove': () => undefined,
      'runs.output': () => ({ text: findingsFile(), mtime: 1, version: 1 }),
      'shell.open': () => undefined,
      'stats.get': () => {
        throw mockError('UNSUPPORTED', 'no stats')
      },
      'folders.recent': () => [],
    },
  })
})

afterEach(() => {
  resetRemovalsForTests()
  resetFixPickersForTests()
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

const row = (id: string): HTMLElement => screen.getByTestId(`runs-row-${id}`)

async function openMenu(id: string): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(screen.getByTestId(`runs-menu-${id}`), {
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

describe('a row', () => {
  it('shows core’s outcome, folder, age, duration and cost, and the AUTO and isolated chips', async () => {
    await mount()
    expect(screen.getByTestId('runs-outcome-done').textContent).toBe('Fixed · 2 must · 2 should')
    expect(screen.getByTestId('runs-meta-done').textContent).toBe(
      'Fixed · 2 must · 2 should · repo · 1 h ago · 4m 12s · $0.62',
    )
    expect(within(row('done')).getByTestId('runs-auto-done').textContent).toBe('AUTO')
    expect(within(row('iso')).getByTestId('isolated-chip-iso').textContent).toBe(ISOLATED_NOT_APPLIED)
    expect(within(row('again')).getByTestId('runs-isolated-again').textContent).toBe('Isolated')
    expect(within(row('live')).queryByText('AUTO')).toBeNull()
    expect(screen.getByTestId('runs-outcome-live').textContent).toBe('Implementing')
    expect(screen.getByTestId('runs-meta-again').textContent).toContain('Re-run from Fix of #7 · repo')
    // Cut to fit, so its tooltip says it whole, with the folder's full path.
    expect(screen.getByTestId('runs-meta-done').getAttribute('title')).toBe(
      'Fixed · 2 must · 2 should · repo · 1 h ago · 4m 12s · $0.62\nC:\\work\\repo',
    )
  })
})

describe('the actions menu', () => {
  it('Open, Open diff and Reveal folder', async () => {
    await mount()
    await openMenu('done')
    await click(screen.getByTestId('runs-action-open'))
    expect(window.location.hash).toBe('#/runs/done')
    await openMenu('done')
    await click(screen.getByTestId('runs-action-diff'))
    expect(window.location.hash).toBe('#/runs/done/diff')
    await openMenu('done')
    await click(screen.getByTestId('runs-action-reveal'))
    expect(mock.callsOf('shell.open')).toEqual([{ target: 'folder', path: 'C:\\work\\repo' }])
  })

  it('Re-run with same config: runs.rerun from the start, then the new run', async () => {
    await mount()
    await openMenu('done')
    const item = screen.getByTestId('runs-action-rerun')
    expect(item.getAttribute('data-disabled')).toBeNull()
    await click(item)
    expect(mock.callsOf('runs.rerun')).toEqual([{ runId: 'done', from: 'start' }])
    expect(window.location.hash).toBe('#/runs/new-run')
  })

  it('Re-run with same config waits while the run goes on, with the reason', async () => {
    await mount()
    await openMenu('live')
    const item = screen.getByTestId('runs-action-rerun')
    expect(item.getAttribute('data-disabled')).toBe('')
    expect(item.textContent).toContain(RERUN_WAIT_REASON)
  })

  it('a refused re-run is a toast with core’s words, and nothing opens', async () => {
    mock.on('runs.rerun', () => {
      throw mockError('PREFLIGHT_BLOCKED', 'The folder is not trusted for this command.')
    })
    await mount()
    await openMenu('done')
    await click(screen.getByTestId('runs-action-rerun'))
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain(
      'The folder is not trusted for this command.',
    )
    expect(window.location.hash).toBe('')
  })

  it('Re-run from Fix reads core’s facts when the menu opens: Checking…, then fresh and why', async () => {
    const held = deferred<RunSnapshot>()
    mock.on('runs.get', () => held.promise)
    await mount()
    expect(mock.callsOf('runs.get')).toEqual([])
    await openMenu('done')
    expect(mock.callsOf('runs.get')).toEqual([{ runId: 'done' }])
    const item = screen.getByTestId('runs-action-rerun-fix')
    expect(item.getAttribute('data-disabled')).toBe('')
    expect(within(item).getByTestId('runs-action-rerun-fix-text').textContent).toBe('Checking…')
    await act(async () => {
      held.resolve(snaps['done'] as RunSnapshot)
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(item.getAttribute('data-disabled')).toBeNull()
    expect(within(item).getByTestId('runs-action-rerun-fix-text').textContent).toBe(
      'Fix would start a fresh session: Fix vendor differs',
    )
    // The tooltip says it whole: fresh, and why.
    expect(item.getAttribute('title')).toBe(
      'Fix would start a fresh session: Fix vendor differs. ' +
        'Fix runs on Codex, Implement ran on Claude; a session cannot move between vendors.',
    )
  })

  it('Re-run from Fix from the summary’s facts when core sends them there: nothing to read first', async () => {
    runs = runs.map((s) => (s.runId === 'done' ? { ...s, rerunFromFix: FRESH_FIX } : s))
    await mount()
    await openMenu('done')
    expect(mock.callsOf('runs.get')).toEqual([])
    const item = screen.getByTestId('runs-action-rerun-fix')
    expect(item.getAttribute('data-disabled')).toBeNull()
    // The Why names the vendors from the summary's steps.
    expect(item.getAttribute('title')).toBe(
      'Fix would start a fresh session: Fix vendor differs. ' +
        'Fix runs on Codex, Implement ran on Claude; a session cannot move between vendors.',
    )
  })

  it('Re-run from Fix not available: disabled with core’s reason', async () => {
    snaps['iso'] = endedSnap(
      { runId: 'iso', displayNo: 6, isolation: 'worktree' },
      { available: false, fresh: true, unavailable: 'The run has no changes to fix.' },
    )
    await mount()
    await openMenu('iso')
    const item = screen.getByTestId('runs-action-rerun-fix')
    expect(item.getAttribute('data-disabled')).toBe('')
    expect(item.textContent).toContain('The run has no changes to fix')
    expect(item.getAttribute('title')).toBe('The run has no changes to fix')
  })

  it('Re-run from Fix from a core that sends no reason: the rule its facts break', async () => {
    snaps['live'] = endedSnap(
      { runId: 'live', displayNo: 8, status: 'running', phase: 'implementing' },
      { available: false, fresh: true },
    )
    snaps['iso'] = endedSnap(
      { runId: 'iso', displayNo: 6, findings: { must: 0, should: 0 } },
      { available: false, fresh: true },
    )
    await mount()
    await openMenu('live')
    expect(screen.getByTestId('runs-action-rerun-fix').textContent).toContain(RERUN_WAIT_REASON)
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    })
    await openMenu('iso')
    expect(screen.getByTestId('runs-action-rerun-fix').textContent).toContain(
      'The run has no findings for Fix to work on',
    )
  })
})

describe('Re-run from Fix under the row', () => {
  it('reads the findings, opens the picker under its row, and sends the ticked ones', async () => {
    snaps['done'] = endedSnap(
      { runId: 'done', displayNo: 7 },
      { ...FRESH_FIX, findingIds: ['f1', 'f2', 'f3'] },
    )
    await mount()
    await openMenu('done')
    await settle()
    await click(screen.getByTestId('runs-action-rerun-fix'))
    expect(mock.callsOf('runs.output')).toEqual([{ runId: 'done', file: 'findings' }])
    const picker = within(row('done')).getByTestId('runs-fix-picker-done')
    // It takes the focus (not handed back to the menu's button), and it is no dialog.
    expect(document.activeElement).toBe(picker)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Core's default: every must, and the should chosen at the gate.
    const ticked = within(picker)
      .getAllByRole('checkbox')
      .map((c) => c.getAttribute('aria-checked'))
    expect(ticked).toEqual(['true', 'true', 'true', 'false'])
    expect(within(picker).getByTestId('fix-picker-receives').textContent).toBe(
      'Fix will receive 2 must · 1 should',
    )
    expect(within(picker).getByTestId('fix-picker-session').textContent).toBe(
      'Fix would start a fresh session: Fix vendor differs. ' +
        'Fix runs on Codex, Implement ran on Claude; a session cannot move between vendors.',
    )
    // Untick F2 (a must).
    const f2 = within(picker).getByTestId(`runs-fix-done-${FINDINGS[1]?.id ?? ''}`)
    await click(within(f2).getByRole('checkbox'))
    expect(within(picker).getByTestId('fix-picker-receives').textContent).toBe(
      'Fix will receive 1 must · 1 should',
    )
    await click(within(picker).getByTestId('fix-picker-start'))
    expect(mock.callsOf('runs.rerun')).toEqual([{ runId: 'done', from: 'fix', findingIds: ['f1', 'f3'] }])
    expect(window.location.hash).toBe('#/runs/new-run')
  })

  it('Cancel closes it', async () => {
    await mount()
    await openMenu('done')
    await settle()
    await click(screen.getByTestId('runs-action-rerun-fix'))
    await click(screen.getByTestId('fix-picker-cancel'))
    expect(screen.queryByTestId('runs-fix-picker-done')).toBeNull()
    expect(mock.callsOf('runs.rerun')).toEqual([])
  })

  it('a run with no findings file (its join never ran) opens the picker with core’s findings', async () => {
    const carried = [finding(1, 'must', 'Null check missing', 'm1'), finding(2, 'should', 'Rename it', 's1')]
    snaps['done'] = endedSnap(
      { runId: 'done', displayNo: 7, status: 'cancelled', phase: 'done' },
      { available: true, fresh: false, findingIds: ['m1', 's1'], findings: carried },
    )
    mock.on('runs.output', () => {
      throw mockError('NOT_FOUND', 'Run done has no findings yet.')
    })
    await mount()
    await openMenu('done')
    await settle()
    await click(screen.getByTestId('runs-action-rerun-fix'))
    const picker = within(row('done')).getByTestId('runs-fix-picker-done')
    expect(within(picker).getAllByRole('checkbox')).toHaveLength(2)
    expect(mock.callsOf('runs.output')).toEqual([])
    await click(within(picker).getByTestId('fix-picker-start'))
    expect(mock.callsOf('runs.rerun')).toEqual([{ runId: 'done', from: 'fix', findingIds: ['m1', 's1'] }])
  })

  it('a findings file core cannot give is a toast, and no picker', async () => {
    mock.on('runs.output', () => {
      throw mockError('NOT_FOUND', 'The run has no findings file.')
    })
    await mount()
    await openMenu('done')
    await settle()
    await click(screen.getByTestId('runs-action-rerun-fix'))
    expect(screen.queryByTestId('runs-fix-picker-done')).toBeNull()
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain('The run has no findings file.')
  })
})

describe('Pin', () => {
  it('toggles through runs.pin and shows core’s answer', async () => {
    await mount()
    const pin = within(row('done')).getByRole('button', { name: 'Pin' })
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    await click(pin)
    expect(mock.callsOf('runs.pin')).toEqual([{ runId: 'done', pinned: true }])
    expect(within(row('done')).getByRole('button', { name: 'Pin' }).getAttribute('aria-pressed')).toBe('true')
    expect(row('done').dataset['pinned']).toBe('true')
    await click(within(row('done')).getByRole('button', { name: 'Pin' }))
    expect(mock.callsOf('runs.pin').at(-1)).toEqual({ runId: 'done', pinned: false })
    expect(within(row('done')).getByRole('button', { name: 'Pin' }).getAttribute('aria-pressed')).toBe(
      'false',
    )
  })
})

describe('Remove', () => {
  it('leaves a row in its place with Undo, and an Undo toast; Undo brings the run back where it was', async () => {
    await mount()
    const ids = (): string[] =>
      within(screen.getByTestId('runs-list'))
        .getAllByRole('listitem')
        .map((r) => r.dataset['testid'] ?? '')
    const before = ids()
    await click(within(row('done')).getByRole('button', { name: 'Remove' }))
    expect(mock.callsOf('runs.remove')).toEqual([{ runIds: ['done'] }])
    // The same place in the list, now the removed run's row.
    expect(ids()).toEqual(before)
    expect(row('done').dataset['removed']).toBe('removed')
    expect(within(row('done')).getByTestId('runs-removed-done').textContent).toBe(
      'Removed from the history. Undo brings it back.',
    )
    expect(useStore.getState().summaries.byId['done']).toBeUndefined()
    const t = useStore.getState().toasts.items.find((x) => x.id === 'removed:done')
    expect(t?.message).toBe('Run #7 removed')
    expect(t?.action?.label).toBe('Undo')

    await click(within(row('done')).getByTestId('runs-undo-done'))
    expect(mock.callsOf('runs.undoRemove')).toEqual([{ undoToken: 'undo-1' }])
    expect(row('done').dataset['removed']).toBeUndefined()
    expect(row('done').dataset['status']).toBe('completed')
    expect(ids()).toEqual(before)
    expect(useStore.getState().toasts.items.find((x) => x.id === 'removed:done')).toBeUndefined()
    expect(useStore.getState().summaries.byId['done']?.runId).toBe('done')
  })

  it('Undo from the toast does the same', async () => {
    await mount()
    await click(within(row('done')).getByRole('button', { name: 'Remove' }))
    const toaster = screen.getByTestId('toaster')
    await click(within(toaster).getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('runs.undoRemove')).toEqual([{ undoToken: 'undo-1' }])
    expect(row('done').dataset['removed']).toBeUndefined()
  })

  it('an Undo core refuses leaves the row saying why', async () => {
    mock.on('runs.undoRemove', () => {
      throw mockError('NOT_FOUND', 'Run #7 was already deleted.')
    })
    await mount()
    await click(within(row('done')).getByRole('button', { name: 'Remove' }))
    await click(within(row('done')).getByTestId('runs-undo-done'))
    expect(row('done').dataset['removed']).toBe('gone')
    expect(within(row('done')).getByTestId('runs-removed-done').textContent).toBe(
      'Removed for good: Run #7 was already deleted.',
    )
    expect(within(row('done')).getByTestId<HTMLButtonElement>('runs-undo-done').disabled).toBe(true)
  })

  it.each([
    ['pinned', PINNED_REMOVE_REASON],
    ['live', ACTIVE_REMOVE_REASON],
    ['stuck', LOCKED_REMOVE_REASON],
  ])('is disabled for the %s run, with the reason', async (id, reason) => {
    await mount()
    const remove = within(row(id)).getByTestId<HTMLButtonElement>(`runs-remove-${id}`)
    expect(remove.disabled).toBe(true)
    expect(within(row(id)).getByText(reason)).toBeTruthy()
    expect(mock.callsOf('runs.remove')).toEqual([])
  })
})
