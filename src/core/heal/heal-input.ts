// Self-heal input (the internal/heal.md template's values): trigger, probe, pass config
// (argv only), env (versions only) and a tail built from stderr plus status/control frames. Content frames (Claude
// stream_event/assistant/user tool_result, Codex item/delta, ACP updates) never reach the healer: every stdout frame
// is projected through a key allowlist, so the task, plan, diff and file bodies stay out even in unknown frame shapes.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { homedir, hostname, release, userInfo } from 'node:os'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import type { ProbeResult } from '../../shared/vendors.ts'
import type { RedactOptions } from '../../shared/redact.ts'
import { redactText } from '../../shared/redact.ts'
import { stepLabel } from '../supervisor/cards.ts'
import { commandFor, osFamily } from './commands.ts'
import type { OsFamily } from './commands.ts'
import type { HealRequest } from './healer.ts'

/** "Last 40 lines" (the heal template). */
export const HEAL_TAIL_LINES = 40
/** Strings over 300 chars are truncated. */
export const HEAL_STRING_MAX = 300
/** A projected frame stays readable even with several long fields. */
const LINE_MAX = 1200
const ERRORS_MAX = 3
const DEPTH_MAX = 4

const ELLIPSIS = '\u2026'

/** Cut to {@link HEAL_STRING_MAX} characters (the last one an ellipsis when cut). */
export function truncateHeal(s: string, max: number = HEAL_STRING_MAX): string {
  return s.length > max ? `${s.slice(0, max - 1)}${ELLIPSIS}` : s
}

// ---- redaction ---------------------------------------------------------------------------------------------------

/** Heal-mode redaction for this machine: secrets, emails, the home folder, the user and host names. */
export function healRedactOptions(): RedactOptions {
  const o: RedactOptions = { mode: 'heal', home: homedir() }
  try {
    const u = userInfo().username
    if (u !== '') o.username = u
  } catch {
    // no user name on this system
  }
  try {
    o.hostname = hostname()
  } catch {
    // no host name
  }
  return o
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g
/** The evidence block's own delimiters; a line carrying them could close the block early (prompt injection). */
const DELIMITER = /<<<\s*EVIDENCE|EVIDENCE\s*>>>/gi

/** One evidence string: ANSI and control characters removed, redacted, delimiters defused, truncated. */
export function cleanHealText(s: string, redact: RedactOptions, max: number = HEAL_STRING_MAX): string {
  const plain = s.replace(ANSI, '').replace(/\t/g, ' ').replace(CONTROL, '')
  const red = redactText(plain, redact).text.replace(DELIMITER, '[delimiter removed]')
  return truncateHeal(red.trim(), max)
}

// ---- frame projection ----------------------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type JsonObject = { [k: string]: Json }

const isObj = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Claude frame types that carry the conversation (text, tool calls and results, progress). */
const CONTENT_TYPES: ReadonlySet<string> = new Set([
  'stream_event',
  'user',
  'tool_progress',
  'tool_use_summary',
  'keep_alive',
  'prompt_suggestion',
  'streamlined_text',
  'streamlined_tool_use_summary',
])
/** Claude `system` subtypes that carry content (sub-agent prompts, hook output, file names, command output). */
const CONTENT_SYSTEM_SUBTYPE = /^(task_|hook_|files_persisted|local_command)/
/** Codex `exec --json` item events (messages, commands and their output, file changes). */
const CONTENT_TYPE_PREFIX = /^(item\.|response_item)/
/**
 * JSON-RPC methods that carry content: Codex app-server items, deltas, diffs and plans, legacy `codex/event/*`,
 * approvals (their command or patch); ACP session updates, permission requests, file and terminal calls.
 */
const CONTENT_METHOD =
  /^(item\/|codex\/event\/|rawResponseItem\/|turn\/(diff|plan)\/|session\/(update|request_permission|prompt)|fs\/|terminal\/|execCommandApproval|applyPatchApproval)|delta/i

/** Scalar keys kept from a status frame (everything else is dropped, whatever it holds). */
const SAFE_SCALARS: ReadonlySet<string> = new Set([
  'type',
  'subtype',
  'method',
  'status',
  'error',
  'errors',
  'code',
  'message',
  'is_error',
  'error_status',
  'api_error_status',
  'terminal_reason',
  'stop_reason',
  'stopReason',
  'num_turns',
  'duration_ms',
  'attempt',
  'max_retries',
  'retry_delay_ms',
  'model',
  'permissionMode',
  'apiKeySource',
  'claude_code_version',
  'tool_name',
  'rateLimitType',
  'resetsAt',
  'overageStatus',
  'isUsingOverage',
  'willRetry',
  'httpStatusCode',
  'additionalDetails',
  'codexErrorInfo',
  'success',
  'usedPercent',
  'windowDurationMins',
  'exitCode',
  'exit_code',
  'signal',
  'retryAfter',
  'retry_after',
  'retryAfterMs',
  'protocolVersion',
])
/** Nested objects searched for more safe keys. */
const SAFE_NESTED: ReadonlySet<string> = new Set([
  'error',
  'request',
  'response',
  'rate_limit_info',
  'params',
  'turn',
  'result',
  'rateLimits',
  'primary',
  'secondary',
])

const scalar = (v: Json, redact: RedactOptions): Json | undefined => {
  if (typeof v === 'string') return cleanHealText(v, redact)
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v
  return undefined
}

function project(o: JsonObject, redact: RedactOptions, depth: number): JsonObject {
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === 'result' && typeof v === 'string') continue // Claude's answer text: see projectFrame
    if (k === 'codexErrorInfo' && isObj(v)) {
      out[k] = Object.keys(v).join(',')
      continue
    }
    if (k === 'errors' && Array.isArray(v)) {
      const list = v
        .map((x) => scalar(x, redact))
        .filter((x): x is Json => x !== undefined && typeof x !== 'object')
      if (list.length > 0) out[k] = list.slice(-ERRORS_MAX)
      continue
    }
    if (SAFE_NESTED.has(k) && isObj(v)) {
      if (depth >= DEPTH_MAX) continue
      const inner = project(v, redact, depth + 1)
      if (Object.keys(inner).length > 0) out[k] = inner
      continue
    }
    if (!SAFE_SCALARS.has(k)) continue
    const s = scalar(v, redact)
    if (s !== undefined) out[k] = s
  }
  return out
}

