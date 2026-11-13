// claude.ai connectors through the real adapter and spawn path, against the fake CLI (a temp CLAUDE_CONFIG_DIR, never
// ~/.claude). Listing them is an initialize-only session with strict MCP off that asks `mcp_status` (C22a) and never
// sends a user message; it runs only where that session would start no other MCP server. A pass at Allowed list that
// allows a connector gets it as an explicit `claudeai-proxy` entry in its private MCP config file (C22c, C22d), and a
// "Run without asking" server gets its `mcp__<name>__*` allow rule (C21b).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../src/core/adapters/types.ts'
import { CONNECTORS_BLOCKED } from '../../../src/core/extensions/claude-connectors.ts'
import type { FakeSetup } from '../adapters/helpers.ts'
import { LOCAL, drive, fakeAdapter, fakeSetup, tempDir, terminals } from '../adapters/helpers.ts'

let setup: FakeSetup
beforeAll(async () => {
  setup = await fakeSetup()
})

const MAIL = {
  name: 'claude.ai Example Mail',
  config: {
    type: 'claudeai-proxy',
    url: 'https://mcp-proxy.example.invalid/v1/mcp/srv_mail',
    id: 'srv_mail',
  },
}
const DRIVE = {
  name: 'claude.ai Example Drive',
  config: {
    type: 'claudeai-proxy',
    url: 'https://mcp-proxy.example.invalid/v1/mcp/srv_drive',
    id: 'srv_drive',
  },
}
const status = (rid: string, mail: string): object => ({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: rid,
    response: {
      mcpServers: [
        { ...MAIL, status: mail, scope: 'claudeai', source: 'claudeai' },
        { ...DRIVE, status: 'needs-auth', scope: 'claudeai', source: 'claudeai' },
      ],
    },
  },
})

/** The listing as C22a recorded it: initialize, then `mcp_status` until no connector is pending; no user message. */
const LISTING = [
  {
    op: 'expectArgs',
    includes: ['-p', 'default', '--no-session-persistence'],
    excludes: ['--strict-mcp-config'],
  },
  {
    op: 'expectStdin',
    match: { type: 'control_request', request: { subtype: 'initialize' } },
    capture: { rid: 'request_id' },
  },
  {
    op: 'stdout',
    json: { type: 'control_response', response: { subtype: 'success', request_id: '$rid', response: {} } },
  },
  {
    op: 'expectStdin',
    match: { type: 'control_request', request: { subtype: 'mcp_status' } },
    capture: { s1: 'request_id' },
  },
  { op: 'stdout', json: status('$s1', 'pending') },
  {
    op: 'expectStdin',
    match: { type: 'control_request', request: { subtype: 'mcp_status' } },
    capture: { s2: 'request_id' },
  },
  { op: 'stdout', json: status('$s2', 'connected') },
  { op: 'expectEof', timeoutMs: 10_000 },
  { op: 'exit', code: 0 },
]

/** A read-only pass at Allowed list that allows the Mail connector and lets it run without asking. */
const PASS = [
  {
    op: 'expectArgs',
    includes: [
      '-p',
      'dontAsk',
      '--strict-mcp-config',
      '--mcp-config',
      '--allowedTools',
      'mcp__claude_ai_Example_Mail__*',
    ],
  },
  {
    op: 'expectFile',
    argvPath: '--mcp-config',
    json: {
      mcpServers: {
        claude_ai_Example_Mail: MAIL.config,
        claude_ai_Example_Drive: { $absent: true },
      },
    },
  },
  {
    op: 'stdout',
    json: { type: 'system', subtype: 'init', session_id: 'fake-session-0001', cwd: '$FAKE_CWD' },
  },
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
    op: 'stdout',
    json: { type: 'assistant', message: { content: [{ type: 'text', text: 'NO FINDINGS' }] } },
  },
  {
    op: 'stdout',
    json: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'NO FINDINGS',
      session_id: 'fake-session-0001',
    },
  },
  { op: 'exit', code: 0 },
]

function scenario(entries: { match: object; script: object[] }[]): { dir: string; log: string } {
  const dir = tempDir('connectors-scenario-')
  const list = entries.map((e, i) => {
    const file = join(dir, `s${i}.script.jsonl`)
    writeFileSync(file, e.script.map((op) => JSON.stringify(op)).join('\n'))
    return { match: e.match, script: file }
  })
  writeFileSync(
    join(dir, 'scenario.json'),
    JSON.stringify([
      { match: { argvIncludes: ['--version'] }, script: join(LOCAL, 'version.script.jsonl'), repeat: true },
      ...list,
    ]),
  )
  return { dir, log: join(dir, 'fake.log.jsonl') }
}

/** A Claude config folder with no MCP server, plugin or login file of anyone's (`.claude.json` with `servers`). */
function claudeConfig(servers: Record<string, unknown> = {}): string {
  const dir = tempDir('claude-config-')
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: servers }))
  mkdirSync(join(dir, 'skills'), { recursive: true })
  return dir
}

const starts = (log: string): string[][] => {
  let text: string
  try {
    text = readFileSync(log, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { kind: string; argv?: string[] })
    .filter((e) => e.kind === 'start' && Array.isArray(e.argv))
    .map((e) => e.argv ?? [])
}

const errors = (log: string): unknown[] =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { kind: string })
    .filter((e) => e.kind === 'error')

