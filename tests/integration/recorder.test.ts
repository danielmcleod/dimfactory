// Raw recorder (scripts/record-fixture.mjs) + fixture-to-script, driven against the fake CLI.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../scripts/build-fake-cli.mjs'
import { redactText } from '../../src/shared/redact.ts'
import { fakeEnv } from '../fake-cli/harness.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RECORD = join(ROOT, 'scripts', 'record-fixture.mjs')
const TO_SCRIPT = join(ROOT, 'scripts', 'fixture-to-script.mjs')
const build = await buildFakeCli()

// Composed at runtime so no secret-shaped literal lives in the repo.
const SECRET = ['sk', 'ant', 'api03', 'Zx9q'.repeat(8)].join('-')
const GH_TOKEN = `ghp_${'a1B2'.repeat(9)}`
const EMAIL = ['jane.doe', 'corp-mail.net'].join('@')

interface Frame {
  t: number
  dir: 'in' | 'out' | 'err' | 'exit'
  line?: string
  crlf?: true
  eol?: false
  code?: number | null
  signal?: string | null
  timedOut?: true
}
interface Header {
  kind: string
  [key: string]: unknown
}

function runNode(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: fakeEnv(env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c))
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function parseRecording(path: string): { header: Header; frames: Frame[]; text: string } {
  const text = readFileSync(path, 'utf8')
  const lines = text.trimEnd().split('\n')
  const header = JSON.parse(lines[0] ?? '{}') as Header
  return { header, frames: lines.slice(1).map((l) => JSON.parse(l) as Frame), text }
}

const byDir = (frames: Frame[], dir: Frame['dir']): Frame[] => frames.filter((f) => f.dir === dir)

let work = ''
let subject = ''
let stdinFrames = ''
let responders = ''

function recordArgs(cwd: string, out: string, extra: string[] = []): string[] {
  return [
    '--bin',
    process.execPath,
    '--arg',
    build.entry,
    '--arg',
    '-p',
    '--cwd',
    cwd,
    '--out',
    out,
    '--vendor',
    'fake',
    '--route',
    'stream-json',
    '--id',
    'R01',
    '--slug',
    'roundtrip',
    '--env',
    'FAKE_VAR_greeting=hello',
    '--timeout',
    '20000',
    ...extra,
  ]
}

