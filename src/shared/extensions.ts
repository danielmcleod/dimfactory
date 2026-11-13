// Per-pass Extensions: which of the user's own vendor extensions (MCP servers, skills, plugins, hooks) a pass may use.
// Three levels, shown on each pass row and in Settings > Extensions:
//   - none: built-in tools only (Plan, Review, Critic, Security, heal and the price refresh by default);
//   - allowed: only the MCP servers (and, where the vendor can limit them, the skills) the user ticked;
//   - passthrough: everything in the user's CLI config, as if they ran the CLI themselves (Implement and Fix by default).
// What each vendor can really do at each level is said here once (the ONLY source of this copy), with no em dashes.
// Names of servers, skills and subagents are the user's data: they travel to the renderer to be shown and ticked, and to
// the vendor process for its launch, never into Dim Factory's own logs, diagnostics or the self-heal input.
// At every level, Pass through included, a pass's raw log (the vendor's own frames) has the names the user's settings
// define replaced by [REDACTED]; the run view's tool rows (and the run's event history behind them) keep the tool's
// name, such as `mcp:<server>/<tool>`, because the user needs to see what a pass used.
import type { PassName } from './run.ts'
import type { VendorId } from './vendors.ts'
import { LOCAL_VENDOR_PREFIX } from './vendors.ts'

export const EXTENSION_LEVELS = ['none', 'allowed', 'passthrough'] as const
export type ExtensionLevel = (typeof EXTENSION_LEVELS)[number]

export function isExtensionLevel(v: unknown): v is ExtensionLevel {
  return typeof v === 'string' && (EXTENSION_LEVELS as readonly string[]).includes(v)
}

/** The level names as the pass rows and Settings show them. */
export const EXTENSION_LEVEL_LABEL: Readonly<Record<ExtensionLevel, string>> = {
  none: 'None',
  allowed: 'Allowed list',
  passthrough: 'Pass through',
}

/** Passes that may never change files. Pass through on one of them needs the user's explicit choice and a warning. */
const READ_ONLY: ReadonlySet<string> = new Set(['plan', 'review', 'critic', 'security', 'heal', 'catalog'])

export const isReadOnlyExtensionsPass = (pass: PassName | 'heal' | 'catalog'): boolean => READ_ONLY.has(pass)

/** The level a pass runs at when no layer sets one: today's behaviour, made explicit. */
export function defaultExtensionLevel(pass: PassName | 'heal' | 'catalog'): ExtensionLevel {
  return READ_ONLY.has(pass) ? 'none' : 'passthrough'
}

/**
 * An MCP server name Dim Factory can allow: letters, digits, `-` and `_`, not starting with `-` (a name that is one
 * safe bare key for Codex's `mcp_servers.<name>` and one item of Gemini's comma-separated list, never read as a flag).
 * Other names are listed but cannot be ticked.
 */
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/
/** A skill name, or `plugin:skill` for a skill a Claude plugin brings. */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}(?::[A-Za-z0-9_.-]{1,128})?$/

export const isAllowableMcpName = (name: string): boolean => MCP_NAME_PATTERN.test(name)
export const isAllowableSkillName = (name: string): boolean => SKILL_NAME_PATTERN.test(name)

/** The vendor whose extensions a pass's vendor id uses (a `local-<preset>` runs on Codex). */
export function extensionsVendor(vendor: VendorId): string {
  return vendor.startsWith(LOCAL_VENDOR_PREFIX) ? 'codex' : vendor
}

/** What a vendor lets Dim Factory limit for one pass. */
export interface ExtensionsSupport {
  /** The MCP servers a pass loads can be chosen (None and Allowed list mean something). */
  mcp: boolean
  /** The skills a pass sees can be limited to a list (Claude's session skill allowlist). */
  skills: boolean
}

export const EXTENSIONS_SUPPORT: Readonly<Record<string, ExtensionsSupport>> = {
  claude: { mcp: true, skills: true },
  codex: { mcp: true, skills: false },
  gemini: { mcp: true, skills: false },
  grok: { mcp: false, skills: false },
  muse: { mcp: false, skills: false },
}

export function extensionsSupport(vendor: VendorId): ExtensionsSupport {
  return EXTENSIONS_SUPPORT[extensionsVendor(vendor)] ?? { mcp: false, skills: false }
}

/** Vendors whose extensions Settings > Extensions lists (the ones Dim Factory can read and limit). */
export const EXTENSION_VENDORS = ['claude', 'codex', 'gemini'] as const

