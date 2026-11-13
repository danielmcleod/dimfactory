// Self-heal input: a property test that the healer's input never contains the task, plan, diff or any file
// body, even when they appear in the raw log. Marker strings stand for each; they are placed in every kind of content
// a vendor log carries (the prompt on stdin, deltas, assistant text and tool calls, tool results, ask inputs, the final
// answer, sub-agent prompts, Codex items/diffs/plans/approvals, ACP updates and file calls) and in unknown fields of
// status frames, in raw-log records and bare lines alike, and in the classifier's `raw`. The rendered prompt must hold
// none of them, while the stderr and status evidence still gets through.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { RedactOptions } from '@shared/redact.ts'
import type { HealEnv } from '@core/heal/heal-input.ts'
import { HEAL_STRING_MAX, buildHealInput, filterHealTail } from '@core/heal/heal-input.ts'
import type { HealRequest } from '@core/heal/healer.ts'
import { readHealTemplate } from '@core/heal/healer.ts'
import { render } from '@core/prompts/template.ts'

const R: RedactOptions = { mode: 'heal', home: '/home/tester', username: 'tester', hostname: 'devbox' }
const ENV: HealEnv = {
  os: 'linux',
  osRelease: '6.8.0',
  arch: 'x64',
  shell: 'bash',
  node: '24.11.0',
  git: '2.43.0',
}

interface Secrets {
  task: string
  plan: string
  diff: string
  body: string
}

