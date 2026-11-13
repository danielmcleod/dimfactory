// Codex profile redaction for fixture recordings, including live recordings on the everyday profile
// (tests/fixtures/codex/README.md "Redaction"). The shared rules (src/shared/redact.ts) already take tokens,
// emails, account and installation ids, the home folder, the user name in paths and the host name. A recording made
// against a real ~/.codex also carries what only the Codex protocol or the profile itself says is personal:
//
//   redactCodexValue(msg)    protocol rules on one server message (app-server JSON-RPC or an exec JSONL event): the
//                            machine in the userAgent, the plan, credits and quota windows, the remote-control
//                            identity, MCP server names, errors and tool calls, ChatGPT apps, hooks, config warnings,
//                            custom instructions, a thread's git remote.
//                            Pure and idempotent, and every value keeps its schema type (planType becomes "unknown").
//                            tests/unit/fixtures-redaction.test.ts checks each committed Codex recording is a fixed
//                            point of it.
//   profileTerms(codexHome)  what the profile's own files name (config.toml MCP servers, trusted project folders and
//                            instructions; AGENTS.md; the instructions file), so a mention in free text (a warning,
//                            stderr, the agent's answer) is redacted too. Read in memory only; the recorder reports
//                            counts, never values. Never written to.
//   redactTerms(value, terms) those terms in one parsed message (string values only) or one text line.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REDACTED = '<REDACTED>'
/** A quota window's length and reset time in a recording (numbers, so the frame stays valid; 0 reads as a stand-in). */
export const QUOTA_WINDOW_MINS = 0
export const QUOTA_RESETS_AT = 0

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Keys whose string value is custom instructions text (config, thread settings, collaboration settings). */
const INSTRUCTION_KEY =
  /^(instructions|developer_?instructions|user_?instructions|base_?instructions|compact_?prompt)$/i
/** The ChatGPT plan; replaced with PlanType's own "unknown" so the frame stays valid. */
const PLAN_KEY = /^(plan_?type|chatgpt_?plan_?type)$/i
/** A config object's MCP server table (config/read and friends): server names are its keys. */
const MCP_CONFIG_KEY = /^mcp_?servers$/i
/** Thread items (app-server) and exec items that call one of the user's MCP servers. */
const MCP_ITEM_TYPES = new Set(['mcpToolCall', 'mcp_tool_call'])
/** Elicitation and startup fields that come from the MCP server or name it. */
const MCP_PARAM_TEXT = ['name', 'serverName', 'error', 'message', 'title', 'description', 'challenge', 'url']

// `<originator>/<version> (<os> <os version>; <arch>) <terminal>` + ` (<client>; <client version>)`
/** The host's client suffix is `(<clientInfo.name>; <version>)`: a one-word name (the app's, now or when recorded). */
const USER_AGENT = /^(\S+\/\S+) (.+?)( \([\w-]+; \d+(?:\.\d+)*\))?$/s

/**
 * The userAgent without what identifies the machine (OS build, architecture, terminal): the originator and its
 * version and Dim Factory's own client suffix stay. A value with no space (a fake's "fake") is left alone.
 */
export function redactUserAgent(ua) {
  const m = USER_AGENT.exec(ua)
  if (m !== null) return `${m[1]} ${REDACTED}${m[3] ?? ''}`
  const space = ua.search(/\s/)
  return space === -1 ? ua : `${ua.slice(0, space)} ${REDACTED}`
}

/**
 * The protocol rules on one parsed server message. Returns a redacted copy and the count of each rule that changed
 * something (codex-user-agent, codex-plan, codex-remote-control, codex-mcp, codex-app, codex-hook, codex-config,
 * codex-instructions, codex-git).
 */
