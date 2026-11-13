// Shared setup for the ACP base + Gemini adapter integration tests (fixture replay goes through the real resolver
// and spawn path: the fake CLI behind an npm-style gemini.cmd shim on win32 (run as system `node <entry>`) or a
// shebang copy on POSIX; the fake deep-compares every host frame and exits 99 on a mismatch).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import type { FakeCliBuild } from '../../../../scripts/build-fake-cli.mjs'
import type { AcpAdapterOptions } from '../../../../src/core/adapters/acp-base/index.ts'
import type { GeminiAdapter } from '../../../../src/core/adapters/gemini/index.ts'
import { createGeminiAdapter } from '../../../../src/core/adapters/gemini/index.ts'
import type {
  AskCancelReason,
  ExitInfo,
  RunHandle,
  StartOptions,
} from '../../../../src/core/adapters/types.ts'
import { USAGE_FIELDS } from '../../../../src/core/adapters/usage.ts'
import type { AdapterSignal, AskDecision, NormalizedEvent } from '../../../../src/shared/events.ts'

export const GEMINI_FIXTURES = fileURLToPath(new URL('../../../fixtures/gemini/', import.meta.url))

export interface FakeSetup {
  build: FakeCliBuild
  /** What a user install exposes: the npm-style .cmd shim on win32, the shebang copy on POSIX. */
  launcher: string
  pathEnv: string
}

let memo: Promise<FakeSetup> | undefined

export function fakeSetup(): Promise<FakeSetup> {
  memo ??= (async () => {
    const build = await buildFakeCli()
    const launcher = process.platform === 'win32' ? build.launchers.cmd?.gemini : build.launchers.sh?.gemini
    if (launcher === undefined) throw new Error('fake CLI launcher missing for this OS')
    return { build, launcher, pathEnv: [build.dir, dirname(process.execPath)].join(delimiter) }
  })()
  return memo
}

export function tempDir(prefix = 'acp-it-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** process.env without the developer's Gemini/Google settings and test-runner leftovers. */
export function hermeticEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(GEMINI_|GOOGLE_|FAKE_CLI_|FAKE_VAR_|REPLAY_|VITEST|NODE_OPTIONS$|DIM_FACTORY_HOME$)/i.test(k))
      delete env[k]
  }
  return { ...env, ...extra }
}

export type Op = Record<string, unknown>

export interface ScenarioEntry {
  match: { argvIncludes?: string[]; argvExcludes?: string[] }
  /** Script ops, or the path of a script / recording. */
  script: Op[] | string
  repeat?: boolean
}

export const GEMINI_VERSION = '0.62.0'

/** `gemini --help` as the CLI's yargs prints it (the options the probe looks for). */
export const HELP_TEXT = [
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

export const helpOps = (lines: readonly string[] = HELP_TEXT): Op[] => [
  ...lines.map((line) => ({ op: 'stdout', line })),
  { op: 'exit', code: 0 },
]

/** A scenario directory for FAKE_CLI_SCRIPT; `--version` answers {@link GEMINI_VERSION}, `--help` the help text. */
export function scenario(
  entries: ScenarioEntry[],
  o: { version?: string; help?: readonly string[] } = {},
): string {
  const dir = tempDir('gemini-scenario-')
  const all: ScenarioEntry[] = [
    {
      match: { argvIncludes: ['--version'] },
      script: [
        { op: 'stdout', line: o.version ?? GEMINI_VERSION },
        { op: 'exit', code: 0 },
      ],
      repeat: true,
    },
    { match: { argvIncludes: ['--help'] }, script: helpOps(o.help), repeat: true },
    ...entries,
  ]
  const json = all.map((e, i) => {
    let script = e.script
    if (Array.isArray(script)) {
      const file = join(dir, `s${i}.script.jsonl`)
      writeFileSync(file, `${script.map((x) => JSON.stringify(x)).join('\n')}\n`)
      script = file
    }
    return { match: e.match, script, repeat: e.repeat ?? false }
  })
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(json, null, 2))
  return dir
}

export interface FakeGemini {
  adapter: GeminiAdapter
  log: string
  home: string
  dimFactoryHome: string
  logEntries(): Record<string, unknown>[]
  /** The JSON-RPC lines the fake read, parsed. */
  stdinLines(): unknown[]
  /** The argv of each start (after the script name). */
  starts(): string[][]
}

