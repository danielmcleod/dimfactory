// The recorder on a Claude CLI run against the user's own profile (the live re-record;
// scripts/record-fixture.mjs --vendor claude, scripts/redact-claude.mjs), driven by the fake CLI: the commands and
// agents the CLI's initialize reply does not mark built in, the profile's own skills, agents and hook command, plugins,
// MCP servers and tools, a hook's output and the plan windows' resets leave no trace in the recording, also when a
// streamed delta splits a name; the CLI's own entries stay; --claude-config is refused for another vendor.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../../scripts/build-fake-cli.mjs'
import { fakeEnv } from '../../fake-cli/harness.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RECORD = join(ROOT, 'scripts', 'record-fixture.mjs')
const build = await buildFakeCli()

// Every personal value is an obviously fake one; the names are the profile's (files) or the stream's (initialize).
const OWN_SKILL = 'fake-own-skill' // skills/fake-own-skill/SKILL.md
const OWN_AGENT = 'fake-reviewer' // agents/fake-reviewer.md
const HOOK = 'node C:/fake/hooks/notify-me.js' // settings.json hooks
const SYNCED = 'fakesynced' // only in the initialize reply (not built in), namespaced in init
const SYNCED_NS = `acme-skills:${SYNCED}`

function runNode(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RECORD, ...args], {
      env: fakeEnv(env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdout.resume()
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

let work = ''
let config = ''
let script = ''
let stdin = ''

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'dim-factory-claude-recorder-'))
  config = join(work, 'claude-config')
  const put = (rel: string, text: string): void => {
    const p = join(config, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
  put(`skills/${OWN_SKILL}/SKILL.md`, `---\nname: ${OWN_SKILL}\ndescription: mine\n---\n`)
  put(`agents/${OWN_AGENT}.md`, `---\nname: ${OWN_AGENT}\ndescription: mine\n---\n`)
  put('settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK }] }] } }))

  const out = (json: unknown): unknown => ({ op: 'stdout', json })
  const delta = (text: string): unknown =>
    out({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    })
  const ops: unknown[] = [
    {
      op: 'expectStdin',
      match: { type: 'control_request', request: { subtype: 'initialize' } },
      capture: { rid: 'request_id' },
    },
    out({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '$rid',
        response: {
          commands: [
            { name: OWN_SKILL, description: 'Mine. (user)', argumentHint: '' },
            { name: 'code-review', description: 'Review the diff.', argumentHint: '', builtin: true },
            { name: SYNCED, description: 'Synced. (claude.ai sync)', argumentHint: '', aliases: [SYNCED_NS] },
          ],
          agents: [
            { name: 'general-purpose', description: 'General.' },
            { name: OWN_AGENT, description: 'Mine.', model: 'opus' },
          ],
          models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }],
        },
      },
    }),
    { op: 'expectStdin', match: { type: 'user' } },
    out({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      tools: ['Read', 'mcp__fake-notes__read_note'],
      mcp_servers: [{ name: 'fake-notes', status: 'connected' }],
      slash_commands: [OWN_SKILL, 'code-review', SYNCED_NS],
      skills: [OWN_SKILL, 'code-review', SYNCED_NS],
      agents: ['general-purpose', OWN_AGENT],
      plugins: [
        { name: 'cc-plugin-telemetry', path: 'builtin', source: 'cc-plugin-telemetry@builtin' },
        { name: 'fake-plugin', path: '~/.claude/plugins/fake-plugin', source: 'fake-plugin@fake-market' },
      ],
    }),
    out({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h1',
      hook_name: 'Stop',
      hook_event: 'Stop',
      output: `ran ${HOOK}`,
      stdout: `ran ${HOOK}`,
      stderr: '',
      outcome: 'success',
    }),
    // The model names the user's skill, split across two deltas, and the hook command.
    delta(`I used fake-own`),
    delta(`-skill and ${HOOK}.`),
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } }),
    out({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1792281600,
        unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1791847800 } },
      },
    }),
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      subagent_stats: { by_type: { [OWN_AGENT]: 1 } },
    }),
    { op: 'expectEof' },
    { op: 'exit', code: 0 },
  ]
  script = join(work, 'claude.script.jsonl')
  writeFileSync(script, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
  stdin = join(work, 'stdin.jsonl')
  writeFileSync(
    stdin,
    [
      { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } },
      { $wait: { type: 'control_response' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { $wait: { type: 'result' } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
  )
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const args = (out: string, extra: string[] = []): string[] => [
  '--bin',
  process.execPath,
  '--arg',
  build.entry,
  '--cwd',
  mkdtempSync(join(work, 'cwd-')),
  '--out',
  out,
  '--id',
  'C99',
  '--slug',
  'profile',
  '--route',
  'stdio',
  '--timing',
  'off',
  '--timeout',
  '20000',
  '--stdin',
  stdin,
  ...extra,
]

describe('record-fixture --vendor claude on a real profile', () => {
  let text = ''
  let lines: Record<string, unknown>[] = []

  beforeAll(async () => {
    const out = join(work, 'out')
    const r = await runNode(args(out, ['--vendor', 'claude', '--claude-config', config]), {
      FAKE_CLI_SCRIPT: script,
    })
    expect(r.code, r.stderr).toBe(0)
    text = readFileSync(join(out, 'recording.jsonl'), 'utf8')
    lines = text
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((l) => JSON.parse(l) as { dir: string; line?: string })
      .filter((f) => f.dir === 'out' && typeof f.line === 'string')
      .map((f) => JSON.parse(f.line!) as Record<string, unknown>)
  })

  it('leaves no name, command or server of the profile in the recording', () => {
    for (const term of [OWN_SKILL, OWN_AGENT, HOOK, SYNCED, 'fake-notes', 'fake-plugin', 'fake-market'])
      expect(text, term).not.toContain(term)
    expect(text).not.toContain('Mine.')
    expect(text).not.toContain('Synced.')
  })

  it('keeps the CLI’s own entries and every value’s type', () => {
    const reply = (lines[0]!['response'] as { response: Record<string, unknown[]> }).response
    expect(reply['commands']).toEqual([
      { name: '<REDACTED>', description: '<REDACTED>', argumentHint: '<REDACTED>' },
      { name: 'code-review', description: 'Review the diff.', argumentHint: '', builtin: true },
      { name: '<REDACTED>', description: '<REDACTED>', argumentHint: '<REDACTED>', aliases: ['<REDACTED>'] },
    ])
    expect(reply['models']).toEqual([
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
    ])
    const init = lines.find((m) => m['subtype'] === 'init')!
    expect(init['slash_commands']).toEqual(['<REDACTED>', 'code-review', '<REDACTED>'])
    expect(init['agents']).toEqual(['general-purpose', '<REDACTED>'])
    expect(init['tools']).toEqual(['Read', 'mcp__<REDACTED>'])
    expect((init['plugins'] as unknown[])[0]).toEqual({
      name: 'cc-plugin-telemetry',
      path: 'builtin',
      source: 'cc-plugin-telemetry@builtin',
    })
  })

  it('a split name in streamed text is redacted with the joined text otherwise unchanged', () => {
    const joined = lines
      .filter((m) => m['type'] === 'stream_event')
      .map((m) => (m['event'] as { delta?: { text?: string } }).delta?.text ?? '')
      .join('')
    expect(joined).toBe('I used <REDACTED> and <REDACTED>.')
  })

  it('the hook’s output, the plan windows’ resets and a user agent’s tally are gone', () => {
    expect(lines.find((m) => m['subtype'] === 'hook_response')).toMatchObject({
      hook_name: '<REDACTED>',
      hook_event: 'Stop',
      output: '<REDACTED>',
      outcome: 'success',
    })
    expect(lines.find((m) => m['type'] === 'rate_limit_event')).toMatchObject({
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 0,
        unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 0 } },
      },
    })
    expect(lines.find((m) => m['type'] === 'result')).toMatchObject({
      subagent_stats: { by_type: { '<REDACTED>': 1 } },
    })
  })

  it('--claude-config is only for --vendor claude', async () => {
    const r = await runNode(args(join(work, 'out-other'), ['--vendor', 'fake', '--claude-config', config]), {
      FAKE_CLI_SCRIPT: script,
    })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--claude-config is only for --vendor claude')
  })
})
