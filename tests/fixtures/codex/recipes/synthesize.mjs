#!/usr/bin/env node
// Synthesizes the Codex fixtures (X01–X17 app-server, E01–E08 exec) from the generated 0.160 protocol
// (src/core/adapters/codex/protocol/v0.160.0/).
//
//   node tests/fixtures/codex/recipes/synthesize.mjs [--check]
//
// X01a/b, X02, X03a/b, X04, X06a/b, X07, X08, X09h, X10, X12a, X17, X18a/b, X20 to X24 and E01/E02/E04 were recorded
// live with a logged-in account and are published synthesized from those recordings (scripts/synthesize-fixtures.mjs):
// they are not generated here, and their recipes are kept by hand. What stays is synthesized: its header says "synthesized": true and names its sources.
// The host frames are built with the adapter's own params.ts (what Dim Factory sends); the server frames follow the
// generated schema, and tests/unit/codex/protocol/fixtures-schema.test.ts validates every frame against it. For each
// scenario this also writes the live re-record recipe (recipes/<ID>-<slug>/stdin.jsonl, responders.json, pass.json;
// README "Re-recording").
// --check compares instead of writing (exit 1 when a committed file differs).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REFUSED_CODE, REFUSED_MESSAGE } from '../../../../src/core/adapters/codex/asks.ts'
import { execArgv } from '../../../../src/core/adapters/codex/launch.ts'
import {
  ELICITATION_CANCEL,
  approvalReply,
  initializeParams,
  permissionsReply,
  planCollaboration,
  threadResumeParams,
  threadStartParams,
  turnStartParams,
} from '../../../../src/core/adapters/codex/params.ts'
import { usageFromTokenBreakdown } from '../../../../src/core/adapters/codex/protocol.ts'
import { RESEARCH_SCHEMA } from '../../../../src/core/research/parse.ts'
import { redactCodexValue } from '../../../../scripts/redact-codex.mjs'

const SELF = fileURLToPath(import.meta.url)
const FIXTURES = resolve(dirname(SELF), '..')
const RECIPES = dirname(SELF)
const CLI_VERSION = '0.160.1'
const CWD = '<CWD>'
const MODEL = 'gpt-5.6-terra'
const T0_MS = 1791602700000
const SOURCES =
  'src/core/adapters/codex/protocol/v0.160.0 (generate-ts / generate-json-schema of codex-cli 0.160.1); ' +
  'the live X01b handshake (emittedAtMs, initialize result)'
const META_PLAN_FALLBACK = 'planFallback'
const META_PLAN_SOURCE = 'planSource'

const tid = (n) => `019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e${String(n).padStart(2, '0')}`
const turnIdOf = (n, k = 1) => `019a1c3f-${String(n).padStart(4, '0')}-7000-8000-${String(k).padStart(12, '0')}`

// ---- token usage ------------------------------------------------------------------------------------------------

/** A cumulative breakdown as Codex reports it (totalTokens = input + output, as the OpenAI API counts). */
function breakdown(input, cached, output, reasoning, cacheWrite = 0) {
  return {
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
  }
}
/** Dim Factory Usage of a cumulative breakdown (protocol.ts usageFromTokenBreakdown: cached input comes off input). */
const usageOf = (b) => usageFromTokenBreakdown(b)

// ---- one recorded process ---------------------------------------------------------------------------------------

class Rec {
  constructor() {
    this.frames = []
    this.nextClient = 1
    this.nextServer = 0
    this.clock = T0_MS
    /** thread/start-style client requests by id (the recipe captures their thread). */
    this.methods = new Map()
  }
  push(dir, value) {
    // A server message is written as the recorder writes a live one (scripts/redact-codex.mjs: the machine in the
    // userAgent, the MCP server's name and text, …), so tests/unit/fixtures-redaction.test.ts holds for every fixture.
    const v = dir === 'out' && typeof value !== 'string' ? redactCodexValue(value).value : value
    this.frames.push({ t: this.frames.length * 5, dir, line: typeof v === 'string' ? v : JSON.stringify(v) })
  }
  ms(step = 37) {
    this.clock += step
    return this.clock
  }
  // client → server
  request(method, params) {
    const id = this.nextClient++
    this.methods.set(id, method)
    this.push('in', params === undefined ? { id, method } : { id, method, params })
    return id
  }
  notify(method, params) {
    this.push('in', params === undefined ? { method } : { method, params })
  }
  reply(id, result) {
    this.push('in', { id, result })
  }
  replyError(id, error) {
    this.push('in', { id, error })
  }
  // server → client
  result(id, result) {
    this.push('out', { id, result })
  }
  error(id, error) {
    this.push('out', { error, id })
  }
  note(method, params) {
    this.push('out', { method, params, emittedAtMs: this.ms() })
  }
  serverRequest(method, params) {
    const id = this.nextServer++
    this.push('out', { id, method, params })
    return id
  }
  stderr(line) {
    this.push('err', line)
  }
  eof() {
    this.frames.push({ t: this.frames.length * 5, dir: 'eof' })
  }
  exit(code = 0, extra = {}) {
    this.frames.push({ t: this.frames.length * 5, dir: 'exit', code, signal: null, ...extra })
  }
}

// ---- app-server shapes (v2) -------------------------------------------------------------------------------------

function thread(id, o = {}) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    preview: o.preview ?? '',
    ephemeral: o.ephemeral ?? false,
    modelProvider: o.modelProvider ?? 'openai',
    createdAt: Math.floor(T0_MS / 1000),
    updatedAt: Math.floor(T0_MS / 1000),
    status: { type: 'idle' },
    path: o.ephemeral ? null : `<CODEX_HOME>/sessions/2026/10/09/rollout-2026-10-09T23-25-00-${id}.jsonl`,
    cwd: CWD,
    cliVersion: CLI_VERSION,
    source: 'appServer',
    projectId: null,
    gitInfo: null,
    name: null,
    turns: [],
  }
}

function threadResponse(t, o) {
  const sandbox =
    o.sandbox === 'read-only'
      ? { type: 'readOnly', networkAccess: false }
      : o.sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  return {
    thread: t,
    model: o.model ?? MODEL,
    modelProvider: o.modelProvider ?? 'openai',
    serviceTier: null,
    cwd: CWD,
    approvalPolicy: o.approvalPolicy,
    approvalsReviewer: 'user',
    sandbox,
    reasoningEffort: 'medium',
  }
}

const turnObj = (id, status, error = null) => ({
  id,
  items: [],
  itemsView: 'notLoaded',
  status,
  error,
  startedAt: Math.floor(T0_MS / 1000),
  completedAt: status === 'inProgress' ? null : Math.floor(T0_MS / 1000) + 9,
  durationMs: status === 'inProgress' ? null : 9120,
})

const userMessage = (id, text) => ({
  type: 'userMessage',
  id,
  content: [{ type: 'text', text, text_elements: [] }],
})
const agentMessage = (id, text) => ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null })
const reasoning = (id, summary) => ({ type: 'reasoning', id, summary: [summary], content: [] })
function command(id, cmd, o = {}) {
  return {
    type: 'commandExecution',
    id,
    command: cmd,
    cwd: CWD,
    processId: null,
    source: 'agent',
    status: o.status ?? 'inProgress',
    commandActions: o.actions ?? [{ type: 'unknown', command: cmd }],
    aggregatedOutput: o.output ?? null,
    exitCode: o.exitCode ?? null,
    durationMs: o.durationMs ?? null,
  }
}
const readAction = (path) => ({ type: 'read', command: `cat ${path}`, name: path.split('/').pop(), path })
function fileChange(id, changes, status = 'inProgress') {
  return {
    type: 'fileChange',
    id,
    changes: changes.map(([path, kind, diff]) => ({ path, kind: { type: kind, ...(kind === 'update' ? { move_path: null } : {}) }, diff })),
    status,
  }
}

