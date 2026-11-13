#!/usr/bin/env node
// Synthesizes the Grok ACP fixtures (the P1 scenarios GR01–GR05) from the pinned Agent Client Protocol schema
// (src/core/adapters/acp-base/protocol/v1.25.0/) and Grok Build's own public docs and source, read-only on 2026-10-11
// (tests/fixtures/grok/README.md "Sources").
//
//   node tests/fixtures/grok/recipes/synthesize.mjs [--check]
//
// The adapter was built without the Grok CLI (not installed on the dev machine), so every fixture is synthesized: its
// header says "synthesized": true and names its sources. The host frames are built with the ACP base's own wire
// builders and the Grok configuration's `_meta` (src/core/adapters/grok/wire.ts); the agent frames follow the schema
// (tests/unit/grok/fixtures.test.ts validates every frame, Grok's own x.ai/* notifications as JSON-RPC only) and go
// through the recorder's Grok rules (scripts/redact-grok.mjs), as a live recording would. For each scenario this also
// writes the live re-record recipe (recipes/<ID>-<slug>/stdin.jsonl, responders.mjs, pass.json, record.txt).
// --check compares instead of writing (exit 1 when a committed file differs, or the generator no longer writes one).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initializeParams,
  newSessionParams,
  promptParams,
  rejectReply,
} from '../../../../src/core/adapters/acp-base/protocol.ts'
import { GROK_ASK_META, GROK_YOLO_META, grokMetaUsage } from '../../../../src/core/adapters/grok/wire.ts'
import { redactGrokValue } from '../../../../scripts/redact-grok.mjs'
import { GROK_PREFS } from './dim-factory-responder.mjs'

const SELF = fileURLToPath(import.meta.url)
const FIXTURES = resolve(dirname(SELF), '..')
const RECIPES = dirname(SELF)
const ROUTE = 'acp'
/**
 * The Grok Build release the fixtures' shapes are read for: the newest a release tracker named when the adapter was
 * built (1.0.50, 2026-10-06; secondhand), against docs and source read from main on 2026-10-11. A live re-record
 * stamps the real `grok --version`.
 */
const CLI_VERSION = '1.0.50'
const CWD = '<CWD>'
const SOURCES =
  'src/core/adapters/acp-base/protocol/v1.25.0 (Agent Client Protocol schema v1.25.0); ' +
  'github.com/xai-org/grok-build main, read 2026-10-11: ' +
  'crates/codegen/xai-grok-pager/docs/user-guide/{01-getting-started,02-authentication,14-headless-mode,' +
  '15-agent-mode,17-sessions,19-plan-mode,22-permissions-and-safety,26-config-reference}.md and ' +
  'crates/codegen/xai-grok-shell/src/agent/{auth_method.rs,folder_trust.rs,mvp_agent/acp_agent.rs,' +
  'mvp_agent/session_setup.rs,mvp_agent/prompt_response_meta_tests.rs}'

const sid = (n) => `0199d2a4-7c1e-7a3b-9f20-3c4d5e6f70${String(n).padStart(2, '0')}`
const loc = (rel) => ({ path: `${CWD}/${rel}` })
const textContent = (text) => ({ type: 'content', content: { type: 'text', text } })
const diff = (rel, oldText, newText) => ({ type: 'diff', path: `${CWD}/${rel}`, oldText, newText })

// ---- one recorded process -----------------------------------------------------------------------------------------

