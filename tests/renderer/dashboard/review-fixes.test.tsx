// Review fixes on the Dashboard and in shared UI: Queue ("Folder busy") reads core's folderKey
// and lock-holding statuses (failed included), the active card's Stop toasts like the Run view's, disabled controls
// are announced with their own label and the reason, and the page refuses file drops.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { Button } from '@renderer/components/ui/Button.tsx'
import { DisabledHint } from '@renderer/components/ui/DisabledHint.tsx'
import { installDropGuard } from '@renderer/lib/dropGuard.ts'
import { DashboardPage } from '@renderer/pages/dashboard/DashboardPage.tsx'
import { QuickComposer } from '@renderer/pages/dashboard/QuickComposer.tsx'
import { holdsFolderLock, wouldQueue } from '@renderer/pages/dashboard/composer-model.ts'
import { upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, resolvedView, settle, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory
let resolved: ResolvedWithProvenance

beforeEach(() => {
  resolved = resolvedView()
  mock = setUp({
    handlers: {
      'config.resolve': () => resolved,
      'runs.stop': () => undefined,
      'runs.get': () => {
        throw new Error('not needed')
      },
    },
  })
})

afterEach(() => {
  resetStopWatches()
  tearDown(mock)
})

describe('wouldQueue', () => {
  const run = (o: Parameters<typeof makeSummary>[0]) => makeSummary(o)

  it('a run holding the lock of the same scope root (core folderKey) queues a sibling sub-folder', () => {
    const a = run({ runId: 'a', status: 'running', folder: 'C:\\repo\\a', folderKey: 'k1' })
    expect(wouldQueue('C:\\repo\\b', 'k1', [a], 'win32')).toBe(true)
    expect(wouldQueue('C:\\repo\\b', 'k2', [a], 'win32')).toBe(false)
    // Without core's key (not resolved yet), nested paths still count.
    expect(wouldQueue('C:\\repo\\a\\src', null, [a], 'win32')).toBe(true)
    expect(wouldQueue('C:\\repo\\b', null, [a], 'win32')).toBe(false)
  })

  it('a failed run keeps its lock, except after a failed preflight; finished runs hold nothing', () => {
    const failed = run({ runId: 'f', status: 'failed', folderKey: 'k1' })
    const preflight = run({
      runId: 'p',
      status: 'failed',
      folderKey: 'k1',
      failure: { step: 'preflight', category: 'auth_required' },
    })
    expect(holdsFolderLock(failed)).toBe(true)
    expect(holdsFolderLock(preflight)).toBe(false)
    for (const status of ['queued', 'running', 'waiting', 'paused'] as const)
      expect(holdsFolderLock(run({ runId: 'x', status }))).toBe(true)
    for (const status of ['completed', 'cancelled'] as const)
      expect(holdsFolderLock(run({ runId: 'x', status }))).toBe(false)
    expect(wouldQueue('D:\\other', 'k1', [failed], 'win32')).toBe(true)
    expect(wouldQueue('D:\\other', 'k1', [preflight], 'win32')).toBe(false)
  })
})

describe('QuickComposer: Queue (Folder busy)', () => {
  async function mount(): Promise<void> {
    render(
      <Providers>
        <QuickComposer />
      </Providers>,
    )
    await settle()
  }
  const runButton = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('composer-run')
  /** What Run reads: its constant label, then the state shown beside it (UI standard: the button never changes size). */
  const runReads = (): string => {
    const status = screen.getByTestId('composer-run-status').textContent ?? ''
    const label = runButton().textContent ?? ''
    return status === '' ? label : `${label} · ${status}`
  }
  async function fill(folder: string): Promise<void> {
    fireEvent.change(screen.getByTestId('composer-folder-input'), { target: { value: folder } })
    fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a flag' } })
    await settle(500)
  }

  it('labels a sibling sub-folder of a busy repo once core resolved its folderKey', async () => {
    resolved = { ...resolvedView(), scopeRoot: 'C:\\work\\repo', folderKey: 'repo-key' }
    upsertSummaries(
      [makeSummary({ runId: 'a', status: 'running', folder: 'C:\\work\\repo\\a', folderKey: 'repo-key' })],
      { loaded: true },
    )
    await mount()
    await fill('C:\\work\\repo\\b')
    expect(runReads()).toBe('Queue · Folder busy')
  })

  it('labels a folder whose failed run still holds the lock', async () => {
    resolved = { ...resolvedView(), scopeRoot: 'C:\\work\\repo', folderKey: 'repo-key' }
    upsertSummaries(
      [makeSummary({ runId: 'f', status: 'failed', folder: 'C:\\work\\repo', folderKey: 'repo-key' })],
      {
        loaded: true,
      },
    )
    await mount()
    await fill('C:\\work\\repo')
    expect(runReads()).toBe('Queue · Folder busy')
  })
})

describe('Dashboard active card Stop', () => {
  it('stops through the same path as the Run view: "Run stopped · changes kept" once cancelled', async () => {
    const running = makeSummary({ runId: 'r1', status: 'running', createdAt: Date.now() - 60_000 })
    upsertSummaries([running], { loaded: true })
    render(
      <Providers>
        <DashboardPage />
      </Providers>,
    )
    await settle()
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('active-run-r1')).getByRole('button', { name: 'Stop' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: 'r1' }])
    const messages = (): string[] => useStore.getState().toasts.items.map((t) => t.message)
    expect(messages()).not.toContain('Run stopped · changes kept')
    act(() => upsertSummaries([{ ...running, status: 'cancelled', phase: 'done' }]))
    expect(messages()).toContain('Run stopped · changes kept')
  })
})

describe('DisabledHint', () => {
  it("is named by the control's own label and the reason, and is one tab stop", () => {
    render(
      <Providers>
        <DisabledHint>
          <Button disabled>Cancel all</Button>
        </DisabledHint>
        <DisabledHint reason="Pin and Remove are available in a later version">
          <span>
            <Button disabled>Pin</Button>
            <Button disabled>Remove</Button>
          </span>
        </DisabledHint>
      </Providers>,
    )
    const one = screen.getByRole('group', { name: 'Cancel all Available in a later version' })
    expect(one.tabIndex).toBe(0)
    expect(one.getAttribute('aria-label')).toBeNull()
    expect(
      screen.getByRole('group', { name: 'Pin Remove Pin and Remove are available in a later version' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel all' })).toHaveProperty('disabled', true)
  })
})

describe('drop guard', () => {
  it('refuses drags and drops on the page, so a dropped file never navigates it', () => {
    const remove = installDropGuard(document)
    try {
      const over = new Event('dragover', { cancelable: true })
      const dataTransfer = { dropEffect: 'copy' }
      Object.defineProperty(over, 'dataTransfer', { value: dataTransfer })
      document.dispatchEvent(over)
      expect(over.defaultPrevented).toBe(true)
      expect(dataTransfer.dropEffect).toBe('none')
      const drop = new Event('drop', { cancelable: true, bubbles: true })
      document.body.dispatchEvent(drop)
      expect(drop.defaultPrevented).toBe(true)
    } finally {
      remove()
    }
    const after = new Event('drop', { cancelable: true })
    document.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})
