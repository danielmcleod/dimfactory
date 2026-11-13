// A Claude answer given while background work (a shell, a subagent) still runs, through the real adapter and spawn
// path: stdin stays open (closing it ends a one-shot session and kills the work), the pass ends with the CLI's
// follow-up turn once the work finishes, and with the answer it has when no turn follows.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { FakeSetup } from './helpers.ts'
import { drive, fakeAdapter, fakeSetup, tempDir, terminals } from './helpers.ts'

let setup: FakeSetup
beforeAll(async () => {
  setup = await fakeSetup()
})

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'bg-session',
  tools: [],
  mcp_servers: [],
  model: 'claude-sonnet',
  permissionMode: 'acceptEdits',
  apiKeySource: 'none',
  claude_code_version: '2.1.289',
  cwd: 'x',
}
const tasks = (list: object[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: list })
const result = (text: string, input: number) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  modelUsage: { m: { inputTokens: input, outputTokens: 1 } },
})

function script(dir: string, followUp: boolean): string {
  const file = join(dir, 'background.script.jsonl')
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
    { op: 'stdout', json: init },
    {
      op: 'stdout',
      json: tasks([{ task_id: 'b1', task_type: 'local_bash', description: 'Run the test suite' }]),
    },
    { op: 'stdout', json: result('Started the tests.', 10) },
    // The host must keep stdin open now: an EOF here fails the script (and the pass would end with this answer).
    { op: 'expectStdin', match: { type: 'never-sent' }, timeoutMs: 800, onTimeout: 'work-done' },
    { op: 'label', name: 'work-done' },
    { op: 'stdout', json: tasks([]) },
    ...(followUp
      ? [
          { op: 'stdout', json: init },
          { op: 'stdout', json: result('All 42 tests pass.', 25) },
        ]
      : []),
    { op: 'expectEof', timeoutMs: 10_000 },
    { op: 'exit', code: 0 },
  ]
  writeFileSync(file, ops.map((o) => JSON.stringify(o)).join('\n'))
  return file
}

const options = (cwd: string, file: string) => ({
  runId: 'r-bg',
  step: 'implement' as const,
  cwd,
  prompt: 'Run the tests in the background and report.',
  mode: 'autoedit' as const,
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
  env: { FAKE_CLI_SCRIPT: file },
})

describe('claude adapter: background work', () => {
  it('keeps stdin open while the work runs and ends with the follow-up turn', async () => {
    const dir = tempDir()
    const { entries, exit } = await drive(fakeAdapter(setup), options(dir, script(dir, true)), new Map())
    expect(terminals(entries)).toMatchObject([
      { type: 'done', result: 'All 42 tests pass.', usage: { input: 25 } },
    ])
    expect(entries).toContainEqual({ type: 'waiting', tasks: ['Run the test suite'] })
    expect(exit.code).toBe(0)
  }, 60_000)

  it('ends with the answer it has when the work ends and no turn follows', async () => {
    const dir = tempDir()
    const adapter = fakeAdapter(setup, { timing: { drainedMs: 300 } })
    const { entries, exit } = await drive(adapter, options(dir, script(dir, false)), new Map())
    expect(terminals(entries)).toMatchObject([{ type: 'done', result: 'Started the tests.' }])
    expect(exit.code).toBe(0)
  }, 60_000)
})

describe('claude adapter: custom subagents on a read-only pass', () => {
  it("a project's custom subagent takes the subagent tool away from a read-only pass below Pass through", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    // A custom subagent may raise its own permission mode: a read-only pass must not be able to start it.
    writeFileSync(
      join(dir, '.claude', 'agents', 'x.md'),
      ['---', 'name: x', 'description: test', 'permissionMode: bypassPermissions', '---', 'Do it.'].join(
        '\n',
      ),
    )
    const file = join(dir, 'agents.script.jsonl')
    const ops = [
      {
        op: 'expectArgs',
        includes: ['Edit,Write,NotebookEdit,AskUserQuestion,Monitor,Agent', '--disable-slash-commands'],
      },
      { op: 'expectStdin', match: { type: 'control_request' }, capture: { rid: 'request_id' } },
      {
        op: 'stdout',
        json: {
          type: 'control_response',
          response: { subtype: 'success', request_id: '$rid', response: {} },
        },
      },
      { op: 'expectStdin', match: { type: 'user' } },
      { op: 'stdout', json: { ...init, permissionMode: 'dontAsk' } },
      { op: 'stdout', json: result('Reviewed.', 5) },
      { op: 'expectEof', timeoutMs: 10_000 },
      { op: 'exit', code: 0 },
    ]
    writeFileSync(file, ops.map((o) => JSON.stringify(o)).join('\n'))
    const { entries, exit } = await drive(
      fakeAdapter(setup),
      {
        ...options(dir, file),
        step: 'review',
        mode: 'readonly',
        extensions: { level: 'none', mcp: [], skills: [] },
      },
      new Map(),
    )
    expect(terminals(entries)).toMatchObject([{ type: 'done', result: 'Reviewed.' }])
    expect(exit.code).toBe(0)
  }, 60_000)
})
