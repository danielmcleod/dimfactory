// Codex passes and the user's MCP servers. Codex has no switch that turns every MCP server off without naming it, so
// a pass below Pass through (the read-only passes, Plan, Review, Critic, heal and catalog, by default) names each server
// the user's config.toml defines and switches it off for the pass (`mcp_servers.<name>.enabled=false`), all of them
// at the None level and all but the allowed ones at the Allowed list level, leaving the file itself untouched.
// Only the server names are read, in memory: no value is kept, logged or stored, and the names themselves are
// redacted from everything Dim Factory writes down (raw logs, procs.json, the run's argv, failure text).
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { EnvInput } from '../../proc/env.ts'
import { codexHome } from './session.ts'

/** A name that is safe as one bare segment of a dotted `-c` / config key (TOML bare-key characters only). */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/

export const isSafeServerName = (name: string): boolean => SAFE_NAME.test(name)

export interface ParsedServers {
  /** Server names in the order they first appear (unquoted; not yet checked for key safety). */
  names: string[]
  /** False when the file has a shape this reader does not follow, so it may define servers the list misses. */
  ok: boolean
}

const KEY = String.raw`(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))`
const HEADER = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*${KEY}\s*(?:\.|\])`)
const SERVERS_TABLE = /^\s*\[\s*mcp_servers\s*\]/
const TABLE_KEY = new RegExp(String.raw`^\s*${KEY}\s*[.=]`)
const DOTTED = new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${KEY}\s*[.=]`)
/** Any root key or header that mentions `mcp_servers` (quoted or not), to catch shapes the patterns above miss. */
const MENTIONS = /^\s*\[*\s*["']?mcp_servers["']?\s*[.=\]]/

/**
 * MCP server names in a Codex config.toml, in the shapes TOML allows: `[mcp_servers.<name>]` (and its sub-tables),
 * with bare, "double" or 'single' quoted names and trailing comments; a `[mcp_servers]` table whose keys are servers
 * (`<name> = { … }`, `<name>.command = …`); and dotted keys at the top level (`mcp_servers.<name>.command = …`).
 * Comment lines and multi-line strings are skipped. A shape it does not follow (an inline `mcp_servers = { … }`, an
 * array of tables, an escaped quoted name, an unterminated multi-line string) makes `ok` false.
 */
export function parseCodexMcpServers(toml: string): ParsedServers {
  const names: string[] = []
  let ok = true
  const add = (m: RegExpExecArray | null): boolean => {
    const n = m?.[1] ?? m?.[2] ?? m?.[3]
    if (n === undefined) return false
    if (!names.includes(n)) names.push(n)
    return true
  }
  let table: 'root' | 'servers' | 'other' = 'root'
  let multi: '"""' | "'''" | undefined
  // Open `[` / `{` of a value that spans lines (a multi-line array, or a TOML 1.1 inline table): its lines are not keys.
  let depth = 0
  for (const raw of toml.split(/\r?\n/)) {
    if (multi !== undefined) {
      if (raw.includes(multi)) multi = undefined
      continue
    }
    if (depth > 0) {
      depth = Math.max(0, depth + nesting(raw))
      continue
    }
    if (/^\s*(#|$)/.test(raw)) continue
    const opens = /"""|'''/.exec(raw)
    if (opens !== null) {
      const delim = opens[0] as '"""' | "'''"
      if (!raw.slice(opens.index + 3).includes(delim)) multi = delim
    }
    if (/^\s*\[/.test(raw)) {
      if (SERVERS_TABLE.test(raw)) table = 'servers'
      else {
        const isServer = add(HEADER.exec(raw))
        if (!isServer && MENTIONS.test(raw)) ok = false
        table = 'other'
      }
      continue
    }
    if (table === 'servers') {
      if (!add(TABLE_KEY.exec(raw)) && QUOTED_KEY.test(raw)) ok = false
    } else if (table === 'root') {
      if (!add(DOTTED.exec(raw)) && MENTIONS.test(raw)) ok = false
    }
    if (multi === undefined) depth = Math.max(0, nesting(raw))
  }
  if (multi !== undefined || depth > 0) ok = false
  return { names, ok }
}

/** A key line whose quoted key the name pattern does not take (an escape inside it). */
const QUOTED_KEY = /^\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*[.=]/

/** Net `[` / `{` minus `]` / `}` on a line, outside strings and comments. */
function nesting(line: string): number {
  let n = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '#') break
    if (c === '"' || c === "'") {
      const end = c
      for (i++; i < line.length && line[i] !== end; i++) if (end === '"' && line[i] === '\\') i++
    } else if (c === '[' || c === '{') n++
    else if (c === ']' || c === '}') n--
  }
  return n
}

/** Server names only (the reader's list, whatever `ok` says). */
export function codexMcpServerNames(toml: string): string[] {
  return parseCodexMcpServers(toml).names
}

export interface McpIsolation {
  /** The servers to switch off, every one key-safe. */
  names: string[]
  /**
   * True only when every server Codex could load from a config.toml is in `names`: the user's file was read (or is
   * absent) and fully understood, every name is key-safe, and no project config in the pass folder defines servers.
   * False keeps the honest copy that MCP servers may still load.
   */
  complete: boolean
}

type Reader = (path: string) => string

const isMissing = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The text of a file, `null` when it does not exist, `undefined` when it could not be read. */
function readMaybe(read: Reader, path: string): string | null | undefined {
  try {
    return read(path)
  } catch (err) {
    return isMissing(err) ? null : undefined
  }
}

const exists = (p: string): boolean => {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * The project config files Codex may layer over the user's for a pass in `cwd`: `.codex/config.toml` in the folder and
 * each folder above it up to the git root (the folder itself only when it is in no repository).
 */
export function projectConfigPaths(
  cwd: string,
  isRoot: (dir: string) => boolean = (d) => exists(join(d, '.git')),
): string[] {
  const dirs: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    dirs.push(dir)
    if (isRoot(dir)) return dirs.map((d) => join(d, '.codex', 'config.toml'))
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return [join(resolve(cwd), '.codex', 'config.toml')]
}

/**
 * What a read-only pass switches off: the servers the user's config.toml (under CODEX_HOME as the child sees it, else
 * ~/.codex) defines. Project config files in the pass folder are only checked: Codex loads them for trusted projects
 * only, and naming a server the loaded config does not define fails the pass before its first turn, so a project
 * that defines servers leaves the isolation incomplete rather than guessed at.
 */
export function codexMcpIsolation(o: {
  env: EnvInput
  home?: string | undefined
  cwd?: string | undefined
  read?: Reader | undefined
  isRoot?: ((dir: string) => boolean) | undefined
}): McpIsolation {
  const read: Reader = o.read ?? ((p) => readFileSync(p, 'utf8'))
  const userFile = join(codexHome(o.env, o.home ?? homedir()), 'config.toml')
  const text = readMaybe(read, userFile)
  if (text === undefined) return { names: [], complete: false }
  const parsed = text === null ? { names: [], ok: true } : parseCodexMcpServers(text)
  const names = parsed.names.filter(isSafeServerName)
  let complete = parsed.ok && names.length === parsed.names.length
  if (complete && o.cwd !== undefined && o.cwd !== '') {
    for (const file of projectConfigPaths(o.cwd, o.isRoot)) {
      if (resolve(file).toLowerCase() === resolve(userFile).toLowerCase()) continue
      const project = readMaybe(read, file)
      if (project === null) continue
      if (project === undefined) {
        complete = false
        break
      }
      const p = parseCodexMcpServers(project)
      if (!p.ok || p.names.length > 0) {
        complete = false
        break
      }
    }
  }
  return { names, complete }
}

export const REDACTED_SERVER = '[REDACTED]'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replaces `mcp_servers.<name>` for each switched-off name with `mcp_servers.[REDACTED]` (argv, the thread/start
 * frame, Codex's own errors that quote the key). The identity function when there is nothing to hide.
 */
export function mcpNameRedactor(names: readonly string[]): (text: string) => string {
  if (names.length === 0) return (t) => t
  const alt = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|')
  const re = new RegExp(String.raw`(mcp_servers\s*\.\s*)(?:${alt})(?![A-Za-z0-9_-])`, 'g')
  return (t) => t.replace(re, `$1${REDACTED_SERVER}`)
}
