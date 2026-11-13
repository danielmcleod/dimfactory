// Helpers for the Grok and Muse E2E specs (Grok on the ACP base, Muse on exec,
// the mode rows "Grok ACP" and "Muse exec"): a fake Grok and a fake Muse the app finds at
// `vendors.grok.path` / `vendors.muse.path` (the fake CLI's npm-style .cmd shim on win32, its shebang copy on POSIX),
// through the real resolver and spawn path. Both CLIs are native binaries in real life; the shims stand in for them.
//
// The fake Grok answers `--version` as Grok Build prints it and `agent --help` with the agent options the probe looks
// for (`stdio`, `--no-leader`); every `grok agent --no-leader stdio` runs one branching JSON-RPC 2.0 script, because the
// probe's handshake and the passes share that argv and come in any order:
//   initialize → its result, then by the next request
//   - session/new in Dim Factory's probe folder (`…/probe-cwd`; Test only) → the probe's session (or authRequired);
//   - session/new with `_meta.yoloMode: false` (a pass that asks: read-only) → the state's `readOnly` script;
//   - session/new with `_meta.yoloMode: true` (full mode, Auto only) → the state's `full` script.
// Its home is a private GROK_HOME under the test's root (never ~/.grok): signed in, it holds an empty stand-in
// `auth.json` (Dim Factory checks that the file exists and never reads it).
//
// The fake Muse answers `--version`, `exec --help` (the flags a pass needs) and `muse schema …` (a schema the probe
// hashes); every `muse exec --json --prompt-file <file> … --disable-approval|--yolo` prints exec JSON records (the
// synthesized pin's shapes, tests/fixtures/muse) and exits. Muse closes nothing on its own: Dim Factory closes stdin
// at once and reads the prompt from nowhere but the file it wrote under runs/<id>/prompts.
// A test changes a fake's state between steps (`set`); a process already running keeps the script it started with.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { buildFakeCli } from '../../scripts/build-fake-cli.mjs'
import { readFakeLog } from '../fake-cli/harness.ts'
import type { FakeLogEntry } from '../fake-cli/harness.ts'

export type Op = Record<string, unknown>

/** The fake `grok` / `muse` a user install would expose: the .cmd shim on win32, the shebang copy on POSIX. */
export async function fakeGrokPath(): Promise<string> {
  const build = await buildFakeCli()
  const p = process.platform === 'win32' ? build.launchers.cmd?.grok : build.launchers.sh?.grok
  if (p === undefined) throw new Error('fake grok launcher missing')
  return p
}

export async function fakeMusePath(): Promise<string> {
  const build = await buildFakeCli()
  const p = process.platform === 'win32' ? build.launchers.cmd?.muse : build.launchers.sh?.muse
  if (p === undefined) throw new Error('fake muse launcher missing')
  return p
}

// ---- Grok -----------------------------------------------------------------------------------------------------------

export const GROK_VERSION = '1.0.50'

/** `grok agent --help` as clap prints it (Grok Build user guide 15: the agent options and the transports). */
const GROK_AGENT_HELP = [
  'Run Grok as an ACP agent',
  '',
  'Usage: grok agent [OPTIONS] <COMMAND>',
  '',
  'Commands:',
  '  stdio     Speak ACP over stdin and stdout',
  '  serve     Serve ACP over a WebSocket',
  '  headless  Connect to a relay',
  '  help      Print this message or the help of the given subcommand(s)',
  '',
  'Options:',
  '  -m, --model <MODEL>           Model ID',
  '      --always-approve          Run without interactive tool-permission prompts [aliases: --yolo]',
  '      --reauth                  Authenticate before the agent starts',
  '      --agent-profile <PATH>    Load an agent profile from a file',
  '      --leader                  Connect to a shared leader process',
  '      --no-leader               Force a local agent',
  '  -h, --help                    Print help',
]