function freshDir(name: string): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'dim-factory-recorder-'))
  subject = join(work, 'subject.script.jsonl')
  const ops: unknown[] = [
    {
      op: 'stdout',
      json: {
        type: 'system',
        subtype: 'init',
        cwd: '$FAKE_CWD',
        home: '$FAKE_HOME',
        apiKey: SECRET,
        note: `token ${GH_TOKEN} for ${EMAIL}`,
      },
    },
    {
      op: 'expectStdin',
      match: { type: 'control_request', request: { subtype: 'initialize' } },
      capture: { rid: 'request_id' },
    },
    {
      op: 'stdout',
      json: {
        type: 'control_response',
        response: { subtype: 'success', request_id: '$rid', response: { account: { email: EMAIL } } },
      },
    },
    {
      op: 'stdout',
      json: {
        type: 'control_request',
        request_id: 'cli_req_0001',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      },
    },
    {
      op: 'expectStdin',
      match: {
        type: 'control_response',
        response: {
          request_id: 'cli_req_0001',
          response: { behavior: 'allow', updatedInput: { command: 'ls' } },
        },
      },
    },
    { op: 'stdout', json: { type: 'assistant', text: 'Edited $FAKE_HOME/notes.txt in $FAKE_CWD' } },
    { op: 'expectStdin', match: { type: 'user' } },
    { op: 'stdout', json: { type: 'result', subtype: 'success', result: 'done' } },
    { op: 'stdout', raw: 'progress 100%\r\n' },
    { op: 'expectEof' },
    { op: 'stderr', line: `debug: home=$FAKE_HOME contact=${EMAIL} key=${SECRET}` },
    { op: 'stdout', raw: 'tail-without-newline' },
    { op: 'exit', code: 0 },
  ]
  writeFileSync(subject, ops.map((o) => JSON.stringify(o)).join('\n') + '\n')

  stdinFrames = join(work, 'stdin.jsonl')
  writeFileSync(
    stdinFrames,
    [
      JSON.stringify({
        type: 'control_request',
        request_id: 'init_0001',
        request: { subtype: 'initialize' },
      }),
      JSON.stringify({ $wait: { type: 'assistant' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
      JSON.stringify({ $wait: { type: 'result' } }),
    ].join('\n') + '\n',
  )
  responders = join(work, 'responders.json')
  writeFileSync(
    responders,
    JSON.stringify([
      {
        when: {
          type: 'control_request',
          request_id: '$rid',
          request: { subtype: 'can_use_tool', input: '$input' },
        },
        reply: {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: '$rid',
            response: { behavior: 'allow', updatedInput: '$input' },
          },
        },
        once: true,
      },
    ]),
  )
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('record-fixture', () => {
  let first = ''
  let second = ''

  beforeAll(async () => {
    const io = ['--stdin', stdinFrames, '--responders', responders, '--timing', 'off']
    const [a, b] = await Promise.all([
      runNode(RECORD, recordArgs(freshDir('cwd-a'), freshDir('out-a'), io), { FAKE_CLI_SCRIPT: subject }),
      runNode(RECORD, recordArgs(freshDir('cwd-b'), freshDir('out-b'), io), { FAKE_CLI_SCRIPT: subject }),
    ])
    expect(a.stderr, a.stderr).not.toContain('record-fixture:')
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    first = join(work, 'out-a', 'recording.jsonl')
    second = join(work, 'out-b', 'recording.jsonl')
  })

  it('writes byte-identical recordings for identical runs with --timing off', () => {
    expect(readFileSync(second)).toEqual(readFileSync(first))
  })

  it('writes a header without machine identity or wall-clock time', () => {
    const { header } = parseRecording(first)
    expect(header).toMatchObject({
      kind: 'header',
      schemaVersion: 1,
      vendor: 'fake',
      route: 'stream-json',
      scenario: 'R01-roundtrip',
      os: process.platform,
      arch: process.arch,
      envKeys: ['FAKE_VAR_greeting'],
    })
    expect(header).not.toHaveProperty('recordedAt')
    // The entry path goes through the home rule like any argv path: a checkout under the home folder (CI's
    // /home/runner/work/...) is recorded as ~/..., one outside it (C:\_Dev\...) verbatim.
    const machine = { home: homedir(), username: userInfo().username, hostname: hostname() }
    const entry = redactText(build.entry, { mode: 'fixture', ...machine }).text
    expect(header['argv']).toEqual([basename(process.execPath), entry, '-p'])
    expect(typeof header['hostVersion']).toBe('string')
  })

  it('redacts secrets, emails, the home path and the cwd', () => {
    const { text } = parseRecording(first)
    const home = homedir()
    for (const needle of [
      SECRET,
      GH_TOKEN,
      EMAIL,
      home,
      home.replace(/\\/g, '/'),
      JSON.stringify(home).slice(1, -1),
    ]) {
      expect(text).not.toContain(needle)
    }
    const user = userInfo().username
    if (user.length > 1 && user !== 'user') {
      expect(text).not.toMatch(
        new RegExp(`(Users|home)(\\\\\\\\|\\\\|/)${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
      )
    }
    expect(text).toContain('<TOKEN>')
    expect(text).toContain('user@example.invalid')
    expect(text).toContain('Edited ~/notes.txt in <CWD>')
    expect(text).toContain('\\"cwd\\":\\"<CWD>\\"')
  })

  it('records frames in causal order, including responder replies, CRLF and a partial last line', () => {
    const { frames } = parseRecording(first)
    expect(frames.map((f) => f.dir)).toEqual([
      'in',
      'out',
      'out',
      'out',
      'in',
      'out',
      'in',
      'out',
      'out',
      'err',
      'out',
      'exit',
    ])
    expect(frames.every((f) => f.t === 0)).toBe(true)
    const reply = JSON.parse(byDir(frames, 'in')[1]?.line ?? '{}') as unknown
    expect(reply).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'cli_req_0001',
        response: { behavior: 'allow', updatedInput: { command: 'ls' } },
      },
    })
    expect(JSON.parse(byDir(frames, 'out')[1]?.line ?? '{}')).toMatchObject({
      response: { request_id: 'init_0001' },
    })
    expect(frames[8]).toEqual({ t: 0, dir: 'out', line: 'progress 100%', crlf: true })
    expect(frames[10]).toEqual({ t: 0, dir: 'out', line: 'tail-without-newline', eol: false })
    expect(frames[11]).toEqual({ t: 0, dir: 'exit', code: 0, signal: null })
  })

  it('replays the recording itself through the fake CLI', async () => {
    const io = ['--stdin', stdinFrames, '--responders', responders, '--timing', 'off']
    const run = await runNode(RECORD, recordArgs(freshDir('cwd-replay'), freshDir('out-replay'), io), {
      FAKE_CLI_SCRIPT: first,
    })
    expect(run.code, run.stderr).toBe(0)
    const original = parseRecording(first).frames
    const replayed = parseRecording(join(work, 'out-replay', 'recording.jsonl')).frames
    for (const dir of ['in', 'out', 'err', 'exit'] as const)
      expect(byDir(replayed, dir)).toEqual(byDir(original, dir))
  })

  it('converts the recording with fixture-to-script into a script that replays the same session', async () => {
    const script = join(work, 'converted.script.jsonl')
    const conv = await runNode(TO_SCRIPT, [first, '--out', script])
    expect(conv.code, conv.stderr).toBe(0)
    const ops = readFileSync(script, 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(ops[1]).toEqual({
      op: 'expectStdin',
      match: { type: 'control_request', request_id: '$request_id_1', request: { subtype: 'initialize' } },
    })
    expect(String(ops[3]?.['line'])).toContain('"request_id":"$request_id_1"')

    const io = ['--stdin', stdinFrames, '--responders', responders, '--timing', 'off']
    const run = await runNode(RECORD, recordArgs(freshDir('cwd-script'), freshDir('out-script'), io), {
      FAKE_CLI_SCRIPT: script,
    })
    expect(run.code, run.stderr).toBe(0)
    const original = parseRecording(first).frames
    const replayed = parseRecording(join(work, 'out-script', 'recording.jsonl')).frames
    for (const dir of ['in', 'out', 'err', 'exit'] as const)
      expect(byDir(replayed, dir)).toEqual(byDir(original, dir))
  })

  it('stamps recordedAt and real timings with --timing on', async () => {
    const io = ['--stdin', stdinFrames, '--responders', responders, '--timing', 'on']
    const run = await runNode(RECORD, recordArgs(freshDir('cwd-timed'), freshDir('out-timed'), io), {
      FAKE_CLI_SCRIPT: subject,
    })
    expect(run.code, run.stderr).toBe(0)
    const { header, frames } = parseRecording(join(work, 'out-timed', 'recording.jsonl'))
    expect(Date.parse(String(header['recordedAt']))).not.toBeNaN()
    expect(frames.at(-1)?.t).toBeGreaterThan(0)
    const ts = frames.map((f) => f.t)
    expect(ts).toEqual([...ts].sort((x, y) => x - y))
  })

  it('kills the CLI on --timeout and still writes the recording', async () => {
    const hang = join(work, 'hang.script.jsonl')
    writeFileSync(
      hang,
      `${JSON.stringify({ op: 'stdout', line: 'started' })}\n${JSON.stringify({ op: 'sleep', ms: 60_000 })}\n`,
    )
    const args = recordArgs(freshDir('cwd-hang'), freshDir('out-hang'), ['--keep-stdin', '--timing', 'off'])
    args[args.indexOf('--timeout') + 1] = '4000'
    const run = await runNode(RECORD, args, { FAKE_CLI_SCRIPT: hang })
    expect(run.code).toBe(3)
    const exit = parseRecording(join(work, 'out-hang', 'recording.jsonl')).frames.at(-1)
    expect(exit).toMatchObject({ dir: 'exit', timedOut: true })
  })

  it('drops inherited env vars matching --env-drop and records only the patterns', async () => {
    const script = join(work, 'env.script.jsonl')
    writeFileSync(script, `${JSON.stringify({ op: 'stdout', line: 'drop=${dropme} keep=${keepme}' })}\n`)
    const args = recordArgs(freshDir('cwd-env'), freshDir('out-env'), [
      '--timing',
      'off',
      '--env-drop',
      '^fake_var_drop',
    ])
    const run = await runNode(RECORD, args, {
      FAKE_CLI_SCRIPT: script,
      FAKE_VAR_dropme: 'leaked',
      FAKE_VAR_keepme: 'kept',
    })
    expect(run.code, run.stderr).toBe(0)
    const { header, frames } = parseRecording(join(work, 'out-env', 'recording.jsonl'))
    expect(header['envDrop']).toEqual(['^fake_var_drop'])
    expect(byDir(frames, 'out')[0]?.line).toBe('drop=${dropme} keep=kept')
  })

  it('cleans the inherited env like a Dim Factory child: no NODE_OPTIONS or host-session variables', async () => {
    const show =
      'const ks=Object.keys(process.env).filter(k=>/^(CLAUDE|NODE_OPTIONS|KEEP_ME|NO_COLOR|TERM$)/i.test(k));' +
      'process.stdout.write(JSON.stringify(ks.sort())+"\\n")'
    const args = recordArgs(freshDir('cwd-hostenv'), freshDir('out-hostenv'), ['--timing', 'off'])
    args.splice(args.indexOf(build.entry) - 1, 4, '--arg', '-e', '--arg', show)
    const run = await runNode(RECORD, args, {
      CLAUDECODE: '1',
      CLAUDE_CODE_SSE_PORT: '4242',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_EFFORT: 'xhigh',
      CLAUDE_CONFIG_DIR: join(work, 'cfg'),
      NODE_OPTIONS: '--no-deprecation',
      KEEP_ME: 'yes',
    })
    expect(run.code, run.stderr).toBe(0)
    const { frames } = parseRecording(join(work, 'out-hostenv', 'recording.jsonl'))
    const seen = JSON.parse(byDir(frames, 'out')[0]?.line ?? '[]') as string[]
    expect(seen).toContain('KEEP_ME')
    expect(seen).toContain('CLAUDE_CONFIG_DIR')
    expect(seen).toContain('NO_COLOR')
    for (const gone of [
      'CLAUDECODE',
      'CLAUDE_CODE_SSE_PORT',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_EFFORT',
      'NODE_OPTIONS',
    ])
      expect(seen).not.toContain(gone)
  })

  it('replaces --redact-literal values in every frame and the argv', async () => {
    const io = ['--stdin', stdinFrames, '--responders', responders, '--timing', 'off']
    const args = recordArgs(freshDir('cwd-literal'), freshDir('out-literal'), [
      ...io,
      '--redact-literal',
      'notes.txt',
      '--arg',
      'tag=notes.txt',
    ])
    const run = await runNode(RECORD, args, { FAKE_CLI_SCRIPT: subject })
    expect(run.code, run.stderr).toBe(0)
    const { header, text } = parseRecording(join(work, 'out-literal', 'recording.jsonl'))
    expect(text).not.toContain('notes.txt')
    expect(text).toContain('Edited ~/<REDACTED> in <CWD>')
    expect(header['argv']).toContain('tag=<REDACTED>')
  })

  it('accepts a responder module and records the same session as the equivalent rules', async () => {
    const module = join(work, 'responders.mjs')
    writeFileSync(
      module,
      [
        'export default (frame) => {',
        "  if (frame.type !== 'control_request' || frame.request?.subtype !== 'can_use_tool') return undefined",
        '  return {',
        "    type: 'control_response',",
        "    response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updatedInput: frame.request.input } },",
        '  }',
        '}',
      ].join('\n'),
    )
    const io = ['--stdin', stdinFrames, '--responders', module, '--timing', 'off']
    const run = await runNode(RECORD, recordArgs(freshDir('cwd-module'), freshDir('out-module'), io), {
      FAKE_CLI_SCRIPT: subject,
    })
    expect(run.code, run.stderr).toBe(0)
    expect(readFileSync(join(work, 'out-module', 'recording.jsonl'))).toEqual(readFileSync(first))
  })

  it('redacts paths that streamed deltas split across frames without changing the joined text', async () => {
    const cwd = freshDir('cwd-delta')
    const home = JSON.stringify(homedir()).slice(1, -1)
    const delta = (index: number, delta: Record<string, string>): unknown => ({
      op: 'stdout',
      json: { type: 'stream_event', event: { type: 'content_block_delta', index, delta } },
    })
    const stop = (index: number): unknown => ({
      op: 'stdout',
      json: { type: 'stream_event', event: { type: 'content_block_stop', index } },
    })
    const a = Math.floor(home.length / 3)
    const b = Math.floor((home.length * 2) / 3)
    const k = Math.floor(cwd.length / 2)
    const script = join(work, 'delta.script.jsonl')
    writeFileSync(
      script,
      [
        delta(0, { type: 'input_json_delta', partial_json: `{"file_path": "${home.slice(0, a)}` }),
        delta(0, { type: 'input_json_delta', partial_json: home.slice(a, b) }),
        delta(0, { type: 'input_json_delta', partial_json: `${home.slice(b)}\\\\notes.txt"}` }),
        stop(0),
        delta(1, { type: 'text_delta', text: `in ${cwd.slice(0, k)}` }),
        delta(1, { type: 'text_delta', text: cwd.slice(k) }),
        stop(1),
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
    )
    const run = await runNode(RECORD, recordArgs(cwd, freshDir('out-delta'), ['--timing', 'off']), {
      FAKE_CLI_SCRIPT: script,
    })
    expect(run.code, run.stderr).toBe(0)
    const { frames } = parseRecording(join(work, 'out-delta', 'recording.jsonl'))
    const events = byDir(frames, 'out').map(
      (f) =>
        (JSON.parse(f.line ?? '{}') as { event: { index: number; delta?: Record<string, string> } }).event,
    )
    expect(events).toHaveLength(7)
    const joined = (index: number, field: string): string =>
      events
        .filter((e) => e.index === index && e.delta !== undefined)
        .map((e) => e.delta?.[field] ?? '')
        .join('')
    expect(joined(0, 'partial_json')).toBe('{"file_path": "~\\\\notes.txt"}')
    expect(joined(1, 'text')).toBe('in <CWD>')
    const pieces = events.flatMap((e) => Object.values(e.delta ?? {}))
    for (const fragment of [home.slice(0, a), home.slice(a, b), cwd.slice(0, k)])
      expect(pieces.filter((p) => p.includes(fragment))).toEqual([])
  })

  it('hard-kills the process tree on $kill and marks the exit frame', async () => {
    const script = join(work, 'kill.script.jsonl')
    writeFileSync(
      script,
      [
        { op: 'spawnGrandchild', sleepMs: 60_000, stdout: true },
        { op: 'sleep', ms: 60_000 },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
    )
    const frames = join(work, 'kill.stdin.jsonl')
    writeFileSync(frames, `${JSON.stringify({ $wait: { type: 'fake_grandchild' } })}\n{"$kill":true}\n`)
    const args = recordArgs(freshDir('cwd-kill'), freshDir('out-kill'), [
      '--stdin',
      frames,
      '--keep-stdin',
      '--timing',
      'off',
    ])
    const run = await runNode(RECORD, args, { FAKE_CLI_SCRIPT: script })
    expect(run.code, run.stderr).toBe(0)
    const recorded = parseRecording(join(work, 'out-kill', 'recording.jsonl')).frames
    expect(recorded.at(-1)).toMatchObject({ dir: 'exit', killed: 'tree' })
    expect(recorded.at(-1)).not.toHaveProperty('timedOut')
    const pid = Number((JSON.parse(byDir(recorded, 'out')[0]?.line ?? '{}') as { pid?: number }).pid)
    expect(pid).toBeGreaterThan(0)
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      if (process.platform === 'win32') {
        for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50))
        expect(alive()).toBe(false)
      }
    } finally {
      if (alive()) process.kill(pid)
    }
  })

  it('reports a missing binary as a usage error without writing a recording', async () => {
    const out = freshDir('out-missing')
    const args = recordArgs(freshDir('cwd-missing'), out)
    args[1] = join(work, 'does-not-exist.exe')
    const run = await runNode(RECORD, args)
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('cannot spawn')
    expect(() => readFileSync(join(out, 'recording.jsonl'))).toThrow()
  })
})