/** A Gemini adapter whose binary is the fake (temp home, DIM_FACTORY_HOME and probe folder; a fixed PATH). */
export function fakeGemini(
  setup: FakeSetup,
  scenarioDir: string,
  o: { adapter?: Partial<AcpAdapterOptions>; vendorEnv?: Record<string, string> } = {},
): FakeGemini {
  const log = join(tempDir('gemini-log-'), 'fake.log')
  const home = tempDir('gemini-home-')
  const dimFactoryHome = tempDir('gemini-dim-factory-')
  const probeCwd = join(dimFactoryHome, 'tmp', 'probe-cwd')
  mkdirSync(probeCwd, { recursive: true })
  const adapter = createGeminiAdapter({
    configuredPath: setup.launcher,
    pathEnv: setup.pathEnv,
    home,
    dimFactoryHome,
    probeCwd,
    env: hermeticEnv(),
    now: () => 1000,
    timing: { exitAfterTerminalMs: 3_000, stopTurnMs: 3_000, planCancelMs: 5_000 },
    ...o.adapter,
    vendorEnv: {
      FAKE_CLI_SCRIPT: scenarioDir,
      FAKE_CLI_LOG: log,
      FAKE_CLI_TIMEOUT_MS: '20000',
      // Gemini's own home override: never the developer's ~/.gemini.
      GEMINI_CLI_HOME: home,
      ...o.vendorEnv,
      ...o.adapter?.vendorEnv,
    },
  })
  const logEntries = (): Record<string, unknown>[] => {
    try {
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
      return []
    }
  }
  return {
    adapter,
    log,
    home,
    dimFactoryHome,
    logEntries,
    stdinLines: () =>
      logEntries()
        .filter((e) => e['kind'] === 'stdin' && typeof e['line'] === 'string')
        .map((e) => {
          try {
            return JSON.parse(e['line'] as string) as unknown
          } catch {
            return e['line']
          }
        }),
    starts: () =>
      logEntries()
        .filter((e) => e['kind'] === 'start')
        .map((e) => (e['argv'] as string[] | undefined) ?? []),
  }
}

export type Entry = NormalizedEvent | AdapterSignal

export interface Answer {
  decision: AskDecision
  why?: AskCancelReason
}

export interface Driven {
  handle: RunHandle
  entries: Entry[]
  exit: ExitInfo
  answered: string[]
  stopped?: Promise<void>
}

/** Start, answer each ask in order, optionally stop after an event, collect everything. */
export async function drive(
  adapter: GeminiAdapter,
  o: StartOptions,
  answers: readonly Answer[] = [],
  opts: { stopAfter?: (e: NormalizedEvent) => boolean; stopReason?: 'user' | 'timeout' } = {},
): Promise<Driven> {
  const handle = adapter.start(o)
  const entries: Entry[] = []
  const answered: string[] = []
  let next = 0
  let stopped: Promise<void> | undefined
  handle.onSignal((s) => entries.push(s))
  handle.onEvent((e) => {
    entries.push(e)
    if (e.type === 'ask') {
      const a = answers[next++]
      if (a !== undefined) {
        answered.push(e.requestId)
        adapter.answer(handle, e.requestId, a.decision, a.why)
      }
    }
    if (stopped === undefined && opts.stopAfter?.(e) === true) {
      stopped = adapter.stop(handle, opts.stopReason ?? 'user')
    }
  })
  const exit = await handle.exited
  if (stopped !== undefined) await stopped
  return stopped === undefined
    ? { handle, entries, exit, answered }
    : { handle, entries, exit, answered, stopped }
}

const EVENT_TYPES = new Set(['session', 'text', 'tool', 'ask', 'done', 'error'])
export const eventsOf = (list: readonly Entry[]): NormalizedEvent[] =>
  list.filter((e): e is NormalizedEvent => EVENT_TYPES.has(e.type))
export const signalsOf = (list: readonly Entry[]): AdapterSignal[] =>
  list.filter(
    (e): e is AdapterSignal =>
      !EVENT_TYPES.has(e.type) && e.type !== 'liveness' && e.type !== 'shell-command',
  )

export const terminals = (list: readonly Entry[]): Entry[] =>
  list.filter((e) => e.type === 'done' || (e.type === 'error' && e.fatal))

/**
 * The adapter contract invariants: exactly one terminal event (the last event); no double-printed text; every ask
 * answered or withdrawn exactly once; zero asks in read-only passes; per-pass usage ≥ 0; `session` before `done`.
 */
