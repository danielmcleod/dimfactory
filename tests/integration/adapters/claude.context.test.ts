// The Claude adapter's context breakdown through the real spawn path: with StartOptions.contextBreakdown it asks
// get_context_usage (summary) right after the prompt and, once the answer is in, again before it closes stdin; the
// session stays open until that second answer, or until RunTiming.contextUsageMs runs out when none comes. Without
// the option nothing extra is sent.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { readFakeLog } from '../../fake-cli/harness.ts'
import type { FakeSetup } from './helpers.ts'
import { drive, fakeAdapter, fakeSetup, tempDir, terminals } from './helpers.ts'

let setup: FakeSetup
beforeAll(async () => {
  setup = await fakeSetup()
})

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'ctx-session',
  tools: [],
  mcp_servers: [],
  model: 'claude-haiku',
  permissionMode: 'dontAsk',
  apiKeySource: 'none',
  claude_code_version: '2.1.289',
  cwd: 'x',
}
const assistant = {
  type: 'assistant',
  message: {
    id: 'msg_1',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 5_000 },
  },
  parent_tool_use_id: null,
}
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  modelUsage: { 'claude-haiku': { inputTokens: 10, outputTokens: 1, contextWindow: 200_000 } },
}
const usageReply = (total: number) => ({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: '$cid',
    response: {
      totalTokens: total,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      mcpTools: [{ name: 'mcp__gh__a', serverName: 'gh', tokens: 9_000 }],
      memoryFiles: [],
      agents: [],
    },
  },
})

/** `answerEnd`: whether the script answers the end-of-pass request. The script names get_context_usage itself. */
function script(dir: string, answerEnd: boolean): string {
  const file = join(dir, 'context.script.jsonl')
  const ops: object[] = [
    {
      op: 'expectStdin',
      match: { type: 'control_request', request: { subtype: 'initialize' } },
      capture: { rid: 'request_id' },
    },
    {
      op: 'stdout',
      json: { type: 'control_response', response: { subtype: 'success', request_id: '$rid', response: {} } },
    },
    { op: 'expectStdin', match: { type: 'user' } },
    {
      op: 'expectStdin',
      match: { type: 'control_request', request: { subtype: 'get_context_usage', detail: 'summary' } },
      capture: { cid: 'request_id' },
    },
    { op: 'stdout', json: usageReply(26_000) },
    { op: 'stdout', json: init },
    { op: 'stdout', json: assistant },
    { op: 'stdout', json: result },
    {
      op: 'expectStdin',
      match: { type: 'control_request', request: { subtype: 'get_context_usage', detail: 'summary' } },
      capture: { cid: 'request_id' },
    },
    ...(answerEnd ? [{ op: 'stdout', json: usageReply(25_500) }] : []),
    { op: 'expectEof', timeoutMs: 10_000 },
    { op: 'exit', code: 0 },
  ]
  writeFileSync(file, ops.map((o) => JSON.stringify(o)).join('\n'))
  return file
}

const options = (cwd: string, file: string, log: string, breakdown: boolean) => ({
  runId: 'r-ctx',
  step: 'review' as const,
  cwd,
  prompt: 'Say ok.',
  mode: 'readonly' as const,
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
  ...(breakdown ? { contextBreakdown: true } : {}),
  env: { FAKE_CLI_SCRIPT: file, FAKE_CLI_LOG: log },
})

describe('claude adapter: context breakdown', () => {
  it('asks at the start and at the end, and closes the session once the end is answered', async () => {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    const { entries, exit } = await drive(
      fakeAdapter(setup),
      options(dir, script(dir, true), log, true),
      new Map(),
    )
    expect(exit.code).toBe(0)
    expect(terminals(entries)).toMatchObject([{ type: 'done', result: 'ok' }])
    const breakdowns = entries.filter((e) => e.type === 'context-breakdown')
    expect(breakdowns).toMatchObject([
      { at: 'start', breakdown: { total: 26_000, window: 200_000, mcp: [{ name: 'gh', tokens: 9_000 }] } },
      { at: 'end', breakdown: { total: 25_500 } },
    ])
    expect(entries.filter((e) => e.type === 'context')).toEqual([
      { type: 'context', used: 26_000, window: 200_000, source: 'breakdown' },
      { type: 'context', used: 25_010, window: 200_000, cacheRead: 20_000, source: 'request' },
      { type: 'context', used: 25_010, window: 200_000, source: 'breakdown' },
    ])
    const sent = readFakeLog(log)
      .filter((e) => e.kind === 'stdin')
      .map((e) => String(e['line']))
    expect(sent.filter((l) => l.includes('get_context_usage'))).toHaveLength(2)
  }, 60_000)

  it('closes the session anyway when the end-of-pass breakdown is not answered in time', async () => {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    const adapter = fakeAdapter(setup, { timing: { contextUsageMs: 300 } })
    const { entries, exit } = await drive(adapter, options(dir, script(dir, false), log, true), new Map())
    expect(exit.code).toBe(0)
    expect(terminals(entries)).toMatchObject([{ type: 'done', result: 'ok' }])
    expect(entries.filter((e) => e.type === 'context-breakdown').map((e) => e.at)).toEqual(['start'])
  }, 60_000)

  it('sends nothing extra without the option (the fake answers a request no scenario names)', async () => {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    const file = join(dir, 'plain.script.jsonl')
    const ops: object[] = [
      {
        op: 'expectStdin',
        match: { type: 'control_request', request: { subtype: 'initialize' } },
        capture: { rid: 'request_id' },
      },
      {
        op: 'stdout',
        json: {
          type: 'control_response',
          response: { subtype: 'success', request_id: '$rid', response: {} },
        },
      },
      { op: 'expectStdin', match: { type: 'user' } },
      { op: 'stdout', json: init },
      { op: 'stdout', json: result },
      { op: 'expectEof', timeoutMs: 10_000 },
      { op: 'exit', code: 0 },
    ]
    writeFileSync(file, ops.map((o) => JSON.stringify(o)).join('\n'))
    const { entries, exit } = await drive(fakeAdapter(setup), options(dir, file, log, false), new Map())
    expect(exit.code).toBe(0)
    expect(entries.some((e) => e.type === 'context-breakdown')).toBe(false)
    const sent = readFakeLog(log)
      .filter((e) => e.kind === 'stdin')
      .map((e) => String(e['line']))
    expect(sent.some((l) => l.includes('get_context_usage'))).toBe(false)
  }, 60_000)
})