class Rec {
  constructor() {
    this.frames = []
    this.nextClient = 1
    this.nextAgent = 0
    this.calls = 0
  }
  push(dir, value) {
    // An agent message is written as the recorder writes a live one (scripts/redact-grok.mjs), so the redaction suite
    // holds for every fixture.
    const v = dir === 'out' && typeof value !== 'string' ? redactGrokValue(value).value : value
    this.frames.push({ t: this.frames.length * 5, dir, line: typeof v === 'string' ? v : JSON.stringify(v) })
  }
  /** A tool call id (Grok's own shape is not documented; synthesized as `call_<n>`). */
  callId(scenario) {
    this.calls++
    return `call_${scenario}_${String(this.calls).padStart(2, '0')}`
  }
  // client → agent
  request(method, params) {
    const id = this.nextClient++
    this.push('in', { jsonrpc: '2.0', id, method, params })
    return id
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
  notify(method, params) {
    this.push('out', { jsonrpc: '2.0', method, params })
  }
  update(sessionId, update) {
    this.notify('session/update', { sessionId, update })
  }
  agentRequest(method, params) {
    const id = this.nextAgent++
    this.push('out', { jsonrpc: '2.0', id, method, params })
    return id
  }
  eof() {
    this.frames.push({ t: this.frames.length * 5, dir: 'eof' })
  }
  exit(code = 0) {
    this.frames.push({ t: this.frames.length * 5, dir: 'exit', code, signal: null })
  }
}

// ---- Grok shapes ----------------------------------------------------------------------------------------------------

/**
 * Grok's initialize answer (mvp_agent/acp_agent.rs): protocol 1, loadSession, embedded context, MCP over http and sse,
 * session close, list and resume (outside chat mode), the sign-in methods it can use (auth_method.rs: the cached token
 * first when there is one, then the browser sign-in), and `_meta` {grokShell, defaultAuthMethodId, agentVersion}.
 */
function initResult() {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
    authMethods: [
      { id: 'cached_token', name: 'cached_token', description: 'Cached token from ~/.grok/auth.json' },
      { id: 'grok.com', name: 'Grok', description: 'Sign in with Grok' },
    ],
    _meta: { grokShell: true, defaultAuthMethodId: 'cached_token', agentVersion: CLI_VERSION },
  }
}

const MODEL = 'grok-4.6'
/** session/new's `models` (the unstable SessionModelState; not in schema v1.25.0) and its configOptions. */
function sessionResult(id, model = MODEL) {
  return {
    sessionId: id,
    models: {
      availableModels: [
        { modelId: 'grok-4.6', name: 'Grok 4.6' },
        { modelId: 'grok-4.5', name: 'Grok 4.5' },
      ],
      currentModelId: model,
    },
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: model,
        options: [
          { value: 'grok-4.6', name: 'Grok 4.6' },
          { value: 'grok-4.5', name: 'Grok 4.5' },
        ],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'medium',
        options: ['minimal', 'low', 'medium', 'high', 'xhigh'].map((v) => ({ value: v, name: v })),
      },
    ],
    _meta: {
      currentWorkingDirectory: CWD,
      codebaseIndexed: false,
      isGitRepo: true,
      gitRoot: CWD,
      showNonGitWarning: false,
      feedbackEnabled: false,
    },
  }
}

const COMMANDS = [
  { name: 'compact', description: 'Compact the conversation', input: null },
  { name: 'review', description: 'Review the working tree', input: null },
]

/**
 * The options of a Grok confirmation (user guide 22, "Interactive prompt choices"; the ACP option ids are not
 * documented, so these are synthesized): Allow once, Reject once, the session-wide widenings Dim Factory never chooses
 * ("Enable always-approve mode", and "Allow all edits this session" for an edit) and, for a command, the per-project
 * "Always allow" and "Never allow" rows.
 */