const COPY: Readonly<Record<string, Readonly<Record<ExtensionLevel, string>>>> = {
  claude: {
    none: 'Built-in tools only: no MCP servers, skills or hooks, and read-only passes run without your custom subagents.',
    allowed:
      'Only the MCP servers and skills you allowed for Claude, and no hooks. The skills limit covers the pass itself; a subagent it starts may still see your other skills. Read-only passes run without your custom subagents, and use an allowed server only if you let it run without asking.',
    passthrough:
      'Everything in your Claude settings: MCP servers, skills, plugins and hooks, as if you ran Claude yourself. Its claude.ai connectors stay off.',
  },
  codex: {
    none: 'No MCP servers from your Codex config.toml, and no apps, plugins or hooks. Codex cannot limit skills for one pass, so your skills may still load.',
    allowed:
      'Only the MCP servers you allowed from your Codex config.toml (codex_apps: the apps linked to your account), and no plugins or hooks. Codex cannot limit skills for one pass, so they load as usual.',
    passthrough: 'Everything in your Codex settings, as if you ran Codex yourself.',
  },
  gemini: {
    none: "No MCP servers, from your Gemini settings or its extensions. Your extensions' context and commands still load.",
    allowed:
      'Only the MCP servers you allowed for Gemini. Gemini cannot limit skills or extensions for one pass, so they load as usual.',
    passthrough: 'Everything in your Gemini settings and extensions, as if you ran Gemini yourself.',
  },
}

const NO_LIMIT_COPY: Readonly<Record<string, string>> = {
  grok: 'Grok runs with the MCP servers and tools in its own settings at every level: Dim Factory cannot limit them for one pass.',
  muse: 'Muse runs with its own settings at every level: Dim Factory cannot limit its tools or MCP servers for one pass.',
}

/** What a pass on `vendor` gets at `level`, in plain words. */
export function extensionsCopy(vendor: VendorId, level: ExtensionLevel): string {
  const v = extensionsVendor(vendor)
  const own = COPY[v]
  if (own !== undefined) return own[level]
  return (
    NO_LIMIT_COPY[v] ??
    'This vendor runs with its own settings at every level: Dim Factory cannot limit its extensions for one pass.'
  )
}

/** The warning a read-only pass shows before (and while) it runs at Pass through. */
export const PASSTHROUGH_READONLY_WARNING =
  'Pass through lets MCP tools and hooks act outside the sandbox. They may not respect read-only, so this pass could change files or reach other services.'

/** The sentence Settings > Extensions shows about skills. */
export const SKILLS_LIMIT_NOTE =
  'Only Claude can limit skills for one pass. For Codex and Gemini, Allowed list covers MCP servers only.'

// ---- configuration ----------------------------------------------------------------------------------------------

/** One vendor's allow list (config `extensions.allowed.<vendor>`). */
export interface AllowedExtensions {
  mcp: string[]
  skills: string[]
  /**
   * Claude only: allowed MCP servers whose tools run without asking (off by default). Without it a read-only Claude
   * pass denies every MCP tool (its `dontAsk` mode); with it the pass calls that server's tools freely, side effects
   * included. Only names that are also on `mcp` count.
   */
  mcpWithoutAsking: string[]
}

/** The vendors whose passes can let an allowed MCP server run without asking. */
export const MCP_WITHOUT_ASKING_VENDORS: readonly string[] = ['claude']

/** The opt-in's label beside an allowed Claude MCP server, and what it means. */
export const MCP_WITHOUT_ASKING_LABEL = 'Run without asking'
export const MCP_WITHOUT_ASKING_NOTE =
  'Claude asks before every MCP tool, and read-only passes cannot ask, so they never use one. Run without asking lets every pass at Allowed list call this server’s tools freely. Its tools may have side effects, such as changing files or sending messages, even on a read-only pass.'

/** The allow list of `vendor` in a resolved config's `extensions` section (empty when it names none). */
export function allowedFor(
  extensions: { allowed: Readonly<Record<string, Partial<AllowedExtensions>>> } | undefined,
  vendor: VendorId,
): AllowedExtensions {
  const a = extensions?.allowed[extensionsVendor(vendor)]
  return {
    mcp: [...(a?.mcp ?? [])],
    skills: [...(a?.skills ?? [])],
    mcpWithoutAsking: [...(a?.mcpWithoutAsking ?? [])],
  }
}

// ---- discovery (Settings > Extensions; names only) -----------------------------------------------------------------

/** Where a discovered item is defined. */
export const EXTENSION_SCOPES = ['user', 'project', 'local', 'plugin', 'extension', 'account'] as const
export type ExtensionScope = (typeof EXTENSION_SCOPES)[number]

