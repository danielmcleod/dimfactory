// The fake vendor CLI through every launcher this OS supports (node entry, .cmd shim, shebang copy).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../scripts/build-fake-cli.mjs'
import { launchersFor, readFakeLog, runFake, startFake } from '../fake-cli/harness.ts'

const FIXTURES = fileURLToPath(new URL('../fixtures/fake/', import.meta.url))
const fixture = (name: string): string => join(FIXTURES, name)

const build = await buildFakeCli()
const launchers = launchersFor(build, 'claude')
const STREAM_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']

let work = ''
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dim-factory-fake-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const real = (p: string): string => realpathSync.native(p).toLowerCase()

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('build', () => {
  it('provides the launchers for this OS and is idempotent', async () => {
    expect(existsSync(build.entry)).toBe(true)
    expect(build.launchers.node.codex[1]).toBe(build.entry)
    if (process.platform === 'win32') {
      expect(build.launchers.sh).toBeUndefined()
      const shim = readFileSync(build.launchers.cmd?.gemini ?? '', 'utf8')
      expect(shim).toContain('"%dp0%\\node_modules\\dim-factory-fake-cli\\fake-cli.mjs" %*')
      expect(shim).toContain('\r\n')
    } else {
      expect(build.launchers.cmd).toBeUndefined()
      expect(readFileSync(build.launchers.sh?.claude ?? '', 'utf8').startsWith('#!/usr/bin/env node')).toBe(
        true,
      )
    }
    const again = await buildFakeCli()
    expect(again).toEqual(build)
  })
})

describe.each(launchers)('fake CLI via $kind launcher', (launcher) => {
  it('replays a scripted handshake: captured request id is echoed, file written, stdin logged', async () => {
    const log = join(work, 'fake.log')
    const fake = startFake(launcher, {
      args: STREAM_ARGS,
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('echo-handshake.script.jsonl'), FAKE_CLI_LOG: log },
    })
    const init = await fake.waitForJson((f) => f['type'] === 'system')
    expect(real(String(init['cwd']))).toBe(real(work))

    const requestId = `req_${Math.random().toString(16).slice(2)}`
    const initialize = { type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }
    fake.send(initialize)
    const response = await fake.waitForJson((f) => f['type'] === 'control_response')
    expect(response).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { models: [] } },
    })

    const user = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'say "hi"' }] } }
    fake.send(user)
    const result = await fake.waitForJson((f) => f['type'] === 'result')
    expect(result['request_id']).toBe(requestId)
    fake.end()
    const exit = await fake.exited

    expect(exit.code).toBe(0)
    expect(fake.json().map((f) => (f as { type: string }).type)).toEqual([
      'system',
      'control_response',
      'assistant',
      'result',
    ])
    expect(fake.json()[2]).toEqual({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'echo: say "hi"' }] },
    })
    expect(fake.stderr).toContain(`fake: finished turn for ${requestId}`)
    expect(readFileSync(join(work, 'out', 'hello.txt'), 'utf8')).toBe('hello from fake\n')

    const entries = readFakeLog(log)
    expect(entries[0]).toMatchObject({ kind: 'start', argv: STREAM_ARGS })
    expect(entries.filter((e) => e.kind === 'stdin').map((e) => e['line'])).toEqual([
      JSON.stringify(initialize),
      JSON.stringify(user),
    ])
    expect(entries.at(-1)).toMatchObject({ kind: 'exit', code: 0 })
  })

  it('tolerates CRLF-terminated stdin frames', async () => {
    const run = await runFake(launcher, {
      args: STREAM_ARGS,
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('echo-handshake.script.jsonl') },
      eol: '\r\n',
      stdin: [
        { type: 'control_request', request_id: 'crlf-1', request: { subtype: 'initialize' } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } },
      ],
    })
    expect(run.stderr).not.toContain('mismatch')
    expect(run.code).toBe(0)
    expect(run.stdoutLines.at(-1)).toContain('"request_id":"crlf-1"')
  })

  it('exits 99 with a readable diff on a stdin mismatch', async () => {
    const run = await runFake(launcher, {
      args: STREAM_ARGS,
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('echo-handshake.script.jsonl') },
      stdin: [{ type: 'control_request', request_id: 'x', request: { subtype: 'interrupt' } }],
    })
    expect(run.code).toBe(99)
    expect(run.stderr).toContain('stdin mismatch')
    expect(run.stderr).toContain('at $.request.subtype: expected "initialize", got "interrupt"')
  })

  it('exits 99 when expectArgs does not match', async () => {
    const run = await runFake(launcher, {
      args: ['-p', '--resume=abc'],
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('echo-handshake.script.jsonl') },
    })
    expect(run.code).toBe(99)
    expect(run.stderr).toContain('argv mismatch')
    expect(run.stderr).toContain('missing "--input-format"')
    expect(run.stderr).toContain('unexpected "--resume*"')
  })

  it('exits 98 instead of hanging when stdin closes while input is expected', async () => {
    const run = await runFake(launcher, {
      args: STREAM_ARGS,
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('echo-handshake.script.jsonl') },
    })
    expect(run.code).toBe(98)
    expect(run.stderr).toContain('stdin closed while waiting')
  })

  it('claims scenario entries in order across invocations', async () => {
    const env = { FAKE_CLI_SCRIPT: fixture('scenario-pair'), FAKE_CLI_STATE: join(work, 'state') }
    const first = await runFake(launcher, { args: ['-p'], cwd: work, env })
    const version = await runFake(launcher, { args: ['--version'], cwd: work, env })
    const second = await runFake(launcher, { args: ['-p'], cwd: work, env })
    const third = await runFake(launcher, { args: ['-p'], cwd: work, env })
    const versionAgain = await runFake(launcher, { args: ['--version'], cwd: work, env })
    expect([first.stdout.trim(), second.stdout.trim()]).toEqual(['first', 'second'])
    expect(version.stdout.trim()).toBe('2.1.287 (fake)')
    expect(versionAgain.stdout.trim()).toBe('2.1.287 (fake)')
    expect(third.code).toBe(97)
    expect(third.stderr).toContain('already claimed')
  })

  it('replays a recording, masking volatile ids and echoing the host request id', async () => {
    const fake = startFake(launcher, {
      args: STREAM_ARGS,
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('replay-handshake.recording.jsonl') },
    })
    await fake.waitForJson((f) => f['type'] === 'system')
    fake.send({ type: 'control_request', request_id: 'req_live_42', request: { subtype: 'initialize' } })
    const response = await fake.waitForJson((f) => f['type'] === 'control_response')
    expect(response['response']).toMatchObject({ request_id: 'req_live_42' })
    fake.send({
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: work,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })
    fake.end()
    const exit = await fake.exited
    expect(fake.stderr).toContain('warning: replayed from a recording')
    expect(exit.code).toBe(0)
    expect(fake.json().at(-1)).toMatchObject({ type: 'result', for: 'req_live_42' })
  })

  it('fails a recording replay with exit 99 and a diff when an input frame differs', async () => {
    const run = await runFake(launcher, {
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('replay-handshake.recording.jsonl') },
      stdin: [
        { type: 'control_request', request_id: 'r1', request: { subtype: 'initialize' } },
        {
          type: 'user',
          uuid: 'u',
          timestamp: 't',
          cwd: work,
          message: { role: 'user', content: [{ type: 'text', text: 'bye' }] },
        },
      ],
    })
    expect(run.code).toBe(99)
    expect(run.stderr).toContain('at $.message.content[0].text: expected "hello", got "bye"')
  })
})

