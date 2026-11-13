// Helpers for the Gemini E2E specs (the ACP base + Gemini,
// the Gemini variants of the allow-session and trust specs): a fake Gemini the app finds at `vendors.gemini.path` (the fake CLI's npm-style .cmd shim
// on win32, run as system `node <entry>`; its shebang copy on POSIX), through the real resolver and spawn path. It
// answers `--version` and `--help` (which lists `--acp`), and every `gemini --acp` runs one branching JSON-RPC 2.0
// script, because the probe's handshake and the passes share that argv and come in any order:
//   initialize → initialized result, then by the next request
//   - session/new in Dim Factory's probe folder (`…/probe-cwd`) → the probe's session (or authRequired, signed out);
//   - session/new anywhere else → a pass's session (`gemini-session-<pid>`), then by its session/set_mode:
//     `plan` (native Plan), `default` (a read-only pass), `autoEdit` (an edit pass) → the state's pass scripts;
//   - session/load (Fix continuing Implement's session) → the history replayed, then the state's load script.
// Gemini's home is a private GEMINI_CLI_HOME under the test's root (never ~/.gemini): signed in, it holds an empty
// stand-in `oauth_creds.json` (Dim Factory checks that the file exists and never reads it). A test changes the state
// between steps (`set`); a process already running keeps the script it started with.
// The agent's frames have Gemini 0.62's own shapes (read from gemini-cli's source): a shell confirmation's
// title is its command and its text content the explanation; exit_plan_mode is kind `other`, titled with the plan
// file it wrote under GEMINI_CLI_HOME; a mode change is echoed as `[MODE_UPDATE] <mode>` text; the prompt's answer
// carries `_meta.quota` totals and no `usage` (none at all when cancelled).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { buildFakeCli } from '../../scripts/build-fake-cli.mjs'
import { readFakeLog } from '../fake-cli/harness.ts'
import type { FakeLogEntry } from '../fake-cli/harness.ts'

export type Op = Record<string, unknown>

/** The fake `gemini` a user install would expose: the npm .cmd shim on win32, the shebang copy on POSIX. */
export async function fakeGeminiPath(): Promise<string> {
  const build = await buildFakeCli()
  const p = process.platform === 'win32' ? build.launchers.cmd?.gemini : build.launchers.sh?.gemini
  if (p === undefined) throw new Error('fake gemini launcher missing')
  return p
}

export const GEMINI_VERSION = '0.62.0'

/** `gemini --help` as the CLI's yargs prints it (the options the probe looks for). */
const HELP_TEXT = [
  'Usage: gemini [options] [command]',
  '',
  'Options:',
  '  -m, --model                    Model',
  '  -s, --sandbox                  Run in sandbox?',
  '      --approval-mode            Set the approval mode',
  '      --acp                      Starts the agent in ACP mode',
  '      --skip-trust               Trust the current workspace for this session.',
  '  -v, --version                  Show version number',
  '  -h, --help                     Show help',
]

const INITIALIZE_RESULT = {
  protocolVersion: 1,
  authMethods: [
    { id: 'oauth-personal', name: 'Log in with Google', description: null },
    { id: 'gemini-api-key', name: 'Use Gemini API key', description: null },
  ],
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
  },
  agentInfo: { name: 'gemini-cli', title: 'Gemini CLI', version: GEMINI_VERSION },
}

export const GEMINI_MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default', description: 'Prompts for approval' },
    { id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
    { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
    { id: 'plan', name: 'Plan', description: 'Read-only mode' },
  ],
}

