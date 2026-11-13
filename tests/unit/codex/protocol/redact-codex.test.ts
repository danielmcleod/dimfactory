// scripts/redact-codex.mjs (live recordings on the everyday profile): the Codex
// profile rules the recorder applies to every server line, the profile's own terms, and their limits. The frames are
// the live stage A handshake on a real ~/.codex plus what a real profile adds once a thread runs, every personal
// value replaced by an obviously fake one.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMITTED_BUNDLE, checkRecording } from '../../../../scripts/codex-fixture-check.mjs'
import {
  QUOTA_RESETS_AT,
  QUOTA_WINDOW_MINS,
  REDACTED,
  instructionLines,
  profileTerms,
  redactCodexValue,
  redactTerms,
  redactUserAgent,
  tomlStrings,
  wordMatchers,
} from '../../../../scripts/redact-codex.mjs'
import { ELICITATION_CANCEL } from '../../../../src/core/adapters/codex/params.ts'
import { redactLine } from '../../../../src/shared/redact.ts'

const bundle = JSON.parse(readFileSync(COMMITTED_BUNDLE, 'utf8')) as unknown
const T = 1791626208976
const INSTRUCTIONS = 'Sign every answer as the fake person.'
const THREAD = '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e99'
const TURN = '019a1c3f-0099-7000-8000-000000000001'

/** Every value a real profile could give away, as fake stand-ins (none may survive redaction). */
const FAKES = {
  install: '11111111-2222-4333-8444-555555555555',
  os: 'Windows 10.0.99999; x86_64',
  server: 'FAKE-PC-01',
  environment: 'env-fake-0001',
  balance: '123.45',
  limit: '50.00',
  mcp: 'fake-notes',
  mcpCommand: 'C:\\fake\\tools\\fake-notes-mcp.exe',
  tool: 'read_fake_note',
  diary: 'Dear fake diary',
  connector: 'connector_fake',
  app: 'Fake Mail of the fake person',
  hookPath: 'C:\\fake\\hooks\\fake-notify.ps1',
  hookText: 'The fake person is at the desk',
  notebook: 'Which fake notebook?',
}

