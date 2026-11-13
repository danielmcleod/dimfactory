// Review (the PassCard session line's Why?, the composer's Fix row; sessions): the "Why?" words
// the rule core says decided a fresh start, never a guess.
//   - cannot-resume: in the composer (before a run core decides it only from the vendor's capability) and on a card
//     whose StepView.freshDetail is `vendor-cannot-resume`, it says the vendor cannot continue a session — the words
//     of core's `pass.fix.resume` detail; otherwise (canResume found the session gone) it says the conversation is gone
//   - resume-failed: "This did not use the retry." only for the free fallback; `new-attempt` says it began a new one
import '../helpers/rtl.ts'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckResult } from '@shared/preflight.ts'
import type { FreshDetail, FreshReason, RunSnapshot } from '@shared/run.ts'
import { FRESH_DETAILS, FRESH_DETAIL_REASON } from '@shared/run.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { freshReasonWhy } from '@renderer/components/run/SessionLine.tsx'
import { FRESH_REASON_TEXT } from '@renderer/components/run/text.ts'
import { FixSessionSelect, fixResumeNote } from '@renderer/pages/dashboard/composer/FixRow.tsx'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { RUN, snapWith } from '../run/helpers.tsx'
import corePass from '../../../src/core/preflight/checks/pass.ts?raw'

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'runs.events': () => ({ events: [], lastSeq: 0, more: false }),
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'no output')
      },
    },
  })
})

afterEach(() => tearDown(mock))

const textOf = (id: string): string | null => screen.getByTestId(id).textContent

/** A finished run whose Fix (on `fixVendor`) started fresh for `reason`, with core's `detail`. */
function freshFix(reason: FreshReason, detail?: FreshDetail, fixVendor = 'claude', attempt = 1): RunSnapshot {
  return snapWith({
    summary: { status: 'completed', phase: 'done', outcome: 'fixed' },
    steps: {
      implement: { status: 'done', attempt: 1, vendor: 'claude', activeMs: 60_000 },
      fix: {
        status: 'done',
        attempt,
        vendor: fixVendor,
        activeMs: 30_000,
        sessionNote: `fresh session: ${FRESH_REASON_TEXT[reason]}`,
        ...(detail !== undefined ? { freshDetail: detail } : {}),
      },
    },
  })
}

async function cardWhy(snap: RunSnapshot): Promise<{ line: string; why: string }> {
  const view = render(
    <Providers>
      <PassCard runId={RUN} snap={snap} view={snap.steps.fix} />
    </Providers>,
  )
  await settle()
  fireEvent.click(screen.getByTestId('session-why-fix-toggle'))
  const out = { line: textOf('fix-session-line') ?? '', why: textOf('session-why-fix') ?? '' }
  view.unmount()
  return out
}

describe('cannot-resume says the rule that decided it', () => {
  it('in the composer: the vendor cannot continue a session — core’s pass.fix.resume detail, word for word', () => {
    // Core's own sentence (pass.ts why['cannot-resume']), and the renderer's for the same vendor.
    expect(corePass).toContain(
      "'cannot-resume': `${fixName} cannot continue a session, so Fix starts a new one.`",
    )
    const planned = freshReasonWhy('cannot-resume', {
      vendor: 'Codex',
      implementVendor: 'Codex',
      planned: true,
    })
    expect(planned).toBe('Codex cannot continue a session, so Fix starts a new one.')
    expect(planned).not.toMatch(/no longer has|cleaned up/)
  })

  it('in the Fix row the Why and the check’s note agree (no transcript story under a capability note)', () => {
    const resumeCheck: CheckResult = {
      id: 'pass.fix.resume',
      scope: 'pass',
      status: 'pass',
      blocking: false,
      title: 'Fix will start fresh: the session cannot be resumed',
      detail: 'Codex cannot continue a session, so Fix starts a new one.',
      recovery: [],
      at: 0,
      ttlMs: 0,
    }
    render(
      <Providers>
        <FixSessionSelect
          value="fresh"
          otherVendor={null}
          resumeCheck={resumeCheck}
          reason="cannot-resume"
          fixVendor="Codex"
          implementVendor="Codex"
          onChange={() => undefined}
        />
      </Providers>,
    )
    expect(textOf('fix-session-reason-text')).toBe('Fresh session: the session cannot be resumed')
    fireEvent.click(screen.getByTestId('fix-session-reason-why-toggle'))
    const why = textOf('fix-session-reason-why')
    expect(why).toBe(resumeCheck.detail)
    expect(textOf('fix-session-note')).toBe(fixResumeNote(resumeCheck, 'cannot-resume'))
    expect(textOf('fix-session-note')).toBe(why)
  })

  it('on the card with core’s vendor-cannot-resume: the vendor cannot continue a session, in the past tense', async () => {
    const { line, why } = await cardWhy(freshFix('cannot-resume', 'vendor-cannot-resume', 'codex'))
    expect(line).toBe('Fresh session: the session cannot be resumed')
    expect(why).toBe('Codex cannot continue a session, so Fix started a new one.')
  })

  it('on the card without a detail (canResume found it gone): the conversation is gone', async () => {
    const { why } = await cardWhy(freshFix('cannot-resume'))
    expect(why).toBe("Claude no longer has Implement's conversation (it may have been cleaned up).")
  })
})

describe('resume-failed says whether the retry was used', () => {
  it('the free fallback (no detail): "This did not use the retry."', async () => {
    const { why } = await cardWhy(freshFix('resume-failed'))
    expect(why).toBe('Claude rejected the session; Fix started fresh. This did not use the retry.')
  })

  it('a new attempt (core’s new-attempt, attempt 2): says so and never claims the retry is unused', async () => {
    const { line, why } = await cardWhy(freshFix('resume-failed', 'new-attempt', 'claude', 2))
    expect(line).toBe('Fresh session: resuming failed')
    expect(why).toBe('Claude rejected the session; Fix started fresh in a new attempt.')
    expect(why).not.toMatch(/did not use the retry/)
  })

  it('names the pass when it is not Fix', () => {
    expect(
      freshReasonWhy('resume-failed', { step: 'implement', vendor: 'Claude', detail: 'new-attempt' }),
    ).toBe('Claude rejected the session; Implement started fresh in a new attempt.')
  })
})

describe('a detail only changes the reason it belongs to', () => {
  it('every detail pairs with one reason; on any other reason the Why is the usual one', () => {
    for (const detail of FRESH_DETAILS) {
      const own = FRESH_DETAIL_REASON[detail]
      const ctx = { vendor: 'Codex', implementVendor: 'Claude' }
      expect(freshReasonWhy(own, { ...ctx, detail })).not.toBe(freshReasonWhy(own, ctx))
      for (const reason of Object.keys(FRESH_REASON_TEXT) as FreshReason[]) {
        if (reason === own) continue
        expect(freshReasonWhy(reason, { ...ctx, detail })).toBe(freshReasonWhy(reason, ctx))
      }
    }
  })
})
