// Reading Grok's own TOML settings without its secrets (Dim Factory never reads credential files).
// Grok's config.toml may hold a per-model `api_key` (user guide 02 "Precedence", config reference
// `model.<id>.api_key`): every line that sets a key whose value can be a secret is dropped as the file is read, so no
// such value is kept, scanned or matched. Used by the read-only readiness scan (allow-rules.ts) and the recorder's
// Grok profile terms (scripts/redact-grok.mjs). Pure line handling; no TOML library.
import { existsSync, readFileSync, statSync } from 'node:fs'

/**
 * Keys whose value may be a credential: `api_key`, `env_key` (the variable names a key is read from), a token, and
 * anything named secret, password or credential.
 */
export const GROK_SECRET_KEY =
  /^(?:api_?key|env_?key|(?:access_?|refresh_?|id_?|auth_?|bearer_?|session_?)?token)$|secret|password|passwd|credential/i

/** A settings file larger than this is not Grok's own (it is skipped, never read whole). */
export const GROK_TOML_MAX_BYTES = 1024 * 1024

/** The parts of a dotted TOML key (`a."b.c".d` is a, b.c, d), quotes removed. */
function splitKey(raw: string): string[] {
  const parts: string[] = []
  const re = /"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+)/g
  for (let p = re.exec(raw); p !== null; p = re.exec(raw)) parts.push(p[1] ?? p[2] ?? p[3] ?? '')
  return parts
}

/** The key a TOML line sets (`a.b = …`, `"a" = …`: the last dotted part, unquoted), or undefined. */
export function tomlKeyOf(line: string): string | undefined {
  if (!/^\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-])/.test(line)) return undefined
  const eq = line.indexOf('=')
  if (eq === -1) return undefined
  return splitKey(line.slice(0, eq)).at(-1)
}

/** Brackets a value opens and does not close on its line (outside strings), to follow a multi-line array. */
function openBrackets(text: string): number {
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote !== undefined) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = undefined
      continue
    }
    if (c === '#') break
    if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
  }
  return depth
}

/**
 * The text with every secret line dropped: a line that sets a {@link GROK_SECRET_KEY} key, and the rest of its value
 * when that value runs on (a multi-line array, or a `"""` / `'''` string).
 */
export function withoutSecretLines(text: string): string {
  const out: string[] = []
  let skipDepth = 0
  let skipUntil: string | undefined
  for (const line of text.split(/\r?\n/)) {
    if (skipUntil !== undefined) {
      if (line.includes(skipUntil)) skipUntil = undefined
      continue
    }
    if (skipDepth > 0) {
      skipDepth += openBrackets(line)
      continue
    }
    const key = tomlKeyOf(line)
    if (key !== undefined && GROK_SECRET_KEY.test(key)) {
      const value = line.slice(line.indexOf('=') + 1)
      const triple = /^\s*("""|''')/.exec(value)?.[1]
      if (triple !== undefined && value.indexOf(triple, value.indexOf(triple) + 3) === -1) skipUntil = triple
      else skipDepth = Math.max(0, openBrackets(value))
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * A Grok TOML settings file as text, its secret lines dropped ({@link withoutSecretLines}). undefined when it is
 * absent, not a file, larger than {@link GROK_TOML_MAX_BYTES} or unreadable.
 */
export function readGrokToml(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    const st = statSync(path)
    if (!st.isFile() || st.size > GROK_TOML_MAX_BYTES) return undefined
    return withoutSecretLines(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The table a TOML header line opens (`[a.b]`, `[[a.b]]`, quoted parts unquoted), or undefined. */
export function tomlTableOf(line: string): { path: string[]; array: boolean } | undefined {
  const m = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)
  if (m?.[1] === undefined || m[2] === undefined) return undefined
  const parts: string[] = []
  const re = /"([^"]*)"|'([^']*)'|([^.\s]+)/g
  for (let p = re.exec(m[2]); p !== null; p = re.exec(m[2])) parts.push(p[1] ?? p[2] ?? p[3] ?? '')
  return { path: parts, array: m[1] === '[[' }
}

/** One `key = value` of a TOML text: its table, its full dotted key (unquoted) and its raw value (lines joined). */
export interface TomlEntry {
  table: string[]
  /** True inside an `[[array.of.tables]]` entry; `index` counts the entries of that array. */
  arrayTable: boolean
  index: number
  key: string[]
  value: string
}

/** Every `key = value` of a TOML text, a multi-line array's value joined into one string. */
export function tomlEntries(text: string): TomlEntry[] {
  const out: TomlEntry[] = []
  let table: string[] = []
  let arrayTable = false
  const counts = new Map<string, number>()
  let index = 0
  let pending: { key: string[]; value: string; depth: number } | undefined
  for (const line of text.split(/\r?\n/)) {
    if (pending !== undefined) {
      pending.value += `\n${line}`
      pending.depth += openBrackets(line)
      if (pending.depth <= 0) {
        out.push({ table, arrayTable, index, key: pending.key, value: pending.value })
        pending = undefined
      }
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const t = tomlTableOf(line)
    if (t !== undefined) {
      table = t.path
      arrayTable = t.array
      const k = t.path.join('.')
      index = counts.get(k) ?? 0
      if (t.array) counts.set(k, index + 1)
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = splitKey(line.slice(0, eq))
    if (key.length === 0) continue
    const value = line.slice(eq + 1)
    const depth = openBrackets(value)
    if (depth > 0) pending = { key, value, depth }
    else out.push({ table, arrayTable, index, key, value })
  }
  if (pending !== undefined) out.push({ table, arrayTable, index, key: pending.key, value: pending.value })
  return out
}

/** The string values in a raw TOML value (`"v"`, `'v'`, `["a", "b"]`); basic-string escapes `\\` and `\"` read. */
export function tomlStringsOf(value: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g
  for (let m = re.exec(value); m !== null; m = re.exec(value))
    out.push(m[1] !== undefined ? m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') : (m[2] ?? ''))
  return out
}

/** A raw TOML value read as a boolean (`true` / `false`), else undefined. */
export function tomlBoolOf(value: string): boolean | undefined {
  const v = value.replace(/#.*$/, '').trim()
  return v === 'true' ? true : v === 'false' ? false : undefined
}
