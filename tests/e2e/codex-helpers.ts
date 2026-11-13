// Helpers for the Codex E2E specs (Codex → cross-vendor balanced, the Codex app-server route,
// the Codex variants of the first-launch, cross-vendor and snag specs): a fake Codex the app finds at `vendors.codex.path` (the fake CLI's npm-style .cmd shim on win32, its
// shebang copy on POSIX, through the real resolver and spawn path). Every `codex app-server --listen stdio://` runs one
// branching JSON-RPC script, because the probe's handshakes and the passes share that argv and come in any order:
// initialize → initialized, then by the next request
//   - windowsSandbox/readiness (win32 probes) → the state's sandbox; model/list → the state's models (the picker's: the
//     probe asks it without hidden models);
//   - windowsSandbox/setupStart{unelevated} (the chip's click) → {started:true}, a pause, then setupCompleted;
//   - thread/start (an edit pass), thread/start read-only, thread/resume → the state's pass scripts.
// `codex login status`, `--version` and `app-server generate-json-schema` (the committed 0.160 bundle, or one without
// turn/interrupt for the exec route) answer from the state too, and `codex exec --json` runs the exec scripts. A test
// changes the state between steps (`set`); a process already running keeps the script it started with.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFakeCli } from '../../scripts/build-fake-cli.mjs'
import { readFakeLog } from '../fake-cli/harness.ts'
import type { FakeLogEntry } from '../fake-cli/harness.ts'
import { REPO_ROOT } from '../integration/run/scenario.ts'

export const IS_WIN32 = process.platform === 'win32'

export type Op = Record<string, unknown>

const COMMITTED_SCHEMA = join(
  REPO_ROOT,
  'src',
  'core',
  'adapters',
  'codex',
  'protocol',
  'v0.160.0',
  'schema',
  'codex_app_server_protocol.schemas.json',
)

/** The fake `codex` a user install would expose: the .cmd shim on win32, the shebang copy on POSIX. */
export async function fakeCodexPath(): Promise<string> {
  const build = await buildFakeCli()
  const p = process.platform === 'win32' ? build.launchers.cmd?.codex : build.launchers.sh?.codex
  if (p === undefined) throw new Error('fake codex launcher missing')
  return p
}

