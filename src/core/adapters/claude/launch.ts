// Per-pass argv and env for `claude -p` (launch flags, the read-only route; the env is sanitized).
// The prompt never goes in argv: it is the first user message on stdin.
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Mode } from '../../../shared/run.ts'
import { isEffortLevel } from '../../../shared/vendors.ts'
import type { ExtensionLevel } from '../../../shared/extensions.ts'
import { isAllowableMcpName } from '../../../shared/extensions.ts'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv, sanitizeEnv } from '../../proc/env.ts'
import type { StartStep } from '../types.ts'
import {
  AGENT_TOOLS,
  CATALOG_CONFINED_ENV,
  CATALOG_DISALLOWED,
  CATALOG_TOOLS,
  CLAUDEAI_MCP_ENV,
  CLI_FLAGS,
  DISABLE_SKILLS_FLAG,
  ESCALATION_FLAGS,
  MANAGED_FLAGS,
  PLAN_ALLOWED_SETTINGS,
  PLAN_DISALLOWS_SHELL,
  PLAN_SETTINGS,
  READONLY_DISALLOWED,
  RESEARCH_READ_TOOLS,
  READONLY_SETTINGS,
  SHELL_TOOLS,
  STRICT_MCP_READONLY,
  WEB_DOMAIN_PATTERN,
  WEB_SEARCH_TOOL,
  WEB_TOOLS,
  webFetchRule,
} from './capabilities.ts'
import type { ClaudeRoute } from './normalize.ts'

const READ_ONLY_STEPS: readonly StartStep[] = ['review', 'critic', 'heal', 'catalog', 'research']

/**
 * plan + planNative → native plan; review/critic/heal/catalog/research, emulated plan and readonly mode → read-only
 * route.
 */
export function routeFor(o: { step: StartStep; mode: Mode; planNative: boolean }): ClaudeRoute {
  if (o.step === 'plan') return o.planNative ? 'plan' : 'readonly'
  if (READ_ONLY_STEPS.includes(o.step) || o.mode === 'readonly') return 'readonly'
  return 'edit'
}

export function permissionModeFor(route: ClaudeRoute, mode: Mode): string {
  if (route === 'plan') return 'plan'
  if (route === 'readonly') return 'dontAsk'
  return mode === 'full' ? 'bypassPermissions' : 'acceptEdits'
}

export interface ArgvInput {
  route: ClaudeRoute
  mode: Mode
  step: StartStep
  model?: string | null | undefined
  /** `--effort <level>`; null/absent: the CLI's default effort. Anything but a plain level is never passed. */
  effort?: string | null | undefined
  /** Fresh edit sessions: `--session-id=<uuid>`. */
  sessionId?: string | undefined
  /** Fix reuse / resume: `--resume=<id>` and never `--session-id` (C08e: the CLI rejects both). */
  resumeId?: string | undefined
  /** `--allowedTools` for edit passes (AllowRule.nativeRules of the run). */
  nativeRules?: readonly string[]
  /** Readiness found non-read-only shell allow-rules (read-only passes then run without the shell tools). */
  disallowShell?: boolean
  ephemeral?: boolean | undefined
  /**
   * Plan only (continuity): keep the session (no `--no-session-persistence`) under `--session-id`, so Implement can
   * resume it with its own permission mode. The pass's tools and mode stay read-only.
   */
  keepSession?: boolean | undefined
  extraArgs?: readonly string[] | undefined
  flagMap?: Readonly<Record<string, string>> | undefined
  /**
   * `catalog` step only: the hosts page fetches may reach (`WebFetch(domain:<host>)` each). Hosts that are not
   * plain lower-case DNS names are left out; none at all leaves web search alone.
   */
  webDomains?: readonly string[] | undefined
  /** `research` step only: web search and page fetches on any host (absent/false: the repository only). */
  webOpen?: boolean | undefined
  /**
   * The pass's Extensions level (shared/extensions.ts). Absent: the route's own, as before Extensions existed (none
   * on the plan and read-only routes, passthrough on the edit route), and argv is exactly what it was then.
   */
  extensions?: ExtensionLevel | undefined
  /** `allowed`: the file holding the allowed servers' definitions (`--mcp-config`); absent when none was found. */
  mcpConfigPath?: string | undefined
  /**
   * The user, the project or an enabled plugin defines custom subagents (extensions/claude.ts claudeCustomAgents). Their
   * own `permissionMode`, bypassPermissions included, does not lift a read-only pass's `dontAsk` nor the asks of
   * Claude's own plan mode (C20a, C20b). But a custom subagent is the user's own extension (its prompt, model, tools
   * and MCP servers), which None and Allowed list leave out, so the read-only and plan routes below Pass through run
   * without the subagent tool then; built-in subagents only exist otherwise.
   */
  customAgents?: boolean | undefined
  /**
   * `allowed` only: the allowed MCP servers the user lets run without asking (config
   * `extensions.allowed.claude.mcpWithoutAsking`). Each becomes `mcp__<name>__*` in `--allowedTools`; without it a
   * read-only pass's `dontAsk` denies every MCP tool (C21a) and a plan pass's host denies it as a read-only ask.
   */
  mcpWithoutAsking?: readonly string[] | undefined
}