describe('fake CLI ops (node launcher)', () => {
  const node = launchers[0]!

  it('branches on stdin and jumps to onStdinEof when the host closes stdin', async () => {
    const run = await runFake(node, {
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('branching.script.jsonl') },
      stdin: [{ decision: 'allow', tool: 'Bash' }, { decision: 'deny' }, { decision: 'maybe' }],
    })
    expect(run.stdoutLines).toEqual([
      'ready',
      '{"result":"allowed","tool":"Bash"}',
      '{"result":"denied"}',
      '{"result":"other"}',
      'bye',
    ])
    expect(run.code).toBe(3)
  })

  it('times out with exit 99 when the host never writes', async () => {
    const run = await runFake(node, {
      args: STREAM_ARGS,
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('echo-handshake.script.jsonl'), FAKE_CLI_TIMEOUT_MS: '300' },
      keepStdinOpen: true,
    })
    expect(run.code).toBe(99)
    expect(run.stderr).toContain('timed out after 300 ms')
  })

  it('hands out each claimed entry exactly once to concurrent invocations', async () => {
    const env = { FAKE_CLI_SCRIPT: fixture('scenario-pair'), FAKE_CLI_STATE: join(work, 'state') }
    const runs = await Promise.all([1, 2, 3].map(() => runFake(node, { args: ['-p'], cwd: work, env })))
    expect(runs.map((r) => r.stdout.trim()).sort()).toEqual(['', 'first', 'second'])
    expect(runs.map((r) => r.code).sort()).toEqual([0, 0, 97])
  })

  it('spawns a grandchild that outlives the fake and logs its pid', async () => {
    const log = join(work, 'fake.log')
    const run = await runFake(node, {
      cwd: work,
      env: { FAKE_CLI_SCRIPT: fixture('grandchild.script.jsonl'), FAKE_CLI_LOG: log },
    })
    expect(run.code).toBe(0)
    const entry = readFakeLog(log).find((e) => e.kind === 'grandchild')
    const pid = Number(entry?.['pid'])
    expect(pid).toBeGreaterThan(0)
    expect(JSON.parse(run.stdoutLines[0] ?? '{}')).toEqual({ type: 'grandchild', pid })
    try {
      expect(isAlive(pid)).toBe(true)
    } finally {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
      for (let i = 0; i < 50 && isAlive(pid); i++) await delay(50)
    }
  })

  it.skipIf(process.platform === 'win32')('jumps to onSignal handlers on SIGTERM (POSIX)', async () => {
    for (const launcher of launchers) {
      const fake = startFake(launcher, {
        cwd: work,
        env: { FAKE_CLI_SCRIPT: fixture('signal.script.jsonl') },
      })
      await fake.waitForLine((l) => l === 'ready')
      fake.child.kill('SIGTERM')
      const exit = await fake.exited
      expect(fake.stdoutLines).toEqual(['ready', 'signal SIGTERM'])
      expect(exit.code).toBe(143)
    }
  })

  it('fails setup with exit 97 when no script is configured', async () => {
    const run = await runFake(node, { cwd: work })
    expect(run.code).toBe(97)
    expect(run.stderr).toContain('FAKE_CLI_SCRIPT is not set')
  })
})
