// Outcome and timeline (verify results "verify:2: a failure here → outcome verify-failed"; RunOutcome
// "verify-failed ⇒ Completed with failures"; "A failing post-Fix verify ends the run as Completed with failures";
// PhaseTimeline "… implement → verify:1 → review‖critic → ◇ → fix → verify:2 …"). The words are core's outcome
// formatted; a verify round is a node of its own, and a finished round with a failing command reads as one.
import '../helpers/rtl.ts'
import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PhaseTimeline } from '@renderer/components/run/PhaseTimeline.tsx'
import { RunHeader } from '@renderer/components/run/RunHeader.tsx'
import { timelineColumns } from '@renderer/components/run/steps.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { outcomeText } from '@renderer/lib/format.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { resetStore } from '@renderer/state/store.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, snapWith } from '../run/helpers.tsx'
import { TEST_FAIL, TYPECHECK, verifyStep } from './fixtures.ts'

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  mock = installMockDimFactory({
    handlers: { 'runs.events': () => ({ events: [], lastSeq: 0, more: false }) },
  })
})

afterEach(() => {
  mock.uninstall()
  resetTicker()
  resetBridgeForTests()
})

const finished = {
  status: 'completed' as const,
  phase: 'done' as const,
  endedAt: 1_700_000_100_000,
}

describe('Completed with failures', () => {
  it('is how a run that still fails its final verify ends', () => {
    expect(outcomeText(makeSummary({ runId: RUN, ...finished, outcome: 'verify-failed' }))).toBe(
      'Completed with failures',
    )
    expect(
      outcomeText(
        makeSummary({ runId: RUN, ...finished, outcome: 'fixed', findings: { must: 1, should: 0 } }),
      ),
    ).toBe('Fixed · 1 must · 0 should')
  })

  it('a clean run that lists a [should] from Verify names it instead of saying "no findings"', () => {
    // Auto skipped an untrusted command: a [should] that does not block the Fix skip rule (only [must] findings do).
    expect(
      outcomeText(
        makeSummary({ runId: RUN, ...finished, outcome: 'clean', findings: { must: 0, should: 1 } }),
      ),
    ).toBe('Clean · 0 must · 1 should')
    expect(
      outcomeText(
        makeSummary({ runId: RUN, ...finished, outcome: 'clean', findings: { must: 0, should: 0 } }),
      ),
    ).toBe('Clean: no findings')
  })

  it('takes the phase’s place in the Run header once the run has ended', () => {
    const snap = snapWith({
      summary: { ...finished, outcome: 'verify-failed', findings: { must: 1, should: 0 } },
      steps: {
        implement: { status: 'done', attempt: 1 },
        'verify:1': verifyStep({ commands: [TEST_FAIL] }),
        fix: { status: 'done', attempt: 1 },
        'verify:2': verifyStep({ commands: [TEST_FAIL] }),
      },
    })
    renderUi(<RunHeader snap={snap} onStop={() => undefined} stopping={false} />)
    expect(screen.getByTestId('run-outcome').textContent).toBe('Completed with failures')
  })
})

describe('the timeline', () => {
  it('has verify:1 after Implement and verify:2 after Fix, and marks a finished round with a failure', () => {
    const snap = snapWith({
      summary: { status: 'running', phase: 'final-verify' },
      steps: {
        plan: { status: 'done', attempt: 1 },
        implement: { status: 'done', attempt: 1 },
        'verify:1': verifyStep({ commands: [TYPECHECK, TEST_FAIL] }),
        review: { status: 'done', attempt: 1 },
        critic: { status: 'done', attempt: 1 },
        fix: { status: 'done', attempt: 1 },
        'verify:2': verifyStep({ status: 'running', commands: [{ ...TEST_FAIL, status: 'running' }] }),
      },
    })
    const order = timelineColumns(snap)
      .filter((c) => c.kind === 'step')
      .map((c) => (c.kind === 'step' ? c.steps.map((s) => s.key).join('+') : ''))
    expect(order).toEqual(['preflight', 'plan', 'implement', 'verify:1', 'review+critic', 'fix', 'verify:2'])
    renderUi(<PhaseTimeline snap={snap} />)
    expect(screen.getByTestId('timeline-node-verify:1').className).toContain('border-st-failed/60')
    expect(screen.getByTestId('timeline-node-verify:2').className).toContain('border-st-running/50')
    expect(screen.getByTestId('timeline-node-verify:2').textContent).toContain('Final verify')
  })

  it('does not mark a round that passed', () => {
    const snap = snapWith({
      steps: { implement: { status: 'done', attempt: 1 }, 'verify:1': verifyStep({ commands: [TYPECHECK] }) },
    })
    renderUi(<PhaseTimeline snap={snap} />)
    expect(screen.getByTestId('timeline-node-verify:1').className).not.toContain('border-st-failed')
  })
})
