// The a11y audit, the Run view (accessibility). What the audit found here and
// fixed: the run heading read "#1Add…" (a margin, not a space, between the number and the title); a step's heading sat
// inside its disclosure button (a button's content is presentational, so the heading was not one) and the Flow tab's
// headings went from h1 to h3; the timeline's step names read "Plan : Done , 1s"; and the assertive regions kept
// saying an ask, or "Plan ready for review.", after it had been answered. a11y.spec.ts checks the running app.
import '../helpers/rtl.ts'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskView, CardView as CardData, RunEnvelope, RunSnapshot } from '@shared/run.ts'
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

const planGate: CardData = {
  id: 'gate:afterPlan-1',
  kind: 'gate:afterPlan',
  title: 'Review the plan',
  body: '1. Add the flag',
  payload: { plan: '1. Add the flag' },
  blocking: true,
  choices: [
    { id: 'approve', label: 'Approve', primary: true, input: 'plan' },
    { id: 'cancel', label: 'Cancel run', danger: true },
  ],
}

function snap(seq: number, o: { asks?: AskView[]; gate?: boolean } = {}): RunSnapshot {
  const asks = o.asks ?? []
  return snapWith({
    summary: {
      title: 'Add a --version flag',
      displayNo: 7,
      status: o.gate === true || asks.length > 0 ? 'waiting' : 'running',
      phase: o.gate === true ? 'plan-review' : 'implementing',
    },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1, vendor: 'claude' },
      implement:
        o.gate === true
          ? { status: 'queued' }
          : { status: asks.length > 0 ? 'waiting' : 'running', attempt: 1, vendor: 'claude' },
    },
    lastSeq: seq,
    extra: { asks, cards: o.gate === true ? [planGate] : [] },
  })
}

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  resetCoreClock()
  setMacForTests(false)
  log = [env(RUN, 1, text('implement', 'Working on it\n'))]
  current = snap(1)
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

const apply = (s: RunSnapshot): void => {
  current = s
  act(() => {
    applySnapshot(s)
  })
}

describe('the Run view outline', () => {
  it('says the run as "#7 Add a --version flag": a space between the number and the title', async () => {
    await mount()
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.textContent).toBe('#7 Add a --version flag')
  })

  it('goes run (h1) → steps (h2) → each step (h3), with the disclosure button inside the heading', async () => {
    await mount()
    const flow = screen.getByTestId('flow-tab')
    const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]))
    for (let i = 1; i < levels.length; i++)
      expect(levels[i] ?? 0).toBeLessThanOrEqual((levels[i - 1] ?? 0) + 1)
    expect(within(flow).getByRole('heading', { level: 2 }).textContent).toBe('Steps')
    const implement = within(screen.getByTestId('pass-card-implement')).getByRole('heading', { level: 3 })
    expect(implement.textContent).toBe('Implement')
    expect(implement.closest('button')).toBeNull()
    const toggle = within(implement).getByRole('button', { name: 'Implement' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // No heading anywhere hides inside a button or a link.
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      expect(h.parentElement?.closest('button, a[href]') ?? null, h.textContent ?? '').toBeNull()
    }
  })

  it("names each timeline step in one clean phrase, and marks the run's current step", async () => {
    await mount()
    const plan = screen.getByTestId('timeline-node-plan')
    expect(plan.getAttribute('aria-label')).toMatch(/^Plan: Done(, \S.*)?$/)
    const implement = screen.getByTestId('timeline-node-implement')
    expect(implement.getAttribute('aria-label')).toMatch(/^Implement: Running(, \S.*)?$/)
    expect(implement.getAttribute('aria-current')).toBe('step')
    expect(plan.getAttribute('aria-current')).toBeNull()
  })
})

describe('the live regions after an answer', () => {
  it("an ask's announcement goes once the ask has left", async () => {
    await mount()
    const said = screen.getByTestId('ask-announcer')
    apply(snap(2, { asks: [ask] }))
    expect(said.textContent).toContain('Claude asks to run: npm test.')
    apply(snap(3))
    expect(said.textContent).toBe('')
    expect(said.querySelector('[data-request-id]')).toBeNull()
    // A new ask is said again, as a new node.
    apply(snap(4, { asks: [{ ...ask, requestId: 'req-2' }] }))
    expect(said.querySelector('[data-request-id="req-2"]')?.textContent).toContain('npm test')
  })

  it('a card\'s announcement ("Plan ready for review.") goes once the card is answered', async () => {
    await mount()
    const said = screen.getByTestId('card-announcer')
    apply(snap(2, { gate: true }))
    expect(said.textContent).toBe('Plan ready for review.')
    apply(snap(3))
    expect(said.textContent).toBe('')
  })

  it('keeps the announcement while its ask or card is still open', async () => {
    await mount()
    apply(snap(2, { asks: [ask] }))
    apply(snap(3, { asks: [ask] }))
    expect(screen.getByTestId('ask-announcer').textContent).toContain('npm test')
    apply(snap(4, { gate: true }))
    apply(snap(5, { gate: true }))
    expect(screen.getByTestId('card-announcer').textContent).toBe('Plan ready for review.')
  })
})