type Dir = 'in' | 'out'
const FRAMES: [Dir, Record<string, unknown>][] = [
  [
    'in',
    {
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'dim-factory', title: null, version: '0.1.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    },
  ],
  [
    'out',
    {
      id: 1,
      result: {
        userAgent: `dim-factory/0.160.1 (${FAKES.os}) dumb (dim-factory; 0.1.0)`,
        codexHome: '<CODEX_HOME>',
        platformFamily: 'windows',
        platformOs: 'windows',
      },
    },
  ],
  ['in', { method: 'initialized' }],
  ['in', { id: 2, method: 'windowsSandbox/readiness' }],
  [
    'out',
    {
      method: 'remoteControl/status/changed',
      params: {
        status: 'disabled',
        serverName: FAKES.server,
        installationId: FAKES.install,
        environmentId: FAKES.environment,
      },
      emittedAtMs: T,
    },
  ],
  ['out', { id: 2, result: { status: 'ready' } }],
  ['out', { method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' }, emittedAtMs: T }],
  [
    'out',
    {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          limitName: null,
          normalModelSlug: null,
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791626208 },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: FAKES.balance },
          individualLimit: { limit: FAKES.limit, used: '12.34', remainingPercent: 75, resetsAt: 1791626208 },
          spendControlReached: false,
          planType: 'plus',
          rateLimitReachedType: null,
        },
      },
      emittedAtMs: T,
    },
  ],
  [
    'out',
    {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: null,
        name: FAKES.mcp,
        status: 'failed',
        error: `program not found: ${FAKES.mcpCommand}`,
        failureReason: null,
      },
      emittedAtMs: T,
    },
  ],
  [
    'out',
    {
      method: 'configWarning',
      params: {
        summary: `Unknown key in [mcp_servers.${FAKES.mcp}]`,
        details: 'fake_key is not a known key',
        path: '<CODEX_HOME>\\config.toml',
      },
      emittedAtMs: T,
    },
  ],
  [
    'out',
    {
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: TURN,
        completedAtMs: T,
        item: {
          type: 'mcpToolCall',
          id: 'call_99',
          server: FAKES.mcp,
          tool: FAKES.tool,
          status: 'completed',
          arguments: { title: FAKES.diary },
          appContext: {
            connectorId: FAKES.connector,
            linkId: null,
            resourceUri: null,
            appName: FAKES.app,
            actionName: null,
          },
          mcpAppResourceUri: `ui://${FAKES.mcp}/view`,
          mcpAppUi: null,
          pluginId: null,
          readOnlyHint: true,
          result: { content: [{ type: 'text', text: FAKES.diary }], structuredContent: null, _meta: null },
          error: null,
          durationMs: 12,
        },
      },
      emittedAtMs: T,
    },
  ],
  [
    'out',
    {
      method: 'app/list/updated',
      params: {
        data: [
          {
            id: FAKES.connector,
            name: FAKES.app,
            description: FAKES.app,
            logoUrl: 'https://fake.example/logo.png',
            logoUrlDark: null,
            iconAssets: null,
            iconDarkAssets: null,
            distributionChannel: null,
            branding: null,
            appMetadata: null,
            labels: null,
            installUrl: null,
            isAccessible: true,
            isEnabled: true,
            pluginDisplayNames: [FAKES.app],
          },
        ],
      },
      emittedAtMs: T,
    },
  ],
  [
    'out',
    {
      method: 'hook/started',
      params: {
        threadId: THREAD,
        turnId: null,
        run: {
          id: 'hook-1',
          eventName: 'sessionStart',
          handlerType: 'command',
          executionMode: 'sync',
          scope: 'thread',
          sourcePath: FAKES.hookPath,
          source: 'user',
          displayOrder: 0,
          status: 'running',
          statusMessage: FAKES.hookText,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          entries: [{ kind: 'context', text: FAKES.hookText }],
        },
      },
      emittedAtMs: T,
    },
  ],
  [
    'out',
    {
      id: 0,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: THREAD,
        turnId: null,
        serverName: FAKES.mcp,
        mode: 'form',
        _meta: null,
        message: FAKES.notebook,
        requestedSchema: {
          type: 'object',
          properties: { book: { type: 'string', title: FAKES.notebook, enum: [FAKES.diary, 'Fake ledger'] } },
          required: ['book'],
        },
      },
    },
  ],
  ['in', { id: 0, result: ELICITATION_CANCEL }],
]

/** The frames as a recording; `redact`: what the recorder writes (shared rules on every line, then these on out). */
function recording(redact: boolean): string {
  const header = {
    kind: 'header',
    vendor: 'codex',
    route: 'app-server',
    scenario: 'X99-profile',
    protocol: 'jsonrpc',
  }
  const lines = FRAMES.map(([dir, msg]) => {
    let line = JSON.stringify(msg)
    if (redact) {
      line = redactLine(line, { mode: 'fixture' }).text
      if (dir === 'out') line = JSON.stringify(redactCodexValue(JSON.parse(line)).value)
    }
    return JSON.stringify({ t: 0, dir, line })
  })
  return `${[JSON.stringify(header), ...lines].join('\n')}\n`
}

