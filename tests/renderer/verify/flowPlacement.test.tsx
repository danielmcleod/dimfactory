// Integration fixes (UI standards: nothing moves on its own; the
// flow only ever grows at its end), both measured by ui-layout.spec.ts's verify walk:
//   - A verify round can open a second card (verifyEnv) after core added a note while the round ran (answering its
//     trust card: "Trusted the verify command lint for this project."). Put after the round's card, inside its step's
//     block, it pushed that note down. A card joins its step's block only while the block ends the flow; otherwise it
//     lands after everything on the page, and stays where it went.
//   - Core's reason for a waiting round ("trust needed", "checks could not run") came and went as a line of its own,
//     moving the round's rows and output (and the page under scroll anchoring). In a round the view watched, the line
//     is always there.
//   - A round over when its card mounted opened every failure's excerpt: two inner regions stacked left the wheel no
//     page between them ("the wheel always finds page beside it"). Only the first failure's opens.
import '../helpers/rtl.ts'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunSnapshot } from '@shared/run.ts'
import { VerifyCard } from '@renderer/components/run/VerifyCard.tsx'
import { FlowTab } from '@renderer/pages/run/FlowTab.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { eventsHandler, RUN, snapWith } from '../run/helpers.tsx'
import { TEST_FAIL, TYPECHECK, trustCard, verifyEnvCard, verifyStep } from './fixtures.ts'

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

const NOTE = 'Trusted the verify command lint for this project.'

/** `a` comes before `b` in the document. */
function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function round(o: { cards?: RunSnapshot['cards']; notes?: string[]; status?: 'waiting' | 'running' }) {
  return snapWith({
    summary: { status: o.status === 'running' ? 'running' : 'waiting', phase: 'verifying' },
    steps: {
      plan: { status: 'done', attempt: 1, vendor: 'claude' },
      implement: { status: 'done', attempt: 1, vendor: 'claude' },
      'verify:1': verifyStep({ status: o.status ?? 'waiting', commands: [] }),
    },
    extra: { cards: o.cards ?? [], notes: o.notes ?? [] },
  })
}

describe('a card that opens after something followed its step lands at the end of the flow', () => {
  it("joins its step's block while that block ends the flow, and moves nothing when a note follows", async () => {
    const view = render(
      <Providers>
        <FlowTab snap={round({ cards: [trustCard()] })} />
      </Providers>,
    )
    await settle()
    const verify = screen.getByTestId('pass-card-verify:1')
    const trust = screen.getByTestId('card-trust')
    // The trust card opened with the round: right after the round's card, in its block.
    expect(before(verify, trust)).toBe(true)
    expect(trust.parentElement).toBe(verify.parentElement)

    // Answered: core's note lands at the end.
    view.rerender(
      <Providers>
        <FlowTab snap={round({ status: 'running', notes: [NOTE] })} />
      </Providers>,
    )
    await settle()
    const note = screen.getByText(NOTE)
    expect(before(screen.getByTestId('pass-card-verify:1'), note)).toBe(true)

    // The round ends with a verifyEnv card: it lands after the note instead of above it.
    view.rerender(
      <Providers>
        <FlowTab snap={round({ cards: [verifyEnvCard()], notes: [NOTE] })} />
      </Providers>,
    )
    await settle()
    const env = screen.getByTestId('card-verifyEnv')
    expect(before(screen.getByText(NOTE), env)).toBe(true)
    expect(env.parentElement).not.toBe(screen.getByTestId('pass-card-verify:1').parentElement)

    // Another note follows: the card stays where it went (after the first note, before the new one).
    view.rerender(
      <Providers>
        <FlowTab snap={round({ cards: [verifyEnvCard()], notes: [NOTE, 'A later note.'] })} />
      </Providers>,
    )
    await settle()
    const env2 = screen.getByTestId('card-verifyEnv')
    expect(before(screen.getByText(NOTE), env2)).toBe(true)
    expect(before(env2, screen.getByText('A later note.'))).toBe(true)
  })

  it('a card already open when the view opens keeps its place in its step (the natural order)', async () => {
    render(
      <Providers>
        <FlowTab snap={round({ cards: [verifyEnvCard()], notes: [NOTE] })} />
      </Providers>,
    )
    await settle()
    const verify = screen.getByTestId('pass-card-verify:1')
    const env = screen.getByTestId('card-verifyEnv')
    expect(env.parentElement).toBe(verify.parentElement)
    expect(before(env, screen.getByText(NOTE))).toBe(true)
  })

  it('a card placed in its block stays there when a note comes after it', async () => {
    const view = render(
      <Providers>
        <FlowTab snap={round({ status: 'running' })} />
      </Providers>,
    )
    await settle()
    view.rerender(
      <Providers>
        <FlowTab snap={round({ cards: [verifyEnvCard()] })} />
      </Providers>,
    )
    await settle()
    const verify = screen.getByTestId('pass-card-verify:1')
    expect(screen.getByTestId('card-verifyEnv').parentElement).toBe(verify.parentElement)
    view.rerender(
      <Providers>
        <FlowTab snap={round({ cards: [verifyEnvCard()], notes: [NOTE] })} />
      </Providers>,
    )
    await settle()
    const env = screen.getByTestId('card-verifyEnv')
    expect(env.parentElement).toBe(screen.getByTestId('pass-card-verify:1').parentElement)
    expect(before(env, screen.getByText(NOTE))).toBe(true)
  })
})

