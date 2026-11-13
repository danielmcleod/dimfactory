// pages/run/RunPage: focus while mounted, the header (status, phase, AUTO, Re-run with core's rerunFromFix facts,
// live), Stop (button and ⌘/Ctrl+.) → runs.stop → "Run stopped · changes kept" with Revert all once core says
// cancelled (stop.spec.ts), the timeline leaving out unused steps and showing Fix skipped with its reason (no-findings.spec.ts), tabs, the
// Diff and Log tabs, step announcements and the not-found state.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { RunPage } from '@renderer/pages/run/RunPage.tsx'
import { applySnapshot } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, runEvent, text } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from './helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]
let current: RunSnapshot
let release: (() => void) | null = null

const running = (): RunSnapshot =>
  snapWith({
    summary: {
      status: 'running',
      phase: 'implementing',
      auto: true,
      progress: { tokens: 1500, costUsd: null, filesChanged: 7 },
    },
    steps: {
      preflight: { status: 'done', attempt: 1, activeMs: 900 },
      prepare: { status: 'skipped', reason: 'in place' },
      'verify:0': { status: 'skipped', reason: 'in place' },
      plan: { status: 'done', attempt: 1, vendor: 'claude', activeMs: 40_000 },
      implement: { status: 'running', attempt: 1, vendor: 'claude', activeMs: 5000 },
      critic: { status: 'skipped', reason: 'disabled' },
    },
    lastSeq: 3,
    extra: { rerunFromFix: { available: true, fresh: true, reason: 'vendor-differs' } },
  })

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  setMacForTests(false)
  window.location.hash = ''
  log = [
    env(RUN, 1, { t: 'step-status', step: 'implement', attempt: 1, status: 'running' }),
    env(RUN, 2, text('implement', 'Working on it\n')),
    env(RUN, 3, {
      t: 'auto-answered',
      step: 'plan',
      attempt: 1,
      tool: 'Read',
      decision: 'allow',
      why: 'readonly',
    }),
  ]
  current = running()
  mock = installMockDimFactory({
    handlers: {
      'runs.get': () => current,
      'runs.events': eventsHandler(() => log),
      'runs.stop': () => undefined,
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'none')
      },
    },
  })
})

afterEach(() => {
  release?.()
  release = null
  resetStopWatches()
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  setMacForTests(null)
  resetBridgeForTests()
  window.location.hash = ''
})

async function mount(tab: 'flow' | 'diff' | 'log' | 'config' = 'flow'): Promise<void> {
  release = startBridge()
  renderUi(<RunPage runId={RUN} tab={tab} />)
  await act(async () => {
    await settle(10)
  })
  await waitFor(() => expect(screen.getByTestId('run-header')).toBeTruthy())
}