describe('redactCodexValue: a real profile’s server frames', () => {
  it('the frames are valid 0.160 protocol before and after (every value keeps its schema type)', () => {
    expect(checkRecording(bundle, recording(false))).toEqual([])
    expect(checkRecording(bundle, recording(true))).toEqual([])
  })

  /** The recorded lines (each a JSON message), as the recording holds them. */
  const lines = (text: string): string[] =>
    text
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => String((JSON.parse(l) as { line: string }).line))

  it('no personal value survives, and the host frames are untouched', () => {
    const recorded = lines(recording(true)).join('\n')
    for (const [what, value] of Object.entries(FAKES)) {
      const found = recorded.includes(JSON.stringify(value).slice(1, -1))
      expect({ what, found }).toEqual({ what, found: false })
    }
    expect(recorded).not.toContain('"plus"')
    // The fakes are really there before (the check above is not vacuous).
    const raw = lines(recording(false)).join('\n')
    for (const value of Object.values(FAKES)) expect(raw).toContain(JSON.stringify(value).slice(1, -1))
    const host = FRAMES.filter(([dir]) => dir === 'in').map(([, m]) => JSON.stringify(m))
    for (const line of host) expect(lines(recording(true))).toContain(line)
  })

  it('keeps what the replay and the adapter read', () => {
    const msgs = lines(recording(true)).map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(msgs[1]).toMatchObject({
      result: { userAgent: `dim-factory/0.160.1 ${REDACTED} (dim-factory; 0.1.0)` },
    })
    expect(msgs[4]).toMatchObject({
      params: { status: 'disabled', serverName: 'host', installationId: REDACTED, environmentId: REDACTED },
    })
    expect(msgs[7]).toMatchObject({
      params: {
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: QUOTA_WINDOW_MINS, resetsAt: QUOTA_RESETS_AT },
          individualLimit: { remainingPercent: 75, resetsAt: QUOTA_RESETS_AT },
          planType: 'unknown',
          credits: { hasCredits: true },
        },
      },
    })
    expect(msgs[8]).toMatchObject({ params: { name: REDACTED, status: 'failed', error: REDACTED } })
    expect(msgs[10]).toMatchObject({
      params: { item: { type: 'mcpToolCall', status: 'completed', result: { content: [{ type: 'text' }] } } },
    })
    expect(msgs[13]).toMatchObject({
      id: 0,
      params: { mode: 'form', requestedSchema: { required: ['book'] } },
    })
  })

  it('counts each rule, and a second pass changes nothing', () => {
    const counts: Record<string, number> = {}
    for (const [dir, msg] of FRAMES) {
      if (dir !== 'out') continue
      const once = redactCodexValue(msg)
      for (const [k, n] of Object.entries(once.counts)) counts[k] = (counts[k] ?? 0) + n
      expect(redactCodexValue(once.value)).toEqual({ value: once.value, counts: {} })
    }
    expect(Object.keys(counts).sort()).toEqual([
      'codex-app',
      'codex-config',
      'codex-hook',
      'codex-mcp',
      'codex-plan',
      'codex-remote-control',
      'codex-user-agent',
    ])
  })

  it('a quota window keeps its used percent; its length and reset are stand-ins (the plan, the start)', () => {
    // Live stage B: every frame read one 30-day window, no second one and the account's own reset time, which says
    // which plan the redacted planType hid and when the account's window began. Fake values here.
    const limits = (primary: unknown, secondary: unknown) => ({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          limitName: null,
          normalModelSlug: null,
          primary,
          secondary,
          credits: { hasCredits: false, unlimited: false, balance: null },
          individualLimit: null,
          spendControlReached: null,
          planType: 'free',
          rateLimitReachedType: null,
        },
      },
    })
    const stand = { windowDurationMins: QUOTA_WINDOW_MINS, resetsAt: QUOTA_RESETS_AT }
    const single = redactCodexValue(
      limits({ usedPercent: 3, windowDurationMins: 43200, resetsAt: 1799999999 }, null),
    )
    expect(single.value).toEqual({
      ...limits({ usedPercent: 3, ...stand }, null),
      params: {
        rateLimits: { ...limits({ usedPercent: 3, ...stand }, null).params.rateLimits, planType: 'unknown' },
      },
    })
    expect(single.counts).toEqual({ 'codex-plan': 3 })
    const two = redactCodexValue(
      limits(
        { usedPercent: 40, windowDurationMins: 300, resetsAt: 1799990000 },
        { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1800500000 },
      ),
    )
    expect(two.value).toMatchObject({
      params: {
        rateLimits: { primary: { usedPercent: 40, ...stand }, secondary: { usedPercent: 7, ...stand } },
      },
    })
    // Unknown stays unknown (null), and a second pass changes nothing.
    const none = redactCodexValue(limits({ usedPercent: 0, windowDurationMins: null, resetsAt: null }, null))
    expect(none.value).toMatchObject({
      params: { rateLimits: { primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null } } },
    })
    expect(redactCodexValue(two.value)).toEqual({ value: two.value, counts: {} })
    // Still valid 0.160 (an int64 where one is required).
    const frame = JSON.stringify({ t: 0, dir: 'out', line: JSON.stringify(two.value) })
    const header = JSON.stringify({
      kind: 'header',
      vendor: 'codex',
      route: 'app-server',
      scenario: 'X99-q',
      protocol: 'jsonrpc',
    })
    expect(checkRecording(bundle, `${header}\n${frame}\n`)).toEqual([])
  })

  it('custom instructions, a config MCP table and an exec MCP item', () => {
    const r = redactCodexValue({
      id: 7,
      result: {
        config: {
          instructions: INSTRUCTIONS,
          developer_instructions: INSTRUCTIONS,
          compact_prompt: INSTRUCTIONS,
          mcp_servers: { [FAKES.mcp]: { command: FAKES.mcpCommand } },
          model: 'gpt-5.6-terra',
        },
        settings: { developerInstructions: INSTRUCTIONS, chatgpt_plan_type: 'pro' },
      },
    })
    expect(r.value).toEqual({
      id: 7,
      result: {
        config: {
          instructions: REDACTED,
          developer_instructions: REDACTED,
          compact_prompt: REDACTED,
          mcp_servers: REDACTED,
          model: 'gpt-5.6-terra',
        },
        settings: { developerInstructions: REDACTED, chatgpt_plan_type: 'unknown' },
      },
    })
    expect(r.counts).toEqual({ 'codex-instructions': 4, 'codex-mcp': 1, 'codex-plan': 1 })
    const exec = redactCodexValue({
      type: 'item.completed',
      item: {
        id: 'item_3',
        type: 'mcp_tool_call',
        server: FAKES.mcp,
        tool: FAKES.tool,
        arguments: { q: FAKES.diary },
        result: { content: [{ type: 'text', text: FAKES.diary }], structured_content: null },
        error: { message: FAKES.mcpCommand },
        status: 'failed',
      },
    })
    expect(exec.value).toEqual({
      type: 'item.completed',
      item: {
        id: 'item_3',
        type: 'mcp_tool_call',
        server: REDACTED,
        tool: REDACTED,
        arguments: { q: REDACTED },
        result: { content: [{ type: 'text', text: REDACTED }], structured_content: null },
        error: { message: REDACTED },
        status: 'failed',
      },
    })
  })

  it("a thread's git remote (a clone's URL names its owner); the sha and branch stay", () => {
    const started = (originUrl: string | null) => ({
      method: 'thread/started',
      params: { thread: { id: THREAD, gitInfo: { sha: 'abc1234', branch: 'main', originUrl } } },
    })
    expect(redactCodexValue(started('https://github.com/fake-person/fake-repo.git'))).toEqual({
      value: started(REDACTED),
      counts: { 'codex-git': 1 },
    })
    expect(redactCodexValue(started(null))).toEqual({ value: started(null), counts: {} })
  })

  it('leaves alone what is not profile data', () => {
    const untouched = [
      // A command approval's environment, a thread's environments, a free-text warning (the terms take that).
      {
        id: 0,
        method: 'item/commandExecution/requestApproval',
        params: { environmentId: null, cwd: '<CWD>' },
      },
      { result: { thread: { id: THREAD, environments: [{ environmentId: 'local', cwd: '<CWD>' }] } } },
      { method: 'warning', params: { threadId: null, message: `MCP client for \`${FAKES.mcp}\` failed` } },
      { result: { userAgent: 'fake' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Done.' } },
    ]
    for (const msg of untouched) expect(redactCodexValue(msg)).toEqual({ value: msg, counts: {} })
  })
})