export const GEMINI_MODELS = {
  currentModelId: 'gemini-3-pro-preview',
  availableModels: [
    { modelId: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (preview)', description: null },
    { modelId: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (preview)', description: null },
  ],
}

/**
 * Where Gemini says a shell command runs (core tools/shell.ts getContextualDetails): the CLI's own folder, which
 * Dim Factory starts it in (the pass folder). A shell ask's `content` is this explanation and its `title` the command.
 */
export const SHELL_HERE = '[current working directory $FAKE_CWD]'

/**
 * A pass's session id: one per Gemini process (the fake's pid, in a UUID's shape), as a real `session/new` mints a
 * new one.
 */
export const SESSION = '${FAKE_PID}-e2e0-4000-8000-00000000e2e0'
/** The session a session/load names (Implement's, which Fix continues): bound when the load request matched. */
export const LOADED_SESSION = '$loadSid'

/** Gemini's options for a shell or edit confirmation in a session (toPermissionOptions). */
export const SESSION_OPTIONS = [
  { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
]

/**
 * G06b: the only always-option is the forbidden one ("Allow for all future sessions" writes the approval into
 * Gemini's own settings), so Dim Factory raises the ask with allowSession:false.
 */
export const FORBIDDEN_ONLY_OPTIONS = [
  { optionId: 'proceed_always_and_save', name: 'Allow for all future sessions', kind: 'allow_always' },
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
]

/** exit_plan_mode's options: no always-option (Plan never leaves plan mode through Dim Factory). */
const PLAN_EXIT_OPTIONS = [
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
]

const update = (u: Record<string, unknown>, sid = SESSION): Op => ({
  op: 'rpcNotify',
  method: 'session/update',
  params: { sessionId: sid, update: u },
})

export const chunk = (text: string, sid = SESSION): Op =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, sid)

export interface GeminiUsage {
  /** Prompt tokens, the cached ones included (G05). */
  input: number
  cached: number
  output: number
  thought: number
}

/** Gemini 0.62's token totals on a prompt answer (`_meta.quota`; no `usage`, no cached or thought split). */
const quotaOf = (u: GeminiUsage) => {
  const count = { input_tokens: u.input, output_tokens: u.output }
  return {
    quota: { token_count: count, model_usage: [{ model: 'gemini-3-pro-preview', token_count: count }] },
  }
}

/** A tool the agent asks permission for: its pending tool_call, then session/request_permission. */
export interface GeminiAsk {
  toolCallId: string
  kind: 'execute' | 'edit' | 'fetch' | 'delete' | 'move'
  /** Gemini's title: a shell command's command itself (getDisplayTitle). */
  title: string
  /** The tool_call's one text block: a shell command's explanation (`${SHELL_HERE} (<description>)`). */
  content?: string
  options?: readonly Record<string, string>[]
  /** The optionId Dim Factory must answer with (the fake exits 99 on anything else). */
  expect: string
  /** What the tool_call_update says after the answer. */
  after: 'completed' | 'failed'
  /** How long Dim Factory may take to answer (a person answering: minutes). */
  timeoutMs?: number
}

function askOps(a: GeminiAsk, n: number, sid = SESSION): Op[] {
  const toolCall = {
    toolCallId: a.toolCallId,
    status: 'pending',
    title: a.title,
    content: a.content !== undefined ? [{ type: 'content', content: { type: 'text', text: a.content } }] : [],
    locations: [],
    kind: a.kind,
  }
  return [
    update({ sessionUpdate: 'tool_call', ...toolCall }, sid),
    {
      op: 'rpcRequest',
      method: 'session/request_permission',
      as: `perm${n}`,
      params: { sessionId: sid, options: a.options ?? SESSION_OPTIONS, toolCall },
    },
    {
      op: 'rpcExpectResponse',
      id: `$perm${n}`,
      result: { outcome: { outcome: 'selected', optionId: a.expect } },
      timeoutMs: a.timeoutMs ?? 120_000,
    },
    update({ sessionUpdate: 'tool_call_update', toolCallId: a.toolCallId, status: a.after }, sid),
  ]
}

/**
 * session/set_mode answered (a mode other than `default` echoed first as `[MODE_UPDATE] <mode>` text, as Gemini does
 * while set_mode runs), then session/prompt (bound to $prompt), with its text matched when given.
 */
function promptOps(promptRegex?: string, sid = SESSION, mode?: string): Op[] {
  return [
    ...(mode !== undefined && mode !== 'default' ? [chunk(`[MODE_UPDATE] ${mode}`, sid)] : []),
    { op: 'rpcResult', id: '$mode', result: {} },
    {
      op: 'rpcExpect',
      method: 'session/prompt',
      as: 'prompt',
      params: {
        sessionId: sid,
        ...(promptRegex !== undefined ? { prompt: [{ type: 'text', text: { $regex: promptRegex } }] } : {}),
      },
      timeoutMs: 60_000,
    },
  ]
}

/** The prompt's answer: 0.62's `_meta` totals; a cancelled prompt carries none. */
const ending = (stopReason: string, usage?: GeminiUsage): Op[] => [
  {
    op: 'rpcResult',
    id: '$prompt',
    result: usage !== undefined ? { stopReason, _meta: quotaOf(usage) } : { stopReason },
  },
  { op: 'expectEof', timeoutMs: 30_000 },
  { op: 'exit', code: 0 },
]

/**
 * A read-only pass (Review, Critic; set_mode `default`): each permission request must be answered `cancel`
 * (reject_once) by Dim Factory itself (permission rule 2: a read-only pass rejects every ask), then the answer.
 */
export function readOnlyPass(o: {
  asks: { toolCallId: string; kind: GeminiAsk['kind']; title: string; content?: string }[]
  text: string
  usage: GeminiUsage
  promptRegex?: string
}): Op[] {
  return [
    ...promptOps(o.promptRegex),
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'read_file-e2e-1',
      status: 'in_progress',
      title: 'src/index.ts',
      content: [],
      locations: [{ path: '$FAKE_CWD/src/index.ts' }],
      kind: 'read',
    }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'read_file-e2e-1', status: 'completed' }),
    ...o.asks.flatMap((a, i) =>
      askOps({ ...a, expect: 'cancel', after: 'failed', timeoutMs: 30_000 }, i + 1),
    ),
    chunk(o.text),
    ...ending('end_turn', o.usage),
  ]
}