/** The allow rule for every tool of one MCP server (C21b: `dontAsk` then runs them without asking). */
export const mcpServerRule = (name: string): string => `mcp__${name}__*`

/** The `--allowedTools` rules of the servers that run without asking, at the Allowed list level only. */
function mcpAllowRules(i: ArgvInput, level: ExtensionLevel): string[] {
  if (level !== 'allowed') return []
  return (i.mcpWithoutAsking ?? []).filter(isAllowableMcpName).map(mcpServerRule)
}

/** The subagent tool, cut from a read-only or plan pass below Pass through when custom subagents exist. */
function agentCut(i: ArgvInput, level: ExtensionLevel): string[] {
  return level !== 'passthrough' && i.customAgents === true ? [...AGENT_TOOLS] : []
}

/** The level a route runs at when the pass names none (read-only and plan routes none, the edit route passthrough). */
export const routeExtensions = (route: ClaudeRoute): ExtensionLevel =>
  route === 'edit' ? 'passthrough' : 'none'

/**
 * The MCP and hooks part of an argv below Pass through: `--strict-mcp-config` (no MCP server but the ones
 * `--mcp-config` names: the allowed ones, at the Allowed list level).
 */
function strictMcp(i: ArgvInput, level: ExtensionLevel): string[] {
  const a = STRICT_MCP_READONLY ? ['--strict-mcp-config'] : []
  if (level === 'allowed' && i.mcpConfigPath !== undefined) a.push('--mcp-config', i.mcpConfigPath)
  return a
}

const catalogHosts = (webDomains: readonly string[] | undefined): string[] =>
  (webDomains ?? []).filter((h) => WEB_DOMAIN_PATTERN.test(h))

/** The catalog refresh's `--allowedTools`: web search, then one exact-host WebFetch rule per valid host. */
export function catalogAllowedTools(webDomains: readonly string[] | undefined): string[] {
  return [WEB_SEARCH_TOOL, ...catalogHosts(webDomains).map(webFetchRule)]
}

/**
 * The catalog refresh's `--tools`: web search, and WebFetch only when there is a host to fetch from. The
 * pass has no other built-in tool (no Read, Glob, Grep, agents, workflows, schedules, messages or worktrees).
 */
export function catalogTools(webDomains: readonly string[] | undefined): string[] {
  return CATALOG_TOOLS.filter((t) => t !== 'WebFetch' || catalogHosts(webDomains).length > 0)
}

/** Research's `--tools`: the repository's read tools, plus web search and page fetches when it may use the web. */
export function researchTools(webOpen: boolean | undefined): string[] {
  return [...RESEARCH_READ_TOOLS, ...(webOpen === true ? WEB_TOOLS.slice().reverse() : [])]
}

/** Research's `--allowedTools`: web search and page fetches on any host, or nothing without the web. */
export function researchAllowedTools(webOpen: boolean | undefined): string[] {
  return webOpen === true ? [WEB_SEARCH_TOOL, 'WebFetch'] : []
}

/**
 * The probe's initialize-only handshake (C16 flags): the stream and host flags every pass relies on, so a renamed
 * flag fails here too, plus the user's extraArgs and flagMap; hermetic (no MCP, hooks or transcript).
 */
export function probeArgv(
  o: {
    extraArgs?: readonly string[] | undefined
    flagMap?: Readonly<Record<string, string>> | undefined
    /**
     * The claude.ai connector listing (C22a): strict MCP off, so the CLI fetches the account's connectors. Only where
     * that session starts no other MCP server (extensions/claude-connectors.ts connectorListingBlocked).
     */
    connectors?: boolean | undefined
  } = {},
): string[] {
  const a = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'default',
    '--permission-prompt-tool',
    'stdio',
  ]
  if (STRICT_MCP_READONLY && o.connectors !== true) a.push('--strict-mcp-config')
  a.push('--no-session-persistence', '--settings', READONLY_SETTINGS, ...(o.extraArgs ?? []))
  return applyFlagMap(a, o.flagMap)
}

