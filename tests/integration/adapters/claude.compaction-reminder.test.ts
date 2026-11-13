// The post-compaction reminder through the real Claude adapter and the fake CLI: with StartOptions.compactionReminder
// an edit pass registers its own SessionStart hook in initialize, answers that hook with the reminder as
// additionalContext when the session restarts after a compaction (source `compact`), with nothing added for any
// other start, and keeps every other hook callback unsupported. Without the option nothing is registered. The frame
// shapes are live C24a's (tests/fixtures/claude/stdio/C24a-compaction-reminder).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { REMINDER_HOOK_ID } from '../../../src/core/adapters/claude/run.ts'
import type { StartOptions } from '../../../src/core/adapters/types.ts'
import { readFakeLog } from '../../fake-cli/harness.ts'
import type { FakeLogEntry } from '../../fake-cli/harness.ts'
import type { FakeSetup } from './helpers.ts'
import { drive, fakeAdapter, fakeSetup, tempDir } from './helpers.ts'

let setup: FakeSetup
beforeAll(async () => {
  setup = await fakeSetup()
}, 120_000)

const SESSION = 'fa4e9589-b2e6-4857-8d21-1114b3e46c61'
const REMINDER = 'Reminder after the context was summarised: keep to the plan.'

const hookCallback = (rid: string, callbackId: string, source: string): unknown => ({
  op: 'stdout',
  json: {
    type: 'control_request',
    request_id: rid,
    request: {
      subtype: 'hook_callback',
      callback_id: callbackId,
      input: { session_id: SESSION, cwd: '<CWD>', hook_event_name: 'SessionStart', source },
    },
  },
})

function script(dir: string, withHook: boolean): string {
  const file = join(dir, 'reminder.script.jsonl')
  const ops: unknown[] = [
    {
      op: 'expectStdin',
      match: { type: 'control_request', request: { subtype: 'initialize' } },
      capture: { rid: 'request_id' },
    },
    {
      op: 'stdout',
      json: { type: 'control_response', response: { subtype: 'success', request_id: '$rid' } },
    },
    { op: 'expectStdin', match: { type: 'user' } },
  ]
  if (withHook) {
    ops.push(
      hookCallback('h-start', REMINDER_HOOK_ID, 'startup'),
      {
        op: 'expectStdin',
        match: {
          type: 'control_response',
          response: { subtype: 'success', request_id: 'h-start', response: {} },
        },
      },
      hookCallback('h-compact', REMINDER_HOOK_ID, 'compact'),
      {
        op: 'expectStdin',
        match: {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'h-compact',
            response: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: REMINDER } },
          },
        },
      },
    )
  }
  ops.push(
    hookCallback('h-other', 'someone-else', 'compact'),
    {
      op: 'expectStdin',
      match: { type: 'control_response', response: { subtype: 'error', request_id: 'h-other' } },
    },
    {
      op: 'stdout',
      json: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        session_id: SESSION,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { op: 'exit', code: 0 },
  )
  writeFileSync(file, ops.map((x) => JSON.stringify(x)).join('\n'))
  return file
}

function stdinFrames(log: readonly FakeLogEntry[]): Record<string, unknown>[] {
  return log
    .filter((e) => e.kind === 'stdin')
    .map((e) => JSON.parse(String(e['line'])) as Record<string, unknown>)
}

function options(dir: string, scriptFile: string, log: string, reminder: boolean): StartOptions {
  return {
    runId: 'r',
    step: 'implement',
    cwd: dir,
    prompt: 'hi',
    mode: 'autoedit',
    planNative: false,
    allowRules: [],
    askTimeoutMs: 1000,
    trustFolder: false,
    env: { FAKE_CLI_SCRIPT: scriptFile, FAKE_CLI_LOG: log },
    ...(reminder ? { compactionReminder: () => Promise.resolve(REMINDER) } : {}),
  }
}

describe('claude adapter: the post-compaction reminder', () => {
  it('registers its SessionStart hook and answers a compact start with the reminder', async () => {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    const { entries, exit } = await drive(
      fakeAdapter(setup),
      options(dir, script(dir, true), log, true),
      new Map(),
    )
    expect(exit.code).toBe(0)
    const frames = stdinFrames(readFakeLog(log))
    const init = frames.find(
      (f) => (f['request'] as { subtype?: string } | undefined)?.subtype === 'initialize',
    )
    expect(init?.['request']).toMatchObject({
      hooks: { SessionStart: [{ hookCallbackIds: [REMINDER_HOOK_ID] }] },
    })
    // The startup answer adds nothing; only the compact start carries the reminder.
    const answers = frames.filter((f) => f['type'] === 'control_response')
    expect(answers.map((a) => (a['response'] as { request_id: string }).request_id)).toEqual([
      'h-start',
      'h-compact',
      'h-other',
    ])
    expect(entries).toContainEqual({ type: 'meta', key: 'compactionReminder', value: { sent: true } })
    expect(entries.filter((e) => e.type === 'meta' && e.key === 'compactionReminder')).toHaveLength(1)
    expect(entries.find((e) => e.type === 'done')).toMatchObject({ result: 'ok' })
  }, 60_000)

  it('without the option nothing is registered and every hook callback stays unsupported', async () => {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    const { exit } = await drive(fakeAdapter(setup), options(dir, script(dir, false), log, false), new Map())
    expect(exit.code).toBe(0)
    const frames = stdinFrames(readFakeLog(log))
    const init = frames.find(
      (f) => (f['request'] as { subtype?: string } | undefined)?.subtype === 'initialize',
    )
    expect(init?.['request']).not.toHaveProperty('hooks')
    expect(JSON.stringify(frames)).not.toContain('additionalContext')
  }, 60_000)

  it('a read-only pass never registers the hook, even when given the option', async () => {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    const o = {
      ...options(dir, script(dir, false), log, true),
      step: 'review' as const,
      mode: 'readonly' as const,
    }
    const { exit } = await drive(fakeAdapter(setup), o, new Map())
    expect(exit.code).toBe(0)
    const init = stdinFrames(readFakeLog(log)).find(
      (f) => (f['request'] as { subtype?: string } | undefined)?.subtype === 'initialize',
    )
    expect(init?.['request']).not.toHaveProperty('hooks')
  }, 60_000)
})
