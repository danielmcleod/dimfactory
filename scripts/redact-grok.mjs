// Grok profile redaction for fixture recordings (deterministic, in two layers, as for Codex and Gemini: the shared
// stable-id rules in src/shared/redact.ts, and these recorder-only rules). A recording made against a signed-in Grok
// profile carries what only the ACP stream or the profile itself says is personal:
//
//   redactGrokValue(msg)       protocol rules on one agent message (ACP JSON-RPC): the session group folder Grok keeps
//                              under `sessions/` (the URL-encoded sandbox path, or a slug and hash of it), the sign-in
//                              labels an enterprise profile shows in `authMethods` (its SSO issuer, its auth
//                              provider's label), and team, principal and issuer ids in any key spelling. Pure and
//                              idempotent; every value keeps its type. tests/unit/grok/redaction.test.ts checks each
//                              committed Grok recording is a fixed point of it.
//   redactGrokText(text)       the same folder rule on a plain text line (stderr).
//   profileTerms(grokHome)     what the profile's own files name (config.toml MCP servers with their commands, args,
//                              URLs and env values, its OIDC issuer and client id, an external auth provider's command
//                              and label; the user-level AGENTS.md lines), so a mention in free text is redacted too.
//                              Read in memory only; never written; credential files are never opened (NEVER_READ),
//                              and config.toml's secret lines (`api_key`, `env_key`, tokens, secrets)
//                              are dropped as it is read, so their values are never kept.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readGrokToml } from '../src/core/adapters/grok/config-toml.ts'
import { instructionLines } from './redact-codex.mjs'

export const REDACTED = '<REDACTED>'
/** What GROK_HOME (the folder Grok keeps its profile in, default ~/.grok) becomes in a recording. */
export const GROK_HOME_PLACEHOLDER = '<GROK_HOME>'
/** What the session group folder under `sessions/` becomes. */
export const PROJECT_PLACEHOLDER = '<PROJECT>'

/**
 * Files in the Grok home that hold credentials or grants: never opened, not even to redact them. The probe checks
 * auth.json by existence only, and the recorder not at all.
 */
export const NEVER_READ = Object.freeze([
  'auth.json',
  'mcp_credentials.json',
  'credentials.json',
  'trusted_folders.toml',
  'permission.toml',
  '.env',
])

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// `<GROK_HOME>/sessions` or `.grok/sessions` + one segment, with `/` or `\` (raw, JSON-escaped once or twice). The home
// rules run first, so a profile's folder reads one of those two by now; a method name like `x.ai/sessions/list` is not
// a session folder and is left alone.
const SEP = String.raw`(?:\\{1,4}|/)`
const SESSION_GROUP = new RegExp(
  String.raw`((?:<GROK_HOME>|\.grok)${SEP}sessions${SEP})([^\\/"'\s<>|*?]+)`,
  'g',
)

/** The session group folder under `sessions/` in one string; counts the replacements. */
function groupRule(text) {
  let n = 0
  const out = text.replace(SESSION_GROUP, (all, head, segment) => {
    if (segment === PROJECT_PLACEHOLDER) return all
    n++
    return `${head}${PROJECT_PLACEHOLDER}`
  })
  return { text: out, n }
}

/** `redactGrokText`: the session-folder rule on a plain line (stderr, a non-JSON stdout line). */
export function redactGrokText(text) {
  return groupRule(text).text
}

/** Keys whose value names the account's team, its SSO principal or its identity provider. */
const ACCOUNT_KEY = /^(?:team|principal|tenant|org)_?(?:id|type)?$|^(?:oidc_?)?issuer$|^client_?id$/i
/** `authMethods` entries whose name or description an enterprise profile fills in (the defaults stay). */
const LABELLED_METHODS = new Set(['oidc', 'grok.com'])
const DEFAULT_LABELS = new Set(['Grok', 'Sign in with Grok', REDACTED, `Sign in with ${REDACTED}`])

/**
 * The protocol rules on one parsed agent message. Returns a redacted copy and the count of each rule that changed
 * something (grok-project, grok-auth-label, grok-account).
 */