/**
 * A read-only or plan route's session flags: thrown away when the pass ends (`--no-session-persistence`), or, for a Plan
 * that keeps its session for Implement (continuity), kept under its pre-assigned `--session-id`.
 */
function keptSession(i: ArgvInput): string[] {
  if (i.keepSession === true && i.step === 'plan')
    return i.sessionId !== undefined ? [`--session-id=${i.sessionId}`] : []
  return ['--no-session-persistence']
}

/** List flags take one comma-joined argument; a rule that itself contains a comma cannot be passed. */
const joinList = (items: readonly string[]): string => [...new Set(items)].join(',')

export function buildArgv(i: ArgvInput): string[] {
  const a = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    permissionModeFor(i.route, i.mode),
  ]
  if (i.model !== undefined && i.model !== null && i.model !== '') a.push('--model', i.model)
  if (isEffortLevel(i.effort)) a.push('--effort', i.effort)
  const level = i.extensions ?? routeExtensions(i.route)
  switch (i.route) {
    case 'plan':
      if (level !== 'passthrough') a.push(...strictMcp(i, level))
      a.push(
        '--permission-prompt-tool',
        'stdio',
        '--settings',
        // Below Pass through Claude's own plan mode runs without the user's hooks, as the read-only route does.
        level === 'passthrough' ? PLAN_SETTINGS : PLAN_ALLOWED_SETTINGS,
        ...keptSession(i),
        '--disallowedTools',
        joinList([
          'AskUserQuestion',
          ...(i.disallowShell === true || PLAN_DISALLOWS_SHELL ? SHELL_TOOLS : []),
          ...agentCut(i, level),
        ]),
      )
      {
        const mcpRules = mcpAllowRules(i, level)
        if (mcpRules.length > 0) a.push('--allowedTools', joinList(mcpRules))
      }
      break
    case 'readonly': {
      const heal = i.step === 'heal'
      const catalog = i.step === 'catalog'
      const research = i.step === 'research'
      const disallowed =
        catalog || research
          ? CATALOG_DISALLOWED
          : [
              ...READONLY_DISALLOWED,
              ...(i.disallowShell === true || heal ? SHELL_TOOLS : []),
              ...(heal ? WEB_TOOLS : []),
              ...agentCut(i, level),
            ]
      // Pass through: the user's MCP servers and hooks load, as for an edit pass (the read-only tool cut stays).
      if (level !== 'passthrough') a.push(...strictMcp(i, level))
      a.push('--permission-prompts', 'none', ...keptSession(i))
      if (level !== 'passthrough') a.push('--settings', READONLY_SETTINGS)
      a.push('--disallowedTools', joinList(disallowed))
      // Allowed list: the servers the user lets run without asking (never on the catalog refresh or Research, which
      // run at None and name their own allow list below).
      const mcpRules = catalog || research ? [] : mcpAllowRules(i, level)
      if (mcpRules.length > 0) a.push('--allowedTools', joinList(mcpRules))
      // Catalog refresh: web search, and page fetches on the official hosts only. Under dontAsk any other
      // fetch is denied, not prompted (claudeEnv's `confined` keeps settings rules and preapproved hosts out).
      // `--tools` makes those two the pass's only built-in tools.
      if (catalog) {
        a.push(
          '--tools',
          joinList(catalogTools(i.webDomains)),
          '--allowedTools',
          joinList(catalogAllowedTools(i.webDomains)),
        )
      }
      // Research: the catalog's confinement with the repository's read tools, and the web on any host when allowed.
      if (research) {
        a.push('--tools', joinList(researchTools(i.webOpen)))
        const allowed = researchAllowedTools(i.webOpen)
        if (allowed.length > 0) a.push('--allowedTools', joinList(allowed))
      }
      break
    }
    case 'edit': {
      a.push('--permission-prompt-tool', 'stdio', '--disallowedTools', 'AskUserQuestion')
      // Below Pass through an edit pass loads no MCP server but the allowed ones, and no hooks.
      if (level !== 'passthrough') a.push(...strictMcp(i, level), '--settings', READONLY_SETTINGS)
      const rules = [
        ...(i.nativeRules ?? []).filter((r) => r !== '' && !r.includes(',') && !/[\r\n\0]/.test(r)),
        ...mcpAllowRules(i, level),
      ]
      if (rules.length > 0) a.push('--allowedTools', joinList(rules))
      if (i.resumeId !== undefined) a.push(`--resume=${i.resumeId}`)
      else if (i.sessionId !== undefined) a.push(`--session-id=${i.sessionId}`)
      if (i.ephemeral === true) a.push('--no-session-persistence')
      break
    }
  }
  // None: no skill of the user's, a plugin's or the account's (built-in tools only), on every route. The catalog
  // refresh and Research name their tools (`--tools`, no Skill tool among them), so no skill can run there already.
  const toolsListed = i.route === 'readonly' && (i.step === 'catalog' || i.step === 'research')
  if (level === 'none' && !toolsListed) a.push(DISABLE_SKILLS_FLAG)
  a.push(...(i.extraArgs ?? []))
  return applyFlagMap(a, i.flagMap)
}