/** One turn on a session: the bookkeeping notifications a real turn carries. */
class Turn {
  constructor(r, threadId, turnId) {
    this.r = r
    this.threadId = threadId
    this.turnId = turnId
  }
  started() {
    this.r.note('turn/started', { threadId: this.threadId, turn: turnObj(this.turnId, 'inProgress') })
  }
  itemStarted(item) {
    this.r.note('item/started', { item, threadId: this.threadId, turnId: this.turnId, startedAtMs: this.r.ms(1) })
  }
  itemCompleted(item) {
    this.r.note('item/completed', { item, threadId: this.threadId, turnId: this.turnId, completedAtMs: this.r.ms(1) })
  }
  user(text) {
    const item = userMessage(`${this.turnId.slice(-4)}-user`, text)
    this.itemStarted(item)
    this.itemCompleted(item)
  }
  /** An agentMessage streamed as `deltas`, then completed with the whole text. */
  say(id, deltas) {
    this.itemStarted(agentMessage(id, ''))
    for (const d of deltas) {
      this.r.note('item/agentMessage/delta', { threadId: this.threadId, turnId: this.turnId, itemId: id, delta: d })
    }
    this.itemCompleted(agentMessage(id, deltas.join('')))
  }
  think(id, summary) {
    this.itemStarted(reasoning(id, ''))
    this.itemCompleted(reasoning(id, summary))
  }
  /** A command that runs to completion without an approval (inside the sandbox). */
  run(id, cmd, o = {}) {
    this.itemStarted(command(id, cmd, { actions: o.actions }))
    if (o.output) {
      this.r.note('item/commandExecution/outputDelta', {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: id,
        delta: o.output,
      })
    }
    this.itemCompleted(
      command(id, cmd, {
        actions: o.actions,
        status: o.status ?? 'completed',
        output: o.output ?? '',
        exitCode: o.exitCode ?? 0,
        durationMs: 412,
      }),
    )
  }
  usage(total, last) {
    this.r.note('thread/tokenUsage/updated', {
      threadId: this.threadId,
      turnId: this.turnId,
      tokenUsage: { total, last: last ?? total, modelContextWindow: 272000 },
    })
  }
  plan(steps) {
    this.r.note('turn/plan/updated', {
      threadId: this.threadId,
      turnId: this.turnId,
      explanation: null,
      plan: steps.map(([step, status]) => ({ step, status })),
    })
  }
  resolved(requestId) {
    this.r.note('serverRequest/resolved', { threadId: this.threadId, requestId })
  }
  /** The `error` notification Codex sends for a failure (willRetry:false) or a retry (true). */
  errorNote(message, codexErrorInfo, willRetry) {
    this.r.note('error', {
      error: { message, codexErrorInfo, additionalDetails: null },
      willRetry,
      threadId: this.threadId,
      turnId: this.turnId,
    })
  }
  completed(status = 'completed', error = null) {
    this.r.note('turn/completed', { threadId: this.threadId, turn: turnObj(this.turnId, status, error) })
  }
}

/**
 * The common opening of a pass: initialize → initialized → thread/start|resume (+ the thread/started echo) →
 * turn/start → turn/started. Returns the Turn. `o.resumeId` resumes; `o.echoId` makes the resume answer another id.
 */
function openPass(r, o) {
  const init = r.request('initialize', initializeParams(o.planNative === true))
  r.result(init, initResult())
  r.notify('initialized')
  const input = { step: o.step, mode: o.mode, cwd: CWD, ...(o.model ? { model: o.model } : {}), ...(o.local ? { local: o.local } : {}), ...(o.web !== undefined ? { web: o.web } : {}) }
  const params = o.resumeId !== undefined ? threadResumeParams(o.resumeId, input) : threadStartParams(input)
  const threadId = o.echoId ?? o.resumeId ?? o.threadId
  const t = thread(threadId, {
    ephemeral: params.ephemeral === true,
    preview: o.resumeId !== undefined ? 'resumed' : o.prompt.slice(0, 60),
    modelProvider: params.modelProvider ?? 'openai',
  })
  if (o.threadStartedFirst) r.note('thread/started', { thread: t })
  const start = r.request(o.resumeId !== undefined ? 'thread/resume' : 'thread/start', params)
  if (o.resumeError) {
    r.error(start, o.resumeError)
    return { start, threadId: undefined }
  }
  r.result(
    start,
    threadResponse(t, {
      sandbox: params.sandbox,
      approvalPolicy: params.approvalPolicy,
      model: params.model ?? MODEL,
      modelProvider: params.modelProvider ?? 'openai',
    }),
  )
  if (!o.threadStartedFirst && o.resumeId === undefined) r.note('thread/started', { thread: t })
  return { start, threadId, model: params.model ?? MODEL }
}

function initResult() {
  return {
    userAgent: `dim/${CLI_VERSION} (Windows 10.0.26200; x86_64) dumb (dim-factory; 0.1.0)`,
    codexHome: '<CODEX_HOME>',
    platformFamily: 'windows',
    platformOs: 'windows',
  }
}

/** turn/start (+ its response and turn/started); returns the Turn. */
function startTurn(r, threadId, turnId, prompt, extra = {}, o = {}) {
  const id = r.request('turn/start', turnStartParams({ threadId, prompt, ...extra }))
  const turn = new Turn(r, threadId, turnId)
  if (o.turnStartedFirst) turn.started()
  r.result(id, { turn: turnObj(turnId, 'inProgress') })
  if (!o.turnStartedFirst) turn.started()
  return turn
}

const end = (r, code = 0) => {
  r.eof()
  r.exit(code)
}

// ---- expected entries (events + the signals that matter; liveness never) -----------------------------------------

const ev = {
  session: (id) => ({ type: 'session', id }),
  text: (delta) => ({ type: 'text', delta }),
  toolStart: (id, name) => ({ type: 'tool', id, name, phase: 'start' }),
  toolEnd: (id, name, status = 'ok') => ({ type: 'tool', id, name, phase: 'end', status }),
  todo: () => ({ type: 'tool', name: 'todo' }),
  ask: (kind, allowSession = true) => ({ type: 'ask', kind, allowSession }),
  done: (result, usage) => (usage === undefined ? { type: 'done', result } : { type: 'done', result, usage }),
  error: (category) => ({ type: 'error', fatal: true, category }),
  withdrawn: () => ({ type: 'ask-withdrawn' }),
  auto: (decision, why) => ({ type: 'auto-answered', decision, why }),
  allowRule: (kind, tool) => ({ type: 'allow-rule', rule: { vendor: 'codex', kind, tool } }),
  plan: (markdown, source) => ({ type: 'plan-captured', markdown, source }),
  meta: (key, value) => (value === undefined ? { type: 'meta', key } : { type: 'meta', key, value }),
  /**
   * Live balanced run: a pass that names no model records the model its thread answered with (META_MODEL_USED); with
   * no account list to judge by (these replays have no probe) nothing is sent in its place.
   */
  modelUsed: (model = MODEL) => ({ type: 'meta', key: 'modelUsed', value: { model } }),
}

/** The text events of agent messages, as the adapter prints them: '\n\n' between two messages. */
function texts(...messages) {
  const out = []
  messages.forEach((deltas, i) => {
    if (i > 0) out.push(ev.text('\n\n'))
    for (const d of deltas) out.push(ev.text(d))
  })
  return out
}

