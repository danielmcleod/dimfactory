#!/usr/bin/env node
// Turns live Claude and Codex recordings into synthetic ones with the same protocol shape, so no recording of a real
// account is ever published. Deterministic: the same input always gives the same output (every generated value is
// derived from a SHA-256 of a fixed seed and the value it replaces), so the script can be re-run at any time.
//
//   node scripts/synthesize-fixtures.mjs [--from <dir>] [--to <dir>] [--only <id,id>] [--check]
//
// --from  the folder of live recordings, laid out like tests/fixtures (default tests/fixtures-private, which is
//         kept out of the published tree; without it there is nothing to synthesize and the script says so).
// --to    where the synthetic recordings go (default tests/fixtures), at the same relative paths.
// --only  only these scenario ids.
// --check write nothing; exit 1 when an output would differ from what is on disk.
//
// What it replaces, in the vendor's frames (our own host frames stay byte for byte, except where they echo a value the
// vendor sent: an id, or a tool input the host hands back, which change exactly as the vendor's copy does):
//   - every id: UUIDs anywhere in a line (session, thread, turn, item, request, installation), the vendor's
//     prefixed ids (msg_, req_, toolu_, call_, rs_ ...), task and agent ids, process ids, socket names, git shas;
//     each becomes a fake one of the same shape, marked `fa4e`, the same fake for the same id in every file;
//   - times: the header's recordedAt becomes 2030-01-01, and every timestamp (ISO strings, epoch seconds or ms
//     under a time key) moves by the same offset, so durations and orders stay as recorded;
//   - account data: the subscription or plan, organization and email, rate-limit details (utilization and used
//     percentages), the model-access lists (rebuilt from the app's own seed catalog), account-specific tools,
//     commands and skills (only the public ones stay; the redaction placeholders stay as they are);
//   - all free text from the model (streamed and final text, plans, thinking, tool inputs, subagent prompts and
//     summaries, approval reasons, questions) and every tool output (command output, file contents, web results):
//     each word becomes a fake word of the same length and case, so streamed deltas still add up to the final text
//     at the same offsets. Tokens that are code (paths, flags, identifiers, numbers, placeholders, inline code,
//     ALL-CAPS words and a few verdict words the parsers read) stay, so the app treats the text the same way.
// Kept: the protocol itself (types, methods, enums, tool names, model ids, permission modes), the vendor CLI's own
// messages (errors, denials, warnings: the classifier reads them), token counts, and every invariant the replay
// tests check (one terminal event, deltas equal to the final text, asks answered, usage sums).
// Each output's header says `"synthesized": true` with a `synthesizedFrom` note that names no account data.
// Also rewritten from their private copies: a fake-CLI script made from a recording, `claude auth status` captures,
// and a live recipe's pass.json and notes (the ids of the thread a resume continues, the allow rules it quotes).
// Recordings built by a generator of their own (recipes/**/synthesize.mjs) are left to it.
//
// Exit: 0 written (or --check clean) · 1 --check found a difference · 2 usage error
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PRIVATE_DIR = join(ROOT, 'tests', 'fixtures-private')
export const PUBLIC_DIR = join(ROOT, 'tests', 'fixtures')

const SEED = 'dim-factory-synthesized-fixtures/1'
/** The marker every generated id carries ("fake"). */
export const FAKE_MARK = 'fa4e'
/** recordedAt of every synthesized recording; the other times keep their offset from it. */
export const BASE_TIME = '2030-01-01T00:00:00.000Z'
const BASE_MS = Date.parse(BASE_TIME)

export const SYNTH_NOTE =
  'scripts/synthesize-fixtures.mjs: ids, times, account data, model lists and all model text and tool output are generated'

const hash = (kind, value) => createHash('sha256').update(`${SEED}|${kind}|${value}`).digest()
const hex = (kind, value) => hash(kind, value).toString('hex')
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---- ids ------------------------------------------------------------------------------------------------------

const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
/** The vendors' own prefixed ids: Anthropic message, request and tool ids; OpenAI response item and call ids. */
const PREFIXED_ID_RE = /\b(msg|req|toolu|srvtoolu|call|rs|fc|ws|resp|ig|ci)_([A-Za-z0-9]{16,})\b/g
/** The Claude CLI's per-process socket name. */
const SOCKET_RE = /\bcc-msg-([0-9a-f]{16,})\b/g
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A fake UUID for `id`: `fa4e…`, version 4 shape, the same case as the original. Fakes map to themselves. */
export function fakeUuid(id) {
  if (id.toLowerCase().startsWith(FAKE_MARK)) return id
  const h = hex('uuid', id.toLowerCase())
  const out = `${FAKE_MARK}${h.slice(0, 4)}-${h.slice(4, 8)}-4${h.slice(8, 11)}-8${h.slice(11, 14)}-${h.slice(14, 26)}`
  return id === id.toUpperCase() && /[A-F]/.test(id) ? out.toUpperCase() : out
}

/** A fake of `body` with the same length and alphabet (hex stays hex), starting with the fake marker. */
export function fakeToken(body, kind = 'token') {
  if (body.toLowerCase().startsWith(FAKE_MARK)) return body
  const isHex = /^[0-9a-f]+$/.test(body)
  const bytes = Buffer.concat([hash(kind, body), hash(`${kind}+`, body), hash(`${kind}++`, body)])
  let out = FAKE_MARK
  for (let i = 0; out.length < body.length; i++)
    out += isHex ? (bytes[i % bytes.length] % 16).toString(16) : BASE62[bytes[i % bytes.length] % 62]
  return out.slice(0, body.length)
}

/** Digits only (a process id): same length, never starting with 0. */
function fakeDigits(digits) {
  const h = hash('digits', digits)
  let out = String((h[0] % 9) + 1)
  for (let i = 1; out.length < digits.length; i++) out += String(h[i % h.length] % 10)
  return out
}

