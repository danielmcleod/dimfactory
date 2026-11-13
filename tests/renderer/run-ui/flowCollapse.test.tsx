// PassCard collapse at open (PassCard: "The card collapses after done", only as the view opens; the control
// standards: nothing moves on its own). A card mounts once its step begins, so a fast reviewer that begins and ends
// between two renders mounts already done; the Run view's record of what was over when it opened keeps that card
// open (found as an intermittent full-run.spec.ts failure: Review and Critic came up collapsed after a run watched live). When the
// second reviewer begins, the first reviewer's card keeps its instance and the user's open/closed choice.
import '../helpers/rtl.ts'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope, RunSnapshot, StepKey } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { FlowTab } from '@renderer/pages/run/FlowTab.tsx'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { eventsHandler, renderUi, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory
const log: RunEnvelope[] = []

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  mock = installMockDimFactory({
    handlers: {
      'runs.events': eventsHandler(() => log),
      'runs.get': () => snapWith(),
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'no output')
      },
    },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetTicker()
  resetBridgeForTests()
})

const DONE = { status: 'done' as const, attempt: 1, startedAt: 1, endedAt: 2 }
const RUNNING = { status: 'running' as const, attempt: 1, startedAt: 1 }

/** Plan and Implement done; the reviewers as given. */
function snap(review: object | null, critic: object | null): RunSnapshot {
  return snapWith({
    summary: { status: 'running', phase: 'reviewing' },
    steps: {
      plan: DONE,
      implement: DONE,
      ...(review !== null ? { review } : {}),
      ...(critic !== null ? { critic } : {}),
    },
  })
}

/** The tree renderUi renders, for rerender (which otherwise drops the providers and mounts everything again). */
function framed(node: React.ReactNode): React.JSX.Element {
  return (
    <TooltipProvider>
      {node}
      <Toaster />
    </TooltipProvider>
  )
}

function toggle(step: StepKey): HTMLElement {
  return screen.getByTestId(`pass-card-${step}`).querySelector('[aria-expanded]') as HTMLElement
}

describe('PassCard collapse when the Run view opens', () => {
  it('a reviewer that begins and ends between two renders opens expanded while the view watched the run', () => {
    // The view opened during Implement: only Plan was over then.
    const atOpen = new Set<StepKey>(['plan'])
    const ui = renderUi(<FlowTab snap={snap(null, null)} finishedAtOpen={atOpen} />)
    ui.rerender(framed(<FlowTab snap={snap(DONE, DONE)} finishedAtOpen={atOpen} />))
    expect(toggle('review').getAttribute('aria-expanded')).toBe('true')
    expect(toggle('critic').getAttribute('aria-expanded')).toBe('true')
  })

  it('steps already over when the view opened start collapsed', () => {
    const atOpen = new Set<StepKey>(['plan', 'implement', 'review', 'critic'])
    renderUi(<FlowTab snap={snap(DONE, DONE)} finishedAtOpen={atOpen} />)
    expect(toggle('review').getAttribute('aria-expanded')).toBe('false')
    expect(toggle('critic').getAttribute('aria-expanded')).toBe('false')
    expect(toggle('implement').getAttribute('aria-expanded')).toBe('false')
  })

  it("the first reviewer keeps the user's choice when the second one begins", () => {
    const atOpen = new Set<StepKey>(['plan'])
    const ui = renderUi(<FlowTab snap={snap(RUNNING, null)} finishedAtOpen={atOpen} />)
    const reviewCard = screen.getByTestId('pass-card-review')
    fireEvent.click(toggle('review'))
    expect(toggle('review').getAttribute('aria-expanded')).toBe('false')
    ui.rerender(framed(<FlowTab snap={snap(RUNNING, RUNNING)} finishedAtOpen={atOpen} />))
    expect(screen.getByTestId('pass-card-review')).toBe(reviewCard)
    expect(toggle('review').getAttribute('aria-expanded')).toBe('false')
    expect(toggle('critic').getAttribute('aria-expanded')).toBe('true')
  })
})
