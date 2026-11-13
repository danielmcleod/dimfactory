// Fake-Claude scenarios for run-level tests, built from the real Claude recordings (tests/fixtures/claude/stdio)
// with scripts/fixture-to-script.mjs. The conversion keeps every recorded frame; this helper only
//   - relaxes the recorded user message (Dim Factory renders its own prompts) to "$_",
//   - optionally writes a file just before the recorded `result` (the fake does not run tools, so S0..S1 would be
//     empty otherwise), spawns a long-sleeping grandchild, or parks the script in a long sleep (kill tests),
//   - optionally replaces the final answer (`text`): the recorded text deltas go, one delta with the new text is
//     sent before the `result`, whose `result` field (and the assistant frame's text) carry it too. That turns
//     C02 (the Review shape: read-only tools, a denied Bash, a final answer) into a review with findings, a
//     `NO FINDINGS` reply or an empty one.
// Read-only passes (Review, Critic) are matched by `dontAsk` and their model (claude-only: Review sonnet, Critic
// opus); every scenario has a default `NO FINDINGS` reviewer for each, so a run without explicit reviewers ends
// clean with Fix skipped. A Fix reusing Implement's session is a `--resume=<id>` spawn (`resume`); a fresh Fix is
// an `acceptEdits` spawn after Implement's (`fix`).
// The probe uses the Claude fixtures: `--version`, `auth status` and the C16 initialize-only handshake.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildFakeCli } from '../../../scripts/build-fake-cli.mjs'
import { readFakeLog } from '../../fake-cli/harness.ts'
import type { FakeLogEntry } from '../../fake-cli/harness.ts'

export const STDIO = fileURLToPath(new URL('../../fixtures/claude/stdio/', import.meta.url))
const ADAPTER_FIXTURES = fileURLToPath(new URL('../adapters/fixtures/', import.meta.url))
const FAKE_SCRIPTS = fileURLToPath(new URL('../../fixtures/fake/m12/', import.meta.url))
export const SANDBOX_TS_SMALL = fileURLToPath(new URL('../../fixtures/sandboxes/ts-small/', import.meta.url))
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'dimf.ts')

type Op = Record<string, unknown> & { op: string }

type Converter = (text: string, o?: { sleep?: boolean }) => string
const converterUrl = pathToFileURL(
  fileURLToPath(new URL('../../../scripts/fixture-to-script.mjs', import.meta.url)),
).href
let converter: Converter | undefined

/** scripts/fixture-to-script.mjs (plain JS, loaded untyped). */
export async function loadConverter(): Promise<Converter> {
  converter ??= ((await import(converterUrl)) as { recordingToScript: Converter }).recordingToScript
  return converter
}

export interface PassScript {
  /** Recording id under tests/fixtures/claude/stdio, or a hand-written script under tests/fixtures/fake/m12. */
  recording?: string
  script?: string
  /** Write this file (relative to the run folder) right before the recorded result. */
  write?: { path: string; content: string }
  /** Spawn a long-sleeping grandchild after the user message, then park in a sleep (kill tests). */
  grandchildThenSleepMs?: number
  /** Sleep this long after the user message (keeps the pass running). */
  delayMs?: number
  /**
   * Sleep this long right before and right after the vendor's `system/status compacting` frame (a recording with a
   * compaction, C23s), so the context meter's full and summarising states stay on screen for a while.
   */
  holdAroundCompactingMs?: number
  /**
   * The recording's compaction (its `status compacting` frame through its `compact_boundary`) this many times in all,
   * then a sleep of `afterCompactionsMs` (context health's restart after compactions).
   */
  compactions?: number
  afterCompactionsMs?: number
  /**
   * The recording's first tool call (its assistant `tool_use` frame and the `tool_result`) this many times in all, each
   * with its own id and the same input (context health's loop card and stop).
   */
  toolCalls?: number
  /** A sleep after the repeated tool calls (the loop card stays on screen while the pass waits). */
  afterToolCallsMs?: number
  /** Replace the final answer (see the header); '' = an empty answer. */
  text?: string
  /** Fake CLI ops run first, before the recorded frames (`expectArgs`, `expectFile`: what the launch must carry). */
  prepend?: Record<string, unknown>[]
  /** The `result` frame also carries this as `structured_output` (the answer to a jsonSchema, outputSchema). */
  structured?: unknown
}

