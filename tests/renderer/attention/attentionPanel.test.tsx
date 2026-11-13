// AttentionPanel (accessibility; asks.spec.ts, no-allow-session.spec.ts, keyboard.spec.ts): queue position,
// countdown on core's (scaled) clock, A/⇧A/D only with focus in the ask and never while typing, "Allow for this run"
// absent with a note, Deny primary for defaultToNo, Deny → undo, the assertive announcement (once per ask), focus
// for a new ask only when nothing else has it, asks withdrawn or answered elsewhere leaving a polite note, and a
// stale answer showing core's own text.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskView, RunSnapshot } from '@shared/run.ts'
import { AttentionPanel } from '@renderer/components/run/AttentionPanel.tsx'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { configureCoreClock, resetCoreClock } from '@renderer/lib/coreClock.ts'
import { resetShortcuts } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import type { RunEventBody } from '@shared/run.ts'
import { env, ev } from '../helpers/fixtures.ts'
import { defaultAppInfo, installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory
let seq = 0

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  resetCoreClock()
  seq = 0
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
    expiresAt: Date.now() + 599_500,
    allowSession: true,
    queue: { index: 1, total: 1 },
    ...over,
  }
}

const snapOf = (asks: AskView[]): RunSnapshot => snapWith({ extra: { asks } })

function Ui({ asks }: { asks: AskView[] }): React.JSX.Element {
  return (
    <TooltipProvider>
      <AttentionPanel snap={snapOf(asks)} />
      <Toaster />
    </TooltipProvider>
  )
}

function show(asks: AskView[]): { rerender: (asks: AskView[]) => void } {
  const r = render(<Ui asks={asks} />)
  return { rerender: (next) => r.rerender(<Ui asks={next} />) }
}

/** Feed the stream buffer as the bridge would (the ask marker, then how core resolved it). */
function feed(body: RunEventBody, ts = Date.now()): void {
  streamBuffer.apply(env(RUN, ++seq, body, ts))
  streamBuffer.flush()
}

function askEvent(a: AskView): RunEventBody {
  return ev(a.step, {
    type: 'ask',
    requestId: a.requestId,
    kind: a.kind,
    detail: a.detail,
    expiresAt: a.expiresAt,
    allowSession: a.allowSession,
  })
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

async function key(target: EventTarget, k: string, shift = false): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }),
    )
    await settle()
  })
}

describe('queue and buttons', () => {
  it('shows the queue position and asks waiting in other steps', () => {
    show([
      ask({ queue: { index: 1, total: 3 } }),
      ask({ requestId: 'req-2', queue: { index: 2, total: 3 } }),
      ask({ requestId: 'req-3', step: 'fix', queue: { index: 1, total: 1 } }),
    ])
    expect(screen.getByTestId('ask-queue').textContent).toBe('1 of 3 · 1 more waiting in other steps')
    expect(screen.getAllByTestId('ask-panel')).toHaveLength(1)
  })

  it('hides "Allow for this run" with a note when the vendor cannot allow it, and ⇧A does nothing', async () => {
    show([ask({ allowSession: false })])
    expect(screen.queryByTestId('ask-allow-session')).toBeNull()
    expect(screen.getByTestId('ask-no-session').textContent).toBe(
      'This tool cannot be allowed for the whole run',
    )
    const panel = screen.getByTestId('ask-panel')
    panel.focus()
    await key(panel, 'A', true)
    expect(mock.callsOf('asks.answer')).toEqual([])
  })

  it('makes Deny the primary button when the vendor defaults to no', () => {
    show([ask({ defaultToNo: true })])
    expect(screen.getByTestId('ask-deny').className).toContain('bg-primary')
    expect(screen.getByTestId('ask-allow').className).not.toContain('bg-primary')
  })

  it('denies with the 3 s grace and an Undo toast; the card shows the grace with Undo', async () => {
    const view = show([ask()])
    await click(screen.getByTestId('ask-deny'))
    expect(mock.callsOf('asks.answer')).toEqual([
      { runId: RUN, requestId: 'req-1', decision: 'deny', graceMs: 3000 },
    ])
    const t = useStore.getState().toasts.items.find((x) => x.id === 'deny:req-1')
    expect(t?.durationMs).toBe(3000)
    view.rerender([ask({ pendingDenyUntil: Date.now() + 3000 })])
    expect(screen.getByTestId('ask-pending-deny').textContent).toMatch(/^Denied · sent in 3 s/)
    await click(screen.getByTestId('ask-undo'))
    expect(mock.callsOf('asks.undo')).toEqual([{ runId: RUN, requestId: 'req-1' }])
  })
})

