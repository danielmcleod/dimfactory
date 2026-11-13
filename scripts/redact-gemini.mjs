// Gemini profile redaction for fixture recordings (deterministic, in two layers, as for Codex: the shared stable-id
// rules in src/shared/redact.ts, and these recorder-only rules). A recording made against a real ~/.gemini carries
// what only the ACP stream or the profile itself says is personal:
//
//   redactGeminiValue(msg)       protocol rules on one agent message (ACP JSON-RPC): the project folder Gemini keeps
//                                under .gemini/tmp (a hash or a short name of the sandbox path), the account's quota
//                                tier and resets in `_meta.quota`, and the user's MCP servers in tool titles and in
//                                the names of permission options. Pure and idempotent; every value keeps its type.
//                                tests/unit/fixtures-redaction.test.ts checks each committed Gemini recording is a
//                                fixed point of it.
//   redactGeminiText(text)       the same path rule on a plain text line (stderr).
//   profileTerms(geminiCliHome)  what the profile's own files name (settings.json MCP servers with their commands,
//                                args, URLs and env values; GEMINI.md lines; custom command and extension names; the
//                                install's own ids), so a mention in free text is redacted too. Read in memory only;
//                                never written; credential files are never opened (NEVER_READ).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { instructionLines } from './redact-codex.mjs'

export const REDACTED = '<REDACTED>'
/** What GEMINI_CLI_HOME (the folder holding `.gemini`) becomes in a recording. */
export const GEMINI_HOME_PLACEHOLDER = '<GEMINI_CLI_HOME>'
/** What the project folder under `.gemini/tmp` (or `.gemini/history`) becomes. */
export const PROJECT_PLACEHOLDER = '<PROJECT>'

/**
 * Files under `.gemini` that hold credentials or the account's identity: never opened, not even to redact them. The
 * probe checks oauth_creds.json by existence only, and so does the recorder (not at all).
 */
export const NEVER_READ = Object.freeze([
  'oauth_creds.json',
  'google_accounts.json',
  'google_account_id',
  'mcp-oauth-tokens.json',
  'a2a-oauth-tokens.json',
  'credentials.json',
  '.env',
])

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// `.gemini` + `tmp` or `history` + one segment, with `/` or `\` (raw, JSON-escaped once or twice).
const SEP = String.raw`(?:\\{1,4}|/)`
const PROJECT_DIR = new RegExp(String.raw`(\.gemini${SEP}(?:tmp|history)${SEP})([^\\/"'\s<>|*?:]+)`, 'g')

/** The project folder under `.gemini/tmp` / `.gemini/history` in one string; counts the replacements. */
function projectRule(text) {
  let n = 0
  const out = text.replace(PROJECT_DIR, (all, head, segment) => {
    if (segment === PROJECT_PLACEHOLDER) return all
    n++
    return `${head}${PROJECT_PLACEHOLDER}`
  })
  return { text: out, n }
}

/** `redactGeminiText`: the project rule on a plain line (stderr, a non-JSON stdout line). */
export function redactGeminiText(text) {
  return projectRule(text).text
}

/** Option ids whose name quotes an MCP server or tool (Gemini toPermissionOptions for an MCP call). */
const MCP_OPTION_IDS = new Set(['proceed_always_server', 'proceed_always_tool'])
/** A Gemini MCP tool's title: `<tool> (<server> MCP Server)`. */
const MCP_TITLE = /^(.+) \((.+) MCP Server\)$/s
/** Inside `_meta.quota`: what names or dates the account's plan (strings) and its window (numbers). */
const QUOTA_TEXT_KEY = /tier|plan|project|account|user|email/i
const QUOTA_NUMBER_KEY = /reset|remaining|limit/i

/**
 * The protocol rules on one parsed agent message. Returns a redacted copy and the count of each rule that changed
 * something (gemini-project, gemini-mcp, gemini-quota).
 */