/** A UUIDv7 made now: Codex's thread ids carry their date, which canResume uses to find the rollout. */
export function threadIdNow(tail: string, ms = Date.now()): string {
  const hex = ms.toString(16).padStart(12, '0')
  const t = tail
    .replace(/[^0-9a-f]/g, '0')
    .padStart(12, '0')
    .slice(-12)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-${t}`
}

export interface CodexUsage {
  input: number
  cached: number
  output: number
  reasoning: number
}

const tokenUsage = (u: CodexUsage) => ({
  totalTokens: u.input + u.output,
  inputTokens: u.input,
  cachedInputTokens: u.cached,
  cacheWriteInputTokens: 0,
  outputTokens: u.output,
  reasoningOutputTokens: u.reasoning,
})

const notify = (method: string, params: object): Op => ({
  op: 'stdout',
  json: { method, params, emittedAtMs: Date.now() },
})

/** What thread/start (or thread/resume) answers: the thread, its model and the sandbox it really runs in. */
export function threadReply(
  threadId: string,
  sandbox: 'workspaceWrite' | 'readOnly',
  model = 'gpt-5.6-terra',
): object {
  return {
    thread: {
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      ephemeral: sandbox === 'readOnly',
      modelProvider: 'openai',
      status: { type: 'idle' },
      cliVersion: '0.160.1',
      source: 'appServer',
      turns: [],
    },
    model,
    modelProvider: 'openai',
    serviceTier: null,
    approvalPolicy: sandbox === 'readOnly' ? 'never' : 'on-request',
    approvalsReviewer: 'user',
    sandbox:
      sandbox === 'readOnly'
        ? { type: 'readOnly' }
        : { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
    reasoningEffort: null,
  }
}

export interface TurnOptions {
  threadId: string
  turnId: string
  /** The model thread/start (or thread/resume) answers with: what the CLI resolved (default gpt-5.6-terra). */
  model?: string
  /**
   * Live balanced run: the account's whole list (hidden models included), which a pass with no model asks for when the
   * picker's list lacks the model its thread named (model/list{includeHidden:true}, after the thread request).
   */
  accountList?: CodexModel[]
  /** A pause before that list answers (the pass has started and has not said which model it runs yet). */
  listDelayMs?: number
  /** The final message, streamed as two deltas. */
  text: string
  /** A file written (relative to the pass's folder) before the turn ends. */
  write?: { path: string; content: string }
  /** One command approval the user answers (the request id is 0); the reply must be this decision. */
  approval?: { command: string; reason: string; decision?: 'accept' | 'acceptForSession' | 'decline' }
  /** Cumulative thread totals after this turn. */
  total: CodexUsage
  /** Totals the thread already had (a resume reports them first). */
  restored?: CodexUsage
  /** Pause before the final message (keeps the pass running for a moment). */
  delayMs?: number
}

/** A turn after the thread request was answered: turn/start → items → usage → turn/completed → stdin closed. */
function turnOps(o: TurnOptions): Op[] {
  const t = { threadId: o.threadId, turnId: o.turnId }
  const turn = (status: string) => ({ id: o.turnId, items: [], status, error: null })
  const ops: Op[] = []
  if (o.restored !== undefined) {
    const u = tokenUsage(o.restored)
    ops.push(
      notify('thread/tokenUsage/updated', {
        ...t,
        tokenUsage: { total: u, last: u, modelContextWindow: 272000 },
      }),
    )
  }
  ops.push(
    {
      op: 'rpcExpect',
      method: 'turn/start',
      as: 'turn',
      params: { threadId: o.threadId },
      timeoutMs: 60_000,
    },
    { op: 'rpcResult', id: '$turn', result: { turn: turn('inProgress') } },
    notify('turn/started', { threadId: o.threadId, turn: turn('inProgress') }),
  )
  if (o.approval !== undefined) {
    const item = {
      type: 'commandExecution',
      id: 'call_e2e_1',
      command: o.approval.command,
      cwd: '$FAKE_CWD',
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: o.approval.command }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
    ops.push(
      notify('item/started', { ...t, item, startedAtMs: Date.now() }),
      {
        op: 'stdout',
        json: {
          id: 0,
          method: 'item/commandExecution/requestApproval',
          params: {
            ...t,
            itemId: item.id,
            startedAtMs: Date.now(),
            reason: o.approval.reason,
            command: o.approval.command,
            cwd: '$FAKE_CWD',
            commandActions: item.commandActions,
            availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
          },
        },
      },
      {
        op: 'rpcExpectResponse',
        id: 0,
        result: { decision: o.approval.decision ?? 'accept' },
        timeoutMs: 120_000,
      },
      notify('serverRequest/resolved', { threadId: o.threadId, requestId: 0 }),
      notify('item/completed', {
        ...t,
        item: { ...item, status: 'completed', aggregatedOutput: '# pass 2\n', exitCode: 0, durationMs: 900 },
        completedAtMs: Date.now(),
      }),
    )
  }
  if (o.write !== undefined) {
    const change = {
      type: 'fileChange',
      id: 'call_e2e_2',
      changes: [{ path: o.write.path, kind: { type: 'add' }, diff: o.write.content }],
    }
    ops.push(
      notify('item/started', { ...t, item: { ...change, status: 'inProgress' }, startedAtMs: Date.now() }),
      { op: 'writeFile', path: o.write.path, content: o.write.content },
      notify('item/completed', { ...t, item: { ...change, status: 'completed' }, completedAtMs: Date.now() }),
    )
  }
  if (o.delayMs !== undefined) ops.push({ op: 'sleep', ms: o.delayMs })
  const half = Math.ceil(o.text.length / 2)
  const msg = { type: 'agentMessage', id: 'msg_e2e', text: '', phase: null, memoryCitation: null }
  const total = tokenUsage(o.total)
  ops.push(
    notify('item/started', { ...t, item: msg, startedAtMs: Date.now() }),
    notify('item/agentMessage/delta', { ...t, itemId: msg.id, delta: o.text.slice(0, half) }),
    notify('item/agentMessage/delta', { ...t, itemId: msg.id, delta: o.text.slice(half) }),
    notify('item/completed', { ...t, item: { ...msg, text: o.text }, completedAtMs: Date.now() }),
    notify('thread/tokenUsage/updated', {
      ...t,
      tokenUsage: { total, last: total, modelContextWindow: 272000 },
    }),
    notify('turn/completed', { threadId: o.threadId, turn: turn('completed') }),
    { op: 'expectEof', timeoutMs: 30_000 },
    { op: 'exit', code: 0 },
  )
  return ops
}

/** model/list's entries for `models` (hidden: `hidden` is true for those listed there). */
export function modelListData(models: readonly CodexModel[]): object[] {
  return models.map((m) => ({
    id: m.id,
    model: m.id,
    displayName: m.displayName,
    description: '',
    hidden: m.hidden === true,
    isDefault: m.isDefault === true,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
    defaultReasoningEffort: 'medium',
  }))
}

/** The thread request answered (with the model the CLI resolved), then the pass's own list when it asks for one. */
function threadOps(o: Pick<TurnOptions, 'threadId' | 'model' | 'accountList' | 'listDelayMs'>): Op[] {
  const ops: Op[] = [
    { op: 'rpcResult', id: '$thr', result: threadReply(o.threadId, 'workspaceWrite', o.model) },
  ]
  if (o.accountList !== undefined) {
    ops.push(
      {
        op: 'rpcExpect',
        method: 'model/list',
        as: 'mlp',
        params: { includeHidden: true },
        timeoutMs: 60_000,
      },
      ...(o.listDelayMs !== undefined ? [{ op: 'sleep', ms: o.listDelayMs }] : []),
      { op: 'rpcResult', id: '$mlp', result: { data: modelListData(o.accountList), nextCursor: null } },
    )
  }
  return ops
}

/** An edit pass (Implement, a fresh Fix): thread/start answered workspace-write, then the turn. */
export function editPass(o: TurnOptions): Op[] {
  return [...threadOps(o), notify('thread/started', { thread: { id: o.threadId } }), ...turnOps(o)]
}

/** Fix resuming Implement's thread: thread/resume echoes the id and the restored totals, then the turn. */
export function resumePass(o: TurnOptions): Op[] {
  return [...threadOps(o), ...turnOps(o)]
}

/** A turn that fails with a structured codexErrorInfo (the failure table's Codex column): error{willRetry:false}, turn failed. */
export function failedPass(o: {
  threadId: string
  turnId: string
  message: string
  codexErrorInfo: unknown
  /** As TurnOptions. */
  model?: string
  accountList?: CodexModel[]
  listDelayMs?: number
}): Op[] {
  const error = { message: o.message, codexErrorInfo: o.codexErrorInfo, additionalDetails: null }
  const turn = (status: string, err: unknown) => ({ id: o.turnId, items: [], status, error: err })
  return [
    ...threadOps(o),
    notify('thread/started', { thread: { id: o.threadId } }),
    {
      op: 'rpcExpect',
      method: 'turn/start',
      as: 'turn',
      params: { threadId: o.threadId },
      timeoutMs: 60_000,
    },
    { op: 'rpcResult', id: '$turn', result: { turn: turn('inProgress', null) } },
    notify('turn/started', { threadId: o.threadId, turn: turn('inProgress', null) }),
    notify('error', { error, willRetry: false, threadId: o.threadId, turnId: o.turnId }),
    notify('turn/completed', { threadId: o.threadId, turn: turn('failed', error) }),
    { op: 'expectEof', timeoutMs: 30_000 },
    { op: 'exit', code: 0 },
  ]
}

/** turn/start refused with a JSON-RPC error (an -32601 "method not found" is flag drift). */
export function refusedTurnPass(o: { threadId: string; code: number; message: string }): Op[] {
  return [
    { op: 'rpcResult', id: '$thr', result: threadReply(o.threadId, 'workspaceWrite') },
    {
      op: 'rpcExpect',
      method: 'turn/start',
      as: 'turn',
      params: { threadId: o.threadId },
      timeoutMs: 60_000,
    },
    { op: 'rpcError', id: '$turn', error: { code: o.code, message: o.message } },
    { op: 'expectEof', timeoutMs: 30_000 },
    { op: 'exit', code: 0 },
  ]
}

/** `codex exec --json … -` (the fallback route): the prompt to EOF, JSONL events, the `-o` file. */
export function execPass(o: {
  threadId: string
  text: string
  write?: { path: string; content: string }
  total: CodexUsage
  resume?: boolean
}): Op[] {
  const ops: Op[] = [
    {
      op: 'expectArgs',
      includes: [
        'exec',
        '--json',
        '--sandbox',
        'workspace-write',
        '-o',
        '-',
        ...(o.resume === true ? ['resume'] : []),
      ],
      excludes: ['--full-auto', '--approve-for-me', '--oss', '--local-provider', '--ephemeral'],
    },
    { op: 'readToEof', timeoutMs: 30_000 },
    { op: 'stdout', json: { type: 'thread.started', thread_id: o.threadId } },
    { op: 'stdout', json: { type: 'turn.started' } },
  ]
  if (o.write !== undefined) {
    ops.push(
      { op: 'writeFile', path: o.write.path, content: o.write.content },
      {
        op: 'stdout',
        json: {
          type: 'item.completed',
          item: {
            id: 'item_0',
            type: 'file_change',
            changes: [{ path: o.write.path, kind: 'add' }],
            status: 'completed',
          },
        },
      },
    )
  }
  ops.push(
    {
      op: 'stdout',
      json: { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: o.text } },
    },
    {
      op: 'stdout',
      json: {
        type: 'turn.completed',
        usage: {
          input_tokens: o.total.input,
          cached_input_tokens: o.total.cached,
          output_tokens: o.total.output,
          reasoning_output_tokens: o.total.reasoning,
        },
      },
    },
    { op: 'writeFile', argvPath: '-o', content: `${o.text}\n` },
    { op: 'exit', code: 0 },
  )
  return ops
}

export interface CodexModel {
  id: string
  displayName: string
  isDefault?: boolean
  /** Only in a list asked with hidden models (never the picker's). */
  hidden?: boolean
}

export const CODEX_MODELS: CodexModel[] = [
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', isDefault: true },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
]

export interface CodexFakeState {
  /** `codex login status`. */
  login: 'in' | 'out'
  /** windowsSandbox/readiness (only win32 probes ask). */
  sandbox: 'ready' | 'notConfigured'
  /** generate-json-schema: the committed 0.160 bundle, or one without turn/interrupt (a required method → exec). */
  schema: 'app-server' | 'exec'
  /** windowsSandbox/setupStart: the pause before setupCompleted, and whether it succeeds. */
  setup: { delayMs: number; success: boolean }
  models: CodexModel[]
  /** After a thread/start for an edit pass matched (`$thr` bound): the pass (ends with exit). */
  edit?: Op[]
  /** After a read-only thread/start matched. */
  readOnly?: Op[]
  /** After thread/resume of this thread matched. */
  resume?: { threadId: string; ops: Op[] }
  /** codex exec (no `resume`) and `exec … resume <id>`. */
  exec?: Op[]
  execResume?: Op[]
  /** More `codex exec` scripts, matched before the ones above (e.g. by a renamed flag in argv). */
  execBy?: { name: string; argvIncludes: string[]; ops: Op[] }[]
}

const DEFAULT_STATE: CodexFakeState = {
  login: 'in',
  sandbox: 'ready',
  schema: 'app-server',
  setup: { delayMs: 2_500, success: true },
  models: CODEX_MODELS,
}

/** The fake Codex of one E2E test (its scenario folder, log and private CODEX_HOME under the test's root). */
export class FakeCodex {
  readonly dir: string
  readonly log: string
  readonly codexHome: string
  #state: CodexFakeState

  constructor(root: string, state: Partial<CodexFakeState> = {}) {
    this.dir = join(root, 'codex-scenario')
    this.log = join(root, 'codex.log.jsonl')
    this.codexHome = join(root, 'codex-home')
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(this.codexHome, { recursive: true })
    this.#state = { ...DEFAULT_STATE, ...state }
    this.#write()
  }

  /** `vendors.codex.env`: the fake's scenario and log, and a private CODEX_HOME (never ~/.codex). */
  get env(): Record<string, string> {
    return {
      FAKE_CLI_SCRIPT: this.dir,
      FAKE_CLI_LOG: this.log,
      FAKE_CLI_TIMEOUT_MS: '30000',
      CODEX_HOME: this.codexHome,
    }
  }

  get state(): Readonly<CodexFakeState> {
    return this.#state
  }

  /** Change what the next Codex processes answer. */
  set(patch: Partial<CodexFakeState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#write()
  }

  /** The rollout Codex keeps for a thread it can resume (sessions/YYYY/MM/DD/rollout-…-<id>.jsonl). */
  writeRollout(threadId: string, ms = Date.now()): void {
    const d = new Date(ms)
    const p = (n: number): string => String(n).padStart(2, '0')
    const ymd = [String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())]
    const dir = join(this.codexHome, 'sessions', ...ymd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `rollout-${ymd.join('-')}T00-00-00-${threadId}.jsonl`), '')
  }

  entries(): FakeLogEntry[] {
    return readFakeLog(this.log)
  }

  /** argv of every Codex process the app started (the resolver's `--version` checks left out). */
  argvs(): string[][] {
    return this.entries()
      .filter((e) => e.kind === 'start' && Array.isArray(e['argv']))
      .map((e) => e['argv'] as string[])
      .filter((a) => !a.includes('--version'))
  }

  /** The JSON-RPC messages the app sent, parsed, with the process that read them. */
  messages(): { pid: number; msg: Record<string, unknown> }[] {
    const out: { pid: number; msg: Record<string, unknown> }[] = []
    for (const e of this.entries()) {
      if (e.kind !== 'stdin' || typeof e['line'] !== 'string') continue
      try {
        const v: unknown = JSON.parse(e['line'])
        if (v !== null && typeof v === 'object' && !Array.isArray(v))
          out.push({ pid: e.pid, msg: v as Record<string, unknown> })
      } catch {
        // a prompt line on the exec route
      }
    }
    return out
  }

  /** Requests of one method, in order. */
  requests(method: string): { pid: number; params: Record<string, unknown>; id: unknown }[] {
    return this.messages()
      .filter((m) => m.msg['method'] === method && 'id' in m.msg)
      .map((m) => ({
        pid: m.pid,
        id: m.msg['id'],
        params: (m.msg['params'] ?? {}) as Record<string, unknown>,
      }))
  }

  /** The text of each turn/start, in order. */
  turnTexts(): string[] {
    return this.requests('turn/start').map((r) => {
      const input = r.params['input'] as { text?: string }[] | undefined
      return (input ?? []).map((i) => i.text ?? '').join('\n')
    })
  }

  /** The prompt each `codex exec` read on stdin (its lines joined). */
  execPrompts(): string[] {
    const execPids = new Set(
      this.entries()
        .filter(
          (e) => e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes('exec'),
        )
        .map((e) => e.pid),
    )
    const by = new Map<number, string[]>()
    for (const e of this.entries()) {
      if (e.kind !== 'stdin' || !execPids.has(e.pid) || typeof e['line'] !== 'string') continue
      by.set(e.pid, [...(by.get(e.pid) ?? []), e['line']])
    }
    return [...by.values()].map((l) => l.join('\n'))
  }

  /** Mismatches and script errors the fake logged (it exits 99/98/97 on them). */
  errors(): FakeLogEntry[] {
    return this.entries().filter((e) => e.kind === 'error')
  }

  /** Wait until the app sent `method` (polling the fake's log). */
  async waitForRequest(method: string, timeoutMs = 60_000): Promise<void> {
    const end = Date.now() + timeoutMs
    while (this.requests(method).length === 0) {
      if (Date.now() > end) throw new Error(`Codex never received ${method}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  #write(): void {
    const s = this.#state
    const file = (name: string, ops: readonly Op[]): string => {
      const path = join(this.dir, `${name}.script.jsonl`)
      writeFileSync(path, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
      return path
    }
    const version = file('version', [
      { op: 'stdout', line: 'codex-cli 0.160.1' },
      { op: 'exit', code: 0 },
    ])
    const login = file(
      'login',
      s.login === 'in'
        ? [
            { op: 'stderr', line: 'Logged in using ChatGPT' },
            { op: 'exit', code: 0 },
          ]
        : [
            { op: 'stderr', line: 'Not logged in' },
            { op: 'exit', code: 1 },
          ],
    )
    let bundle = COMMITTED_SCHEMA
    if (s.schema === 'exec') {
      bundle = join(this.dir, 'exec-bundle', 'codex_app_server_protocol.schemas.json')
      mkdirSync(join(this.dir, 'exec-bundle'), { recursive: true })
      writeFileSync(bundle, JSON.stringify(withoutMethod(COMMITTED_SCHEMA, 'turn/interrupt')))
    }
    const schema = file('schema', [
      { op: 'copyFiles', from: bundle, argvPath: '--out' },
      { op: 'exit', code: 0 },
    ])
    const server = file('app-server', this.#serverOps())
    const entries: {
      match: { argvIncludes: string[]; argvExcludes?: string[] }
      script: string
      repeat: true
    }[] = [
      { match: { argvIncludes: ['--version'] }, script: version, repeat: true },
      { match: { argvIncludes: ['login', 'status'] }, script: login, repeat: true },
      { match: { argvIncludes: ['generate-json-schema'] }, script: schema, repeat: true },
      { match: { argvIncludes: ['app-server', '--listen'] }, script: server, repeat: true },
    ]
    for (const e of s.execBy ?? [])
      entries.push({
        match: { argvIncludes: ['exec', ...e.argvIncludes] },
        script: file(`exec-${e.name}`, e.ops),
        repeat: true,
      })
    if (s.execResume !== undefined)
      entries.push({
        match: { argvIncludes: ['exec', 'resume'] },
        script: file('exec-resume', s.execResume),
        repeat: true,
      })
    if (s.exec !== undefined)
      entries.push({
        match: { argvIncludes: ['exec', '--json'], argvExcludes: ['resume'] },
        script: file('exec', s.exec),
        repeat: true,
      })
    writeFileSync(join(this.dir, 'scenario.json'), JSON.stringify(entries, null, 2))
  }

  #serverOps(): Op[] {
    const s = this.#state
    const cases: Op[] = [
      { match: { method: 'windowsSandbox/readiness', id: '$rdy' }, goto: 'readiness' },
      { match: { method: 'model/list', id: '$ml' }, goto: 'models' },
      {
        match: { method: 'windowsSandbox/setupStart', id: '$setup', params: { mode: 'unelevated' } },
        goto: 'setup',
      },
    ]
    const tail: Op[] = []
    if (s.edit !== undefined) {
      cases.push({
        match: {
          method: 'thread/start',
          id: '$thr',
          params: {
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            ephemeral: false,
            threadId: { $absent: true },
          },
        },
        goto: 'edit',
      })
      tail.push({ op: 'label', name: 'edit' }, ...s.edit)
    }
    if (s.readOnly !== undefined) {
      cases.push({
        match: {
          method: 'thread/start',
          id: '$thr',
          params: { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true },
        },
        goto: 'readOnly',
      })
      tail.push({ op: 'label', name: 'readOnly' }, ...s.readOnly)
    }
    if (s.resume !== undefined) {
      cases.push({
        match: {
          method: 'thread/resume',
          id: '$thr',
          params: {
            threadId: s.resume.threadId,
            excludeTurns: true,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
          },
        },
        goto: 'resume',
      })
      tail.push({ op: 'label', name: 'resume' }, ...s.resume.ops)
    }
    const models = modelListData(s.models.filter((m) => m.hidden !== true))
    return [
      { op: 'onStdinEof', goto: 'end' },
      { op: 'rpcExpect', method: 'initialize', as: 'init', params: { clientInfo: { name: 'dim-factory' } } },
      {
        op: 'rpcResult',
        id: '$init',
        result: {
          userAgent: 'dim-factory/0.160.1 (fake) dumb (dim-factory; 0.1.0)',
          codexHome: this.codexHome,
          platformFamily: IS_WIN32 ? 'windows' : 'unix',
          platformOs:
            process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
        },
      },
      { op: 'rpcExpect', method: 'initialized', kind: 'notification' },
      { op: 'label', name: 'next' },
      { op: 'onStdinEof', goto: 'end' },
      { op: 'branch', on: 'stdin', cases },
      { op: 'label', name: 'readiness' },
      { op: 'rpcResult', id: '$rdy', result: { status: s.sandbox } },
      { op: 'goto', label: 'next' },
      { op: 'label', name: 'models' },
      { op: 'rpcResult', id: '$ml', result: { data: models, nextCursor: null } },
      { op: 'goto', label: 'next' },
      { op: 'label', name: 'setup' },
      { op: 'rpcResult', id: '$setup', result: { started: true } },
      { op: 'sleep', ms: s.setup.delayMs },
      {
        op: 'stdout',
        json: {
          method: 'windowsSandbox/setupCompleted',
          params: {
            mode: 'unelevated',
            success: s.setup.success,
            error: s.setup.success ? null : 'CreateRestrictedToken failed: access is denied (os error 5)',
          },
          emittedAtMs: Date.now(),
        },
      },
      { op: 'goto', label: 'next' },
      ...tail,
      { op: 'label', name: 'end' },
      { op: 'exit', code: 0 },
    ]
  }
}

/** The committed bundle without one client request (a CLI that lacks a required method → the exec route). */
function withoutMethod(bundlePath: string, method: string): unknown {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
    definitions: Record<
      string,
      { oneOf?: { properties?: { method?: { enum?: string[]; const?: string } } }[] }
    >
  }
  const root = bundle.definitions['ClientRequest']
  if (root?.oneOf === undefined) throw new Error('the bundle has no ClientRequest union')
  root.oneOf = root.oneOf.filter((v) => {
    const m = v.properties?.method
    return !(m?.const === method || (m?.enum ?? []).includes(method))
  })
  return bundle
}