/** Content with a marker inside arbitrary text (quotes, braces, newlines, unicode included). */
const wrapped = (marker: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc
    .tuple(fc.string({ maxLength: 40 }), marker, fc.string({ maxLength: 40 }))
    .map(([a, m, b]) => `${a}${m}${b}`)

const markerArb = (tag: string): fc.Arbitrary<string> =>
  fc.stringMatching(/^[a-z0-9]{14,20}$/).map((s) => `Q${tag}${s}`)

const secretsArb: fc.Arbitrary<Secrets> = fc.record({
  task: markerArb('TASK'),
  plan: markerArb('PLAN'),
  diff: markerArb('DIFF'),
  body: markerArb('BODY'),
})

type Dir = 'in' | 'out'
type Frame = [Dir, unknown]

/** Every content-carrying frame shape, each holding one or more secrets (`t` = wrapped text with a marker). */
function contentFrames(s: Secrets, t: (m: string) => string): Frame[] {
  const prompt = `Task:\n${t(s.task)}\nPlan:\n${t(s.plan)}\n<diff>\n${t(s.diff)}\n</diff>`
  return [
    // Claude stream-json
    [
      'in',
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        parent_tool_use_id: null,
      },
    ],
    [
      'out',
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t(s.plan) } },
      },
    ],
    [
      'out',
      { type: 'assistant', message: { content: [{ type: 'text', text: t(s.task) }] }, session_id: 's' },
    ],
    [
      'out',
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'a.ts', content: t(s.body) } },
          ],
        },
      },
    ],
    [
      'out',
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: t(s.body) }] },
      },
    ],
    [
      'out',
      {
        type: 'control_request',
        request_id: 'r1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Edit',
          input: { old_string: t(s.body), new_string: t(s.diff) },
          title: t(s.plan),
          description: t(s.task),
          blocked_path: t(s.body),
          decision_reason: t(s.diff),
          permission_suggestions: [
            { type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: t(s.body) }] },
          ],
        },
      },
    ],
    [
      'in',
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'r1',
          response: { behavior: 'allow', updatedInput: { content: t(s.body) } },
        },
      },
    ],
    [
      'out',
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: t(s.plan),
        permission_denials: [{ tool_name: 'Write', tool_use_id: 'x', tool_input: { content: t(s.body) } }],
      },
    ],
    ['out', { type: 'system', subtype: 'task_started', prompt: t(s.task), description: t(s.plan) }],
    ['out', { type: 'system', subtype: 'task_notification', status: 'completed', summary: t(s.diff) }],
    ['out', { type: 'tool_progress', tool_name: 'Bash', output: t(s.body) }],
    // Status frames with secrets in fields Dim Factory has never seen
    ['out', { type: 'system', subtype: 'status', status: 'requesting', note: t(s.diff) }],
    [
      'out',
      { type: 'system', subtype: 'init', cwd: t(s.task), tools: [t(s.body)], model: 'claude-sonnet-4' },
    ],
    ['out', { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', comment: t(s.plan) } }],
    [
      'out',
      {
        type: 'control_response',
        response: { subtype: 'success', response: { commands: [{ description: t(s.task) }] } },
      },
    ],
    // Codex app-server
    ['out', { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: t(s.plan) } }],
    [
      'out',
      {
        method: 'item/completed',
        params: { item: { type: 'commandExecution', command: t(s.task), aggregatedOutput: t(s.body) } },
      },
    ],
    ['out', { method: 'turn/diff/updated', params: { diff: t(s.diff) } }],
    ['out', { method: 'turn/plan/updated', params: { plan: [{ step: t(s.plan) }] } }],
    ['out', { method: 'thread/started', params: { thread: { id: 't', preview: t(s.task) } } }],
    ['out', { method: 'codex/event/agent_message', params: { msg: { message: t(s.plan) } } }],
    ['out', { method: 'item/fileChange/requestApproval', id: 5, params: { changes: [{ diff: t(s.diff) }] } }],
    ['out', { jsonrpc: '2.0', id: 3, result: { thread: { preview: t(s.task) }, items: [t(s.body)] } }],
    [
      'out',
      {
        method: 'turn/started',
        params: { turn: { id: 't', items: [{ text: t(s.task) }], status: 'inProgress' } },
      },
    ],
    [
      'out',
      { jsonrpc: '2.0', id: 8, error: { code: -32000, message: 'failed', data: { input: t(s.body) } } },
    ],
    [
      'in',
      { jsonrpc: '2.0', id: 2, method: 'turn/start', params: { input: [{ type: 'text', text: prompt }] } },
    ],
    // Codex exec --json
    ['out', { type: 'item.completed', item: { type: 'agent_message', text: t(s.plan) } }],
    ['out', { type: 'item.started', item: { type: 'command_execution', command: t(s.task) } }],
    ['out', { type: 'turn.completed', usage: { input_tokens: 1 }, last_agent_message: t(s.plan) }],
    // ACP
    [
      'out',
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: t(s.plan) } } },
      },
    ],
    [
      'out',
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'session/request_permission',
        params: { toolCall: { content: [{ type: 'diff', newText: t(s.diff) }] } },
      },
    ],
    [
      'out',
      { jsonrpc: '2.0', id: 6, method: 'fs/write_text_file', params: { path: 'a.ts', content: t(s.body) } },
    ],
    ['out', { jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: t(s.task) } }],
    [
      'in',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: { prompt: [{ type: 'text', text: prompt }] },
      },
    ],
    ['in', { jsonrpc: '2.0', id: 7, result: { content: t(s.body) } }],
  ]
}

/** Evidence with no secret in it: stderr lines and status frames. */
const STDERR = ['error: unknown option --frobnicate', 'warn: config file is old', 'fatal: cannot reach host']
const STATUS: unknown[] = [
  {
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    error_status: 529,
    error: 'overloaded',
  },
  {
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    errors: ['Reached maximum number of turns (1)'],
  },
  {
    type: 'assistant',
    error: 'rate_limit',
    is_api_error_message: true,
    message: { content: [{ type: 'text', text: 'Rate limited' }] },
  },
  { method: 'error', params: { error: { message: 'stream disconnected' }, willRetry: false } },
]

type LogItem =
  | { kind: 'content'; i: number; bare: boolean }
  | { kind: 'stderr'; i: number }
  | { kind: 'status'; i: number }

const itemArb: fc.Arbitrary<LogItem> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ kind: fc.constant('content' as const), i: fc.nat(), bare: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('stderr' as const), i: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('status' as const), i: fc.nat() }) },
)