export function checkInvariants(d: Pick<Driven, 'entries' | 'answered'>, o: { readOnly: boolean }): void {
  const events = eventsOf(d.entries)
  const terms = terminals(d.entries)
  expect(terms).toHaveLength(1)
  expect(events.at(-1)).toBe(terms[0])
  const asks = events.flatMap((e) => (e.type === 'ask' ? [e.requestId] : []))
  expect(new Set(asks).size).toBe(asks.length)
  const withdrawn = d.entries.flatMap((e) => (e.type === 'ask-withdrawn' ? [e.requestId] : []))
  for (const id of asks) {
    const n =
      d.answered.filter((a) => a === id).length +
      withdrawn.filter((w) => w === id && !d.answered.includes(id)).length
    expect(n, `ask ${id} answered or withdrawn once`).toBe(1)
  }
  const auto = d.entries.flatMap((e) => (e.type === 'auto-answered' ? [e.requestId] : []))
  for (const id of auto) expect(asks).not.toContain(id)
  if (o.readOnly) expect(asks).toEqual([])
  for (const e of events) {
    if (e.type !== 'done' || e.usage === undefined) continue
    for (const f of USAGE_FIELDS) expect(e.usage[f] ?? 0).toBeGreaterThanOrEqual(0)
  }
  // No double-printed text: a done result is the text since the last tool event, never repeated in the stream.
  const done = events.findIndex((e) => e.type === 'done')
  if (done !== -1) {
    const session = events.findIndex((e) => e.type === 'session')
    expect(session).toBeGreaterThanOrEqual(0)
    expect(session).toBeLessThan(done)
    const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
    const result = (events[done] as Extract<NormalizedEvent, { type: 'done' }>).result
    if (result !== '' && text.includes(result)) {
      expect(text.indexOf(result)).toBe(text.lastIndexOf(result))
    }
  }
  // Tool cards: each id starts once and ends at most once (tool_call deduped by toolCallId).
  const tools = events.filter((e): e is Extract<NormalizedEvent, { type: 'tool' }> => e.type === 'tool')
  const ids = new Set(tools.map((t) => t.id))
  for (const id of ids) {
    expect(tools.filter((t) => t.id === id && t.phase === 'start')).toHaveLength(1)
    expect(tools.filter((t) => t.id === id && t.phase === 'end').length).toBeLessThanOrEqual(1)
  }
}

// ---- recordings (the fixture format: a header, then {t, dir, line} frames, then the exit) -------------------------

export interface RecordingHeader {
  scenario: string
  pass?: Record<string, unknown>
  [k: string]: unknown
}

export type Frame = Record<string, unknown>

const line = (v: unknown): string => JSON.stringify(v)

/** Host → agent request (JSON-RPC 2.0). */
export const inReq = (id: number, method: string, params: unknown): Frame => ({
  t: 0,
  dir: 'in',
  line: line({ jsonrpc: '2.0', id, method, params }),
})
/** Host → agent notification. */
export const inNote = (method: string, params: unknown): Frame => ({
  t: 0,
  dir: 'in',
  line: line({ jsonrpc: '2.0', method, params }),
})
/** Host → agent answer to an agent request. */
export const inRes = (id: number | string, result: unknown): Frame => ({
  t: 0,
  dir: 'in',
  line: line({ jsonrpc: '2.0', id, result }),
})
/** Agent → host answer. */
export const outRes = (id: number, result: unknown, t = 0): Frame => ({
  t,
  dir: 'out',
  line: line({ jsonrpc: '2.0', id, result }),
})
export const outErr = (id: number, error: unknown, t = 0): Frame => ({
  t,
  dir: 'out',
  line: line({ jsonrpc: '2.0', id, error }),
})
/** Agent → host notification. */
export const outNote = (method: string, params: unknown, t = 0): Frame => ({
  t,
  dir: 'out',
  line: line({ jsonrpc: '2.0', method, params }),
})
/** Agent → host request (its ids start at 0, the TypeScript SDK's counter). */
export const outReq = (id: number, method: string, params: unknown, t = 0): Frame => ({
  t,
  dir: 'out',
  line: line({ jsonrpc: '2.0', id, method, params }),
})
export const errLine = (text: string): Frame => ({ t: 0, dir: 'err', line: text })
export const eof = (): Frame => ({ t: 0, dir: 'eof' })
export const exitFrame = (code = 0): Frame => ({ t: 0, dir: 'exit', code, signal: null })