describe('keys', () => {
  it('answers with A, ⇧A and D only while focus is in the ask', async () => {
    show([ask()])
    await key(document.body, 'a')
    expect(mock.callsOf('asks.answer')).toEqual([])
    const panel = screen.getByTestId('ask-panel')
    panel.focus()
    await key(document.activeElement ?? panel, 'a')
    await key(screen.getByTestId('ask-deny'), 'A', true)
    await key(panel, 'd')
    expect(mock.callsOf('asks.answer').map((r) => r.decision)).toEqual(['allow', 'allow-session', 'deny'])
  })

  it('never answers while the user types, even with the ask on screen', async () => {
    const input = document.createElement('input')
    document.body.append(input)
    try {
      show([ask()])
      input.focus()
      await key(input, 'a')
      await key(input, 'd')
      expect(mock.callsOf('asks.answer')).toEqual([])
      // Focus stayed where the user was typing.
      expect(document.activeElement).toBe(input)
    } finally {
      input.remove()
    }
  })

  it('names every answer key on its button', () => {
    show([ask()])
    expect(screen.getByTestId('ask-allow').getAttribute('aria-keyshortcuts')).toBe('A')
    expect(screen.getByTestId('ask-allow-session').getAttribute('aria-keyshortcuts')).toBe('Shift+A')
    expect(screen.getByTestId('ask-deny').getAttribute('aria-keyshortcuts')).toBe('D')
  })
})

describe('announcements and focus', () => {
  it('announces a new ask once, assertively, with its detail and the time left', () => {
    const view = show([ask()])
    const live = screen.getByTestId('ask-announcer')
    expect(live.getAttribute('aria-live')).toBe('assertive')
    expect(live.textContent).toBe(
      'Implement: Claude wants to run a command. Claude asks to run: npm test -- --run. 9 minutes left.',
    )
    view.rerender([
      ask(),
      ask({ requestId: 'req-2', kind: 'edit', detail: 'src/a.ts', expiresAt: Date.now() + 45_000 }),
    ])
    expect(live.textContent).toBe(
      'Implement: Claude wants to change a file. Claude asks to change: src/a.ts. 45 seconds left.',
    )
    // The first leaves; the second (already announced) is not announced again.
    view.rerender([
      ask({ requestId: 'req-2', kind: 'edit', detail: 'src/a.ts', expiresAt: Date.now() + 45_000 }),
    ])
    expect(live.textContent).toContain('src/a.ts')
  })

  it('moves focus to a new ask only when nothing else has it, and to the next ask after an answer', () => {
    const view = show([ask()])
    expect(document.activeElement).toBe(screen.getByTestId('ask-panel'))
    // The user answers; the next ask in the queue takes over the (lost) focus.
    ;(document.activeElement as HTMLElement).blur()
    view.rerender([ask({ requestId: 'req-2' })])
    const next = screen.getByTestId('ask-panel')
    expect(next.dataset['requestId']).toBe('req-2')
    expect(document.activeElement).toBe(next)
    // Somewhere else: a third ask does not steal focus.
    const button = document.createElement('button')
    document.body.append(button)
    try {
      button.focus()
      view.rerender([ask({ requestId: 'req-3' })])
      expect(document.activeElement).toBe(button)
    } finally {
      button.remove()
    }
  })

  it('counts down on core’s clock, which E2E runs compress', async () => {
    const core = Date.now() + 10_000_000
    configureCoreClock(defaultAppInfo({ e2e: true }), () =>
      Promise.resolve({ ok: true, value: { now: core, timeScale: 100 } }),
    )
    await act(() => settle())
    show([ask({ expiresAt: core + 600_000 })])
    const timer = screen.getByTestId('ask-countdown').querySelector('[role="timer"]')
    const left = Number(timer?.getAttribute('data-remaining-ms'))
    // A real second or so has not gone by yet: ~10 core minutes left, not 10_600 s as Date.now() would say.
    expect(left).toBeGreaterThan(590_000)
    expect(left).toBeLessThanOrEqual(600_000)
    expect(screen.getByTestId('ask-announcer').textContent).toMatch(/\. (9|10) minutes left\.$/)
  })
})