describe('RunPage', () => {
  it('focuses the run, loads it and shows the header', async () => {
    await mount()
    await waitFor(() => expect(mock.callsOf('events.focus').at(-1)).toEqual({ runIds: [RUN] }))
    expect(screen.getByTestId('run-status').textContent).toBe('Running')
    expect(screen.getByTestId('run-phase').textContent).toBe('Implementing')
    expect(screen.getByTestId('run-header').textContent).toContain('AUTO')
    expect(screen.getByTestId('run-tab-diff').textContent).toBe('Diff(7)')
    // The focus replay feeds the stream buffer, so the Implement stream shows the log's text.
    await waitFor(() => expect(screen.getByTestId('stream-implement').textContent).toContain('Working on it'))
  })

  it('leaves unused steps out of the timeline', async () => {
    await mount()
    const nodes = screen.getAllByTestId(/^timeline-node-/).map((n) => n.getAttribute('data-testid'))
    expect(nodes).toEqual([
      'timeline-node-preflight',
      'timeline-node-plan',
      'timeline-node-implement',
      'timeline-node-review',
      'timeline-node-fix',
    ])
    expect(screen.getByTestId('timeline-node-implement').getAttribute('data-status')).toBe('running')
    // Auto runs have no gates.
    expect(screen.queryByTestId('timeline-gate-afterPlan')).toBeNull()
  })

  it('shows Fix skipped with its reason in a clean run', async () => {
    current = snapWith({
      summary: { status: 'completed', phase: 'done', outcome: 'clean' },
      steps: {
        preflight: { status: 'done', attempt: 1 },
        plan: { status: 'done', attempt: 1 },
        implement: { status: 'done', attempt: 1 },
        review: { status: 'done', attempt: 1 },
        critic: { status: 'done', attempt: 1 },
        fix: { status: 'skipped', reason: 'no findings' },
      },
    })
    await mount()
    expect(screen.getByTestId('timeline-node-fix').textContent).toContain('Skipped')
    expect(screen.getByTestId('pass-reason-fix').textContent).toBe('Skipped · no findings to fix')
    expect(screen.getByTestId('run-outcome').textContent).toBe('Clean: no findings')
    expect(screen.queryByTestId('stop-run')).toBeNull()
    expect(screen.getByTestId('timeline-gate-beforeFix').getAttribute('data-open')).toBe('false')
  })

  it('stops the run and, once core says cancelled, offers Revert all', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('stop-run'))
      await settle()
    })
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: RUN }])
    expect(
      useStore.getState().toasts.items.find((t) => t.message === 'Run stopped · changes kept'),
    ).toBeUndefined()
    await act(async () => {
      mock.push({
        kind: 'run-summary',
        summary: { ...current.summary, status: 'cancelled', phase: 'done' },
      })
      await settle()
    })
    const t = useStore.getState().toasts.items.find((x) => x.message === 'Run stopped · changes kept')
    expect(t?.action?.label).toBe('Revert all')
    // Revert all is live (diff.revert; tests/renderer/run-branch/revertAll.test.tsx) once the run's process has gone.
    expect(t?.action?.disabledReason).toBeUndefined()
    expect(t?.action?.liveDisabledReason?.(useStore.getState())).toBeUndefined()
    // Re-run from Fix stays offered: live (core says it is available), with core's fresh reason.
    current = { ...current, summary: { ...current.summary, status: 'cancelled', phase: 'done' } }
    act(() => {
      applySnapshot({ ...current, lastSeq: 10 })
    })
    expect(screen.queryByTestId('stop-run')).toBeNull()
    fireEvent.pointerDown(screen.getByTestId('rerun-menu'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    const item = await screen.findByTestId('rerun-from-fix')
    expect(item.getAttribute('data-disabled')).toBeNull()
    expect(item.textContent).toContain('Fix would start a fresh session: Fix vendor differs')
  })

  it('stops with Ctrl+.', async () => {
    await mount()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, cancelable: true }))
      await settle()
    })
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: RUN }])
  })

  it('switches tabs through the route and opens the Diff tab with Ctrl+Shift+D', async () => {
    await mount()
    fireEvent.mouseDown(screen.getByTestId('run-tab-log'), { button: 0 })
    expect(window.location.hash).toBe('#/runs/run-1/log')
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'D', ctrlKey: true, shiftKey: true, cancelable: true }),
      )
    })
    expect(window.location.hash).toBe('#/runs/run-1/diff')
  })

  it("shows the Diff tab's file count and core's reason while the run has no diff yet", async () => {
    mock.on('diff.files', () => {
      throw mockError('NOT_FOUND', 'The run has not recorded any changes yet.')
    })
    await mount('diff')
    await waitFor(() =>
      expect(screen.getByTestId('diff-tab').textContent).toContain(
        'The run has not recorded any changes yet.',
      ),
    )
    expect(screen.getByTestId('diff-tab').textContent).toContain('7 files changed')
    expect(mock.callsOf('diff.files')).toEqual([{ runId: RUN, seg: 'combined' }])
  })

  it('shows the log with the AUTO count and a step filter', async () => {
    await mount('log')
    await waitFor(() => expect(screen.getByTestId('log-rows').querySelectorAll('[data-seq]')).toHaveLength(3))
    expect(screen.getByTestId('log-auto-approved').textContent).toBe('AUTO approved 1')
    fireEvent.change(screen.getByTestId('log-step-filter'), { target: { value: 'implement' } })
    expect(screen.getByTestId('log-rows').querySelectorAll('[data-seq]')).toHaveLength(2)
    await act(async () => {
      log.push(env(RUN, 4, text('implement', 'more\n')))
      mock.push(runEvent(log[3] as RunEnvelope))
      await settle()
    })
    expect(screen.getByTestId('log-rows').querySelectorAll('[data-seq]')).toHaveLength(3)
  })

  it('says the folder path and the log columns, cut to fit, in full as tooltips', async () => {
    await mount('log')
    const folder = screen.getByTestId('run-folder')
    expect(folder.getAttribute('title')).toBe(`Open the folder: ${current.summary.folder}`)
    await waitFor(() => expect(screen.getByTestId('log-rows').querySelectorAll('[data-seq]')).toHaveLength(3))
    const row = screen.getByTestId('log-rows').querySelector('[data-seq="3"]')
    const cut = [...(row?.querySelectorAll('span.truncate') ?? [])]
    expect(cut.map((c) => [c.textContent, c.getAttribute('title')])).toEqual([
      ['Plan', 'Plan'],
      ['AUTO', 'AUTO'],
    ])
  })

  it('announces step transitions politely', async () => {
    await mount()
    current = {
      ...current,
      steps: { ...current.steps, implement: { ...current.steps.implement, status: 'done' } },
      lastSeq: 20,
    }
    act(() => {
      applySnapshot(current)
    })
    expect(screen.getByTestId('step-announcer').textContent).toBe('Implement: Done')
    expect(screen.getByTestId('step-announcer').getAttribute('aria-live')).toBe('polite')
  })

  it('shows a clear state with a link to Runs for an unknown run', async () => {
    mock.on('runs.get', () => {
      throw mockError('NOT_FOUND', `Run ${RUN} not found.`)
    })
    release = startBridge()
    renderUi(<RunPage runId={RUN} tab="flow" />)
    await waitFor(() => expect(screen.getByTestId('run-not-found')).toBeTruthy())
    expect(screen.getByTestId('run-not-found').textContent).toContain(`Run ${RUN} not found.`)
    expect(screen.getByRole('link', { name: 'Go to Runs' }).getAttribute('href')).toBe('#/runs')
  })
})