/** Grok Build's initialize answer (GR01, synthesized from grok-build's acp_agent.rs). */
const GROK_INITIALIZE_RESULT = {
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
  _meta: { grokShell: true, defaultAuthMethodId: 'cached_token', agentVersion: GROK_VERSION },
}

const GROK_MODELS = {
  availableModels: [
    { modelId: 'grok-4.6', name: 'Grok 4.6' },
    { modelId: 'grok-4.5', name: 'Grok 4.5' },
  ],
  currentModelId: 'grok-4.6',
}

/** A pass's session id: one per Grok process (the fake's pid in it), as a real session/new mints a new one. */
export const GROK_SESSION = '0199d2a4-7c1e-7a3b-9f20-${FAKE_PID}'

const sessionResult = (sessionId: string): Record<string, unknown> => ({
  sessionId,
  models: GROK_MODELS,
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'grok-4.6',
      options: GROK_MODELS.availableModels.map((m) => ({ value: m.modelId, name: m.name })),
    },
  ],
})

const grokUpdate = (u: Record<string, unknown>): Op => ({
  op: 'rpcNotify',
  method: 'session/update',
  params: { sessionId: GROK_SESSION, update: u },
})

export const grokChunk = (text: string): Op =>
  grokUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

/**
 * The choices Grok's permission prompt offers (user guide 22; GR04's synthesized option ids): a command can be always
 * allowed for the project or turn the whole session to always-approve; an edit can allow every later edit. Dim Factory
 * never chooses one of the widening ones (its forbidden option names).
 */
export const GROK_SHELL_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always_allow', name: 'Always allow `npm test` in this project', kind: 'allow_always' },
  { optionId: 'always_approve', name: 'Enable always-approve mode', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'never_allow', name: 'Never allow `npm test` in this project', kind: 'reject_always' },
]
export const GROK_EDIT_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_all_edits', name: 'Allow all edits this session', kind: 'allow_always' },
  { optionId: 'always_approve', name: 'Enable always-approve mode', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
]

export interface GrokAsk {
  toolCallId: string
  kind: 'execute' | 'edit' | 'fetch' | 'delete' | 'move'
  /** Grok's tool name (`Bash`, `Edit`, `WebFetch`). */
  name: string
  title: string
  rawInput?: Record<string, unknown>
  options?: readonly Record<string, string>[]
}

/** Grok's prompt answer `_meta` (GR04's shape): the prompt's usage per model, with Grok's own cost. */
export interface GrokUsage {
  input: number
  cacheRead: number
  output: number
  costUsd: number
}

const promptMeta = (u: GrokUsage): Record<string, unknown> => ({
  modelId: 'grok-4.6',
  usage: {
    totalTokens: u.input + u.cacheRead + u.output,
    modelUsage: {
      'grok-4.6': {
        inputTokens: u.input,
        outputTokens: u.output,
        cacheReadInputTokens: u.cacheRead,
        modelCalls: 2,
        costUSD: u.costUsd,
      },
    },
  },
})

/**
 * A read-only pass (Review, Critic): the session asks for everything (`_meta {yoloMode:false, autoMode:false}`), and
 * every permission request must be answered `reject_once` by Dim Factory itself (the "Grok ACP" mode row: the adapter
 * rejects every ask); the fake exits 99 on any other answer. `delayMs` keeps the pass running before its answer.
 */
