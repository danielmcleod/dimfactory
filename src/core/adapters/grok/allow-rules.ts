// Readiness `grok-allow-rules` (the readonly row of the Grok mode table, as Claude's read-only passes check their
// shell allow-rules): Grok applies the user's own allow rules before it asks (user guide 22: rules, then remembered
// grants, then the prompt), and it reads them from its own settings and from the user's Claude settings. Rejecting
// every ask cannot stop what such a rule lets through, so a read-only pass (Plan, Review, Critic) is not run while any
// rule would let Grok change files or run a command that can. Only settings files are read (never a credential or
// grant file); Grok's TOML loses its secret lines as it is read (config-toml.ts).
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'
import { allowRulesIn, isReadOnlyShellRule } from '../claude/settings-scan.ts'
import { readGrokToml, tomlBoolOf, tomlEntries, tomlStringsOf } from './config-toml.ts'
import type { TomlEntry } from './config-toml.ts'
import { grokHome } from './home.ts'

export interface GrokAllowRule {
  /** The settings file that holds it. */
  file: string
  /** The rule as written (`Bash(npm *)`, `Edit`), or the setting (`sandbox.auto_allow_bash`). */
  rule: string
}

/**
 * Tools that only read: an allow rule for one of them lets nothing change (Grok approves read-only tools on its own
 * anyway). Compared case-insensitively. Anything else (edits, MCP tools, agents, an unknown name) counts.
 */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'glob',
  'grep',
  'ls',
  'notebookread',
  'websearch',
  'webfetch',
  'todoread',
  'todowrite',
])

/**
 * True when an allow rule could let Grok change files or run a command that can, in a pass that must only read. A shell
 * rule is judged as Claude's are (`isReadOnlyShellRule`); a rule Dim Factory cannot read counts.
 */
export function isRiskyAllowRule(rule: string): boolean {
  const m = /^\s*([A-Za-z][\w.-]*)\s*(?:\((.*)\))?\s*$/s.exec(rule)
  if (m?.[1] === undefined) return true
  const tool = m[1]
  if (/^(?:bash|shell|powershell)$/i.test(tool)) {
    const name = /^powershell$/i.test(tool) ? 'PowerShell' : 'Bash'
    return !isReadOnlyShellRule(m[2] !== undefined ? `${name}(${m[2]})` : name)
  }
  return !READ_TOOLS.has(tool.toLowerCase())
}

const sameFile = (a: string, b: string): boolean =>
  process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()

/**
 * The folders whose project settings Grok reads for a pass in `cwd`: from the folder up to its repository's root (the
 * first folder holding `.git`); without a repository, the folder alone.
 */