const str = (v: Json | undefined): string | undefined => (typeof v === 'string' ? v : undefined)

/** The text of a Claude assistant API-error message (`message.content[].text`, or a projected `message`). */
function assistantErrorText(f: JsonObject): string {
  const m = f['message']
  if (typeof m === 'string') return m
  const content = isObj(m) ? m['content'] : undefined
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is JsonObject => isObj(b) && b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => str(b['text']) ?? '')
    .join(' ')
}

/**
 * A vendor stdout frame as heal evidence, or null when it is a content frame (or carries nothing). Only allowlisted
 * status keys survive, so a field Dim Factory has never seen cannot carry content through. Exceptions, mirroring the
 * classifier's own evidence (heal/signals/claude.ts `texts`): an error result's `result` text and an assistant
 * API-error message (`error` set), which are the vendor's error text rather than the model's answer.
 */
export function projectFrame(frame: unknown, redact: RedactOptions): JsonObject | null {
  if (!isObj(frame)) return null
  const type = str(frame['type'])
  const subtype = str(frame['subtype'])
  const method = str(frame['method'])
  if (type !== undefined) {
    if (CONTENT_TYPES.has(type) || CONTENT_TYPE_PREFIX.test(type)) return null
    if (type === 'system' && subtype !== undefined && CONTENT_SYSTEM_SUBTYPE.test(subtype)) return null
    if (type === 'rate_limit_event') {
      const info = frame['rate_limit_info']
      if (isObj(info) && info['status'] === 'allowed') return null
    }
    if (type === 'assistant') {
      const error = str(frame['error'])
      if (error === undefined) return null
      const out: JsonObject = { type, error: cleanHealText(error, redact) }
      if (frame['is_api_error_message'] === true) out['is_api_error_message'] = true
      const text = cleanHealText(assistantErrorText(frame), redact)
      if (text !== '') out['message'] = text
      return out
    }
  }
  if (method !== undefined && CONTENT_METHOD.test(method)) return null
  const out = project(frame, redact, 0)
  if (type === 'result') {
    const failed = frame['is_error'] === true || (subtype !== undefined && subtype !== 'success')
    const result = str(frame['result'])
    if (failed && result !== undefined && result.trim() !== '') out['result'] = cleanHealText(result, redact)
  }
  const keys = Object.keys(out)
  // A JSON-RPC response with nothing safe left (a successful `{id, result:{…}}`) says nothing.
  if (keys.length === 0) return null
  return out
}

