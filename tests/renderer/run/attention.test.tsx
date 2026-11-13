// components/run/AttentionPanel and PausedNotice: allow once / for this run / deny with the 3 s undo grace and its
// Undo toast, "Allow for this run" absent when the vendor cannot allow it, A/⇧A/D inside the panel, Deny primary when
// the vendor defaults to no, the queue position, the assertive announcement; the ask-timeout pause's three ways on.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskView } from '@shared/run.ts'
import { AttentionPanel } from '@renderer/components/run/AttentionPanel.tsx'
import { PausedNotice } from '@renderer/components/run/PausedNotice.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, settle, snapWith } from './helpers.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  mock = installMockDimFactory({
    handlers: {
      'asks.answer': () => undefined,
      'asks.undo': () => undefined,
      'runs.resume': () => undefined,
      'runs.stop': () => undefined,
      'runs.get': () => snapWith(),
    },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  resetBridgeForTests()
})

function ask(over: Partial<AskView> = {}): AskView {
  return {
    runId: RUN,
    step: 'implement',
    attempt: 1,
    requestId: 'req-1',
    vendor: 'claude',
    kind: 'shell',
    detail: 'npm test -- --run',
    reason: 'Run the test suite',
    expiresAt: Date.now() + 120_000,
    allowSession: true,
    queue: { index: 1, total: 3 },
    ...over,
  }
}

function showAsks(asks: AskView[]): ReturnType<typeof renderUi> {
  return renderUi(<AttentionPanel snap={snapWith({ extra: { asks } })} />)
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

describe('AttentionPanel', () => {
  it('shows the ask with its detail, reason, countdown and queue position, and announces it', () => {
    showAsks([ask()])
    const panel = screen.getByTestId('ask-panel')
    expect(panel.textContent).toContain('Implement · Claude wants to run a command')
    expect(screen.getByTestId('ask-detail').textContent).toBe('npm test -- --run')
    expect(panel.textContent).toContain('Run the test suite')
    expect(screen.getByTestId('ask-queue').textContent).toBe('1 of 3')
    expect(panel.querySelector('[role="timer"]')).not.toBeNull()
    expect(screen.getByTestId('ask-announcer').textContent).toContain('Claude wants to run a command')
    expect(screen.getByTestId('ask-announcer').getAttribute('aria-live')).toBe('assertive')
    expect(screen.getByTestId('ask-allow').getAttribute('aria-keyshortcuts')).toBe('A')
    expect(screen.getByTestId('ask-allow-session').getAttribute('aria-keyshortcuts')).toBe('Shift+A')
    expect(screen.getByTestId('ask-deny').getAttribute('aria-keyshortcuts')).toBe('D')
  })

  it('hides "Allow for this run" when the vendor cannot allow it for the run, with a note', () => {
    showAsks([ask({ allowSession: false })])
    expect(screen.queryByTestId('ask-allow-session')).toBeNull()
    expect(screen.getByTestId('ask-no-session').textContent).toBe(
      'This tool cannot be allowed for the whole run',
    )
  })

  it('allows once and for the run', async () => {
    showAsks([ask()])
    await click(screen.getByTestId('ask-allow'))
    await click(screen.getByTestId('ask-allow-session'))
    expect(mock.callsOf('asks.answer')).toEqual([
      { runId: RUN, requestId: 'req-1', decision: 'allow' },
      { runId: RUN, requestId: 'req-1', decision: 'allow-session' },
    ])
  })

  it('denies with a 3 s grace and an Undo toast that calls asks.undo', async () => {
    showAsks([ask()])
    await click(screen.getByTestId('ask-deny'))
    expect(mock.callsOf('asks.answer')).toEqual([
      { runId: RUN, requestId: 'req-1', decision: 'deny', graceMs: 3000 },
    ])
    const t = useStore.getState().toasts.items.find((x) => x.id === 'deny:req-1')
    expect(t?.message).toBe('Denied · Undo')
    expect(t?.durationMs).toBe(3000)
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('asks.undo')).toEqual([{ runId: RUN, requestId: 'req-1' }])
  })

  it('shows a deny in its grace period with Undo in the panel', async () => {
    showAsks([ask({ pendingDenyUntil: Date.now() + 3000 })])
    expect(screen.getByTestId('ask-pending-deny').textContent).toMatch(/^Denied · sent in [1-3] s/)
    expect(screen.queryByTestId('ask-allow')).toBeNull()
    await click(screen.getByTestId('ask-undo'))
    expect(mock.callsOf('asks.undo')).toEqual([{ runId: RUN, requestId: 'req-1' }])
  })

  it('answers with A, Shift+A and D while focus is in the panel', async () => {
    showAsks([ask()])
    const panel = screen.getByTestId('ask-panel')
    const key = async (k: string, shift = false): Promise<void> => {
      await act(async () => {
        panel.dispatchEvent(
          new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }),
        )
        await settle()
      })
    }
    await key('a')
    await key('A', true)
    await key('d')
    expect(mock.callsOf('asks.answer').map((r) => r.decision)).toEqual(['allow', 'allow-session', 'deny'])
    // Outside the panel a single key does nothing.
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
      await settle()
    })
    expect(mock.callsOf('asks.answer')).toHaveLength(3)
  })

  it('makes Deny the primary button when the vendor defaults to no', () => {
    showAsks([ask({ defaultToNo: true })])
    expect(screen.getByTestId('ask-deny').className).toContain('bg-primary')
    expect(screen.getByTestId('ask-allow').className).not.toContain('bg-primary')
  })

  it('offers Switch to Auto on an Implement or Fix ask outside Auto, never in an Auto run or for other passes', () => {
    const { unmount } = showAsks([ask()])
    expect(screen.getByTestId('ask-auto-switch').textContent).toContain('Switch to Auto')
    unmount()
    const inAuto = renderUi(
      <AttentionPanel snap={snapWith({ summary: { auto: true }, extra: { asks: [ask()] } })} />,
    )
    expect(screen.queryByTestId('ask-auto-switch')).toBeNull()
    inAuto.unmount()
    showAsks([ask({ step: 'deploy' })])
    expect(screen.queryByTestId('ask-auto-switch')).toBeNull()
  })

  it('renders nothing but the live region without asks', () => {
    showAsks([])
    expect(screen.queryByTestId('ask-panel')).toBeNull()
  })
})

describe('PausedNotice', () => {
  it('offers Allow & resume, Resume (keep denied) and Stop run after an ask timed out', async () => {
    const snap = snapWith({ steps: { implement: { status: 'paused', pause: 'ask-timeout', attempt: 1 } } })
    renderUi(<PausedNotice runId={RUN} view={snap.steps.implement} />)
    await click(screen.getByRole('button', { name: 'Allow & resume' }))
    await click(screen.getByRole('button', { name: 'Resume (keep denied)' }))
    expect(mock.callsOf('runs.resume')).toEqual([{ runId: RUN, allowTimedOutAsk: true }, { runId: RUN }])
    await click(screen.getByRole('button', { name: 'Stop run' }))
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: RUN }])
  })

  it('offers Resume after an interruption (nothing resumes on its own)', () => {
    const snap = snapWith({ steps: { implement: { status: 'paused', pause: 'interrupted', attempt: 1 } } })
    renderUi(<PausedNotice runId={RUN} view={snap.steps.implement} />)
    expect(screen.getByTestId('paused-implement').textContent).toContain('Nothing resumes on its own')
    expect(screen.getByTestId('resume')).toBeTruthy()
  })
})
