// Shared setup for the Claude adapter integration tests: recordings, the fake CLI wired as `claude`, and a
// driver that answers asks the way the recording did.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFakeCli } from '../../../scripts/build-fake-cli.mjs'
import type { FakeCliBuild } from '../../../scripts/build-fake-cli.mjs'
import type { ClaudeAdapter, ClaudeAdapterOptions } from '../../../src/core/adapters/claude/index.ts'
import { createClaudeAdapter } from '../../../src/core/adapters/claude/index.ts'
import type { RecordingFrame, RecordingHeader } from '../../../src/core/adapters/claude/normalize.ts'
import { decisionFromReply, parseRecording } from '../../../src/core/adapters/claude/normalize.ts'
import { parseFrame } from '../../../src/core/adapters/claude/protocol.ts'
import type { ExitInfo, RunHandle, StartOptions } from '../../../src/core/adapters/types.ts'
import type { AdapterSignal, AskDecision, NormalizedEvent, Usage } from '../../../src/shared/events.ts'

export const STDIO = fileURLToPath(new URL('../../fixtures/claude/stdio/', import.meta.url))
export const LOCAL = fileURLToPath(new URL('./fixtures/', import.meta.url))

export function recordingIds(): string[] {
  return readdirSync(STDIO, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export interface Recording {
  id: string
  path: string
  text: string
  header: RecordingHeader
  frames: RecordingFrame[]
  /** Recorded host → CLI lines, in order. */
  inLines: string[]
  prompt: string | undefined
  /** Recorded answers to raised asks, by request id. */
  decisions: Map<string, AskDecision>
  exit: RecordingFrame | undefined
}

export function loadRecording(id: string): Recording {
  const path = join(STDIO, id, 'recording.jsonl')
  const text = readFileSync(path, 'utf8')
  const { header, frames } = parseRecording(text)
  const inLines = frames.filter((f) => f.dir === 'in' && typeof f.line === 'string').map((f) => f.line!)
  const decisions = new Map<string, AskDecision>()
  let prompt: string | undefined
  for (const line of inLines) {
    const v = parseFrame(line)
    if (v === undefined) continue
    const d = decisionFromReply(v)
    if (d !== undefined) decisions.set(d.requestId, d.decision)
    if (v['type'] === 'user' && prompt === undefined) {
      const content = (v['message'] as { content?: { text?: string }[] } | undefined)?.content
      prompt = content?.[0]?.text
    }
  }
  return {
    id,
    path,
    text,
    header: header ?? { kind: 'header' },
    frames,
    inLines,
    prompt,
    decisions,
    exit: frames.find((f) => f.dir === 'exit'),
  }
}

export function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === flag) return argv[i + 1]
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
  }
  return undefined
}

/** The `jsonSchema` the recording's host sent in initialize (C17/C18, the catalog refresh), if any. */
export function recordedJsonSchema(rec: Recording): object | undefined {
  for (const line of rec.inLines) {
    const v = parseFrame(line)
    const request = v?.['type'] === 'control_request' ? (v['request'] as Record<string, unknown>) : undefined
    const schema = request?.['subtype'] === 'initialize' ? request['jsonSchema'] : undefined
    if (schema !== null && typeof schema === 'object') return schema
  }
  return undefined
}

/** StartOptions that make the adapter talk to the CLI the way the recording's host did. */
export function startOptionsFor(
  rec: Recording,
  o: { cwd: string; env: Record<string, string>; priorUsage?: Usage | undefined },
): StartOptions {
  const argv = rec.header.argv ?? []
  const mode = flagValue(argv, '--permission-mode')
  const model = flagValue(argv, '--model')
  const base = {
    runId: 'run-replay',
    cwd: o.cwd,
    prompt: rec.prompt ?? '',
    allowRules: [],
    askTimeoutMs: 600_000,
    trustFolder: false,
    env: o.env,
    ...(model !== undefined ? { model } : {}),
  }
  if (mode === 'plan') return { ...base, step: 'plan', mode: 'readonly', planNative: true }
  // C17/C18: the catalog refresh is the read-only pass with web tools; it sends the recorded jsonSchema.
  const allowed = flagValue(argv, '--allowedTools')
  if (mode === 'dontAsk' && allowed?.split(',').includes('WebSearch') === true) {
    const allowedDomains = allowed
      .split(',')
      .flatMap((r) => /^WebFetch\(domain:([^)]+)\)$/.exec(r)?.[1] ?? [])
    const schema = recordedJsonSchema(rec)
    return {
      ...base,
      step: 'catalog',
      mode: 'readonly',
      planNative: false,
      ephemeral: true,
      web: { allowedDomains },
      ...(schema !== undefined ? { outputSchema: schema } : {}),
    }
  }
  if (mode === 'dontAsk') return { ...base, step: 'review', mode: 'readonly', planNative: false }
  const resume = flagValue(argv, '--resume')
  const sessionId = flagValue(argv, '--session-id')
  return {
    ...base,
    step: resume !== undefined ? 'fix' : 'implement',
    mode: 'autoedit',
    planNative: false,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(resume !== undefined
      ? { resume: { sessionId: resume, ...(o.priorUsage !== undefined ? { priorUsage: o.priorUsage } : {}) } }
      : {}),
  }
}