describe('redactUserAgent', () => {
  it.each([
    [
      'dim-factory/0.160.1 (Windows 10.0.99999; x86_64) dumb (dim-factory; 0.1.0)',
      `dim-factory/0.160.1 ${REDACTED} (dim-factory; 0.1.0)`,
    ],
    [
      'dim-factory/0.160.1 (Mac OS 26.1.0; arm64) vscode/1.105.0 (dim-factory; 0.1.0)',
      `dim-factory/0.160.1 ${REDACTED} (dim-factory; 0.1.0)`,
    ],
    ['codex_cli_rs/0.160.1 (Ubuntu 24.4.0; x86_64) WindowsTerminal', `codex_cli_rs/0.160.1 ${REDACTED}`],
    ['dim-factory (Windows 10.0.99999)', `dim-factory ${REDACTED}`],
    [
      `dim-factory/0.160.1 ${REDACTED} (dim-factory; 0.1.0)`,
      `dim-factory/0.160.1 ${REDACTED} (dim-factory; 0.1.0)`,
    ],
    ['fake', 'fake'],
    ['codex_cli_rs/0.160.1', 'codex_cli_rs/0.160.1'],
  ])('%s', (ua, expected) => {
    expect(redactUserAgent(ua)).toBe(expected)
  })
})

