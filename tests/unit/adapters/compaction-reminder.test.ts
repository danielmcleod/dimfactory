// The post-compaction reminder's frames: Claude's initialize hook registration and hook answer, the normalizer handing
// only Dim Factory's own hook callback to the adapter, and Codex's turn/steer parameters (live C24a and X24 shapes).
import { describe, expect, it } from 'vitest'
import { ClaudeNormalizer } from '@core/adapters/claude/normalize.ts'
import { hookResponse, initializeRequest, sessionStartContext } from '@core/adapters/claude/protocol.ts'
import { steerParams } from '@core/adapters/codex/appserver.ts'

const callback = (rid: string, callbackId: string, source: string): string =>
  JSON.stringify({
    type: 'control_request',
    request_id: rid,
    request: {
      subtype: 'hook_callback',
      callback_id: callbackId,
      input: { hook_event_name: 'SessionStart', source },
    },
  })

describe('claude: the reminder hook', () => {
  it('initialize carries the hooks only when given', () => {
    expect(initializeRequest('i').request).not.toHaveProperty('hooks')
    const hooks = { SessionStart: [{ hookCallbackIds: ['compaction-reminder'] }] }
    expect(initializeRequest('i', { hooks }).request).toEqual({ subtype: 'initialize', hooks })
  })

  it('the answer adds the reminder as SessionStart additionalContext', () => {
    expect(hookResponse('h1', sessionStartContext('keep to the plan'))).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'h1',
        response: {
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'keep to the plan' },
        },
      },
    })
    expect(hookResponse('h2', {}).response).toEqual({ subtype: 'success', request_id: 'h2', response: {} })
  })

  it('the normalizer hands its own callback to the adapter and keeps others unsupported', () => {
    const n = new ClaudeNormalizer({
      route: 'edit',
      askTimeoutMs: 1000,
      now: () => 0,
      reminderHookId: 'compaction-reminder',
    })
    const own = n.line(callback('h1', 'compaction-reminder', 'compact'))
    expect(own.hook).toEqual({ requestId: 'h1', source: 'compact' })
    expect(own.stdin).toEqual([])
    const other = n.line(callback('h2', 'someone-else', 'compact'))
    expect(other.hook).toBeUndefined()
    expect(other.stdin).toMatchObject([
      { type: 'control_response', response: { subtype: 'error', request_id: 'h2' } },
    ])
  })

  it('without a registered hook every callback stays unsupported', () => {
    const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000, now: () => 0 })
    const s = n.line(callback('h1', 'compaction-reminder', 'compact'))
    expect(s.hook).toBeUndefined()
    expect(s.stdin).toMatchObject([
      {
        type: 'control_response',
        response: { subtype: 'error', error: 'Unsupported by Dim Factory: hook_callback' },
      },
    ])
  })
})

describe('codex: the reminder steer', () => {
  it('turn/steer sends the reminder as a text input of the running turn (no experimental field)', () => {
    expect(steerParams('th', 'tu', 'keep to the plan')).toEqual({
      threadId: 'th',
      expectedTurnId: 'tu',
      input: [{ type: 'text', text: 'keep to the plan', text_elements: [] }],
    })
  })
})
