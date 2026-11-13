// Review: "nothing moves on its own" (UI standards).
//   - The timeline inserted the verify:1 node between Implement and Review/Critic when the round began, pushing every
//     node right of it. Core now marks a round the run's config runs as `planned` while it waits, and the timeline
//     shows its node from the start.
//   - A watched VerifyCard grew above notes already shown: the failFast paragraph appeared under the rows when the
//     round ended. In a watched round the fact joins the never-wrapping metrics line. (A first round's rows exist
//     from its start: core's RunConfig.verify.names, tests/unit/verify/machine-review.test.ts.)
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunSnapshot, StepKey, StepView } from '@shared/run.ts'
import { PhaseTimeline } from '@renderer/components/run/PhaseTimeline.tsx'
import { timelineColumns } from '@renderer/components/run/steps.ts'
import { VERIFY_ABORTED_SHORT } from '@renderer/components/run/VerifyCard.tsx'
import { FlowTab } from '@renderer/pages/run/FlowTab.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { eventsHandler, renderUi, snapWith } from '../run/helpers.tsx'
import { TEST_FAIL, verifyStep } from './fixtures.ts'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({
    handlers: {
      'runs.events': eventsHandler(() => []),
      'runs.output': () => ({ text: '', mtime: 0, version: 0 }),
    },
  })
})

afterEach(() => tearDown(mock))

const order = (snap: RunSnapshot): string[] =>
  timelineColumns(snap).map((c) => (c.kind === 'step' ? c.steps.map((s) => s.key).join('+') : `<${c.gate}>`))

function at(steps: Partial<Record<StepKey, Partial<StepView>>>): RunSnapshot {
  return snapWith({
    summary: { status: 'running', phase: 'implementing' },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1 },
      'verify:1': { planned: true },
      'verify:2': { planned: true },
      ...steps,
    },
  })
}

describe('the timeline shows a planned verify round from the start', () => {
  it('while Implement runs, verify:1 already has its place; when it begins nothing to its right moves', () => {
    const implementing = at({ implement: { status: 'running', attempt: 1 } })
    const verifying = at({
      implement: { status: 'done', attempt: 1 },
      'verify:1': { status: 'running', attempt: 1 },
    })
    const before = order(implementing)
    expect(before).toEqual([
      'preflight',
      'plan',
      '<afterPlan>',
      'implement',
      'verify:1',
      'review+critic',
      '<beforeFix>',
      'fix',
      'verify:2',
    ])
    expect(order(verifying)).toEqual(before)
    renderUi(<PhaseTimeline snap={implementing} />)
    expect(screen.getByTestId('timeline-node-verify:1').getAttribute('data-status')).toBe('queued')
  })

  it('a round the config does not run is never shown (no `planned`, never begun)', () => {
    const snap = at({ implement: { status: 'running', attempt: 1 }, 'verify:1': {}, 'verify:2': {} })
    const off = snapWith({
      ...snap,
      steps: {
        ...snap.steps,
        'verify:1': { key: 'verify:1', status: 'queued', attempt: 0, activeMs: 0 },
        'verify:2': { key: 'verify:2', status: 'queued', attempt: 0, activeMs: 0 },
      },
    })
    expect(order(off)).not.toContain('verify:1')
    expect(order(off)).not.toContain('verify:2')
  })
})

describe('a watched VerifyCard says failFast on its metrics line, never in a paragraph that pushes notes down', () => {
  const NOTE = 'Trusted the verify command test for this project.'
  const round = (o: { done: boolean }): RunSnapshot =>
    snapWith({
      summary: { status: 'running', phase: 'verifying' },
      steps: {
        plan: { status: 'done', attempt: 1, vendor: 'claude' },
        implement: { status: 'done', attempt: 1, vendor: 'claude' },
        'verify:1': {
          ...verifyStep({ status: o.done ? 'done' : 'running' }),
          verify: {
            commands: [
              o.done ? TEST_FAIL : { ...TEST_FAIL, status: 'running' },
              o.done
                ? {
                    name: 'lint',
                    argv: ['pnpm', 'lint'],
                    status: 'skipped',
                    reason: 'Not run: failFast stopped the round after test failed',
                  }
                : { name: 'lint', argv: ['pnpm', 'lint'], status: 'queued' },
            ],
            ...(o.done ? { aborted: true } : {}),
          },
        },
      },
      extra: { notes: [NOTE] },
    })

  it('the note after the card keeps its place when the round ends aborted', async () => {
    const view = render(
      <Providers>
        <FlowTab snap={round({ done: false })} />
      </Providers>,
    )
    await settle()
    const body = (): Element[] => [...(document.getElementById('pass-body-verify:1')?.children ?? [])]
    const blocksBefore = body().map((e) => e.tagName)
    expect(blocksBefore.length).toBeGreaterThan(0)
    view.rerender(
      <Providers>
        <FlowTab snap={round({ done: true })} />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('verify-aborted-verify:1')).toBeNull()
    expect(screen.getByTestId('verify-summary-verify:1').textContent).toBe(
      `1 failed · 1 skipped · ${VERIFY_ABORTED_SHORT}`,
    )
    // No block was added to the card's body (the summary line was already there): what follows it did not move.
    expect(body().map((e) => e.tagName)).toEqual(blocksBefore)
    expect(screen.getByTestId('verify-commands-verify:1').children).toHaveLength(2)
    expect(VERIFY_ABORTED_SHORT).not.toContain('—')
  })
})