const flagName = (arg: string): string =>
  arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg

const isManaged = (arg: string): boolean => (MANAGED_FLAGS as readonly string[]).includes(flagName(arg))

/** Spelling-insensitive identity of a flag: `--allowedTools` ≡ `--allowed-tools` ≡ `--ALLOWED_TOOLS`. */
const flagKey = (arg: string): string => flagName(arg).replace(/^-+/, '').toLowerCase().replace(/[-_]/g, '')

const MANAGED_KEYS = new Set(MANAGED_FLAGS.map(flagKey))
const ESCALATION_KEYS = new Set(ESCALATION_FLAGS.map(flagKey))
const CLI_FLAG_KEYS = new Set(CLI_FLAGS.map(flagKey))

const isFlag = (arg: string): boolean => arg.startsWith('-') && arg.length > 1
const managedLoose = (arg: string): boolean => isFlag(arg) && MANAGED_KEYS.has(flagKey(arg))
const escalates = (arg: string): boolean =>
  isFlag(arg) && (ESCALATION_KEYS.has(flagKey(arg)) || /^(allow)?dangerously/.test(flagKey(arg)))

/**
 * The single-letter flags of a combined short-flag argument (`-pc` → `-p -c`, `-r<id>` → `-r …`, `-p=x` → `-p -= -x`),
 * or null for anything else. The CLI's parser (commander) reads such an argument letter by letter, so `-pc` is
 * `--print --continue`; extraArgs checks look at every letter.
 */
export function shortFlagCluster(arg: string): string[] | null {
  if (!/^-[^-]/.test(arg) || arg.length <= 2) return null
  return [...arg.slice(1)].map((ch) => `-${ch}`)
}

/** extraArgs may not repeat a managed flag nor widen permissions; returns the problem. */
export function extraArgsProblem(extraArgs: readonly string[] | undefined): string | undefined {
  for (const a of extraArgs ?? []) {
    if (/[\r\n\0]/.test(a)) return `extraArgs entry ${JSON.stringify(a.slice(0, 40))} contains a newline`
    if (managedLoose(a)) return `extraArgs may not set ${flagName(a)}; Dim Factory manages it`
    if (escalates(a)) return `extraArgs may not set ${flagName(a)}; it widens what a pass may do`
    const letters = shortFlagCluster(a)
    const hit = letters?.find((l) => (MANAGED_FLAGS as readonly string[]).includes(l) || escalates(l))
    if (hit !== undefined) {
      return `extraArgs may not combine ${hit} with other short flags (${JSON.stringify(a.slice(0, 40))}); Dim Factory manages ${hit}`
    }
  }
  return undefined
}

const LONG_FLAG = /^--[A-Za-z][\w-]*$/

/**
 * flagMap ("flag renamed in a new CLI release") may only rename a managed flag to a long flag name the CLI does not
 * already define: never to another managed flag (`--disallowedTools` → `--allowedTools` would turn the read-only cut into
 * an allow list), nor to an escalation flag, nor to any other flag of the CLI (`--disallowedTools` →
 * `--fallback-model` would make the read-only cut a harmless option value), and never two flags to one name.
 */
export function flagMapProblem(flagMap: Readonly<Record<string, string>> | undefined): string | undefined {
  const targets = new Set<string>()
  for (const [from, to] of Object.entries(flagMap ?? {})) {
    if (!isManaged(from)) return `flagMap key ${from} is not a flag Dim Factory manages`
    if (!LONG_FLAG.test(to)) return `flagMap value ${JSON.stringify(to)} is not a long flag name (--name)`
    const key = flagKey(to)
    if (escalates(to)) return `flagMap may not rename ${from} to ${to}; that flag widens what a pass may do`
    if (key !== flagKey(from) && MANAGED_KEYS.has(key))
      return `flagMap may not rename ${from} to ${to}; Dim Factory manages ${to} itself`
    if (key !== flagKey(from) && CLI_FLAG_KEYS.has(key))
      return `flagMap may not rename ${from} to ${to}; Claude Code already uses ${to} for something else`
    if (targets.has(key)) return `flagMap renames two flags to ${to}`
    targets.add(key)
  }
  return undefined
}

