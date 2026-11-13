// Shared setup for the Codex adapter integration tests (fixture replay goes through the real
// resolver and spawn path, the fake CLI behind an npm-style .cmd shim on win32 or a shebang copy on POSIX).
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import type { FakeCliBuild } from '../../../../scripts/build-fake-cli.mjs'
import type { CodexFacts } from '../../../../src/core/adapters/codex/capabilities.ts'
import type { CodexAdapter, CodexAdapterOptions } from '../../../../src/core/adapters/codex/index.ts'
import { accountModelsOf } from '../../../../src/core/adapters/codex/default-model.ts'
import { createCodexAdapter } from '../../../../src/core/adapters/codex/index.ts'
import { toModelInfo } from '../../../../src/core/adapters/codex/probe.ts'
import type {
  AskCancelReason,
  ExitInfo,
  RunHandle,
  StartOptions,
} from '../../../../src/core/adapters/types.ts'
import { USAGE_FIELDS, addUsage } from '../../../../src/core/adapters/usage.ts'
import { realPathSync } from '../../../../src/core/real-path.ts'
import type { AdapterSignal, AskDecision, NormalizedEvent, Usage } from '../../../../src/shared/events.ts'
import type { ModelInfo } from '../../../../src/shared/vendors.ts'
import { FIXTURES_ROOT } from '../../../live-fixtures.ts'

/** tests/fixtures/codex (synthesized), or the live recordings under DIM_FACTORY_LIVE_FIXTURES=1 (tests/live-fixtures.ts). */
export const FIXTURES = join(FIXTURES_ROOT, 'codex')
export const COMMITTED_SCHEMA = fileURLToPath(
  new URL('../../../../src/core/adapters/codex/protocol/v0.160.0/schema/', import.meta.url),
)

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
    const launcher = process.platform === 'win32' ? build.launchers.cmd?.codex : build.launchers.sh?.codex
    if (launcher === undefined) throw new Error('fake CLI launcher missing for this OS')
    return { build, launcher, pathEnv: [build.dir, dirname(process.execPath)].join(delimiter) }
  })()
  return memo
}

export function tempDir(prefix = 'codex-it-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** process.env without the developer's Codex/OpenAI settings and test-runner leftovers. */
export function hermeticEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(OPENAI_|CODEX_|FAKE_CLI_|FAKE_VAR_|REPLAY_|VITEST|NODE_OPTIONS$)/i.test(k)) delete env[k]
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

export const VERSION_OPS: Op[] = [
  { op: 'stdout', line: 'codex-cli 0.160.1' },
  { op: 'exit', code: 0 },
]

/** A scenario directory for FAKE_CLI_SCRIPT; `--version` always answers 0.160.1. */
export function scenario(entries: ScenarioEntry[]): string {
  const dir = tempDir('codex-scenario-')
  const all: ScenarioEntry[] = [
    { match: { argvIncludes: ['--version'] }, script: VERSION_OPS, repeat: true },
    ...entries,
  ]
  const json = all.map((e, i) => {
    let script = e.script
    if (Array.isArray(script)) {
      const file = join(dir, `s${i}.script.jsonl`)
      writeFileSync(file, `${script.map((o) => JSON.stringify(o)).join('\n')}\n`)
      script = file
    }
    return { match: e.match, script, repeat: e.repeat ?? false }
  })
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(json, null, 2))
  return dir
}

export interface FakeCodex {
  adapter: CodexAdapter
  log: string
  /** The fake's log entries so far. */
  logEntries(): Record<string, unknown>[]
  /** The JSON-RPC (or stdin) lines the fake read, parsed where possible. */
  stdinLines(): unknown[]
}