export interface DiscoveredItem {
  name: string
  scope: ExtensionScope
  /** Its name can go on an allow list (MCP_NAME_PATTERN / SKILL_NAME_PATTERN). */
  allowable: boolean
  /** A claude.ai connector: its name on claude.ai (`name` is the one it is allowed under). */
  label?: string
  /** A claude.ai connector: how it stood when listed (connected, needs-auth, failed, pending, disabled). */
  status?: string
}

/** What listing Claude's claude.ai connectors gave (Settings > Extensions, `extensions.claudeConnectors`). */
export interface ConnectorsListResult {
  ok: boolean
  /** How many connectors the account has (0 when not listed). */
  count: number
  /** Why they were not listed: another MCP server would have started too. */
  blocked?: string
  error?: string
}

/** Settings > Extensions, under Claude's MCP servers. */
export const CLAUDE_CONNECTORS_NOTE =
  'claude.ai connectors: Dim Factory can list them without tokens when that starts no other MCP server. Once listed, tick one to allow it on passes at Allowed list; Pass through keeps them off.'
export const CLAUDE_CONNECTORS_BUTTON = 'List connectors'

/** A connector's status when it is not connected, in plain words. */
export function connectorStatusText(status: string | undefined): string | undefined {
  switch (status) {
    case undefined:
    case 'connected':
      return undefined
    case 'needs-auth':
      return 'Needs sign-in on claude.ai'
    case 'failed':
      return 'Did not connect'
    case 'disabled':
      return 'Turned off'
    default:
      return 'Not connected yet'
  }
}

export interface DiscoveredVendor {
  vendor: string
  mcp: DiscoveredItem[]
  skills: DiscoveredItem[]
  /** Plugin (Claude, Codex) names, informational: they load at Pass through. */
  plugins: string[]
  /** Claude's custom subagents, informational: read-only passes below Pass through run without them. */
  agents?: string[]
  /** Every file Dim Factory looked in was read and understood (false: the lists may miss something). */
  complete: boolean
  support: ExtensionsSupport
}

export interface DiscoveredExtensions {
  vendors: DiscoveredVendor[]
}

// ---- a run's own Tools (the composer's Tools picker and Use skill; run overrides `tools`) -------------------------

/** One vendor's tools, as a run's picker names them. */
export interface ToolNames {
  mcp: string[]
  skills: string[]
}

/**
 * The run layer's Tools, resolved: per vendor (its extensions vendor: a `local-<preset>` is Codex), the MCP servers and
 * skills put on or taken off the Allowed list for this run, and the one skill the run is asked to use.
 */
export interface RunTools {
  on: Record<string, ToolNames>
  off: Record<string, ToolNames>
  skill: { vendor: string; name: string } | null
}

export const NO_RUN_TOOLS: RunTools = { on: {}, off: {}, skill: null }

type PartialNames = { mcp?: readonly string[] | undefined; skills?: readonly string[] | undefined }
/** What a run layer may hold (every part optional). */
export interface RunToolsLike {
  on?: Readonly<Record<string, PartialNames>> | undefined
  off?: Readonly<Record<string, PartialNames>> | undefined
  skill?: { vendor: string; name: string } | null | undefined
}

const uniq = (xs: readonly string[] | undefined): string[] => [...new Set(xs ?? [])]

function namesByVendor(r: Readonly<Record<string, PartialNames>> | undefined): Record<string, ToolNames> {
  const out: Record<string, ToolNames> = {}
  for (const [vendor, n] of Object.entries(r ?? {})) {
    const v = extensionsVendor(vendor)
    const prev = out[v] ?? { mcp: [], skills: [] }
    out[v] = {
      mcp: uniq([...prev.mcp, ...(n.mcp ?? [])]),
      skills: uniq([...prev.skills, ...(n.skills ?? [])]),
    }
  }
  return out
}

/** A run layer's Tools with every vendor entry complete (resolve's `tools`; none: NO_RUN_TOOLS). */
export function resolvedRunTools(t: RunToolsLike | undefined): RunTools {
  if (t === undefined) return { on: {}, off: {}, skill: null }
  const skill = t.skill ?? null
  return {
    on: namesByVendor(t.on),
    off: namesByVendor(t.off),
    skill: skill === null ? null : { vendor: extensionsVendor(skill.vendor), name: skill.name },
  }
}

/** Whether a run's Tools pick anything (on, off or a skill). */
export function hasRunTools(t: RunToolsLike | undefined): boolean {
  const r = resolvedRunTools(t)
  const any = (m: Record<string, ToolNames>): boolean =>
    Object.values(m).some((n) => n.mcp.length > 0 || n.skills.length > 0)
  return any(r.on) || any(r.off) || r.skill !== null
}