/** Every id-shaped string in a serialized line → its fake (UUIDs, prefixed ids, socket names, then `extra`). */
export function fakeIdsInText(text, extra = new Map()) {
  let out = text
    .replace(UUID_RE, (m) => fakeUuid(m))
    .replace(PREFIXED_ID_RE, (m, p, body) => `${p}_${fakeToken(body, p)}`)
    .replace(SOCKET_RE, (m, body) => `cc-msg-${fakeToken(body, 'socket')}`)
  for (const [from, to] of extra) if (out.includes(from)) out = out.split(from).join(to)
  return out
}

/** Keys whose string values are ids without a recognizable shape (collected first, then replaced everywhere). */
const ID_KEYS = new Set(['task_id', 'agent_id', 'agentId', 'harnessSectionHash'])
const NUMERIC_ID_KEYS = new Set(['processId'])

function collectIds(value, out) {
  if (Array.isArray(value)) value.forEach((v) => collectIds(v, out))
  else if (isObject(value))
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && v.length >= 6 && ID_KEYS.has(k) && !v.startsWith(FAKE_MARK))
        out.set(v, fakeToken(v, k))
      else if (typeof v === 'string' && /^\d{2,}$/.test(v) && NUMERIC_ID_KEYS.has(k))
        out.set(v, fakeDigits(v))
      else collectIds(v, out)
    }
}

// ---- times ----------------------------------------------------------------------------------------------------

const ISO_IN_TEXT_RE = /\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z\b/g
const TIME_KEY_RE = /^(?:timestamp|recordedAt|generatedAt|[a-z]*(?:At|AtMs)|end_time|start_time)$/

/** `iso` moved by `offsetMs`, keeping its fraction digits. */
function shiftIso(iso, offsetMs) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?Z$/.exec(iso)
  if (!m) return iso
  const ms = Date.parse(`${m[1]}Z`)
  if (Number.isNaN(ms)) return iso
  const shifted = new Date(ms + offsetMs).toISOString().slice(0, 19)
  return `${shifted}${m[2] ?? ''}Z`
}

function shiftTimes(value, offsetMs, key) {
  if (typeof value === 'number' && key !== undefined && TIME_KEY_RE.test(key)) {
    if (value > 1e12) return value + offsetMs
    if (value > 1e9) return value + Math.round(offsetMs / 1000)
    return value
  }
  // ISO strings move once, with every other ISO time in the serialized line (synthesizeRecording).
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, offsetMs, undefined))
  if (isObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = shiftTimes(v, offsetMs, k)
    return out
  }
  return value
}

// ---- text -----------------------------------------------------------------------------------------------------

const SYLLABLES = [
  'lo',
  'rem',
  'ip',
  'sum',
  'do',
  'lor',
  'sit',
  'am',
  'et',
  'con',
  'sec',
  'te',
  'tur',
  'ad',
  'pi',
  'sci',
  'el',
  'it',
  'sed',
  'ei',
  'us',
  'mod',
  'tem',
  'por',
  'in',
  'ci',
  'dunt',
  'ut',
  'la',
  'bo',
  're',
  'ma',
  'gna',
  'ali',
  'qua',
  'ven',
]
/** Words the parsers read in model text (verdicts, finding tags), kept wherever they appear. */
const KEEP_WORDS = new Set([
  'no',
  'findings',
  'none',
  'lgtm',
  'looks',
  'good',
  'issues',
  'problems',
  'concerns',
  'must',
  'should',
  'nit',
  'blocker',
  'critical',
  'major',
  'minor',
  'security',
  'grounding',
  'recommended',
])
/** Program names: code wherever they appear (a command the model ran keeps its program, and its allow rule with it). */
const PROGRAM_WORDS = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'git',
  'python',
  'pip',
  'mkdir',
  'mv',
  'cp',
  'rm',
  'ls',
  'cat',
  'echo',
  'rg',
  'grep',
  'curl',
  'bash',
  'sh',
  'powershell',
  'pwsh',
  'cmd',
])

/** A fake word for a run of letters: same length, same case pattern, made of lorem syllables. */
export function fakeWord(run) {
  const h = hash('word', run.toLowerCase())
  let w = ''
  for (let i = 0; w.length < run.length; i++) w += SYLLABLES[h[i % h.length] % SYLLABLES.length]
  w = w.slice(0, run.length)
  // Same length in UTF-16 units as the original (a letter outside the BMP is two units).
  while (w.length < run.length) w += 'x'
  if (run.length > 1 && run === run.toUpperCase() && run !== run.toLowerCase()) return w.toUpperCase()
  if (run[0] !== run[0].toLowerCase()) return w[0].toUpperCase() + w.slice(1)
  return w
}