/** Renames managed flags (`--x` and `--x=value` forms) per the user's flagMap (the "flag renamed" fix). */
export function applyFlagMap(
  argv: readonly string[],
  flagMap: Readonly<Record<string, string>> | undefined,
): string[] {
  if (flagMap === undefined || Object.keys(flagMap).length === 0) return [...argv]
  return argv.map((arg) => {
    const name = flagName(arg)
    const to = flagMap[name]
    if (to === undefined || !isManaged(name)) return arg
    return name === arg ? to : `${to}${arg.slice(name.length)}`
  })
}

/**
 * Live balanced run: whether a launched pass ran without Bash and PowerShell, read from the argv it was spawned
 * with (a run's StepState.argv): SHELL_TOOLS in its `--disallowedTools`, in any spelling of the flag or as `flagMap`
 * renamed it. What the pass ran with, whatever the folder's settings say now.
 */
export function argvDisallowsShell(
  argv: readonly string[],
  flagMap?: Readonly<Record<string, string>>,
): boolean {
  const renamed = flagMap?.['--disallowedTools']
  const keys = new Set([flagKey('--disallowedTools'), ...(renamed !== undefined ? [flagKey(renamed)] : [])])
  return argv.some((arg, i) => {
    if (!arg.startsWith('--') || !keys.has(flagKey(arg))) return false
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[i + 1]
    const tools = (value ?? '').split(',').map((t) => t.trim())
    return SHELL_TOOLS.every((t) => tools.includes(t))
  })
}

// ---- env --------------------------------------------------------------------------------------------------

const DEFAULT_API_URL = /^https:\/\/api\.anthropic\.com\/?$/i

/**
 * Variables a Claude Code host session leaves behind that sanitizeEnv's list does not cover (observed on the
 * dev machine: CLAUDE_EFFORT, the desktop app's ANTHROPIC_BASE_URL pointing at the default endpoint).
 * `CLAUDE_CONFIG_DIR` is the user's own relocation and stays.
 */
export function isHostSessionLeftover(key: string, value: string): boolean {
  const k = key.toUpperCase()
  if (k.startsWith('CLAUDE_') && k !== 'CLAUDE_CONFIG_DIR') return true
  return k === 'ANTHROPIC_BASE_URL' && DEFAULT_API_URL.test(value.trim())
}

export interface ClaudeEnvOptions {
  route: ClaudeRoute
  path?: string | undefined
  pathPrepend?: readonly string[] | undefined
  /** `vendors.claude.env` plus StartOptions.env, applied after everything Dim Factory sets. */
  vendorEnv?: EnvInput | undefined
  launchedFromClaude?: boolean
  platform?: NodeJS.Platform
  /**
   * The catalog refresh: {@link CATALOG_CONFINED_ENV}, set after vendorEnv so no setting of the user's
   * can unset it (the CLI's allow list is then exactly the argv's `--allowedTools`).
   */
  confined?: boolean | undefined
  /**
   * The pass's Extensions level. At Pass through the claude.ai connectors are switched off as on an edit pass (the
   * user's own MCP servers load, the connectors never do). Absent: the route decides, as before.
   */
  extensions?: ExtensionLevel | undefined
}

export function claudeEnv(base: EnvInput, o: ClaudeEnvOptions): Record<string, string> {
  const platform = o.platform ?? process.platform
  const launched = o.launchedFromClaude ?? getEnv(base, 'CLAUDECODE', platform) === '1'
  const scrubbed: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (launched && isHostSessionLeftover(k, v)) continue
    scrubbed[k] = v
  }
  if (o.route === 'edit' || o.extensions === 'passthrough') Object.assign(scrubbed, CLAUDEAI_MCP_ENV)
  return sanitizeEnv(scrubbed, {
    purpose: 'vendor',
    vendor: 'claude',
    ...(o.path !== undefined ? { path: o.path } : {}),
    ...(o.pathPrepend !== undefined ? { pathPrepend: o.pathPrepend } : {}),
    ...(o.vendorEnv !== undefined ? { vendorEnv: o.vendorEnv } : {}),
    extra: { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1', ...(o.confined === true ? CATALOG_CONFINED_ENV : {}) },
    launchedFromClaude: launched,
    platform,
  })
}

/** `${CLAUDE_CONFIG_DIR ?? ~/.claude}` as the child will see it. */
export function claudeConfigDir(env: EnvInput, home: string = homedir()): string {
  const dir = getEnv(env, 'CLAUDE_CONFIG_DIR')
  return dir !== undefined && dir.trim() !== '' ? dir : join(home, '.claude')
}
