// Claude Code's own extensions, read from its settings files (never by running `claude mcp list`, which starts every
// server to check its health): MCP servers of the user (`~/.claude.json` mcpServers), local (that file's
// `projects[<folder>].mcpServers`) and project (`.mcp.json`) scopes; skills of the user (`<config dir>/skills`) and the
// project (`.claude/skills`); enabled plugins (settings `enabledPlugins`) and the skills they bring (`plugin:skill`).
// `CLAUDE_CONFIG_DIR` (as the child sees it) moves both `.claude.json` and the config folder, as it does for the CLI.
// Discovery keeps names only. A server's definition is read for one launch only (launch.ts: the allowed servers'
// config file) and never kept, logged or stored anywhere else: its env values may be secrets.
import type { Dirent } from 'node:fs'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { DiscoveredItem, ExtensionScope } from '../../shared/extensions.ts'
import { isAllowableMcpName, isAllowableSkillName } from '../../shared/extensions.ts'
import type { EnvInput } from '../proc/env.ts'
import { getEnv } from '../proc/env.ts'
import type { Reader } from './files.ts'
import {
  defaultReader,
  foldersHolding,
  foldersToRoot,
  isObj,
  objectAt,
  readJsonObject,
  readMaybe,
} from './files.ts'

/** `${CLAUDE_CONFIG_DIR ?? ~/.claude}` as the child will see it. */
export function claudeDir(env: EnvInput, home: string = homedir()): string {
  const dir = getEnv(env, 'CLAUDE_CONFIG_DIR')
  return dir !== undefined && dir.trim() !== '' ? dir : join(home, '.claude')
}

/** The CLI's global config file: `.config.json` in the config folder when an old install left one, else `.claude.json`. */
export function claudeGlobalFiles(env: EnvInput, home: string = homedir()): string[] {
  const dir = getEnv(env, 'CLAUDE_CONFIG_DIR')
  const base = dir !== undefined && dir.trim() !== '' ? dir : home
  return [join(claudeDir(env, home), '.config.json'), join(base, '.claude.json')]
}

export interface ClaudeMcpServer {
  name: string
  scope: Extract<ExtensionScope, 'user' | 'project' | 'local'>
  /** The server's definition as the settings hold it (command/args/env or url/headers). In memory only. */
  def: Record<string, unknown>
}

export interface ClaudeOptions {
  env: EnvInput
  home?: string | undefined
  /** The pass folder (project and local scopes); absent: user scope only. */
  cwd?: string | undefined
  read?: Reader | undefined
  isRoot?: ((dir: string) => boolean) | undefined
}

const norm = (p: string): string => {
  const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/**
 * The only parts of the CLI's global file Dim Factory keeps: the user scope's `mcpServers` and each project's
 * `mcpServers`. That file also holds the account and, for API key users, the key itself: every other key is dropped
 * the moment the file is parsed, so nothing else of it is ever in memory past this function.
 */
export function claudeGlobalMcpOnly(doc: Record<string, unknown>): {
  mcpServers: Record<string, unknown>
  projects: Record<string, Record<string, unknown>>
} {
  const projects: Record<string, Record<string, unknown>> = {}
  for (const [k, v] of Object.entries(objectAt(doc, 'projects'))) {
    if (isObj(v) && isObj(v['mcpServers'])) projects[k] = v['mcpServers']
  }
  return { mcpServers: objectAt(doc, 'mcpServers'), projects }
}

/**
 * Every MCP server Claude would load for a pass in `cwd`, in precedence order (local, then project, then user: the
 * first definition of a name is the one Claude uses). `complete` is false when a settings file exists but could not
 * be read or understood.
 */
export function readClaudeMcp(o: ClaudeOptions): { servers: ClaudeMcpServer[]; complete: boolean } {
  const read = o.read ?? defaultReader
  const home = o.home ?? homedir()
  let complete = true
  let global: ReturnType<typeof claudeGlobalMcpOnly> | null = null
  for (const file of claudeGlobalFiles(o.env, home)) {
    const g = readJsonObject(read, file)
    if (g === undefined) complete = false
    if (g !== null && g !== undefined) {
      global = claudeGlobalMcpOnly(g)
      break
    }
  }
  const out: ClaudeMcpServer[] = []
  const seen = new Set<string>()
  const add = (scope: ClaudeMcpServer['scope'], servers: Record<string, unknown>): void => {
    for (const [name, def] of Object.entries(servers)) {
      if (seen.has(name) || !isObj(def)) continue
      seen.add(name)
      out.push({ name, scope, def })
    }
  }
  const folders = o.cwd !== undefined && o.cwd !== '' ? foldersToRoot(o.cwd, o.isRoot) : []
  if (folders.length > 0) {
    const byKey = new Map(Object.entries(global?.projects ?? {}).map(([k, v]) => [norm(k), v]))
    for (const dir of folders) {
      const servers = byKey.get(norm(dir))
      if (servers !== undefined) add('local', servers)
    }
    for (const dir of folders) {
      const mcp = readJsonObject(read, join(dir, '.mcp.json'))
      if (mcp === undefined) complete = false
      if (mcp !== null && mcp !== undefined) add('project', objectAt(mcp, 'mcpServers'))
    }
  }
  add('user', global?.mcpServers ?? {})
  return { servers: out, complete }
}

/** The definitions of `names` that Claude would load in `cwd` (missing names are left out). In memory only. */
export function claudeMcpDefinitions(
  o: ClaudeOptions & { names: readonly string[] },
): Record<string, Record<string, unknown>> {
  const wanted = new Set(o.names.filter(isAllowableMcpName))
  const out: Record<string, Record<string, unknown>> = {}
  for (const s of readClaudeMcp(o).servers) if (wanted.has(s.name)) out[s.name] = s.def
  return out
}

/** Enabled plugin ids (`name@marketplace`) of the user and project settings. */
function enabledPlugins(
  o: ClaudeOptions,
  read: Reader,
  folders: readonly string[],
): { ids: string[]; complete: boolean } {
  const dir = claudeDir(o.env, o.home ?? homedir())
  const files = [
    join(dir, 'settings.json'),
    ...folders.flatMap((f) => [
      join(f, '.claude', 'settings.json'),
      join(f, '.claude', 'settings.local.json'),
    ]),
  ]
  const on = new Map<string, boolean>()
  let complete = true
  for (const file of files) {
    const s = readJsonObject(read, file)
    if (s === undefined) complete = false
    for (const [id, v] of Object.entries(objectAt(s, 'enabledPlugins')))
      if (typeof v === 'boolean') on.set(id, v)
  }
  return { ids: [...on].filter(([, v]) => v).map(([id]) => id), complete }
}

/** Where an installed plugin lives (`<config dir>/plugins/installed_plugins.json`, either of its shapes). */
function pluginPaths(o: ClaudeOptions, read: Reader): Map<string, string> {
  const file = join(claudeDir(o.env, o.home ?? homedir()), 'plugins', 'installed_plugins.json')
  const doc = readJsonObject(read, file)
  const out = new Map<string, string>()
  for (const [id, v] of Object.entries(objectAt(doc, 'plugins'))) {
    const entry = Array.isArray(v) ? v.find(isObj) : isObj(v) ? v : undefined
    const path = entry?.['installPath']
    if (typeof path === 'string' && path !== '') out.set(id, path)
  }
  return out
}

/** `*.md` files under `dir` (and its sub-folders, a few levels deep), sorted; empty when `dir` is absent. */
function markdownFiles(dir: string, depth = 3): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p)
    else if (e.isDirectory() && depth > 1) out.push(...markdownFiles(p, depth - 1))
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/** A subagent file's name: its front matter's `name:`, else the file name without `.md`. */
function agentName(read: Reader, file: string): string {
  const text = readMaybe(read, file)
  const fm = typeof text === 'string' ? /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text) : null
  const name = fm !== null ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1] ?? '')?.[1] : undefined
  return name !== undefined && name !== '' ? name : basename(file).replace(/\.md$/i, '')
}