describe('asks that leave without an answer from here', () => {
  it('says "Answered from a notification", with what was decided, in a polite region', () => {
    const a = ask()
    feed(askEvent(a))
    const view = show([a])
    feed({
      t: 'ask-resolved',
      step: 'implement',
      requestId: 'req-1',
      by: 'user',
      via: 'notification',
      decision: 'allow',
    })
    view.rerender([])
    expect(screen.queryByTestId('ask-panel')).toBeNull()
    const note = screen.getByTestId('ask-withdrawn-note')
    expect(note.textContent).toBe('Answered from a notification')
    expect(note.closest('[role="status"]')?.getAttribute('aria-live')).toBe('polite')
    expect(note.parentElement?.textContent).toContain('Allowed once · npm test -- --run')
    // Dismissable.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this note' }))
    expect(screen.queryByTestId('ask-withdrawn-note')).toBeNull()
  })

  it('says the vendor withdrew it, and says nothing for an answer given in this window', () => {
    const a = ask()
    const b = ask({ requestId: 'req-2' })
    feed(askEvent(a))
    feed(askEvent(b))
    const view = show([a, b])
    feed({
      t: 'ask-resolved',
      step: 'implement',
      requestId: 'req-1',
      by: 'user',
      via: 'app',
      decision: 'allow',
    })
    view.rerender([b])
    expect(screen.queryByTestId('ask-withdrawn-note')).toBeNull()
    feed({ t: 'ask-resolved', step: 'implement', requestId: 'req-2', by: 'vendor-cancel' })
    view.rerender([])
    expect(screen.getByTestId('ask-withdrawn-note').textContent).toBe('Withdrawn by Claude')
  })

  it('shows core’s text for a stale answer, not a generic error', async () => {
    mock.on('asks.answer', () => {
      throw mockError('NOT_FOUND', 'This question was already answered or has expired.')
    })
    const view = show([ask()])
    await click(screen.getByTestId('ask-allow'))
    expect(screen.getByTestId('ask-stale').textContent).toBe(
      'This question was already answered or has expired.',
    )
    expect(useStore.getState().toasts.items.filter((t) => t.level === 'error')).toEqual([])
    // It stays after the ask is gone, and goes when a new ask arrives.
    view.rerender([])
    expect(screen.getByTestId('ask-stale')).toBeTruthy()
    view.rerender([ask({ requestId: 'req-9' })])
    expect(screen.queryByTestId('ask-stale')).toBeNull()
  })

  it('keeps other failures as an error toast with core’s message', async () => {
    mock.on('asks.answer', () => {
      throw mockError('INTERNAL', 'The vendor could not be reached.')
    })
    show([ask()])
    await click(screen.getByTestId('ask-allow'))
    expect(screen.queryByTestId('ask-stale')).toBeNull()
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain(
      'The vendor could not be reached.',
    )
  })
})