// ---- tail filter ---------------------------------------------------------------------------------------------------

export type HealTailStream = 'stderr' | 'stdout' | 'exit'

const PREFIX = /^(stderr|stdout|exit): ?/

const looksJson = (s: string): boolean => /^\s*[[{]/.test(s)

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return undefined
  }
}

/** A raw-log record (`runs/<id>/raw/*.ndjson`: `{t, dir, line}`, or a fixture recording's frame). */
function asRecord(v: unknown): { dir: string; line?: string; code?: unknown; signal?: unknown } | undefined {
  if (!isObj(v)) return undefined
  const dir = v['dir']
  if (dir !== 'in' && dir !== 'out' && dir !== 'err' && dir !== 'exit') return undefined
  if (dir !== 'exit' && typeof v['line'] !== 'string') return undefined
  return {
    dir,
    ...(typeof v['line'] === 'string' ? { line: v['line'] } : {}),
    code: v['code'],
    signal: v['signal'],
  }
}

function stdoutLine(payload: string, redact: RedactOptions): string | null {
  if (payload.trim() === '') return null
  if (looksJson(payload)) {
    const parsed = parseJson(payload)
    // Unreadable or non-object JSON: never pass a broken content frame through as text.
    if (!isObj(parsed)) return 'stdout: [unreadable frame dropped]'
    const projected = projectFrame(parsed, redact)
    return projected === null ? null : `stdout: ${truncateHeal(JSON.stringify(projected), LINE_MAX)}`
  }
  // Plain text on a JSON protocol's stdout: a CLI status or error line (the classifier reads it too).
  const text = cleanHealText(payload, redact)
  return text === '' ? null : `stdout: ${text}`
}

function stderrLine(payload: string, redact: RedactOptions): string | null {
  const text = cleanHealText(payload, redact)
  return text === '' ? null : `stderr: ${text}`
}

/**
 * One input line as heal evidence, or null when it is dropped. Accepts raw-log records (`{t, dir, line}`: `in` is
 * dropped, `out` projected, `err` kept as text), lines this filter already produced (`stderr: …`, `stdout: …`,
 * `exit: …`; filtered again, so filtering is idempotent), a bare vendor JSON frame (projected as stdout), and plain
 * text (treated as stderr).
 */
export function filterHealLine(line: string, redact: RedactOptions = healRedactOptions()): string | null {
  const raw = line.replace(/\r$/, '')
  if (raw.trim() === '') return null
  const prefixed = PREFIX.exec(raw)
  if (prefixed !== null) {
    const payload = raw.slice(prefixed[0].length)
    if (prefixed[1] === 'stderr') return stderrLine(payload, redact)
    if (prefixed[1] === 'stdout') return stdoutLine(payload, redact)
    const text = cleanHealText(payload, redact)
    return text === '' ? null : `exit: ${text}`
  }
  if (looksJson(raw)) {
    const parsed = parseJson(raw)
    const rec = asRecord(parsed)
    if (rec !== undefined) {
      if (rec.dir === 'in') return null
      if (rec.dir === 'err') return stderrLine(rec.line ?? '', redact)
      if (rec.dir === 'exit') {
        const code = typeof rec.code === 'number' ? rec.code : null
        const signal = typeof rec.signal === 'string' ? cleanHealText(rec.signal, redact, 32) : null
        return `exit: code ${code ?? 'none'}${signal !== null ? `, signal ${signal}` : ''}`
      }
      return stdoutLine(rec.line ?? '', redact)
    }
    if (isObj(parsed) && parsed['kind'] === 'header') return null
    return stdoutLine(raw, redact)
  }
  return stderrLine(raw, redact)
}

