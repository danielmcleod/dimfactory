// Codex fixture replay harness (replay goes through the real resolver and spawn path;
// the fake masks ids and deep-compares input frames, exit 99 on a mismatch). The fake CLI stands in for `codex`: its
// npm-style .cmd shim (win32) or shebang copy (POSIX) is resolved by resolve-cli with the Codex CliSpec.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import { codexCliSpec } from '../../../../src/core/adapters/codex/cli-spec.ts'
import { sanitizeEnv } from '../../../../src/core/proc/env.ts'
import type { ResolvedCli } from '../../../../src/core/proc/resolve-cli.ts'
import { resolveCli } from '../../../../src/core/proc/resolve-cli.ts'

export const CODEX_FIXTURES = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))
export const HERE = fileURLToPath(new URL('./', import.meta.url))

export type CodexRoute = 'app-server' | 'exec'

export interface CodexFrame {
  t?: number
  dir: 'in' | 'out' | 'err' | 'eof' | 'file' | 'hold' | 'exit'
  line?: string
  code?: number | null
  signal?: string | null
  killed?: string
  argvPath?: string
  content?: string
}

/** The header's `pass`: how Dim Factory ran the recorded process (tests/fixtures/codex/README.md "Header"). */
export interface PassHeader {
  kind: 'pass' | 'probe' | 'listModels' | 'vendorSetup'
  route?: 'exec'
  step?: string
  mode?: string
  planNative?: boolean
  prompt?: string
  answers?: { decision: string; why?: string }[]
  stop?: { after: Record<string, unknown>; reason: 'user' | 'timeout' }
  resume?: { sessionId: string; priorUsage?: Record<string, number> }
  winSandbox?: string
  [k: string]: unknown
}

export interface CodexHeader {
  kind: 'header'
  vendor: string
  route: CodexRoute
  scenario: string
  cliVersion?: string
  protocol?: 'jsonrpc'
  synthesized?: boolean
  synthesizedFrom?: string
  argv: string[]
  pass?: PassHeader
  [k: string]: unknown
}

export interface CodexRecording {
  id: string
  route: CodexRoute
  path: string
  text: string
  header: CodexHeader
  frames: CodexFrame[]
}

export function fixtureIds(route: CodexRoute): string[] {
  return readdirSync(join(CODEX_FIXTURES, route), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function loadCodexRecording(route: CodexRoute, id: string): CodexRecording {
  const path = join(CODEX_FIXTURES, route, id, 'recording.jsonl')
  const text = readFileSync(path, 'utf8')
  const [first, ...rest] = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
  return { id, route, path, text, header: first as CodexHeader, frames: rest as CodexFrame[] }
}

export function expectedEntries(route: CodexRoute, id: string): Record<string, unknown>[] {
  return JSON.parse(readFileSync(join(CODEX_FIXTURES, route, id, 'expected.events.json'), 'utf8')) as Record<
    string,
    unknown
  >[]
}

/** The JSON message of a frame's line (undefined for non-JSON lines such as an exec prompt). */
export function messageOf(f: CodexFrame): Record<string, unknown> | undefined {
  if (f.line === undefined) return undefined
  try {
    const v = JSON.parse(f.line) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function tempDir(prefix = 'codex-it-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export interface FakeCodex {
  cli: ResolvedCli
  /** The child env: sanitized like a Codex pass's, plus FAKE_CLI_SCRIPT. */
  env: Record<string, string>
  scenarioDir: string
}

/**
 * The fake CLI as `codex`, resolved by the real resolver (`--version` answers `codex-cli 0.160.1`), replaying
 * `recordingPath` for `app-server` / `exec` invocations.
 */
export async function fakeCodex(
  recordingPath: string,
  extraEnv: Record<string, string> = {},
): Promise<FakeCodex> {
  const build = await buildFakeCli()
  const launcher = process.platform === 'win32' ? build.launchers.cmd?.codex : build.launchers.sh?.codex
  if (launcher === undefined) throw new Error('fake codex launcher missing for this OS')
  const scenarioDir = tempDir('codex-scenario-')
  writeFileSync(
    join(scenarioDir, 'scenario.json'),
    JSON.stringify([
      { match: { argvIncludes: ['--version'] }, script: join(HERE, 'version.script.jsonl'), repeat: true },
      { match: { argvIncludes: ['app-server'] }, script: recordingPath, repeat: true },
      { match: { argvIncludes: ['exec'] }, script: recordingPath, repeat: true },
    ]),
  )
  const pathEnv = [build.dir, dirname(process.execPath)].join(delimiter)
  const vendorEnv = { FAKE_CLI_SCRIPT: scenarioDir, ...extraEnv }
  const home = tempDir('codex-home-')
  const resolved = await resolveCli(codexCliSpec, {
    configuredPath: launcher,
    pathEnv,
    home,
    env: hermeticEnv(),
    vendorEnv,
  })
  if (!resolved.ok) throw new Error(`the fake codex did not resolve: ${JSON.stringify(resolved.rejected)}`)
  const env = sanitizeEnv(hermeticEnv(), {
    purpose: 'vendor',
    vendor: 'codex',
    path: pathEnv,
    pathPrepend: resolved.cli.pathPrepend,
    vendorEnv: { ...vendorEnv, CODEX_HOME: home },
  })
  return { cli: resolved.cli, env, scenarioDir }
}

/** process.env without the developer's own Codex/OpenAI settings, so results do not depend on the machine. */
export function hermeticEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) if (/^(CODEX_|OPENAI_|FAKE_)/i.test(k)) delete env[k]
  return env
}

/** Replace the recording's `<CWD>` placeholder (whole value or inside strings) with a real folder. */
export function withCwd<T>(value: T, cwd: string): T {
  return JSON.parse(JSON.stringify(value).split('<CWD>').join(JSON.stringify(cwd).slice(1, -1))) as T
}
