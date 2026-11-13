// The composer's Tools for one run (run overrides `tools`): the Tools picker's ticks, Use skill, and the keyword
// suggestions under the task ("…in Linear" with a Linear server set up suggests it; nothing is turned on until the
// user clicks). Pure functions over the pending overrides; what each pass then gets is core's (shared
// passExtensionsPlan): picks add only to passes that change files at Allowed list, read-only passes never get one, and
// a pass's level never changes. Tools are for this run only: Save all overrides never writes them.
import type { ResolvedConfig, RunOverrides } from '@shared/config-schema.ts'
import type { DiscoveredExtensions, DiscoveredItem, ExtensionLevel } from '@shared/extensions.ts'
import {
  allowedFor,
  defaultExtensionLevel,
  extensionsSupport,
  extensionsVendor,
  isReadOnlyExtensionsPass,
  resolvedRunTools,
} from '@shared/extensions.ts'
import type { PassName } from '@shared/run.ts'
import { PASS_NAMES } from '@shared/run.ts'
import { pruneEmpty, settle } from './overrides.ts'

export type ToolKind = 'mcp' | 'skills'

/** One tool the picker lists: a discovered MCP server or skill of a vendor this run uses. */
export interface ToolItem {
  vendor: string
  kind: ToolKind
  name: string
  /** What to show (a claude.ai connector's own name). */
  label: string
  /** On the settings' Allowed list. */
  inSettings: boolean
}

type ConfigSlice = Pick<ResolvedConfig, 'passes' | 'extensions'>

/** The passes that change files: the only ones a pick reaches. */
const WRITE_PASSES: readonly PassName[] = PASS_NAMES.filter((p) => !isReadOnlyExtensionsPass(p))

/** The enabled passes with their extensions vendor and level. */
function passesOf(config: ConfigSlice): { pass: PassName; vendor: string; level: ExtensionLevel }[] {
  return PASS_NAMES.flatMap((pass) => {
    // Read defensively: a partial config (a pass left out) lists nothing for it.
    const p = (config.passes as Partial<ConfigSlice['passes']> | undefined)?.[pass]
    if (p === undefined || !p.enabled) return []
    return [{ pass, vendor: extensionsVendor(p.vendor), level: p.extensions ?? defaultExtensionLevel(pass) }]
  })
}

/** Vendors whose MCP servers a pass of this run can be limited to (claude, codex, gemini), in pass order. */
export function toolVendors(config: ConfigSlice): string[] {
  return [...new Set(passesOf(config).map((p) => p.vendor))].filter((v) => extensionsSupport(v).mcp)
}

/** The tools of `found` the run may pick: allowable MCP servers of its vendors, and (Claude) allowable skills. */
export function toolItems(config: ConfigSlice, found: DiscoveredExtensions | null): ToolItem[] {
  if (found === null) return []
  const vendors = toolVendors(config)
  const out: ToolItem[] = []
  for (const v of found.vendors) {
    if (!vendors.includes(v.vendor)) continue
    const a = allowedFor((config as Partial<ConfigSlice>).extensions, v.vendor)
    const add = (kind: ToolKind, items: readonly DiscoveredItem[], settings: readonly string[]): void => {
      for (const i of items) {
        if (!i.allowable || out.some((o) => o.vendor === v.vendor && o.kind === kind && o.name === i.name))
          continue
        out.push({
          vendor: v.vendor,
          kind,
          name: i.name,
          label: i.label ?? i.name,
          inSettings: settings.includes(i.name),
        })
      }
    }
    add('mcp', v.mcp, a.mcp)
    if (v.support.skills) add('skills', v.skills, a.skills)
  }
  return out
}

/** The skills Use skill offers: every allowable skill of a vendor that runs a pass that changes files. */
export function skillChoices(config: ConfigSlice, found: DiscoveredExtensions | null): ToolItem[] {
  if (found === null) return []
  const writers = new Set(
    passesOf(config)
      .filter((p) => WRITE_PASSES.includes(p.pass))
      .map((p) => p.vendor),
  )
  const out: ToolItem[] = []
  for (const v of found.vendors) {
    if (!writers.has(v.vendor)) continue
    const a = allowedFor((config as Partial<ConfigSlice>).extensions, v.vendor)
    for (const i of v.skills) {
      if (!i.allowable || out.some((o) => o.vendor === v.vendor && o.name === i.name)) continue
      out.push({
        vendor: v.vendor,
        kind: 'skills',
        name: i.name,
        label: i.label ?? i.name,
        inSettings: a.skills.includes(i.name),
      })
    }
  }
  return out
}

/** Whether `item` is on for this run: on the settings' list and not taken off, or picked. */
export function isToolOn(
  o: RunOverrides,
  item: Pick<ToolItem, 'vendor' | 'kind' | 'name' | 'inSettings'>,
): boolean {
  const t = resolvedRunTools(o.tools)
  const off = t.off[item.vendor]?.[item.kind] ?? []
  const on = t.on[item.vendor]?.[item.kind] ?? []
  return item.inSettings ? !off.includes(item.name) : on.includes(item.name)
}

const without = (xs: readonly string[] | undefined, name: string): string[] =>
  (xs ?? []).filter((x) => x !== name)
const withName = (xs: readonly string[] | undefined, name: string): string[] => [...without(xs, name), name]

/**
 * Tick or untick a tool for this run. A tool on the settings' list is taken off (or put back); any other is picked (or
 * dropped). Only the run layer changes.
 */
