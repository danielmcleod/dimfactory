// Every committed fixture must already be redacted: no real emails, user paths, account or installation ids or
// token-shaped strings. Uses the same rules as the recorder (src/shared/redact.ts): a redacted fixture is a fixed
// point. Every server frame of a Codex recording is also a fixed point of the recorder's Codex profile rules
// (scripts/redact-codex.mjs: the machine in the userAgent, the plan, the remote-control identity, MCP servers, apps,
// hooks, config warnings, custom instructions, a git remote, a quota window's length and reset), so a live recording
// from a real ~/.codex cannot carry them; nor a path under the recording machine's temp folder (the recorder's <TMP>).
// Every agent frame of a Gemini ACP recording is likewise a fixed point of the recorder's Gemini rules
// (scripts/redact-gemini.mjs: the project folder under .gemini/tmp, MCP names, the quota's tier and resets).
// From the live re-record on the user's everyday ~/.claude: every CLI frame of a Claude recording is a fixed point of
// the recorder's Claude rules (scripts/redact-claude.mjs: the commands the CLI does not mark built in, the user's and
// plugins' subagents, skills and output styles, plugins, MCP servers and tools, hook frames), and every plain skill or
// command name init lists is one the same recording's initialize reply marks built in.
import { readdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REDACTED, builtinCommandNames, redactClaudeValue } from '../../scripts/redact-claude.mjs'
import { redactCodexValue } from '../../scripts/redact-codex.mjs'
import { redactGeminiText, redactGeminiValue } from '../../scripts/redact-gemini.mjs'
import { redactJsonValue, redactLine, redactText } from '../../src/shared/redact.ts'

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const ALLOWED_USERS = new Set(['user'])

