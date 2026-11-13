// The Run view for a keyboard and screen-reader user (accessibility; keyboard.spec.ts): the
// stream is a log, step transitions go to a polite live region and asks to an assertive one, an ask that arrives
// while nothing has focus takes it so A answers it, and every shortcut is named on its control.
import '../helpers/rtl.ts'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskView, RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { resetCoreClock } from '@renderer/lib/coreClock.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { RunPage } from '@renderer/pages/run/RunPage.tsx'
import { applySnapshot } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, text } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]
let current: RunSnapshot
let release: (() => void) | null = null

const ask: AskView = {
  runId: RUN,
  step: 'implement',
  attempt: 1,
  requestId: 'req-1',
  vendor: 'claude',
  kind: 'shell',
  detail: 'npm test',
  expiresAt: Date.now() + 600_000,
  allowSession: true,
  queue: { index: 1, total: 1 },
}

const snap = (asks: AskView[], seq: number): RunSnapshot =>
  snapWith({
    summary: { status: asks.length > 0 ? 'waiting' : 'running', phase: 'implementing' },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1 },
      implement: { status: asks.length > 0 ? 'waiting' : 'running', attempt: 1, vendor: 'claude' },
    },
    lastSeq: seq,
    extra: { asks },
  })

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  resetCoreClock()
  setMacForTests(false)
  log = [env(RUN, 1, text('implement', 'Working on it\n'))]
  current = snap([], 1)
  mock = installMockDimFactory({
    handlers: {
      'runs.get': () => current,
      'runs.events': eventsHandler(() => log),
      'asks.answer': () => undefined,
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
  resetCoreClock()
  setMacForTests(null)
  resetBridgeForTests()
})

async function mount(): Promise<void> {
  release = startBridge()
  renderUi(<RunPage runId={RUN} tab="flow" />)
  await act(async () => {
    await settle(10)
  })
  await waitFor(() => expect(screen.getByTestId('run-header')).toBeTruthy())
}

describe('Run view accessibility', () => {
  it('has a log for the stream, a polite region for steps and an assertive one for asks', async () => {
    await mount()
    const stream = await waitFor(() => screen.getByTestId('stream-implement'))
    expect(stream.getAttribute('role')).toBe('log')
    expect(screen.getByTestId('step-announcer').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('ask-announcer').getAttribute('aria-live')).toBe('assertive')
    expect(screen.getByRole('navigation', { name: 'Run steps' })).toBeTruthy()
    expect(screen.getByTestId('stop-run').getAttribute('aria-keyshortcuts')).toBe('Control+Period')
  })

  it('gives a new ask the focus when nothing has it, announces it, and A answers it', async () => {
    await mount()
    expect(document.activeElement).toBe(document.body)
    current = snap([ask], 2)
    act(() => {
      applySnapshot(current)
    })
    const panel = screen.getByTestId('ask-panel')
    expect(document.activeElement).toBe(panel)
    expect(screen.getByTestId('ask-announcer').textContent).toContain('Claude asks to run: npm test.')
    await act(async () => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
      await settle()
    })
    expect(mock.callsOf('asks.answer')).toEqual([{ runId: RUN, requestId: 'req-1', decision: 'allow' }])
    // The step's transition is said politely once core reports it.
    current = snap([], 3)
    act(() => {
      applySnapshot(current)
    })
    expect(screen.getByTestId('step-announcer').textContent).toBe('Implement: Running')
  })
})
