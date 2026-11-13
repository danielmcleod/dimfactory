#!/usr/bin/env node
// Synthesizes the Gemini ACP fixtures (G01–G10, plus process exit codes) from the pinned Agent Client Protocol schema
// (src/core/adapters/acp-base/protocol/v1.25.0/) and gemini-cli's own source.
//
//   node tests/fixtures/gemini/recipes/synthesize.mjs [--check]
//
// The adapter was built without the Gemini CLI (not installed on the dev machine), so every fixture is synthesized:
// its header says "synthesized": true and names its sources. A review checked the agent's side against gemini-cli's
// own source (v0.62.0, v0.63.0, v0.64.0-preview.0 and main, packages/cli/src/acp/acpSession.ts and core tools): a
// shell confirmation's title is its command and its text content the explanation; exit_plan_mode is kind `other`,
// titled with its plan file; mode changes arrive as `[MODE_UPDATE] <mode>` text; 0.62 and 0.63 answer the prompt with
// `_meta.quota` and no `usage` (0.64 adds `usage`, whose totalTokens is input + output, and `usage_update`); a
// cancelled prompt carries neither. The host frames are built with the ACP base's own wire builders
// (src/core/adapters/acp-base/protocol.ts), the agent frames follow the schema (tests/unit/acp/protocol/
// fixtures-schema.test.ts validates every frame) and go through the recorder's Gemini rules
// (scripts/redact-gemini.mjs), as a live recording would. For each scenario this also writes the live re-record
// recipe (recipes/<ID>-<slug>/stdin.jsonl, responders.mjs, pass.json, record.txt; README "Re-recording live").
// --check compares instead of writing (exit 1 when a committed file differs).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CANCELLED_OUTCOME,
  initializeParams,
  loadSessionParams,
  newSessionParams,
  permissionReply,
  promptParams,
  resumeSessionParams,
  setModeParams,
  cancelParams,
  usageFromAcp,
  usageFromContext,
} from '../../../../src/core/adapters/acp-base/protocol.ts'
import { redactGeminiValue } from '../../../../scripts/redact-gemini.mjs'
import { GEMINI_PREFS } from './dim-factory-responder.mjs'

const SELF = fileURLToPath(import.meta.url)
const FIXTURES = resolve(dirname(SELF), '..')
const RECIPES = dirname(SELF)
const ROUTE = 'acp'
/** The recommended Gemini CLI: every fixture's shape unless it names another version. */
const CLI_VERSION = '0.62.0'
/** The first Gemini CLI that answers session/prompt with `usage` (buildPromptResponse) and sends usage_update. */
const USAGE_VERSION = '0.64.0-preview.0'
const CWD = '<CWD>'
const T0_MS = 1791602700000
const SOURCES =
  'src/core/adapters/acp-base/protocol/v1.25.0 (Agent Client Protocol schema v1.25.0, schema.json and ' +
  'schema.unstable.json); github.com/google-gemini/gemini-cli (v0.62.0, v0.63.0, v0.64.0-preview.0 and main: ' +
  'packages/cli/src/acp/acpSession.ts, acpUtils.ts and the core tools)'
/** Mode mapping, Gemini ACP: readonly default (every ask rejected), autoedit autoEdit, full yolo; Plan plan. */
const MODE_IDS = { readonly: 'default', autoedit: 'autoEdit', full: 'yolo' }
const PLAN_MODE_ID = 'plan'

const sid = (n) => `7c4e9a12-3b5d-4f60-8a1b-2c3d4e5f60${String(n).padStart(2, '0')}`
const loc = (rel) => ({ path: `${CWD}/${rel}` })
const textContent = (text) => ({ type: 'content', content: { type: 'text', text } })
const diff = (rel, oldText, newText) => ({ type: 'diff', path: `${CWD}/${rel}`, oldText, newText })

// ---- one recorded process -----------------------------------------------------------------------------------------