export function grokReadOnlyPass(o: {
  asks: GrokAsk[]
  text: string
  usage: GrokUsage
  delayMs?: number
}): Op[] {
  const ops: Op[] = [
    {
      op: 'rpcExpect',
      method: 'session/prompt',
      as: 'prompt',
      params: { sessionId: GROK_SESSION },
      timeoutMs: 60_000,
    },
    grokUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_e2e_read',
      status: 'in_progress',
      title: 'Read src/index.ts',
      name: 'Read',
      kind: 'read',
      content: [],
      locations: [{ path: '$FAKE_CWD/src/index.ts' }],
    }),
    grokUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'call_e2e_read', status: 'completed' }),
  ]
  o.asks.forEach((a, i) => {
    const toolCall = {
      toolCallId: a.toolCallId,
      status: 'pending',
      title: a.title,
      name: a.name,
      kind: a.kind,
      content: [],
      locations: [],
      ...(a.rawInput !== undefined ? { rawInput: a.rawInput } : {}),
    }
    ops.push(
      grokUpdate({ sessionUpdate: 'tool_call', ...toolCall }),
      {
        op: 'rpcRequest',
        method: 'session/request_permission',
        as: `perm${i + 1}`,
        params: {
          sessionId: GROK_SESSION,
          options: a.options ?? (a.kind === 'edit' ? GROK_EDIT_OPTIONS : GROK_SHELL_OPTIONS),
          toolCall,
        },
      },
      {
        op: 'rpcExpectResponse',
        id: `$perm${i + 1}`,
        result: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
        timeoutMs: 30_000,
      },
      grokUpdate({ sessionUpdate: 'tool_call_update', toolCallId: a.toolCallId, status: 'failed' }),
    )
  })
  if (o.delayMs !== undefined) ops.push({ op: 'sleep', ms: o.delayMs })
  ops.push(
    grokChunk(o.text),
    { op: 'rpcResult', id: '$prompt', result: { stopReason: 'end_turn', _meta: promptMeta(o.usage) } },
    { op: 'expectEof', timeoutMs: 30_000 },
    { op: 'exit', code: 0 },
  )
  return ops
}

/** A full-mode pass (Auto, `_meta.yoloMode:true`): no permission requests, a file written, the final message. */
export function grokFullPass(o: {
  write?: { path: string; content: string }
  text: string
  usage: GrokUsage
}): Op[] {
  const ops: Op[] = [
    {
      op: 'rpcExpect',
      method: 'session/prompt',
      as: 'prompt',
      params: { sessionId: GROK_SESSION },
      timeoutMs: 60_000,
    },
  ]
  if (o.write !== undefined) {
    ops.push(
      grokUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_e2e_write',
        status: 'in_progress',
        title: `Write ${o.write.path}`,
        name: 'Write',
        kind: 'edit',
        content: [],
        locations: [{ path: `$FAKE_CWD/${o.write.path}` }],
      }),
      { op: 'writeFile', path: o.write.path, content: o.write.content },
      grokUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'call_e2e_write', status: 'completed' }),
    )
  }
  ops.push(
    grokChunk(o.text),
    { op: 'rpcResult', id: '$prompt', result: { stopReason: 'end_turn', _meta: promptMeta(o.usage) } },
    { op: 'expectEof', timeoutMs: 30_000 },
    { op: 'exit', code: 0 },
  )
  return ops
}

/** A Review on Grok that runs a command and edits a file: Dim Factory rejects both, so the run asks nothing. */
export function grokReview(o: { delayMs?: number } = {}): Op[] {
  return grokReadOnlyPass({
    asks: [
      {
        toolCallId: 'call_e2e_bash',
        kind: 'execute',
        name: 'Bash',
        title: 'npm test',
        rawInput: { command: 'npm test' },
      },
      {
        toolCallId: 'call_e2e_edit',
        kind: 'edit',
        name: 'Edit',
        title: 'Edit src/cli.ts',
        rawInput: { file_path: '$FAKE_CWD/src/cli.ts' },
      },
    ],
    text: 'NO FINDINGS',
    usage: { input: 9_216, cacheRead: 27_648, output: 330, costUsd: 0.0318 },
    ...(o.delayMs !== undefined ? { delayMs: o.delayMs } : {}),
  })
}

export interface GrokFakeState {
  /** `grok --version` prints `grok <version> (<commit>) stable`. */
  version: string
  /** Signed in: a stand-in auth.json in the fake's GROK_HOME; out: session/new answers authRequired. */
  login: 'in' | 'out'
  /** After session/new with `_meta.yoloMode:false` (a read-only pass). */
  readOnly?: Op[]
  /** After session/new with `_meta.yoloMode:true` (full mode). */
  full?: Op[]
}