describe("a watched round keeps its reason's line", () => {
  it('as the round waits on a card, runs, and waits again', async () => {
    const at = (status: 'waiting' | 'running' | 'done', reason?: string): RunSnapshot =>
      snapWith({
        steps: {
          implement: { status: 'done', attempt: 1 },
          'verify:1': verifyStep({ status, commands: [], ...(reason !== undefined ? { reason } : {}) }),
        },
      })
    const show = (s: RunSnapshot): React.JSX.Element => (
      <Providers>
        <VerifyCard runId={RUN} snap={s} view={s.steps['verify:1']} />
      </Providers>
    )
    const view = render(show(at('waiting', 'trust needed')))
    await settle()
    const line = screen.getByTestId('pass-reason-verify:1')
    expect(line.textContent).toBe('trust needed')
    expect(line.className).toContain('h-4')
    view.rerender(show(at('running')))
    await settle()
    // The same line, empty: nothing under it moved.
    expect(screen.getByTestId('pass-reason-verify:1')).toBe(line)
    expect(line.textContent).toBe('')
    view.rerender(show(at('waiting', 'checks could not run')))
    await settle()
    expect(screen.getByTestId('pass-reason-verify:1')).toBe(line)
    expect(line.textContent).toBe('checks could not run')
    view.rerender(show(at('done')))
    await settle()
    expect(screen.getByTestId('pass-reason-verify:1')).toBe(line)
  })

  it('a round already over when its card mounts has no empty line', async () => {
    const s = snapWith({
      steps: { implement: { status: 'done', attempt: 1 }, 'verify:1': verifyStep({ commands: [] }) },
    })
    render(
      <Providers>
        <VerifyCard runId={RUN} snap={s} view={s.steps['verify:1']} />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('pass-reason-verify:1')).toBeNull()
  })
})

describe('a round over when its card mounts', () => {
  it("opens the first failure's excerpt only; the others open on a click", async () => {
    const lint = {
      name: 'lint',
      argv: ['pnpm', 'run', 'lint'],
      status: 'env' as const,
      exitCode: 127,
      durationMs: 300,
      reason: 'A program it runs was not found: eslint',
      excerpt: 'sh: 1: eslint: not found',
    }
    const s = snapWith({
      steps: {
        implement: { status: 'done', attempt: 1 },
        'verify:1': verifyStep({ commands: [TYPECHECK, TEST_FAIL, lint] }),
      },
    })
    render(
      <Providers>
        <VerifyCard runId={RUN} snap={s} view={s.steps['verify:1']} finishedAtOpen={false} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('verify-command-verify:1-1-excerpt').textContent).toContain('1 failed')
    expect(screen.queryByTestId('verify-command-verify:1-2-excerpt')).toBeNull()
    const toggle = screen.getByTestId('verify-command-verify:1-2-excerpt-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByTestId('verify-command-verify:1-2-excerpt').textContent).toContain('eslint: not found')
  })
})
