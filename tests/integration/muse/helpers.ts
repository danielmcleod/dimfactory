// Shared setup for the Muse adapter integration tests (fixture replay goes through the real resolver
// and spawn path: the fake CLI behind an npm-style muse.cmd shim on win32 or a shebang copy on POSIX; the fake checks the
// prompt file the adapter wrote and exits 99 on a mismatch). The adapter only ever sees its configured fake (search
// 'configured'), so no test can find or run a real Muse, and every test has its own DIM_FACTORY_HOME.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { buildFakeCli } from '../../../scripts/build-fake-cli.mjs'
import type { FakeCliBuild } from '../../../scripts/build-fake-cli.mjs'
import type { MuseAdapter, MuseAdapterOptions } from '../../../src/core/adapters/muse/index.ts'
import { createMuseAdapter } from '../../../src/core/adapters/muse/index.ts'
import type { ExitInfo, RunHandle, StartOptions } from '../../../src/core/adapters/types.ts'
import { USAGE_FIELDS } from '../../../src/core/adapters/usage.ts'
import type { AdapterSignal, NormalizedEvent } from '../../../src/shared/events.ts'

export const MUSE_FIXTURES = fileURLToPath(new URL('../../fixtures/muse/', import.meta.url))

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
    const launcher = process.platform === 'win32' ? build.launchers.cmd?.muse : build.launchers.sh?.muse
    if (launcher === undefined) throw new Error('fake CLI launcher missing for this OS')
    return { build, launcher, pathEnv: [build.dir, dirname(process.execPath)].join(delimiter) }
  })()
  return memo
}

export function tempDir(prefix = 'muse-it-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** process.env without the developer's Muse settings and test-runner leftovers. */
export function hermeticEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(META_|MUSE_|FAKE_CLI_|FAKE_VAR_|REPLAY_|VITEST|NODE_OPTIONS$|DIM_FACTORY_HOME$)/i.test(k))
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

export const MUSE_VERSION_LINE = 'muse 1.4.2-R4102.1'

/** `muse exec --help` as a CLI prints it (the options the probe looks for). */
export const EXEC_HELP = [
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
].join('\n')

/** A schema `muse schema` could print (any JSON: the probe compares hashes). */
export const SCHEMA_JSON = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Muse records',
  oneOf: [
    { properties: { payload_type: { const: 'run.output.delta' } } },
    { properties: { payload_type: { pattern: '^run.terminal' } } },
    { properties: { payload_type: { pattern: '^task.lifecycle' } } },
    { properties: { payload_type: { const: 'tool.result' } } },
  ],
})

const lines = (text: string): Op[] => text.split('\n').map((line) => ({ op: 'stdout', line }))

export const VERSION_ENTRY: ScenarioEntry = {
  match: { argvIncludes: ['--version'] },
  script: [
    { op: 'stdout', line: MUSE_VERSION_LINE },
    { op: 'exit', code: 0 },
  ],
  repeat: true,
}
export const HELP_ENTRY: ScenarioEntry = {
  match: { argvIncludes: ['exec', '--help'] },
  script: [...lines(EXEC_HELP), { op: 'exit', code: 0 }],
  repeat: true,
}
export const SCHEMA_ENTRY: ScenarioEntry = {
  match: { argvIncludes: ['schema'] },
  script: [
    { op: 'stdout', line: SCHEMA_JSON },
    { op: 'exit', code: 0 },
  ],
  repeat: true,
}

/** A scenario directory for FAKE_CLI_SCRIPT; `--version` answers 1.4.2 unless `version: false`. */
export function scenario(entries: ScenarioEntry[], o: { version?: boolean } = {}): string {
  const dir = tempDir('muse-scenario-')
  const all: ScenarioEntry[] = [...(o.version === false ? [] : [VERSION_ENTRY]), ...entries]
  const json = all.map((e, i) => {
    let script = e.script
    if (Array.isArray(script)) {
      const file = join(dir, `s${i}.script.jsonl`)
      writeFileSync(file, `${script.map((op) => JSON.stringify(op)).join('\n')}\n`)
      script = file
    }
    return { match: e.match, script, repeat: e.repeat ?? false }
  })
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(json, null, 2))
  return dir
}

export interface FakeMuse {
  adapter: MuseAdapter
  log: string
  dimFactoryHome: string
  /** The fake's log entries so far. */
  logEntries(): Record<string, unknown>[]
  /** The argv of every process the fake started. */
  starts(): string[][]
}