export function redactCodexValue(input) {
  const counts = {}
  if (input === null || typeof input !== 'object') return { value: input, counts }
  const value = structuredClone(input)
  const put = (holder, key, next, id) => {
    if (!Object.hasOwn(holder, key)) return
    if (JSON.stringify(holder[key]) === JSON.stringify(next)) return
    holder[key] = next
    counts[id] = (counts[id] ?? 0) + 1
  }
  const putText = (holder, key, id) => {
    if (typeof holder[key] === 'string') put(holder, key, REDACTED, id)
  }
  /** Every string under `v` (but a `type` tag) becomes the placeholder; structure, numbers and booleans stay. */
  const scrub = (v, key) => {
    if (typeof v === 'string') return key === 'type' ? v : REDACTED
    if (Array.isArray(v)) return v.map((x) => scrub(x))
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]))
    return v
  }
  /** An elicitation form schema: its labels and choices come from the MCP server; its shape stays. */
  const scrubSchema = (v) => {
    if (Array.isArray(v)) return v.map(scrubSchema)
    if (!isObject(v)) return v
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (['title', 'description', 'default', 'const'].includes(k) && typeof x === 'string') out[k] = REDACTED
      else if ((k === 'enum' || k === 'enumNames') && Array.isArray(x))
        out[k] = x.map((e) => (typeof e === 'string' ? REDACTED : e))
      else if (k === 'properties' && isObject(x))
        out[k] = Object.fromEntries(Object.entries(x).map(([p, s]) => [p, scrubSchema(s)]))
      else if (['oneOf', 'anyOf', 'items'].includes(k)) out[k] = scrubSchema(x)
      else out[k] = x
    }
    return out
  }
  /** A ChatGPT app: strings become the placeholder, lists empty, nested objects null (all nullable in AppInfo). */
  const scrubApp = (app) => {
    if (!isObject(app)) return app
    const out = {}
    for (const [k, x] of Object.entries(app)) {
      out[k] = typeof x === 'string' ? REDACTED : Array.isArray(x) ? [] : isObject(x) ? null : x
    }
    return out
  }

  // ---- by method (JSON-RPC notifications and server requests) ----
  const method = typeof value.method === 'string' ? value.method : undefined
  const params = isObject(value.params) ? value.params : undefined
  if (method !== undefined && params !== undefined) {
    if (method.startsWith('mcpServer/')) {
      for (const k of MCP_PARAM_TEXT) putText(params, k, 'codex-mcp')
      if (params.requestedSchema !== undefined)
        put(params, 'requestedSchema', scrubSchema(params.requestedSchema), 'codex-mcp')
      if (params._meta !== undefined) put(params, '_meta', scrub(params._meta), 'codex-mcp')
    } else if (method === 'item/mcpToolCall/progress') putText(params, 'message', 'codex-mcp')
    else if (method === 'app/list/updated' && Array.isArray(params.data))
      put(params, 'data', params.data.map(scrubApp), 'codex-app')
    else if (method.startsWith('hook/') && isObject(params.run)) {
      putText(params.run, 'statusMessage', 'codex-hook')
      putText(params.run, 'sourcePath', 'codex-hook')
      if (Array.isArray(params.run.entries)) put(params.run, 'entries', [], 'codex-hook')
    } else if (method === 'configWarning') {
      putText(params, 'summary', 'codex-config')
      putText(params, 'details', 'codex-config')
    }
  }

  // ---- by shape and key, anywhere in the message ----
  const walk = (v) => {
    if (Array.isArray(v)) {
      v.forEach(walk)
      return
    }
    if (!isObject(v)) return
    if (MCP_ITEM_TYPES.has(v.type)) {
      for (const k of ['server', 'tool', 'mcpAppResourceUri']) putText(v, k, 'codex-mcp')
      for (const k of ['arguments', 'result', 'error', 'appContext'])
        if (v[k] !== undefined) put(v, k, scrub(v[k]), 'codex-mcp')
      if (isObject(v.mcpAppUi)) put(v, 'mcpAppUi', null, 'codex-mcp')
    }
    if (Object.hasOwn(v, 'installationId')) {
      // The remote-control identity: the server name defaults to the host name, the environment is the user's.
      if (typeof v.serverName === 'string') put(v, 'serverName', 'host', 'codex-remote-control')
      putText(v, 'environmentId', 'codex-remote-control')
    }
    if (typeof v.hasCredits === 'boolean') putText(v, 'balance', 'codex-plan')
    // A quota window (RateLimitWindow): its length gives the plan away and its reset time dates the account's window;
    // both become fixed numbers, the used percent stays.
    if (typeof v.usedPercent === 'number') {
      if (typeof v.windowDurationMins === 'number')
        put(v, 'windowDurationMins', QUOTA_WINDOW_MINS, 'codex-plan')
      if (typeof v.resetsAt === 'number') put(v, 'resetsAt', QUOTA_RESETS_AT, 'codex-plan')
    }
    if (typeof v.remainingPercent === 'number') {
      putText(v, 'limit', 'codex-plan')
      putText(v, 'used', 'codex-plan')
      if (typeof v.resetsAt === 'number') put(v, 'resetsAt', QUOTA_RESETS_AT, 'codex-plan')
    }
    for (const [k, child] of Object.entries(v)) {
      if (typeof child === 'string') {
        if (k === 'userAgent') put(v, k, redactUserAgent(child), 'codex-user-agent')
        else if (k === 'originUrl')
          put(v, k, REDACTED, 'codex-git') // a thread's gitInfo: the user's remote
        else if (PLAN_KEY.test(k)) put(v, k, 'unknown', 'codex-plan')
        else if (INSTRUCTION_KEY.test(k)) put(v, k, REDACTED, 'codex-instructions')
      } else if (MCP_CONFIG_KEY.test(k) && child !== null && typeof child === 'object') {
        put(v, k, REDACTED, 'codex-mcp')
      } else walk(child)
    }
  }
  walk(value)
  return { value, counts }
}