/** A recording file in the fixture format (header `"protocol":"jsonrpc"`: the fake replays by message). */
export function recording(header: RecordingHeader, frames: readonly Frame[]): string {
  const dir = tempDir('gemini-rec-')
  const file = join(dir, 'recording.jsonl')
  const head = {
    kind: 'header',
    schemaVersion: 1,
    vendor: 'gemini',
    route: 'acp',
    cliVersion: GEMINI_VERSION,
    protocol: 'jsonrpc',
    ...header,
  }
  writeFileSync(file, `${[head, ...frames].map(line).join('\n')}\n`)
  return file
}

/** A scenario replaying `file` for the ACP invocation (`--acp` in argv). */
export function acpScenario(file: string, extra: ScenarioEntry[] = [], o: { version?: string } = {}): string {
  return scenario([...extra, { match: { argvIncludes: ['--acp'] }, script: file, repeat: true }], o)
}

/** The fake never reported a mismatch (it would have exited 99 and logged an error). */
export function expectNoMismatch(logEntries: Record<string, unknown>[]): void {
  expect(logEntries.filter((e) => e['kind'] === 'error')).toEqual([])
}

// ---- the session frames every pass shares -------------------------------------------------------------------------

export const SESSION = '3f2b9c1e-6a4d-4e8b-9c2f-1a0b7d5e4c31'

export const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'dim-factory', title: 'Dim Factory', version: '0.1.0' },
}

export const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
  },
  authMethods: [
    { id: 'oauth-personal', name: 'Log in with Google', description: null },
    { id: 'gemini-api-key', name: 'Use Gemini API key', description: null },
  ],
}

export const MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default', description: 'Prompts for approval' },
    { id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
    { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
    { id: 'plan', name: 'Plan', description: 'Read-only mode' },
  ],
}

export const MODELS = {
  currentModelId: 'gemini-3-pro-preview',
  availableModels: [
    { modelId: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (preview)' },
    { modelId: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (preview)' },
  ],
}

/** initialize, then session/new answered with the session, the modes and the models. */
export function opening(o: { sessionNew?: boolean } = {}): Frame[] {
  const frames: Frame[] = [inReq(1, 'initialize', INITIALIZE_PARAMS), outRes(1, INITIALIZE_RESULT)]
  if (o.sessionNew !== false) {
    frames.push(
      inReq(2, 'session/new', { cwd: '<CWD>', mcpServers: [] }),
      outRes(2, { sessionId: SESSION, modes: MODES, models: MODELS }),
    )
  }
  return frames
}

export const update = (u: Record<string, unknown>, sessionId = SESSION, t = 0): Frame =>
  outNote('session/update', { sessionId, update: u }, t)
export const chunk = (text: string, t = 0): Frame =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, SESSION, t)

/** The options Gemini offers for an edit or shell confirmation (toPermissionOptions, no permanent approval). */
export const EDIT_OPTIONS = [
  { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
]

export const startOptions = (cwd: string, o: Partial<StartOptions> = {}): StartOptions => ({
  runId: 'run-acp',
  step: 'implement',
  cwd,
  prompt: 'Add a --version flag.',
  mode: 'autoedit',
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
  ...o,
})

// ---- the protocol agent's fixtures (tests/fixtures/gemini/acp/<ID>/) --------------------------------------------

export interface Fixture {
  id: string
  dir: string
  recording: string
  header: Record<string, unknown> & { argv?: string[]; pass?: Record<string, unknown> }
  frames: Record<string, unknown>[]
  inMessages: unknown[]
  expected?: unknown[]
}

export function fixtureIds(route = 'acp'): string[] {
  try {
    return readdirSync(join(GEMINI_FIXTURES, route), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

export function loadFixture(id: string, route = 'acp'): Fixture {
  const dir = join(GEMINI_FIXTURES, route, id)
  const file = join(dir, 'recording.jsonl')
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  const header = (lines[0] ?? {}) as Fixture['header']
  const frames = lines.slice(1)
  const inMessages = frames
    .filter((f) => f['dir'] === 'in' && typeof f['line'] === 'string')
    .map((f) => {
      try {
        return JSON.parse(f['line'] as string) as unknown
      } catch {
        return f['line']
      }
    })
  let expected: unknown[] | undefined
  try {
    expected = JSON.parse(readFileSync(join(dir, 'expected.events.json'), 'utf8')) as unknown[]
  } catch {
    expected = undefined
  }
  return {
    id,
    dir,
    recording: file,
    header,
    frames,
    inMessages,
    ...(expected !== undefined ? { expected } : {}),
  }
}