/** Collapse runs of identical lines into one with a count (api_retry and status frames repeat). */
function collapse(lines: readonly string[]): string[] {
  const out: string[] = []
  let prev: string | undefined
  let n = 0
  const flush = (): void => {
    if (prev === undefined) return
    out.push(n > 1 ? `${prev} (repeated ${n} times)` : prev)
  }
  for (const l of lines) {
    const base = l.replace(/ \(repeated \d+ times\)$/, '')
    const count = Number(/ \(repeated (\d+) times\)$/.exec(l)?.[1] ?? 1)
    if (base === prev) n += count
    else {
      flush()
      prev = base
      n = count
    }
  }
  flush()
  return out
}

/**
 * The heal tail: every line through {@link filterHealLine}, repeats collapsed, the last `max` (40) kept. Feed it a
 * pass's raw log lines, a classifier `raw`, or a tail this function already built.
 */
export function filterHealTail(
  lines: readonly string[],
  o: { max?: number; redact?: RedactOptions } = {},
): string[] {
  const redact = o.redact ?? healRedactOptions()
  const kept: string[] = []
  for (const l of lines) {
    for (const part of l.split('\n')) {
      const f = filterHealLine(part, redact)
      if (f !== null) kept.push(f)
    }
  }
  return collapse(kept).slice(-(o.max ?? HEAL_TAIL_LINES))
}

/**
 * Read a pass's raw log (`runs/<id>/raw/<step>-<attempt>.ndjson`) as heal evidence, streaming so a large log costs no
 * more memory than its kept lines. A missing file is an empty tail.
 */
