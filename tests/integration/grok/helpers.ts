// Shared setup for the Grok adapter integration tests (fixture replay goes through the real
// resolver and spawn path; the fake deep-compares every host frame and exits 99 on a mismatch). The fake CLI stands in
// for the native `grok` behind its npm-style shim (win32) or shebang copy (POSIX); it answers `--version` as Grok does,
// and `agent --help` with the agent options the probe looks for. No test here resolves a real grok or reads a real
// ~/.grok: the fake is the configured path (search 'configured'), and every child gets an empty GROK_HOME.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AcpAdapterOptions } from '../../../src/core/adapters/acp-base/index.ts'
import type { GrokAdapter } from '../../../src/core/adapters/grok/index.ts'
import { createGrokAdapter } from '../../../src/core/adapters/grok/index.ts'
import type { StartOptions } from '../../../src/core/adapters/types.ts'
import type { FakeSetup, Op, ScenarioEntry } from '../acp/adapter/helpers.ts'
import { tempDir } from '../acp/adapter/helpers.ts'

export const GROK_FIXTURES = fileURLToPath(new URL('../../fixtures/grok/', import.meta.url))

export const GROK_VERSION = '1.0.50'

/** `grok --version` as Grok Build prints it (xai-grok-pager-bin version_text: name, version, commit, channel). */
export const VERSION_LINE = `grok ${GROK_VERSION} (3f9c2ab) stable`

/** `grok agent --help` as clap prints it (user guide 15: the agent options and the transports). */
export const AGENT_HELP = [
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

export const helpOps = (lines: readonly string[] = AGENT_HELP): Op[] => [
  ...lines.map((line) => ({ op: 'stdout', line })),
  { op: 'exit', code: 0 },
]

/**
 * A scenario directory for FAKE_CLI_SCRIPT: `--version` answers {@link VERSION_LINE}, `agent --help` the help text,
 * then `entries` (matched on argv, the first that fits).
 */
export function grokScenario(
  entries: ScenarioEntry[],
  o: { version?: readonly string[]; help?: readonly string[] } = {},
): string {
  const dir = tempDir('grok-scenario-')
  const all: ScenarioEntry[] = [
    {
      match: { argvIncludes: ['--version'] },
      script: [
        ...(o.version ?? [VERSION_LINE]).map((line) => ({ op: 'stdout', line })),
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

/** A scenario replaying `file` for the agent invocation (`stdio` in argv). */
export function stdioScenario(file: string, extra: ScenarioEntry[] = []): string {
  return grokScenario([...extra, { match: { argvIncludes: ['stdio'] }, script: file, repeat: true }])
}

/**
 * process.env without the developer's Grok / xAI settings, their CLAUDE_CONFIG_DIR (Grok's read-only scan
 * reads the Claude settings there) and test-runner leftovers.
 */
export function grokHermeticEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) {
    if (
      /^(GROK_|XAI_|CLAUDE_CONFIG_DIR$|FAKE_CLI_|FAKE_VAR_|REPLAY_|VITEST|NODE_OPTIONS$|DIM_FACTORY_HOME$)/i.test(
        k,
      )
    )
      delete env[k]
  }
  return { ...env, ...extra }
}

export interface FakeGrok {
  adapter: GrokAdapter
  log: string
  /** The user's home (empty) and Grok's own home in it (GROK_HOME, empty unless a test writes into it). */
  home: string
  grokHome: string
  dimFactoryHome: string
  logEntries(): Record<string, unknown>[]
  /** The JSON-RPC lines the fake read, parsed. */
  stdinLines(): unknown[]
  /** The argv of each start (after the script name). */
  starts(): string[][]
  /** The env names each start saw (FAKE_CLI_LOG_ENV), by start. */
  startEnv(): Record<string, string | null>[]
}

/** A Grok adapter whose binary is the fake (temp home, GROK_HOME, DIM_FACTORY_HOME and probe folder; a fixed PATH). */
export function fakeGrok(
  setup: FakeSetup,
  scenarioDir: string,
  o: {
    adapter?: Partial<AcpAdapterOptions>
    vendorEnv?: Record<string, string>
    env?: Record<string, string>
    logEnv?: readonly string[]
  } = {},
): FakeGrok {
  const log = join(tempDir('grok-log-'), 'fake.log')
  const home = tempDir('grok-user-')
  const grokHome = join(home, '.grok-test')
  mkdirSync(grokHome, { recursive: true })
  const dimFactoryHome = tempDir('grok-dim-factory-')
  const probeCwd = join(dimFactoryHome, 'tmp', 'probe-cwd')
  mkdirSync(probeCwd, { recursive: true })
  const adapter = createGrokAdapter({
    configuredPath: setup.launcher,
    search: 'configured',
    pathEnv: setup.pathEnv,
    home,
    dimFactoryHome,
    probeCwd,
    env: grokHermeticEnv({ GROK_HOME: grokHome, ...o.env }),
    now: () => 1000,
    timing: { exitAfterTerminalMs: 3_000, stopTurnMs: 3_000 },
    ...o.adapter,
    vendorEnv: {
      FAKE_CLI_SCRIPT: scenarioDir,
      FAKE_CLI_LOG: log,
      FAKE_CLI_TIMEOUT_MS: '20000',
      ...(o.logEnv !== undefined ? { FAKE_CLI_LOG_ENV: o.logEnv.join(',') } : {}),
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
    grokHome,
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
    startEnv: () =>
      logEntries()
        .filter((e) => e['kind'] === 'start')
        .map((e) => (e['env'] as Record<string, string | null> | undefined) ?? {}),
  }
}

export const grokStartOptions = (cwd: string, o: Partial<StartOptions> = {}): StartOptions => ({
  runId: 'run-grok',
  step: 'review',
  cwd,
  prompt: 'Review the change.',
  mode: 'readonly',
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
  ...o,
})

// ---- the fixtures (tests/fixtures/grok/acp/<ID>/) ----------------------------------------------------------------

export interface GrokFixture {
  id: string
  dir: string
  recording: string
  header: Record<string, unknown> & { argv: string[]; pass: Record<string, unknown> }
  frames: Record<string, unknown>[]
  expected: unknown[]
}

export function grokFixtureIds(): string[] {
  return readdirSync(join(GROK_FIXTURES, 'acp'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function loadGrokFixture(id: string): GrokFixture {
  const dir = join(GROK_FIXTURES, 'acp', id)
  const recording = join(dir, 'recording.jsonl')
  const lines = readFileSync(recording, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  return {
    id,
    dir,
    recording,
    header: lines[0] as GrokFixture['header'],
    frames: lines.slice(1),
    expected: JSON.parse(readFileSync(join(dir, 'expected.events.json'), 'utf8')) as unknown[],
  }
}