export interface ScenarioSpec {
  /** Plan spawns in order. */
  plan?: PassScript | PassScript[]
  /** Implement spawns in order (fresh spawns; a resumed spawn goes in `resume`). */
  implement?: PassScript[]
  /** `--resume=<id>` spawns in order: P19 resumes and a Fix that reuses Implement's session. */
  resume?: PassScript[]
  /** Review spawns in order (`dontAsk` + `--model <reviewModel>`); then the default `NO FINDINGS` reply. */
  review?: PassScript[]
  /** Critic spawns in order (`dontAsk` + `--model <criticModel>`); then the default `NO FINDINGS` reply. */
  critic?: PassScript[]
  /** Fresh Fix spawns in order (`acceptEdits`, after every Implement entry). */
  fix?: PassScript[]
  /** The Deploy step's spawns in order (`acceptEdits`, a fresh session, after every Implement and Fix entry). */
  deploy?: PassScript[]
  /** Default `sonnet` / `opus` (the claude-only profile). */
  reviewModel?: string
  criticModel?: string
  /**
   * The security advisor's spawns in order (`dontAsk` + `--model <securityModel>`): the Security pass, then the
   * re-check after Fix (both run on the Security pass's config); then the default `NO FINDINGS` reply. Only with
   * `security` set (a run without the advisor never spawns them).
   */
  security?: PassScript[]
  /** Default `haiku`, so the Security pass is told apart from Critic (opus) by its model. */
  securityModel?: string
  /**
   * Clarify's spawns in order (`dontAsk` + `--model <clarifyModel>`: Clarify runs read-only on the Plan pass's model,
   * so a test sets the Plan pass's model to it). Only with `clarify` set.
   */
  clarify?: PassScript[]
  /** Default `haiku`. */
  clarifyModel?: string
  /**
   * Explain it to me's spawns in order (`dontAsk` + `--model <explainModel>`: Explain runs read-only on the Plan pass's
   * model, so a test sets the Plan pass's model to it). Only with `explain` set. The acceptance review needs no entry
   * of its own: it runs read-only on Review's model, so it takes the first `review` entry (it spawns before Review).
   */
  explain?: PassScript[]
  /**
   * Default `haiku`. `null`: the pass runs on the vendor's own default model (no `--model` at all), as a match's
   * side does when its builder names no model; it is then told apart by having no model.
   */
  explainModel?: string | null
  /**
   * Research's spawns in order (`dontAsk` + `--tools`: Research is the one read-only run pass with a tool allow list;
   * the other read-only entries exclude `--tools`, so they never take its spawn). Only with `research` set.
   */
  research?: PassScript[]
}

/** C02 (the Review shape) answering `NO FINDINGS`. */
export const NO_FINDINGS_REVIEW: PassScript = { recording: 'C02-review-shape', text: 'NO FINDINGS' }

/** A review.md-shaped answer: F1 and F2 [must] (one with a detail line), F3 [should] (after must-first sorting). */
export const REVIEW_WITH_FINDINGS = [
  '- [must] `src/cli.ts:12` — --version prints nothing. Print the version from package.json.',
  '  The handler returns before it writes to stdout.',
  '- [should] `src/cli.ts:3` — Unused import of `greet`. Remove it.',
  '- [must] `test/cli.test.ts:1` — No test covers --version. Add one.',
].join('\n')

export interface Scenario {
  dir: string
  log: string
  state: string
  /** `vendors.claude.env` for dimfactory.json. */
  env: Record<string, string>
  entries(): FakeLogEntry[]
}

