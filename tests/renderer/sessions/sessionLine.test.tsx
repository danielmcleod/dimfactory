// The session line on the PassCard (sessions; the flow "understand why Fix
// started fresh from the card line"): every FreshReason shows its words and a "Why?" sentence; a reused session shows
// its short id with a copy button; a pass core resumed (a paused Implement, P19) has the line too.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FreshReason, RunEnvelope, RunSnapshot, StepKey } from '@shared/run.ts'
import { FRESH_REASONS } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, ev } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith, stubClipboard } from '../run/helpers.tsx'

const IMPL_SESSION = 'fa4e849c-3bb9-4cdb-8305-645bafbe57ea'

/** Core's notes (supervisor/sessions.ts SESSION_NOTE; parity.test.ts keeps the renderer's copy equal). */
const CORE_REASON_TEXT: Record<FreshReason, string> = {
  'vendor-differs': 'Fix vendor differs',
  'no-session': 'no session to continue',
  'cannot-resume': 'the session cannot be resumed',
  'cwd-changed': 'the folder changed',
  'model-differs': 'the model differs',
  'override-fresh': 'set to start fresh',
  'override-other-vendor': 'set to a different vendor',
  'resume-failed': 'resuming failed',
  'implement-skipped': 'Implement was skipped',
  'context-heavy': 'the Implement session was nearly full',
  'plan-skipped': 'Plan was skipped',
  'plan-vendor-differs': 'Plan ran on another vendor',
  'mode-switch-unsupported': 'the vendor cannot change the mode of a resumed session',
}

/** What "Why?" says on Fix's card, Fix on Codex and Implement on Claude (model-differs: both on Claude). */
const WHY_ON_FIX: Record<FreshReason, string> = {
  'vendor-differs': 'Fix runs on Codex, Implement ran on Claude; a session cannot move between vendors.',
  'model-differs': 'Fix uses a different model and Claude cannot switch models when resuming.',
  'cwd-changed':
    'Fix runs in a different folder than Implement did, and a session stays with the folder it started in.',
  'cannot-resume': "Claude no longer has Implement's conversation (it may have been cleaned up).",
  'resume-failed': 'Claude rejected the session; Fix started fresh. This did not use the retry.',
  'override-fresh': "You chose a fresh session for Fix instead of continuing Implement's.",
  'override-other-vendor': 'You chose to run Fix on Codex; a session cannot move between vendors.',
  'implement-skipped': 'Implement was skipped, so there is no session for Fix to continue.',
  'no-session': 'Implement did not finish with a session for Fix to continue.',
  'context-heavy':
    "Implement's session ended nearly full or summarised its notes more than once, so Fix started clean.",
  'plan-skipped': 'Plan did not run, so there is no Plan session for Implement to continue.',
  'plan-vendor-differs':
    'Plan and Implement run on different vendors; a session cannot move between vendors.',
  'mode-switch-unsupported':
    "Claude cannot switch a resumed session from Plan's read-only mode to editing, so Implement started a new one.",
}

/** Fix's vendor for a reason: a different vendor where the reason is about vendors, else Implement's. */
const FIX_VENDOR = (r: FreshReason): string =>
  r === 'vendor-differs' || r === 'override-other-vendor' ? 'codex' : 'claude'

let mock: MockDimFactory
let log: RunEnvelope[]

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  log = []
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

function card(snap: RunSnapshot, step: StepKey): ReturnType<typeof renderUi> {
  return renderUi(<PassCard runId={RUN} snap={snap} view={snap.steps[step]} />)
}

const textOf = (id: string): string | null => screen.getByTestId(id).textContent

function fixSnap(
  sessionNote: string | undefined,
  fixVendor = 'claude',
  status: 'running' | 'done' = 'running',
): RunSnapshot {
  return snapWith({
    steps: {
      implement: { status: 'done', attempt: 1, vendor: 'claude', activeMs: 60_000 },
      fix: {
        status,
        attempt: 1,
        vendor: fixVendor,
        ...(sessionNote !== undefined ? { sessionNote } : {}),
      },
    },
  })
}

describe('a fresh Fix says why', () => {
  it.each(FRESH_REASONS.map((r) => [r]))('%s: the line words and the Why sentence', async (reason) => {
    // A finished Fix (no launch line reading the log), so the last check below is about the session line alone.
    const view = card(
      fixSnap(`fresh session: ${CORE_REASON_TEXT[reason]}`, FIX_VENDOR(reason), 'done'),
      'fix',
    )
    const line = screen.getByTestId('session-line-fix')
    expect(line.getAttribute('data-session')).toBe('fresh')
    expect(line.getAttribute('data-reason')).toBe(reason)
    expect(textOf('fix-session-line')).toBe(`Fresh session: ${CORE_REASON_TEXT[reason]}`)
    // The sentence is behind "Why?" until asked for.
    const toggle = screen.getByTestId('session-why-fix-toggle')
    expect(toggle.textContent).toBe('Why?')
    expect(toggle.getAttribute('aria-label')).toBe('Why Fix started a fresh session')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('session-why-fix')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const why = screen.getByTestId('session-why-fix')
    expect(why.textContent).toBe(WHY_ON_FIX[reason])
    expect(toggle.getAttribute('aria-controls')).toBe(why.id)
    // No session id or copy button on a fresh line (it is not a continued session).
    expect(screen.queryByTestId('session-copy-fix')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.queryByTestId('session-why-fix')).toBeNull()
    await act(() => settle())
    // A fresh line never reads the run log for a session id.
    expect(mock.callsOf('runs.events')).toEqual([])
    view.unmount()
  })

  it('says what happened when the CLI ignored the resume, without the flag', () => {
    card(fixSnap('the CLI ignored --resume and started a fresh session'), 'fix')
    expect(textOf('fix-session-line')).toBe('Session: the CLI ignored --resume and started a fresh session')
    fireEvent.click(screen.getByTestId('session-why-fix-toggle'))
    expect(textOf('session-why-fix')).toBe(
      'Claude did not continue the earlier session and started a new one, so Fix does not have that conversation.',
    )
  })

  it('shows a note this build does not know as core wrote it, with no Why', () => {
    card(fixSnap('kept the session for later'), 'fix')
    expect(textOf('fix-session-line')).toBe('Session: kept the session for later')
    expect(screen.getByTestId('session-line-fix').getAttribute('data-session')).toBe('note')
    expect(screen.queryByTestId('session-why-fix-toggle')).toBeNull()
  })

  it('has no session line before core states one', () => {
    card(fixSnap(undefined), 'fix')
    expect(screen.queryByTestId('session-line-fix')).toBeNull()
    expect(screen.queryByTestId('fix-session-line')).toBeNull()
  })
})