// ---- the profile's own files ------------------------------------------------------------------------------------

const CONFIG = [
  '# a real profile, every value fake',
  'model = "gpt-5.6-terra"',
  'approval_policy = "on-request"',
  'mcp_servers.fake-dotted.command = "/opt/fake/dotted-mcp"',
  'developer_instructions = """',
  'Always answer as the fake person from Fake Street.',
  'Short line.',
  '"""',
  "model_instructions_file = 'fake-instructions.md'",
  'weird = "unterminated',
  'this line is not toml',
  '',
  '[mcp_servers.fake-notes]',
  "command = 'C:\\fake\\tools\\fake-notes-mcp.exe'",
  'args = [',
  '  "--vault", "D:/fake-vault/secret-notes",  # a comment',
  '  "-y",',
  ']',
  'env = { FAKE_TOKEN = "fake-token-value-0123456789", MODE = "1" }',
  'enabled_tools = ["read_note", "search"]',
  '',
  '[mcp_servers."fake remote"]',
  'url = "https://mcp.fake-remote.example/mcp"',
  'startup_timeout_sec = 30',
  '',
  '[ mcp_servers . git ]',
  'command = "uvx"',
  '',
  "[projects.'C:\\Users\\fake\\secret-project']",
  'trust_level = "trusted"',
  '',
  '[[profiles.work.tags]]',
  'name = "x\\u0041\\t"',
  '[profiles.work]',
  "instructions = '''Use the fake company style guide for every answer.'''",
].join('\n')

describe('tomlStrings', () => {
  it('reads tables, dotted and quoted keys, arrays, inline tables and every string form', () => {
    const { entries, skipped } = tomlStrings(CONFIG)
    const strings = entries.filter((e) => e.value !== null).map((e) => [e.path.join('.'), e.value])
    expect(strings).toEqual([
      ['model', 'gpt-5.6-terra'],
      ['approval_policy', 'on-request'],
      ['mcp_servers.fake-dotted.command', '/opt/fake/dotted-mcp'],
      ['developer_instructions', 'Always answer as the fake person from Fake Street.\nShort line.\n'],
      ['model_instructions_file', 'fake-instructions.md'],
      ['mcp_servers.fake-notes.command', 'C:\\fake\\tools\\fake-notes-mcp.exe'],
      ['mcp_servers.fake-notes.args', '--vault'],
      ['mcp_servers.fake-notes.args', 'D:/fake-vault/secret-notes'],
      ['mcp_servers.fake-notes.args', '-y'],
      ['mcp_servers.fake-notes.env.FAKE_TOKEN', 'fake-token-value-0123456789'],
      ['mcp_servers.fake-notes.env.MODE', '1'],
      ['mcp_servers.fake-notes.enabled_tools', 'read_note'],
      ['mcp_servers.fake-notes.enabled_tools', 'search'],
      ['mcp_servers.fake remote.url', 'https://mcp.fake-remote.example/mcp'],
      ['mcp_servers.git.command', 'uvx'],
      ['projects.C:\\Users\\fake\\secret-project.trust_level', 'trusted'],
      ['profiles.work.tags.name', 'xA\t'],
      ['profiles.work.instructions', 'Use the fake company style guide for every answer.'],
    ])
    // The two broken statements are skipped, and the scanner goes on after them.
    expect(skipped).toBe(2)
    const headers = entries.filter((e) => e.value === null).map((e) => e.path.join('.'))
    expect(headers).toEqual(
      expect.arrayContaining(['mcp_servers.fake-notes', 'mcp_servers.fake remote', 'mcp_servers.git']),
    )
  })

  it('CRLF, literal escapes and line-ending backslashes', () => {
    const text = 'a = """\r\none \\\r\n   two"""\r\nb = \'C:\\x\\y\'\r\nc = "\\"q\\""\r\n'
    expect(tomlStrings(text)).toEqual({
      entries: [
        { path: ['a'], value: 'one two' },
        { path: ['b'], value: 'C:\\x\\y' },
        { path: ['c'], value: '"q"' },
      ],
      skipped: 0,
    })
  })
})