function frameOf(line: unknown): Record<string, unknown> | undefined {
  if (typeof line !== 'string') return undefined
  try {
    const v: unknown = JSON.parse(line)
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function isResultLine(line: unknown): boolean {
  return frameOf(line)?.['type'] === 'result'
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** A main-thread `stream_event` text delta. */
function isTextDelta(f: Record<string, unknown> | undefined): boolean {
  if (f?.['type'] !== 'stream_event' || f['parent_tool_use_id'] !== null) return false
  const ev = asRecord(f['event'])
  return ev?.['type'] === 'content_block_delta' && asRecord(ev['delta'])?.['type'] === 'text_delta'
}

/**
 * The recorded final answer replaced by `text`: text deltas dropped, one delta (shaped like the first recorded
 * one) before the `result`, the result's `result` and the assistant frames' text items set to `text`.
 */
function replaceAnswer(ops: Op[], text: string): Op[] {
  let template: Record<string, unknown> | undefined
  const out: Op[] = []
  for (const op of ops) {
    if (op.op !== 'stdout') {
      out.push(op)
      continue
    }
    const f = frameOf(op['line'])
    if (isTextDelta(f)) {
      template ??= f
      continue
    }
    if (f?.['type'] === 'assistant') {
      const msg = asRecord(f['message'])
      const content: unknown = msg?.['content']
      const items: unknown[] = Array.isArray(content) ? (content as unknown[]) : []
      if (msg !== undefined && items.some((c) => asRecord(c)?.['type'] === 'text')) {
        msg['content'] = items.map((c): unknown =>
          asRecord(c)?.['type'] === 'text' ? { type: 'text', text } : c,
        )
        out.push({ op: 'stdout', line: JSON.stringify(f) })
        continue
      }
    }
    if (f?.['type'] === 'result') {
      if (text !== '') {
        const delta = structuredClone(
          template ?? {
            type: 'stream_event',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } },
            parent_tool_use_id: null,
          },
        )
        const d = asRecord(asRecord(delta['event'])?.['delta'])
        if (d !== undefined) d['text'] = text
        out.push({ op: 'stdout', line: JSON.stringify(delta) })
      }
      out.push({ op: 'stdout', line: JSON.stringify({ ...f, result: text }) })
      continue
    }
    out.push(op)
  }
  return out
}

/** The `result` frame with `structured_output` (a successful jsonSchema answer). */
function withStructured(ops: Op[], value: unknown): Op[] {
  return ops.map((op) => {
    const f = op.op === 'stdout' ? frameOf(op['line']) : undefined
    return f?.['type'] === 'result' ? { ...op, line: JSON.stringify({ ...f, structured_output: value }) } : op
  })
}

function loadOps(spec: PassScript, convert: Converter): Op[] {
  const text =
    spec.recording !== undefined
      ? convert(readFileSync(join(STDIO, spec.recording, 'recording.jsonl'), 'utf8'))
      : readFileSync(join(FAKE_SCRIPTS, spec.script ?? ''), 'utf8')
  const ops = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('#'))
    .map((l) => JSON.parse(l) as Op)
  const out: Op[] = []
  let userSeen = false
  for (const op of ops) {
    const match = op['match'] as { type?: unknown; message?: unknown } | undefined
    if (op.op === 'expectStdin' && match?.type === 'user') {
      out.push({ op: 'expectStdin', match: { type: 'user', message: '$_' } })
      userSeen = true
      if (spec.delayMs !== undefined) out.push({ op: 'sleep', ms: spec.delayMs })
      if (spec.grandchildThenSleepMs !== undefined) {
        out.push({ op: 'spawnGrandchild', sleepMs: 120_000 })
        out.push({ op: 'sleep', ms: spec.grandchildThenSleepMs })
      }
      continue
    }
    if (spec.write !== undefined && op.op === 'stdout' && isResultLine(op['line'])) {
      out.push({ op: 'writeFile', path: spec.write.path, content: spec.write.content })
    }
    const hold = spec.holdAroundCompactingMs
    const compacting =
      hold !== undefined &&
      op.op === 'stdout' &&
      (() => {
        const f = frameOf(op['line'])
        return f?.['type'] === 'system' && f['subtype'] === 'status' && f['status'] === 'compacting'
      })()
    if (compacting) out.push({ op: 'sleep', ms: hold })
    out.push(op)
    if (compacting) out.push({ op: 'sleep', ms: hold })
  }
  if (!userSeen) throw new Error(`scenario ${spec.recording ?? spec.script}: no user message to relax`)
  repeatCompactions(out, spec)
  repeatToolCalls(out, spec)
  const first = (spec.prepend ?? []) as Op[]
  const answered = spec.text !== undefined ? replaceAnswer(out, spec.text) : out
  return [...first, ...(spec.structured !== undefined ? withStructured(answered, spec.structured) : answered)]
}

const subtypeOf = (op: Op): { type?: unknown; subtype?: unknown; status?: unknown } | undefined =>
  op.op === 'stdout' ? frameOf(op['line']) : undefined