describe('a reused or resumed session shows its id', () => {
  it("reused: Implement's session id, shortened, with a copy button that copies all of it", async () => {
    const clip = stubClipboard()
    log = [
      env(RUN, 1, { t: 'step-status', step: 'implement', attempt: 1, status: 'running' }),
      env(RUN, 2, ev('implement', { type: 'session', id: IMPL_SESSION })),
      env(RUN, 3, { t: 'step-status', step: 'fix', attempt: 1, status: 'running' }),
    ]
    card(fixSnap('reused the Implement session'), 'fix')
    expect(textOf('fix-session-line')).toBe('Session: reused the Implement session')
    expect(screen.getByTestId('session-line-fix').getAttribute('data-session')).toBe('reused')
    await act(() => settle())
    const id = screen.getByTestId('session-id-fix')
    expect(id.textContent).toBe('fa4e849c')
    expect(id.getAttribute('title')).toBe(IMPL_SESSION)
    const copy = screen.getByTestId('session-copy-fix')
    expect(copy.getAttribute('aria-label')).toBe('Copy the session id')
    await act(async () => {
      fireEvent.click(copy)
      await settle()
    })
    expect(clip.writes).toEqual([IMPL_SESSION])
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain(
      'Session id copied to the clipboard',
    )
    // The words alone are unchanged by the id and the button (full-run.spec.ts reads them).
    expect(textOf('fix-session-line')).toBe('Session: reused the Implement session')
    expect(screen.queryByTestId('session-why-fix-toggle')).toBeNull()
  })

  it("reused: Fix's own report wins once it arrives", async () => {
    log = [
      env(RUN, 1, ev('implement', { type: 'session', id: IMPL_SESSION })),
      env(RUN, 2, ev('fix', { type: 'session', id: 'f1c0ffee-0000-4000-8000-000000000001' })),
    ]
    card(fixSnap('reused the Implement session'), 'fix')
    await act(() => settle())
    expect(textOf('session-id-fix')).toBe('f1c0ffee')
  })

  it('reused before any session was reported: the line without an id', async () => {
    card(fixSnap('reused the Implement session'), 'fix')
    await act(() => settle())
    expect(textOf('fix-session-line')).toBe('Session: reused the Implement session')
    expect(screen.queryByTestId('session-id-fix')).toBeNull()
    expect(screen.queryByTestId('session-copy-fix')).toBeNull()
  })

  it('a paused Implement resumed has the line too, with its own session id', async () => {
    log = [
      env(RUN, 1, ev('implement', { type: 'session', id: IMPL_SESSION })),
      env(RUN, 2, ev('review', { type: 'session', id: 'aaaaaaaa-0000-4000-8000-000000000002' })),
    ]
    const snap = snapWith({
      steps: {
        implement: {
          status: 'running',
          attempt: 1,
          vendor: 'claude',
          sessionNote: 'resumed the previous session',
        },
        review: { status: 'queued', attempt: 0 },
      },
    })
    card(snap, 'implement')
    expect(textOf('implement-session-line')).toBe('Session: resumed the previous session')
    expect(screen.getByTestId('session-line-implement').getAttribute('data-session')).toBe('resumed')
    await act(() => settle())
    expect(textOf('session-id-implement')).toBe('fa4e849c')
  })

  it("a resumed pass that had to start fresh says so in the pass's own name", () => {
    const snap = snapWith({
      steps: {
        implement: {
          status: 'running',
          attempt: 1,
          vendor: 'claude',
          sessionNote: 'fresh session: resuming failed',
        },
      },
    })
    card(snap, 'implement')
    expect(textOf('implement-session-line')).toBe('Fresh session: resuming failed')
    fireEvent.click(screen.getByTestId('session-why-implement-toggle'))
    expect(textOf('session-why-implement')).toBe(
      'Claude rejected the session; Implement started fresh. This did not use the retry.',
    )
  })

  it('a pass without a note has no session line', () => {
    const snap = snapWith({ steps: { review: { status: 'running', attempt: 1, vendor: 'claude' } } })
    card(snap, 'review')
    expect(screen.queryByTestId('session-line-review')).toBeNull()
  })
})