const OPT = {
  once: { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  reject: { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  yolo: { optionId: 'always_approve', name: 'Enable always-approve mode', kind: 'allow_always' },
  allEdits: { optionId: 'allow_all_edits', name: 'Allow all edits this session', kind: 'allow_always' },
  alwaysCmd: (cmd) => ({ optionId: 'always_allow', name: `Always allow \`${cmd}\` in this project`, kind: 'allow_always' }),
  neverCmd: (cmd) => ({ optionId: 'never_allow', name: `Never allow \`${cmd}\` in this project`, kind: 'reject_always' }),
}
const EDIT_OPTIONS = [OPT.once, OPT.allEdits, OPT.yolo, OPT.reject]
const SHELL_OPTIONS = (cmd) => [OPT.once, OPT.alwaysCmd(cmd), OPT.yolo, OPT.reject, OPT.neverCmd(cmd)]
const MODE_OPTIONS = [OPT.once, OPT.reject]

/** One session's updates. */
class Session {
  constructor(r, id, scenario) {
    this.r = r
    this.id = id
    this.scenario = scenario
  }
  say(...chunks) {
    for (const text of chunks)
      this.r.update(this.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }
  think(text) {
    this.r.update(this.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
  }
  commands() {
    this.r.update(this.id, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS })
  }
  /** A `tool_call` update; returns its id. */
  tool(o) {
    const toolCallId = o.id ?? this.r.callId(this.scenario)
    this.r.update(this.id, {
      sessionUpdate: 'tool_call',
      toolCallId,
      status: o.status ?? 'in_progress',
      title: o.title,
      name: o.name,
      kind: o.kind,
      content: o.content ?? [],
      locations: o.locations ?? [],
      ...(o.rawInput !== undefined ? { rawInput: o.rawInput } : {}),
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
  /** The pending tool_call, then session/request_permission for it; returns {toolCallId, ask}. */
  ask(o, options) {
    const toolCallId = this.tool({ ...o, status: 'pending' })
    const ask = this.r.agentRequest('session/request_permission', {
      sessionId: this.id,
      options,
      toolCall: {
        toolCallId,
        status: 'pending',
        title: o.title,
        name: o.name,
        kind: o.kind,
        content: o.content ?? [],
        locations: o.locations ?? [],
        ...(o.rawInput !== undefined ? { rawInput: o.rawInput } : {}),
      },
    })
    return { toolCallId, ask }
  }
}

const READ = (rel) => ({ name: 'Read', title: `Read ${rel}`, kind: 'read', locations: [loc(rel)] })
const SHELL = (command) => ({
  name: 'Bash',
  title: command,
  kind: 'execute',
  rawInput: { command },
})
const EDIT = (rel, oldText, newText) => ({
  name: 'Edit',
  title: `Edit ${rel}`,
  kind: 'edit',
  content: [diff(rel, oldText, newText)],
  locations: [loc(rel)],
})
/** Grok's own plan mode asks before it switches (user guide 19, `enter_plan_mode`). */
const ENTER_PLAN = { name: 'enter_plan_mode', title: 'Enter plan mode', kind: 'switch_mode' }

/**
 * The opening of a process: initialize, then session/new with the pass's posture (`meta`, the mode's `_meta`; the
 * probe sends none). Returns the session (undefined when session/new was refused).
 */
function open(r, o) {
  const init = r.request('initialize', initializeParams())
  r.result(init, initResult())
  const params = o.meta !== undefined ? { ...newSessionParams(CWD), _meta: o.meta } : newSessionParams(CWD)
  const req = r.request('session/new', params)
  if (o.newError !== undefined) {
    r.error(req, o.newError)
    return undefined
  }
  r.result(req, sessionResult(o.sid, o.model))
  const s = new Session(r, o.sid, o.scenario)
  if (o.commands === true) s.commands()
  return s
}

const prompt = (r, s, text) => r.request('session/prompt', promptParams(s.id, text))
const end = (r, code = 0) => {
  r.eof()
  r.exit(code)
}

/**
 * Grok's prompt answer (`build_prompt_response_meta`): no ACP `usage`; `_meta` names the session, the request and
 * prompt ids, the session's running total, the model, the last turn's tokens and the prompt's usage per model (the
 * headless `modelUsage` keys). In `modelUsage` the cached reads are apart from inputTokens (the headless total, input +
 * cache read + output). The last turn's keys are the API's own (prompt_response_meta_tests.rs): `inputTokens` is
 * prompt_tokens, which holds the cached reads, so `cachedReadTokens` never exceeds it.
 */
function promptAnswer(stopReason, s, u, n) {
  return {
    stopReason,
    _meta: {
      sessionId: s.id,
      requestId: `prompt-${n}`,
      promptId: `prompt-${n}`,
      totalTokens: u.input + u.cached + u.output + 4096,
      modelId: u.model ?? MODEL,
      inputTokens: u.lastInput,
      outputTokens: u.lastOutput,
      cachedReadTokens: u.lastCached,
      reasoningTokens: u.reasoning,
      usage: {
        totalTokens: u.input + u.cached + u.output,
        modelUsage: {
          [u.model ?? MODEL]: {
            inputTokens: u.input,
            outputTokens: u.output,
            cacheReadInputTokens: u.cached,
            modelCalls: u.calls,
            costUSD: u.cost,
          },
        },
      },
    },
  }
}

/** The pass usage the adapter reports for an answer (grok/wire.ts grokMetaUsage, exact: no usageApprox). */
const usageOfAnswer = (answer) => {
  const { approx: _approx, ...usage } = grokMetaUsage(answer)
  return usage
}

// ---- expected entries (events + the signals that matter; liveness never) -----------------------------------------

const ev = {
  session: (id) => ({ type: 'session', id }),
  text: (delta) => ({ type: 'text', delta }),
  toolStart: (id) => ({ type: 'tool', id, phase: 'start' }),
  toolEnd: (id, status = 'ok') => ({ type: 'tool', id, phase: 'end', status }),
  done: (result, usage) => (usage === undefined ? { type: 'done', result } : { type: 'done', result, usage }),
  error: (category) => ({ type: 'error', fatal: true, category }),
  auto: (decision, why) => ({ type: 'auto-answered', decision, why }),
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
  critic: 'Critique the change in src/cli.ts: what could break? List findings as [must]/[should]/[nit].',
  implement: 'Add a --version flag to the CLI that prints the package version.',
}
const VERSION_EDIT = EDIT(
  'src/cli.ts',
  'const args = process.argv.slice(2)',
  "const args = process.argv.slice(2)\nif (args.includes('--version')) console.log(version)",
)

const PASS = (step, mode, prompt_, extra = {}) => ({
  kind: 'pass',
  step,
  mode,
  planNative: false,
  prompt: prompt_,
  trustFolder: false,
  ...extra,
})

const U = {
  GR02: { input: 6144, cached: 18432, output: 210, calls: 2, cost: 0.0213, lastInput: 12416, lastOutput: 150, lastCached: 9216, reasoning: 60 },
  GR03: { input: 4096, cached: 12288, output: 160, calls: 2, cost: 0.0142, lastInput: 8192, lastOutput: 90, lastCached: 6144, reasoning: 32 },
  GR04: { input: 9216, cached: 27648, output: 330, calls: 4, cost: 0.0318, lastInput: 11776, lastOutput: 120, lastCached: 9216, reasoning: 48 },
  GR05: { input: 12288, cached: 36864, output: 540, calls: 4, cost: 0.0457, lastInput: 15360, lastOutput: 130, lastCached: 12288, reasoning: 64 },
}

/** @type {Array<{id:string, slug:string, pass:object, note:string, argv?:string[], build:(r:Rec)=>void, expected:object[]|(()=>object[])}>} */
const SCENARIOS = [
  {
    id: 'GR01',
    slug: 'handshake-session',
    pass: { kind: 'probe', force: true },
    note:
      'The probe on Test (vendor.grok.protocol, "ACP authRequired on Test"): initialize, then session/new in ' +
      "Dim Factory's own probe folder, no prompt, no token. The answer advertises loadSession and session/resume, the " +
      "sign-in methods Grok can use (its cached sign-in first) and its version in _meta; session/new names the models " +
      '(unstable models and a configOptions model select) and no modes (Grok has no ACP mode switch). The launch probe ' +
      'stops at initialize.',
    build(r) {
      open(r, { sid: sid(1), scenario: 'GR01' })
      end(r)
    },
    expected: [],
  },
  {
    id: 'GR01b',
    slug: 'auth-required',
    pass: { kind: 'probe', force: true },
    note:
      'Not signed in, on Test: initialize answers (it needs no sign-in), session/new answers ACP authRequired (-32000 ' +
      '"Authentication required"). vendor.grok.auth fails auth_required with the sign-in command to copy; Dim Factory ' +
      'never calls authenticate.',
    build(r) {
      open(r, { sid: sid(2), scenario: 'GR01b', newError: { code: -32000, message: 'Authentication required' } })
      end(r)
    },
    expected: [],
  },
  {
    id: 'GR02',
    slug: 'review-message-chunks',
    pass: PASS('review', 'readonly', PROMPTS.review, { model: MODEL }),
    note:
      'A read-only Review with a picked model (`grok agent --model grok-4.6 --no-leader stdio`): session/new with the ' +
      'ask posture (_meta yoloMode false, autoMode false), no set_mode (Grok has none). A read runs unasked; a thought ' +
      "(logged, never printed), Grok's own x.ai/session_notification (ignored) and the answer as agent_message_chunk " +
      'text; the prompt answer carries no ACP usage, its _meta.usage.modelUsage is the pass usage (cached reads apart, ' +
      'exact) and Grok\'s own cost.',
    build(r) {
      const s = open(r, { sid: sid(3), scenario: 'GR02', meta: GROK_ASK_META, model: MODEL, commands: true })
      const p = prompt(r, s, PROMPTS.review)
      r.notify('x.ai/session_notification', { sessionId: s.id, kind: 'title', title: 'Review the version flag' })
      s.think('Reading the change before judging it.')
      const read = s.run({ ...READ('src/cli.ts'), output: "const args = process.argv.slice(2)\n" })
      s.say('No blocking issues. ', '[nit] cli.ts: name the version constant.')
      const answer = promptAnswer('end_turn', s, U.GR02, 1)
      r.result(p, answer)
      end(r)
      this.ids = { read }
      this.answer = answer
    },
    expected: () => {
      const { ids, answer } = builtOf('GR02')
      return [
        ev.session(sid(3)),
        ev.toolStart(ids.read),
        ev.toolEnd(ids.read),
        ...texts(['No blocking issues. ', '[nit] cli.ts: name the version constant.']),
        ev.done('No blocking issues. [nit] cli.ts: name the version constant.', usageOfAnswer(answer)),
      ]
    },
  },
  {
    id: 'GR03',
    slug: 'default-mode-edit',
    pass: {
      kind: 'study',
      step: 'implement',
      mode: 'autoedit',
      planNative: false,
      prompt: PROMPTS.implement,
      trustFolder: false,
      study: 'default-mode-edit',
    },
    note:
      'Decides Grok autoedit (fixture-gated; SYNTHESIZED, so it stays unsupported). What Grok does with an edit when ' +
      'no posture approves edits: session/new with the ask posture, the edit asks, and the only grants beyond once are ' +
      '"Allow all edits this session" and "Enable always-approve mode": answers to an edit already asked, each widening ' +
      'the session from inside it, never an edits-only posture Dim Factory could set before the turn. The study rejects ' +
      'it (as the adapter would; nothing is written). Dim Factory itself never starts an autoedit pass on Grok: the ' +
      'adapter refuses it before spawning (expected events).',
    build(r) {
      const s = open(r, { sid: sid(4), scenario: 'GR03', meta: GROK_ASK_META })
      const p = prompt(r, s, PROMPTS.implement)
      const read = s.run(READ('src/cli.ts'))
      const { toolCallId: edit, ask } = s.ask(VERSION_EDIT, EDIT_OPTIONS)
      r.reply(ask, rejectReply(EDIT_OPTIONS, GROK_PREFS))
      s.toolUpdate(edit, 'failed', [textContent('The user rejected this edit.')])
      s.say('I could not edit src/cli.ts: the change was rejected.')
      r.result(p, promptAnswer('end_turn', s, U.GR03, 1))
      end(r)
      this.ids = { read, edit }
    },
    // The adapter refuses an autoedit pass before anything is spawned (support() unsupported until GR03).
    expected: [ev.error('capability_missing')],
  },
  {
    id: 'GR04',
    slug: 'review-readonly-rejects',
    pass: PASS('critic', 'readonly', PROMPTS.critic),
    note:
      'A read-only Critic: session/new with the ask posture; reads run unasked; a shell command, an edit and ' +
      "Grok's own enter_plan_mode each ask and the adapter rejects every one (reject_once; never Allow, never the " +
      'session-wide always-approve or all-edits options, never the per-project Always or Never allow), so zero asks ' +
      'reach the user; each rejected tool ends declined and the turn goes on to its findings.',
    build(r) {
      const s = open(r, { sid: sid(5), scenario: 'GR04', meta: GROK_ASK_META })
      const p = prompt(r, s, PROMPTS.critic)
      const read = s.run(READ('src/cli.ts'))
      const shellOptions = SHELL_OPTIONS('npm test')
      const { toolCallId: shell, ask: a1 } = s.ask(SHELL('npm test'), shellOptions)
      r.reply(a1, rejectReply(shellOptions, GROK_PREFS))
      s.toolUpdate(shell, 'failed', [textContent('The user rejected this command.')])
      const { toolCallId: edit, ask: a2 } = s.ask(VERSION_EDIT, EDIT_OPTIONS)
      r.reply(a2, rejectReply(EDIT_OPTIONS, GROK_PREFS))
      s.toolUpdate(edit, 'failed', [textContent('The user rejected this edit.')])
      const { toolCallId: plan, ask: a3 } = s.ask(ENTER_PLAN, MODE_OPTIONS)
      r.reply(a3, rejectReply(MODE_OPTIONS, GROK_PREFS))
      s.toolUpdate(plan, 'failed')
      s.say('[should] cli.ts: --version prints undefined when package.json has no version.')
      const answer = promptAnswer('end_turn', s, U.GR04, 1)
      r.result(p, answer)
      end(r)
      this.ids = { read, shell, edit, plan }
      this.answer = answer
    },
    expected: () => {
      const { ids, answer } = builtOf('GR04')
      return [
        ev.session(sid(5)),
        ev.toolStart(ids.read),
        ev.toolEnd(ids.read),
        ev.toolStart(ids.shell),
        ev.auto('deny', 'readonly'),
        ev.toolEnd(ids.shell, 'declined'),
        ev.toolStart(ids.edit),
        ev.auto('deny', 'readonly'),
        ev.toolEnd(ids.edit, 'declined'),
        ev.toolStart(ids.plan),
        ev.auto('deny', 'readonly'),
        ev.toolEnd(ids.plan, 'declined'),
        ...texts(['[should] cli.ts: --version prints undefined when package.json has no version.']),
        ev.done(
          '[should] cli.ts: --version prints undefined when package.json has no version.',
          usageOfAnswer(answer),
        ),
      ]
    },
  },
  {
    id: 'GR05',
    slug: 'full-yolo-auto',
    pass: PASS('implement', 'full', PROMPTS.implement, { auto: true }),
    note:
      'Full mode, which only Auto runs (config: mode full only with auto): session/new with _meta yoloMode true ' +
      '(always-approve for this session only, never the --always-approve flag). The read, the edit and the test ' +
      'command run without a single permission request; the answer and its _meta usage follow.',
    build(r) {
      const s = open(r, { sid: sid(6), scenario: 'GR05', meta: GROK_YOLO_META })
      const p = prompt(r, s, PROMPTS.implement)
      const read = s.run(READ('src/cli.ts'))
      const edit = s.run(VERSION_EDIT)
      const shell = s.run({ ...SHELL('npm test'), output: '# pass 3\n# fail 0\n' })
      s.say('Added `--version` ', 'to src/cli.ts; tests pass.')
      const answer = promptAnswer('end_turn', s, U.GR05, 1)
      r.result(p, answer)
      end(r)
      this.ids = { read, edit, shell }
      this.answer = answer
    },
    expected: () => {
      const { ids, answer } = builtOf('GR05')
      return [
        ev.session(sid(6)),
        ev.toolStart(ids.read),
        ev.toolEnd(ids.read),
        ev.toolStart(ids.edit),
        ev.toolEnd(ids.edit),
        ev.toolStart(ids.shell),
        ev.toolEnd(ids.shell),
        ...texts(['Added `--version` ', 'to src/cli.ts; tests pass.']),
        ev.done('Added `--version` to src/cli.ts; tests pass.', usageOfAnswer(answer)),
      ]
    },
  },
]

const BUILT = new Map()
function builtOf(id) {
  const b = BUILT.get(id)
  if (b === undefined) throw new Error(`${id} has not been built yet`)
  return b
}

// ---- writing ------------------------------------------------------------------------------------------------------

/** `grok agent [--model <m>] --no-leader stdio` (src/core/adapters/grok/config.ts resolveLaunch). */
function argvOf(s) {
  if (s.argv !== undefined) return s.argv
  const model = typeof s.pass.model === 'string' ? ['--model', s.pass.model] : []
  return ['grok', 'agent', ...model, '--no-leader', 'stdio']
}

function headerOf(s) {
  return {
    kind: 'header',
    schemaVersion: 1,
    vendor: 'grok',
    route: ROUTE,
    scenario: `${s.id}-${s.slug}`,
    cliVersion: CLI_VERSION,
    protocol: 'jsonrpc',
    jsonrpc: '2.0',
    os: 'any',
    arch: 'any',
    synthesized: true,
    synthesizedFrom: SOURCES,
    note: `${s.note} Generator: tests/fixtures/grok/recipes/synthesize.mjs. Re-record live: tests/fixtures/grok/README.md.`,
    argv: argvOf(s),
    envKeys: ['GROK_DISABLE_AUTOUPDATER', 'GROK_HOME'],
    envDrop: ['^GROK_', '^XAI_'],
    pass: s.pass,
    hostVersion: '0.1.0',
  }
}

/** Builds every scenario once, in order. */
function built() {
  const out = []
  for (const s of SCENARIOS) {
    const r = new Rec()
    const holder = { ids: undefined, answer: undefined }
    s.build.call(holder, r)
    BUILT.set(s.id, holder)
    out.push({ s, text: `${[headerOf(s), ...r.frames].map((x) => JSON.stringify(x)).join('\n')}\n` })
  }
  return out
}

/** A response (never a request) to the host's request `id`: a `$wait` pattern. */
const responseTo = (id) => ({ id, method: { $absent: true } })

const RESPONDERS_MJS = [
  "// Answers every agent request as Dim Factory's ACP base does for this pass with the Grok configuration",
  '// (../dim-factory-responder.mjs, with ./pass.json). Generated by ../synthesize.mjs; the recorder loads it with',
  '// --responders.',
  "import { readFileSync } from 'node:fs'",
  "import { dimFactoryResponder } from '../dim-factory-responder.mjs'",
  '',
  "export default dimFactoryResponder(JSON.parse(readFileSync(new URL('./pass.json', import.meta.url), 'utf8')))",
  '',
].join('\n')

/**
 * The live re-record recipe's stdin: Dim Factory's own requests, paced by `$wait` on each answer, with the session id
 * captured from session/new and the sandbox as `$cwd`. The replies to the agent's requests come from responders.mjs.
 */
function recipeStdin(text) {
  const frames = text
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => JSON.parse(l))
  const outs = frames.filter((f) => f.dir === 'out').map((f) => JSON.parse(f.line))
  const sessionIds = new Set(outs.flatMap((m) => (typeof m.result?.sessionId === 'string' ? [m.result.sessionId] : [])))
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
    if (msg.method === 'session/cancel') throw new Error('a Grok recipe with session/cancel needs a recipe of its own')
    stdin.push(vars(msg))
    if (!Object.hasOwn(msg, 'id')) continue
    if (msg.method === 'session/prompt') {
      promptId = msg.id
      continue
    }
    const answer = outs.find((m) => m.id === msg.id && typeof m.method !== 'string')
    if (answer === undefined) continue
    const capture =
      msg.method === 'session/new' && answer.result !== undefined
        ? { $capture: { sessionId: 'result.sessionId' } }
        : {}
    stdin.push(JSON.stringify({ $wait: responseTo(msg.id), $timeoutMs: 120000, ...capture }))
  }
  if (promptId !== undefined && outs.some((m) => m.id === promptId && typeof m.method !== 'string'))
    stdin.push(JSON.stringify({ $wait: responseTo(promptId), $timeoutMs: 900000 }))
  return stdin
}

function expectedText(s) {
  const expected = typeof s.expected === 'function' ? s.expected() : s.expected
  return `${JSON.stringify(expected, null, 2)}\n`
}

/** Live re-record notes per scenario (README "Re-recording live"): what it needs beyond the common command. */
const LIVE_NOTES = {
  GR01: "--cwd is an empty scratch folder (the probe runs in Dim Factory's own tmp/probe-cwd); a signed-in profile.",
  GR01b: 'Needs a fixture profile that is signed out (no auth.json in it, no XAI_API_KEY in --env-file).',
  GR02: 'A signed-in profile; --model is the model to stamp (any the account offers).',
  GR03:
    'Decides Grok autoedit. Record the options Grok offers for the edit and what each is called; the study rejects ' +
    'it. Autoedit becomes supportable only if Grok offers an edits-only posture Dim Factory can set before the turn.',
  GR04: 'The live check that a read-only Grok pass raises zero asks: every request rejected by the responder.',
  GR05:
    'Writes to the sandbox (always-approve for this session). Use a throwaway copy; never a folder with anything of ' +
    'value.',
}

/** recipes/<ID>-<slug>/record.txt: the command that re-records this scenario live (placeholders in <>). */
function recordCommand(s) {
  const name = `${s.id}-${s.slug}`
  const r = `tests/fixtures/grok/recipes/${name}`
  const parts = [
    'node scripts/record-fixture.mjs --acp --vendor grok --grok-home "<fixture GROK_HOME>"',
    '--bin "<the grok executable>" --cwd "<sandbox>"',
    `--out tests/fixtures/grok/${ROUTE}/${name} --id ${s.id} --slug ${s.slug} --cli-version <x.y.z> --timing off`,
    `--stdin ${r}/stdin.jsonl --pass-file ${r}/pass.json --responders ${r}/responders.mjs`,
  ]
  const lines = [
    `# ${name}: ${s.note}`,
    ...(LIVE_NOTES[s.id] ? [`# ${LIVE_NOTES[s.id]}`] : []),
    '# A fresh git-init copy of tests/fixtures/sandboxes/ts-small as <sandbox>; never the everyday ~/.grok.',
    `${parts.join(' ')} --timeout 900000 -- ${argvOf(s).slice(1).join(' ')}`,
  ]
  return `${lines.join('\n')}\n`
}

/** Scenarios recorded live (`<ID>-<slug>`): their recipe is generated, their recording and expected events are not. */
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
    files.set(join(RECIPES, name, 'stdin.jsonl'), `${recipeStdin(text).join('\n')}\n`)
    files.set(join(RECIPES, name, 'responders.mjs'), RESPONDERS_MJS)
    files.set(join(RECIPES, name, 'pass.json'), `${JSON.stringify(s.pass, null, 2)}\n`)
    files.set(join(RECIPES, name, 'record.txt'), recordCommand(s))
  }
  return files
}

/** Files in the folders the generator owns that it does not write (absolute paths). */
export function strays(files = synthesize()) {
  const owned = new Set([...files.keys()].map((p) => resolve(p).toLowerCase()))
  const out = []
  for (const base of [join(FIXTURES, ROUTE), RECIPES]) {
    if (!existsSync(base)) continue
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      if (base !== RECIPES && LIVE.has(d.name)) continue
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

export { GROK_PREFS, SCENARIOS }

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
    process.stdout.write(`synthesized ${SCENARIOS.length} Grok fixtures (${files.size} files)\n`)
    const left = strays(files)
    if (left.length > 0) {
      process.stderr.write(`synthesize: files the generator no longer writes (remove them):\n${left.map((d) => `  ${d}`).join('\n')}\n`)
      process.exitCode = 1
    }
  }
}