class Rec {
  constructor() {
    this.frames = []
    this.nextClient = 1
    this.nextAgent = 0
    this.clock = T0_MS
  }
  push(dir, value) {
    // An agent message is written as the recorder writes a live one (scripts/redact-gemini.mjs: the project folder,
    // MCP names, the quota), so tests/unit/fixtures-redaction.test.ts holds for every fixture.
    const v = dir === 'out' && typeof value !== 'string' ? redactGeminiValue(value).value : value
    this.frames.push({ t: this.frames.length * 5, dir, line: typeof v === 'string' ? v : JSON.stringify(v) })
  }
  /** Gemini's tool call ids: `<tool name>-<epoch ms>`. */
  callId(tool) {
    this.clock += 101
    return `${tool}-${this.clock}`
  }
  // client → agent
  request(method, params) {
    const id = this.nextClient++
    this.push('in', { jsonrpc: '2.0', id, method, params })
    return id
  }
  notify(method, params) {
    this.push('in', { jsonrpc: '2.0', method, params })
  }
  reply(id, result) {
    this.push('in', { jsonrpc: '2.0', id, result })
  }
  // agent → client
  result(id, result) {
    this.push('out', { jsonrpc: '2.0', id, result })
  }
  error(id, error) {
    this.push('out', { jsonrpc: '2.0', id, error })
  }
  update(sessionId, update) {
    this.push('out', { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
  }
  agentRequest(method, params) {
    const id = this.nextAgent++
    this.push('out', { jsonrpc: '2.0', id, method, params })
    return id
  }
  stderr(line) {
    this.push('err', line)
  }
  eof() {
    this.frames.push({ t: this.frames.length * 5, dir: 'eof' })
  }
  /** A file the CLI wrote at this point (Gemini's plan file), as the recorder records it for the replay. */
  file(path, content) {
    this.frames.push({ t: this.frames.length * 5, dir: 'file', path, content })
  }
  exit(code = 0) {
    this.frames.push({ t: this.frames.length * 5, dir: 'exit', code, signal: null })
  }
}

// ---- Gemini shapes ----------------------------------------------------------------------------------------------

const AUTH_METHODS = [
  { id: 'oauth-personal', name: 'Log in with Google', description: null },
  {
    id: 'gemini-api-key',
    name: 'Use Gemini API key',
    description: 'Requires setting the `GEMINI_API_KEY` environment variable',
  },
  { id: 'vertex-ai', name: 'Vertex AI', description: null },
]

function initResult(o = {}, version = CLI_VERSION) {
  return {
    protocolVersion: 1,
    authMethods: AUTH_METHODS,
    agentCapabilities: {
      loadSession: o.loadSession ?? true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      ...(o.resume === true ? { sessionCapabilities: { resume: {} } } : {}),
    },
    agentInfo: { name: 'gemini-cli', title: 'Gemini CLI', version },
  }
}

function modes(current = 'default') {
  return {
    currentModeId: current,
    availableModes: [
      { id: 'default', name: 'Default', description: 'Prompts for approval' },
      { id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
      { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
      { id: 'plan', name: 'Plan', description: 'Read-only mode' },
    ],
  }
}

/** Gemini CLI 0.62's `models` (the earlier unstable SessionModelState; not in schema v1.25.0). */
function models(current) {
  return {
    availableModels: [
      {
        modelId: 'auto-gemini-3',
        name: 'Auto (Gemini 3)',
        description: 'Let Gemini CLI pick gemini-3-pro-preview or gemini-3-flash-preview for each task',
      },
      { modelId: 'gemini-3-pro-preview', name: 'gemini-3-pro-preview', description: null },
      { modelId: 'gemini-3-flash-preview', name: 'gemini-3-flash-preview', description: null },
      { modelId: 'gemini-2.5-pro', name: 'gemini-2.5-pro', description: null },
      { modelId: 'gemini-2.5-flash', name: 'gemini-2.5-flash', description: null },
    ],
    currentModelId: current ?? 'auto-gemini-3',
  }
}

const COMMANDS = [
  { name: 'memory', description: 'Commands for interacting with memory.', input: null },
  { name: 'init', description: 'Analyzes the project and creates a tailored GEMINI.md file.', input: null },
  { name: 'compress', description: 'Compresses the context by replacing it with a summary.', input: null },
]

/** Permission options as Gemini's toPermissionOptions builds them: the always-options first, then Allow and Reject. */
const OPT = {
  always: { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
  alwaysSave: { optionId: 'proceed_always_and_save', name: 'Allow for all future sessions', kind: 'allow_always' },
  alwaysServer: (server) => ({
    optionId: 'proceed_always_server',
    name: `Always allow all tools from server "${server}"`,
    kind: 'allow_always',
  }),
  alwaysTool: (tool) => ({ optionId: 'proceed_always_tool', name: `Always allow tool "${tool}"`, kind: 'allow_always' }),
  once: { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  reject: { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
}
const EXEC_OPTIONS = [OPT.always, OPT.once, OPT.reject]

/** One session's updates. */
class Session {
  constructor(r, id) {
    this.r = r
    this.id = id
  }
  say(...chunks) {
    for (const text of chunks)
      this.r.update(this.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }
  /** Gemini's echo of an approval-mode change (acpSession handleApprovalModeChanged): text, not current_mode_update. */
  modeEcho(mode) {
    this.r.update(this.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `[MODE_UPDATE] ${mode}` },
    })
  }
  think(text) {
    this.r.update(this.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
  }
  user(text) {
    this.r.update(this.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
  }
  commands() {
    this.r.update(this.id, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS })
  }
  plan(entries) {
    this.r.update(this.id, {
      sessionUpdate: 'plan',
      entries: entries.map(([content, status]) => ({ content, priority: 'medium', status })),
    })
  }
  usage(used, size = 1048576) {
    this.r.update(this.id, { sessionUpdate: 'usage_update', used, size })
  }
  /** A `tool_call` update; returns its id. */
  tool(o) {
    const toolCallId = o.id ?? this.r.callId(o.tool)
    this.r.update(this.id, {
      sessionUpdate: 'tool_call',
      toolCallId,
      status: o.status ?? 'in_progress',
      title: o.title,
      content: o.content ?? [],
      locations: o.locations ?? [],
      kind: o.kind,
    })
    return toolCallId
  }
  toolUpdate(toolCallId, status, content) {
    this.r.update(this.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status,
      ...(content !== undefined ? { content } : {}),
    })
  }
  /** A tool that runs without a question: tool_call in_progress, then completed. */
  run(o) {
    const id = this.tool(o)
    this.toolUpdate(id, 'completed', o.output !== undefined ? [textContent(o.output)] : undefined)
    return id
  }
  /** The pending tool_call Gemini sends first, then session/request_permission for it; returns {toolCallId, ask}. */
  ask(o, options) {
    const toolCallId = this.tool({ ...o, status: 'pending' })
    const ask = this.r.agentRequest('session/request_permission', {
      sessionId: this.id,
      options,
      toolCall: {
        toolCallId,
        status: 'pending',
        title: o.title,
        content: o.content ?? [],
        locations: o.locations ?? [],
        kind: o.kind,
      },
    })
    return { toolCallId, ask }
  }
}

/**
 * Gemini's shell confirmation (core tools/shell.ts, acpSession runTool): the title is the command (getDisplayTitle),
 * the one text block its explanation (`[current working directory <the CLI's folder>] (<description>)`), no rawInput.
 */
const SHELL = (command, description) => ({
  tool: 'run_shell_command',
  title: command,
  kind: 'execute',
  content: [textContent(`[current working directory ${CWD}] (${description})`)],
})
const READ = (rel) => ({ tool: 'read_file', title: rel, kind: 'read', locations: [loc(rel)] })
const EDIT = (rel, oldText, newText) => ({
  tool: 'replace',
  title: `${rel}: ${oldText.split('\n')[0]} => ${newText.split('\n')[0]}`,
  kind: 'edit',
  content: [diff(rel, oldText, newText)],
  locations: [loc(rel)],
})

/**
 * The opening of a process: initialize → session/new (or session/load / session/resume) → set_mode. Returns the
 * session (undefined when the setup was refused). `o.mode` = the ACP mode id (omitted: no set_mode, the probe).
 */
function open(r, o) {
  const init = r.request('initialize', initializeParams())
  r.result(init, initResult(o.facts, o.version))
  let id
  if (o.resume === undefined) {
    const req = r.request('session/new', newSessionParams(CWD))
    if (o.newError !== undefined) {
      r.error(req, o.newError)
      return undefined
    }
    id = o.sid
    r.result(req, { sessionId: id, modes: modes(), models: models(o.model) })
  } else if (o.resumeVia === 'resume') {
    const req = r.request('session/resume', resumeSessionParams(o.resume, CWD))
    id = o.resume
    r.result(req, { modes: modes() })
  } else {
    const req = r.request('session/load', loadSessionParams(o.resume, CWD))
    if (o.loadError !== undefined) {
      r.error(req, o.loadError)
      return undefined
    }
    id = o.resume
    r.result(req, { modes: modes(), models: models(o.model) })
    // Gemini streams the stored history after its answer (streamHistory, not awaited): the adapter drops it.
    o.replay?.(new Session(r, id))
  }
  const s = new Session(r, id)
  if (o.commands === true) s.commands()
  if (o.mode !== undefined) {
    const req = r.request('session/set_mode', setModeParams(id, o.mode))
    // A new or loaded session starts in `default`: a change is echoed as text before set_mode answers (Gemini's
    // ApprovalModeChanged handler sends it while setMode runs); setting `default` again echoes nothing.
    if (o.mode !== 'default') s.modeEcho(o.mode)
    r.result(req, {})
  }
  return s
}

const prompt = (r, s, text) => r.request('session/prompt', promptParams(s.id, text))
const end = (r, code = 0) => {
  r.eof()
  r.exit(code)
}
/**
 * One pass's token counts: `input` is the prompts' promptTokenCount (the cached tokens included), `output` their
 * candidates, `thoughts` apart from both.
 */
const tokens = (input, cached, output, thoughts) => ({ input, cached, output, thoughts })

/**
 * A PromptResponse.usage as Gemini 0.64 sends it (buildPromptResponse): inputTokens includes the cached reads,
 * totalTokens = inputTokens + outputTokens (thoughts and cache not added), zero cached or thought tokens left out.
 */
const acpUsage = (u) => ({
  totalTokens: u.input + u.output,
  inputTokens: u.input,
  outputTokens: u.output,
  ...(u.thoughts > 0 ? { thoughtTokens: u.thoughts } : {}),
  ...(u.cached > 0 ? { cachedReadTokens: u.cached } : {}),
})

/** The `_meta` Gemini puts on every prompt answer with token totals (0.62 onwards): no cached or thought split. */
const quotaMeta = (u, model = 'gemini-3-pro-preview') => {
  const count = { input_tokens: u.input, output_tokens: u.output }
  return { quota: { token_count: count, model_usage: [{ model, token_count: { ...count } }] } }
}

/** A session/prompt answer as the scenario's Gemini version sends it (0.62: `_meta` only; 0.64: `usage` too). */
const promptAnswer = (stopReason, u, version = CLI_VERSION) =>
  version === USAGE_VERSION
    ? { stopReason, usage: acpUsage(u), _meta: quotaMeta(u) }
    : { stopReason, _meta: quotaMeta(u) }

/** The usage the adapter reports for a 0.62 answer: its _meta totals, input with the cached tokens (approximate). */
const metaUsageOf = (u) => ({ input: u.input, output: u.output })

// ---- expected entries (events + the signals that matter; liveness never) -----------------------------------------

const ev = {
  session: (id) => ({ type: 'session', id }),
  text: (delta) => ({ type: 'text', delta }),
  toolStart: (id) => ({ type: 'tool', id, phase: 'start' }),
  toolEnd: (id, status = 'ok') => ({ type: 'tool', id, phase: 'end', status }),
  ask: (kind, allowSession = true) => ({ type: 'ask', kind, allowSession }),
  done: (result, usage) => (usage === undefined ? { type: 'done', result } : { type: 'done', result, usage }),
  error: (category) => ({ type: 'error', fatal: true, category }),
  auto: (decision, why) => ({ type: 'auto-answered', decision, why }),
  allowRule: (kind) => ({ type: 'allow-rule', rule: { vendor: 'gemini', kind } }),
  plan: (markdown) => ({ type: 'plan-captured', markdown, source: 'acp-exit-plan' }),
  meta: (key) => ({ type: 'meta', key }),
  /** A done with the approximate usage of Gemini 0.62's `_meta` totals (its usageApprox signal first). */
  doneMeta: (result, u) => [
    { type: 'meta', key: 'usageApprox', value: { reason: 'no-cached-split' } },
    { type: 'done', result, usage: metaUsageOf(u) },
  ],
}

/** The text events of agent messages, as the adapter prints them: '\n\n' before a message that follows a tool. */
function texts(...messages) {
  const out = []
  messages.forEach((chunks, i) => {
    if (i > 0) out.push(ev.text('\n\n'))
    for (const c of chunks) out.push(ev.text(c))
  })
  return out
}

// ---- scenarios ----------------------------------------------------------------------------------------------------

const PROMPTS = {
  review: 'Review the change in src/cli.ts against the plan. List findings as [must]/[should]/[nit].',
  implement: 'Add a --version flag to the CLI that prints the package version.',
  fix: 'Fix the findings below.\n[must] cli.ts: --version prints undefined when package.json has no version.',
  plan: 'Plan how to add a --version flag to the CLI. Do not change files.',
}
const PLAN_MD =
  '## Plan\n1. Read the version from package.json in src/cli.ts.\n2. Print it for --version and exit 0.\n' +
  '3. Add a test in test/cli.test.ts.'
const PLAN_FILE = `<GEMINI_CLI_HOME>/.gemini/tmp/<PROJECT>/${sid(12)}/plans/version-flag.md`
/** Gemini's exit_plan_mode title (core tools/exit-plan-mode.ts getDescription; GEMINI_PLAN_EXIT_TITLE). */
const PLAN_EXIT_TITLE = `Requesting plan approval for: ${PLAN_FILE}`
const VERSION_EDIT = EDIT(
  'src/cli.ts',
  "const args = process.argv.slice(2)",
  "const args = process.argv.slice(2)\nif (args.includes('--version')) console.log(version)",
)

const PASS = (step, mode, prompt_, extra = {}) => ({
  kind: 'pass',
  step,
  mode,
  planNative: false,
  prompt: prompt_,
  trustFolder: true,
  ...extra,
})

const U = {
  G02: tokens(8192, 4096, 96, 64),
  G03: tokens(16384, 8192, 512, 192),
  G04: tokens(20480, 12288, 640, 256),
  G04b: tokens(12288, 8192, 220, 96),
  G05a: tokens(18432, 12288, 612, 240),
  G05c: tokens(18432, 12288, 612, 240),
  G06a: tokens(14336, 10240, 330, 96),
  G06b: tokens(11264, 6144, 210, 64),
  G06c: tokens(9216, 4096, 180, 48),
  G07: tokens(15360, 10240, 420, 160),
  G09a: tokens(24576, 20480, 380, 128),
  G09b: tokens(10240, 6144, 300, 96),
  G10d: tokens(30720, 24576, 2048, 512),
  G11: tokens(180224, 98304, 1400, 320),
}
const usageOf = (u) => usageFromAcp(acpUsage(u))

/** @type {Array<{id:string, slug:string, version?:string, pass:object, note:string, argv?:string[], build:(r:Rec)=>void, expected:object[], recipe?:object}>} */
const SCENARIOS = [
  {
    id: 'G01',
    slug: 'handshake-session',
    pass: { kind: 'probe' },
    note:
      'The probe (vendor.gemini.protocol and .plan): initialize + session/new in a Dim Factory-owned folder with ' +
      '--skip-trust, no prompt, no token. The answer advertises loadSession (resume by session/load), the four ' +
      'modes with plan among them, and models (Gemini CLI 0.62 still sends them); available commands follow.',
    build(r) {
      open(r, { sid: sid(1), commands: true })
      end(r)
    },
    expected: [],
  },
  {
    id: 'G02',
    slug: 'review-message-chunks',
    pass: PASS('review', 'readonly', PROMPTS.review, { model: 'gemini-3-pro-preview' }),
    note:
      'A read-only Review with a picked model (-m): set_mode default, a thought (logged, never printed), the answer ' +
      'as agent_message_chunk text, then the prompt response (stopReason end_turn, unstable usage).',
    build(r) {
      const s = open(r, { sid: sid(2), mode: MODE_IDS.readonly, model: 'gemini-3-pro-preview', commands: true })
      const p = prompt(r, s, PROMPTS.review)
      s.think('Checking the change against the plan.')
      s.say('No blocking issues. ', '[nit] cli.ts: name the version constant.')
      r.result(p, promptAnswer('end_turn', U.G02))
      end(r)
    },
    expected: [
      ev.session(sid(2)),
      ...texts(['No blocking issues. ', '[nit] cli.ts: name the version constant.']),
      ...ev.doneMeta('No blocking issues. [nit] cli.ts: name the version constant.', U.G02),
    ],
  },
  {
    id: 'G03',
    slug: 'tool-call-dedup',
    pass: PASS('implement', 'autoedit', PROMPTS.implement),
    note:
      'Implement in autoEdit: tool_call / tool_call_update keyed by toolCallId. The edit is announced twice (pending, ' +
      'then in_progress) and updated in_progress before it completes: one tool start and one end. A plan update is ' +
      'logged only (not mapped to an event).',
    build(r) {
      const s = open(r, { sid: sid(3), mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.implement)
      s.plan([
        ['Read the CLI entry', 'in_progress'],
        ['Add the flag', 'pending'],
      ])
      const read = s.run(READ('src/cli.ts'))
      s.say('Adding the flag.')
      const edit = s.tool({ ...VERSION_EDIT, status: 'pending' })
      s.tool({ ...VERSION_EDIT, id: edit, status: 'in_progress' })
      s.toolUpdate(edit, 'in_progress')
      s.toolUpdate(edit, 'completed')
      s.say('Added `--version` ', 'to src/cli.ts.')
      r.result(p, promptAnswer('end_turn', U.G03))
      end(r)
      this.ids = { read, edit }
    },
    expected: () => {
      const ids = idsOf('G03')
      return [
        ev.session(sid(3)),
        ev.toolStart(ids.read),
        ev.toolEnd(ids.read),
        ...texts(['Adding the flag.']),
        ev.toolStart(ids.edit),
        ev.toolEnd(ids.edit),
        ev.text('\n\n'),
        ev.text('Added `--version` '),
        ev.text('to src/cli.ts.'),
        ...ev.doneMeta('Added `--version` to src/cli.ts.', U.G03),
      ]
    },
  },
  {
    id: 'G04',
    slug: 'permission-allow-once',
    pass: PASS('implement', 'autoedit', PROMPTS.implement, { answers: [{ decision: 'allow' }] }),
    note:
      'Implement in autoEdit: the edit runs without a question; the shell command asks (a pending tool_call, then ' +
      'session/request_permission for the same toolCallId: one tool card and one ask). Allow → proceed_once ' +
      '(allow_once). The session G09a resumes.',
    build(r) {
      const s = open(r, { sid: sid(4), mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.implement)
      const edit = s.run(VERSION_EDIT)
      const { toolCallId: shell, ask } = s.ask(SHELL('npm test', 'Run the test suite'), EXEC_OPTIONS)
      r.reply(ask, permissionReply('allow', EXEC_OPTIONS, GEMINI_PREFS))
      s.toolUpdate(shell, 'in_progress')
      s.toolUpdate(shell, 'completed', [textContent('# pass 2\n# fail 0\n')])
      s.say('Added `--version`; tests pass.')
      r.result(p, promptAnswer('end_turn', U.G04))
      end(r)
      this.ids = { edit, shell }
    },
    expected: () => {
      const ids = idsOf('G04')
      return [
        ev.session(sid(4)),
        ev.toolStart(ids.edit),
        ev.toolEnd(ids.edit),
        ev.toolStart(ids.shell),
        ev.ask('shell', true),
        ev.toolEnd(ids.shell),
        ...texts(['Added `--version`; tests pass.']),
        ...ev.doneMeta('Added `--version`; tests pass.', U.G04),
      ]
    },
  },
  {
    id: 'G04b',
    slug: 'permission-deny',
    pass: PASS('implement', 'autoedit', PROMPTS.implement, { answers: [{ decision: 'deny' }] }),
    note:
      'Deny → reject_once (Gemini optionId cancel): the tool ends declined and the turn goes on; never ' +
      'reject_always, which could persist.',
    build(r) {
      const s = open(r, { sid: sid(5), mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.implement)
      const { toolCallId: shell, ask } = s.ask(SHELL('npm publish --dry-run', 'Check the package contents'), EXEC_OPTIONS)
      r.reply(ask, permissionReply('deny', EXEC_OPTIONS, GEMINI_PREFS))
      s.toolUpdate(shell, 'failed')
      s.say('Skipped the dry run as asked.')
      r.result(p, promptAnswer('end_turn', U.G04b))
      end(r)
      this.ids = { shell }
    },
    expected: () => {
      const ids = idsOf('G04b')
      return [
        ev.session(sid(5)),
        ev.toolStart(ids.shell),
        ev.ask('shell', true),
        ev.toolEnd(ids.shell, 'declined'),
        ...texts(['Skipped the dry run as asked.']),
        ...ev.doneMeta('Skipped the dry run as asked.', U.G04b),
      ]
    },
  },
  {
    id: 'G05a',
    slug: 'usage-cached-tokens',
    version: USAGE_VERSION,
    pass: PASS('review', 'readonly', PROMPTS.review),
    note:
      'G05 decides cached-token subtraction (synthesized, pending live confirmation), on Gemini 0.64 (the first to ' +
      'answer session/prompt with usage): inputTokens is the prompts\' promptTokenCount, which counts the cached reads ' +
      'too, so input = inputTokens - cachedReadTokens; thoughtTokens are reasoning; totalTokens is inputTokens + ' +
      'outputTokens (it cannot tell). A usage_update follows each model call (used = that call\'s input + output); ' +
      'neither it nor _meta.quota is added on top.',
    build(r) {
      const s = open(r, { sid: sid(6), mode: MODE_IDS.readonly, version: USAGE_VERSION })
      const p = prompt(r, s, PROMPTS.review)
      const read = s.run(READ('src/cli.ts'))
      s.usage(9000 + 216)
      s.say('The change matches the plan. ', 'No findings.')
      s.usage(9432 + 396)
      r.result(p, promptAnswer('end_turn', U.G05a, USAGE_VERSION))
      end(r)
      this.ids = { read }
    },
    expected: () => {
      const ids = idsOf('G05a')
      return [
        ev.session(sid(6)),
        ev.toolStart(ids.read),
        ev.toolEnd(ids.read),
        ...texts(['The change matches the plan. ', 'No findings.']),
        ev.done('The change matches the plan. No findings.', usageOf(U.G05a)),
      ]
    },
  },
  {
    id: 'G05b',
    slug: 'usage-update-fallback',
    pass: PASS('review', 'readonly', PROMPTS.review),
    note:
      'A prompt response without usage or _meta totals: usage_update is the fallback usage source. The last ' +
      'usage_update (tokens in context) stands in for the input, output 0, flagged usageApprox (protocol.ts ' +
      'usageFromContext). Not a Gemini shape (0.62 and 0.63 send _meta.quota, 0.64 sends usage): the ACP base\'s ' +
      'generic path, kept synthesized.',
    build(r) {
      const s = open(r, { sid: sid(7), mode: MODE_IDS.readonly })
      const p = prompt(r, s, PROMPTS.review)
      s.say('No findings.')
      s.usage(7168)
      r.result(p, { stopReason: 'end_turn' })
      end(r)
    },
    expected: [
      ev.session(sid(7)),
      ...texts(['No findings.']),
      ev.meta('usageApprox'),
      ev.done('No findings.', usageFromContext({ used: 7168 })),
    ],
  },
  {
    id: 'G05c',
    slug: 'usage-meta-quota',
    pass: PASS('review', 'readonly', PROMPTS.review),
    note:
      'Gemini 0.62 and 0.63 (0.62 is the recommended version) answer session/prompt with no usage and no ' +
      'usage_update: only _meta.quota.token_count {input_tokens, output_tokens} (promptTokenCount with the cached ' +
      'tokens in it, candidatesTokenCount without thoughts). The adapter reports them as the pass usage, flagged ' +
      'usageApprox (no cached split).',
    build(r) {
      const s = open(r, { sid: sid(21), mode: MODE_IDS.readonly })
      const p = prompt(r, s, PROMPTS.review)
      const read = s.run(READ('src/cli.ts'))
      s.say('The change matches the plan. ', 'No findings.')
      r.result(p, promptAnswer('end_turn', U.G05c))
      end(r)
      this.ids = { read }
    },
    expected: () => {
      const ids = idsOf('G05c')
      return [
        ev.session(sid(21)),
        ev.toolStart(ids.read),
        ev.toolEnd(ids.read),
        ...texts(['The change matches the plan. ', 'No findings.']),
        ...ev.doneMeta('The change matches the plan. No findings.', U.G05c),
      ]
    },
  },
  {
    id: 'G06a',
    slug: 'allow-session-option-prefs',
    pass: PASS('implement', 'autoedit', PROMPTS.implement, { answers: [{ decision: 'allow-session' }] }),
    note:
      'Allow for this run → the first allow_always of optionPrefs.allowSession that is not forbidden and does not ' +
      'say it persists: proceed_always (never proceed_always_and_save, "Allow for all future sessions"). Gemini then ' +
      'runs the same command again without asking; the adapter records the exact rule.',
    build(r) {
      const s = open(r, { sid: sid(8), mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.implement)
      const options = [OPT.always, OPT.alwaysSave, OPT.once, OPT.reject]
      const { toolCallId: first, ask } = s.ask(SHELL('npm test', 'Run the test suite'), options)
      r.reply(ask, permissionReply('allow-session', options, GEMINI_PREFS))
      s.toolUpdate(first, 'in_progress')
      s.toolUpdate(first, 'completed', [textContent('# pass 2\n')])
      const second = s.run({ ...SHELL('npm test', 'Run the test suite again'), output: '# pass 2\n' })
      s.say('Tests pass twice.')
      r.result(p, promptAnswer('end_turn', U.G06a))
      end(r)
      this.ids = { first, second }
    },
    expected: () => {
      const ids = idsOf('G06a')
      return [
        ev.session(sid(8)),
        ev.toolStart(ids.first),
        ev.ask('shell', true),
        ev.allowRule('shell'),
        ev.toolEnd(ids.first),
        ev.toolStart(ids.second),
        ev.toolEnd(ids.second),
        ...texts(['Tests pass twice.']),
        ...ev.doneMeta('Tests pass twice.', U.G06a),
      ]
    },
  },
  {
    id: 'G06b',
    slug: 'allow-session-forbidden-only',
    pass: PASS('implement', 'autoedit', PROMPTS.implement, { answers: [{ decision: 'allow' }] }),
    note:
      'Synthetic: the only always-option is the forbidden, persistent proceed_always_and_save, so the ask is raised ' +
      'with allowSession:false ("Allow for this run" hidden, E05); Allow → proceed_once.',
    build(r) {
      const s = open(r, { sid: sid(9), mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.implement)
      const options = [OPT.alwaysSave, OPT.once, OPT.reject]
      const { toolCallId: shell, ask } = s.ask(SHELL('npm test', 'Run the test suite'), options)
      r.reply(ask, permissionReply('allow', options, GEMINI_PREFS))
      s.toolUpdate(shell, 'completed', [textContent('# pass 2\n')])
      s.say('Tests pass.')
      r.result(p, promptAnswer('end_turn', U.G06b))
      end(r)
      this.ids = { shell }
    },
    expected: () => {
      const ids = idsOf('G06b')
      return [
        ev.session(sid(9)),
        ev.toolStart(ids.shell),
        ev.ask('shell', false),
        ev.toolEnd(ids.shell),
        ...texts(['Tests pass.']),
        ...ev.doneMeta('Tests pass.', U.G06b),
      ]
    },
  },
  {
    id: 'G06c',
    slug: 'allow-session-mcp-tool',
    pass: PASS('implement', 'autoedit', PROMPTS.implement, { answers: [{ decision: 'allow-session' }] }),
    note:
      'An MCP tool from the user\'s own Gemini settings (Dim Factory sends mcpServers: [] but the CLI still loads its ' +
      'configured servers): two session-scoped always-options; allow-session picks proceed_always_tool (first in ' +
      'optionPrefs). The server and tool names are redacted as a live recording\'s would be.',
    build(r) {
      const s = open(r, { sid: sid(10), mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.implement)
      const options = [OPT.alwaysServer('docs'), OPT.alwaysTool('search'), OPT.once, OPT.reject]
      const mcp = { tool: 'search', title: 'search (docs MCP Server)', kind: 'other', content: [] }
      const { toolCallId: call, ask } = s.ask(mcp, options)
      r.reply(ask, permissionReply('allow-session', options, GEMINI_PREFS))
      s.toolUpdate(call, 'completed', [textContent('3 results')])
      s.say('The docs agree: print the package version.')
      r.result(p, promptAnswer('end_turn', U.G06c))
      end(r)
      this.ids = { call }
    },
    expected: () => {
      const ids = idsOf('G06c')
      return [
        ev.session(sid(10)),
        ev.toolStart(ids.call),
        ev.ask('other', true),
        ev.allowRule('other'),
        ev.toolEnd(ids.call),
        ...texts(['The docs agree: print the package version.']),
        ...ev.doneMeta('The docs agree: print the package version.', U.G06c),
      ]
    },
  },
  {
    id: 'G07',
    slug: 'review-readonly-rejects',
    pass: PASS('review', 'readonly', PROMPTS.review),
    note:
      'Read-only Review (mode default): reads run without a question; a shell command and an edit each ask, and the ' +
      'adapter rejects every one (reject_once, auto-answered readonly): zero asks reach the user. The turn goes on.',
    build(r) {
      const s = open(r, { sid: sid(11), mode: MODE_IDS.readonly })
      const p = prompt(r, s, PROMPTS.review)
      const read = s.run(READ('src/cli.ts'))
      const shell = s.ask(SHELL('npm test', 'Run the test suite'), EXEC_OPTIONS)
      r.reply(shell.ask, permissionReply('deny', EXEC_OPTIONS, GEMINI_PREFS))
      s.toolUpdate(shell.toolCallId, 'failed')
      const edit = s.ask(VERSION_EDIT, EXEC_OPTIONS)
      r.reply(edit.ask, permissionReply('deny', EXEC_OPTIONS, GEMINI_PREFS))
      s.toolUpdate(edit.toolCallId, 'failed')
      s.say('[should] cli.ts: --version prints undefined when package.json has no version.')
      r.result(p, promptAnswer('end_turn', U.G07))
      end(r)
      this.ids = { read, shell: shell.toolCallId, edit: edit.toolCallId }
    },
    expected: () => {
      const ids = idsOf('G07')
      return [
        ev.session(sid(11)),
        ev.toolStart(ids.read),
        ev.toolEnd(ids.read),
        ev.toolStart(ids.shell),
        ev.auto('deny', 'readonly'),
        ev.toolEnd(ids.shell, 'declined'),
        ev.toolStart(ids.edit),
        ev.auto('deny', 'readonly'),
        ev.toolEnd(ids.edit, 'declined'),
        ...texts(['[should] cli.ts: --version prints undefined when package.json has no version.']),
        ...ev.doneMeta('[should] cli.ts: --version prints undefined when package.json has no version.', U.G07),
      ]
    },
  },
  {
    id: 'G08',
    slug: 'plan-exit-captured',
    pass: { kind: 'pass', step: 'plan', mode: 'readonly', planNative: true, prompt: PROMPTS.plan, trustFolder: true },
    note:
      'Native Plan (set_mode plan, echoed as [MODE_UPDATE] plan): reads and the plan file under .gemini/tmp run ' +
      'without a question; exit_plan_mode asks as Gemini sends it (kind other, titled "Requesting plan approval for: ' +
      '<plan file>", no content, no always-option). The adapter reads the plan from that file (only under Gemini\'s ' +
      'own tmp folder), rejects (never approves: an approved exit could switch modes) and sends session/cancel; the ' +
      'prompt ends cancelled (no usage: a cancelled prompt carries none) and the pass succeeds with the plan.',
    build(r) {
      const s = open(r, { sid: sid(12), mode: PLAN_MODE_ID })
      const p = prompt(r, s, PROMPTS.plan)
      const read = s.run(READ('src/cli.ts'))
      s.say('I have what I need; writing the plan.')
      const write = s.run({
        tool: 'write_file',
        title: 'Writing to plans/version-flag.md',
        kind: 'edit',
        locations: [{ path: PLAN_FILE }],
      })
      // The file the write left: the recorder records it before the request that names it (README "file frames").
      r.file(PLAN_FILE, PLAN_MD)
      const options = [OPT.once, OPT.reject]
      const exit = s.ask({ tool: 'exit_plan_mode', title: PLAN_EXIT_TITLE, kind: 'other' }, options)
      r.reply(exit.ask, permissionReply('deny', options, GEMINI_PREFS))
      r.notify('session/cancel', cancelParams(s.id))
      s.toolUpdate(exit.toolCallId, 'failed')
      r.result(p, { stopReason: 'cancelled' })
      end(r)
      this.ids = { read, write, exit: exit.toolCallId }
    },
    expected: () => {
      const ids = idsOf('G08')
      return [
        ev.session(sid(12)),
        ev.toolStart(ids.read),
        ev.toolEnd(ids.read),
        ...texts(['I have what I need; writing the plan.']),
        ev.toolStart(ids.write),
        ev.toolEnd(ids.write),
        ev.toolStart(ids.exit),
        ev.plan(PLAN_MD),
        ev.auto('deny', 'plan-capture'),
        ev.toolEnd(ids.exit, 'declined'),
        ev.done(PLAN_MD),
      ]
    },
  },
  {
    id: 'G09a',
    slug: 'resume-load-quiet',
    pass: PASS('fix', 'autoedit', PROMPTS.fix, {
      resume: { sessionId: sid(4), priorUsage: metaUsageOf(U.G04) },
    }),
    note:
      'Fix resumes G04\'s session by session/load (loadSession advertised, session/resume not). Gemini streams the ' +
      'history after its answer (user, thought, the old tool calls completed, the old answer): the adapter drops ' +
      'every update until 400 ms of quiet, then re-sends set_mode and prompts. The pass\'s usage is its own prompt ' +
      'response as is (one prompt per process; pending live confirmation).',
    build(r) {
      const s = open(r, {
        resume: sid(4),
        mode: MODE_IDS.autoedit,
        replay: (h) => {
          const g04 = idsOf('G04')
          h.user(PROMPTS.implement)
          h.think('Adding the flag and running the tests.')
          h.tool({ ...VERSION_EDIT, id: g04.edit, status: 'completed' })
          h.tool({ ...SHELL('npm test', 'Run the test suite'), id: g04.shell, status: 'completed' })
          h.say('Added `--version`; tests pass.')
        },
      })
      const p = prompt(r, s, PROMPTS.fix)
      const edit = s.run(
        EDIT('src/cli.ts', 'console.log(version)', "console.log(version ?? '0.0.0')"),
      )
      s.say('Fixed: --version prints 0.0.0 when package.json has no version.')
      r.result(p, promptAnswer('end_turn', U.G09a))
      end(r)
      this.ids = { edit }
    },
    expected: () => {
      const ids = idsOf('G09a')
      return [
        ev.session(sid(4)),
        ev.toolStart(ids.edit),
        ev.toolEnd(ids.edit),
        ...texts(['Fixed: --version prints 0.0.0 when package.json has no version.']),
        ...ev.doneMeta('Fixed: --version prints 0.0.0 when package.json has no version.', U.G09a),
      ]
    },
    recipe: { sleepAfter: { 'session/load': 1500 }, sandboxOf: 'G04' },
  },
  {
    id: 'G09b',
    slug: 'resume-advertised',
    pass: PASS('fix', 'autoedit', PROMPTS.fix, { resume: { sessionId: sid(13) } }),
    note:
      'An agent that advertises sessionCapabilities.resume is resumed with session/resume (no history replay), then ' +
      'set_mode. Gemini CLI 0.62 does not advertise it (its dispatcher has no resumeSession): this is the generic ' +
      'ACP base path.',
    build(r) {
      const s = open(r, { facts: { resume: true }, resume: sid(13), resumeVia: 'resume', mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.fix)
      const edit = s.run(EDIT('src/cli.ts', 'console.log(version)', "console.log(version ?? '0.0.0')"))
      s.say('Fixed.')
      r.result(p, promptAnswer('end_turn', U.G09b))
      end(r)
      this.ids = { edit }
    },
    expected: () => {
      const ids = idsOf('G09b')
      return [
        ev.session(sid(13)),
        ev.toolStart(ids.edit),
        ev.toolEnd(ids.edit),
        ...texts(['Fixed.']),
        ...ev.doneMeta('Fixed.', U.G09b),
      ]
    },
  },
  {
    id: 'G09c',
    slug: 'resume-unknown-session',
    pass: PASS('fix', 'autoedit', PROMPTS.fix, { resume: { sessionId: sid(14) } }),
    note:
      'session/load of a session Gemini does not have: the handler throws, so the SDK answers -32603 "Internal error" ' +
      'with the words in data.details ("Invalid session identifier"); resume_failed (retry fresh). The adapter must ' +
      'read data.details (protocol.ts acpErrorText).',
    build(r) {
      open(r, {
        resume: sid(14),
        loadError: {
          code: -32603,
          message: 'Internal error',
          data: {
            details: `Invalid session identifier "${sid(14)}". Use --list-sessions to see available sessions.`,
          },
        },
      })
      end(r)
    },
    expected: [ev.error('resume_failed')],
  },
  {
    id: 'G10a',
    slug: 'cancel-pending-permission',
    pass: PASS('implement', 'autoedit', PROMPTS.implement, { stop: { after: { type: 'ask' }, reason: 'user' } }),
    note:
      'User Stop with an ask pending (the first kill step): session/cancel, then every pending permission answered ' +
      '{outcome: cancelled}; the tool ends, the prompt ends cancelled → user_cancelled.',
    build(r) {
      const s = open(r, { sid: sid(15), mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.implement)
      const { toolCallId: shell, ask } = s.ask(SHELL('npm run build', 'Build the package'), EXEC_OPTIONS)
      r.notify('session/cancel', cancelParams(s.id))
      r.reply(ask, CANCELLED_OUTCOME)
      s.toolUpdate(shell, 'failed')
      r.result(p, { stopReason: 'cancelled' })
      end(r)
      this.ids = { shell }
    },
    expected: () => {
      const ids = idsOf('G10a')
      return [
        ev.session(sid(15)),
        ev.toolStart(ids.shell),
        ev.ask('shell', true),
        ev.toolEnd(ids.shell, 'declined'),
        ev.error('user_cancelled'),
      ]
    },
  },
  {
    id: 'G10b',
    slug: 'auth-required',
    pass: PASS('implement', 'autoedit', PROMPTS.implement),
    note:
      'Not signed in: session/new answers -32000 "Authentication required" (RequestError.authRequired). Dim Factory ' +
      'never calls authenticate: auth_required, with the login command to copy.',
    build(r) {
      open(r, { newError: { code: -32000, message: 'Authentication required' } })
      end(r)
    },
    expected: [ev.error('auth_required')],
  },
  {
    id: 'G10c',
    slug: 'prompt-error-quota',
    pass: PASS('review', 'readonly', PROMPTS.review),
    note:
      'The model call fails after Gemini\'s own retries: session/prompt answers -32603 "Internal error" with the API ' +
      'error in data.details (a daily quota, RESOURCE_EXHAUSTED) → quota_exceeded.',
    build(r) {
      const s = open(r, { sid: sid(16), mode: MODE_IDS.readonly })
      const p = prompt(r, s, PROMPTS.review)
      r.error(p, {
        code: -32603,
        message: 'Internal error',
        data: {
          details:
            "You have exhausted your daily quota on this model. Quota exceeded for quota metric 'Gemini 3 Pro " +
            "Requests' and limit 'Gemini 3 Pro Requests per day per user'. (RESOURCE_EXHAUSTED)",
        },
      })
      end(r)
    },
    expected: [ev.session(sid(16)), ev.error('quota_exceeded')],
  },
  {
    id: 'G10d',
    slug: 'max-turn-requests',
    pass: PASS('implement', 'autoedit', PROMPTS.implement),
    note: 'The prompt ends with stopReason max_turn_requests (the session turn limit) → turn_limit.',
    build(r) {
      const s = open(r, { sid: sid(17), mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.implement)
      s.say('Still working on the flag.')
      r.result(p, promptAnswer('max_turn_requests', U.G10d))
      end(r)
    },
    expected: [ev.session(sid(17)), ...texts(['Still working on the flag.']), ev.error('turn_limit')],
  },
  {
    id: 'G10e',
    slug: 'refusal',
    pass: PASS('review', 'readonly', PROMPTS.review),
    note: 'The prompt ends with stopReason refusal → content_policy (no heal).',
    build(r) {
      const s = open(r, { sid: sid(18), mode: MODE_IDS.readonly })
      const p = prompt(r, s, PROMPTS.review)
      r.result(p, { stopReason: 'refusal' })
      end(r)
    },
    expected: [ev.session(sid(18)), ev.error('content_policy')],
  },
  {
    id: 'G11',
    slug: 'compaction-update',
    pass: PASS('implement', 'autoedit', PROMPTS.implement),
    note:
      'Context pressure and a compaction over ACP: usage_update {used, size} after each model call (the meter: ' +
      'used of size), then the unstable CompactionUpdate (schema.unstable.json: in_progress, then completed) with a ' +
      'summary chunk, and a smaller usage_update after it. Not seen from a live Gemini (which needs the client to ' +
      'advertise session capability compaction, which the ACP base does not): keep synthesized.',
    build(r) {
      const s = open(r, { sid: sid(22), mode: MODE_IDS.autoedit })
      const p = prompt(r, s, PROMPTS.implement)
      s.usage(840000)
      r.update(s.id, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' })
      r.update(s.id, {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'c1',
        content: { type: 'text', text: 'Summary of the work so far.' },
      })
      r.update(s.id, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' })
      s.usage(96000)
      s.say('Added the flag.')
      r.result(p, promptAnswer('end_turn', U.G11))
      end(r)
    },
    expected: [
      ev.session(sid(22)),
      { type: 'context', used: 840000, window: 1048576, source: 'session' },
      { type: 'compaction', phase: 'start' },
      { type: 'compaction', phase: 'end' },
      { type: 'context', used: 96000, window: 1048576, source: 'session' },
      ...texts(['Added the flag.']),
      ...ev.doneMeta('Added the flag.', U.G11),
    ],
  },
  ...exitScenarios(),
]

/** Gemini's process exit codes (41 auth, 42 input, 44 sandbox, 52 config, 53 turn limit, 54 tool, 55 trust). */
function exitScenarios() {
  const startup = (id, slug, code, stderr, category, note, extra = {}) => ({
    id,
    slug,
    pass: PASS('implement', 'autoedit', PROMPTS.implement, extra.pass ?? {}),
    ...(extra.argv ? { argv: extra.argv } : {}),
    note,
    build(r) {
      r.request('initialize', initializeParams())
      for (const line of stderr) r.stderr(line)
      r.exit(code)
    },
    expected: [ev.error(category)],
    recipe: { keepStdin: true },
  })
  const midTurn = (id, slug, code, stderr, category, note, n) => ({
    id,
    slug,
    pass: PASS('implement', 'autoedit', PROMPTS.implement),
    note,
    build(r) {
      const s = open(r, { sid: sid(n), mode: MODE_IDS.autoedit })
      prompt(r, s, PROMPTS.implement)
      for (const line of stderr) r.stderr(line)
      r.exit(code)
    },
    expected: [ev.session(sid(n)), ev.error(category)],
    recipe: { keepStdin: true },
  })
  return [
    startup(
      'GX41',
      'exit-auth',
      41,
      [
        'Please set an Auth method in your <GEMINI_CLI_HOME>/.gemini/settings.json or specify one of the following ' +
          'environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA',
      ],
      'auth_required',
      'FatalAuthenticationError: the CLI exits 41 before ACP starts, plain text on stderr.',
    ),
    startup(
      'GX42',
      'exit-input',
      42,
      ['FatalInputError: --acp cannot be combined with a prompt on stdin.'],
      'flag_drift',
      'FatalInputError (exit 42) at startup: the launch flags no longer fit this CLI.',
    ),
    startup(
      'GX44',
      'exit-sandbox',
      44,
      [
        "Sandbox image 'us-docker.pkg.dev/gemini-code-dev/gemini-cli/sandbox:0.62.0' is missing or could not be " +
          'pulled. Please ensure Docker is running.',
      ],
      'sandbox_unavailable',
      'FatalSandboxError (exit 44): the user\'s settings turn the Gemini sandbox on and it cannot start.',
    ),
    startup(
      'GX52',
      'exit-config',
      52,
      [
        'Error in <GEMINI_CLI_HOME>/.gemini/settings.json: Unexpected token } in JSON at position 87',
        'Please fix the configuration file and try again.',
      ],
      'config_invalid',
      'FatalConfigError (exit 52): a settings file Gemini cannot read.',
    ),
    midTurn(
      'GX53',
      'exit-turn-limit',
      53,
      [
        'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in ' +
          'settings.json.',
      ],
      'turn_limit',
      'FatalTurnLimitedError (exit 53) during the turn.',
      19,
    ),
    midTurn(
      'GX54',
      'exit-tool-disk-full',
      54,
      ['Error executing tool write_file: NO_SPACE_LEFT: ENOSPC: no space left on device, write'],
      'disk_full',
      'FatalToolExecutionError (exit 54; only NO_SPACE_LEFT is fatal) during the turn.',
      20,
    ),
    startup(
      'GX55',
      'exit-untrusted-folder',
      55,
      [
        'Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`, set the ' +
          '`GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this directory in interactive mode.',
      ],
      'trust_required',
      'Launched without --skip-trust (the folder has no vendorFolder grant): folder trust is on by default and every ' +
        'Dim Factory child is headless, so the CLI exits 55 before ACP starts → trust_required (grant, then retry).',
      { pass: { trustFolder: false }, argv: ['gemini', '--acp'] },
    ),
  ]
}

/** The tool call ids a scenario's build recorded (its expected events name them). */
const BUILT = new Map()
function idsOf(id) {
  const ids = BUILT.get(id)
  if (ids === undefined) throw new Error(`${id} has not been built yet`)
  return ids
}

// ---- writing ------------------------------------------------------------------------------------------------------

function argvOf(s) {
  if (s.argv !== undefined) return s.argv
  const model = typeof s.pass.model === 'string' ? ['-m', s.pass.model] : []
  return ['gemini', '--acp', ...model, '--skip-trust']
}

function headerOf(s) {
  return {
    kind: 'header',
    schemaVersion: 1,
    vendor: 'gemini',
    route: ROUTE,
    scenario: `${s.id}-${s.slug}`,
    cliVersion: s.version ?? CLI_VERSION,
    protocol: 'jsonrpc',
    jsonrpc: '2.0',
    os: 'any',
    arch: 'any',
    synthesized: true,
    synthesizedFrom: SOURCES,
    note: `${s.note} Generator: tests/fixtures/gemini/recipes/synthesize.mjs. Re-record live: tests/fixtures/gemini/README.md.`,
    argv: argvOf(s),
    launch: 'node <entry>',
    envKeys: ['GEMINI_CLI_HOME'],
    envDrop: ['^GEMINI_', '^GOOGLE_'],
    pass: s.pass,
    hostVersion: '0.1.0',
  }
}

/** Builds every scenario once, in order (a later expectation may name an earlier scenario's tool calls). */
function built() {
  const out = []
  for (const s of SCENARIOS) {
    const r = new Rec()
    const holder = { ids: undefined }
    s.build.call(holder, r)
    if (holder.ids !== undefined) BUILT.set(s.id, holder.ids)
    out.push({ s, text: `${[headerOf(s), ...r.frames].map((x) => JSON.stringify(x)).join('\n')}\n` })
  }
  return out
}

/** A response (never a request) to the host's request `id`: a `$wait` pattern. */
const responseTo = (id) => ({ id, method: { $absent: true } })

/**
 * recipes/<ID>-<slug>/responders.mjs: every agent request answered as the ACP base answers it for this pass
 * (dim-factory-responder.mjs), so a live model may ask as often as it likes and still get Dim Factory's answers.
 */
const RESPONDERS_MJS = [
  "// Answers every agent request as Dim Factory's ACP base does for this pass (../dim-factory-responder.mjs, with",
  '// ./pass.json). Generated by ../synthesize.mjs; the recorder loads it with --responders.',
  "import { readFileSync } from 'node:fs'",
  "import { dimFactoryResponder } from '../dim-factory-responder.mjs'",
  '',
  "export default dimFactoryResponder(JSON.parse(readFileSync(new URL('./pass.json', import.meta.url), 'utf8')))",
  '',
].join('\n')

/**
 * The live re-record recipe's stdin: Dim Factory's own requests and notifications, paced by `$wait` on each answer, with
 * the session id captured from session/new (`--var sessionId=` for a resume) and the sandbox as `$cwd`. The replies to
 * the agent's requests, and the session/cancel a plan exit or a Stop at an ask sends with them, come from
 * responders.mjs: the stdin holds neither.
 */
function recipeStdin(s, text) {
  const frames = text
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => JSON.parse(l))
  const outs = frames.filter((f) => f.dir === 'out').map((f) => JSON.parse(f.line))
  const sessionIds = new Set([
    ...outs.flatMap((m) => (typeof m.result?.sessionId === 'string' ? [m.result.sessionId] : [])),
    ...(s.pass.resume ? [s.pass.resume.sessionId] : []),
  ])
  const vars = (value) => {
    let line = JSON.stringify(value)
    for (const id of sessionIds) line = line.split(JSON.stringify(id)).join('"$sessionId"')
    return line.split('"<CWD>"').join('"$cwd"').split('<CWD>').join('${cwd}')
  }
  const stdin = []
  let promptId
  for (const f of frames) {
    if (f.dir !== 'in') continue
    const msg = JSON.parse(f.line)
    if (typeof msg.method !== 'string') continue // a reply: the responder's
    if (msg.method === 'session/cancel') {
      // Only the responder sends it (a plan exit, a Stop at an ask): a scenario with another cancel needs a recipe of
      // its own.
      if (s.pass.planNative !== true && s.pass.stop === undefined)
        throw new Error(`${s.id}: session/cancel outside a plan exit or a Stop`)
      continue
    }
    stdin.push(vars(msg))
    if (!Object.hasOwn(msg, 'id')) continue
    if (msg.method === 'session/prompt') {
      promptId = msg.id
      continue
    }
    const answer = outs.find((m) => m.id === msg.id && typeof m.method !== 'string')
    // A request the CLI never answered (it exited first): the recipe stops there (--keep-stdin).
    if (answer === undefined) continue
    const capture =
      msg.method === 'session/new' && answer.result !== undefined
        ? { $capture: { sessionId: 'result.sessionId' } }
        : {}
    stdin.push(JSON.stringify({ $wait: responseTo(msg.id), $timeoutMs: 120000, ...capture }))
    const sleep = s.recipe?.sleepAfter?.[msg.method]
    if (sleep !== undefined) stdin.push(JSON.stringify({ $sleep: sleep }))
  }
  if (promptId !== undefined && outs.some((m) => m.id === promptId && typeof m.method !== 'string'))
    stdin.push(JSON.stringify({ $wait: responseTo(promptId), $timeoutMs: 900000 }))
  return stdin
}

/** expected.events.json: the normalized events and the signals the scenario is about, each partial (README). */
function expectedText(s) {
  const expected = typeof s.expected === 'function' ? s.expected() : s.expected
  return `${JSON.stringify(expected, null, 2)}\n`
}

/** Live re-record notes per scenario (README "Re-recording live"): what it needs beyond the common command. */
const LIVE_NOTES = {
  G01: '--cwd is an empty scratch folder (the probe runs in Dim Factory\'s own tmp/probe-cwd).',
  G04: 'Its session is the one G09a resumes: note the session id for G09a\'s --var.',
  G05a:
    'Needs Gemini 0.64 or later (0.62 and 0.63 send no usage). Confirms G05 when usage.inputTokens equals ' +
    '_meta.quota.token_count.input_tokens (promptTokenCount, which includes the cached content) with ' +
    'cachedReadTokens > 0; Gemini\'s totalTokens (input + output) cannot tell.',
  G05b: 'Not a Gemini shape (the ACP base\'s generic usage_update fallback): keep synthesized.',
  G05c: 'Gemini 0.62 or 0.63 (the recommended 0.62.0): the answer carries _meta.quota only.',
  G06b: 'Synthetic (a vendor offering only a persistent always-option): keep synthesized.',
  G06c: 'Needs an MCP server in the fixture profile\'s settings.json; its name is redacted.',
  G08:
    'The live check that a live Gemini native Plan is captured: the recording has the plan file as ' +
    'a file frame before the exit request, and the replay captures the plan from it.',
  G07: 'The live check that a read-only Review raises zero asks.',
  G09a:
    '--var sessionId=<G04\'s session id>, and --pass-file a scratch copy of pass.json whose resume.sessionId and ' +
    'resume.priorUsage are G04\'s live session id and done usage.',
  G09b: 'Gemini CLI 0.62 does not advertise session/resume: keep synthesized until an agent that does is recorded.',
  G09c: '--var sessionId=<a never-used UUID>.',
  G10b: 'Needs a fixture profile that is signed out.',
  G10c: 'Only when the account really hits its daily quota: keep synthesized until observed.',
  G10d: 'Needs maxSessionTurns set low in the fixture profile\'s settings.json.',
  G10e: 'Cannot be provoked on demand: keep synthesized until observed.',
  G11: 'Needs the ACP base to advertise the compaction session capability and a long enough session: keep synthesized.',
  GX41: 'An auth method in settings.json that cannot work (e.g. gemini-api-key without the key).',
  GX42: 'Cannot be provoked with Dim Factory\'s own flags: keep synthesized until observed.',
  GX44: 'Needs tools.sandbox on in the fixture profile without Docker running.',
  GX52: 'A broken settings.json in the fixture profile (restore it afterwards).',
  GX53: 'Needs maxSessionTurns 1 in the fixture profile; usually ends as G10d instead.',
  GX54: 'Only on a full disk: keep synthesized until observed.',
  GX55: 'A sandbox the profile does not trust, launched without --skip-trust.',
}

/** recipes/<ID>-<slug>/record.txt: the command that re-records this scenario live (placeholders in <>). */
function recordCommand(s) {
  const name = `${s.id}-${s.slug}`
  const r = `tests/fixtures/gemini/recipes/${name}`
  const resume = s.pass.resume !== undefined ? ' --var sessionId=<the session id>' : ''
  const keep = s.recipe?.keepStdin === true ? ' --keep-stdin' : ''
  // A resume that names the prior pass's usage needs the live values: a scratch copy of pass.json (LIVE_NOTES).
  const passFile = s.pass.resume?.priorUsage !== undefined ? '"<scratch pass.json>"' : `${r}/pass.json`
  const parts = [
    'node scripts/record-fixture.mjs --acp --vendor gemini --gemini-home "<fixture GEMINI_CLI_HOME>"',
    '--bin "<node>" --entry "<the gemini package entry .js>" --cwd "<sandbox>"',
    `--out tests/fixtures/gemini/${ROUTE}/${name} --id ${s.id} --slug ${s.slug} --cli-version <x.y.z> --timing off`,
    `--stdin ${r}/stdin.jsonl --pass-file ${passFile} --responders ${r}/responders.mjs`,
  ]
  const lines = [
    `# ${name}: ${s.note}`,
    ...(LIVE_NOTES[s.id] ? [`# ${LIVE_NOTES[s.id]}`] : []),
    s.recipe?.sandboxOf !== undefined
      ? `# <sandbox>: ${s.recipe.sandboxOf}'s sandbox again (Gemini sessions are project-scoped); never the everyday ~/.gemini.`
      : '# A fresh git-init copy of tests/fixtures/sandboxes/ts-small as <sandbox>; never the everyday ~/.gemini.',
    `${parts.join(' ')}${resume}${keep} --timeout 900000 -- ${argvOf(s).slice(1).join(' ')}`,
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Scenarios recorded live (`<ID>-<slug>`; README "Re-recording live"): the generator still writes their recipe, and
 * leaves their recording.jsonl and expected.events.json (the live ones) alone. None yet: the Gemini CLI was not
 * installed when the adapter was built, so every fixture is synthesized.
 */
export const LIVE = new Set([])

/** Every file the generator owns: absolute path → content. */
export function synthesize() {
  BUILT.clear()
  const files = new Map()
  for (const { s, text } of built()) {
    const name = `${s.id}-${s.slug}`
    const dir = join(FIXTURES, ROUTE, name)
    if (!LIVE.has(name)) {
      files.set(join(dir, 'recording.jsonl'), text)
      files.set(join(dir, 'expected.events.json'), expectedText(s))
    }
    files.set(join(RECIPES, name, 'stdin.jsonl'), `${recipeStdin(s, text).join('\n')}\n`)
    files.set(join(RECIPES, name, 'responders.mjs'), RESPONDERS_MJS)
    files.set(join(RECIPES, name, 'pass.json'), `${JSON.stringify(s.pass, null, 2)}\n`)
    files.set(join(RECIPES, name, 'record.txt'), recordCommand(s))
  }
  return files
}

/**
 * Files in the folders the generator owns (acp/<scenario>/, recipes/<scenario>/) that it does not write: a scenario
 * or recipe file since dropped. Absolute paths.
 */
export function strays(files = synthesize()) {
  const owned = new Set([...files.keys()].map((p) => resolve(p).toLowerCase()))
  const out = []
  for (const base of [join(FIXTURES, ROUTE), RECIPES]) {
    if (!existsSync(base)) continue
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      if (base !== RECIPES && LIVE.has(d.name)) continue // a live recording's folder is not the generator's
      for (const f of readdirSync(join(base, d.name))) {
        const p = join(base, d.name, f)
        if (!owned.has(resolve(p).toLowerCase())) out.push(p)
      }
    }
  }
  return out
}

/** Generated files whose committed content differs (LF-normalized) or that are missing, and stray files. */
export function outOfDate(files = synthesize()) {
  const stale = []
  for (const [path, content] of files) {
    if (!existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== content) stale.push(path)
  }
  return [...stale, ...strays(files)]
}

export { GEMINI_PREFS, SCENARIOS }

const argv1 = process.argv[1] ? resolve(process.argv[1]) : ''
if (process.platform === 'win32' ? argv1.toLowerCase() === SELF.toLowerCase() : argv1 === SELF) {
  const files = synthesize()
  if (process.argv.includes('--check')) {
    const stale = outOfDate(files)
    if (stale.length > 0) {
      process.stderr.write(`synthesize: out of date (run it without --check):\n${stale.map((d) => `  ${d}`).join('\n')}\n`)
      process.exitCode = 1
    }
  } else {
    for (const [path, content] of files) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    process.stdout.write(`synthesized ${SCENARIOS.length} Gemini fixtures (${files.size} files)\n`)
    // Never deleted here: a file the generator no longer writes is listed for the author to remove.
    const left = strays(files)
    if (left.length > 0) {
      process.stderr.write(`synthesize: files the generator no longer writes (remove them):\n${left.map((d) => `  ${d}`).join('\n')}\n`)
      process.exitCode = 1
    }
  }
}