export function redactGrokValue(input) {
  const counts = {}
  if (input === null || typeof input !== 'object') return { value: input, counts }
  const bump = (id) => {
    counts[id] = (counts[id] ?? 0) + 1
  }
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = groupRule(v)
      if (r.n > 0) bump('grok-project')
      return r.text
    }
    if (Array.isArray(v)) return v.map(walk)
    if (!isObject(v)) return v
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && ACCOUNT_KEY.test(k) && x !== REDACTED && x !== '') {
        bump('grok-account')
        out[k] = REDACTED
      } else out[k] = walk(x)
    }
    // An initialize answer's sign-in methods: an SSO issuer or a custom provider label names the employer.
    if (Array.isArray(out.authMethods)) {
      out.authMethods = out.authMethods.map((m) => {
        if (!isObject(m) || !LABELLED_METHODS.has(m.id)) return m
        const next = { ...m }
        for (const key of ['name', 'description']) {
          const label = next[key]
          if (typeof label !== 'string' || DEFAULT_LABELS.has(label)) continue
          bump('grok-auth-label')
          next[key] = key === 'name' ? REDACTED : `Sign in with ${REDACTED}`
        }
        return next
      })
    }
    return out
  }
  return { value: walk(structuredClone(input)), counts }
}

// ---- the profile's own files ------------------------------------------------------------------------------------

/** Reads one profile file as text; refuses the credential files outright. undefined when absent or unreadable. */
export function readProfileText(path) {
  if (NEVER_READ.includes(basename(path))) throw new Error(`refusing to read ${basename(path)} (credentials)`)
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/** A value specific enough to match verbatim anywhere: a path, URL, package or secret, never a plain word. */
const distinctive = (v) =>
  typeof v === 'string' && v.trim().length >= 8 && (/[\\/:@.]/.test(v) || v.trim().length >= 16)

/** The string values on one TOML line (`key = "v"`, `key = 'v'`, `key = ["a", "b"]`); escapes left as written. */
function tomlStrings(line) {
  const eq = line.indexOf('=')
  if (eq === -1) return []
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g
  for (let m = re.exec(line.slice(eq + 1)); m !== null; m = re.exec(line.slice(eq + 1)))
    out.push(m[1] !== undefined ? m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') : m[2])
  return out
}

/** The table a TOML header line opens (`[a.b]`, `[[a.b]]`, quoted parts unquoted), or undefined. */
function tomlTable(line) {
  const m = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)
  if (m === null) return undefined
  const parts = []
  const re = /"([^"]*)"|'([^']*)'|([^.\s]+)/g
  for (let p = re.exec(m[1]); p !== null; p = re.exec(m[1])) parts.push(p[1] ?? p[2] ?? p[3])
  return parts
}

/**
 * The terms a Grok profile names (`<grokHome>/config.toml`, `AGENTS.md`): `literals` (MCP commands, args, URLs and env
 * values, the OIDC issuer and client id, an auth provider's command and label, AGENTS.md lines) are matched verbatim;
 * `names` (MCP server names, 4 characters or more) as whole words in free text. `skipped` is 0 (TOML is read line by
 * line; a line it cannot read names nothing).
 */
export function profileTerms(grokHome) {
  const literals = new Set()
  const names = new Set()
  // config.toml may hold a key (`api_key`, `env_key`; user guide 02): its secret lines are dropped as it is
  // read (src/core/adapters/grok/config-toml.ts), so no such value is kept, matched or written.
  const config = readGrokToml(join(grokHome, 'config.toml'))
  if (config !== undefined) {
    let table = []
    for (const raw of config.split(/\r?\n/)) {
      const line = raw.replace(/^\s+/, '')
      if (line === '' || line.startsWith('#')) continue
      const t = tomlTable(line)
      if (t !== undefined) {
        table = t
        if (table[0] === 'mcp_servers' && table[1] !== undefined && table[1].length >= 4) names.add(table[1])
        continue
      }
      const key = line.slice(0, Math.max(0, line.indexOf('='))).trim()
      const values = tomlStrings(line)
      const inMcp = table[0] === 'mcp_servers'
      const inSso = table[0] === 'grok_com_config' && table[1] === 'oidc'
      const inAuth = table[0] === 'auth' && /^auth_provider_(?:command|label)$/.test(key)
      for (const v of values) {
        if ((inMcp && distinctive(v)) || ((inSso || inAuth) && v.trim().length >= 4)) literals.add(v.trim())
      }
    }
  }
  for (const file of ['AGENTS.md']) {
    const text = readProfileText(join(grokHome, file))
    if (text !== undefined) for (const l of instructionLines(text)) literals.add(l)
  }
  return {
    literals: [...literals].sort((a, b) => b.length - a.length),
    names: [...names].sort((a, b) => b.length - a.length),
    skipped: 0,
  }
}