// ---- scenarios ----------------------------------------------------------------------------------------------------

const PROMPTS = {
  review: 'Review the change in src/index.ts against the plan. List findings as [must]/[should]/[nit].',
  implement: 'Add a --version flag to the CLI that prints the package version.',
  fix: 'Fix the findings below.\n[must] cli.ts: --version prints undefined when package.json has no version.',
  plan: 'Plan how to add a --version flag to the CLI. Do not change files.',
  research: 'Research how CLIs usually offer a --version flag, with sources. Do not change files.',
  continue: 'continue',
}

const X04_TOTAL = breakdown(24576, 16384, 1450, 512)
const CATALOG_PROMPT = 'Refresh the prices of the Codex models in the catalog (the catalog refresh schema).'
const LOCAL_PRESET = { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder:30b' }

/** @type {Array<{id:string, slug:string, route:'app-server'|'exec', pass:object, note?:string, build:(r:Rec)=>void, expected:object[], recipe?:object}>} */
const SCENARIOS = [
  ...approvalScenarios(),
  {
    id: 'X04b',
    slug: 'filechange-approval',
    route: 'app-server',
    pass: { kind: 'pass', step: 'implement', mode: 'autoedit', planNative: false, prompt: PROMPTS.implement, answers: [{ decision: 'allow' }] },
    note: 'Implement: a fileChange outside the auto-approved set asks (item/started, requestApproval, accept, resolved, completed). Stays synthesized: on the live X04 the model wrote its file outside the folder with a shell command (a command approval).',
    build(r) {
      const { threadId } = openPass(r, { step: 'implement', mode: 'autoedit', threadId: tid(4), prompt: PROMPTS.implement })
      const turn = startTurn(r, threadId, turnIdOf(4), PROMPTS.implement)
      turn.user(PROMPTS.implement)
      turn.plan([['Read the CLI entry', 'completed'], ['Add the flag', 'inProgress'], ['Run the tests', 'pending']])
      const change = [['src/cli.ts', 'update', '@@ -1,3 +1,6 @@\n+if (process.argv.includes(\'--version\')) {\n+  console.log(version)\n+}\n']]
      turn.itemStarted(fileChange('call_04a', change))
      const ask = r.serverRequest('item/fileChange/requestApproval', {
        threadId,
        turnId: turnIdOf(4),
        itemId: 'call_04a',
        startedAtMs: r.ms(1),
        reason: 'Write src/cli.ts',
        grantRoot: null,
      })
      r.reply(ask, approvalReply('allow'))
      turn.resolved(ask)
      turn.itemCompleted(fileChange('call_04a', change, 'completed'))
      turn.say('msg_04a', ['Added `--version` ', 'to src/cli.ts.'])
      turn.usage(X04_TOTAL)
      turn.completed()
      end(r)
    },
    expected: [
      ev.session(tid(4)),
      ev.modelUsed(),
      ev.todo(),
      ev.toolStart('call_04a', 'edit'),
      ev.ask('edit'),
      ev.toolEnd('call_04a', 'edit'),
      ...texts(['Added `--version` ', 'to src/cli.ts.']),
      ev.done('Added `--version` to src/cli.ts.', usageOf(X04_TOTAL)),
    ],
  },
  {
    id: 'X05a',
    slug: 'network-approval',
    route: 'app-server',
    pass: { kind: 'pass', step: 'implement', mode: 'autoedit', planNative: false, prompt: PROMPTS.implement, answers: [{ decision: 'allow' }] },
    note: 'A command that needs the network: requestApproval with networkApprovalContext → an ask of kind network.',
    build(r) {
      const { threadId } = openPass(r, { step: 'implement', mode: 'autoedit', threadId: tid(5), prompt: PROMPTS.implement })
      const turn = startTurn(r, threadId, turnIdOf(5), PROMPTS.implement)
      const cmd = 'npm view typescript version'
      turn.itemStarted(command('call_05a', cmd))
      const ask = r.serverRequest('item/commandExecution/requestApproval', {
        threadId,
        turnId: turnIdOf(5),
        itemId: 'call_05a',
        startedAtMs: r.ms(1),
        reason: 'Look up the latest TypeScript version on the npm registry',
        networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
        command: cmd,
        cwd: CWD,
        commandActions: [{ type: 'unknown', command: cmd }],
      })
      r.reply(ask, approvalReply('allow'))
      turn.resolved(ask)
      turn.itemCompleted(command('call_05a', cmd, { status: 'completed', output: '6.0.3\n', exitCode: 0, durationMs: 840 }))
      turn.say('msg_05a', ['TypeScript 6.0.3 is current.'])
      turn.usage(breakdown(9216, 4096, 220, 64))
      turn.completed()
      end(r)
    },
    expected: [
      ev.session(tid(5)),
      ev.modelUsed(),
      ev.toolStart('call_05a', 'shell'),
      ev.ask('network'),
      ev.toolEnd('call_05a', 'shell'),
      ...texts(['TypeScript 6.0.3 is current.']),
      ev.done('TypeScript 6.0.3 is current.', usageOf(breakdown(9216, 4096, 220, 64))),
    ],
  },
  {
    id: 'X05b',
    slug: 'permissions-elicitation',
    route: 'app-server',
    pass: { kind: 'pass', step: 'implement', mode: 'autoedit', planNative: false, prompt: PROMPTS.implement, answers: [{ decision: 'deny' }] },
    note: 'item/permissions/requestApproval denied ({permissions:{}}); an MCP elicitation auto-cancelled; item/tool/requestUserInput refused with a JSON-RPC error. The turn goes on.',
    build(r) {
      const { threadId } = openPass(r, { step: 'implement', mode: 'autoedit', threadId: tid(6), prompt: PROMPTS.implement })
      const turnId = turnIdOf(6)
      const turn = startTurn(r, threadId, turnId, PROMPTS.implement)
      const elicit = r.serverRequest('mcpServer/elicitation/request', {
        serverName: 'docs',
        threadId,
        turnId,
        mode: 'form',
        message: 'Which docs space should I search?',
        requestedSchema: { type: 'object', properties: { space: { type: 'string', title: 'Space' } }, required: ['space'] },
      })
      r.reply(elicit, ELICITATION_CANCEL)
      const question = r.serverRequest('item/tool/requestUserInput', {
        threadId,
        turnId,
        itemId: 'call_06q',
        isBlocking: true,
        questions: [{ id: 'q1', header: 'Version source', question: 'Read the version from package.json?' }],
      })
      r.replyError(question, { code: REFUSED_CODE, message: REFUSED_MESSAGE })
      const perms = r.serverRequest('item/permissions/requestApproval', {
        threadId,
        turnId,
        itemId: 'call_06p',
        startedAtMs: r.ms(1),
        cwd: CWD,
        reason: 'Download the release notes',
        permissions: { network: { enabled: true }, fileSystem: null },
      })
      r.reply(perms, permissionsReply('deny', { network: { enabled: true }, fileSystem: null }))
      turn.resolved(perms)
      turn.say('msg_06a', ['Without network access I used ', 'the version in package.json.'])
      turn.usage(breakdown(10240, 6144, 300, 96))
      turn.completed()
      end(r)
    },
    expected: [
      ev.session(tid(6)),
      ev.modelUsed(),
      ev.auto('cancel', 'unsupported'),
      ev.auto('deny', 'unsupported'),
      ev.ask('network'),
      ...texts(['Without network access I used ', 'the version in package.json.']),
      ev.done('Without network access I used the version in package.json.', usageOf(breakdown(10240, 6144, 300, 96))),
    ],
  },
  {
    id: 'X08b',
    slug: 'stop-pending-ask',
    route: 'app-server',
    pass: {
      kind: 'pass',
      step: 'implement',
      mode: 'autoedit',
      planNative: false,
      prompt: PROMPTS.implement,
      stop: { after: { type: 'ask' }, reason: 'user' },
    },
    note: 'User Stop while an ask is pending: turn/interrupt; the server resolves the request itself (serverRequest/resolved → ask-withdrawn) and the host\'s late `cancel` reply is ignored; the item ends declined, the turn interrupted.',
    build(r) {
      const { threadId } = openPass(r, { step: 'implement', mode: 'autoedit', threadId: tid(18), prompt: PROMPTS.implement })
      const turnId = turnIdOf(18)
      const turn = startTurn(r, threadId, turnId, PROMPTS.implement)
      const cmd = 'npm publish --dry-run'
      turn.itemStarted(command('call_18a', cmd))
      const ask = r.serverRequest('item/commandExecution/requestApproval', {
        threadId,
        turnId,
        itemId: 'call_18a',
        startedAtMs: r.ms(1),
        reason: 'Check the package contents (needs the network)',
        command: cmd,
        cwd: CWD,
        commandActions: [{ type: 'unknown', command: cmd }],
      })
      const stop = r.request('turn/interrupt', { threadId, turnId })
      r.result(stop, {})
      turn.resolved(ask)
      r.reply(ask, approvalReply('cancel'))
      turn.itemCompleted(command('call_18a', cmd, { status: 'declined' }))
      turn.completed('interrupted')
      end(r)
    },
    expected: [
      ev.session(tid(18)),
      ev.modelUsed(),
      ev.toolStart('call_18a', 'shell'),
      ev.ask('shell'),
      ev.withdrawn(),
      ev.toolEnd('call_18a', 'shell', 'declined'),
      ev.error('user_cancelled'),
    ],
    recipe: {
      waitBefore: { 'turn/interrupt': { method: 'item/commandExecution/requestApproval' } },
      // The ask stays pending (no reply, no -32601); the late cancel follows the server's own resolution.
      responders: [
        { when: { method: 'item/commandExecution/requestApproval', id: '$id' }, reply: null, once: true },
        {
          when: { method: 'serverRequest/resolved', params: { requestId: '$rid' } },
          reply: { id: '$rid', result: { decision: 'cancel' } },
          once: true,
        },
      ],
    },
  },
  ...errorScenarios(),
  {
    id: 'X11a',
    slug: 'winsandbox-not-configured-review',
    route: 'app-server',
    pass: { kind: 'pass', step: 'review', mode: 'readonly', planNative: false, prompt: PROMPTS.review, winSandbox: 'notConfigured' },
    note: 'Windows sandbox not set up (readiness notConfigured, as X01b recorded live): the read-only Review still runs, its shell read fails, and it reviews from the diff (the degraded copy).',
    build(r) {
      const { threadId } = openPass(r, { step: 'review', mode: 'readonly', threadId: tid(11), prompt: PROMPTS.review })
      const turn = startTurn(r, threadId, turnIdOf(11), PROMPTS.review)
      turn.run('call_11a', 'Get-Content src/index.ts', {
        actions: [{ type: 'read', command: 'Get-Content src/index.ts', name: 'index.ts', path: 'src/index.ts' }],
        status: 'failed',
        exitCode: 1,
        output: 'windows sandbox: the sandbox is not set up for this user; run `codex sandbox setup`\n',
      })
      turn.say('msg_11a', ['I could not read files here, so this review ', 'is from the diff only.\n[should] cli.ts: handle --version first.'])
      turn.usage(breakdown(8192, 4096, 280, 64))
      turn.completed()
      end(r)
    },
    expected: [
      ev.session(tid(11)),
      ev.modelUsed(),
      ev.toolStart('call_11a', 'shell'),
      ev.toolEnd('call_11a', 'shell', 'failed'),
      ...texts(['I could not read files here, so this review ', 'is from the diff only.\n[should] cli.ts: handle --version first.']),
      ev.done('I could not read files here, so this review is from the diff only.\n[should] cli.ts: handle --version first.', usageOf(breakdown(8192, 4096, 280, 64))),
    ],
  },
  {
    id: 'X11b',
    slug: 'winsandbox-setup-unelevated',
    route: 'app-server',
    pass: { kind: 'vendorSetup', call: 'windowsSandbox/setupStart', params: { mode: 'unelevated' }, ok: true },
    note: 'vendor_setup (user click only): windowsSandbox/setupStart {mode:unelevated} → {started:true} → windowsSandbox/setupCompleted success. The re-probe that follows is a new process (X01b shape, status ready).',
    build(r) {
      const init = r.request('initialize', initializeParams(false))
      r.result(init, initResult())
      r.notify('initialized')
      const setup = r.request('windowsSandbox/setupStart', { mode: 'unelevated' })
      r.result(setup, { started: true })
      r.note('windowsSandbox/setupCompleted', { mode: 'unelevated', success: true, error: null })
      end(r)
    },
    expected: [],
    recipe: { finalWait: { method: 'windowsSandbox/setupCompleted' } },
  },
  {
    id: 'X11c',
    slug: 'winsandbox-elevated-needed',
    route: 'app-server',
    pass: { kind: 'vendorSetup', call: 'windowsSandbox/setupStart', params: { mode: 'unelevated' }, ok: false },
    note: 'The unelevated setup fails: the user is offered the elevated `codex sandbox setup --elevated --current-user` (shell_copy). Dim Factory never elevates.',
    build(r) {
      const init = r.request('initialize', initializeParams(false))
      r.result(init, initResult())
      r.notify('initialized')
      const setup = r.request('windowsSandbox/setupStart', { mode: 'unelevated' })
      r.result(setup, { started: true })
      r.note('windowsSandbox/setupCompleted', {
        mode: 'unelevated',
        success: false,
        error: 'setup refresh had errors: CreateRestrictedToken failed: Access is denied. (os error 5)',
      })
      end(r)
    },
    expected: [],
    recipe: { finalWait: { method: 'windowsSandbox/setupCompleted' } },
  },
  ...planScenarios(),
  {
    id: 'X13',
    slug: 'local-provider',
    route: 'app-server',
    pass: {
      kind: 'pass',
      step: 'implement',
      mode: 'autoedit',
      planNative: false,
      prompt: PROMPTS.implement,
      local: LOCAL_PRESET,
    },
    note: 'Local preset: thread/start modelProvider dim_factory_local with the provider table in config (wire_api responses, a loopback base_url, never --oss). Fixture-gated: the live recording decides inline table vs dotted keys.',
    build(r) {
      const { threadId } = openPass(r, { step: 'implement', mode: 'autoedit', threadId: tid(13), prompt: PROMPTS.implement, local: LOCAL_PRESET })
      const turn = startTurn(r, threadId, turnIdOf(13), PROMPTS.implement)
      turn.say('msg_13a', ['Here is the change:', ' add a --version check to src/cli.ts.'])
      turn.usage(breakdown(3072, 0, 180, 0))
      turn.completed()
      end(r)
    },
    expected: [
      ev.session(tid(13)),
      ...texts(['Here is the change:', ' add a --version check to src/cli.ts.']),
      ev.done('Here is the change: add a --version check to src/cli.ts.', usageOf(breakdown(3072, 0, 180, 0))),
    ],
  },
  {
    id: 'X14',
    slug: 'resume-id-mismatch',
    route: 'app-server',
    pass: { kind: 'pass', step: 'fix', mode: 'autoedit', planNative: false, prompt: PROMPTS.fix, resume: { sessionId: tid(14) } },
    note: 'thread/resume answers another thread than the one asked for: the echoed id must match, so the pass fails resume_failed (retried fresh by the engine) and no turn starts.',
    build(r) {
      openPass(r, { step: 'fix', mode: 'autoedit', resumeId: tid(14), echoId: tid(41), prompt: PROMPTS.fix })
      end(r)
    },
    expected: [ev.error('resume_failed')],
  },
  {
    id: 'X15',
    slug: 'resume-unknown-thread',
    route: 'app-server',
    pass: { kind: 'pass', step: 'fix', mode: 'autoedit', planNative: false, prompt: PROMPTS.fix, resume: { sessionId: tid(15) } },
    note: 'thread/resume of a thread whose rollout is gone: a JSON-RPC error → resume_failed.',
    build(r) {
      openPass(r, {
        step: 'fix',
        mode: 'autoedit',
        resumeId: tid(15),
        prompt: PROMPTS.fix,
        resumeError: { code: -32600, message: `no rollout found for thread id ${tid(15)}` },
      })
      end(r)
    },
    expected: [ev.error('resume_failed')],
  },
  {
    id: 'X16',
    slug: 'notifications-before-responses',
    route: 'app-server',
    pass: { kind: 'pass', step: 'critic', mode: 'readonly', planNative: false, prompt: PROMPTS.review },
    note: 'Ordering edge: thread/started and turn/started arrive before their requests\' responses; the session comes from the response, once, before done.',
    build(r) {
      const { threadId } = openPass(r, { step: 'critic', mode: 'readonly', threadId: tid(16), prompt: PROMPTS.review, threadStartedFirst: true })
      const turn = startTurn(r, threadId, turnIdOf(16), PROMPTS.review, {}, { turnStartedFirst: true })
      turn.say('msg_16a', ['NO FINDINGS'])
      turn.usage(breakdown(7168, 4096, 12, 0))
      turn.completed()
      end(r)
    },
    expected: [ev.session(tid(16)), ev.modelUsed(), ...texts(['NO FINDINGS']), ev.done('NO FINDINGS', usageOf(breakdown(7168, 4096, 12, 0)))],
  },
  researchScenario(),
  ...execScenarios(),
]

/**
 * X19: Research (read-only, ephemeral, `web_search: live`, the research outputSchema on turn/start, as X17 sends its
 * own): one web search, then the cited JSON answer as the final message. Never recorded live.
 */
function researchScenario() {
  const url = 'https://clig.dev/'
  const answer = JSON.stringify({
    summary: ['A --version flag is expected of every CLI.'],
    features: [{ feature: 'Print the version with --version', priority: 'must', sources: [url] }],
    standards: [{ standard: 'GNU --version output', why: 'Scripts parse it', sources: [url] }],
    options: [
      {
        topic: 'Where the version comes from',
        options: ['package.json', 'a constant'],
        recommendation: 'package.json',
        rationale: 'One source of truth',
        sources: ['repo:package.json'],
      },
    ],
    risks: [{ risk: 'A bundled build can print a stale version', sources: [url] }],
    questions: [],
    sources: [{ url, title: 'Command Line Interface Guidelines' }],
  })
  const cut = Math.ceil(answer.length / 2)
  const deltas = [answer.slice(0, cut), answer.slice(cut)]
  const total = breakdown(18432, 12288, 640, 256)
  const query = 'command line interface guidelines --version flag'
  return {
    id: 'X19',
    slug: 'research-web-search',
    route: 'app-server',
    pass: { kind: 'pass', step: 'research', mode: 'readonly', planNative: false, prompt: PROMPTS.research, web: true },
    note: 'Research: read-only, ephemeral, web_search live and the research outputSchema; one web search, then the cited JSON answer. Synthesized: Research was never recorded live.',
    build(r) {
      const { threadId } = openPass(r, { step: 'research', mode: 'readonly', threadId: tid(19), prompt: PROMPTS.research, web: true })
      const turn = startTurn(r, threadId, turnIdOf(19), PROMPTS.research, { outputSchema: RESEARCH_SCHEMA })
      turn.user(PROMPTS.research)
      turn.itemStarted({ type: 'webSearch', id: 'ws_19a', query: '', action: null, results: null })
      turn.itemCompleted({
        type: 'webSearch',
        id: 'ws_19a',
        query,
        action: { type: 'search', query: null, queries: [query] },
        results: [
          {
            type: 'text_result',
            domain: 'clig.dev',
            ref_id: 'turn0search0',
            snippet: 'Print the version with --version.',
            thumbnail_url: 'https://clig.dev/favicon.png',
            title: 'Command Line Interface Guidelines',
            url,
          },
        ],
      })
      turn.say('msg_19a', deltas)
      turn.usage(total)
      turn.completed()
      end(r)
    },
    expected: [
      ev.session(tid(19)),
      ev.modelUsed(),
      ev.toolStart('ws_19a', 'web_search'),
      ev.toolEnd('ws_19a', 'web_search'),
      ...texts(deltas),
      // The turn's outputSchema answer: the adapter reports the final message's JSON as the structured output.
      ev.meta('structuredOutput', JSON.parse(answer)),
      ev.done(answer, usageOf(total)),
    ],
  }
}

function approvalScenarios() {
  const cmd = 'npm test'
  const base = (n, slug, decision, o) => ({
    id: `X03${n}`,
    slug,
    route: 'app-server',
    pass: { kind: 'pass', step: 'implement', mode: 'autoedit', planNative: false, prompt: PROMPTS.implement, answers: [{ decision }] },
    note: o.note,
    build(r) {
      const threadId = tid(30 + n.charCodeAt(0) - 96)
      openPass(r, { step: 'implement', mode: 'autoedit', threadId, prompt: PROMPTS.implement })
      const turnId = turnIdOf(30 + n.charCodeAt(0) - 96)
      const turn = startTurn(r, threadId, turnId, PROMPTS.implement)
      turn.itemStarted(command('call_03a', cmd))
      const ask = r.serverRequest('item/commandExecution/requestApproval', {
        threadId,
        turnId,
        itemId: 'call_03a',
        startedAtMs: r.ms(1),
        reason: 'Run the test suite (writes outside the workspace cache)',
        command: cmd,
        cwd: CWD,
        commandActions: [{ type: 'unknown', command: cmd }],
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      })
      r.reply(ask, approvalReply(decision))
      turn.resolved(ask)
      o.after(turn, r, threadId, turnId)
      turn.usage(o.total)
      turn.completed()
      end(r)
    },
    expected: (threadId) => o.expected(threadId),
  })
  const list = [
    base('c', 'command-approval-allow-session', 'allow-session', {
      note: 'allow-session → acceptForSession: Codex does not ask again for the same command in this session; the adapter records the exact rule.',
      total: breakdown(14336, 10240, 330, 96),
      after(turn) {
        turn.itemCompleted(command('call_03a', cmd, { status: 'completed', output: '# pass 2\n', exitCode: 0, durationMs: 1300 }))
        turn.run('call_03c', cmd, { output: '# pass 2\n' })
        turn.say('msg_03c', ['Tests pass twice.'])
      },
      expected: (t) => [
        ev.session(t),
        ev.modelUsed(),
        ev.toolStart('call_03a', 'shell'),
        ev.ask('shell'),
        ev.allowRule('shell', 'shell'),
        ev.toolEnd('call_03a', 'shell'),
        ev.toolStart('call_03c', 'shell'),
        ev.toolEnd('call_03c', 'shell'),
        ...texts(['Tests pass twice.']),
        ev.done('Tests pass twice.', usageOf(breakdown(14336, 10240, 330, 96))),
      ],
    }),
  ]
  return list.map((s) => ({ ...s, expected: s.expected(tid(30 + s.id.charCodeAt(3) - 96)) }))
}

function errorScenarios() {
  const cases = [
    ['a', 'error-rate-limit', 'rateLimitExceeded', 'Rate limit reached for gpt-5.6-terra on tokens per min (TPM). Please try again in 20s.', 'rate_limited'],
    ['b', 'error-usage-limit', 'usageLimitExceeded', "You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 13 minutes.", 'quota_exceeded'],
    ['c', 'error-unauthorized', 'unauthorized', 'Your access token could not be refreshed. Please log out and sign in again.', 'auth_expired'],
    ['d', 'error-context-window', 'contextWindowExceeded', "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.", 'context_exceeded'],
    ['e', 'error-server-overloaded', 'serverOverloaded', 'The model is currently overloaded. Please try again later.', 'vendor_internal'],
    ['f', 'error-sandbox', 'sandboxError', 'sandbox error: CreateRestrictedToken failed: Access is denied. (os error 5)', 'sandbox_unavailable'],
    ['g', 'error-http-connection', { httpConnectionFailed: { httpStatusCode: 502 } }, 'error sending request for url (https://chatgpt.com/backend-api/codex/responses)', 'network'],
  ]
  return cases.map(([n, slug, info, message, category], i) => ({
    id: `X09${n}`,
    slug,
    route: 'app-server',
    pass: { kind: 'pass', step: 'implement', mode: 'autoedit', planNative: false, prompt: PROMPTS.implement },
    note: `turn/completed failed with codexErrorInfo ${JSON.stringify(info)} → ${category}.${n === 'e' ? ' Two error{willRetry:true} notifications first are liveness only.' : ''}`,
    build(r) {
      const threadId = tid(90 + i)
      openPass(r, { step: 'implement', mode: 'autoedit', threadId, prompt: PROMPTS.implement })
      const turn = startTurn(r, threadId, turnIdOf(90 + i), PROMPTS.implement)
      if (n === 'e') {
        turn.errorNote('Reconnecting... 1/5 (stream disconnected before completion: The model is overloaded.)', null, true)
        turn.errorNote('Reconnecting... 2/5 (stream disconnected before completion: The model is overloaded.)', null, true)
      }
      const error = { message, codexErrorInfo: info, additionalDetails: null }
      turn.errorNote(message, info, false)
      turn.completed('failed', error)
      end(r)
    },
    expected: [ev.session(tid(90 + i)), ev.modelUsed(), ev.error(category)],
  }))
}

function planScenarios() {
  const plan = '## Plan\n1. Read the version from package.json in src/cli.ts.\n2. Print it for --version and exit 0.\n3. Add a test.'
  const common = { kind: 'pass', step: 'plan', mode: 'readonly', prompt: PROMPTS.plan }
  return [
    {
      id: 'X12b',
      slug: 'plan-proposed-block',
      route: 'app-server',
      pass: { ...common, planNative: true },
      note: 'Native Plan without a plan item: the plan is the <proposed_plan> block of the final message.',
      build(r) {
        const { threadId, model } = openPass(r, { step: 'plan', mode: 'readonly', planNative: true, threadId: tid(22), prompt: PROMPTS.plan })
        const turn = startTurn(r, threadId, turnIdOf(22), PROMPTS.plan, { collaborationMode: planCollaboration(model) })
        turn.say('msg_22a', ['Here is my plan.\n<proposed_plan>\n', plan, '\n</proposed_plan>'])
        turn.usage(breakdown(12288, 8192, 410, 200))
        turn.completed()
        end(r)
      },
      expected: [
        ev.session(tid(22)),
      ev.modelUsed(),
        ...texts(['Here is my plan.\n<proposed_plan>\n', plan, '\n</proposed_plan>']),
        ev.plan(plan, 'proposed_plan'),
        ev.meta(META_PLAN_SOURCE, { source: 'proposed_plan' }),
        ev.done(plan, usageOf(breakdown(12288, 8192, 410, 200))),
      ],
    },
    {
      id: 'X12c',
      slug: 'plan-collaboration-rejected',
      route: 'app-server',
      pass: { ...common, planNative: true },
      note: 'turn/start refuses collaborationMode (-32602) before any model call: the same thread runs the Plan emulated (planFallback meta, no retry budget); the final message is the plan.',
      build(r) {
        const { threadId, model } = openPass(r, { step: 'plan', mode: 'readonly', planNative: true, threadId: tid(23), prompt: PROMPTS.plan })
        const refused = r.request('turn/start', turnStartParams({ threadId, prompt: PROMPTS.plan, collaborationMode: planCollaboration(model) }))
        r.error(refused, { code: -32602, message: 'Invalid params: collaborationMode is not supported by this server' })
        const turn = startTurn(r, threadId, turnIdOf(23), PROMPTS.plan)
        turn.say('msg_23a', [plan])
        turn.usage(breakdown(12288, 8192, 380, 160))
        turn.completed()
        end(r)
      },
      expected: [
        ev.session(tid(23)),
      ev.modelUsed(),
        ev.meta(META_PLAN_FALLBACK),
        ...texts([plan]),
        ev.done(plan, usageOf(breakdown(12288, 8192, 380, 160))),
      ],
    },
  ]
}

// ---- exec route (`codex exec --json`): the no-relay fallback ------------------------------------------------------

function execScenarios() {
  const OUT = '<CWD>/.dimfactory/last-message.txt'
  const argvOf = (o) => ['codex.exe', ...execArgv({ cwd: CWD, outFile: OUT, ...o })]
  const line = (r, v) => r.push('out', v)
  const usage = (b) => ({
    input_tokens: b.inputTokens,
    cached_input_tokens: b.cachedInputTokens,
    output_tokens: b.outputTokens,
    reasoning_output_tokens: b.reasoningOutputTokens,
  })
  const prompt = (r, text) => {
    r.push('in', text)
    r.eof()
  }
  const finalFile = (r, text) => r.frames.push({ t: r.frames.length * 5, dir: 'file', argvPath: '-o', content: `${text}\n` })
  return [
    {
      id: 'E03',
      slug: 'escalation-auto-denied',
      route: 'exec',
      argv: argvOf({ step: 'implement', mode: 'autoedit' }),
      pass: { kind: 'pass', route: 'exec', step: 'implement', mode: 'autoedit', planNative: false, prompt: PROMPTS.implement },
      note: 'No relay on exec: a command needing the network is declined without an ask (the degraded autoedit copy).',
      build(r) {
        prompt(r, PROMPTS.implement)
        line(r, { type: 'thread.started', thread_id: tid(53) })
        line(r, { type: 'turn.started' })
        line(r, { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'npm view typescript version', aggregated_output: '', exit_code: null, status: 'in_progress' } })
        line(r, { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'npm view typescript version', aggregated_output: '', exit_code: null, status: 'declined' } })
        line(r, { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'The registry lookup was not allowed; I kept the pinned version.' } })
        line(r, { type: 'turn.completed', usage: usage(breakdown(9216, 4096, 200, 64)) })
        finalFile(r, 'The registry lookup was not allowed; I kept the pinned version.')
        r.exit(0)
      },
      expected: [
        ev.session(tid(53)),
        ev.toolStart('item_0', 'shell'),
        ev.toolEnd('item_0', 'shell', 'declined'),
        ev.text('The registry lookup was not allowed; I kept the pinned version.'),
        ev.done('The registry lookup was not allowed; I kept the pinned version.', usageOf(breakdown(9216, 4096, 200, 64))),
      ],
    },
    {
      id: 'E05',
      slug: 'turn-failed',
      route: 'exec',
      argv: argvOf({ step: 'implement', mode: 'autoedit' }),
      pass: { kind: 'pass', route: 'exec', step: 'implement', mode: 'autoedit', planNative: false, prompt: PROMPTS.implement },
      note: 'A transient {"type":"error"} (a retry; not terminal by itself), then turn.failed: exit 1, classified from the message (quota_exceeded).',
      build(r) {
        prompt(r, PROMPTS.implement)
        line(r, { type: 'thread.started', thread_id: tid(55) })
        line(r, { type: 'turn.started' })
        line(r, { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' })
        line(r, { type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 13 minutes." } })
        r.exit(1)
      },
      expected: [ev.session(tid(55)), ev.error('quota_exceeded')],
    },
    {
      id: 'E06',
      slug: 'killed-mid-command',
      route: 'exec',
      argv: argvOf({ step: 'implement', mode: 'autoedit' }),
      pass: {
        kind: 'pass',
        route: 'exec',
        step: 'implement',
        mode: 'autoedit',
        planNative: false,
        prompt: PROMPTS.implement,
        stop: { after: { type: 'tool', phase: 'start' }, reason: 'user' },
      },
      note: 'User Stop on exec (no turn/interrupt there): the tree is killed mid-command, so no turn.* line ever comes. {"dir":"hold"} keeps the fake alive until the kill.',
      build(r) {
        prompt(r, PROMPTS.implement)
        line(r, { type: 'thread.started', thread_id: tid(56) })
        line(r, { type: 'turn.started' })
        line(r, { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'npm test -- --watch', aggregated_output: '', exit_code: null, status: 'in_progress' } })
        r.frames.push({ t: r.frames.length * 5, dir: 'hold' })
        r.exit(1, { killed: 'tree' })
      },
      expected: [ev.session(tid(56)), ev.toolStart('item_0', 'shell'), ev.toolEnd('item_0', 'shell', 'declined'), ev.error('user_cancelled')],
      recipe: { execTail: [{ $close: true }, { $wait: { type: 'item.started' }, $timeoutMs: 120000 }, { $kill: true }] },
    },
    {
      id: 'E07',
      slug: 'todo-web-search',
      route: 'exec',
      argv: argvOf({ step: 'catalog', mode: 'readonly' }),
      pass: { kind: 'pass', route: 'exec', step: 'catalog', mode: 'readonly', planNative: false, prompt: CATALOG_PROMPT },
      note: 'todo_list started/updated/completed (the todo tool) and a web_search item (-c web_search="live"; the catalog refresh on exec).',
      build(r) {
        prompt(r, CATALOG_PROMPT)
        line(r, { type: 'thread.started', thread_id: tid(57) })
        line(r, { type: 'turn.started' })
        line(r, { type: 'item.started', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'Find the pricing page', completed: false }, { text: 'Read the prices', completed: false }] } })
        line(r, { type: 'item.started', item: { id: 'item_1', type: 'web_search', query: 'OpenAI API pricing', action: { type: 'search', query: 'OpenAI API pricing' } } })
        line(r, { type: 'item.completed', item: { id: 'item_1', type: 'web_search', query: 'OpenAI API pricing', action: { type: 'search', query: 'OpenAI API pricing' } } })
        line(r, { type: 'item.updated', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'Find the pricing page', completed: true }, { text: 'Read the prices', completed: false }] } })
        line(r, { type: 'item.completed', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'Find the pricing page', completed: true }, { text: 'Read the prices', completed: true }] } })
        line(r, { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: '{"generatedAt":"2026-10-09T23:30:00Z","entries":[],"newModels":[],"unverifiable":[]}' } })
        line(r, { type: 'turn.completed', usage: usage(breakdown(12288, 4096, 400, 200)) })
        finalFile(r, '{"generatedAt":"2026-10-09T23:30:00Z","entries":[],"newModels":[],"unverifiable":[]}')
        r.exit(0)
      },
      expected: [
        ev.session(tid(57)),
        ev.todo(),
        ev.toolStart('item_1', 'web_search'),
        ev.toolEnd('item_1', 'web_search'),
        ev.todo(),
        ev.todo(),
        ev.text('{"generatedAt":"2026-10-09T23:30:00Z","entries":[],"newModels":[],"unverifiable":[]}'),
        ev.done('{"generatedAt":"2026-10-09T23:30:00Z","entries":[],"newModels":[],"unverifiable":[]}', usageOf(breakdown(12288, 4096, 400, 200))),
      ],
    },
    {
      id: 'E08',
      slug: 'resume-unknown-thread',
      route: 'exec',
      argv: argvOf({ step: 'fix', mode: 'autoedit', resumeId: tid(58) }),
      pass: { kind: 'pass', route: 'exec', step: 'fix', mode: 'autoedit', planNative: false, prompt: PROMPTS.fix.split('\n')[0], resume: { sessionId: tid(58) } },
      note: '`exec resume <UUID>` of an unknown thread: an error on stderr and exit 1, no JSONL → resume_failed.',
      build(r) {
        prompt(r, PROMPTS.fix.split('\n')[0])
        r.stderr(`Error: no rollout found for thread id ${tid(58)}`)
        r.exit(1)
      },
      expected: [ev.error('resume_failed')],
    },
  ]
}