/**
 * An edit pass (Implement, a fresh Fix; set_mode `autoEdit`): optional asks the user answers, a file written, the
 * final message. `delayMs` keeps the pass running a moment before its answer.
 */
export interface EditPassOptions {
  asks?: GeminiAsk[]
  write?: { path: string; content: string }
  text: string
  usage: GeminiUsage
  promptRegex?: string
  delayMs?: number
}

export function editPass(o: EditPassOptions, sid = SESSION): Op[] {
  const ops: Op[] = [
    ...promptOps(o.promptRegex, sid, 'autoEdit'),
    ...(o.asks ?? []).flatMap((a, i) => askOps(a, i + 1, sid)),
  ]
  if (o.write !== undefined) {
    ops.push(
      update(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'write_file-e2e-1',
          status: 'in_progress',
          title: `Writing to ${o.write.path}`,
          content: [],
          locations: [{ path: `$FAKE_CWD/${o.write.path}` }],
          kind: 'edit',
        },
        sid,
      ),
      { op: 'writeFile', path: o.write.path, content: o.write.content },
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'write_file-e2e-1', status: 'completed' }, sid),
    )
  }
  if (o.delayMs !== undefined) ops.push({ op: 'sleep', ms: o.delayMs })
  ops.push(chunk(o.text, sid), ...ending('end_turn', o.usage))
  return ops
}

/**
 * Fix continuing Implement's session (session/load, resuming): Gemini replays the session's history as
 * updates before it answers (Dim Factory drops them until 400 ms of quiet), then set_mode `autoEdit` on the loaded
 * session and the edit pass.
 */
export function loadPass(o: EditPassOptions): Op[] {
  return [
    update(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'add a --version flag' } },
      LOADED_SESSION,
    ),
    chunk('REPLAYED HISTORY: Added the --version flag.', LOADED_SESSION),
    { op: 'rpcResult', id: '$load', result: { modes: GEMINI_MODES, models: GEMINI_MODELS } },
    {
      op: 'rpcExpect',
      method: 'session/set_mode',
      as: 'mode',
      params: { sessionId: LOADED_SESSION, modeId: 'autoEdit' },
      timeoutMs: 60_000,
    },
    ...editPass(o, LOADED_SESSION),
  ]
}

/** Where Gemini's plan mode writes the plan, inside the fake's GEMINI_CLI_HOME (`.gemini/tmp/<project>/<session>`). */
const PLAN_FILE = '.gemini/tmp/project/e2e-session/plans/version-flag.md'

/**
 * Gemini's native Plan (set_mode `plan`; G08): it reads, writes its plan file under its own tmp folder, then asks to
 * leave plan mode as Gemini does (exit_plan_mode: kind `other`, titled `Requesting plan approval for: <file>`, no
 * content). Dim Factory must read the plan from that file, answer `cancel` (reject_once: approving it could switch
 * Gemini out of plan mode), then send session/cancel; the prompt ends `cancelled` (no usage).
 */
