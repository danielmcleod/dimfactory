// Plan gate timing (the plan-end guard, state-machine row R4): core may now take the plan-end snapshot between Plan's
// end and the gate, so the Run view can see Plan `done` with no gate open yet. The SummaryBar's "Plan ✓ approved"
// comes from the gate's resolved card in the log (plan.ts usePlanGate); a read in that window finds no gate and no
// later step, which is not a settled answer: it must not stick, so the approval shows once the gate closes.
import '../helpers/rtl.ts'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CardView, RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { clearPlanGateCache } from '@renderer/components/run/plan.ts'
import { SummaryBar } from '@renderer/components/run/SummaryBar.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { RUN, eventsHandler, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]

const gate: CardView = {
  id: 'gate:afterPlan-1',
  kind: 'gate:afterPlan',
  title: 'Review the plan',
  body: '# Plan',
  payload: { plan: '# Plan' },
  blocking: true,
  defaultChoice: 'approve',
  choices: [
    { id: 'approve', label: 'Approve', primary: true, input: 'plan' },
    { id: 'cancel', label: 'Cancel run', danger: true },
  ],
}

const planDone = (cards: CardView[] = [], implement: 'queued' | 'running' = 'queued'): RunSnapshot =>
  snapWith({
    summary: { status: cards.length > 0 ? 'waiting' : 'running', phase: 'planning' },
    steps: {
      plan: { status: 'done', attempt: 1 },
      implement: { status: implement, attempt: implement === 'running' ? 1 : 0 },
    },
    extra: { cards },
  })

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  clearToasts()
  clearOutputCache()
  clearPlanGateCache()
  log = [env(RUN, 1, { t: 'step-status', step: 'plan', attempt: 1, status: 'done' })]
  mock = installMockDimFactory({
    handlers: {
      'runs.events': eventsHandler(() => log),
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'none')
      },
    },
  })
})

afterEach(() => {
  mock.uninstall()
  clearToasts()
  clearPlanGateCache()
  resetBridgeForTests()
})

const plan = (): string => screen.getByTestId('summary-plan').textContent ?? ''

const bar = (snap: RunSnapshot): React.JSX.Element => (
  <TooltipProvider>
    <SummaryBar snap={snap} onOpenDiff={() => undefined} />
  </TooltipProvider>
)

async function settled(): Promise<void> {
  await act(async () => {
    await settle()
  })
}

describe('the plan gate after the plan-end guard', () => {
  it('shows the approval once the gate closes, though the first read came before the gate opened', async () => {
    const ui = render(bar(planDone()))
    // The window: Plan done, the plan-end snapshot under way, no gate yet.
    await settled()
    expect(mock.callsOf('runs.events').length).toBeGreaterThan(0)
    expect(plan()).toBe('Plan done')
    // The gate opens, then the user approves; Implement starts.
    log.push(env(RUN, 2, { t: 'card', card: gate, state: 'open' }))
    ui.rerender(bar(planDone([gate])))
    await settled()
    expect(plan()).toBe('Plan ready for review')
    log.push(
      env(RUN, 3, { t: 'card', card: gate, state: 'resolved', choiceId: 'approve' }),
      env(RUN, 4, { t: 'step-status', step: 'implement', attempt: 1, status: 'running' }),
    )
    ui.rerender(bar(planDone([], 'running')))
    await waitFor(() => expect(plan()).toBe('Plan ✓ approved'))
  })

  it('reads the plan again once the gate has closed, so an edit made at the gate shows', async () => {
    let edited = false
    mock.on('runs.output', (req) => {
      if (req.file === 'plan')
        return { text: edited ? '# Plan\n1. a\n2. b\n' : '# Plan\n1. a\n', mtime: 1, version: edited ? 2 : 1 }
      if (req.file === 'plan.original' && edited) return { text: '# Plan\n1. a\n', mtime: 1, version: 1 }
      throw mockError('NOT_FOUND', 'none')
    })
    const ui = render(bar(planDone()))
    await settled()
    expect(plan()).toBe('Plan done')
    log.push(env(RUN, 2, { t: 'card', card: gate, state: 'open' }))
    ui.rerender(bar(planDone([gate])))
    await settled()
    // Approved with an edit: core writes plan.original.md and the edited plan.md.
    edited = true
    log.push(
      env(RUN, 3, { t: 'card', card: gate, state: 'resolved', choiceId: 'approve' }),
      env(RUN, 4, { t: 'step-status', step: 'implement', attempt: 1, status: 'running' }),
    )
    ui.rerender(bar(planDone([], 'running')))
    await waitFor(() => expect(plan()).toBe('Plan ✓ approved (edited)'))
  })

  it('keeps a settled answer: no gate before a later step reported (Auto, gate off) reads Plan done', async () => {
    log.push(env(RUN, 2, { t: 'step-status', step: 'implement', attempt: 1, status: 'running' }))
    const first = render(bar(planDone([], 'running')))
    await settled()
    expect(plan()).toBe('Plan done')
    const reads = mock.callsOf('runs.events').length
    expect(reads).toBeGreaterThan(0)
    // A later mount reuses it (no new read of the log).
    first.unmount()
    render(bar(planDone([], 'running')))
    await settled()
    expect(mock.callsOf('runs.events').length).toBe(reads)
    expect(plan()).toBe('Plan done')
  })
})