// ---- writing ------------------------------------------------------------------------------------------------------

function headerOf(s) {
  return {
    kind: 'header',
    schemaVersion: 1,
    vendor: 'codex',
    route: s.route,
    scenario: `${s.id}-${s.slug}`,
    cliVersion: CLI_VERSION,
    ...(s.route === 'app-server' ? { protocol: 'jsonrpc' } : {}),
    os: 'any',
    arch: 'any',
    synthesized: true,
    synthesizedFrom: SOURCES,
    note: `${s.note} Generator: tests/fixtures/codex/recipes/synthesize.mjs. Re-record live: tests/fixtures/codex/README.md.`,
    argv: s.argv ?? ['codex.exe', 'app-server', '--listen', 'stdio://'],
    envKeys: ['CODEX_HOME'],
    envDrop: ['^OPENAI_', '^CODEX_'],
    pass: s.pass,
    hostVersion: '0.1.0',
  }
}

function recordingText(s) {
  const r = new Rec()
  s.build(r)
  return `${[headerOf(s), ...r.frames].map((x) => JSON.stringify(x)).join('\n')}\n`
}

/** The live re-record recipe: host frames with $wait pacing and captured ids, responders for server requests. */
function recipeOf(s, text) {
  const frames = text
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => JSON.parse(l))
  const stdin = []
  const responders = []
  if (s.route === 'exec') {
    for (const f of frames) if (f.dir === 'in') stdin.push(f.line)
    // exec reads the prompt to EOF; a recipe that acts afterwards closes stdin itself first.
    for (const d of s.recipe?.execTail ?? []) stdin.push(JSON.stringify(d))
    return { stdin, responders }
  }
  const outs = frames.filter((f) => f.dir === 'out').map((f) => JSON.parse(f.line))
  const threadIds = new Set(outs.flatMap((m) => (m.result?.thread?.id ? [m.result.thread.id] : [])))
  const resumeIds = s.pass.resume ? [s.pass.resume.sessionId] : []
  const turnIds = new Set(outs.flatMap((m) => (m.result?.turn?.id ? [m.result.turn.id] : [])))
  const vars = (value) => {
    let line = JSON.stringify(value)
    for (const id of [...threadIds, ...resumeIds]) line = line.split(JSON.stringify(id)).join('"$threadId"')
    for (const id of turnIds) line = line.split(JSON.stringify(id)).join('"$turnId"')
    // The sandbox folder: the recorder binds $cwd to its --cwd.
    return line.split('"<CWD>"').join('"$cwd"').split('<CWD>').join('${cwd}')
  }
  const answered = new Set()
  for (const f of frames) {
    if (f.dir !== 'in') continue
    const msg = JSON.parse(f.line)
    if (typeof msg.method === 'string') {
      const before = s.recipe?.waitBefore?.[msg.method]
      if (before) stdin.push(JSON.stringify({ $wait: before, $timeoutMs: 120000 }))
      stdin.push(vars(msg))
      if (Object.hasOwn(msg, 'id')) {
        // Capture ids from successful answers only (X12c's refused turn/start, X15's refused resume have none).
        const answer = outs.find((m) => m.id === msg.id && typeof m.method !== 'string')
        const capture =
          answer?.result === undefined
            ? {}
            : msg.method === 'thread/start' || msg.method === 'thread/resume'
              ? { $capture: { threadId: 'result.thread.id' } }
              : msg.method === 'turn/start'
                ? { $capture: { turnId: 'result.turn.id' } }
                : {}
        stdin.push(JSON.stringify({ $wait: { id: msg.id }, $timeoutMs: 120000, ...capture }))
      }
      continue
    }
    // A reply to a server request: one responder rule per request method (with the recorded answer).
    const request = outs.find((m) => typeof m.method === 'string' && m.id === msg.id)
    if (request === undefined || answered.has(`${request.method}:${msg.id}`)) continue
    answered.add(`${request.method}:${msg.id}`)
    const reply = Object.hasOwn(msg, 'error') ? { id: '$id', error: msg.error } : { id: '$id', result: msg.result }
    responders.push({ when: { method: request.method, id: '$id' }, reply, once: true })
  }
  const last = s.recipe?.finalWait ?? (s.pass.kind === 'pass' && !['X14', 'X15'].includes(s.id) ? { method: 'turn/completed' } : null)
  if (last) stdin.push(JSON.stringify({ $wait: last, $timeoutMs: 600000 }))
  return { stdin, responders: s.recipe?.responders ?? responders }
}