const DEFAULT_GROK: GrokFakeState = { version: GROK_VERSION, login: 'in' }

/** Child env names the fake Grok logs with each start (what Dim Factory put in the spawn's env). */
const GROK_LOGGED_ENV = ['GROK_DISABLE_AUTOUPDATER', 'GROK_HOME']

/** The fake Grok of one E2E test (its scenario folder, log and private GROK_HOME under the test's root). */
export class FakeGrok {
  readonly dir: string
  readonly log: string
  readonly grokHome: string
  #state: GrokFakeState

  constructor(root: string, state: Partial<GrokFakeState> = {}) {
    this.dir = join(root, 'grok-scenario')
    this.log = join(root, 'grok.log.jsonl')
    this.grokHome = join(root, 'grok-home')
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(this.grokHome, { recursive: true })
    this.#state = { ...DEFAULT_GROK, ...state }
    this.#write()
  }

  /** `vendors.grok.env`: the fake's scenario and log, and a private GROK_HOME (never ~/.grok). */
  get env(): Record<string, string> {
    return {
      FAKE_CLI_SCRIPT: this.dir,
      FAKE_CLI_LOG: this.log,
      FAKE_CLI_TIMEOUT_MS: '30000',
      FAKE_CLI_LOG_ENV: GROK_LOGGED_ENV.join(','),
      GROK_HOME: this.grokHome,
    }
  }

  set(patch: Partial<GrokFakeState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#write()
  }

  entries(): FakeLogEntry[] {
    return readFakeLog(this.log)
  }

  /** Every `grok agent … stdio` the app started: argv, folder and the logged env (the resolver's checks left out). */
  agents(): { pid: number; argv: string[]; cwd: string; env: Record<string, string | null> }[] {
    return this.entries()
      .filter((e) => e.kind === 'start' && Array.isArray(e['argv']))
      .map((e) => ({
        pid: e.pid,
        argv: e['argv'] as string[],
        cwd: typeof e['cwd'] === 'string' ? e['cwd'] : '',
        env: (e['env'] ?? {}) as Record<string, string | null>,
      }))
      .filter((s) => s.argv.includes('stdio'))
  }

  /** Every Grok process the app started, whatever its argv (`--version`, `agent --help`, the agents). */
  allStarts(): { argv: string[]; env: Record<string, string | null> }[] {
    return this.entries()
      .filter((e) => e.kind === 'start' && Array.isArray(e['argv']))
      .map((e) => ({ argv: e['argv'] as string[], env: (e['env'] ?? {}) as Record<string, string | null> }))
  }

  messages(): { pid: number; msg: Record<string, unknown> }[] {
    const out: { pid: number; msg: Record<string, unknown> }[] = []
    for (const e of this.entries()) {
      if (e.kind !== 'stdin' || typeof e['line'] !== 'string') continue
      try {
        const v: unknown = JSON.parse(e['line'])
        if (v !== null && typeof v === 'object' && !Array.isArray(v))
          out.push({ pid: e.pid, msg: v as Record<string, unknown> })
      } catch {
        // not JSON: the fake reports it as a mismatch
      }
    }
    return out
  }

  calls(method: string): { pid: number; params: Record<string, unknown> }[] {
    return this.messages()
      .filter((m) => m.msg['method'] === method)
      .map((m) => ({ pid: m.pid, params: (m.msg['params'] ?? {}) as Record<string, unknown> }))
  }

  /** The app's answers to session/request_permission: the optionId it chose, in order. */
  permissionAnswers(): { pid: number; optionId: string }[] {
    return this.messages()
      .filter((m) => 'id' in m.msg && !('method' in m.msg) && 'result' in m.msg)
      .flatMap((m) => {
        const outcome = (m.msg['result'] as { outcome?: { outcome?: string; optionId?: string } } | null)
          ?.outcome
        return outcome === undefined
          ? []
          : [{ pid: m.pid, optionId: outcome.optionId ?? `(${outcome.outcome ?? 'none'})` }]
      })
  }