/** PassScript.compactions: the compaction block repeated in place, then the sleep after it. */
function repeatCompactions(out: Op[], spec: PassScript): void {
  if (spec.compactions === undefined) return
  const start = out.findIndex((op) => {
    const f = subtypeOf(op)
    return f?.type === 'system' && f.subtype === 'status' && f.status === 'compacting'
  })
  const end = out.findIndex((op, i) => i > start && subtypeOf(op)?.subtype === 'compact_boundary')
  if (start < 0 || end < 0)
    throw new Error(`scenario ${spec.recording ?? spec.script}: no compaction to repeat`)
  const block = out.slice(start, end + 1)
  const repeated: Op[] = []
  for (let i = 0; i < spec.compactions; i++) repeated.push(...block)
  if (spec.afterCompactionsMs !== undefined) repeated.push({ op: 'sleep', ms: spec.afterCompactionsMs })
  out.splice(start, block.length, ...repeated)
}

/** PassScript.toolCalls: the first tool call repeated after its result, each copy with its own tool id. */
function repeatToolCalls(out: Op[], spec: PassScript): void {
  if (spec.toolCalls === undefined) return
  const call = out.findIndex((op) => {
    const f = subtypeOf(op) as Record<string, unknown> | undefined
    const content = asRecord(f?.['message'])?.['content']
    return (
      f?.['type'] === 'assistant' &&
      Array.isArray(content) &&
      content.some((c) => asRecord(c)?.['type'] === 'tool_use')
    )
  })
  const line = call >= 0 ? (out[call]?.['line'] as string) : ''
  const id = /"type":"tool_use","id":"([^"]+)"/.exec(line)?.[1]
  const result = out.findIndex(
    (op, i) => i > call && op.op === 'stdout' && String(op['line']).includes(`"tool_use_id":"${id ?? ''}"`),
  )
  if (call < 0 || id === undefined || result < 0)
    throw new Error(`scenario ${spec.recording ?? spec.script}: no tool call to repeat`)
  const copies: Op[] = []
  for (let k = 2; k <= spec.toolCalls; k++) {
    const nid = `${id}r${k}`
    for (const op of [out[call], out[result]] as Op[]) {
      copies.push({ ...op, line: String(op['line']).split(id).join(nid) })
    }
  }
  if (spec.afterToolCallsMs !== undefined) copies.push({ op: 'sleep', ms: spec.afterToolCallsMs })
  out.splice(result + 1, 0, ...copies)
}

function writeScript(dir: string, name: string, spec: PassScript, convert: Converter): string {
  const file = join(dir, `${name}.script.jsonl`)
  writeFileSync(
    file,
    `${loadOps(spec, convert)
      .map((o) => JSON.stringify(o))
      .join('\n')}\n`,
  )
  return file
}