// \Users\<name> (also JSON-escaped \\Users\\<name>); /Users/<name> and /home/<name> not inside a URL or word.
const WINDOWS_USER_PATH = /(?:\\\\|\\)Users(?:\\\\|\\)([^\\/"'\s<>:*?|]+)/gi
const POSIX_USER_PATH = /(?<![\w.~-])\/(?:Users|home)\/([^/"'\s<>\\]+)/g
// A Windows user's temp folder (any escaping) or a POSIX one, with a path under it: a scratch folder names a session.
const TEMP_PATH =
  /AppData(?:\\{1,4}|\/)Local(?:\\{1,4}|\/)Temp(?:\\{1,4}|\/)[^\\/"'\s<>]|(?<![\w.~-])\/(?:tmp|var\/folders)\/[^/"'\s<>]/i

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

function stable(value: unknown): string {
  return JSON.stringify(value)
}

/** Key-based rules (secret keys, account ids) must leave every JSON value unchanged, including recorded lines. */
function checkJson(value: unknown, where: string, problems: string[]): void {
  const redacted = redactJsonValue(value, { mode: 'fixture' })
  if (stable(redacted.value) !== stable(value)) {
    problems.push(`${where}: unredacted JSON (${Object.keys(redacted.counts).join(', ') || 'values'})`)
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const line = (value as Record<string, unknown>)['line']
    if (typeof line === 'string' && /^\s*[[{]/.test(line)) {
      const parsed = tryParse(line)
      if (parsed !== undefined) {
        if (redactLine(line, { mode: 'fixture' }).text !== stable(parsed))
          problems.push(`${where}: unredacted recorded line`)
      } else {
        // Not JSON, only bracketed: a stderr line like `[claude-code:unrecognized_model] {…}` (C11b). The text
        // scan covers the line; its JSON suffix still gets the key-based check.
        const suffix = tryParse(line.replace(/^\s*\[[^\]\n]*\]\s*/, ''))
        if (suffix !== undefined && suffix !== null && typeof suffix === 'object')
          checkJson(suffix, `${where} (embedded JSON)`, problems)
      }
    }
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function findViolations(text: string, name = 'text'): string[] {
  const problems: string[] = []

  const tokens = redactText(text, { mode: 'fixture' })
  for (const [rule, n] of Object.entries(tokens.counts)) problems.push(`${name}: ${rule} x${n}`)

  if (name.endsWith('.json')) {
    const whole = tryParse(text)
    if (whole !== undefined) checkJson(whole, name, problems)
  }
  text.split('\n').forEach((line, i) => {
    if (!/^\s*[[{]/.test(line)) return
    const parsed = tryParse(line)
    if (parsed !== undefined) checkJson(parsed, `${name}:${i + 1}`, problems)
  })

  for (const m of text.matchAll(WINDOWS_USER_PATH)) {
    if (!ALLOWED_USERS.has((m[1] ?? '').toLowerCase())) problems.push(`${name}: Windows user path ${m[0]}`)
  }
  for (const m of text.matchAll(POSIX_USER_PATH)) {
    if (!ALLOWED_USERS.has(m[1] ?? '')) problems.push(`${name}: user path ${m[0]}`)
  }

  const host = hostname()
  if (host.length >= 6 && text.toLowerCase().includes(host.toLowerCase()))
    problems.push(`${name}: this machine's hostname`)

  if (name.startsWith('codex/')) problems.push(...codexViolations(text, name))
  if (name.startsWith('gemini/')) problems.push(...geminiViolations(text, name))
  if (name.startsWith('claude/')) problems.push(...claudeViolations(text, name))
  return problems
}

/** The CLI frames (out) of a Claude recording, parsed, with their line numbers. */
function claudeCliFrames(text: string): { line: number; msg: Record<string, unknown> }[] {
  const out: { line: number; msg: Record<string, unknown> }[] = []
  text.split('\n').forEach((raw, i) => {
    const frame = /^\s*\{/.test(raw) ? tryParse(raw) : undefined
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return
    const { dir, line } = frame as Record<string, unknown>
    if (dir !== 'out' || typeof line !== 'string') return
    const msg = /^\s*\{/.test(line) ? tryParse(line) : undefined
    if (msg !== null && typeof msg === 'object' && !Array.isArray(msg))
      out.push({ line: i + 1, msg: msg as Record<string, unknown> })
  })
  return out
}

/**
 * CLI frames of a Claude recording the Claude profile rules would still change, and plain skill or command names
 * in init that the recording's own initialize reply does not mark built in (the user's own skills are plain names).
 */
function claudeViolations(text: string, name: string): string[] {
  const problems: string[] = []
  const frames = claudeCliFrames(text)
  const builtins = new Set(frames.flatMap((f) => builtinCommandNames(f.msg)))
  for (const { line, msg } of frames) {
    const rules = Object.keys(redactClaudeValue(msg).counts)
    if (rules.length > 0) problems.push(`${name}:${line}: Claude profile data (${rules.join(', ')})`)
    if (builtins.size === 0 || msg['type'] !== 'system' || msg['subtype'] !== 'init') continue
    for (const key of ['slash_commands', 'skills']) {
      const list = msg[key]
      if (!Array.isArray(list)) continue
      for (const n of list)
        if (typeof n === 'string' && n !== REDACTED && !builtins.has(n.toLowerCase()))
          problems.push(
            `${name}:${line}: init.${key} names a command its initialize reply does not mark built in`,
          )
    }
  }
  return problems
}

/** Agent frames (out, err) of a Gemini recording the Gemini profile rules would still change. */
function geminiViolations(text: string, name: string): string[] {
  const problems: string[] = []
  if (TEMP_PATH.test(text)) problems.push(`${name}: a path under a temp folder (the recorder writes <TMP>)`)
  text.split('\n').forEach((raw, i) => {
    const frame = /^\s*\{/.test(raw) ? tryParse(raw) : undefined
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return
    const { dir, line } = frame as Record<string, unknown>
    if ((dir !== 'out' && dir !== 'err') || typeof line !== 'string') return
    const msg = /^\s*[[{]/.test(line) ? tryParse(line) : undefined
    if (msg === null || typeof msg !== 'object') {
      if (redactGeminiText(line) !== line)
        problems.push(`${name}:${i + 1}: Gemini profile data (gemini-project)`)
      return
    }
    const rules = Object.keys(redactGeminiValue(msg).counts)
    if (rules.length > 0) problems.push(`${name}:${i + 1}: Gemini profile data (${rules.join(', ')})`)
  })
  return problems
}

/** Server frames (out, err) of a Codex recording the Codex profile rules would still change. */
function codexViolations(text: string, name: string): string[] {
  const problems: string[] = []
  if (TEMP_PATH.test(text)) problems.push(`${name}: a path under a temp folder (the recorder writes <TMP>)`)
  text.split('\n').forEach((raw, i) => {
    const frame = /^\s*\{/.test(raw) ? tryParse(raw) : undefined
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return
    const { dir, line } = frame as Record<string, unknown>
    if ((dir !== 'out' && dir !== 'err') || typeof line !== 'string') return
    const msg = /^\s*[[{]/.test(line) ? tryParse(line) : undefined
    if (msg === null || typeof msg !== 'object') return
    const rules = Object.keys(redactCodexValue(msg).counts)
    if (rules.length > 0) problems.push(`${name}:${i + 1}: Codex profile data (${rules.join(', ')})`)
  })
  return problems
}

/** Server frames of the Codex recordings under `files`, parsed (the scan above must not pass vacuously). */
function codexServerFrames(files: readonly string[]): unknown[] {
  return files
    .filter((f) => /[\\/]codex[\\/].*recording\.jsonl$/.test(f))
    .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
    .map((l) => (/^\s*\{/.test(l) ? (tryParse(l) as Record<string, unknown> | undefined) : undefined))
    .filter((f) => f?.['dir'] === 'out' && typeof f['line'] === 'string')
    .map((f) => tryParse(String(f?.['line'])))
}

describe('fixture redaction checker', () => {
  // Secret-shaped samples are assembled at runtime so no literal ever lands in the repo.
  const leaks: Record<string, string> = {
    email: `contact ${['bob', 'realcorp.com'].join('@')}`,
    'windows path': 'cwd C:\\Users\\alice\\project',
    'json-escaped windows path': '{"cwd":"C:\\\\Users\\\\alice\\\\project"}',
    'mac path': 'open /Users/alice/project',
    'linux path': 'cd /home/alice/src',
    'anthropic key': `key=${['sk', 'ant', 'api03', 'x'.repeat(24)].join('-')}`,
    'github token': `ghp_${'A'.repeat(36)}`,
    'secret-named key': '{"api_key":"abc123"}',
    'account key in a recorded line': JSON.stringify({
      t: 0,
      dir: 'out',
      line: JSON.stringify({ email: 'x' }),
    }),
    'secret key in a tagged stderr line': JSON.stringify({
      t: 0,
      dir: 'err',
      line: `[claude-code:x] ${JSON.stringify({ api_key: 'abc123' })}`,
    }),
  }
  it.each(Object.entries(leaks))('flags %s', (_label, sample) => {
    expect(findViolations(sample)).not.toEqual([])
  })

  const clean = [
    'reach user@example.invalid',
    'C:\\Users\\user\\project and /home/user/src and /Users/user/x and ~/notes.txt',
    'see https://example.com/home/page or <CWD>/src',
    '{"apiKey":"<TOKEN>","uuid":"<REDACTED>","usage":{"max_tokens":5,"output_tokens":7}}',
    JSON.stringify({ t: 0, dir: 'in', line: JSON.stringify({ type: 'user', uuid: '<REDACTED>' }) }),
    JSON.stringify({
      t: 0,
      dir: 'err',
      line: '[claude-code:unrecognized_model] {"model":"claude-nonexistent-9","query_source":"sdk"}',
    }),
  ]
  it.each(clean)('accepts %s', (sample) => {
    expect(findViolations(sample)).toEqual([])
  })
})

describe('fixture redaction checker, Codex server frames (live stage A: a real ~/.codex)', () => {
  // The frames of the stage A handshake on the everyday profile (scratch recording, never committed), with every
  // personal value replaced by an obviously fake one; plus the frames a real profile adds once a thread runs.
  const out = (msg: unknown): string => JSON.stringify({ t: 0, dir: 'out', line: JSON.stringify(msg) })
  const FAKE_INSTALL = '11111111-2222-4333-8444-555555555555'
  const initialize = (userAgent: string): string =>
    out({
      id: 1,
      result: { userAgent, codexHome: '<CODEX_HOME>', platformFamily: 'windows', platformOs: 'windows' },
    })
  const remoteControl = (o: { serverName: string; installationId: string; environmentId: string | null }) =>
    out({
      method: 'remoteControl/status/changed',
      params: { status: 'disabled', ...o },
      emittedAtMs: 1791626208976,
    })
  const rateLimits = (
    planType: string,
    balance: string,
    window = { windowDurationMins: 0, resetsAt: 0 },
  ): string =>
    out({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          limitName: null,
          normalModelSlug: null,
          primary: { usedPercent: 12, ...window },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance },
          individualLimit: null,
          spendControlReached: false,
          planType,
          rateLimitReachedType: null,
        },
      },
    })
  const mcpStartup = (name: string, error: string | null): string =>
    out({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: null, name, status: 'failed', error, failureReason: null },
    })
  const mcpCall = (server: string, tool: string, text: string): string =>
    out({
      method: 'item/completed',
      params: {
        threadId: 't',
        turnId: 'u',
        completedAtMs: 1,
        item: {
          type: 'mcpToolCall',
          id: 'call_1',
          server,
          tool,
          status: 'completed',
          arguments: { title: text },
          appContext: null,
          mcpAppUi: null,
          pluginId: null,
          readOnlyHint: true,
          result: { content: [{ type: 'text', text }], structuredContent: null, _meta: null },
          error: null,
          durationMs: 12,
        },
      },
    })
  const instructions = (text: string): string =>
    out({ id: 7, result: { config: { developer_instructions: text, model: null } } })

  const CODEX = 'codex/sample/recording.jsonl'
  const leaks: Record<string, string> = {
    'the installation id': remoteControl({
      serverName: 'host',
      installationId: FAKE_INSTALL,
      environmentId: null,
    }),
    'the machine in the userAgent': initialize(
      'dim-factory/0.160.1 (Windows 10.0.99999; x86_64) dumb (dim-factory; 0.1.0)',
    ),
    'a remote-control server name and environment': remoteControl({
      serverName: 'FAKE-PC-01',
      installationId: '<REDACTED>',
      environmentId: 'env-fake-0001',
    }),
    'the ChatGPT plan': rateLimits('plus', '<REDACTED>'),
    'the credits balance': rateLimits('unknown', '123.45'),
    // A 30-day window with no second one says which plan; its reset dates the account's window.
    'a quota window’s length and reset': rateLimits('unknown', '<REDACTED>', {
      windowDurationMins: 43200,
      resetsAt: 1791626208,
    }),
    'a scratch path under the temp folder': JSON.stringify({
      t: 0,
      dir: 'out',
      line: JSON.stringify({ delta: 'Directory: ~\\AppData\\Local\\Temp\\fake-tool\\0f0f0f0f\\scrat\r\n' }),
    }),
    'an MCP server name from the config': mcpStartup('fake-notes', null),
    'an MCP startup error': mcpStartup('<REDACTED>', 'program not found: fake-notes-mcp'),
    'an MCP tool call': mcpCall('fake-notes', 'read_note', 'Dear fake diary'),
    'custom instructions': instructions('Sign every answer as the fake person.'),
  }
  it.each(Object.entries(leaks))('flags %s', (_label, sample) => {
    expect(findViolations(sample, CODEX)).not.toEqual([])
  })

  const clean = [
    remoteControl({ serverName: 'host', installationId: '<REDACTED>', environmentId: null }),
    initialize('dim-factory/0.160.1 <REDACTED> (dim-factory; 0.1.0)'),
    rateLimits('unknown', '<REDACTED>'),
    mcpStartup('<REDACTED>', '<REDACTED>'),
    mcpCall('<REDACTED>', '<REDACTED>', '<REDACTED>'),
    instructions('<REDACTED>'),
    // Not profile data: a command approval's environment, a host frame, a stderr line.
    out({ id: 0, method: 'item/commandExecution/requestApproval', params: { environmentId: null } }),
    JSON.stringify({ t: 0, dir: 'in', line: JSON.stringify({ id: 1, method: 'initialize' }) }),
    JSON.stringify({
      t: 0,
      dir: 'err',
      line: 'WARNING: proceeding, even though we could not create PATH aliases',
    }),
  ]
  it.each(clean)('accepts %s', (sample) => {
    expect(findViolations(sample, CODEX)).toEqual([])
  })
})

describe('fixture redaction checker, Gemini agent frames (a real ~/.gemini)', () => {
  // What a live Gemini recording on a signed-in profile would carry, with every personal value an obviously fake one.
  const out = (msg: unknown): string => JSON.stringify({ t: 0, dir: 'out', line: JSON.stringify(msg) })
  const update = (u: Record<string, unknown>): string =>
    out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: u } })
  const planFile = (project: string): string =>
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'write_file-1',
      title: 'Writing to plans/a.md',
      kind: 'edit',
      status: 'in_progress',
      locations: [{ path: `<GEMINI_CLI_HOME>/.gemini/tmp/${project}/s/plans/a.md` }],
    })
  const mcpAsk = (title: string, option: string): string =>
    out({
      jsonrpc: '2.0',
      id: 0,
      method: 'session/request_permission',
      params: {
        sessionId: 's',
        options: [{ optionId: 'proceed_always_server', name: option, kind: 'allow_always' }],
        toolCall: { toolCallId: 'x', title, kind: 'other' },
      },
    })
  const quota = (tier: string): string =>
    out({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn', _meta: { quota: { user_tier: tier } } } })

  const GEMINI = 'gemini/sample/recording.jsonl'
  const leaks: Record<string, string> = {
    'the project folder under .gemini/tmp': planFile('9f8e7d6c5b4a'),
    'an MCP server in a tool title': mcpAsk('read_note (fake-notes MCP Server)', '<REDACTED>'),
    'an MCP server in an option name': mcpAsk(
      '<REDACTED> (<REDACTED> MCP Server)',
      'Always allow all tools from server "fake-notes"',
    ),
    'the quota tier': quota('fake-paid-tier'),
    'a project folder in stderr': JSON.stringify({
      t: 0,
      dir: 'err',
      line: 'saved ~/.gemini/tmp/abc123/logs.json',
    }),
  }
  it.each(Object.entries(leaks))('flags %s', (_label, sample) => {
    expect(findViolations(sample, GEMINI)).not.toEqual([])
  })

  const clean = [
    planFile('<PROJECT>'),
    mcpAsk('<REDACTED> (<REDACTED> MCP Server)', 'Always allow all tools from server "<REDACTED>"'),
    quota('<REDACTED>'),
    JSON.stringify({ t: 0, dir: 'err', line: 'saved ~/.gemini/tmp/<PROJECT>/logs.json' }),
    // Host frames are Dim Factory's own; a plain shell title is not an MCP call.
    JSON.stringify({
      t: 0,
      dir: 'in',
      line: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    }),
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'r',
      title: 'npm test (Run the test suite)',
      kind: 'execute',
    }),
  ]
  it.each(clean)('accepts %s', (sample) => {
    expect(findViolations(sample, GEMINI)).toEqual([])
  })
})

describe('fixture redaction checker, Claude CLI frames (the everyday ~/.claude)', () => {
  // What a live recording on the user's own profile carries, with every personal value an obviously fake one.
  const out = (msg: unknown): string => JSON.stringify({ t: 0, dir: 'out', line: JSON.stringify(msg) })
  const reply = (commands: unknown[], agents: unknown[] = []): string =>
    out({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'init-1', response: { commands, agents } },
    })
  const init = (o: Record<string, unknown>): string =>
    out({ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [], agents: ['Explore'], ...o })
  const BUILTIN = { name: 'code-review', description: 'Review.', argumentHint: '', builtin: true }
  const OWN = { name: 'fake-own-skill', description: 'Mine. (user)', argumentHint: '' }
  const OWN_DONE = { name: REDACTED, description: REDACTED, argumentHint: REDACTED }

  const CLAUDE = 'claude/stdio/sample/recording.jsonl'
  const leaks: Record<string, string> = {
    'a command of the user’s in the initialize reply': reply([BUILTIN, OWN]),
    'a subagent of the user’s in the initialize reply': reply(
      [BUILTIN],
      [{ name: 'fake-reviewer', description: 'Mine.', model: 'opus' }],
    ),
    'a plugin’s skill in init': init({ skills: ['acme-skills:fakedocs'] }),
    'a subagent of the user’s in init': init({ agents: ['Explore', 'fake-reviewer'] }),
    'a plugin that is not built in': init({
      plugins: [{ name: 'fake-plugin', path: '~/x', source: 'fake@m' }],
    }),
    'an MCP server and its tool': init({
      mcp_servers: [{ name: 'fake-notes', status: 'connected' }],
      tools: ['mcp__fake-notes__read'],
    }),
    'a hook’s output': out({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'Stop',
      output: 'Hi Fake',
      stdout: '',
      stderr: '',
    }),
    'a plain user skill the reply does not mark built in': [
      reply([BUILTIN, OWN_DONE]),
      init({ slash_commands: ['code-review', 'fake-own-skill'], skills: ['code-review'] }),
    ].join('\n'),
  }
  it.each(Object.entries(leaks))('flags %s', (_label, sample) => {
    expect(findViolations(sample, CLAUDE)).not.toEqual([])
  })

  const clean = [
    [
      reply(
        [BUILTIN, OWN_DONE],
        [
          { name: 'Explore', description: 'Search.' },
          { name: REDACTED, description: REDACTED },
        ],
      ),
      init({
        slash_commands: ['code-review', REDACTED],
        skills: ['code-review', REDACTED],
        agents: ['Explore', REDACTED],
        plugins: [{ name: 'cc-plugin-telemetry', path: 'builtin', source: 'cc-plugin-telemetry@builtin' }],
        mcp_servers: [{ name: REDACTED, status: 'connected' }],
      }),
    ].join('\n'),
    // Without an initialize reply (C05c/d) the plain names cannot be checked; namespaced ones still are.
    init({ slash_commands: ['code-review', 'clear'], skills: ['code-review'] }),
    out({ type: 'system', subtype: 'hook_started', hook_name: REDACTED, hook_event: 'Stop' }),
    // Host frames are Dim Factory's own.
    JSON.stringify({
      t: 0,
      dir: 'in',
      line: JSON.stringify({ type: 'control_request', request: { subtype: 'initialize' } }),
    }),
  ]
  it.each(clean)('accepts %s', (sample) => {
    expect(findViolations(sample, CLAUDE)).toEqual([])
  })
})

describe('tests/fixtures', () => {
  const files = listFiles(FIXTURES)

  it('checks every Claude CLI frame against the Claude profile rules (initialize, init, the turns)', () => {
    const frames = files
      .filter((f) => /[\\/]claude[\\/].*recording\.jsonl$/.test(f))
      .flatMap((f) => claudeCliFrames(readFileSync(f, 'utf8')).map((x) => x.msg))
    expect(frames.length).toBeGreaterThan(1000)
    const kinds = new Set(frames.map((m) => [m['type'], m['subtype'] ?? ''].join('/')))
    for (const k of ['control_response/', 'system/init', 'result/success']) expect(kinds.has(k)).toBe(true)
  })

  it('contains fixtures to scan', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('scans the Codex fixtures too (recordings, expected events, re-record recipes)', () => {
    const rel = files.map((f) => relative(FIXTURES, f).replace(/\\/g, '/'))
    for (const dir of ['codex/app-server/', 'codex/exec/', 'codex/recipes/'])
      expect(rel.some((f) => f.startsWith(dir) && /\.jsonl?$/.test(f))).toBe(true)
  })

  it('checks every Codex server frame against the Codex profile rules (the handshake, threads, items)', () => {
    const frames = codexServerFrames(files)
    expect(frames.length).toBeGreaterThan(300)
    const methods = new Set(frames.map((m) => (m as Record<string, unknown> | undefined)?.['method']))
    for (const m of ['remoteControl/status/changed', 'mcpServer/elicitation/request', 'item/completed'])
      expect(methods.has(m)).toBe(true)
  })

  it('scans the Gemini fixtures too (recordings, expected events, re-record recipes)', () => {
    const rel = files.map((f) => relative(FIXTURES, f).replace(/\\/g, '/'))
    for (const dir of ['gemini/acp/', 'gemini/recipes/'])
      expect(rel.some((f) => f.startsWith(dir) && /\.jsonl?$/.test(f))).toBe(true)
  })

  it('checks every Gemini agent frame against the Gemini profile rules (setup, updates, permissions)', () => {
    const frames = files
      .filter((f) => /[\\/]gemini[\\/].*recording\.jsonl$/.test(f))
      .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
      .map((l) => (/^\s*\{/.test(l) ? (tryParse(l) as Record<string, unknown> | undefined) : undefined))
      .filter((f) => f?.['dir'] === 'out' && typeof f['line'] === 'string')
      .map((f) => tryParse(String(f?.['line'])) as Record<string, unknown> | undefined)
    expect(frames.length).toBeGreaterThan(150)
    const methods = new Set(frames.map((m) => m?.['method']))
    for (const m of ['session/update', 'session/request_permission']) expect(methods.has(m)).toBe(true)
  })

  it('holds no unredacted emails, user paths, account ids or tokens', () => {
    const problems: string[] = []
    for (const file of files) {
      const buffer = readFileSync(file)
      if (buffer.includes(0)) continue // binary
      problems.push(...findViolations(buffer.toString('utf8'), relative(FIXTURES, file).replace(/\\/g, '/')))
    }
    expect(problems).toEqual([])
  })
})