  errors(): FakeLogEntry[] {
    return this.entries().filter((e) => e.kind === 'error')
  }

  #write(): void {
    const s = this.#state
    const auth = join(this.grokHome, 'auth.json')
    // A stand-in for `grok login`: Dim Factory checks that the file exists, never what it holds.
    if (s.login === 'in') writeFileSync(auth, '{}\n')
    else rmSync(auth, { force: true })
    const file = (name: string, ops: readonly Op[]): string => {
      const path = join(this.dir, `${name}.script.jsonl`)
      writeFileSync(path, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
      return path
    }
    const version = file('version', [
      { op: 'stdout', line: `grok ${s.version} (3f9c2ab) stable` },
      { op: 'exit', code: 0 },
    ])
    const help = file('help', [
      ...GROK_AGENT_HELP.map((line) => ({ op: 'stdout', line })),
      { op: 'exit', code: 0 },
    ])
    const agent = file('agent', this.#agentOps())
    const entries = [
      { match: { argvIncludes: ['--version'] }, script: version, repeat: true },
      { match: { argvIncludes: ['agent', '--help'] }, script: help, repeat: true },
      { match: { argvIncludes: ['agent', 'stdio'] }, script: agent, repeat: true },
    ]
    writeFileSync(join(this.dir, 'scenario.json'), JSON.stringify(entries, null, 2))
  }

  #agentOps(): Op[] {
    const s = this.#state
    const cases: Op[] = []
    const tail: Op[] = []
    const pass = (label: string, yoloMode: boolean, ops: Op[] | undefined): void => {
      if (ops === undefined) return
      cases.push({
        match: { method: 'session/new', id: '$new', params: { mcpServers: [], _meta: { yoloMode } } },
        goto: label,
      })
      tail.push(
        { op: 'label', name: label },
        s.login === 'in'
          ? { op: 'rpcResult', id: '$new', result: sessionResult(GROK_SESSION) }
          : { op: 'rpcError', id: '$new', error: { code: -32000, message: 'Authentication required' } },
        ...(s.login === 'in'
          ? ops
          : [
              { op: 'expectEof', timeoutMs: 30_000 },
              { op: 'exit', code: 0 },
            ]),
      )
    }
    pass('readOnly', false, s.readOnly)
    pass('full', true, s.full)
    return [
      { op: 'rpcProtocol', jsonrpc: '2.0' },
      { op: 'onStdinEof', goto: 'end' },
      // The ACP base: fs and terminal client capabilities stay false; Dim Factory never calls authenticate.
      {
        op: 'rpcExpect',
        method: 'initialize',
        as: 'init',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        },
        timeoutMs: 60_000,
      },
      { op: 'rpcResult', id: '$init', result: GROK_INITIALIZE_RESULT },
      { op: 'label', name: 'next' },
      { op: 'onStdinEof', goto: 'end' },
      {
        op: 'branch',
        on: 'stdin',
        timeoutMs: 60_000,
        cases: [
          {
            match: { method: 'session/new', id: '$new', params: { cwd: { $regex: 'probe-cwd$' } } },
            goto: 'probe',
          },
          ...cases,
        ],
      },
      { op: 'label', name: 'probe' },
      s.login === 'in'
        ? { op: 'rpcResult', id: '$new', result: sessionResult('0199d2a4-7c1e-7a3b-9f20-00000000e2e0') }
        : { op: 'rpcError', id: '$new', error: { code: -32000, message: 'Authentication required' } },
      { op: 'goto', label: 'next' },
      ...tail,
      { op: 'label', name: 'end' },
      { op: 'exit', code: 0 },
    ]
  }
}