const EDGE_OPEN = /^[*_"'“”‘’(«]+/
const EDGE_CLOSE = /[*_"'“”‘’),.;:!?»]+$/

/** A whitespace-free token that is code rather than prose (kept as it is). */
export function isCodeLike(token) {
  const core = token.replace(EDGE_OPEN, '').replace(EDGE_CLOSE, '')
  if (core === '') return true
  if (/[`/\\.=<>{}[\]$@#:_|~^&%+*0-9]/.test(core)) return true
  if (core.startsWith('-')) return true
  if (/[a-z][A-Z]/.test(core)) return true
  // A PowerShell cmdlet (Verb-Noun).
  if (/^[A-Z][a-z]+-[A-Z][A-Za-z]+$/.test(core)) return true
  if (core.length > 1 && /^[A-Z][A-Z-]*$/.test(core)) return true
  return KEEP_WORDS.has(core.toLowerCase()) || PROGRAM_WORDS.has(core.toLowerCase())
}

/**
 * Model text → synthetic text of exactly the same length: every prose word becomes a fake word, code-like tokens and
 * whitespace stay. Purely per token, so the same words give the same fakes in streamed deltas and final texts.
 */
export function fakeProse(text) {
  if (typeof text !== 'string' || text === '') return text
  // JSON the model wrote (a whole answer, or a fenced block) keeps its keys and protocol values, so it still parses
  // as the same structure.
  if (/^\s*[{[]/.test(text) && isJsonText(text)) return rewriteJsonText(text, (v, k) => fakeInput(v, k))
  // split() with a capturing group puts each fenced block at an odd index.
  return text
    .split(/(```[^\n]*\n[\s\S]*?```)/)
    .map((part, i) => {
      const m = i % 2 === 1 ? /^(```[^\n]*\n)([\s\S]*?)(```)$/.exec(part) : null
      if (m === null) return fakeWords(part)
      const body = isJsonText(m[2]) ? rewriteJsonText(m[2], (v, k) => fakeInput(v, k)) : fakeWords(m[2])
      return `${m[1]}${body}${m[3]}`
    })
    .join('')
}

function isJsonText(text) {
  try {
    const v = JSON.parse(text)
    return v !== null && typeof v === 'object'
  } catch {
    return false
  }
}

/** Prose → fake words of the same length; code-like tokens and whitespace stay. */
function fakeWords(text) {
  return text.replace(/\S+/g, (tok) =>
    isCodeLike(tok) ? tok : tok.replace(/\p{L}+/gu, (run) => fakeWord(run)),
  )
}

/** Tool-input keys whose values are protocol choices or identifiers, never free text. */
const KEEP_INPUT_KEYS = new Set([
  'subagent_type',
  'model',
  'mode',
  'type',
  'behavior',
  'toolName',
  'destination',
  'vendor',
  'id',
  'aliases',
  'run_in_background',
  'multiSelect',
  'output_mode',
  'sourceUrl',
  'url',
])

/** A tool input (or structured output): keys stay, string values become synthetic text. */
export function fakeInput(value, key) {
  if (typeof value === 'string') {
    if (key !== undefined && KEEP_INPUT_KEYS.has(key)) return value
    if (key === 'generatedAt' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value
    return fakeProse(value)
  }
  if (Array.isArray(value)) return value.map((v) => fakeInput(v, key === 'aliases' ? key : undefined))
  if (isObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = fakeInput(v, k)
    return out
  }
  return value
}

/** Tool result fields that are protocol values, kept. */
const KEEP_RESULT_KEYS = new Set([
  'type',
  'status',
  'agentType',
  'resolvedModel',
  'url',
  'filePath',
  'filenames',
  'matches',
  'code',
  'codeText',
  'interrupted',
  'isImage',
  'agentId',
  'outputFile',
  'tool_name',
  'kind',
  'non_execution_kind',
  'durationMs',
  'numFiles',
  'mode',
  'model',
  'harnessSectionHash',
])
/** A tool's result text the CLI wrote (an error or a refusal), kept for the classifier. */
const CLI_RESULT_RE =
  /^(?:Error:|<tool_use_error>|User rejected|Permission|The user doesn't want|\[Request interrupted)/

function fakeToolResult(value, key) {
  if (typeof value === 'string') {
    if (key !== undefined && KEEP_RESULT_KEYS.has(key)) return value
    if (CLI_RESULT_RE.test(value)) return value
    return fakeProse(value)
  }
  if (Array.isArray(value)) return value.map((v) => fakeToolResult(v, key === 'filenames' ? key : undefined))
  if (isObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = fakeToolResult(v, k)
    return out
  }
  return value
}

/**
 * Rewrites the string values of a JSON text in place (keys, numbers and layout stay), each through `leaf(value, key)`;
 * a truncated text (a stream cut short) is handled up to where it ends. Used on streamed tool-input JSON, so the
 * chunks can be cut again at the original offsets.
 */
export function rewriteJsonText(text, leaf) {
  let out = ''
  let i = 0
  const keys = []
  let pendingKey
  const containers = []
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const closed = j < text.length
      const raw = text.slice(i, closed ? j + 1 : text.length)
      let k = closed ? j + 1 : text.length
      while (k < text.length && /\s/.test(text[k])) k++
      const isKey = containers.at(-1) === '{' && text[k] === ':'
      if (isKey || !closed) {
        if (isKey) pendingKey = JSON.parse(raw)
        out += raw
      } else {
        let decoded
        try {
          decoded = JSON.parse(raw)
        } catch {
          decoded = undefined
        }
        if (typeof decoded === 'string') {
          const key = containers.at(-1) === '[' ? keys.at(-1) : pendingKey
          const replaced = leaf(decoded, key)
          const enc = JSON.stringify(replaced)
          out += enc.length === raw.length || replaced === decoded ? (replaced === decoded ? raw : enc) : enc
        } else out += raw
      }
      i = closed ? j + 1 : text.length
      continue
    }
    if (c === '{' || c === '[') {
      containers.push(c)
      keys.push(c === '[' ? pendingKey : pendingKey)
    } else if (c === '}' || c === ']') {
      containers.pop()
      keys.pop()
    } else if (c === ',') {
      if (containers.at(-1) === '{') pendingKey = undefined
    }
    out += c
    i++
  }
  return out
}

/** Cut `text` at the given chunk lengths (the original deltas'); a length change goes into the last chunk. */
function resplit(text, lengths) {
  const parts = []
  let at = 0
  lengths.forEach((n, idx) => {
    const last = idx === lengths.length - 1
    parts.push(last ? text.slice(at) : text.slice(at, at + n))
    at += n
  })
  return parts
}

// ---- lists and account ----------------------------------------------------------------------------------------

/** Tools every Claude Code install has (and MCP tools); account features (cron, design, remote triggers …) go. */
const PUBLIC_CLAUDE_TOOLS = new Set([
  'Task',
  'Agent',
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
  'NotebookEdit',
  'NotebookRead',
  'PowerShell',
  'Read',
  'Skill',
  'SlashCommand',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'StructuredOutput',
  'TaskStop',
  'TaskOutput',
  'Monitor',
])
/** Built-in commands that are public and that the app or its tests use; other built-ins are account features. */
const PUBLIC_CLAUDE_COMMANDS = new Set([
  'compact',
  'context',
  'clear',
  'config',
  'doctor',
  'init',
  'mcp',
  'model',
  'agents',
  'effort',
  'usage',
  'review',
  'security-review',
  'output-style',
  'fast',
  'focus',
  'color',
  'rename',
  'reload-plugins',
])
const REDACTED = '<REDACTED>'
const keepCommandName = (n) => n === REDACTED || PUBLIC_CLAUDE_COMMANDS.has(n) || /^mcp__/.test(n)
const keepToolName = (n) => PUBLIC_CLAUDE_TOOLS.has(n) || /^mcp__/.test(n)

const SEED_CATALOG = JSON.parse(
  readFileSync(join(ROOT, 'src', 'core', 'catalog', 'seed', 'pricing.seed.json'), 'utf8'),
)

const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max']
/** The Claude model list every synthesized initialize reply carries: the seed catalog's Claude models. */
function claudeModels() {
  const entries = SEED_CATALOG.entries.filter((e) => e.vendor === 'claude')
  const display = (id) =>
    id
      .replace(/^claude-/, '')
      .replace(/-\d{8}$/, '')
      .replace(/^(\w)/, (c) => c.toUpperCase())
      .replace(/-(\d+)-(\d+)$/, ' $1.$2')
      .replace(/-(\d+)$/, ' $1')
  const list = [
    {
      value: 'default',
      resolvedModel: 'claude-sonnet-5-5',
      displayName: 'Default (recommended)',
      description: fakeProse('Sonnet for everyday tasks'),
      supportsEffort: true,
      supportedEffortLevels: effortLevels,
    },
  ]
  for (const e of entries) {
    const alias = e.aliases.find((a) => !a.startsWith('claude-'))
    list.push({
      value: alias ?? e.model,
      resolvedModel: e.model,
      displayName: display(e.model),
      description: fakeProse(`Model ${display(e.model)} for sample tasks`),
      ...(e.model.includes('haiku') ? {} : { supportsEffort: true, supportedEffortLevels: effortLevels }),
    })
  }
  return list
}

/**
 * The Codex model list (model/list): which models are listed decides what a pass with no model runs (a model the list
 * lacks is overridden), so the ids and the schema-required access programs stay; every description becomes synthetic text.
 */
function codexModels(original) {
  return original.map((m) =>
    isObject(m)
      ? {
          ...m,
          ...(typeof m.description === 'string' ? { description: fakeProse(m.description) } : {}),
          ...(Array.isArray(m.supportedReasoningEfforts)
            ? {
                supportedReasoningEfforts: m.supportedReasoningEfforts.map((r) =>
                  isObject(r) && typeof r.description === 'string'
                    ? { ...r, description: fakeProse(r.description) }
                    : r,
                ),
              }
            : {}),
        }
      : m,
  )
}

/** The CLI process id an initialize reply reports. */
const FAKE_PID = 4242
const FAKE_ACCOUNT = {
  email: 'user@example.invalid',
  organization: REDACTED,
  subscriptionType: 'Example Plan',
}

function fakeRateLimitInfo(info) {
  if (!isObject(info)) return info
  const out = { ...info }
  const warn = out.status === 'allowed_warning'
  const level = warn ? 0.8 : 0.25
  if (typeof out.utilization === 'number') out.utilization = level
  if (isObject(out.unifiedWindows))
    out.unifiedWindows = Object.fromEntries(
      Object.entries(out.unifiedWindows).map(([k, w]) => [
        k,
        isObject(w) && typeof w.utilization === 'number'
          ? { ...w, utilization: k === out.rateLimitType ? level : 0.25 }
          : w,
      ]),
    )
  if (typeof out.overageDisabledReason === 'string') out.overageDisabledReason = 'synthetic'
  return out
}

// ---- Claude frames ----------------------------------------------------------------------------------------------

function claudeOut(f, ctx) {
  if (!isObject(f)) return f
  const t = f.type
  if (t === 'stream_event' && isObject(f.event)) {
    const ev = f.event
    if (ev.type === 'content_block_delta' && isObject(ev.delta)) {
      const replacement = ctx.deltaOut.get(ctx.frameIndex)
      const d = { ...ev.delta }
      if (replacement !== undefined) d[replacement.field] = replacement.text
      if (typeof d.signature === 'string' && d.signature !== '') d.signature = REDACTED
      return { ...f, event: { ...ev, delta: d } }
    }
    return f
  }
  // The CLI's own assistant messages (model "<synthetic>": not logged in, an API error) are CLI text: kept.
  if (
    t === 'assistant' &&
    isObject(f.message) &&
    f.message.model !== '<synthetic>' &&
    f.error === undefined
  ) {
    const content = Array.isArray(f.message.content)
      ? f.message.content.map((c) => {
          if (!isObject(c)) return c
          if (c.type === 'text') return { ...c, text: fakeProse(c.text) }
          if (c.type === 'thinking') return { ...c, thinking: fakeProse(c.thinking) }
          if (c.type === 'tool_use') return { ...c, input: fakeInput(c.input) }
          return c
        })
      : f.message.content
    const out = { ...f, message: { ...f.message, content } }
    if (isObject(f.wire_tool_inputs))
      out.wire_tool_inputs = Object.fromEntries(
        Object.entries(f.wire_tool_inputs).map(([k, v]) => [k, fakeInput(v)]),
      )
    if (typeof f.task_description === 'string') out.task_description = fakeProse(f.task_description)
    return out
  }
  if (t === 'user' && isObject(f.message)) {
    const out = { ...f }
    const m = f.message
    if (typeof m.content === 'string') out.message = { ...m, content: fakeUserText(m.content) }
    else if (Array.isArray(m.content))
      out.message = {
        ...m,
        content: m.content.map((c) => {
          if (!isObject(c)) return c
          if (c.type === 'text') return { ...c, text: fakeUserText(c.text) }
          if (c.type !== 'tool_result' || c.is_error === true) return c
          if (typeof c.content === 'string') return { ...c, content: fakeToolResult(c.content) }
          if (Array.isArray(c.content))
            return {
              ...c,
              content: c.content.map((x) =>
                isObject(x) && x.type === 'text' ? { ...x, text: fakeToolResult(x.text) } : x,
              ),
            }
          return c
        }),
      }
    if (f.tool_use_result !== undefined) out.tool_use_result = fakeToolResult(f.tool_use_result)
    if (typeof f.task_description === 'string') out.task_description = fakeProse(f.task_description)
    return out
  }
  if (t === 'control_request' && isObject(f.request)) {
    const r = { ...f.request }
    if (r.subtype === 'can_use_tool') {
      if (r.input !== undefined) r.input = fakeInput(r.input)
      if (typeof r.description === 'string') r.description = fakeProse(r.description)
      if (Array.isArray(r.permission_suggestions))
        r.permission_suggestions = r.permission_suggestions.map(fakeSuggestion)
    }
    return { ...f, request: r }
  }
  if (t === 'control_response' && isObject(f.response) && isObject(f.response.response)) {
    const r = { ...f.response.response }
    if (Array.isArray(r.commands))
      r.commands = r.commands.filter((c) => !isObject(c) || keepCommandName(c.name))
    if (Array.isArray(r.models)) r.models = claudeModels()
    if (isObject(r.account)) {
      const a = { ...r.account }
      for (const k of Object.keys(FAKE_ACCOUNT)) if (k in a) a[k] = FAKE_ACCOUNT[k]
      r.account = a
    }
    if (typeof r.pid === 'number') r.pid = FAKE_PID
    if (Array.isArray(r.available_output_styles))
      r.available_output_styles = r.available_output_styles.filter((s) =>
        ['default', 'Explanatory', 'Learning'].includes(s),
      )
    return { ...f, response: { ...f.response, response: r } }
  }
  if (t === 'system') {
    const s = { ...f }
    if (f.subtype === 'init') {
      if (Array.isArray(s.tools)) s.tools = s.tools.filter((n) => typeof n !== 'string' || keepToolName(n))
      for (const k of ['slash_commands', 'skills'])
        if (Array.isArray(s[k])) s[k] = s[k].filter((n) => typeof n !== 'string' || keepCommandName(n))
      if (Array.isArray(s.available_output_styles))
        s.available_output_styles = s.available_output_styles.filter((x) =>
          ['default', 'Explanatory', 'Learning'].includes(x),
        )
    }
    if (f.subtype === 'task_started') {
      if (typeof s.description === 'string') s.description = fakeProse(s.description)
      if (typeof s.prompt === 'string') s.prompt = fakeProse(s.prompt)
    }
    if (f.subtype === 'task_progress' && typeof s.description === 'string')
      s.description = fakeProse(s.description)
    if (f.subtype === 'task_notification' && typeof s.summary === 'string') s.summary = fakeProse(s.summary)
    if (f.subtype === 'background_tasks_changed' && Array.isArray(s.tasks))
      s.tasks = s.tasks.map((x) =>
        isObject(x) && typeof x.description === 'string'
          ? { ...x, description: fakeProse(x.description) }
          : x,
      )
    return s
  }
  if (t === 'result') {
    const r = { ...f }
    if (typeof r.result === 'string' && r.is_error !== true) r.result = fakeProse(r.result)
    if (r.structured_output !== undefined) r.structured_output = fakeInput(r.structured_output)
    if (Array.isArray(r.permission_denials))
      r.permission_denials = r.permission_denials.map((d) =>
        isObject(d) ? { ...d, tool_input: fakeInput(d.tool_input) } : d,
      )
    return r
  }
  if (t === 'rate_limit_event') return { ...f, rate_limit_info: fakeRateLimitInfo(f.rate_limit_info) }
  return f
}

/** A user-role text the CLI emits: its own markers stay; a compaction summary (model text) after its first line. */
function fakeUserText(text) {
  if (typeof text !== 'string') return text
  if (/^<local-command-|^\[Request interrupted/.test(text)) return text
  const nl = text.indexOf('\n')
  if (/^This session is being continued/.test(text) && nl > 0)
    return text.slice(0, nl) + fakeProse(text.slice(nl))
  return fakeProse(text)
}

function fakeSuggestion(s) {
  if (!isObject(s) || !Array.isArray(s.rules)) return s
  return {
    ...s,
    rules: s.rules.map((r) =>
      isObject(r) && typeof r.ruleContent === 'string' ? { ...r, ruleContent: fakeProse(r.ruleContent) } : r,
    ),
  }
}

/** A host frame that hands a vendor value back: an approved tool input or an allow rule. */
function claudeIn(f) {
  if (
    !isObject(f) ||
    f.type !== 'control_response' ||
    !isObject(f.response) ||
    !isObject(f.response.response)
  )
    return f
  const r = { ...f.response.response }
  if (r.updatedInput !== undefined) r.updatedInput = fakeInput(r.updatedInput)
  if (Array.isArray(r.updatedPermissions)) r.updatedPermissions = r.updatedPermissions.map(fakeSuggestion)
  return { ...f, response: { ...f.response, response: r } }
}

/** Claude stream reassembly: each content block's deltas, joined, rewritten, and cut at the original offsets. */
function claudeDeltas(frames) {
  const streams = new Map()
  const seq = new Map()
  frames.forEach((fr, i) => {
    if (fr.dir !== 'out' || fr.json === undefined || fr.json.type !== 'stream_event') return
    const ev = fr.json.event
    if (!isObject(ev)) return
    const owner = `${fr.json.session_id ?? ''}|${fr.json.parent_tool_use_id ?? ''}`
    if (ev.type === 'message_start') seq.set(owner, (seq.get(owner) ?? 0) + 1)
    if (ev.type !== 'content_block_delta' || !isObject(ev.delta)) return
    const field =
      ev.delta.type === 'text_delta'
        ? 'text'
        : ev.delta.type === 'thinking_delta'
          ? 'thinking'
          : ev.delta.type === 'input_json_delta'
            ? 'partial_json'
            : undefined
    if (field === undefined || typeof ev.delta[field] !== 'string') return
    const key = `${owner}|${seq.get(owner) ?? 0}|${ev.index}|${field}`
    let s = streams.get(key)
    if (s === undefined) streams.set(key, (s = { field, parts: [] }))
    s.parts.push({ frame: i, text: ev.delta[field] })
  })
  const out = new Map()
  for (const s of streams.values()) {
    const full = s.parts.map((p) => p.text).join('')
    const rewritten =
      s.field === 'partial_json' ? rewriteJsonText(full, (v, k) => fakeInput(v, k)) : fakeProse(full)
    const cut = resplit(
      rewritten,
      s.parts.map((p) => p.text.length),
    )
    s.parts.forEach((p, idx) => out.set(p.frame, { field: s.field, text: cut[idx] }))
  }
  return out
}

// ---- Codex frames -----------------------------------------------------------------------------------------------

function codexItem(item) {
  if (!isObject(item)) return item
  const it = { ...item }
  switch (it.type) {
    case 'agentMessage':
    case 'agent_message':
    case 'plan':
      if (typeof it.text === 'string') it.text = fakeProse(it.text)
      break
    case 'reasoning':
      for (const k of ['summary', 'content'])
        if (Array.isArray(it[k]))
          it[k] = it[k].map((x) => (typeof x === 'string' ? fakeProse(x) : fakeInput(x)))
      if (typeof it.text === 'string') it.text = fakeProse(it.text)
      break
    case 'commandExecution':
    case 'command_execution':
      if (typeof it.command === 'string') it.command = fakeProse(it.command)
      if (Array.isArray(it.commandActions))
        it.commandActions = it.commandActions.map((a) =>
          isObject(a) && typeof a.command === 'string' ? { ...a, command: fakeProse(a.command) } : a,
        )
      for (const k of ['aggregatedOutput', 'aggregated_output', 'stdout', 'stderr', 'formattedOutput'])
        if (typeof it[k] === 'string') it[k] = fakeProse(it[k])
      break
    case 'fileChange':
    case 'file_change':
      if (Array.isArray(it.changes))
        it.changes = it.changes.map((c) =>
          isObject(c) && typeof c.diff === 'string' ? { ...c, diff: fakeProse(c.diff) } : c,
        )
      break
    case 'webSearch':
    case 'web_search':
      if (typeof it.query === 'string') it.query = fakeProse(it.query)
      if (isObject(it.action)) it.action = fakeInput(it.action)
      if (Array.isArray(it.results))
        it.results = it.results.map((r) =>
          isObject(r)
            ? {
                ...r,
                ...(typeof r.title === 'string' ? { title: fakeProse(r.title) } : {}),
                ...(typeof r.snippet === 'string' ? { snippet: fakeProse(r.snippet) } : {}),
              }
            : r,
        )
      break
    case 'mcpToolCall':
    case 'mcp_tool_call':
      if (it.arguments !== undefined) it.arguments = fakeInput(it.arguments)
      if (it.result !== undefined) it.result = fakeToolResult(it.result)
      break
    case 'todo_list':
      if (Array.isArray(it.items)) it.items = it.items.map((x) => fakeInput(x))
      break
    default:
      break
  }
  return it
}

function codexOut(m, ctx) {
  if (!isObject(m)) return m
  const replacement = ctx.deltaOut.get(ctx.frameIndex)
  if (replacement !== undefined && isObject(m.params))
    return { ...m, params: { ...m.params, delta: replacement.text } }
  const out = { ...m }
  if (isObject(m.params)) {
    const p = { ...m.params }
    if (isObject(p.item)) p.item = codexItem(p.item)
    if (isObject(p.turn) && Array.isArray(p.turn.items))
      p.turn = { ...p.turn, items: p.turn.items.map(codexItem) }
    if (typeof p.diff === 'string') p.diff = fakeProse(p.diff)
    if (typeof p.reason === 'string' && /requestApproval$/.test(m.method ?? ''))
      p.reason = fakeProse(p.reason)
    if (/requestApproval$/.test(m.method ?? '')) {
      if (typeof p.command === 'string') p.command = fakeProse(p.command)
      if (Array.isArray(p.commandActions))
        p.commandActions = p.commandActions.map((a) =>
          isObject(a) && typeof a.command === 'string' ? { ...a, command: fakeProse(a.command) } : a,
        )
      if (Array.isArray(p.proposedExecpolicyAmendment))
        p.proposedExecpolicyAmendment = p.proposedExecpolicyAmendment.map(fakeProse)
      if (Array.isArray(p.availableDecisions))
        p.availableDecisions = p.availableDecisions.map((d) =>
          isObject(d) &&
          isObject(d.acceptWithExecpolicyAmendment) &&
          Array.isArray(d.acceptWithExecpolicyAmendment.execpolicy_amendment)
            ? {
                ...d,
                acceptWithExecpolicyAmendment: {
                  ...d.acceptWithExecpolicyAmendment,
                  execpolicy_amendment: d.acceptWithExecpolicyAmendment.execpolicy_amendment.map(fakeProse),
                },
              }
            : d,
        )
    }
    if (/requestUserInput$/.test(m.method ?? '') && Array.isArray(p.questions))
      p.questions = p.questions.map((q) =>
        isObject(q) ? { ...fakeInput({ ...q, id: undefined }), id: q.id } : q,
      )
    if (isObject(p.rateLimits) && isObject(p.rateLimits.primary)) {
      const used = p.rateLimits.primary.usedPercent
      p.rateLimits = {
        ...p.rateLimits,
        primary: { ...p.rateLimits.primary, usedPercent: typeof used === 'number' && used > 0 ? 10 : used },
      }
    }
    out.params = p
  }
  if (isObject(m.result)) {
    const r = { ...m.result }
    if (
      Array.isArray(r.data) &&
      r.data.some((d) => isObject(d) && typeof d.model === 'string' && 'isDefault' in d)
    )
      r.data = codexModels(r.data)
    if (isObject(r.thread) && isObject(r.thread.gitInfo) && typeof r.thread.gitInfo.sha === 'string')
      r.thread = {
        ...r.thread,
        gitInfo: { ...r.thread.gitInfo, sha: fakeToken(r.thread.gitInfo.sha, 'sha') },
      }
    if (isObject(r.turn) && Array.isArray(r.turn.items))
      r.turn = { ...r.turn, items: r.turn.items.map(codexItem) }
    out.result = r
  }
  // codex exec --json events
  if (isObject(m.item)) out.item = codexItem(m.item)
  return out
}

/** Codex stream reassembly: each item's deltas (agent text, plan, command output), rewritten as one text. */
function codexDeltas(frames) {
  const streams = new Map()
  frames.forEach((fr, i) => {
    const m = fr.json
    if (fr.dir !== 'out' || !isObject(m) || typeof m.method !== 'string' || !isObject(m.params)) return
    if (typeof m.params.delta !== 'string' || !/(?:\/delta|Delta)$/.test(m.method)) return
    const key = `${m.method}|${m.params.itemId ?? ''}|${m.params.summaryIndex ?? m.params.contentIndex ?? ''}`
    let s = streams.get(key)
    if (s === undefined) streams.set(key, (s = { parts: [] }))
    s.parts.push({ frame: i, text: m.params.delta })
  })
  const out = new Map()
  for (const s of streams.values()) {
    const cut = resplit(
      fakeProse(s.parts.map((p) => p.text).join('')),
      s.parts.map((p) => p.text.length),
    )
    s.parts.forEach((p, idx) => out.set(p.frame, { field: 'delta', text: cut[idx] }))
  }
  return out
}

// ---- one recording ------------------------------------------------------------------------------------------------

/** One live recording's text → its synthetic text. */
export function synthesizeRecording(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const header = JSON.parse(lines[0])
  if (header.kind !== 'header') throw new Error('not a recording: the first line is not a header')
  const vendor = header.vendor
  const frames = lines.slice(1).map((l) => {
    const fr = JSON.parse(l)
    if (typeof fr.line === 'string') {
      try {
        fr.json = JSON.parse(fr.line)
      } catch {
        fr.json = undefined
      }
    }
    return fr
  })
  // The time origin: the header's recordedAt, else the first time a vendor frame carries (Codex headers have none).
  let originMs = Date.parse(header.recordedAt ?? '')
  if (Number.isNaN(originMs)) originMs = firstTime(frames) ?? BASE_MS
  const offset = Math.round((BASE_MS - originMs) / 1000) * 1000
  const extraIds = new Map()
  for (const fr of frames) if (fr.json !== undefined) collectIds(fr.json, extraIds)
  const deltaOut = vendor === 'claude' ? claudeDeltas(frames) : codexDeltas(frames)

  const outLines = []
  const newHeader = { ...header }
  if (typeof newHeader.recordedAt === 'string') newHeader.recordedAt = BASE_TIME
  if (typeof newHeader.hostVersion === 'string') newHeader.hostVersion = '1.0.0'
  // A pass's allow rules quote the vendor's command, which changes with it.
  if (isObject(newHeader.pass) && Array.isArray(newHeader.pass.allowRules))
    newHeader.pass = {
      ...newHeader.pass,
      allowRules: newHeader.pass.allowRules.map((r) =>
        isObject(r) && isObject(r.match) ? { ...r, match: fakeInput(r.match, undefined) } : r,
      ),
    }
  newHeader.synthesized = true
  newHeader.synthesizedFrom = `a ${vendor} ${header.cliVersion ?? ''} recording of this scenario, rewritten by ${SYNTH_NOTE}`
  delete newHeader.note
  outLines.push(fakeIdsInText(JSON.stringify(newHeader), extraIds))

  frames.forEach((fr, i) => {
    const { json, ...rest } = fr
    const out = { ...rest }
    if (json !== undefined) {
      let v = json
      const ctx = { frameIndex: i, deltaOut }
      if (fr.dir === 'out') v = vendor === 'claude' ? claudeOut(v, ctx) : codexOut(v, ctx)
      else if (fr.dir === 'in' && vendor === 'claude') v = claudeIn(v)
      if (fr.dir !== 'in') v = shiftTimes(v, offset, undefined)
      out.line = JSON.stringify(v)
    } else if (typeof fr.line === 'string' && fr.dir !== 'in') {
      out.line = fr.line.replace(ISO_IN_TEXT_RE, (iso) => shiftIso(iso, offset))
    }
    if (fr.dir === 'file' && typeof out.content === 'string') out.content = fakeProse(out.content)
    let s = fakeIdsInText(JSON.stringify(out), extraIds)
    if (fr.dir !== 'in') s = s.replace(ISO_IN_TEXT_RE, (iso) => shiftIso(iso, offset))
    outLines.push(s)
  })
  return `${outLines.join('\n')}\n`
}

/** The earliest epoch time (ms) under a time key in the vendor's frames, if any. */
function firstTime(frames) {
  let min
  const visit = (v, key) => {
    if (typeof v === 'number' && key !== undefined && TIME_KEY_RE.test(key)) {
      const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : undefined
      if (ms !== undefined && (min === undefined || ms < min)) min = ms
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, undefined))
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) visit(x, k)
  }
  for (const fr of frames) if (fr.dir === 'out' && fr.json !== undefined) visit(fr.json, undefined)
  return min
}

// ---- other files -----------------------------------------------------------------------------------------------

/** A recipe's pass.json: its allow rules quote the vendor's command, rewritten as the recording's header is. */
export function synthesizePass(text) {
  const pass = JSON.parse(text)
  if (Array.isArray(pass.allowRules))
    pass.allowRules = pass.allowRules.map((r) =>
      isObject(r) && isObject(r.match) ? { ...r, match: fakeInput(r.match, undefined) } : r,
    )
  return `${JSON.stringify(pass, null, 2)}\n`
}

/** `claude auth status` captures: the plan and organization become fakes. */
export function synthesizeAuthStatus(text) {
  return text
    .replace(/("subscriptionType":\s*")[^"]*"/g, '$1example"')
    .replace(/("orgId":\s*")[^"]*"/g, `$1${fakeUuid('organization')}"`)
    .replace(/("orgName":\s*")[^"]*"/g, '$1Example Organization"')
    .replace(/^Login method: .*$/m, 'Login method: Claude Example Plan account')
    .replace(/^Organization: .*$/m, 'Organization: Example Organization')
}

/** A fake-CLI script made from a recording: its vendor lines get the same rewrite as the recording's. */
export function synthesizeScript(text, recordingFull) {
  const ids = new Map()
  const out = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) {
      out.push(line)
      continue
    }
    const op = JSON.parse(line)
    // What the script expects the host to send back (an approved tool input) changes as the vendor's copy does.
    if (op.op === 'expectStdin' && isObject(op.match)) op.match = claudeIn(op.match)
    if (op.op === 'stdout' && typeof op.line === 'string') {
      let j
      try {
        j = JSON.parse(op.line)
      } catch {
        j = undefined
      }
      if (j !== undefined) {
        collectIds(j, ids)
        const v = recordingFull ? claudeOut(j, { frameIndex: -1, deltaOut: new Map() }) : j
        op.line = JSON.stringify(v)
      }
    }
    out.push(fakeIdsInText(JSON.stringify(op), ids))
  }
  return out.join('\n')
}

// ---- files ------------------------------------------------------------------------------------------------------

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Every (source, target, kind) pair to write: live files from `from`, already synthesized ones in `to`. */
export function plan({ from = PRIVATE_DIR, to = PUBLIC_DIR, only } = {}) {
  const jobs = []
  const wanted = (p) =>
    only === undefined || only.some((id) => p.split(sep).includes(id) || p.split('/').includes(id))
  for (const src of walk(from)) {
    const rel = relative(from, src)
    if (!wanted(rel)) continue
    const target = join(to, rel)
    if (src.endsWith('recording.jsonl')) jobs.push({ src, target, kind: 'recording' })
    else if (src.endsWith('script.jsonl')) jobs.push({ src, target, kind: 'script' })
    else if (/auth-status[^/\\]*\.txt$/.test(src)) jobs.push({ src, target, kind: 'auth' })
    // A live recipe names the recording's ids (the thread a resume continues) and quotes its allow rules.
    else if (src.endsWith('pass.json')) jobs.push({ src, target, kind: 'pass' })
    else if (rel.split(sep).includes('recipes')) jobs.push({ src, target, kind: 'ids' })
  }
  return jobs
}

export function run(argv) {
  const args = { from: PRIVATE_DIR, to: PUBLIC_DIR, only: undefined, check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') args.from = resolve(argv[++i])
    else if (a === '--to') args.to = resolve(argv[++i])
    else if (a === '--only') args.only = argv[++i].split(',')
    else if (a === '--check') args.check = true
    else {
      console.error(`unknown argument: ${a}`)
      return 2
    }
  }
  if (!existsSync(args.from))
    console.log(`No live recordings at ${args.from}: only already synthesized ones are checked.`)
  let changed = 0
  let written = 0
  for (const job of plan(args)) {
    const input = readFileSync(job.src, 'utf8')
    let output
    if (job.kind === 'recording') output = synthesizeRecording(input)
    else if (job.kind === 'script') output = synthesizeScript(input, true)
    else if (job.kind === 'pass') output = fakeIdsInText(synthesizePass(input))
    else if (job.kind === 'ids') output = fakeIdsInText(input)
    else output = synthesizeAuthStatus(input)
    const current = existsSync(job.target) ? readFileSync(job.target, 'utf8') : undefined
    if (current === output) continue
    changed++
    if (args.check) {
      console.log(`would change: ${relative(ROOT, job.target)}`)
      continue
    }
    mkdirSync(dirname(job.target), { recursive: true })
    writeFileSync(job.target, output)
    written++
  }
  console.log(args.check ? `${changed} file(s) would change` : `${written} file(s) written`)
  return args.check && changed > 0 ? 1 : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = run(process.argv.slice(2))