/** A scenario directory (scenario.json + scripts) and the env that points the fake at it. */
export async function makeScenario(
  spec: ScenarioSpec,
  root = mkdtempSync(join(tmpdir(), 'dim-run-scenario-')),
): Promise<Scenario> {
  const convert = await loadConverter()
  const dir = join(root, 'scenario')
  mkdirSync(dir, { recursive: true })
  const entries: { match: Record<string, string[]>; script: string; repeat?: boolean }[] = []
  entries.push({
    match: { argvIncludes: ['--version'] },
    script: join(ADAPTER_FIXTURES, 'version.script.jsonl'),
    repeat: true,
  })
  entries.push({
    match: { argvIncludes: ['auth', 'status'] },
    script: join(ADAPTER_FIXTURES, 'auth-status.script.jsonl'),
    repeat: true,
  })
  entries.push({
    match: { argvIncludes: ['-p', 'default'] },
    script: join(STDIO, 'C16-probe-handshake', 'recording.jsonl'),
    repeat: true,
  })
  const plans = spec.plan === undefined ? [] : Array.isArray(spec.plan) ? spec.plan : [spec.plan]
  plans.forEach((s, i) => {
    entries.push({
      match: { argvIncludes: ['-p', 'plan'] },
      script: writeScript(dir, `plan-${i + 1}`, s, convert),
    })
  })
  ;(spec.resume ?? []).forEach((s, i) => {
    entries.push({
      match: { argvIncludes: ['-p', '--resume=*'] },
      script: writeScript(dir, `resume-${i + 1}`, s, convert),
    })
  })
  ;(spec.implement ?? []).forEach((s, i) => {
    entries.push({
      match: { argvIncludes: ['-p', 'acceptEdits'], argvExcludes: ['--resume=*'] },
      script: writeScript(dir, `implement-${i + 1}`, s, convert),
    })
  })
  ;(spec.fix ?? []).forEach((s, i) => {
    entries.push({
      match: { argvIncludes: ['-p', 'acceptEdits'], argvExcludes: ['--resume=*'] },
      script: writeScript(dir, `fix-${i + 1}`, s, convert),
    })
  })
  ;(spec.deploy ?? []).forEach((s, i) => {
    entries.push({
      match: { argvIncludes: ['-p', 'acceptEdits'], argvExcludes: ['--resume=*'] },
      script: writeScript(dir, `deploy-${i + 1}`, s, convert),
    })
  })
  const reviewers: [string, PassScript[], string | null][] = [
    ['review', spec.review ?? [], spec.reviewModel ?? 'sonnet'],
    ['critic', spec.critic ?? [], spec.criticModel ?? 'opus'],
  ]
  if (spec.security !== undefined) reviewers.push(['security', spec.security, spec.securityModel ?? 'haiku'])
  if (spec.clarify !== undefined) reviewers.push(['clarify', spec.clarify, spec.clarifyModel ?? 'haiku'])
  if (spec.explain !== undefined) {
    reviewers.push(['explain', spec.explain, spec.explainModel === undefined ? 'haiku' : spec.explainModel])
  }
  ;(spec.research ?? []).forEach((s, i) => {
    entries.push({
      match: { argvIncludes: ['-p', 'dontAsk', '--tools'] },
      script: writeScript(dir, `research-${i + 1}`, s, convert),
    })
  })
  for (const [name, list, model] of reviewers) {
    const match =
      model === null
        ? { argvIncludes: ['-p', 'dontAsk'], argvExcludes: ['--tools', '--model'] }
        : { argvIncludes: ['-p', 'dontAsk', '--model', model], argvExcludes: ['--tools'] }
    list.forEach((s, i) => {
      entries.push({ match, script: writeScript(dir, `${name}-${i + 1}`, s, convert) })
    })
    entries.push({
      match,
      script: writeScript(dir, `${name}-default`, NO_FINDINGS_REVIEW, convert),
      repeat: true,
    })
  }
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(entries, null, 2))
  const log = join(root, 'fake.log.jsonl')
  const state = join(root, 'fake-state')
  return {
    dir,
    log,
    state,
    env: { FAKE_CLI_SCRIPT: dir, FAKE_CLI_LOG: log, FAKE_CLI_STATE: state, FAKE_CLI_TIMEOUT_MS: '30000' },
    entries: () => readFakeLog(log),
  }
}

/** The fake `claude` a user install would expose: the .cmd shim on win32, the shebang copy on POSIX. */
export async function fakeClaudePath(): Promise<string> {
  const build = await buildFakeCli()
  const p = process.platform === 'win32' ? build.launchers.cmd?.claude : build.launchers.sh?.claude
  if (p === undefined) throw new Error('fake claude launcher missing')
  return p
}

/**
 * The pipeline the run suites drive: Thorough (Plan, its gate, two reviewers), Implement starting its own session, and
 * every finding sent to Fix. Adaptive depth, continuity and quieter reviews have suites of their own, which pass
 * `pipeline: 'defaults'` to run with the shipped defaults instead.
 */
export const FULL_PIPELINE = {
  depth: 'full',
  passes: { implement: { continuePlan: false }, fix: { trigger: 'all' } },
} as const

/** A home with dimfactory.json pointing `vendors.claude` at the fake (and a private CLAUDE_CONFIG_DIR). */
export async function makeHome(
  scenario: Scenario,
  root = mkdtempSync(join(tmpdir(), 'dim-run-home-')),
  o: { pipeline?: 'full' | 'defaults' } = {},
): Promise<{
  home: string
  claudeConfigDir: string
}> {
  const home = join(root, 'home')
  const claudeConfigDir = join(root, 'claude-config')
  mkdirSync(home, { recursive: true })
  mkdirSync(claudeConfigDir, { recursive: true })
  writeFileSync(
    join(home, 'dimfactory.json'),
    JSON.stringify(
      {
        ...(o.pipeline === 'defaults' ? {} : FULL_PIPELINE),
        vendors: {
          claude: {
            path: await fakeClaudePath(),
            env: { ...scenario.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
          },
        },
      },
      null,
      2,
    ),
  )
  return { home, claudeConfigDir }
}

/** git with a fixed identity and no user/system config (the sandbox gets one commit). */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

/** A copy of tests/fixtures/sandboxes/ts-small, optionally a git repo with one commit. */
export function makeSandbox(
  o: { git?: boolean } = {},
  root = mkdtempSync(join(tmpdir(), 'dim-run-sandbox-')),
): string {
  const dir = join(root, 'ts-small')
  cpSync(SANDBOX_TS_SMALL, dir, { recursive: true })
  if (o.git !== false) {
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'init')
  }
  return dir
}