/** What one pass of a run gets: its level, its effective lists, and the run's own picks it really has. */
export interface PassExtensionsPlan {
  level: ExtensionLevel
  /** The MCP servers and skills of the Allowed list (empty below it and at Pass through, where none is listed). */
  mcp: string[]
  skills: string[]
  /** Claude: allowed servers that run without asking (settings only; a run never adds one). */
  mcpWithoutAsking: string[]
  /** The run's picks (Tools and Use skill) this pass has, for its prompt note; empty on a read-only pass. */
  picked: ToolNames
  /** The Use skill, when this pass has it. */
  skill?: string
}

/**
 * One pass's extensions with a run's Tools on top of the settings' Allowed list. The rules:
 *   - the pass's level never changes (None stays None, Pass through stays Pass through);
 *   - at Allowed list, a pass that changes files (Implement, Fix) gets the run's picks added and the run's removals
 *     taken off; a read-only pass gets only the removals, never an addition (read-only passes stay read-only);
 *   - Use skill counts as a picked skill of its vendor;
 *   - Run without asking stays a settings opt-in: a run never adds one, and drops the ones it took off;
 *   - `picked` (the prompt note's list) is what the run picked and the pass really has: on a pass that changes files,
 *     the picks on its list (Allowed list) or all of them (Pass through, where the user's tools load anyway).
 */
export function passExtensionsPlan(o: {
  pass: PassName | 'heal' | 'catalog'
  vendor: VendorId
  level: ExtensionLevel
  allowed: AllowedExtensions
  tools?: RunToolsLike | undefined
}): PassExtensionsPlan {
  const t = resolvedRunTools(o.tools)
  const v = extensionsVendor(o.vendor)
  const writes = !isReadOnlyExtensionsPass(o.pass)
  const skillPick = t.skill !== null && t.skill.vendor === v ? t.skill.name : undefined
  const on: ToolNames = {
    mcp: writes ? uniq(t.on[v]?.mcp) : [],
    skills: writes ? uniq([...(t.on[v]?.skills ?? []), ...(skillPick !== undefined ? [skillPick] : [])]) : [],
  }
  const off = t.off[v] ?? { mcp: [], skills: [] }
  // A removal wins over a pick of the same name.
  on.mcp = on.mcp.filter((n) => !off.mcp.includes(n))
  on.skills = on.skills.filter((n) => !off.skills.includes(n))
  if (o.level === 'allowed') {
    const mcp = uniq([...o.allowed.mcp, ...on.mcp]).filter((n) => !off.mcp.includes(n))
    const skills = uniq([...o.allowed.skills, ...on.skills]).filter((n) => !off.skills.includes(n))
    const plan: PassExtensionsPlan = {
      level: 'allowed',
      mcp,
      skills,
      mcpWithoutAsking: o.allowed.mcpWithoutAsking.filter(
        (n) => o.allowed.mcp.includes(n) && mcp.includes(n),
      ),
      picked: { mcp: on.mcp, skills: on.skills },
    }
    if (skillPick !== undefined && on.skills.includes(skillPick)) plan.skill = skillPick
    return plan
  }
  const plan: PassExtensionsPlan = {
    level: o.level,
    mcp: [],
    skills: [],
    mcpWithoutAsking: [],
    picked: o.level === 'passthrough' ? on : { mcp: [], skills: [] },
  }
  if (o.level === 'passthrough' && skillPick !== undefined && on.skills.includes(skillPick))
    plan.skill = skillPick
  return plan
}

/**
 * The prompt note for a pass's run picks: the user's own tools this run turned on, with the rule that they are used only
 * for what the task asks and never carry secrets; and the skill the run asks for. Empty when the pass has none.
 */
export function runToolsNote(plan: Pick<PassExtensionsPlan, 'picked' | 'skill'>): string {
  const names = [
    ...plan.picked.mcp.map((n) => `${n} (MCP server)`),
    ...plan.picked.skills.filter((n) => n !== plan.skill).map((n) => `${n} (skill)`),
  ]
  const parts: string[] = []
  if (names.length > 0) {
    parts.push(
      `For this run the user also turned on these of their own tools: ${names.join(', ')}. Use them when the task ` +
        'calls for it, acting under the user’s account. Do not use them for anything the task does not ask for, and ' +
        'never send secrets or credentials through them.',
    )
  }
  if (plan.skill !== undefined) {
    parts.push(
      `The user asked you to use the ${plan.skill} skill for this task.` +
        (names.length === 0 ? ' Never send secrets or credentials through it or any other tool.' : ''),
    )
  }
  return parts.join('\n\n')
}