export function setTool(
  o: RunOverrides,
  item: Pick<ToolItem, 'vendor' | 'kind' | 'name' | 'inSettings'>,
  on: boolean,
): RunOverrides {
  const tools = structuredClone(o.tools ?? {})
  const side = item.inSettings ? 'off' : 'on'
  const lists = { ...(tools[side] ?? {}) }
  const entry = { ...(lists[item.vendor] ?? {}) }
  const add = item.inSettings ? !on : on
  entry[item.kind] = add ? withName(entry[item.kind], item.name) : without(entry[item.kind], item.name)
  if ((entry[item.kind] ?? []).length === 0) delete entry[item.kind]
  lists[item.vendor] = entry
  tools[side] = lists
  return withTools(o, tools)
}

/** Use skill: the skill this run asks its passes that change files to use (null: none). */
export function setUseSkill(o: RunOverrides, skill: { vendor: string; name: string } | null): RunOverrides {
  const tools = structuredClone(o.tools ?? {})
  if (skill === null) delete tools.skill
  else tools.skill = { vendor: skill.vendor, name: skill.name }
  return withTools(o, tools)
}

function withTools(o: RunOverrides, tools: NonNullable<RunOverrides['tools']>): RunOverrides {
  const pruned = pruneEmpty(tools)
  const next: RunOverrides = { ...o }
  if (Object.keys(pruned).length === 0 && pruned.skill === undefined) delete next.tools
  else next.tools = pruned
  return settle(o, next)
}

/** The overrides without the run's Tools (what Save all overrides writes, and what the save button counts). */
export function withoutTools(o: RunOverrides): RunOverrides {
  if (o.tools === undefined) return o
  const next: RunOverrides = { ...o }
  delete next.tools
  return next
}

/** How many tools this run turned on beyond the settings (picks, and Use skill when it is not one of them). */
export function pickedCount(o: RunOverrides): number {
  const t = resolvedRunTools(o.tools)
  const names = new Set<string>()
  for (const [v, n] of Object.entries(t.on))
    for (const k of ['mcp', 'skills'] as const) for (const x of n[k]) names.add(`${v}|${k}|${x}`)
  if (t.skill !== null) names.add(`${t.skill.vendor}|skills|${t.skill.name}`)
  return names.size
}

/** How many tools this run took off the settings' list. */
export function removedCount(o: RunOverrides): number {
  const t = resolvedRunTools(o.tools)
  return Object.values(t.off).reduce((n, x) => n + x.mcp.length + x.skills.length, 0)
}

/** Where a pick reaches in this run, in words (the picker's header), with no em dashes. */
export function toolsReachText(config: ConfigSlice): string {
  const writers = passesOf(config).filter((p) => WRITE_PASSES.includes(p.pass))
  const label = (p: PassName): string => (p === 'implement' ? 'Implement' : p === 'fix' ? 'Fix' : p)
  const at = (level: ExtensionLevel): string =>
    writers
      .filter((p) => p.level === level)
      .map((p) => label(p.pass))
      .join(' and ')
  const allowed = at('allowed')
  const through = at('passthrough')
  const parts: string[] = []
  if (allowed !== '')
    parts.push(`${allowed} at Allowed list ${allowed.includes(' and ') ? 'get' : 'gets'} what you tick here.`)
  if (through !== '')
    parts.push(
      `${through} at Pass through already ${through.includes(' and ') ? 'load' : 'loads'} all your tools; ticked ones are named in the prompt.`,
    )
  if (parts.length === 0)
    parts.push('No pass that changes files uses your tools in this run (their Extensions are None).')
  return `${parts.join(' ')} Read-only passes never get a tool from here. Unticking one from your settings takes it off every pass at Allowed list for this run.`
}

// ---- suggestions -----------------------------------------------------------------------------------------------

/** Words that name a kind of tool, and how to recognise such a tool by its name. */
const HINTS: readonly { says: RegExp; tool: RegExp }[] = [
  { says: /\blinear\b/i, tool: /linear/i },
  { says: /\b(jira|atlassian|confluence)\b/i, tool: /atlassian|jira|confluence/i },
  { says: /\b(github|pull requests?|gh issue)\b|\bPRs?\b/, tool: /github/i },
  { says: /\b(gitlab|merge requests?)\b/i, tool: /gitlab/i },
  { says: /\bnotion\b/i, tool: /notion/i },
  { says: /\bslack\b/i, tool: /slack/i },
  { says: /\basana\b/i, tool: /asana/i },
  { says: /\bsentry\b/i, tool: /sentry/i },
  { says: /\bfigma\b/i, tool: /figma/i },
  { says: /\b(postgres|postgresql|database|sql)\b/i, tool: /postgres|sql|database|supabase|neon/i },
  { says: /\b(browser|playwright|screenshot)\b/i, tool: /playwright|browser|puppeteer/i },
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The tools the task points at (its own name in the task, or a word that names its kind), among those not on for this
 * run yet; at most `max`. Only a suggestion: a chip the user may click.
 */
export function suggestTools(task: string, items: readonly ToolItem[], o: RunOverrides, max = 2): ToolItem[] {
  const text = task.trim()
  if (text.length < 4) return []
  const lower = text.toLowerCase()
  return items
    .filter((i) => i.kind === 'mcp' && !isToolOn(o, i))
    .filter((i) => {
      const own = i.name.replace(/^claude[._ ]ai[._ -]?/i, '').toLowerCase()
      const named =
        own.length >= 3 && new RegExp(`\\b${escape(own).replace(/[-_]+/g, '[\\s_-]?')}\\b`, 'i').test(lower)
      return named || HINTS.some((h) => h.says.test(text) && h.tool.test(`${i.name} ${i.label}`))
    })
    .slice(0, max)
}