export function projectFolders(cwd: string): string[] {
  const start = resolve(cwd)
  const dirs: string[] = []
  let dir = start
  for (let i = 0; i < 64; i++) {
    dirs.push(dir)
    if (existsSync(join(dir, '.git'))) return dirs
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return [start]
}

export interface GrokSettingsFiles {
  /** Claude settings Grok reads permission rules from (user level, then the project's, walking up to the root). */
  claude: string[]
  /** Grok's own TOML settings: its home's config and managed config, then each project folder's `.grok/config.toml`. */
  grok: string[]
}

export interface GrokScanInput {
  cwd: string
  /** The env Grok runs with (GROK_HOME, CLAUDE_CONFIG_DIR). */
  env: EnvInput
  /** The user's home folder. */
  home: string
  /** Default process.platform: `/etc/grok/managed_config.toml` is read on macOS and Linux. */
  platform?: NodeJS.Platform
}

export function grokSettingsFiles(o: GrokScanInput): GrokSettingsFiles {
  const projects = projectFolders(o.cwd)
  const claudeDirs = [join(o.home, '.claude')]
  const configured = getEnv(o.env, 'CLAUDE_CONFIG_DIR')
  if (configured !== undefined && configured.trim() !== '' && isAbsolute(configured))
    claudeDirs.push(configured)
  const claude: string[] = []
  const add = (list: string[], file: string): void => {
    if (!list.some((f) => sameFile(f, file))) list.push(file)
  }
  for (const d of claudeDirs)
    for (const f of ['settings.json', 'settings.local.json']) add(claude, join(d, f))
  for (const d of projects)
    for (const f of ['settings.json', 'settings.local.json']) add(claude, join(d, '.claude', f))
  const home = grokHome(o.env, o.home)
  const grok: string[] = []
  add(grok, join(home, 'config.toml'))
  add(grok, join(home, 'managed_config.toml'))
  if ((o.platform ?? process.platform) !== 'win32') add(grok, '/etc/grok/managed_config.toml')
  for (const d of [...projects].reverse()) add(grok, join(d, '.grok', 'config.toml'))
  return { claude, grok }
}

const PERMISSION_TABLES = new Set(['permission', 'permissions'])

/** The entry's key read from the root: `[permission] allow` and `permission.allow` are both `permission.allow`. */
const fullKey = (e: TomlEntry): string[] => [...e.table, ...e.key]

/** The allow rules of one `rules` value: inline tables `{ action = "allow", tool = "Bash", pattern = "npm *" }`. */
function inlineRuleAllows(value: string): string[] {
  const out: string[] = []
  for (const m of value.matchAll(/\{([^{}]*)\}/g)) {
    const fields = new Map<string, string>()
    for (const f of (m[1] ?? '').matchAll(/([A-Za-z_]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) {
      const v = tomlStringsOf(f[2] ?? '')[0]
      if (f[1] !== undefined && v !== undefined) fields.set(f[1].toLowerCase(), v)
    }
    const action = fields.get('action')?.toLowerCase()
    if (action === 'allow' || action === undefined) out.push(ruleOf(fields))
  }
  // A value with no inline table Dim Factory can read (or a rule without an action) counts as one rule it cannot read.
  if (out.length === 0 && !/^\s*\[\s*\]\s*(?:#.*)?$/.test(value))
    out.push('permission.rules (could not be read)')
  return out
}

const ruleOf = (fields: Map<string, string>): string => {
  const tool = fields.get('tool') ?? fields.get('name') ?? ''
  const pattern = fields.get('pattern') ?? fields.get('command') ?? fields.get('path')
  if (tool === '') return 'permission.rules (could not be read)'
  return pattern !== undefined ? `${tool}(${pattern})` : tool
}

/** The settings of one Grok TOML text that let a tool run unasked: allow rules and the sandbox's bash auto-allow. */
export function grokTomlAllows(text: string): string[] {
  const out: string[] = []
  const entries = tomlEntries(text)
  // `[[permission.rules]]` entries: one rule per table entry.
  const tables = new Map<number, Map<string, string>>()
  for (const e of entries) {
    const key = fullKey(e)
    const head = key[0]?.toLowerCase()
    const name = key.slice(1).join('.').toLowerCase()
    if (head !== undefined && PERMISSION_TABLES.has(head)) {
      if (name === 'allow') out.push(...tomlStringsOf(e.value))
      else if (name === 'rules') out.push(...inlineRuleAllows(e.value))
      else if (e.arrayTable && key[1]?.toLowerCase() === 'rules' && key.length === 3) {
        const fields = tables.get(e.index) ?? new Map<string, string>()
        const v = tomlStringsOf(e.value)[0]
        if (v !== undefined) fields.set((key[2] ?? '').toLowerCase(), v)
        tables.set(e.index, fields)
      }
    }
    if (head === 'sandbox' && name === 'auto_allow_bash' && tomlBoolOf(e.value) !== false)
      out.push('sandbox.auto_allow_bash')
  }
  for (const fields of tables.values()) {
    const action = fields.get('action')?.toLowerCase()
    if (action === 'allow' || action === undefined) out.push(ruleOf(fields))
  }
  return out
}

/**
 * Every setting that would let Grok change files or run a command that can, without asking, in a read-only pass in
 * `cwd`: risky allow rules in the user's Claude settings and in Grok's own (`isRiskyAllowRule`), and the sandbox's
 * bash auto-allow. Empty: Grok asks for everything such a pass could change, and Dim Factory denies each ask.
 */
export function scanGrokAllowRules(o: GrokScanInput): GrokAllowRule[] {
  const files = grokSettingsFiles(o)
  const out: GrokAllowRule[] = []
  for (const file of files.claude) {
    for (const rule of allowRulesIn(file)) if (isRiskyAllowRule(rule)) out.push({ file, rule })
  }
  for (const file of files.grok) {
    const text = readGrokToml(file)
    if (text === undefined) continue
    for (const rule of grokTomlAllows(text)) {
      if (rule === 'sandbox.auto_allow_bash' || isRiskyAllowRule(rule)) out.push({ file, rule })
    }
  }
  return out
}