export interface FakeSetup {
  build: FakeCliBuild
  /** What a user install exposes: the npm-style .cmd shim on win32, the shebang copy on POSIX. */
  launcher: string
  pathEnv: string
  /** FAKE_CLI_SCRIPT for resolution and probes: --version, auth status, and the C16 handshake. */
  scenarioDir: string
}

let memo: Promise<FakeSetup> | undefined

export function fakeSetup(): Promise<FakeSetup> {
  memo ??= (async () => {
    const build = await buildFakeCli()
    const launcher = process.platform === 'win32' ? build.launchers.cmd?.claude : build.launchers.sh?.claude
    if (launcher === undefined) throw new Error('fake CLI launcher missing for this OS')
    const scenarioDir = mkdtempSync(join(tmpdir(), 'claude-scenario-'))
    writeFileSync(
      join(scenarioDir, 'scenario.json'),
      JSON.stringify([
        { match: { argvIncludes: ['--version'] }, script: join(LOCAL, 'version.script.jsonl'), repeat: true },
        {
          match: { argvIncludes: ['auth', 'status'] },
          script: join(LOCAL, 'auth-status.script.jsonl'),
          repeat: true,
        },
        {
          match: { argvIncludes: ['-p'] },
          script: join(STDIO, 'C16-probe-handshake', 'recording.jsonl'),
          repeat: true,
        },
      ]),
    )
    return { build, launcher, pathEnv: [build.dir, dirname(process.execPath)].join(delimiter), scenarioDir }
  })()
  return memo
}

export function tempDir(prefix = 'claude-it-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * process.env without the developer's own Claude/Anthropic settings (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, a host
 * session's CLAUDE_CODE_*), so results do not depend on the machine running the tests.
 */
export function hermeticEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE)/i.test(k)) delete env[k]
  return { ...env, ...extra }
}

/** A Claude adapter whose binary is the fake; a temp home keeps the user's ~/.claude out of the tests. */
export function fakeAdapter(setup: FakeSetup, o: Partial<ClaudeAdapterOptions> = {}): ClaudeAdapter {
  return createClaudeAdapter({
    configuredPath: setup.launcher,
    pathEnv: setup.pathEnv,
    home: tempDir('claude-home-'),
    probeCwd: tempDir('claude-probe-'),
    now: () => 0,
    env: hermeticEnv(),
    ...o,
    vendorEnv: { FAKE_CLI_SCRIPT: setup.scenarioDir, ...o.vendorEnv },
  })
}

export type Entry = NormalizedEvent | AdapterSignal

export interface Driven {
  handle: RunHandle
  entries: Entry[]
  exit: ExitInfo
  /** The `stop()` call stopAfterAnswer made: settles once the tree kill is over, which may be after `exit`. */
  stopped?: Promise<void>
}

/** Start, answer each ask with the recorded decision, optionally stop after the answer, collect everything. */
export async function drive(
  adapter: ClaudeAdapter,
  o: StartOptions,
  decisions: ReadonlyMap<string, AskDecision>,
  opts: { stopAfterAnswer?: 'user' | 'timeout'; onStart?: (h: RunHandle) => void } = {},
): Promise<Driven> {
  const handle = adapter.start(o)
  const entries: Entry[] = []
  let stopped: Promise<void> | undefined
  handle.onSignal((s) => entries.push(s))
  handle.onEvent((e) => {
    entries.push(e)
    if (e.type !== 'ask') return
    const d = decisions.get(e.requestId)
    if (d === undefined) return
    // A recorded cancel is the user's deny + interrupt (P9b), as normalizeRecording reads it.
    adapter.answer(handle, e.requestId, d, d === 'cancel' ? 'denied' : undefined)
    if (opts.stopAfterAnswer !== undefined) stopped ??= adapter.stop(handle, opts.stopAfterAnswer)
  })
  opts.onStart?.(handle)
  const exit = await handle.exited
  return stopped === undefined ? { handle, entries, exit } : { handle, entries, exit, stopped }
}

export const withoutLiveness = <T extends { type: string }>(list: readonly T[]): T[] =>
  list.filter((e) => e.type !== 'liveness' && e.type !== 'stdin' && e.type !== 'shell-command')

export const terminals = <T extends { type: string }>(list: readonly T[]): T[] =>
  list.filter((e) => e.type === 'done' || (e.type === 'error' && (e as { fatal?: unknown }).fatal === true))