describe('Claude: listing the claude.ai connectors', () => {
  it('an initialize-only session with strict MCP off lists them (no user message), and keeps them in memory', async () => {
    const sc = scenario([{ match: { argvIncludes: ['-p', 'default'] }, script: LISTING }])
    const adapter = fakeAdapter(setup, {
      vendorEnv: { FAKE_CLI_SCRIPT: sc.dir, FAKE_CLI_LOG: sc.log, CLAUDE_CONFIG_DIR: claudeConfig() },
    })
    expect(adapter.listedConnectors()).toBeUndefined()
    const r = await adapter.listConnectors()
    expect(errors(sc.log)).toEqual([])
    expect(r).toEqual({
      ok: true,
      connectors: [
        { name: 'claude_ai_Example_Mail', label: MAIL.name, status: 'connected', def: MAIL.config },
        { name: 'claude_ai_Example_Drive', label: DRIVE.name, status: 'needs-auth', def: DRIVE.config },
      ],
    })
    expect(adapter.listedConnectors()?.map((c) => c.name)).toEqual([
      'claude_ai_Example_Mail',
      'claude_ai_Example_Drive',
    ])
    // A second ask is answered from memory: the CLI is not started again.
    await adapter.listConnectors()
    expect(starts(sc.log).filter((a) => a.includes('-p'))).toHaveLength(1)
  })

  it('never lists them where that session would also start an MCP server of the settings', async () => {
    const sc = scenario([{ match: { argvIncludes: ['-p', 'default'] }, script: LISTING }])
    const adapter = fakeAdapter(setup, {
      vendorEnv: {
        FAKE_CLI_SCRIPT: sc.dir,
        FAKE_CLI_LOG: sc.log,
        CLAUDE_CONFIG_DIR: claudeConfig({ mine: { command: 'node', args: ['mine.js'] } }),
      },
    })
    expect(await adapter.listConnectors()).toEqual({ ok: false, blocked: CONNECTORS_BLOCKED.servers })
    expect(starts(sc.log).filter((a) => a.includes('-p'))).toEqual([])
    expect(adapter.listedConnectors()).toBeUndefined()
  })
})

describe('Claude: a pass that allows a connector', () => {
  const review = (cwd: string, o: Partial<StartOptions>): StartOptions => ({
    runId: 'run-conn',
    step: 'review',
    cwd,
    prompt: 'Review the change.',
    model: 'sonnet',
    mode: 'readonly',
    planNative: false,
    allowRules: [],
    askTimeoutMs: 600_000,
    trustFolder: false,
    ...o,
  })

  it('lists the connectors first, then runs with only the allowed one as a claudeai-proxy entry and its allow rule', async () => {
    const sc = scenario([
      { match: { argvIncludes: ['-p', 'default'] }, script: LISTING },
      { match: { argvIncludes: ['-p', 'dontAsk'] }, script: PASS },
    ])
    const adapter = fakeAdapter(setup, {
      connectorsOnDemand: true,
      vendorEnv: { FAKE_CLI_SCRIPT: sc.dir, FAKE_CLI_LOG: sc.log, CLAUDE_CONFIG_DIR: claudeConfig() },
    })
    const d = await drive(
      adapter,
      review(tempDir('claude-cwd-'), {
        extensions: {
          level: 'allowed',
          mcp: ['claude_ai_Example_Mail'],
          skills: [],
          mcpWithoutAsking: ['claude_ai_Example_Mail'],
          scratchDir: tempDir('run-scratch-'),
        },
      }),
      new Map(),
    )
    expect(errors(sc.log)).toEqual([])
    expect(terminals(d.entries)).toMatchObject([{ type: 'done' }])
    // The connector's address and id went to the CLI's private file only, never into argv.
    const order = starts(sc.log).filter((a) => a.includes('-p'))
    expect(order.flat().join(' ')).not.toContain('srv_mail')
    expect(order.map((a) => a[a.indexOf('--permission-mode') + 1])).toEqual(['default', 'dontAsk'])
  })

  it('without a listing (off on demand) the connector is just not defined: strict MCP with no file', async () => {
    const pass = PASS.slice(2)
    const sc = scenario([
      {
        match: { argvIncludes: ['-p', 'dontAsk'] },
        script: [
          {
            op: 'expectArgs',
            includes: ['-p', 'dontAsk', '--strict-mcp-config'],
            excludes: ['--allowedTools'],
          },
          { op: 'expectFile', argvPath: '--mcp-config', absent: true },
          ...pass,
        ],
      },
    ])
    const adapter = fakeAdapter(setup, {
      vendorEnv: { FAKE_CLI_SCRIPT: sc.dir, FAKE_CLI_LOG: sc.log, CLAUDE_CONFIG_DIR: claudeConfig() },
    })
    const d = await drive(
      adapter,
      review(tempDir('claude-cwd-'), {
        extensions: {
          level: 'allowed',
          mcp: ['claude_ai_Example_Mail'],
          skills: [],
          mcpWithoutAsking: ['claude_ai_Example_Mail'],
          scratchDir: tempDir('run-scratch-'),
        },
      }),
      new Map(),
    )
    expect(errors(sc.log)).toEqual([])
    expect(terminals(d.entries)).toMatchObject([{ type: 'done' }])
    expect(starts(sc.log).filter((a) => a.includes('default'))).toEqual([])
  })
})
