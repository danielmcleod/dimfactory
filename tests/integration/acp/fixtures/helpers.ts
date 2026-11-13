// Gemini ACP fixture replay harness (replay goes through the real resolver and spawn path;
// the fake masks ids and deep-compares input frames, exit 99 on a mismatch). The fake CLI stands in for `gemini`: its
// npm-style .cmd shim (win32, run as system `node <entry>`) or shebang copy (POSIX) is resolved with the Gemini CliSpec.
// No test here resolves a real gemini: the fake is the configured path, and the child gets an empty GEMINI_CLI_HOME.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import { geminiCliSpec } from '../../../../src/core/adapters/gemini/cli-spec.ts'
import { sanitizeEnv } from '../../../../src/core/proc/env.ts'
import type { ResolvedCli } from '../../../../src/core/proc/resolve-cli.ts'
import { resolveCli } from '../../../../src/core/proc/resolve-cli.ts'

export const GEMINI_FIXTURES = fileURLToPath(new URL('../../../fixtures/gemini/', import.meta.url))
export const HERE = fileURLToPath(new URL('./', import.meta.url))

export interface AcpFrame {
  t?: number
  dir: 'in' | 'out' | 'err' | 'eof' | 'hold' | 'file' | 'exit'
  line?: string
  code?: number | null
  signal?: string | null
  killed?: string
  /** A `file` frame: a file the CLI wrote at that point (Gemini's plan file), and what it holds. */
  path?: string
  content?: string
}

export interface AcpHeader {
  kind: 'header'
  vendor: string
  route: string
  scenario: string
  argv: string[]
  pass?: { kind: string; resume?: { sessionId: string }; [k: string]: unknown }
  [k: string]: unknown
}

export interface AcpRecording {
  id: string
  path: string
  text: string
  header: AcpHeader
  frames: AcpFrame[]
}

export function fixtureIds(): string[] {
  return readdirSync(join(GEMINI_FIXTURES, 'acp'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function loadRecording(id: string): AcpRecording {
  const path = join(GEMINI_FIXTURES, 'acp', id, 'recording.jsonl')
  const text = readFileSync(path, 'utf8')
  const [first, ...rest] = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
  return { id, path, text, header: first as AcpHeader, frames: rest as AcpFrame[] }
}

/** The JSON message of a frame's line (undefined for a plain text line). */
export function messageOf(f: AcpFrame): Record<string, unknown> | undefined {
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

export function tempDir(prefix = 'acp-fx-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export interface FakeGemini {
  cli: ResolvedCli
  /** The child env: sanitized like a Gemini pass's, an empty GEMINI_CLI_HOME, plus FAKE_CLI_SCRIPT. */
  env: Record<string, string>
  scenarioDir: string
}

/** process.env without the developer's own Gemini / Google settings, so results do not depend on the machine. */
export function hermeticEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) if (/^(GEMINI_|GOOGLE_|FAKE_|REPLAY_)/i.test(k)) delete env[k]
  return env
}

/**
 * The fake CLI as `gemini`, resolved by the real resolver (`--version` answers `0.62.0`), replaying `recordingPath`
 * for `--acp` invocations.
 */
export async function fakeGemini(
  recordingPath: string,
  extraEnv: Record<string, string> = {},
): Promise<FakeGemini> {
  const build = await buildFakeCli()
  const launcher = process.platform === 'win32' ? build.launchers.cmd?.gemini : build.launchers.sh?.gemini
  if (launcher === undefined) throw new Error('fake gemini launcher missing for this OS')
  const scenarioDir = tempDir('gemini-scenario-')
  writeFileSync(
    join(scenarioDir, 'scenario.json'),
    JSON.stringify([
      { match: { argvIncludes: ['--version'] }, script: join(HERE, 'version.script.jsonl'), repeat: true },
      { match: { argvIncludes: ['--acp'] }, script: recordingPath, repeat: true },
    ]),
  )
  const pathEnv = [build.dir, dirname(process.execPath)].join(delimiter)
  const geminiHome = tempDir('gemini-home-')
  mkdirSync(join(geminiHome, '.gemini'), { recursive: true })
  const vendorEnv = { FAKE_CLI_SCRIPT: scenarioDir, GEMINI_CLI_HOME: geminiHome, ...extraEnv }
  const resolved = await resolveCli(geminiCliSpec, {
    configuredPath: launcher,
    pathEnv,
    home: geminiHome,
    env: hermeticEnv(),
    vendorEnv,
  })
  if (!resolved.ok) throw new Error(`the fake gemini did not resolve: ${JSON.stringify(resolved.rejected)}`)
  const env = sanitizeEnv(hermeticEnv(), {
    purpose: 'vendor',
    vendor: 'gemini',
    path: pathEnv,
    pathPrepend: resolved.cli.pathPrepend,
    vendorEnv,
  })
  return { cli: resolved.cli, env, scenarioDir }
}

/** Replace the recording's `<CWD>` placeholder (whole value or inside strings) with a real folder. */
export function withCwd<T>(value: T, cwd: string): T {
  return JSON.parse(JSON.stringify(value).split('<CWD>').join(JSON.stringify(cwd).slice(1, -1))) as T
}