/**
 * An empty CODEX_HOME for this test process: a core under test finds the developer's real Codex (the standalone
 * install is a well-known location) and probes it; with this home it is logged out, so the probe never lists models,
 * starts a thread or touches ~/.codex.
 */
let testCodexHome: string | undefined
function emptyCodexHome(): string {
  testCodexHome ??= join(tmpdir(), `dim-factory-codex-home-${process.pid}`)
  mkdirSync(testCodexHome, { recursive: true })
  return testCodexHome
}

/**
 * Likewise an empty GEMINI_CLI_HOME (Gemini's home-folder override): a core under test that finds a real Gemini
 * reads no ~/.gemini (no Google sign-in file, no sessions), so its probe is not signed in and nothing is prompted.
 */
let testGeminiHome: string | undefined
function emptyGeminiHome(): string {
  testGeminiHome ??= join(tmpdir(), `dim-factory-gemini-home-${process.pid}`)
  mkdirSync(testGeminiHome, { recursive: true })
  return testGeminiHome
}

/**
 * Likewise an empty GROK_HOME (Grok's home-folder override): a core under test that finds a real Grok reads no
 * ~/.grok (no cached sign-in, no sessions, no config of the developer's own).
 */
let testGrokHome: string | undefined
function emptyGrokHome(): string {
  testGrokHome ??= join(tmpdir(), `dim-factory-grok-home-${process.pid}`)
  mkdirSync(testGrokHome, { recursive: true })
  return testGrokHome
}

/**
 * process.env without the developer's Claude/Anthropic/Codex/OpenAI settings (and Gemini/Google sign-in
 * settings: GEMINI_API_KEY, Vertex AI and Code Assist switches, Google Cloud project and credentials; Grok and
 * xAI settings, XAI_API_KEY and GROK_*; Muse's META_API_KEY and MUSE_*) and test-runner leftovers.
 */
const NOT_HERMETIC =
  /^(ANTHROPIC_|CLAUDE|CODEX_|OPENAI_|GEMINI_|GOOGLE_|GROK_|XAI_|META_|MUSE_|FAKE_CLI_|FAKE_VAR_|REPLAY_|VITEST|NODE_OPTIONS$)/i

export function hermeticEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) {
    if (NOT_HERMETIC.test(k)) delete env[k]
  }
  delete env['DIM_FACTORY_HOME']
  // A caller's own CODEX_HOME / GEMINI_CLI_HOME (the E2E harness: one inside the test's root) leaves no shared folder
  // behind.
  return {
    ...env,
    CODEX_HOME: extra['CODEX_HOME'] ?? emptyCodexHome(),
    GEMINI_CLI_HOME: extra['GEMINI_CLI_HOME'] ?? emptyGeminiHome(),
    GROK_HOME: extra['GROK_HOME'] ?? emptyGrokHome(),
    ...extra,
  }
}

/**
 * Remove test folders. A folder made inside one of this module's `dim-run-*` temp roots (the home, the scenario, the
 * sandbox) takes its root with it (the fake's log and state, the private CLAUDE_CONFIG_DIR).
 */
export function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    const root = dirname(d)
    const target = basename(root).startsWith('dim-run-') && dirname(root) === tmpdir() ? root : d
    if (existsSync(target)) rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** Stdin lines the fake received (per process), keyed by the script it ran. */
export function stdinByScript(entries: readonly FakeLogEntry[]): Map<string, string[]> {
  const scriptOf = new Map<number, string>()
  const out = new Map<string, string[]>()
  for (const e of entries) {
    if (e.kind === 'script' && typeof e['file'] === 'string')
      scriptOf.set(e.pid, e['file'].replace(/\\/g, '/').split('/').pop() ?? '')
    if (e.kind === 'stdin' && typeof e['line'] === 'string') {
      const key = scriptOf.get(e.pid) ?? `pid-${e.pid}`
      out.set(key, [...(out.get(key) ?? []), e['line']])
    }
  }
  return out
}

/** argv of every `-p` process the fake started. */
export function passArgvs(entries: readonly FakeLogEntry[]): string[][] {
  return entries
    .filter((e) => e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes('-p'))
    .map((e) => e['argv'] as string[])
    .filter((a) => !a.includes('default'))
}