/**
 * expected.events.json, like Claude's: the normalized events and the adapter signals the scenario is about (every
 * signal but liveness), each partial (only the fields the contract fixes). Events are in order among events and
 * signals among signals; README "expected.events.json" says how the suites compare them.
 */
function expectedText(s) {
  return `${JSON.stringify(s.expected, null, 2)}\n`
}

/** Every file the generator owns: absolute path → content. */
export function synthesize() {
  const files = new Map()
  for (const s of SCENARIOS) {
    const name = `${s.id}-${s.slug}`
    const dir = join(FIXTURES, s.route, name)
    const text = recordingText(s)
    files.set(join(dir, 'recording.jsonl'), text)
    files.set(join(dir, 'expected.events.json'), expectedText(s))
    const recipe = recipeOf(s, text)
    files.set(join(RECIPES, name, 'stdin.jsonl'), `${recipe.stdin.join('\n')}\n`)
    if (recipe.responders.length > 0)
      files.set(join(RECIPES, name, 'responders.json'), `${JSON.stringify(recipe.responders, null, 2)}\n`)
    files.set(join(RECIPES, name, 'pass.json'), `${JSON.stringify(s.pass, null, 2)}\n`)
    files.set(join(RECIPES, name, 'record.txt'), recordCommand(s, recipe.responders.length > 0))
  }
  return files
}