export function planPass(o: { plan: string }): Op[] {
  const exit = {
    toolCallId: 'exit_plan_mode-e2e-1',
    status: 'pending',
    title: `Requesting plan approval for: $GEMINI_CLI_HOME/${PLAN_FILE}`,
    content: [],
    locations: [],
    kind: 'other',
  }
  return [
    ...promptOps(undefined, SESSION, 'plan'),
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'read_file-e2e-plan',
      status: 'in_progress',
      title: 'src/index.ts',
      content: [],
      locations: [{ path: '$FAKE_CWD/src/index.ts' }],
      kind: 'read',
    }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'read_file-e2e-plan', status: 'completed' }),
    chunk('I have what I need; here is the plan.'),
    { op: 'writeFile', under: 'GEMINI_CLI_HOME', path: PLAN_FILE, content: o.plan },
    update({ sessionUpdate: 'tool_call', ...exit }),
    {
      op: 'rpcRequest',
      method: 'session/request_permission',
      as: 'exit',
      params: { sessionId: SESSION, options: PLAN_EXIT_OPTIONS, toolCall: exit },
    },
    {
      op: 'rpcExpectResponse',
      id: '$exit',
      result: { outcome: { outcome: 'selected', optionId: 'cancel' } },
      timeoutMs: 30_000,
    },
    {
      op: 'rpcExpect',
      method: 'session/cancel',
      kind: 'notification',
      params: { sessionId: SESSION },
      timeoutMs: 30_000,
    },
    update({ sessionUpdate: 'tool_call_update', toolCallId: exit.toolCallId, status: 'failed' }),
    ...ending('cancelled'),
  ]
}

// ---- the UI walks (ui-standards.spec.ts test 9, ui-layout.spec.ts's Gemini walk) -----------------------------------------------------

/**
 * A run on the fake Gemini for the UI walks: its native Plan; Implement with an ask (Allow once); Critic read-only with
 * two requests Dim Factory denies itself; Fix continuing Implement's session (session/load). `delayMs` keeps Implement
 * and Fix running a moment before their answers.
 */
export function geminiWalk(o: { delayMs?: number } = {}): Partial<GeminiFakeState> {
  const delay = o.delayMs !== undefined ? { delayMs: o.delayMs } : {}
  return {
    plan: planPass({
      plan: [
        '## Plan',
        '1. Read the version from package.json in src/cli.ts.',
        '2. Print it for --version and exit 0.',
        '3. Add a test in test/cli.test.ts.',
      ].join('\n'),
    }),
    edit: editPass({
      asks: [
        {
          toolCallId: 'run_shell_command-e2e-1',
          kind: 'execute',
          title: 'npm test',
          content: `${SHELL_HERE} (Run the test suite)`,
          expect: 'proceed_once',
          after: 'completed',
          timeoutMs: 300_000,
        },
      ],
      write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
      text: 'Added the --version flag; the tests pass.',
      usage: { input: 11_264, cached: 6_144, output: 512, thought: 96 },
      ...delay,
    }),
    readOnly: readOnlyPass({
      asks: [
        {
          toolCallId: 'run_shell_command-e2e-2',
          kind: 'execute',
          title: 'npm test',
          content: `${SHELL_HERE} (Run the test suite)`,
        },
        { toolCallId: 'write_file-e2e-3', kind: 'edit', title: 'Writing to src/cli.ts' },
      ],
      text: 'NO FINDINGS',
      usage: { input: 12_288, cached: 8_192, output: 420, thought: 128 },
    }),
    load: loadPass({
      write: { path: 'src/version.test.ts', content: 'import "./version"\n' },
      text: 'Done.\n\nF1 fixed\nF2 fixed\nF3 fixed',
      usage: { input: 14_336, cached: 9_216, output: 640, thought: 160 },
      ...delay,
    }),
  }
}

/** The walks' passes: Gemini runs Plan, Implement, Critic and Fix (Review stays on Claude); no Claude model carried. */
export const GEMINI_WALK_PASSES = {
  plan: { vendor: 'gemini', model: null },
  implement: { vendor: 'gemini', model: null },
  critic: { vendor: 'gemini', model: null },
  fix: { vendor: 'gemini', model: null },
} as const

