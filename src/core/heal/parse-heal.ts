// Self-heal answer parsing and safety (executors config_patch / shell_copy; the internal/heal.md answer schema).
// One fenced JSON block, validated with zod; each suggestion becomes a
// RecoveryAction only when it passes the same allowlist the config_patch executor applies (plus heal-only value
// rules), or the shell checks (heal/shell-check.ts: the shell denylist and the command families a heal may suggest).
// Everything dropped is counted as `hidden` ("Dim Factory hid N unsafe suggestions").
import { z } from 'zod'
import { BRANCH_MODES, ProfileNameZ, TimeoutsZ } from '../../shared/config-schema.ts'
import type { FailureCategory, JsonPatchOp, RecoveryAction } from '../../shared/failure.ts'
import { isFailureCategory } from '../../shared/failure.ts'
import { vendorCheckId } from '../../shared/preflight.ts'
import { PASS_NAMES } from '../../shared/run.ts'
import type { PassName } from '../../shared/run.ts'
import { VENDOR_ID_PATTERN } from '../../shared/vendors.ts'
import { parseJsonPointer, validatePatchOps } from '../config/patch.ts'
import { shellFor } from './commands.ts'
import type { OsFamily } from './commands.ts'
import { shellCommandProblem } from './shell-check.ts'

export { HEAL_SHELL_MAX, isRecursiveFlag, shellCommandProblem } from './shell-check.ts'

export const HEAL_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const
export type HealConfidenceLevel = (typeof HEAL_CONFIDENCE_LEVELS)[number]

/** "propose at most 3 remediations" (the heal template). */
export const HEAL_MAX_ACTIONS = 3
export const HEAL_DIAGNOSIS_MAX = 300
export const HEAL_REASON_MAX = 300

const ELLIPSIS = '\u2026'

// ---- the answer ----------------------------------------------------------------------------------------------------

/** The healer's validated answer, before the safety pass (the heal cache stores this shape). */
export interface HealAnswer {
  diagnosis: string
  confidence: HealConfidenceLevel
  category?: FailureCategory
  /** The suggestions as answered; {@link toSafeActions} checks each one. */
  actions: unknown[]
}

export const HealAnswerZ = z.object({
  diagnosis: z.string(),
  confidence: z.enum(HEAL_CONFIDENCE_LEVELS),
  category: z.string().optional(),
  actions: z.array(z.unknown()).max(50).default([]),
})

export type ParseHealResult = { ok: true; answer: HealAnswer } | { ok: false; error: string }

/**
 * Model text as one line of UI copy: control characters and line breaks become spaces, an em dash becomes a colon
 * (UI copy standard), and it is cut to `max`.
 */
export function healCopy(s: string, max: number): string {
  const one = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s*\u2014\s*/g, ': ')
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > max ? `${one.slice(0, max - 1)}${ELLIPSIS}` : one
}

/** Normalize a zod-checked answer: one-line diagnosis, a known category or none. */
export function normalizeAnswer(v: z.infer<typeof HealAnswerZ>): HealAnswer | null {
  const diagnosis = healCopy(v.diagnosis, HEAL_DIAGNOSIS_MAX)
  if (diagnosis === '') return null
  const out: HealAnswer = { diagnosis, confidence: v.confidence, actions: v.actions }
  const category = v.category?.trim().toLowerCase()
  if (category !== undefined && isFailureCategory(category)) out.category = category
  return out
}

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g

/**
 * Parse the healer's final message: exactly one ```json fenced block (prose around it is ignored), or, when there is
 * no fence at all, a message that is a JSON object by itself.
 */
