// Integration (the composer's Fix row, the pass.fix.resume check, sessions): core's
// pass.fix.resume now reports both outcomes ("Fix will continue Implement's session" / "Fix will start fresh:
// <reason>"). Under a fresh choice the Fix row already shows core's reason as the card's session line, so the note
// keeps only the check's detail instead of saying the reason a second time; Reuse keeps `title · detail`.
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FreshReason } from '@shared/run.ts'
import { FRESH_REASONS } from '@shared/run.ts'
import { FRESH_REASON_TEXT } from '@renderer/components/run/text.ts'
import { FixSessionSelect, fixResumeNote } from '@renderer/pages/dashboard/composer/FixRow.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, setUp, tearDown } from '../dashboard/setup.tsx'
import { check } from '../composer/fixtures.tsx'

let mock: MockDimFactory
beforeEach(() => {
  mock = setUp({ handlers: {} })
})
afterEach(() => tearDown(mock))

/** pass.fix.resume as core words it (src/core/preflight/checks/pass.ts). */
const REUSE = check('pass.fix.resume', {
  title: "Fix will continue Implement's session",
  detail: 'Claude resumes the session Implement leaves, so Fix keeps Implement’s context.',
})
const fresh = (reason: FreshReason, detail = `Detail for ${reason}.`) =>
  check('pass.fix.resume', { title: `Fix will start fresh: ${FRESH_REASON_TEXT[reason]}`, detail })

describe('fixResumeNote', () => {
  it('is null without a check', () => {
    expect(fixResumeNote(null, undefined)).toBeNull()
    expect(fixResumeNote(null, 'override-fresh')).toBeNull()
  })

  it('Reuse: title · detail', () => {
    expect(fixResumeNote(REUSE, undefined)).toBe(`${REUSE.title} · ${REUSE.detail}`)
  })

  it.each(FRESH_REASONS.map((r) => [r]))('%s: only the detail when the line says the same reason', (r) => {
    expect(fixResumeNote(fresh(r), r)).toBe(`Detail for ${r}.`)
  })

  it('keeps the title while core’s two answers disagree (one resolved before the other)', () => {
    expect(fixResumeNote(REUSE, 'override-fresh')).toBe(`${REUSE.title} · ${REUSE.detail}`)
    expect(fixResumeNote(fresh('vendor-differs'), 'override-fresh')).toBe(
      'Fix will start fresh: Fix vendor differs · Detail for vendor-differs.',
    )
  })

  it('a fresh check with no detail of its own adds nothing to the line', () => {
    expect(fixResumeNote(fresh('override-fresh', ''), 'override-fresh')).toBeNull()
    const same = check('pass.fix.resume', {
      title: 'Fix will start fresh: set to start fresh',
      detail: 'Fix will start fresh: set to start fresh',
    })
    expect(fixResumeNote(same, 'override-fresh')).toBeNull()
    expect(fixResumeNote(same, undefined)).toBe(same.title)
  })
})

describe('the Fix row says core’s fresh reason once', () => {
  it('Fresh: the session line, then only the check’s detail', () => {
    const detail =
      "The Fix session is set to start fresh: it gets the task, the plan and the changes so far instead of continuing Implement's conversation."
    render(
      <Providers>
        <FixSessionSelect
          value="fresh"
          otherVendor={null}
          resumeCheck={fresh('override-fresh', detail)}
          reason="override-fresh"
          fixVendor="Claude"
          implementVendor="Claude"
          onChange={() => undefined}
        />
      </Providers>,
    )
    expect(screen.getByTestId('fix-session-reason-text').textContent).toBe(
      'Fresh session: set to start fresh',
    )
    expect(screen.getByTestId('fix-session-note').textContent).toBe(detail)
    expect(screen.getByTestId('fix-session-note').textContent).not.toContain('Fix will start fresh')
  })

  it('Reuse: no line, the check’s title and detail', () => {
    render(
      <Providers>
        <FixSessionSelect value="reuse" otherVendor={null} resumeCheck={REUSE} onChange={() => undefined} />
      </Providers>,
    )
    expect(screen.queryByTestId('fix-session-reason')).toBeNull()
    expect(screen.getByTestId('fix-session-note').textContent).toBe(`${REUSE.title} · ${REUSE.detail}`)
  })

  it('no note when the fresh check only repeats the line', () => {
    render(
      <Providers>
        <FixSessionSelect
          value="fresh"
          otherVendor={null}
          resumeCheck={fresh('override-fresh', '')}
          reason="override-fresh"
          onChange={() => undefined}
        />
      </Providers>,
    )
    expect(screen.getByTestId('fix-session-reason')).toBeTruthy()
    expect(screen.queryByTestId('fix-session-note')).toBeNull()
  })
})