/** The folders `<DIM_FACTORY_HOME>/trust.json` trusts for `vendor` (vendorFolder grants), by their scope-root path. */
export function vendorFolderGrants(home: string, vendor = 'gemini'): string[] {
  const file = join(home, 'trust.json')
  if (!existsSync(file)) return []
  const doc = JSON.parse(readFileSync(file, 'utf8')) as {
    folders?: Record<string, { path?: string; grants?: { vendorFolder?: Record<string, unknown> } }>
  }
  return Object.values(doc.folders ?? {})
    .filter((f) => f.grants?.vendorFolder?.[vendor] !== undefined)
    .map((f) => f.path ?? '')
}

/**
 * Leave the Dashboard and come back once Gemini's probe has answered: the setup card decides its optional rows and
 * trust chips once per visit, from the probes in when it shows (Gemini's launch probe lands seconds after
 * the card showed and adds nothing to that visit), so the Gemini row and trust chip are on the next visit's card.
 */
export async function revisitDashboard(page: Page): Promise<void> {
  await page.getByTestId('nav-runs').click()
  await expect(page).toHaveURL(/#\/runs/)
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByTestId('setup-vendor-gemini')).toBeVisible()
}

/**
 * The same folder however each is spelled: the app keys trust by a folder's real name, so on macOS a grant reads
 * /private/var/... for the sandbox the harness made under /var/..., and on Windows an 8.3 temp name expands.
 */
export { samePath } from '../../src/core/real-path.ts'

export interface GeminiFakeState {
  /** `gemini --version`. */
  version: string
  /** Signed in: a stand-in oauth_creds.json in the fake's GEMINI_CLI_HOME; out: session/new answers authRequired. */
  login: 'in' | 'out'
  /** After a pass's session/set_mode `plan` matched. */
  plan?: Op[]
  /** After set_mode `default` (a read-only pass). */
  readOnly?: Op[]
  /** After set_mode `autoEdit` (an edit pass). */
  edit?: Op[]
  /** After a session/load matched (`$load` and `$loadSid` bound): the replay, then the pass (loadPass). */
  load?: Op[]
  /**
   * The launch probe's session/new answers this late (Gemini's probe lands seconds after the Dashboard
   * showed, so a layout walk can see what that moves).
   */
  probeDelayMs?: number
}

const DEFAULT_STATE: GeminiFakeState = { version: GEMINI_VERSION, login: 'in' }

/** The fake Gemini of one E2E test (its scenario folder, log and private GEMINI_CLI_HOME under the test's root). */
export class FakeGemini {
  readonly dir: string
  readonly log: string
  readonly geminiHome: string
  #state: GeminiFakeState

  constructor(root: string, state: Partial<GeminiFakeState> = {}) {
    this.dir = join(root, 'gemini-scenario')
    this.log = join(root, 'gemini.log.jsonl')
    this.geminiHome = join(root, 'gemini-home')
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(join(this.geminiHome, '.gemini'), { recursive: true })
    this.#state = { ...DEFAULT_STATE, ...state }
    this.#write()
  }

  /**
   * `vendors.gemini.env`: the fake's scenario and log, and a private GEMINI_CLI_HOME (never ~/.gemini), also bound as
   * the scripts' `$GEMINI_CLI_HOME` (the plan file exit_plan_mode names).
   */
  get env(): Record<string, string> {
    return {
      FAKE_CLI_SCRIPT: this.dir,
      FAKE_CLI_LOG: this.log,
      FAKE_CLI_TIMEOUT_MS: '30000',
      GEMINI_CLI_HOME: this.geminiHome,
      FAKE_VAR_GEMINI_CLI_HOME: this.geminiHome,
    }
  }

  get state(): Readonly<GeminiFakeState> {
    return this.#state
  }

  /** Change what the next Gemini processes answer. */
  set(patch: Partial<GeminiFakeState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#write()
  }

  entries(): FakeLogEntry[] {
    return readFakeLog(this.log)
  }