describe('profileTerms', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-profile-'))
  writeFileSync(join(home, 'config.toml'), CONFIG)
  writeFileSync(
    join(home, 'AGENTS.md'),
    '# House rules\n\n- Prefer the fake house style when writing code.\n- Be brief.\n',
  )
  writeFileSync(join(home, 'fake-instructions.md'), 'You are helping the fake person with fake projects.\n')
  const terms = profileTerms(home)

  it('names the MCP servers (4 characters or more) and nothing else', () => {
    expect([...terms.names].sort()).toEqual(['fake remote', 'fake-dotted', 'fake-notes'])
  })

  it('takes paths, URLs, packages, secrets, trusted folders and instruction lines verbatim', () => {
    expect([...terms.literals].sort()).toEqual(
      [
        '/opt/fake/dotted-mcp',
        'Always answer as the fake person from Fake Street.',
        'C:\\fake\\tools\\fake-notes-mcp.exe',
        'C:\\Users\\fake\\secret-project',
        'D:/fake-vault/secret-notes',
        'Prefer the fake house style when writing code.',
        'Use the fake company style guide for every answer.',
        'You are helping the fake person with fake projects.',
        'fake-token-value-0123456789',
        'https://mcp.fake-remote.example/mcp',
      ].sort(),
    )
    expect(terms.skipped).toBe(2)
  })

  it('an empty or missing profile names nothing', () => {
    expect(profileTerms(mkdtempSync(join(tmpdir(), 'codex-empty-')))).toEqual({
      literals: [],
      names: [],
      skipped: 0,
    })
  })

  it('instruction lines drop list and heading markers and short lines', () => {
    expect(
      instructionLines(
        '## Style\n1. Use the fake company style guide.\n> Quote: keep answers short please\nok',
      ),
    ).toEqual(['Use the fake company style guide.', 'Quote: keep answers short please'])
  })
})

describe('redactTerms', () => {
  const words = wordMatchers(['fake-notes', 'search'])

  it('replaces whole words in free text only: an enum or id equal to a name stays', () => {
    const r = redactTerms(
      {
        type: 'search',
        id: 'fake-notes',
        message: 'MCP client for `FAKE-NOTES` failed',
        delta: 'fake-notes',
        path: 'C:\\x\\fake-notes\\a.js',
        list: ['search the notes', 'search'],
        other: 'fake-notesy and research',
      },
      words,
    )
    expect(r.value).toEqual({
      type: 'search',
      id: 'fake-notes',
      message: `MCP client for \`${REDACTED}\` failed`,
      delta: REDACTED,
      path: `C:\\x\\${REDACTED}\\a.js`,
      list: [`${REDACTED} the notes`, 'search'],
      other: 'fake-notesy and research',
    })
    expect(r.count).toBe(4)
  })

  it('a text line (stderr, the -o file) everywhere', () => {
    expect(redactTerms('ERROR mcp: fake-notes failed; search off', words)).toEqual({
      value: `ERROR mcp: ${REDACTED} failed; ${REDACTED} off`,
      count: 2,
    })
    expect(redactTerms('nothing here', [])).toEqual({ value: 'nothing here', count: 0 })
  })
})