// ---- Muse -----------------------------------------------------------------------------------------------------------

export const MUSE_VERSION = '1.4.2-R4102.1'

/** `muse exec --help` (the options the probe looks for: every flag a pass passes). */
const MUSE_EXEC_HELP = [
  'Run Muse non-interactively',
  '',
  'Usage: muse exec [OPTIONS] [PROMPT]',
  '',
  'Options:',
  '      --json                     Print JSONL events on stdout',
  '      --prompt-file <FILE>       Read the prompt from a file',
  '      --session-id <UUID>        Continue a session',
  '      --model <ID>               The model',
  '      --disable-approval         Skip approval prompts (the sandbox stays on)',
  '      --sandbox-network <MODE>   proxy-only, restricted or enabled',
  '      --approval-mode <MODE>     on-request, untrusted or never',
  '      --yolo                     No approval and no sandbox',
  '      --trust-workspace          Trust the workspace for this run',
  '      --max-model-steps <N>      Stop after N model steps',
  '  -h, --help                     Print help',
]

/** A schema `muse schema` could print (any JSON: the probe hashes it and warns that nothing live is pinned yet). */
const MUSE_SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Muse records',
  oneOf: [
    { properties: { payload_type: { const: 'run.output.delta' } } },
    { properties: { payload_type: { pattern: '^run.terminal' } } },
    { properties: { payload_type: { pattern: '^task.lifecycle' } } },
    { properties: { payload_type: { const: 'tool.result' } } },
  ],
})

const MUSE_MODEL = 'muse-spark-1.2'
/** The session a Muse process reports (one per process: the fake's pid in it). */
export const MUSE_SESSION = '0199d2a0-4c1e-7a3b-8d5f-${FAKE_PID}'
const MUSE_COMMAND = '0199d2a0-4c1f-7b20-9c4d-5e6f7a8b0e2e'

/** One exec process's records, in the synthesized pin's envelope (tests/fixtures/muse/recipes/synthesize.mjs Rec). */
class MuseRecords {
  readonly ops: Op[] = []
  #seq = 0
  #tasks = 0
  readonly #run = { kind: 'run', id: MUSE_COMMAND }

  record(payloadType: string, payload: Record<string, unknown>): this {
    this.#seq++
    this.ops.push({
      op: 'stdout',
      json: {
        schema_version: 1,
        id: `0199d2a0-4c21-7d0e-8000-${this.#seq.toString(16).padStart(12, '0')}`,
        stream: { kind: 'session', id: MUSE_SESSION },
        sequence: this.#seq,
        recorded_at: 1_791_676_800_000_000 + this.#seq * 1_000,
        record_type: this.#seq === 1 ? 'reconciliation' : 'event',
        durability: 'durable',
        causation_id: MUSE_COMMAND,
        payload_type: payloadType,
        payload_schema_version: 1,
        payload,
      },
    })
    return this
  }