export function redactGeminiValue(input) {
  const counts = {}
  if (input === null || typeof input !== 'object') return { value: input, counts }
  const bump = (id) => {
    counts[id] = (counts[id] ?? 0) + 1
  }
  const value = structuredClone(input)

  /** Strings under a quota object: plan-like text redacted, reset and remaining numbers 0; token counts stay. */
  const quota = (v) => {
    if (Array.isArray(v)) return v.map(quota)
    if (!isObject(v)) return v
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && QUOTA_TEXT_KEY.test(k) && x !== REDACTED) {
        bump('gemini-quota')
        out[k] = REDACTED
      } else if (typeof x === 'number' && QUOTA_NUMBER_KEY.test(k) && x !== 0) {
        bump('gemini-quota')
        out[k] = 0
      } else out[k] = quota(x)
    }
    return out
  }

  const walk = (v, key) => {
    if (typeof v === 'string') {
      const r = projectRule(v)
      if (r.n > 0) bump('gemini-project')
      let text = r.text
      if (key === 'title') {
        const m = MCP_TITLE.exec(text)
        if (m !== null && (m[1] !== REDACTED || m[2] !== REDACTED)) {
          bump('gemini-mcp')
          text = `${REDACTED} (${REDACTED} MCP Server)`
        }
      }
      return text
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (!isObject(v)) return v
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === 'quota' && isObject(x)) out[k] = quota(walk(x, k))
      else out[k] = walk(x, k)
    }
    // A permission option naming an MCP server or tool: every quoted name becomes the placeholder.
    if (MCP_OPTION_IDS.has(out.optionId) && typeof out.name === 'string') {
      const named = out.name.replace(/"([^"]*)"/g, (all, inner) =>
        inner === REDACTED ? all : `"${REDACTED}"`,
      )
      if (named !== out.name) {
        bump('gemini-mcp')
        out.name = named
      }
    }
    return out
  }
  return { value: walk(value), counts }
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

/** JSON with comments (settings.json allows them): line and block comments outside strings dropped. */
export function parseJsonc(text) {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return undefined
  }
}

/** A value specific enough to match verbatim anywhere: a path, URL, package or secret, never a plain word. */
const distinctive = (v) =>
  typeof v === 'string' && v.trim().length >= 8 && (/[\\/:@.]/.test(v) || v.trim().length >= 16)

/** An MCP server table (settings.json, an extension's manifest): names, and the distinctive values under each. */
function mcpTerms(servers, literals, names) {
  if (!isObject(servers)) return
  for (const [name, def] of Object.entries(servers)) {
    if (name.length >= 4) names.add(name)
    const collect = (v) => {
      if (typeof v === 'string') {
        if (distinctive(v)) literals.add(v.trim())
      } else if (Array.isArray(v)) v.forEach(collect)
      else if (isObject(v)) Object.values(v).forEach(collect)
    }
    collect(def)
  }
}

/** Every file under `dir` (relative paths), for the custom command folders; empty when absent. */
function filesUnder(dir) {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(dir, join(e.parentPath, e.name)))
  } catch {
    return []
  }
}

/** The installed extensions' folders; empty when there are none. */
function extensionDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return []
  }
}

/** `commands/git/commit.toml` → `git:commit` (Gemini's custom command naming). */
const commandName = (rel) =>
  rel
    .replace(/\.toml$/i, '')
    .split(sep)
    .join(':')
    .split('/')
    .join(':')

/**
 * The terms a Gemini profile names (`<geminiCliHome>/.gemini`): `literals` (MCP commands, args, URLs and env values,
 * GEMINI.md lines, the install's ids) are matched verbatim; `names` (MCP server, extension and custom command names,
 * 4 characters or more) as whole words in free text. `skipped` counts JSON files that could not be read.
 */
export function profileTerms(geminiCliHome) {
  const dir = join(geminiCliHome, '.gemini')
  const literals = new Set()
  const names = new Set()
  let skipped = 0
  const settingsText = readProfileText(join(dir, 'settings.json'))
  if (settingsText !== undefined) {
    const settings = parseJsonc(settingsText)
    if (settings === undefined) skipped++
    else mcpTerms(settings.mcpServers, literals, names)
  }
  for (const file of ['GEMINI.md']) {
    const text = readProfileText(join(dir, file))
    if (text !== undefined) for (const l of instructionLines(text)) literals.add(l)
  }
  for (const rel of filesUnder(join(dir, 'commands'))) {
    if (!/\.toml$/i.test(rel)) continue
    const name = commandName(rel)
    if (name.length >= 4) names.add(name)
  }
  for (const ext of extensionDirs(join(dir, 'extensions'))) {
    if (ext.name.length >= 4) names.add(ext.name)
    const text = readProfileText(join(dir, 'extensions', ext.name, 'gemini-extension.json'))
    if (text === undefined) continue
    const manifest = parseJsonc(text)
    if (manifest === undefined) {
      skipped++
      continue
    }
    if (typeof manifest.name === 'string' && manifest.name.length >= 4) names.add(manifest.name)
    mcpTerms(manifest.mcpServers, literals, names)
    for (const rel of filesUnder(join(dir, 'extensions', ext.name, 'commands'))) {
      if (/\.toml$/i.test(rel) && commandName(rel).length >= 4) names.add(commandName(rel))
    }
  }
  // The install's own ids (telemetry), one line each: never sent over ACP as far as known, but stable per install.
  for (const file of ['installation_id', 'user_id']) {
    const id = readProfileText(join(dir, file))?.trim()
    if (id !== undefined && id.length >= 8) literals.add(id)
  }
  return {
    literals: [...literals].sort((a, b) => b.length - a.length),
    names: [...names].sort((a, b) => b.length - a.length),
    skipped,
  }
}
