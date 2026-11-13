// Session wording parity (sessions, the PassCard's session line): the notes SessionLine reads back
// are core's own (supervisor/sessions.ts SESSION_NOTE, machine.ts's ignored-resume note), and every FreshReason has
// its line words and a one-sentence "Why?".
import { describe, expect, it } from 'vitest'
import { FRESH_REASONS } from '@shared/run.ts'
import {
  SESSION_NOTE_TEXT,
  freshLineText,
  freshReasonWhy,
  sessionFactsOf,
  shortSessionId,
} from '@renderer/components/run/SessionLine.tsx'
import { FRESH_REASON_TEXT } from '@renderer/components/run/text.ts'
import coreMachine from '../../../src/core/supervisor/machine.ts?raw'
import coreSessions from '../../../src/core/supervisor/sessions.ts?raw'

/** The `export const SESSION_NOTE = {` … `} as const` block of core's sessions.ts. */
function sessionNoteBlock(): string {
  const start = coreSessions.indexOf('const SESSION_NOTE')
  expect(start).toBeGreaterThan(-1)
  const end = coreSessions.indexOf('\n}', start)
  return coreSessions.slice(start, end)
}

describe("core's session notes", () => {
  it('reads the notes SESSION_NOTE builds, word for word', () => {
    const block = sessionNoteBlock()
    expect(block).toContain(`reusedImplement: '${SESSION_NOTE_TEXT.reusedImplement}'`)
    expect(block).toContain(`resumed: '${SESSION_NOTE_TEXT.resumed}'`)
    expect(block).toContain(`\`${SESSION_NOTE_TEXT.freshPrefix}\${FRESH_REASON_TEXT[reason]}\``)
  })

  it('knows the note core writes when the CLI ignored --resume', () => {
    expect(coreMachine).toContain(`'${SESSION_NOTE_TEXT.resumeIgnored}'`)
  })

  it('reads every note back to the facts it was built from; an unknown note stays as core wrote it', () => {
    expect(sessionFactsOf({})).toBeNull()
    expect(sessionFactsOf({ sessionNote: '' })).toBeNull()
    expect(sessionFactsOf({ sessionNote: 'reused the Implement session' })).toEqual({ kind: 'reused' })
    expect(sessionFactsOf({ sessionNote: 'resumed the previous session' })).toEqual({ kind: 'resumed' })
    expect(sessionFactsOf({ sessionNote: SESSION_NOTE_TEXT.resumeIgnored })).toEqual({
      kind: 'resume-ignored',
    })
    for (const reason of FRESH_REASONS) {
      expect(sessionFactsOf({ sessionNote: `fresh session: ${FRESH_REASON_TEXT[reason]}` })).toEqual({
        kind: 'fresh',
        reason,
      })
    }
    expect(sessionFactsOf({ sessionNote: 'fresh session: something new' })).toEqual({
      kind: 'note',
      text: 'fresh session: something new',
    })
    expect(sessionFactsOf({ sessionNote: 'kept the session' })).toEqual({
      kind: 'note',
      text: 'kept the session',
    })
  })
})

describe('wording', () => {
  it('gives every FreshReason distinct line words and its own one-sentence Why', () => {
    const lines = new Set<string>()
    const whys = new Set<string>()
    for (const reason of FRESH_REASONS) {
      const line = freshLineText(reason)
      expect(line).toBe(`Fresh session: ${FRESH_REASON_TEXT[reason]}`)
      lines.add(line)
      const why = freshReasonWhy(reason, { vendor: 'Codex', implementVendor: 'Claude' })
      expect(why).toMatch(/^[A-Z].*\.$/)
      // One sentence (a second one only for resume-failed's "did not use the retry"), no flags or ids.
      expect(why.split('. ').length).toBeLessThanOrEqual(reason === 'resume-failed' ? 2 : 1)
      expect(why).not.toMatch(/--|FreshReason|reuseSession|canResume/)
      whys.add(why)
    }
    expect(lines.size).toBe(FRESH_REASONS.length)
    expect(whys.size).toBe(FRESH_REASONS.length)
  })

  it('names the vendors when they are known and still reads without them', () => {
    expect(freshReasonWhy('vendor-differs', { vendor: 'Codex', implementVendor: 'Claude' })).toBe(
      'Fix runs on Codex, Implement ran on Claude; a session cannot move between vendors.',
    )
    expect(
      freshReasonWhy('vendor-differs', { vendor: 'Codex', implementVendor: 'Claude', planned: true }),
    ).toBe('Fix runs on Codex, Implement runs on Claude; a session cannot move between vendors.')
    expect(freshReasonWhy('vendor-differs')).toBe(
      'Fix and Implement run on different vendors; a session cannot move between vendors.',
    )
    expect(freshReasonWhy('cannot-resume')).toBe(
      "The vendor CLI no longer has Implement's conversation (it may have been cleaned up).",
    )
    expect(freshReasonWhy('override-other-vendor')).toBe(
      'You chose to run Fix on a different vendor; a session cannot move between vendors.',
    )
  })

  it('names the pass that was resumed when it is not Fix', () => {
    expect(freshReasonWhy('resume-failed', { step: 'implement', vendor: 'Claude' })).toBe(
      'Claude rejected the session; Implement started fresh. This did not use the retry.',
    )
    expect(freshReasonWhy('cannot-resume', { step: 'implement', vendor: 'Claude' })).toBe(
      'Claude no longer has the earlier Implement conversation (it may have been cleaned up).',
    )
    expect(freshReasonWhy('no-session', { step: 'review' })).toBe(
      'There is no earlier Review session to continue.',
    )
  })

  it('shortens a session id to its first group and keeps short ids whole', () => {
    expect(shortSessionId('fa4e849c-3bb9-4cdb-8305-645bafbe57ea')).toBe('fa4e849c')
    expect(shortSessionId('thread-1')).toBe('thread-1')
  })
})