/**
 * The custom subagents Claude would offer a pass in `cwd` (names only): the user's (`<config dir>/agents`), the
 * project's (`.claude/agents` from the folder up to the repository root) and those of every enabled plugin
 * (`<plugin>:<name>`). Its own `permissionMode` does not lift a read-only pass's limits (C20a, C20b), but it brings the
 * user's own prompt, model, tools and MCP servers, so a pass that must stay hermetic runs without the subagent tool
 * when any exists (launch.ts).
 */
export function claudeCustomAgents(o: ClaudeOptions): string[] {
  const read = o.read ?? defaultReader
  const folders = o.cwd !== undefined && o.cwd !== '' ? foldersToRoot(o.cwd, o.isRoot) : []
  const out: string[] = []
  const add = (n: string): void => {
    if (!out.includes(n)) out.push(n)
  }
  for (const dir of folders)
    for (const f of markdownFiles(join(dir, '.claude', 'agents'))) add(agentName(read, f))
  for (const f of markdownFiles(join(claudeDir(o.env, o.home ?? homedir()), 'agents')))
    add(agentName(read, f))
  const paths = pluginPaths(o, read)
  for (const id of enabledPlugins(o, read, folders).ids) {
    const path = paths.get(id)
    if (path === undefined) continue
    const plugin = id.split('@', 1)[0] ?? id
    for (const f of markdownFiles(join(path, 'agents'))) add(`${plugin}:${agentName(read, f)}`)
  }
  return out
}

export interface ClaudeExtensions {
  mcp: DiscoveredItem[]
  skills: DiscoveredItem[]
  plugins: string[]
  /** Custom subagents (informational: they never load in a read-only pass below Pass through). */
  agents: string[]
  complete: boolean
}

/** What Settings > Extensions lists for Claude (names only). */
export function discoverClaude(o: ClaudeOptions): ClaudeExtensions {
  const read = o.read ?? defaultReader
  const mcp = readClaudeMcp(o)
  const folders = o.cwd !== undefined && o.cwd !== '' ? foldersToRoot(o.cwd, o.isRoot) : []
  const skills: DiscoveredItem[] = []
  const seen = new Set<string>()
  const addSkill = (name: string, scope: ExtensionScope): void => {
    if (seen.has(name)) return
    seen.add(name)
    skills.push({ name, scope, allowable: isAllowableSkillName(name) })
  }
  for (const dir of folders)
    for (const n of foldersHolding(join(dir, '.claude', 'skills'), 'SKILL.md')) addSkill(n, 'project')
  for (const n of foldersHolding(join(claudeDir(o.env, o.home ?? homedir()), 'skills'), 'SKILL.md'))
    addSkill(n, 'user')
  const plugins = enabledPlugins(o, read, folders)
  const paths = pluginPaths(o, read)
  for (const id of plugins.ids) {
    const path = paths.get(id)
    if (path === undefined) continue
    const plugin = id.split('@', 1)[0] ?? id
    for (const n of foldersHolding(join(path, 'skills'), 'SKILL.md')) addSkill(`${plugin}:${n}`, 'plugin')
  }
  return {
    mcp: mcp.servers.map((s) => ({ name: s.name, scope: s.scope, allowable: isAllowableMcpName(s.name) })),
    skills,
    plugins: plugins.ids,
    agents: claudeCustomAgents(o),
    complete: mcp.complete && plugins.complete,
  }
}
