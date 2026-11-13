// Every Codex fixture frame against the generated protocol (the fixtures are synthesized
// from the 0.160 schema): each app-server message is valid for its own definition (a client request against
// ClientRequest, a reply against the result type of the request it answers…), each exec line is one of exec's eight
// JSONL events. The validator itself is checked on frames it must refuse.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  COMMITTED_BUNDLE,
  checkRecording,
  definitionRef,
  jsonRpcRecordings,
  typedFrames,
  validate,
} from '../../../../scripts/codex-fixture-check.mjs'
import { CODEX_FIXTURES, fixtureNames, loadFixture, message } from './fixtures.ts'

const bundle = JSON.parse(readFileSync(COMMITTED_BUNDLE, 'utf8')) as unknown

describe('app-server fixtures are valid 0.160 protocol', () => {
  const files = jsonRpcRecordings(CODEX_FIXTURES)

  it('covers every app-server fixture', () => {
    expect(files).toHaveLength(fixtureNames('app-server').length)
  })

  it.each(fixtureNames('app-server'))('%s', (name) => {
    const fx = loadFixture('app-server', name)
    expect(checkRecording(bundle, fx.text)).toEqual([])
    // Every response answers a request of the other side (typed), and every frame is JSON.
    const { frames } = typedFrames(fx.text)
    expect(frames.filter((f) => f.problem !== undefined || f.def === undefined)).toEqual([])
  })
})

describe('the validator refuses what the protocol refuses', () => {
  // The fileChange approval (synthesized X04b: on the live X04 the model wrote its file with a shell command, and a
  // command approval may carry an execpolicy amendment).
  const x04 = loadFixture('app-server', 'X04b-filechange-approval').text
  /** Replace inside the double-encoded `line` strings of the recording. */
  const edit = (text: string, from: string, to: string): string => {
    const enc = (s: string): string => JSON.stringify(s).slice(1, -1)
    expect(text).toContain(enc(from))
    return text.replace(enc(from), enc(to))
  }

  it('a decision Dim Factory must never send', () => {
    const bad = edit(
      x04,
      '"decision":"accept"',
      '"decision":{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[]}}',
    )
    expect(checkRecording(bundle, bad).join('\n')).toMatch(/item\/fileChange\/requestApproval/)
  })

  it('a sandbox spelled the way responses spell it', () => {
    const bad = edit(x04, '"sandbox":"workspace-write"', '"sandbox":"workspaceWrite"')
    expect(checkRecording(bundle, bad)).toEqual([
      expect.stringMatching(/thread\/start.*params\.sandbox: "workspaceWrite" not in/),
    ])
  })

  it('a turn/start without its thread', () => {
    const ref = definitionRef(bundle, 'TurnStartParams')
    expect(validate(bundle, { $ref: ref }, { input: [] })).toEqual(['$.threadId: required'])
  })

  it('a notification the protocol does not have', () => {
    const ref = definitionRef(bundle, 'ServerNotification')
    expect(validate(bundle, { $ref: ref }, { method: 'turn/finished', params: {} })).not.toEqual([])
    expect(
      validate(
        bundle,
        { $ref: ref },
        { method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', items: [], status: 'done' } } },
      ),
    ).toEqual(['$.params.turn.status: "done" not in ["completed","interrupted","failed","inProgress"]'])
  })

  it('a reply to an id nobody asked with', () => {
    const lines = x04.split('\n')
    const stray = JSON.stringify({ t: 0, dir: 'in', line: JSON.stringify({ id: 77, result: {} }) })
    expect(checkRecording(bundle, [...lines.slice(0, 3), stray, ...lines.slice(3)].join('\n'))).toEqual([
      expect.stringMatching(/answers an id no request of the other side used/),
    ])
  })
})

/** exec --json: ThreadEvent is serde-tagged with exactly these eight types (exec_events.rs). */
const EXEC_EVENTS: Record<string, (e: Record<string, unknown>) => boolean> = {
  'thread.started': (e) => typeof e['thread_id'] === 'string',
  'turn.started': () => true,
  'turn.completed': (e) => {
    const u = e['usage'] as Record<string, unknown> | undefined
    return ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'].every(
      (k) => typeof u?.[k] === 'number',
    )
  },
  'turn.failed': (e) => typeof (e['error'] as Record<string, unknown> | undefined)?.['message'] === 'string',
  'item.started': (e) => execItem(e['item']),
  'item.updated': (e) => execItem(e['item']),
  'item.completed': (e) => execItem(e['item']),
  error: (e) => typeof e['message'] === 'string',
}
const EXEC_ITEMS = new Set([
  'agent_message',
  'reasoning',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'collab_tool_call',
  'web_search',
  'todo_list',
  'error',
])
function execItem(item: unknown): boolean {
  const i = item as Record<string, unknown> | undefined
  return typeof i?.['id'] === 'string' && typeof i['type'] === 'string' && EXEC_ITEMS.has(i['type'])
}

describe('exec fixtures are exec --json', () => {
  it.each(fixtureNames('exec'))('%s', (name) => {
    const fx = loadFixture('exec', name)
    const outs = fx.frames.filter((f) => f.dir === 'out')
    for (const f of outs) {
      const e = message(f)
      expect(e, f.line).toBeDefined()
      const check = EXEC_EVENTS[String(e!['type'])]
      expect(check, `unknown exec event ${String(e!['type'])}`).toBeDefined()
      expect(check!(e!), f.line).toBe(true)
    }
    // When it prints anything, thread.started comes first (new, resumed or forked runs alike).
    if (outs.length > 0) expect(message(outs[0]!)!['type']).toBe('thread.started')
  })
})