  start(): this {
    const c = { command_id: MUSE_COMMAND }
    return this.record('runtime.command.accepted', {
      kind: 'command_accepted',
      ...c,
      command_kind: 'turn.submit',
      client_id: null,
    })
      .record('session.run.linked', { kind: 'session_run_linked', ...c, run_stream: this.#run })
      .record('run.model.configured', {
        kind: 'model_configured',
        ...c,
        run_stream: this.#run,
        model_id: MUSE_MODEL,
        display_label: 'Muse Spark 1.2',
        profile_id: 'default',
        provider_id: 'meta',
        source: 'startup',
      })
      .record('run.lifecycle.started', { kind: 'run_started', ...c, run_stream: this.#run })
  }

  #lifecycle(task: string, kind: string, extra: Record<string, unknown> = {}): this {
    return this.record(`task.lifecycle.${kind}`, {
      kind: 'task_lifecycle',
      command_id: MUSE_COMMAND,
      run_stream: this.#run,
      task_id: task,
      task_stream: { kind: 'task', id: task },
      event: { kind, task_id: task, ...extra },
    })
  }

  /**
   * One tool task: `policy` is its side effect's decision (`allow:policy` under --disable-approval inside the sandbox;
   * `deny:…` for an escalation, which fails instead of asking: M03), `path` the file an edit names.
   */
  tool(name: string, o: { policy: string; path?: string; write?: Op }): this {
    this.#tasks++
    const task = `0199d2a0-4c20-7c0e-a${this.#tasks.toString(16).padStart(3, '0')}-0f1e2d3c4b5a`
    const call = `call_e2e${this.#tasks.toString(16).padStart(4, '0')}`
    this.#lifecycle(task, 'proposed', { task_kind: `tool.${name}` })
      .#lifecycle(task, 'accepted')
      .#lifecycle(task, 'scheduled', { idempotency_key: `tool:${call}` })
      .#lifecycle(task, 'side_effect_intent', {
        idempotency_key: `tool:${call}`,
        operation: `tool.${name}`,
        policy_decision: o.policy,
      })
    if (o.policy.startsWith('deny')) {
      return this.#lifecycle(task, 'failed', { reason: `${o.policy}: escalation not approved` })
    }
    this.#lifecycle(task, 'started', { span_id: `e2e${this.#tasks}` })
    if (o.write !== undefined) this.ops.push(o.write)
    this.record('tool.result', {
      kind: 'tool_result',
      call_id: call,
      correlation_facts: { outcome: 'success' },
      ...(o.path !== undefined ? { edit_facts: { path: o.path } } : {}),
    })
    return this.#lifecycle(task, 'completed')
  }

  delta(text: string): this {
    return this.record('run.output.delta', {
      kind: 'run_output_delta',
      command_id: MUSE_COMMAND,
      run_stream: this.#run,
      text,
    })
  }

  completed(text: string, usage: MuseUsage): this {
    return this.record('run.terminal.completed', {
      kind: 'run_terminal',
      command_id: MUSE_COMMAND,
      run_stream: this.#run,
      terminal: 'completed',
      text,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        input_tokens_details: { cached_tokens: usage.cached },
      },
    })
  }
}

export interface MuseUsage {
  /** Input tokens, the cached ones included (the Responses API's words). */
  input: number
  cached: number
  output: number
}

/**
 * An edit pass (Implement, a fresh Fix) under `--disable-approval` (M02/M03): it writes a file and runs the tests in its
 * sandbox without asking; a network fetch it tries is an escalation, which fails instead of asking (no relay); then
 * the answer. `delayMs` keeps the pass running a moment before its answer.
 */
export function museEditPass(o: {
  write: { path: string; content: string }
  escalation?: boolean
  text: string
  usage: MuseUsage
  delayMs?: number
}): Op[] {
  const r = new MuseRecords().start()
  r.tool('write_file', {
    policy: 'allow:policy',
    path: `\${FAKE_CWD}/${o.write.path}`,
    write: { op: 'writeFile', path: o.write.path, content: o.write.content },
  })
  r.tool('bash', { policy: 'allow:policy' })
  if (o.escalation === true) r.tool('web_fetch', { policy: 'deny:sandbox' })
  if (o.delayMs !== undefined) r.ops.push({ op: 'sleep', ms: o.delayMs })
  r.delta(o.text).completed(o.text, o.usage)
  return [...r.ops, { op: 'exit', code: 0 }]
}

export interface MuseFakeState {
  version: string
  /** META_API_KEY in `vendors.muse.env` (a stand-in value: the auth check reads that it is set, never its value). */
  key: boolean
  /** A pass with `--disable-approval`. */
  edit?: Op[]
  /** A pass with `--yolo` (full mode, Auto only). */
  full?: Op[]
}

const DEFAULT_MUSE: MuseFakeState = { version: MUSE_VERSION, key: true }