export async function readHealTail(
  file: string,
  o: { max?: number; redact?: RedactOptions } = {},
): Promise<string[]> {
  const redact = o.redact ?? healRedactOptions()
  const max = o.max ?? HEAL_TAIL_LINES
  const kept: string[] = []
  try {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      const f = filterHealLine(line, redact)
      if (f === null) continue
      kept.push(f)
      // Keep a margin so collapsing repeats still leaves `max` distinct lines.
      if (kept.length > max * 8) kept.splice(0, kept.length - max * 4)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return collapse(kept).slice(-max)
}

// ---- signature -----------------------------------------------------------------------------------------------------

/** One line reduced to its shape: ids, numbers, paths and quoted values replaced, case and spacing folded. */
export function normalizeSignatureLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/(?:[a-z]:)?(?:[\\/][^\s\\/'"`:;,)]+){2,}[\\/]?/g, '<path>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<hex>')
    .replace(/\d+(?:\.\d+)*/g, '#')
    .replace(/\(repeated # times\)$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The cache's "normalized stderr signature": the stderr lines of the tail, normalized and de-duplicated,
 * plus the failure message; the stdout status frames stand in when there is no stderr at all.
 */
export function healSignature(message: string, tail: readonly string[]): string {
  const stderr = tail.filter((l) => l.startsWith('stderr: '))
  const source = stderr.length > 0 ? stderr : tail.filter((l) => l.startsWith('stdout: '))
  const lines = [...new Set([normalizeSignatureLine(message), ...source.map(normalizeSignatureLine)])]
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex').slice(0, 32)
}

// ---- env, probe, pass config ---------------------------------------------------------------------------------------

/** Versions only: no environment variable values ever (they may hold secrets). */
export interface HealEnv {
  os: OsFamily
  /** e.g. `10.0.26200`. */
  osRelease: string
  arch: string
  /** PowerShell, or the POSIX login shell's name (`bash`, `zsh`), else `sh`. */
  shell: string
  node: string
  /** `2.17.1`, or null when git was not found. */
  git: string | null
}

const OS_NAMES: Readonly<Record<OsFamily, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

/** This machine's {@link HealEnv}; `git` comes from the caller (core/git's cached `git --version`). */
export function localHealEnv(git: string | null, platform: NodeJS.Platform = process.platform): HealEnv {
  const os = osFamily(platform)
  const shellName = basename(process.env['SHELL'] ?? '')
  return {
    os,
    osRelease: release(),
    arch: process.arch,
    shell: os === 'win32' ? 'PowerShell' : /^[a-z]{1,12}$/.test(shellName) ? shellName : 'sh',
    node: process.versions.node,
    git,
  }
}

function envSummary(env: HealEnv, redact: RedactOptions): string {
  const parts = [
    `${OS_NAMES[env.os]} ${env.osRelease} (${env.arch})`,
    `shell ${env.shell}`,
    `Node ${env.node}`,
    `git ${env.git ?? 'not found'}`,
  ]
  return cleanHealText(parts.join(' · '), redact)
}

function probeSummary(
  req: HealRequest,
  probe: ProbeResult | null | undefined,
  os: OsFamily,
  redact: RedactOptions,
): string {
  const parts: string[] = []
  if (probe === null || probe === undefined) {
    parts.push(`${req.vendor} ${req.vendorVersion ?? 'version unknown'}; no probe result`)
  } else {
    const head = [
      `${probe.vendor} ${probe.version ?? req.vendorVersion ?? 'version unknown'}`,
      probe.route !== undefined ? `route ${probe.route}` : undefined,
      probe.ok ? 'ready' : 'not ready',
    ].filter((s): s is string => s !== undefined)
    parts.push(head.join(', '))
    const checks = probe.checks.map((c) =>
      cleanHealText(`${c.id} ${c.status}${c.status === 'pass' ? '' : `: ${c.title}`}`, redact, 160),
    )
    if (checks.length > 0) parts.push(`checks: ${checks.join('; ')}`)
  }
  const install = commandFor('install', req.vendor, os)
  if (install !== null) parts.push(`official installer: ${install.command}`)
  return cleanHealText(parts.join('. '), redact, 1500)
}

function quoteArg(a: string): string {
  return /^[\w.:=/\\@,+-]+$/.test(a) ? a : JSON.stringify(a)
}

function passConfigSummary(argv: readonly string[], redact: RedactOptions): string {
  if (argv.length === 0) return 'not available'
  const args = argv.map((a) => quoteArg(cleanHealText(a, redact)))
  return truncateHeal(`argv: ${args.join(' ')}`, 2000)
}

function triggerSummary(req: HealRequest, redact: RedactOptions): string {
  const f = req.failure
  const step = req.step ?? f.step
  const where =
    step === undefined ? 'a pass' : step === 'probe' ? 'the vendor check' : `the ${stepLabel(step)} step`
  const who = req.trigger === 'auto' ? 'automatic diagnosis' : 'diagnosis requested by the user'
  const head = `${who} of a ${f.category} failure (classified by ${f.classifiedBy}) in ${where} on ${req.vendor} ${
    req.vendorVersion ?? '(version unknown)'
  }`
  const message = cleanHealText(f.message, redact)
  return message === '' ? head : `${head}. Message: ${message}`
}

// ---- the input -----------------------------------------------------------------------------------------------------

export interface HealInputContext {
  /** The failing vendor's probe (versions and check statuses only). */
  probe?: ProbeResult | null
  env: HealEnv
  redact?: RedactOptions
}

/** The heal template's values (its placeholders) plus what the cache key needs. */
export interface HealInput {
  values: {
    trigger: string
    probe: string
    passConfig: string
    env: string
    tail: string
    shell: string
    os: string
  }
  /** The filtered tail (at most 40 lines). */
  tail: string[]
  /** Normalized stderr signature (heal cache key part). */
  signature: string
}

/**
 * Build the healer's whole input from a request. The tail goes through {@link filterHealTail} again (whatever the
 * caller passed), and the failure's own `raw` is used, filtered the same way, when the request has no tail. Nothing
 * else reaches the prompt: no task, plan, diff, file body or environment variable value.
 */
export function buildHealInput(req: HealRequest, ctx: HealInputContext): HealInput {
  const redact = ctx.redact ?? healRedactOptions()
  let tail = filterHealTail(req.tail, { redact })
  if (tail.length === 0 && req.failure.raw.trim() !== '') tail = filterHealTail([req.failure.raw], { redact })
  const os = ctx.env.os
  return {
    values: {
      trigger: triggerSummary(req, redact),
      probe: probeSummary(req, ctx.probe, os, redact),
      passConfig: passConfigSummary(req.passArgv, redact),
      env: envSummary(ctx.env, redact),
      tail: tail.length > 0 ? tail.join('\n') : '(no output)',
      shell: os === 'win32' ? 'PowerShell' : 'sh',
      os: OS_NAMES[os],
    },
    tail,
    signature: healSignature(req.failure.message, tail),
  }
}