// ---- the profile's own files ------------------------------------------------------------------------------------

/**
 * Every key path of a TOML document, with its string value (null for a table header, an inline table or a
 * non-string scalar). Arrays yield each string under the array's path. Tolerant: a statement it cannot read is
 * skipped and counted, so a config it does not fully understand still yields the rest.
 */
export function tomlStrings(text) {
  const src = text.replace(/\r\n/g, '\n')
  const n = src.length
  /** @type {{path: string[], value: string | null}[]} */
  const entries = []
  let skipped = 0
  let i = 0
  let table = []
  const fail = () => {
    throw new SyntaxError('toml')
  }
  const ws = () => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++
  }
  const comment = () => {
    if (src[i] === '#') while (i < n && src[i] !== '\n') i++
  }
  /** Whitespace, comments and newlines (inside arrays and inline tables). */
  const gap = () => {
    for (;;) {
      ws()
      comment()
      if (src[i] !== '\n') return
      i++
    }
  }
  const SIMPLE = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' }
  const escape = () => {
    const c = src[i + 1] ?? ''
    i += 2
    if (Object.hasOwn(SIMPLE, c)) return SIMPLE[c]
    const len = c === 'u' ? 4 : c === 'U' ? 8 : c === 'x' ? 2 : 0
    const hex = src.slice(i, i + len)
    if (len === 0 || !new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) fail()
    i += len
    return String.fromCodePoint(Number.parseInt(hex, 16))
  }
  const basic = () => {
    let out = ''
    if (src.startsWith('"""', i)) {
      i += 3
      if (src[i] === '\n') i++
      for (;;) {
        if (i >= n) fail()
        if (src.startsWith('"""', i)) {
          let q = 3
          while (src[i + q] === '"' && q < 5) q++
          i += q
          return out + '"'.repeat(q - 3)
        }
        if (src[i] === '\\') {
          let j = i + 1
          while (src[j] === ' ' || src[j] === '\t') j++
          if (src[j] === '\n') {
            i = j
            while (i < n && /\s/.test(src[i])) i++
            continue
          }
          out += escape()
          continue
        }
        out += src[i++]
      }
    }
    i++
    for (;;) {
      if (i >= n || src[i] === '\n') fail()
      if (src[i] === '"') {
        i++
        return out
      }
      out += src[i] === '\\' ? escape() : src[i++]
    }
  }
  const literal = () => {
    if (src.startsWith("'''", i)) {
      i += 3
      if (src[i] === '\n') i++
      const end = src.indexOf("'''", i)
      if (end === -1) fail()
      let q = 3
      while (src[end + q] === "'" && q < 5) q++
      const out = src.slice(i, end) + "'".repeat(q - 3)
      i = end + q
      return out
    }
    i++
    const end = src.indexOf("'", i)
    const nl = src.indexOf('\n', i)
    if (end === -1 || (nl !== -1 && nl < end)) fail()
    const out = src.slice(i, end)
    i = end + 1
    return out
  }
  const key = () => {
    const parts = []
    for (;;) {
      ws()
      if (src[i] === '"') parts.push(basic())
      else if (src[i] === "'") parts.push(literal())
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 512))
        if (m === null) fail()
        parts.push(m[0])
        i += m[0].length
      }
      ws()
      if (src[i] !== '.') return parts
      i++
    }
  }
  const value = (path) => {
    const c = src[i]
    if (c === '"' || c === "'") {
      entries.push({ path, value: c === '"' ? basic() : literal() })
      return
    }
    if (c === '[' || c === '{') {
      const close = c === '[' ? ']' : '}'
      i++
      if (c === '{') entries.push({ path, value: null })
      for (;;) {
        gap()
        if (src[i] === close) {
          i++
          return
        }
        if (c === '[') value(path)
        else {
          const k = key()
          if (src[i] !== '=') fail()
          i++
          ws()
          value([...path, ...k])
        }
        gap()
        if (src[i] === ',') i++
        else if (src[i] !== close) fail()
      }
    }
    const m = /^[^,\]}\n#]+/.exec(src.slice(i, i + 512))
    if (m === null || m[0].trim() === '') fail()
    i += m[0].length
    entries.push({ path, value: null })
  }
  while (i < n) {
    let statement = i
    try {
      gap()
      if (i >= n) break
      statement = i
      if (src[i] === '[') {
        const array = src[i + 1] === '['
        i += array ? 2 : 1
        const path = key()
        if (!src.startsWith(array ? ']]' : ']', i)) fail()
        i += array ? 2 : 1
        table = path
        entries.push({ path, value: null })
      } else {
        const k = key()
        if (src[i] !== '=') fail()
        i++
        ws()
        value([...table, ...k])
      }
      ws()
      comment()
      if (i < n && src[i] !== '\n') fail()
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err
      skipped++
      const nl = src.indexOf('\n', statement)
      i = nl === -1 ? n : nl + 1
    }
  }
  return { entries, skipped }
}