/** A Muse adapter whose binary is the fake (its own DIM_FACTORY_HOME, probe cwd and fixed PATH). */
export function fakeMuse(
  setup: FakeSetup,
  scenarioDir: string,
  o: { adapter?: Partial<MuseAdapterOptions>; env?: Record<string, string> } = {},
): FakeMuse {
  const log = join(tempDir('muse-log-'), 'fake.log')
  const dimFactoryHome = tempDir('muse-home-')
  const adapter = createMuseAdapter({
    configuredPath: setup.launcher,
    search: 'configured',
    pathEnv: setup.pathEnv,
    home: tempDir('muse-userhome-'),
    dimFactoryHome,
    probeCwd: tempDir('muse-probe-'),
    env: hermeticEnv(o.env),
    now: () => 1000,
    timing: { exitAfterTerminalMs: 3_000, stopStdinMs: 500 },
    ...o.adapter,
    vendorEnv: {
      FAKE_CLI_SCRIPT: scenarioDir,
      FAKE_CLI_LOG: log,
      FAKE_CLI_TIMEOUT_MS: '20000',
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
    dimFactoryHome,
    logEntries,
    starts: () =>
      logEntries()
        .filter((e) => e['kind'] === 'start' && Array.isArray(e['argv']))
        .map((e) => e['argv'] as string[]),
  }
}

export type Entry = NormalizedEvent | AdapterSignal

export interface Driven {
  handle: RunHandle
  entries: Entry[]
  exit: ExitInfo
  stopped?: Promise<void>
}

/** Start, optionally stop after an event, collect everything. Muse never asks: an ask fails the test. */
export async function drive(
  adapter: MuseAdapter,
  o: StartOptions,
  opts: { stopAfter?: (e: NormalizedEvent) => boolean; stopReason?: 'user' | 'timeout' } = {},
): Promise<Driven> {
  const handle = adapter.start(o)
  const entries: Entry[] = []
  let stopped: Promise<void> | undefined
  handle.onSignal((s) => entries.push(s))
  handle.onEvent((e) => {
    entries.push(e)
    if (stopped === undefined && opts.stopAfter?.(e) === true) {
      stopped = adapter.stop(handle, opts.stopReason ?? 'user')
    }
  })
  const exit = await handle.exited
  if (stopped !== undefined) await stopped
  // Events reach a late subscriber on a microtask: let them land.
  await new Promise((r) => setTimeout(r, 0))
  return stopped === undefined ? { handle, entries, exit } : { handle, entries, exit, stopped }
}

const EVENT_TYPES = new Set(['session', 'text', 'tool', 'ask', 'done', 'error'])
export const eventsOf = (list: readonly Entry[]): NormalizedEvent[] =>
  list.filter((e): e is NormalizedEvent => EVENT_TYPES.has(e.type))

export const terminals = (list: readonly Entry[]): Entry[] =>
  list.filter((e) => e.type === 'done' || (e.type === 'error' && e.fatal))

/**
 * The adapter contract invariants: exactly one terminal event (the last event); no ask at all (Muse relays nothing);
 * per-pass usage ≥ 0; `session` before `done`.
 */
export function checkInvariants(d: Pick<Driven, 'entries'>): void {
  const events = eventsOf(d.entries)
  const terms = terminals(d.entries)
  expect(terms).toHaveLength(1)
  expect(events.at(-1)).toBe(terms[0])
  expect(events.filter((e) => e.type === 'ask')).toEqual([])
  expect(d.entries.filter((e) => e.type === 'auto-answered')).toEqual([])
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

// ---- recorded / synthesized fixtures ---------------------------------------------------------------------------

export interface FixturePass {
  kind: 'pass'
  route: 'exec'
  step: StartOptions['step']
  mode: StartOptions['mode']
  planNative: boolean
  trustFolder: boolean
  prompt: string
}

export interface Fixture {
  id: string
  dir: string
  recording: string
  header: Record<string, unknown> & { argv: string[]; pass: FixturePass; synthesized?: boolean }
  frames: Record<string, unknown>[]
  expected: unknown[]
}

export function fixtureIds(): string[] {
  return readdirSync(join(MUSE_FIXTURES, 'exec'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function loadFixture(id: string): Fixture {
  const dir = join(MUSE_FIXTURES, 'exec', id)
  const recording = join(dir, 'recording.jsonl')
  const all = readFileSync(recording, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  return {
    id,
    dir,
    recording,
    header: all[0] as Fixture['header'],
    frames: all.slice(1),
    expected: JSON.parse(readFileSync(join(dir, 'expected.events.json'), 'utf8')) as unknown[],
  }
}

/** StartOptions that make the adapter run the pass the recording's host ran. */
export function startOptionsFor(f: Fixture, cwd: string, runId = '20261011T120000Z-a1b2'): StartOptions {
  const p = f.header.pass
  return {
    runId,
    step: p.step,
    cwd,
    prompt: p.prompt,
    mode: p.mode,
    planNative: p.planNative,
    allowRules: [],
    askTimeoutMs: 600_000,
    trustFolder: p.trustFolder,
  }
}

/** A scenario that answers `--version` and replays the fixture for any other invocation. */
export function replayScenario(f: Fixture): string {
  return scenario([{ match: {}, script: f.recording, repeat: true }])
}
