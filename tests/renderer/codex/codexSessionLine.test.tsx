// Fix's session line across vendors (sessions: "Codex: from the thread/start response, before
// turn/start"; "Fix resumes the Codex thread"; cross-vendor.spec.ts; the PassCard's session line). A Fix that continues
// Implement's Codex thread names it ("Codex thread 0199a213" with the whole id in its tooltip and a copy button); a
// fresh Fix on another vendor says why in the vendors' names. Core's words on the line are unchanged.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { sessionIdTitle, sessionNoun } from '@renderer/components/run/SessionLine.tsx'
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

/** A Codex thread id (UUID v7, as thread/start answers it). */
const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53'

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

function snap(note: string, implement: string, fix: string): RunSnapshot {
  return snapWith({
    steps: {
      implement: { status: 'done', attempt: 1, vendor: implement, activeMs: 60_000 },
      fix: { status: 'done', attempt: 1, vendor: fix, sessionNote: note },
    },
  })
}

const textOf = (id: string): string | null => screen.getByTestId(id).textContent

describe('Fix resumes the Codex thread', () => {
  it('names the thread before its id; the tooltip and the copy say thread', async () => {
    const clip = stubClipboard()
    log = [
      env(RUN, 1, { t: 'step-status', step: 'implement', attempt: 1, status: 'running' }),
      env(RUN, 2, ev('implement', { type: 'session', id: THREAD })),
      env(RUN, 3, { t: 'step-status', step: 'fix', attempt: 1, status: 'running' }),
    ]
    const s = snap('reused the Implement session', 'codex', 'codex')
    renderUi(<PassCard runId={RUN} snap={s} view={s.steps.fix} />)
    await act(() => settle())
    // Core's words stay as they are (full-run.spec.ts and cross-vendor.spec.ts read them).
    expect(textOf('fix-session-line')).toBe('Session: reused the Implement session')
    expect(textOf('session-kind-fix')).toBe('Codex thread')
    const id = screen.getByTestId('session-id-fix')
    expect(id.textContent).toBe('0199a213')
    expect(id.getAttribute('title')).toBe(`Codex thread ${THREAD}`)
    const copy = screen.getByTestId('session-copy-fix')
    expect(copy.getAttribute('aria-label')).toBe('Copy the thread id')
    await act(async () => {
      fireEvent.click(copy)
      await settle()
    })
    expect(clip.writes).toEqual([THREAD])
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain(
      'Thread id copied to the clipboard',
    )
  })

  it('a Claude session keeps its words (no thread label)', async () => {
    log = [env(RUN, 1, ev('implement', { type: 'session', id: 'fa4e849c-3bb9-4cdb-8305-645bafbe57ea' }))]
    const s = snap('reused the Implement session', 'claude', 'claude')
    renderUi(<PassCard runId={RUN} snap={s} view={s.steps.fix} />)
    await act(() => settle())
    expect(screen.queryByTestId('session-kind-fix')).toBeNull()
    expect(screen.getByTestId('session-copy-fix').getAttribute('aria-label')).toBe('Copy the session id')
  })

  it('a local model runs on Codex: its session is a thread too', () => {
    expect(sessionNoun('codex')).toBe('thread')
    expect(sessionNoun('local-qwen')).toBe('thread')
    expect(sessionNoun('claude')).toBe('session')
    expect(sessionNoun(undefined)).toBe('session')
    expect(sessionIdTitle('local-qwen', THREAD)).toBe(`Local model (qwen) thread ${THREAD}`)
  })
})

describe('a fresh Fix across vendors says why in the vendors’ names', () => {
  it.each([
    [
      'fresh session: Fix vendor differs',
      'codex',
      'claude',
      'Fresh session: Fix vendor differs',
      'Fix runs on Claude, Implement ran on Codex; a session cannot move between vendors.',
    ],
    [
      'fresh session: set to a different vendor',
      'codex',
      'claude',
      'Fresh session: set to a different vendor',
      'You chose to run Fix on Claude; a session cannot move between vendors.',
    ],
    [
      'fresh session: the session cannot be resumed',
      'codex',
      'codex',
      'Fresh session: the session cannot be resumed',
      "Codex no longer has Implement's conversation (it may have been cleaned up).",
    ],
  ])('%s (Implement %s, Fix %s)', (note, implement, fix, line, why) => {
    const s = snap(note, implement, fix)
    renderUi(<PassCard runId={RUN} snap={s} view={s.steps.fix} />)
    expect(textOf('fix-session-line')).toBe(line)
    fireEvent.click(screen.getByTestId('session-why-fix-toggle'))
    expect(textOf('session-why-fix')).toBe(why)
    // A fresh line names no thread.
    expect(screen.queryByTestId('session-kind-fix')).toBeNull()
  })
})