/** Lines of instructions text worth matching verbatim: list and heading markers off, 24 characters or more. */
export function instructionLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        .trim()
        .replace(/^(?:[-*+>]\s+|#{1,6}\s+|\d+[.)]\s+)+/, '')
        .trim(),
    )
    .filter((l) => l.length >= 24)
}

/** A config value specific enough to match verbatim anywhere: a path, URL, package or secret, never a plain word. */
const distinctive = (v) => v.trim().length >= 8 && (/[\\/:@.]/.test(v) || v.trim().length >= 16)

/** Files whose text Codex adds as instructions (besides the config's own keys). */
const INSTRUCTION_FILES = ['AGENTS.md', 'AGENTS.override.md']
const INSTRUCTIONS_FILE_KEY = /^(model_instructions_file|experimental_instructions_file)$/

function readText(path) {
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * The terms a Codex profile names: `literals` (MCP commands, args, URLs and env
 * values, trusted project folders, instruction lines) are matched verbatim; `names` (MCP server names, 4 characters
 * or more) as whole words in free text. `skipped` counts config statements the scanner could not read.
 */
export function profileTerms(codexHome) {
  const literals = new Set()
  const names = new Set()
  let skipped = 0
  const files = INSTRUCTION_FILES.map((f) => join(codexHome, f))
  const config = readText(join(codexHome, 'config.toml'))
  if (config !== undefined) {
    const toml = tomlStrings(config)
    skipped = toml.skipped
    for (const { path, value } of toml.entries) {
      const mcp = path.findIndex((p) => MCP_CONFIG_KEY.test(p))
      if (mcp !== -1 && path.length > mcp + 1) {
        const name = path[mcp + 1]
        if (name.length >= 4) names.add(name)
        if (value !== null && distinctive(value)) literals.add(value.trim())
      }
      if (path[0] === 'projects' && path.length > 1 && distinctive(path[1])) literals.add(path[1])
      const last = path.at(-1) ?? ''
      if (value !== null && INSTRUCTION_KEY.test(last))
        for (const l of instructionLines(value)) literals.add(l)
      if (value !== null && INSTRUCTIONS_FILE_KEY.test(last)) files.push(resolve(codexHome, value))
    }
  }
  for (const file of files) {
    const text = readText(file)
    if (text !== undefined) for (const l of instructionLines(text)) literals.add(l)
  }
  return {
    literals: [...literals].sort((a, b) => b.length - a.length),
    names: [...names].sort((a, b) => b.length - a.length),
    skipped,
  }
}

// ---- terms in a message or a line -------------------------------------------------------------------------------

/** Keys whose value is free text even without a space (a streamed fragment, a message). */
const PROSE_KEYS = new Set(['delta', 'text', 'message', 'output', 'aggregatedOutput', 'aggregated_output'])

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whole-word matchers for `names` (case-insensitive; a letter or digit next to it means another word). Each entry
 * replaces with `replacement`.
 */
export function wordMatchers(names, replacement = REDACTED) {
  return names.map((name) => ({
    re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, 'gi'),
    replacement,
  }))
}

/**
 * `matchers` in one message (parsed JSON: only string values that read as free text, i.e. with a space or a path
 * separator, or under a prose key, so an enum or id that happens to equal a name is never touched) or one text line.
 * Returns the result and how many replacements were made.
 */
export function redactTerms(value, matchers) {
  let count = 0
  const inText = (s) => {
    let out = s
    for (const { re, replacement } of matchers) {
      out = out.replace(re, () => {
        count++
        return replacement
      })
    }
    return out
  }
  if (matchers.length === 0) return { value, count }
  if (typeof value === 'string') return { value: inText(value), count }
  const walk = (v, key) => {
    if (typeof v === 'string')
      return /[\s/\\]/.test(v) || (key !== undefined && PROSE_KEYS.has(key)) ? inText(v) : v
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return { value: walk(value), count }
}
