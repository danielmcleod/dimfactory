// gemini-no-allow-session.spec.ts (Allow for this run is hidden when allowSession:false, with a
// note; the ACP permissions decision table: no qualifying allow_always option raises the ask with allowSession:false).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskView, RunSnapshot } from '@shared/run.ts'
import { NO_SESSION_NOTE } from '@renderer/components/attention/AskCard.tsx'
import { askHeading, announcement } from '@renderer/components/attention/askText.ts'
import { AttentionPanel } from '@renderer/components/run/AttentionPanel.tsx'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetCoreClock } from '@renderer/lib/coreClock.ts'
import { resetShortcuts } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  resetCoreClock()
  mock = installMockDimFactory({
    handlers: {
      'asks.answer': () => undefined,
      'asks.undo': () => undefined,
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
  resetCoreClock()
  resetBridgeForTests()
})

/** A Gemini ACP permission request as core raises it (the pending tool_call's title as the detail). */
function geminiAsk(over: Partial<AskView> = {}): AskView {
  return {
    runId: RUN,
    step: 'implement',
    attempt: 1,
    requestId: 'run-1:acp:7',
    vendor: 'gemini',
    kind: 'shell',
    detail: 'npm test -- --run',
    reason: 'Run the test suite',
    expiresAt: Date.now() + 599_500,
    allowSession: false,
    queue: { index: 1, total: 1 },
    ...over,
  }
}

const snapOf = (asks: AskView[]): RunSnapshot => snapWith({ extra: { asks } })

function show(asks: AskView[]): void {
  render(
    <TooltipProvider>
      <AttentionPanel snap={snapOf(asks)} />
      <Toaster />
    </TooltipProvider>,
  )
}

async function key(target: EventTarget, k: string, shift = false): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }),
    )
    await settle()
  })
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

describe('Gemini: an ACP ask without a safe "allow for this run" option', () => {
  it('names Gemini, hides "Allow for this run" with its note, and ⇧A answers nothing', async () => {
    show([geminiAsk()])
    expect(screen.getByRole('heading', { name: 'Implement · Gemini wants to run a command' })).toBeTruthy()
    expect(askHeading(geminiAsk())).toBe('Implement · Gemini wants to run a command')
    expect(screen.getByTestId('ask-detail').textContent).toBe('npm test -- --run')
    expect(screen.queryByTestId('ask-allow-session')).toBeNull()
    expect(screen.getByTestId('ask-no-session').textContent).toBe(NO_SESSION_NOTE)
    const panel = screen.getByTestId('ask-panel')
    panel.focus()
    await key(panel, 'A', true)
    expect(mock.callsOf('asks.answer')).toEqual([])
    // Allow once and Deny still answer, by click and by key.
    await key(panel, 'a')
    expect(mock.callsOf('asks.answer')).toEqual([{ runId: RUN, requestId: 'run-1:acp:7', decision: 'allow' }])
  })

  it('Deny goes out with the undo grace, as for any vendor', async () => {
    show([geminiAsk()])
    await click(screen.getByTestId('ask-deny'))
    expect(mock.callsOf('asks.answer')).toEqual([
      { runId: RUN, requestId: 'run-1:acp:7', decision: 'deny', graceMs: 3000 },
    ])
  })

  it('an ACP ask with a safe option offers "Allow for this run", and ⇧A sends allow-session', async () => {
    show([geminiAsk({ allowSession: true })])
    expect(screen.getByTestId('ask-allow-session').textContent).toContain('Allow for this run')
    expect(screen.queryByTestId('ask-no-session')).toBeNull()
    const panel = screen.getByTestId('ask-panel')
    panel.focus()
    await key(panel, 'A', true)
    expect(mock.callsOf('asks.answer').map((r) => r.decision)).toEqual(['allow-session'])
  })

  it('announces the ask with Gemini’s name and plain words', () => {
    expect(announcement(geminiAsk(), 540_000)).toBe(
      'Implement: Gemini wants to run a command. Gemini asks to run: npm test -- --run. 9 minutes left.',
    )
    expect(NO_SESSION_NOTE).not.toContain('—')
  })
})