/** A Codex adapter whose binary is the fake (temp home, probe cwd and tmp dir; a fixed PATH). */
export function fakeCodex(
  setup: FakeSetup,
  scenarioDir: string,
  o: { facts?: Partial<CodexFacts>; platform?: NodeJS.Platform; adapter?: Partial<CodexAdapterOptions> } = {},
): FakeCodex {
  const log = join(tempDir('codex-log-'), 'fake.log')
  const adapter = createCodexAdapter({
    configuredPath: setup.launcher,
    pathEnv: setup.pathEnv,
    home: tempDir('codex-home-'),
    probeCwd: tempDir('codex-probe-'),
    tmpDir: tempDir('codex-tmp-'),
    env: hermeticEnv(),
    platform: o.platform ?? 'linux',
    now: () => 1000,
    timing: { exitAfterTerminalMs: 3_000, stopTurnMs: 3_000, fatalErrorWaitMs: 2_000 },
    ...(o.facts !== undefined ? { initialFacts: o.facts } : {}),
    ...o.adapter,
    vendorEnv: {
      FAKE_CLI_SCRIPT: scenarioDir,
      FAKE_CLI_LOG: log,
      FAKE_CLI_TIMEOUT_MS: '20000',
      CODEX_HOME: tempDir('codex-codexhome-'),
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
  adapter: CodexAdapter,
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

export const terminals = (list: readonly Entry[]): Entry[] =>
  list.filter((e) => e.type === 'done' || (e.type === 'error' && e.fatal))

/**
 * The adapter contract invariants: exactly one terminal event (the last event); every ask answered or withdrawn exactly
 * once; zero asks in read-only passes; per-pass usage ≥ 0; `session` before `done`.
 */
export function checkInvariants(d: Pick<Driven, 'entries' | 'answered'>, o: { readOnly: boolean }): void {
  const events = eventsOf(d.entries)
  const terms = terminals(d.entries)
  expect(terms).toHaveLength(1)
  expect(events.at(-1)).toBe(terms[0])
  const asks = events.flatMap((e) => (e.type === 'ask' ? [e.requestId] : []))
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
  const done = events.findIndex((e) => e.type === 'done')
  if (done !== -1) {
    const session = events.findIndex((e) => e.type === 'session')
    expect(session).toBeGreaterThanOrEqual(0)
    expect(session).toBeLessThan(done)
  }
}

export function sumUsage(list: readonly Usage[]): Usage {
  return list.reduce((a, b) => addUsage(a, b), { input: 0, output: 0 } as Usage)
}

// ---- recorded / synthesized fixtures ---------------------------------------------------------------------------

export interface FixturePass {
  kind: 'pass' | 'probe' | 'listModels' | 'vendorSetup'
  route?: 'exec'
  step?: StartOptions['step']
  mode?: StartOptions['mode']
  planNative?: boolean
  /** Research: the pass may search the web (StartOptions.web). */
  web?: boolean
  prompt?: string
  model?: string
  resume?: StartOptions['resume']
  allowRules?: StartOptions['allowRules']
  local?: StartOptions['local']
  answers?: Answer[]
  stop?: { after: { type: string; phase?: string }; reason: 'user' | 'timeout' }
  winSandbox?: CodexFacts['winSandbox']
  /**
   * Live X18a/b: the probe fixture whose model/list answer is this pass's facts (CodexFacts.accountModels), as a
   * probe of that recording leaves them: the pass's first look at the account's models.
   */
  probe?: string
  structured?: boolean
  call?: string
  params?: Record<string, unknown>
  ok?: boolean
}

export interface Fixture {
  id: string
  route: 'app-server' | 'exec'
  dir: string
  recording: string
  header: Record<string, unknown> & { argv?: string[]; pass?: FixturePass }
  frames: Record<string, unknown>[]
  /** The host → CLI lines, parsed. */
  inMessages: unknown[]
  expected?: unknown[]
}

export function fixtureIds(route: 'app-server' | 'exec'): string[] {
  try {
    return readdirSync(join(FIXTURES, route), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

export function loadFixture(route: 'app-server' | 'exec', id: string): Fixture {
  const dir = join(FIXTURES, route, id)
  const recording = join(dir, 'recording.jsonl')
  const lines = readFileSync(recording, 'utf8')
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
    route,
    dir,
    recording,
    header,
    frames,
    inMessages,
    ...(expected !== undefined ? { expected } : {}),
  }
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** The params of the first recorded client request for `method`. */
export function recordedParams(f: Fixture, method: string): Record<string, unknown> | undefined {
  for (const m of f.inMessages) {
    const r = rec(m)
    if (r?.['method'] === method) return rec(r['params']) ?? {}
  }
  return undefined
}

/** What the live CLI answered to a recording's first request for `method` (a `result`), else undefined. */
export function recordedAnswer(f: Fixture, method: string): Record<string, unknown> | undefined {
  const req = f.inMessages.find((m) => rec(m)?.['method'] === method && rec(m)?.['id'] !== undefined)
  const id = rec(req)?.['id']
  if (id === undefined) return undefined
  for (const fr of f.frames) {
    if (fr['dir'] !== 'out' || typeof fr['line'] !== 'string') continue
    let msg: Record<string, unknown> | undefined
    try {
      msg = rec(JSON.parse(fr['line']))
    } catch {
      continue
    }
    if (msg?.['id'] === id && msg['result'] !== undefined) return rec(msg['result'])
  }
  return undefined
}

/**
 * The facts a pass's header names (`pass.probe`): what a probe of that fixture leaves for a pass with no model of its
 * own (the picker's model/list answer as CodexFacts.accountModels). Empty when the header names no probe.
 */
export function probeFactsFor(f: Fixture): Partial<CodexFacts> {
  const id = f.header.pass?.probe
  if (id === undefined) return {}
  const probe = loadFixture('app-server', id)
  const data = recordedAnswer(probe, 'model/list')?.['data']
  if (!Array.isArray(data)) throw new Error(`${f.id}: ${id} has no model/list answer`)
  const models = data.map(toModelInfo).filter((m): m is ModelInfo => m !== undefined)
  const accountModels = accountModelsOf(models)
  if (accountModels === undefined) throw new Error(`${f.id}: ${id}'s model/list names no single default`)
  return { accountModels }
}

/** StartOptions that make the adapter talk to the CLI the way the recording's host did. */
export function startOptionsFor(f: Fixture, cwd: string): StartOptions {
  const p = f.header.pass ?? { kind: 'pass' }
  const thread = recordedParams(f, 'thread/start') ?? recordedParams(f, 'thread/resume')
  const turn = recordedParams(f, 'turn/start')
  const text = rec((turn?.['input'] as unknown[] | undefined)?.[0])?.['text']
  const execPrompt = f.route === 'exec' ? f.inMessages.find((m) => typeof m === 'string') : undefined
  const model = p.model ?? (typeof thread?.['model'] === 'string' ? thread['model'] : undefined)
  const append = thread?.['developerInstructions']
  const schema = rec(turn?.['outputSchema'])
  // X24: the post-compaction reminder the recording steered the turn with (the adapter sends the same text).
  const steer = rec((recordedParams(f, 'turn/steer')?.['input'] as unknown[] | undefined)?.[0])?.['text']
  return {
    runId: 'run-replay',
    step: p.step ?? 'implement',
    cwd,
    prompt: typeof text === 'string' ? text : typeof execPrompt === 'string' ? execPrompt : (p.prompt ?? ''),
    mode: p.mode ?? 'autoedit',
    planNative: p.planNative ?? false,
    allowRules: p.allowRules ?? [],
    askTimeoutMs: 600_000,
    trustFolder: false,
    ...(model !== undefined && p.local === undefined ? { model } : {}),
    ...(typeof append === 'string' ? { systemAppend: append } : {}),
    ...(p.resume !== undefined ? { resume: p.resume } : {}),
    ...(p.local !== undefined ? { local: p.local } : {}),
    ...(schema !== undefined ? { outputSchema: schema } : {}),
    ...(p.step === 'catalog' ? { web: true, ephemeral: true } : {}),
    ...(p.step === 'research' && p.web === true ? { web: true } : {}),
    ...(typeof steer === 'string' ? { compactionReminder: () => Promise.resolve(steer) } : {}),
  }
}

/** A scenario that answers `--version` and replays the fixture for any other invocation. */
export function replayScenario(f: Fixture, extra: ScenarioEntry[] = []): string {
  return scenario([...extra, { match: {}, script: passRecording(f), repeat: true }])
}

/** Client requests a recording may go on with that Dim Factory never sends (X21: a manual compaction). */
const NOT_SENT = new Set(['thread/compact/start'])

/**
 * The recording the adapter's pass replays: the whole recording, or, when it goes on with a request Dim Factory never
 * sends (X21's thread/compact/start after the pass's turn), its frames up to that request, then the host's close and
 * the exit. The rest is checked through the normalizer (tests/unit/context/fixtures.test.ts).
 */
export function passRecording(f: Fixture): string {
  const cut = f.frames.findIndex((fr) => {
    if (fr['dir'] !== 'in' || typeof fr['line'] !== 'string') return false
    try {
      return NOT_SENT.has(String((JSON.parse(fr['line']) as { method?: unknown }).method))
    } catch {
      return false
    }
  })
  if (cut < 0) return f.recording
  const exit = f.frames.find((fr) => fr['dir'] === 'exit') ?? { t: 0, dir: 'exit', code: 0, signal: null }
  const lines = [f.header, ...f.frames.slice(0, cut), { t: 0, dir: 'eof' }, exit].map((x) =>
    JSON.stringify(x),
  )
  const file = join(tempDir('codex-pass-'), 'recording.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

/**
 * The replay's pass folder back to the recording's `<CWD>` placeholder in every string of `value` (the fake names the
 * pass folder where the live CLI named the sandbox, FAKE_CLI_OUT_CWD; a live agent message links files by their
 * absolute path, X03a). The fake names it by its getcwd(), the real path (macOS /private/var for the /var folder the
 * host gave it), so both spellings are mapped, the longer first.
 */
export function withCwdPlaceholder<T>(value: T, cwd: string): T {
  const spellings = [...new Set([cwd, realPathSync(cwd)].flatMap((c) => [c, c.split('\\').join('/')]))].sort(
    (a, b) => b.length - a.length,
  )
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return spellings.reduce((s, c) => s.split(c).join('<CWD>'), v)
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}