/** The fake Muse of one E2E test (its scenario folder and log under the test's root). */
export class FakeMuse {
  readonly dir: string
  readonly log: string
  #state: MuseFakeState

  constructor(root: string, state: Partial<MuseFakeState> = {}) {
    this.dir = join(root, 'muse-scenario')
    this.log = join(root, 'muse.log.jsonl')
    mkdirSync(this.dir, { recursive: true })
    this.#state = { ...DEFAULT_MUSE, ...state }
    this.#write()
  }

  /** `vendors.muse.env`: the fake's scenario and log (and a stand-in META_API_KEY when signed in). */
  get env(): Record<string, string> {
    return {
      FAKE_CLI_SCRIPT: this.dir,
      FAKE_CLI_LOG: this.log,
      FAKE_CLI_TIMEOUT_MS: '30000',
      ...(this.#state.key ? { META_API_KEY: 'meta-e2e-not-a-real-key' } : {}),
    }
  }

  set(patch: Partial<MuseFakeState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#write()
  }

  entries(): FakeLogEntry[] {
    return readFakeLog(this.log)
  }

  /** Every `muse exec` pass the app started (the probe's `--version`, `exec --help` and `schema` left out). */
  passes(): { pid: number; argv: string[]; cwd: string }[] {
    return this.entries()
      .filter((e) => e.kind === 'start' && Array.isArray(e['argv']))
      .map((e) => ({
        pid: e.pid,
        argv: e['argv'] as string[],
        cwd: typeof e['cwd'] === 'string' ? e['cwd'] : '',
      }))
      .filter((s) => s.argv.includes('exec') && !s.argv.includes('--help'))
  }

  errors(): FakeLogEntry[] {
    return this.entries().filter((e) => e.kind === 'error')
  }

  #write(): void {
    const s = this.#state
    const file = (name: string, ops: readonly Op[]): string => {
      const path = join(this.dir, `${name}.script.jsonl`)
      writeFileSync(path, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
      return path
    }
    const lines = (text: readonly string[]): Op[] => [
      ...text.map((line) => ({ op: 'stdout', line })),
      { op: 'exit', code: 0 },
    ]
    const entries: Record<string, unknown>[] = [
      { match: { argvIncludes: ['--version'] }, script: file('version', lines([`muse ${s.version}`])) },
      { match: { argvIncludes: ['exec', '--help'] }, script: file('help', lines(MUSE_EXEC_HELP)) },
      { match: { argvIncludes: ['schema'] }, script: file('schema', lines([MUSE_SCHEMA])) },
    ]
    if (s.edit !== undefined)
      entries.push({ match: { argvIncludes: ['exec', '--disable-approval'] }, script: file('edit', s.edit) })
    if (s.full !== undefined)
      entries.push({ match: { argvIncludes: ['exec', '--yolo'] }, script: file('full', s.full) })
    writeFileSync(
      join(this.dir, 'scenario.json'),
      JSON.stringify(
        entries.map((e) => ({ ...e, repeat: true })),
        null,
        2,
      ),
    )
  }
}

// ---- the composer ---------------------------------------------------------------------------------------------------

/** Open the composer's pass rows and the row of `pass`. */
export async function openPassRow(page: Page, pass: string): Promise<void> {
  const toggle = page.getByTestId('composer-passes-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const row = page.getByTestId(`pass-row-toggle-${pass}`)
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
}

/**
 * Pick a vendor for a pass the way a user does: open the pass's Vendor list and click the option whose text starts
 * with `name` in the list's "More" group.
 */
export async function pickFromMore(page: Page, pass: string, name: string): Promise<void> {
  await openPassRow(page, pass)
  await page.getByTestId(`pass-vendor-${pass}`).click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  const more = listbox.getByRole('group').filter({ hasText: 'More' })
  await expect(more).toBeVisible()
  await more.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click()
  await expect(listbox).toBeHidden()
  await expect(page.getByTestId(`pass-vendor-${pass}`)).toContainText(name)
}