/** Live re-record notes per scenario (README "Re-recording"): what it needs beyond the common command. */
const LIVE_NOTES = {
  X04b: 'Live X04 wrote its outside file with a shell command (a command approval): keep synthesized until a fileChange approval is observed.',
  X14: 'Cannot be provoked (the server never answers another thread): stays synthesized.',
  X15: 'threadId = a never-used UUIDv7.',
  X09a: 'Only when the account really hits the limit: keep synthesized until observed.',
  X09b: 'Only when the account really hits the limit: keep synthesized until observed.',
  X09c: 'Needs an expired login in the fixture profile.',
  X09d: 'Needs a prompt over the context window (a large diff).',
  X09e: 'Only when the service is overloaded: keep synthesized until observed.',
  X09f: 'Only on a Windows sandbox failure (the sandbox procedure).',
  X09g: 'Block chatgpt.com (e.g. a bad proxy) for the run.',
  X11a: 'The Codex Windows sandbox procedure, step 1 (README).',
  X11b: 'The Codex Windows sandbox procedure, step 2: runs windowsSandbox/setupStart (a user decision).',
  X11c: 'The Codex Windows sandbox procedure, step 3 only if X11b fails.',
  X12b: 'Live X12a gave a plan item: keep synthesized until a <proposed_plan> block without one is observed.',
  X12c: 'Only a server that refuses collaborationMode: keep synthesized until observed (live X12a accepted it).',
  X13: 'Needs Ollama >= 0.13.4 serving qwen3-coder:30b on 127.0.0.1:11434 (the user pulls the model).',
  E08: 'The argv resume UUID must be a never-used UUIDv7.',
}