const rec = (dir: 'in' | 'out' | 'err', line: string): string => JSON.stringify({ t: 0, dir, line })

describe('the heal input never carries the task, plan, diff or file bodies (property)', () => {
  const template = readHealTemplate()

  it('holds for any mix of content frames, status frames and stderr, in records or bare lines', () => {
    fc.assert(
      fc.property(
        secretsArb,
        fc.array(itemArb, { minLength: 1, maxLength: 80 }),
        fc.array(wrapped(fc.constant('')), { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        (s, items, pads, viaRaw) => {
          const t = (m: string): string => `${pads[m.length % pads.length] ?? ''}${m}${pads[0] ?? ''}`
          const frames = contentFrames(s, t)
          const lines = items.map((it) => {
            if (it.kind === 'stderr') return rec('err', STDERR[it.i % STDERR.length] ?? '')
            if (it.kind === 'status') return rec('out', JSON.stringify(STATUS[it.i % STATUS.length]))
            const [dir, frame] = frames[it.i % frames.length] ?? ['out', {}]
            const json = JSON.stringify(frame)
            // Bare lines: a vendor frame without its record (stdin frames always come as records).
            return it.bare && dir === 'out' ? json : rec(dir, json)
          })
          const req: HealRequest = {
            runId: 'r-prop',
            step: 'implement',
            failure: {
              category: 'unknown',
              message: 'claude exited with code 1',
              // The classifier's raw can hold frames too; it is used when the request has no tail.
              raw: lines.slice(-10).join('\n'),
              classifiedBy: 'heuristic',
            },
            trigger: 'auto',
            vendor: 'claude',
            vendorVersion: '2.1.289',
            passArgv: ['-p', '--permission-mode', 'acceptEdits'],
            tail: viaRaw ? [] : lines,
          }
          const input = buildHealInput(req, { env: ENV, redact: R })
          const prompt = render(template, input.values, { template: 'heal' }).text
          for (const marker of [s.task, s.plan, s.diff, s.body]) {
            expect(prompt).not.toContain(marker)
            // Not even a recognizable piece of one (truncation could cut a marker).
            expect(prompt).not.toContain(marker.slice(0, 12))
          }
          for (const line of input.tail) {
            expect(
              line.startsWith('stderr: ') || line.startsWith('stdout: ') || line.startsWith('exit: '),
            ).toBe(true)
            const payload = line
              .replace(/^(stderr|stdout|exit): /, '')
              .replace(/ \(repeated \d+ times\)$/, '')
            if (line.startsWith('stdout: {')) {
              const strings = JSON.stringify(JSON.parse(payload) as unknown).match(/"(?:[^"\\]|\\.)*"/g) ?? []
              for (const str of strings)
                expect((JSON.parse(str) as string).length).toBeLessThanOrEqual(HEAL_STRING_MAX)
            } else {
              expect(payload.length).toBeLessThanOrEqual(HEAL_STRING_MAX)
            }
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  it('still lets the stderr and status evidence through (the property is not vacuous)', () => {
    fc.assert(
      fc.property(secretsArb, (s) => {
        const frames = contentFrames(s, (m) => m)
        const lines = [
          ...frames.map(([dir, f]) => rec(dir, JSON.stringify(f))),
          rec('err', STDERR[0] ?? ''),
          rec('out', JSON.stringify(STATUS[0])),
          rec('out', JSON.stringify(STATUS[2])),
        ]
        const tail = filterHealTail(lines, { redact: R })
        expect(tail).toContain('stderr: error: unknown option --frobnicate')
        expect(tail).toContain(
          'stdout: {"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"error_status":529,"error":"overloaded"}',
        )
        expect(tail).toContain(
          'stdout: {"type":"assistant","error":"rate_limit","is_api_error_message":true,"message":"Rate limited"}',
        )
        const joined = tail.join('\n')
        for (const marker of [s.task, s.plan, s.diff, s.body]) expect(joined).not.toContain(marker)
      }),
      { numRuns: 50 },
    )
  })
})