  /** Every `gemini --acp` the app started: its argv and folder (the resolver's `--version` and `--help` left out). */
  starts(): { pid: number; argv: string[]; cwd: string }[] {
    return this.entries()
      .filter((e) => e.kind === 'start' && Array.isArray(e['argv']))
      .map((e) => ({
        pid: e.pid,
        argv: e['argv'] as string[],
        cwd: typeof e['cwd'] === 'string' ? e['cwd'] : '',
      }))
      .filter((s) => s.argv.includes('--acp'))
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
        // not JSON: the fake reports it as a mismatch
      }
    }
    return out
  }

  /** Requests and notifications of one method, in order. */
  calls(method: string): { pid: number; params: Record<string, unknown> }[] {
    return this.messages()
      .filter((m) => m.msg['method'] === method)
      .map((m) => ({ pid: m.pid, params: (m.msg['params'] ?? {}) as Record<string, unknown> }))
  }

  /** The app's answers to the agent's requests (session/request_permission): the optionId it chose, in order. */
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

  /** The pid of the pass that ran set_mode `modeId` (the first one). */
  pidOfMode(modeId: string): number | undefined {
    return this.calls('session/set_mode').find((c) => c.params['modeId'] === modeId)?.pid
  }

  /** Mismatches and script errors the fake logged (it exits 99/98/97 on them). */
  errors(): FakeLogEntry[] {
    return this.entries().filter((e) => e.kind === 'error')
  }

  #write(): void {
    const s = this.#state
    const creds = join(this.geminiHome, '.gemini', 'oauth_creds.json')
    // A stand-in for a Google sign-in: Dim Factory checks that the file exists, never what it holds.
    if (s.login === 'in') writeFileSync(creds, '{}\n')
    else rmSync(creds, { force: true })
    const file = (name: string, ops: readonly Op[]): string => {
      const path = join(this.dir, `${name}.script.jsonl`)
      writeFileSync(path, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
      return path
    }
    const version = file('version', [
      { op: 'stdout', line: s.version },
      { op: 'exit', code: 0 },
    ])
    const help = file('help', [...HELP_TEXT.map((line) => ({ op: 'stdout', line })), { op: 'exit', code: 0 }])
    const agent = file('acp', this.#agentOps())
    const entries = [
      { match: { argvIncludes: ['--version'] }, script: version, repeat: true },
      { match: { argvIncludes: ['--help'] }, script: help, repeat: true },
      { match: { argvIncludes: ['--acp'] }, script: agent, repeat: true },
    ]
    writeFileSync(join(this.dir, 'scenario.json'), JSON.stringify(entries, null, 2))
  }

  #agentOps(): Op[] {
    const s = this.#state
    const modeCases: Op[] = []
    const tail: Op[] = []
    const pass = (modeId: string, label: string, ops: Op[] | undefined): void => {
      if (ops === undefined) return
      modeCases.push({
        match: { method: 'session/set_mode', id: '$mode', params: { sessionId: SESSION, modeId } },
        goto: label,
      })
      tail.push({ op: 'label', name: label }, ...ops)
    }
    pass('plan', 'plan', s.plan)
    pass('default', 'readOnly', s.readOnly)
    pass('autoEdit', 'edit', s.edit)
    const probeAnswer: Op[] =
      s.login === 'in'
        ? [
            {
              op: 'rpcResult',
              id: '$new',
              result: { sessionId: 'gemini-probe-${FAKE_PID}', modes: GEMINI_MODES, models: GEMINI_MODELS },
            },
          ]
        : [{ op: 'rpcError', id: '$new', error: { code: -32000, message: 'Authentication required' } }]
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
      { op: 'rpcResult', id: '$init', result: INITIALIZE_RESULT },
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
          { match: { method: 'session/new', id: '$new', params: { mcpServers: [] } }, goto: 'new' },
          ...(s.load !== undefined
            ? [
                {
                  match: {
                    method: 'session/load',
                    id: '$load',
                    params: { sessionId: LOADED_SESSION, mcpServers: [] },
                  },
                  goto: 'load',
                },
              ]
            : []),
        ],
      },
      { op: 'label', name: 'probe' },
      ...(s.probeDelayMs !== undefined ? [{ op: 'sleep', ms: s.probeDelayMs }] : []),
      ...probeAnswer,
      { op: 'goto', label: 'next' },
      { op: 'label', name: 'new' },
      s.login === 'in'
        ? {
            op: 'rpcResult',
            id: '$new',
            result: { sessionId: SESSION, modes: GEMINI_MODES, models: GEMINI_MODELS },
          }
        : { op: 'rpcError', id: '$new', error: { code: -32000, message: 'Authentication required' } },
      { op: 'onStdinEof', goto: 'end' },
      { op: 'branch', on: 'stdin', timeoutMs: 60_000, cases: modeCases },
      ...tail,
      ...(s.load !== undefined ? [{ op: 'label', name: 'load' }, ...s.load] : []),
      { op: 'label', name: 'end' },
      { op: 'exit', code: 0 },
    ]
  }
}