/** recipes/<ID>-<slug>/record.txt: the command that re-records this scenario live (placeholders in <>). */
function recordCommand(s, hasResponders) {
  const name = `${s.id}-${s.slug}`
  const r = `tests/fixtures/codex/recipes/${name}`
  const common = [
    '--bin "<codex.exe>" --codex-home "<fixture CODEX_HOME>" --cwd "<sandbox>"',
    `--out tests/fixtures/codex/${s.route}/${name} --id ${s.id} --slug ${s.slug} --cli-version <x.y.z> --timing off`,
    `--stdin ${r}/stdin.jsonl --pass-file ${r}/pass.json${hasResponders ? ` --responders ${r}/responders.json` : ''}`,
  ]
  const resume = s.pass.resume !== undefined && s.route === 'app-server' ? ' --var threadId=<thread id>' : ''
  const head =
    s.route === 'app-server'
      ? 'node scripts/record-fixture.mjs --codex-app-server'
      : 'node scripts/record-fixture.mjs --vendor codex --route exec --output-file -o'
  const tail =
    s.route === 'exec'
      ? ` -- ${s.argv
          .slice(1)
          .map((a) => (a.endsWith('last-message.txt') ? '"<a temp file>"' : a.includes('<CWD>') ? '"<sandbox>"' : /[\s"]/.test(a) ? JSON.stringify(a) : a))
          .join(' ')}`
      : ''
  const lines = [
    `# ${name}: ${s.note}`,
    ...(LIVE_NOTES[s.id] ? [`# ${LIVE_NOTES[s.id]}`] : []),
    '# A fresh git-init copy of tests/fixtures/sandboxes/ts-small as <sandbox>; never your own ~/.codex.',
    `${head} ${common.join(' ')}${resume}${tail}`,
  ]
  return `${lines.join('\n')}\n`
}

/** Generated files whose committed content differs (LF-normalized), or that are missing. */
export function outOfDate(files = synthesize()) {
  const stale = []
  for (const [path, content] of files) {
    if (!existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== content) stale.push(path)
  }
  return stale
}

export { SCENARIOS }

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
    process.stdout.write(`synthesized ${SCENARIOS.length} Codex fixtures (${files.size} files)\n`)
  }
}