export function parseHealAnswer(text: string): ParseHealResult {
  const src = text.replace(/\r\n?/g, '\n')
  const blocks = [...src.matchAll(FENCE)].filter((m) => {
    const lang = (m[1] ?? '').toLowerCase()
    return lang === 'json' || lang === 'jsonc' || (lang === '' && /^\s*\{/.test(m[2] ?? ''))
  })
  let body: string
  if (blocks.length > 1) {
    return {
      ok: false,
      error: `The answer had ${blocks.length} JSON blocks; Dim Factory expects exactly one.`,
    }
  }
  if (blocks.length === 1) body = blocks[0]?.[2] ?? ''
  else if (/^\s*\{[\s\S]*\}\s*$/.test(src)) body = src
  else return { ok: false, error: 'The answer had no JSON block.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch (err) {
    return {
      ok: false,
      error: `The answer's JSON block is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    }
  }
  const r = HealAnswerZ.safeParse(parsed)
  if (!r.success) {
    const issue = r.error.issues[0]
    const where = issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
    return {
      ok: false,
      error: `The answer does not match the schema${where}: ${issue?.message ?? 'invalid'}.`,
    }
  }
  const answer = normalizeAnswer(r.data)
  if (answer === null) return { ok: false, error: 'The answer had no diagnosis.' }
  return { ok: true, answer }
}

// ---- suggestions ---------------------------------------------------------------------------------------------------

const ReasonZ = z.string().max(2000).optional()
const ConfigSuggestionZ = z.object({
  kind: z.literal('config'),
  ops: z.array(z.unknown()).min(1).max(10),
  reason: ReasonZ,
})
const SettingsSuggestionZ = z.object({
  kind: z.literal('settings'),
  pointer: z.string().min(2).max(200),
  value: z.unknown().optional(),
  reason: ReasonZ,
})
const ShellSuggestionZ = z.object({
  kind: z.literal('shell'),
  command: z.string(),
  reason: ReasonZ,
})

export interface SafeActionsContext {
  os: OsFamily
  /** The failing pass's vendor (re-check ids, recovery labels). */
  vendor: string
  /** Managed flags of every BUILT vendor (extraArgs and flagMap are refused for any other vendor). */
  managedFlags: Readonly<Record<string, readonly string[]>>
  /** Every flag each built vendor's CLI already defines (`adapter.cliFlags`): never a flagMap rename target. */
  cliFlags?: Readonly<Record<string, readonly string[]>>
  /** The heal belongs to a run (config patches target its resolved config, P22) or not (composer overrides). */
  inRun: boolean
  /** Action ids are `<idPrefix>-<n>`. */
  idPrefix: string
}

export interface SafeActions {
  actions: RecoveryAction[]
  /** Suggestions dropped as unsafe or malformed. */
  hidden: number
}

// ---- config ----------------------------------------------------------------------------------------------------

/** Flag identity regardless of spelling: `--allowedTools` = `--allowed-tools` = `--ALLOWED_TOOLS`. */
const flagKey = (arg: string): string =>
  (arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg)
    .replace(/^-+/, '')
    .toLowerCase()
    .replace(/[-_]/g, '')

/**
 * Flags a heal may never add or rename to: permission widening, extra folders or tools, MCP servers, plugins and
 * agents, settings and config overrides, and prompt text (a remediation that rewrites the model's instructions would
 * be a prompt-injection path from the evidence into every later pass). Compared by {@link flagKey}.
 */
const RISKY_FLAG_KEYS: ReadonlySet<string> = new Set(
  [
    'add-dir',
    'mcp-config',
    'strict-mcp-config',
    'plugin-dir',
    'setting-sources',
    'settings',
    'agents',
    'agent',
    'tools',
    'allowed-tools',
    'disallowed-tools',
    'permission-mode',
    'permission-prompt-tool',
    'permission-prompts',
    'system-prompt',
    'system-prompt-file',
    'append-system-prompt',
    'append-system-prompt-file',
    'instructions',
    'prompt',
    'config',
    'c',
    'profile',
    'sandbox',
    's',
    'ask-for-approval',
    'a',
    'cd',
    'cwd',
    'dir',
    'env',
    'ide',
    'resume',
    'continue',
    'fork-session',
    'session-id',
  ].map(flagKey),
)
const ESCALATION = /dangerously|yolo|full-?auto|bypass|danger-?full-?access|skip-?permissions|no-?sandbox/i
/** An extraArgs entry: a flag (optionally `=value`) or a plain value token; no spaces, quotes or shell syntax. */
const ARG_TOKEN = /^(?:--?[A-Za-z][A-Za-z0-9-]{0,40}(?:=[A-Za-z0-9._:/@+-]{1,64})?|[A-Za-z0-9._:/@+-]{1,64})$/
const LONG_FLAG = /^--[a-z][a-z0-9-]{1,40}$/

function managedKeys(managed: readonly string[]): Set<string> {
  return new Set(managed.map(flagKey))
}

function extraArgProblem(arg: unknown, managed: readonly string[]): string | undefined {
  if (typeof arg !== 'string' || !ARG_TOKEN.test(arg)) return 'not a plain argument'
  if (!arg.startsWith('-')) return undefined
  // `-pc` is `-p -c` (`--print --continue`) to the CLI's parser: a heal never combines short flags.
  if (/^-[^-]/.test(arg) && arg.length > 2) return 'combines short flags'
  const key = flagKey(arg)
  if (ESCALATION.test(arg)) return 'widens permissions'
  if (RISKY_FLAG_KEYS.has(key)) return 'changes tools, permissions, settings or prompts'
  if (managedKeys(managed).has(key)) return 'is managed by Dim Factory'
  return undefined
}

function flagMapProblem(
  from: string,
  to: unknown,
  managed: readonly string[],
  cliFlags: readonly string[],
): string | undefined {
  if (typeof to !== 'string' || !LONG_FLAG.test(to)) return 'the new name is not a long flag'
  const keys = managedKeys(managed)
  if (!keys.has(flagKey(from))) return `${from} is not a flag Dim Factory manages`
  if (ESCALATION.test(to)) return 'widens permissions'
  const renamed = flagKey(to) !== flagKey(from)
  // Renaming onto another managed flag would change its meaning (--disallowedTools → --allowedTools).
  if (renamed && keys.has(flagKey(to))) return `${to} is managed by Dim Factory`
  if (renamed && RISKY_FLAG_KEYS.has(flagKey(to))) return 'changes tools or permissions'
  // Nor onto any flag the CLI already reads for something else (--disallowedTools → --fallback-model).
  if (renamed && cliFlags.some((f) => flagKey(f) === flagKey(to))) return `${to} is already a flag of the CLI`
  return undefined
}

const ModelValueZ = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:@/[\]-]+$/)
  .nullable()

/** Heal-only value rules on top of the config_patch allowlist (which config/patch.ts checks). */
function opValueProblem(
  segments: readonly string[],
  op: JsonPatchOp,
  managed: Readonly<Record<string, readonly string[]>>,
  cliFlags: Readonly<Record<string, readonly string[]>> = {},
): string | undefined {
  const [top, a, b, c] = segments
  if (op.op === 'test') return undefined
  if (top === 'vendors') {
    const vendor = a ?? ''
    const flags = Object.hasOwn(managed, vendor) ? managed[vendor] : undefined
    if (flags === undefined) return `${vendor} is not a vendor in this build`
    if (op.op === 'remove') return undefined
    if (b === 'extraArgs') {
      const list = segments.length === 4 ? [op.value] : op.value
      if (!Array.isArray(list) || list.length > 16) return 'extraArgs must be a short list'
      for (const arg of list) {
        const p = extraArgProblem(arg, flags)
        if (p !== undefined) return `extraArgs ${JSON.stringify(arg)} ${p}`
      }
      return undefined
    }
    if (b === 'flagMap') {
      const known = Object.hasOwn(cliFlags, vendor) ? (cliFlags[vendor] ?? []) : []
      return c === undefined ? 'flagMap needs a flag' : flagMapProblem(c, op.value, flags, known)
    }
    return 'not a vendor setting a heal may change'
  }
  if (op.op === 'remove') return 'only vendor arguments can be removed'
  const v = op.value
  if (top === 'profile') return ProfileNameZ.safeParse(v).success ? undefined : 'not a profile name'
  if (top === 'passes') {
    if (b === 'vendor') {
      if (typeof v !== 'string' || !VENDOR_ID_PATTERN.test(v)) return 'not a vendor id'
      return managed[v] !== undefined ? undefined : `${v} is not a vendor in this build`
    }
    if (b === 'model') return ModelValueZ.safeParse(v).success ? undefined : 'not a model id'
    return typeof v === 'boolean' ? undefined : 'must be true or false'
  }
  if (top === 'timeouts' && a !== undefined) {
    const field = TimeoutsZ.shape[a as keyof typeof TimeoutsZ.shape]
    return field !== undefined && field.safeParse(v).success ? undefined : 'not a valid timeout'
  }
  if (top === 'isolation' && a === 'branch') {
    return (BRANCH_MODES as readonly unknown[]).includes(v) ? undefined : 'not a branch mode'
  }
  if (top === 'isolation' && a === 'worktree' && b === 'install') {
    return v === 'ask' || v === 'never' ? undefined : 'install may only become ask or never'
  }
  return undefined
}

const PASS_LABEL: Readonly<Record<PassName, string>> = {
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  critic: 'Critic',
  security: 'Security',
  fix: 'Fix',
}
const TIMEOUT_LABEL: Readonly<Record<string, string>> = {
  stallMs: 'stall timeout',
  hardKillMs: 'hard timeout',
  toolStallMs: 'tool timeout',
  askMs: 'question timeout',
}

const passLabel = (p: string | undefined): string =>
  p !== undefined && (PASS_NAMES as readonly string[]).includes(p) ? PASS_LABEL[p as PassName] : 'the pass'

/** A JSON value as label text. */
const show = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? 'nothing'))

const minutes = (v: unknown): string =>
  typeof v === 'number' ? `${Math.round((v / 60_000) * 10) / 10} min` : show(v)

function configLabel(ops: readonly JsonPatchOp[]): string {
  const writes = ops.filter((o) => o.op !== 'test')
  const first = writes[0]
  if (writes.length !== 1 || first === undefined) return 'Apply the suggested settings'
  const seg = parseJsonPointer(first.path) ?? []
  const [top, a, b, c] = seg
  const value = first.op === 'remove' ? undefined : first.value
  if (top === 'vendors' && b === 'flagMap' && c !== undefined) {
    return first.op === 'remove' ? `Stop renaming ${c}` : `Use ${show(value)} instead of ${c}`
  }
  if (top === 'vendors' && b === 'extraArgs') return 'Change the extra CLI arguments'
  if (top === 'passes' && b === 'model') {
    return value === null
      ? `Use the default model for ${passLabel(a)}`
      : `Use model ${show(value)} for ${passLabel(a)}`
  }
  if (top === 'passes' && b === 'effort') {
    return value === null
      ? `Use the default effort for ${passLabel(a)}`
      : `Use ${show(value)} effort for ${passLabel(a)}`
  }
  if (top === 'passes' && b === 'vendor') return `Run ${passLabel(a)} on ${show(value)}`
  if (top === 'passes' && b === 'enabled') return `${value === true ? 'Turn on' : 'Turn off'} ${passLabel(a)}`
  if (top === 'passes' && b === 'reuseSession') {
    return value === true ? 'Let Fix continue the session' : 'Start Fix in a fresh session'
  }
  if (top === 'timeouts' && a !== undefined) return `Set the ${TIMEOUT_LABEL[a] ?? a} to ${minutes(value)}`
  if (top === 'profile') return `Use the ${show(value)} profile`
  return 'Apply the suggested setting'
}

/** One line per op: `add /vendors/claude/flagMap/--permission-mode = "--mode"`. */
export function previewOps(ops: readonly JsonPatchOp[]): string {
  return ops
    .map((o) => (o.op === 'remove' ? `remove ${o.path}` : `${o.op} ${o.path} = ${JSON.stringify(o.value)}`))
    .join('\n')
}

const RUN_OVERRIDE_TOPS: ReadonlySet<string> = new Set(['profile', 'passes', 'isolation'])

function configAction(
  raw: z.infer<typeof ConfigSuggestionZ>,
  ctx: SafeActionsContext,
  id: string,
): RecoveryAction | null {
  const v = validatePatchOps(raw.ops, { scope: 'user', allowlist: true, managedFlags: ctx.managedFlags })
  if (!v.ok) return null
  const ops = raw.ops as JsonPatchOp[]
  const writes: string[][] = []
  for (const op of ops) {
    const seg = parseJsonPointer(op.path)
    if (seg === null) return null
    if (opValueProblem(seg, op, ctx.managedFlags, ctx.cliFlags) !== undefined) return null
    if (op.op !== 'test') writes.push(seg)
  }
  if (writes.length === 0) return null
  const action: RecoveryAction = {
    id,
    label: configLabel(ops),
    kind: 'config_patch',
    target: ctx.inRun ? 'resolved' : 'runOverrides',
    ops: ops.map((o) => ({ ...o })),
    preview: previewOps(ops),
  }
  // A renamed CLI flag is a fact about the installed CLI: keep that fix for later runs too. Outside a run, anything
  // the composer's run overrides cannot hold (vendors, timeouts) goes to the user file.
  const flagMapOnly = writes.every((s) => s[0] === 'vendors' && s[2] === 'flagMap')
  const notOverride = writes.some((s) => !RUN_OVERRIDE_TOPS.has(s[0] ?? ''))
  if (ctx.inRun ? flagMapOnly : notOverride) action.persist = { scope: 'user' }
  return action
}

// ---- settings ----------------------------------------------------------------------------------------------------

/** Settings section (route) per top-level config key (src/renderer/src/pages/settings/sections.ts ids). */
const SECTION_OF: Readonly<Record<string, { route: string; title: string }>> = {
  vendors: { route: 'settings/vendors', title: 'Vendors' },
  local: { route: 'settings/vendors', title: 'Vendors' },
  profile: { route: 'settings/profiles', title: 'Profiles' },
  profiles: { route: 'settings/profiles', title: 'Profiles' },
  passes: { route: 'settings/profiles', title: 'Profiles' },
  selfHeal: { route: 'settings/self-heal', title: 'Self-heal' },
  timeouts: { route: 'settings/general', title: 'General' },
  ask: { route: 'settings/general', title: 'General' },
  gates: { route: 'settings/general', title: 'General' },
  planning: { route: 'settings/general', title: 'General' },
  storage: { route: 'settings/general', title: 'General' },
  isolation: { route: 'settings/isolation', title: 'Isolation & Verify' },
  verify: { route: 'settings/isolation', title: 'Isolation & Verify' },
  catalog: { route: 'settings/catalog', title: 'Catalog' },
  ui: { route: 'settings/appearance', title: 'Appearance' },
  notifications: { route: 'settings/notifications', title: 'Notifications' },
}

/** A prefilled value that would widen what runs may do (the user would be one click from saving it). */
const ESCALATING_SETTING = (seg: readonly string[], value: unknown): boolean => {
  const [top, a, b] = seg
  if (top === 'auto') return value === true
  if ((top === 'passes' || top === 'profiles') && seg[seg.length - 1] === 'mode') return value !== 'readonly'
  if (top === 'verify' || (top === 'isolation' && a === 'worktree' && b === 'installCommand')) return true
  if (top === 'isolation' && a === 'worktree' && b === 'install') return value === 'auto'
  if (top === 'vendors' && (b === 'extraArgs' || b === 'flagMap' || b === 'env')) return true
  if (top === 'selfHeal' && a === 'autoApplyConfigPatches') return value === true
  return typeof value === 'string' && ESCALATION.test(value)
}

/** A settings link (null when the pointer is outside the config, or its prefilled value is an escalation). */
function settingsAction(raw: z.infer<typeof SettingsSuggestionZ>, id: string): RecoveryAction | null {
  const seg = parseJsonPointer(raw.pointer)
  if (
    seg === null ||
    seg.length === 0 ||
    seg.some((s) => s === '' || /^(__proto__|constructor|prototype)$/.test(s))
  ) {
    return null
  }
  const section = SECTION_OF[seg[0] ?? '']
  if (section === undefined) return null
  const action: RecoveryAction = {
    id,
    label: `Open ${section.title} settings`,
    kind: 'settings_link',
    route: section.route,
    pointer: raw.pointer,
  }
  const v = raw.value
  if (v === undefined) return action
  if (ESCALATING_SETTING(seg, v)) return null
  const scalarOk =
    v === null ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.length <= HEAL_REASON_MAX && !/[\r\n]/.test(v))
  if (!scalarOk) return action
  // An executable path is never prefilled unless it names the vendor's own binary (Settings checks it by running it).
  if (seg[0] === 'vendors' && seg[2] === 'path') {
    const base = typeof v === 'string' ? (v.split(/[\\/]/).pop() ?? '').toLowerCase() : ''
    const vendor = seg[1] ?? ''
    if (!new RegExp(`^${vendor.replace(/[^a-z0-9-]/g, '')}(\\.(exe|cmd))?$`).test(base)) return action
  }
  action.suggested = typeof v === 'string' ? healCopy(v, HEAL_REASON_MAX) : v
  return action
}

// ---- shell -------------------------------------------------------------------------------------------------------

/** The vendor check a command fixes, re-run after "I ran it" (a vendor id forces a fresh probe). */
function recheckFor(command: string, vendor: string): string {
  const v = VENDOR_ID_PATTERN.test(vendor) ? vendor : 'claude'
  if (/\b(login|logout|auth|api_key|apikey)\b/i.test(command)) return vendorCheckId(v, 'auth')
  if (/\bgit\b/i.test(command) && !/\b(claude|codex|gemini)\b/i.test(command)) return 'app.git'
  return vendorCheckId(v, 'bin')
}

function shellAction(
  raw: z.infer<typeof ShellSuggestionZ>,
  ctx: SafeActionsContext,
  id: string,
): RecoveryAction | null {
  if (shellCommandProblem(raw.command) !== undefined) return null
  const command = raw.command.trim()
  const reason = healCopy(raw.reason ?? '', HEAL_REASON_MAX)
  const elevated = /^\s*(sudo|doas)\b/i.test(command) || /--elevated\b/.test(command)
  const action: RecoveryAction = {
    id,
    label: 'Copy the suggested command',
    kind: 'shell_copy',
    command,
    shell: shellFor(ctx.os),
    reason: reason !== '' ? reason : 'Run it in a terminal, then re-check.',
    recheck: recheckFor(command, ctx.vendor),
  }
  if (elevated) action.elevated = true
  return action
}

// ---- all suggestions ------------------------------------------------------------------------------------------------

/**
 * Turn the answer's suggestions into safe RecoveryActions (at most {@link HEAL_MAX_ACTIONS}, in the answer's order).
 * A suggestion that is malformed, of an unknown kind, off the config allowlist, an escalation or on the shell denylist
 * is dropped and counted in `hidden`. Suggestions past the third safe one are ignored.
 */
export function toSafeActions(answer: Pick<HealAnswer, 'actions'>, ctx: SafeActionsContext): SafeActions {
  const actions: RecoveryAction[] = []
  let hidden = 0
  for (const raw of answer.actions) {
    if (actions.length >= HEAL_MAX_ACTIONS) break
    const id = `${ctx.idPrefix}-${actions.length + 1}`
    let action: RecoveryAction | null = null
    const config = ConfigSuggestionZ.safeParse(raw)
    const settings = SettingsSuggestionZ.safeParse(raw)
    const shell = ShellSuggestionZ.safeParse(raw)
    if (config.success) action = configAction(config.data, ctx, id)
    else if (settings.success) action = settingsAction(settings.data, id)
    else if (shell.success) action = shellAction(shell.data, ctx, id)
    if (action === null) {
      hidden++
      continue
    }
    actions.push(action)
  }
  return { actions, hidden }
}
