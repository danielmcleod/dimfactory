// `config_patch` executor rules (with `selfHeal.autoApplyConfigPatches` and state machine row P22). A recovery patch
// executes ONLY allowlisted pointers (config/patch.ts CONFIG_PATCH_ALLOWLIST):
// never executable paths, verify or install commands, `auto` (turning it on), or a mode escalation; extraArgs never
// carry managed flags. Three layers check every patch: the pointer allowlist and its value rules (validatePatchOps),
// then, for a run's resolved config, the patched config must still parse (ResolvedConfigZ) and every field outside the
// allowlist must be exactly what it was (guardResolved). The preview is the diff the snag card shows.
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import { FLAG_VALUE_PATTERN, ResolvedConfigZ } from '../../shared/config-schema.ts'
import type { JsonPatchOp } from '../../shared/failure.ts'
import { VENDOR_ID_PATTERN } from '../../shared/vendors.ts'
import { parseJsonPointer, validatePatchOps } from '../config/patch.ts'
import { DimFactoryError } from '../errors.ts'
import { applyJsonPatch, jsonEqual, valueAt } from './json-patch.ts'

export type PatchTarget = 'runOverrides' | 'resolved'

/** What `selfHeal.autoApplyConfigPatches` may apply without a click (documentation form). */
export const AUTO_APPLY_POINTERS = [
  '/passes/*/model',
  '/timeouts/*',
  '/vendors/*/extraArgs',
  '/vendors/*/flagMap/*',
] as const

/**
 * Managed flags that hold a pass read-only or hermetic (the tool cut, no MCP, no hooks, the permission mode and
 * the ask relay), by spelling-insensitive identity, for every vendor. A rename of one of them is never applied without
 * a click: the user sees its preview first. The other managed flags stay in the autoApply subset.
 */
const SAFETY_FLAG_KEYS: ReadonlySet<string> = new Set([
  'disallowedtools',
  'allowedtools',
  'strictmcpconfig',
  'settings',
  'permissionmode',
  'permissionprompts',
  'permissionprompttool',
  'sandbox',
  's',
  'askforapproval',
  'a',
  'approvalmode',
  'approvalpolicy',
])

/** A read-only safety flag (see SAFETY_FLAG_KEYS): its rename always waits for the user. */
export function isSafetyFlag(flag: string): boolean {
  return SAFETY_FLAG_KEYS.has(flagKey(flag))
}

/** One write op inside the autoApply subset. */
export function isAutoApplicableOp(op: JsonPatchOp): boolean {
  if (op.op === 'test') return true
  const s = parseJsonPointer(op.path)
  if (s === null) return false
  const [top, a, b, c] = s
  if (top === 'passes') return s.length === 3 && b === 'model'
  if (top === 'timeouts') return s.length === 2
  if (top === 'vendors' && a !== undefined) {
    if (b === 'extraArgs') return s.length === 3 || s.length === 4
    if (b === 'flagMap') return s.length === 4 && c !== undefined && !isSafetyFlag(c)
  }
  return false
}

/** Every op is in the autoApply subset and at least one writes. */
export function isAutoApplicable(ops: readonly JsonPatchOp[]): boolean {
  return ops.some((o) => o.op !== 'test') && ops.every(isAutoApplicableOp)
}

/** `add`/`replace` of `/auto` with `false`: turning Auto off is never an escalation (a composer preflight fix). */
function isAutoOff(op: JsonPatchOp): boolean {
  return (op.op === 'add' || op.op === 'replace') && op.path === '/auto' && op.value === false
}

export interface CheckOpsOptions {
  target: PatchTarget
  /** Per-vendor `adapter.managedFlags` (extraArgs may not carry them; flagMap may only rename them). */
  managedFlags?: Readonly<Record<string, readonly string[]>> | undefined
  /**
   * The vendor adapter's own extraArgs / flagMap rules, applied to the values the ops write (so a patch saved without
   * a run's config, e.g. a run-less heal's "Apply and save", meets the same rules a spawn does).
   */
  vendorArgs?: VendorArgsCheck | undefined
}

/**
 * The vendor's own rules over each extraArgs list or flagMap rename an op writes (no config needed): FORBIDDEN with
 * the adapter's reason. Removals and tests are not checked (they add nothing).
 */
function checkVendorOps(ops: readonly JsonPatchOp[], vendorArgs: VendorArgsCheck | undefined): void {
  if (vendorArgs === undefined) return
  for (const op of ops) {
    if (op.op === 'test' || op.op === 'remove') continue
    const s = parseJsonPointer(op.path)
    const vendor = s?.[0] === 'vendors' ? s[1] : undefined
    if (s === null || vendor === undefined) continue
    let problem: string | undefined
    if (s[2] === 'extraArgs') {
      const list: unknown = s.length === 4 ? [op.value] : op.value
      if (Array.isArray(list) && list.every((x) => typeof x === 'string')) {
        problem = vendorArgs(vendor, { extraArgs: list, flagMap: {} })
      }
    } else if (s[2] === 'flagMap' && s[3] !== undefined && typeof op.value === 'string') {
      problem = vendorArgs(vendor, { extraArgs: [], flagMap: { [s[3]]: op.value } })
    }
    if (problem !== undefined) throw forbid(problem)
  }
}

/**
 * The allowlist over a recovery patch: FORBIDDEN for anything outside it (with every reason), VALIDATION for
 * a malformed op or an empty patch. `runOverrides` may also turn Auto off (`/auto: false`), never on.
 */
export function checkRecoveryOps(ops: readonly unknown[], o: CheckOpsOptions): JsonPatchOp[] {
  if (!Array.isArray(ops) || ops.length === 0)
    throw new DimFactoryError('VALIDATION', 'This fix changes nothing.')
  const rest = ops.filter((op) => !(o.target === 'runOverrides' && isAutoOffOp(op)))
  const v = validatePatchOps(rest, {
    scope: 'user',
    allowlist: true,
    ...(o.managedFlags !== undefined ? { managedFlags: o.managedFlags } : {}),
  })
  if (!v.ok) {
    const code = v.rejected.some((r) => r.kind === 'forbidden') ? 'FORBIDDEN' : 'VALIDATION'
    throw new DimFactoryError(
      code,
      `Dim Factory will not apply this fix: ${v.rejected.map((r) => r.reason).join('; ')}.`,
      {
        details: v.rejected,
      },
    )
  }
  if (!ops.some((op) => (op as JsonPatchOp).op !== 'test')) {
    throw new DimFactoryError('VALIDATION', 'This fix changes nothing.')
  }
  checkVendorOps(ops as JsonPatchOp[], o.vendorArgs)
  return ops as JsonPatchOp[]
}

const isAutoOffOp = (op: unknown): boolean =>
  typeof op === 'object' && op !== null && !Array.isArray(op) && isAutoOff(op as JsonPatchOp)

// ---- resolved config ---------------------------------------------------------------------------------------------

const EMPTY_VENDOR = (): ResolvedConfig['vendors'][string] => ({
  path: null,
  defaultModel: null,
  defaultEffort: null,
  extraArgs: [],
  env: {},
  flagMap: {},
})

/** A vendor entry the ops write into but the config lacks (a resolved config lists configured vendors only). */
function withVendorEntries(config: ResolvedConfig, ops: readonly JsonPatchOp[]): ResolvedConfig {
  let out = config
  for (const op of ops) {
    const s = parseJsonPointer(op.path)
    const id = s?.[0] === 'vendors' ? s[1] : undefined
    if (id === undefined || s === null || s.length < 3 || Object.hasOwn(out.vendors, id)) continue
    if (!VENDOR_ID_PATTERN.test(id)) continue
    if (out === config) out = { ...config, vendors: { ...config.vendors } }
    out.vendors[id] = EMPTY_VENDOR()
  }
  return out
}

/**
 * A recorded recovery patch (resolved.json `patches[]`) applied again to the stored config on load, exactly as it was
 * applied in the run: a vendor entry the config lacks is created first (withVendorEntries), so a flagMap or extraArgs
 * fix for a vendor the run's config did not list survives a relaunch. Throws when the ops no longer apply.
 */
export function replayRecoveryPatch(config: unknown, ops: readonly JsonPatchOp[]): unknown {
  let base = config
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    const c = config as Record<string, unknown>
    const vendors = c['vendors']
    if (typeof vendors === 'object' && vendors !== null && !Array.isArray(vendors)) {
      base = withVendorEntries(c as unknown as ResolvedConfig, ops)
    }
  }
  return applyJsonPatch(base, ops)
}

/** Every field of a resolved config a recovery patch must leave exactly as it was. */
function frozenPart(c: ResolvedConfig, vendorIds: readonly string[]): unknown {
  const passes = Object.fromEntries(
    Object.entries(c.passes).map(([p, v]) => {
      const { vendor: _v, model: _m, effort: _f, enabled: _e, ...rest } = v as Record<string, unknown>
      if (p === 'fix') delete rest['reuseSession']
      return [p, rest]
    }),
  )
  const vendors = Object.fromEntries(
    vendorIds.map((id) => {
      const v = c.vendors[id] ?? EMPTY_VENDOR()
      return [
        id,
        { path: v.path, defaultModel: v.defaultModel, defaultEffort: v.defaultEffort ?? null, env: v.env },
      ]
    }),
  )
  const { branch: _b, worktree, ...isolation } = c.isolation
  const { install: _i, ...wt } = worktree
  return {
    auto: c.auto,
    passes,
    planning: c.planning,
    gates: c.gates,
    ask: c.ask,
    isolation: { ...isolation, worktree: wt },
    verify: c.verify,
    selfHeal: c.selfHeal,
    ui: c.ui,
    notifications: c.notifications,
    vendors,
    catalog: c.catalog,
    storage: c.storage,
    local: c.local,
  }
}

/** Spelling-insensitive identity of a flag: `--allowedTools` = `--allowed-tools` = `--ALLOWED_TOOLS`. */
export function flagKey(arg: string): string {
  const name = arg.startsWith('-') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
  return name.replace(/^-+/, '').toLowerCase().replace(/[-_]/g, '')
}

/**
 * Flags that widen what a pass may do, for any vendor (never a mode escalation): permission bypasses, extra
 * directories, MCP servers, plugins, agent definitions, setting sources, sandbox and approval overrides and config
 * overrides (`-c`, `-s`). A recovery patch may not add them to extraArgs nor rename a flag to them.
 */
const ESCALATION_KEYS: ReadonlySet<string> = new Set([
  'adddir',
  'mcpconfig',
  'plugindir',
  'settingsources',
  'agents',
  'yolo',
  'fullauto',
  'sandbox',
  's',
  'askforapproval',
  'approvalmode',
  'approvalpolicy',
  'config',
  'c',
  'bypasspermissions',
  'nosandbox',
])

/**
 * The single-letter flags of a combined short-flag argument (`-pc` → `-p`, `-c`; `-r<id>` → `-r`, …), or null for
 * anything else. Vendor CLIs parse such an argument letter by letter (`-pc` is `--print --continue`).
 */
export function shortFlagLetters(arg: string): string[] | null {
  if (!/^-[^-]/.test(arg) || arg.length <= 2) return null
  return [...arg.slice(1)].map((ch) => `-${ch}`)
}

/** True for an argument that widens a pass's permissions (see ESCALATION_KEYS). */
export function escalatingArg(arg: string): boolean {
  if (!arg.startsWith('-') || arg.length < 2) return false
  const k = flagKey(arg)
  return (
    ESCALATION_KEYS.has(k) ||
    /^(allow)?dangerously/.test(k) ||
    /skippermissions|dangerfullaccess|bypassapprovals/.test(k)
  )
}

/** A vendor's own rules for its extraArgs and flagMap (the adapter's launch checks); the problem, or undefined. */
export type VendorArgsCheck = (
  vendor: string,
  v: { extraArgs: readonly string[]; flagMap: Readonly<Record<string, string>> },
) => string | undefined

export interface GuardOptions {
  /** Per-vendor `adapter.managedFlags`. */
  managedFlags?: Readonly<Record<string, readonly string[]>> | undefined
  /** The vendor adapter's own extraArgs / flagMap check (Claude: extraArgsProblem, flagMapProblem). */
  vendorArgs?: VendorArgsCheck | undefined
}

const forbid = (why: string): DimFactoryError =>
  new DimFactoryError('FORBIDDEN', `Dim Factory will not apply this fix: ${why}.`)

/** The extraArgs and flagMap rules over a vendor's changed values (whatever ops built them). */
function checkVendorArgs(
  id: string,
  after: ResolvedConfig['vendors'][string],
  before: ResolvedConfig['vendors'][string],
  o: GuardOptions,
): void {
  const managed = o.managedFlags?.[id]
  const managedKeys = new Set((managed ?? []).map(flagKey))
  if (!jsonEqual(after.extraArgs, before.extraArgs)) {
    for (const arg of after.extraArgs) {
      if (/[\r\n\0]/.test(arg)) throw forbid('an extra argument contains a line break')
      if (escalatingArg(arg)) throw forbid(`${arg} widens the vendor's permissions (mode escalation)`)
      if (arg.startsWith('-') && managedKeys.has(flagKey(arg))) {
        throw forbid(`${arg} is managed by Dim Factory; use flagMap to rename it`)
      }
      // `-pc` is `-p -c` to the CLI's parser: every letter of a combined short flag is checked.
      const hit = shortFlagLetters(arg)?.find((l) => managedKeys.has(flagKey(l)) || escalatingArg(l))
      if (hit !== undefined) {
        throw forbid(`${arg} combines ${hit} with other short flags; Dim Factory manages ${hit}`)
      }
    }
  }
  const targets = new Set<string>()
  for (const [from, to] of Object.entries(after.flagMap)) {
    const changed = before.flagMap[from] !== to
    if (changed) {
      if (!FLAG_VALUE_PATTERN.test(to)) throw forbid('flagMap values must look like a flag (e.g. --new-name)')
      if (escalatingArg(to)) throw forbid(`${to} widens the vendor's permissions (mode escalation)`)
      if (managed !== undefined && !managed.includes(from)) {
        throw forbid(`${from} is not a flag Dim Factory manages for ${id}`)
      }
      // Never another flag Dim Factory manages (`--disallowedTools` to `--allowedTools` would allow what it cuts).
      if (flagKey(to) !== flagKey(from) && managedKeys.has(flagKey(to))) {
        throw forbid(`${from} cannot be renamed to ${to}, a flag Dim Factory manages itself`)
      }
    }
    if (targets.has(flagKey(to))) throw forbid(`two flags would be renamed to ${to}`)
    targets.add(flagKey(to))
  }
  const own = o.vendorArgs?.(id, { extraArgs: after.extraArgs, flagMap: after.flagMap })
  if (own !== undefined) throw forbid(own)
}

/**
 * FORBIDDEN when `after` differs from `before` anywhere outside the allowlist (a mode, Auto, verify or install
 * commands, executable paths, env, …), or when a changed extraArgs / flagMap breaks the value rules (managed flags,
 * escalations, the vendor's own launch checks).
 */
export function guardResolved(before: ResolvedConfig, after: ResolvedConfig, o: GuardOptions = {}): void {
  const ids = [...new Set([...Object.keys(before.vendors), ...Object.keys(after.vendors)])]
  if (!jsonEqual(frozenPart(before, ids), frozenPart(after, ids))) {
    throw forbid('it changes a protected setting')
  }
  for (const id of ids) {
    const a = after.vendors[id] ?? EMPTY_VENDOR()
    const b = before.vendors[id] ?? EMPTY_VENDOR()
    if (jsonEqual(a.extraArgs, b.extraArgs) && jsonEqual(a.flagMap, b.flagMap)) continue
    checkVendorArgs(id, a, b, o)
  }
}

/**
 * The run's resolved config with a recovery patch applied: allowlisted ops only, a config that still parses, and
 * nothing protected changed. Throws DimFactoryError (FORBIDDEN / VALIDATION) otherwise.
 */
export function patchResolved(
  config: ResolvedConfig,
  ops: readonly unknown[],
  o: GuardOptions = {},
): { config: ResolvedConfig; ops: JsonPatchOp[] } {
  // The vendor's own rules run over the whole patched config below (guardResolved), not op by op.
  const checked = checkRecoveryOps(ops, { target: 'resolved', managedFlags: o.managedFlags })
  const patched = applyJsonPatch(withVendorEntries(config, checked), checked)
  const parsed = ResolvedConfigZ.safeParse(patched)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where =
      first !== undefined && first.path.length > 0 ? ` at /${first.path.map(String).join('/')}` : ''
    throw new DimFactoryError(
      'VALIDATION',
      `This fix would make the run's settings invalid${where}: ${first?.message ?? 'invalid'}.`,
    )
  }
  guardResolved(config, parsed.data, o)
  return { config: parsed.data, ops: checked }
}

// ---- preview (the diff the snag card shows) -------------------------------------------------------------------------

const PREVIEW_VALUE_MAX = 80

/** A value as preview text; cut at 80 characters unless `whole` (a vendor's arguments are never cut). */
function previewValue(v: unknown, whole = false): string {
  if (v === undefined) return '(not set)'
  const s = JSON.stringify(v) ?? 'undefined'
  return !whole && s.length > PREVIEW_VALUE_MAX ? `${s.slice(0, PREVIEW_VALUE_MAX - 1)}…` : s
}

/** `/vendors/claude/flagMap/--a~1b` → `vendors.claude.flagMap.--a/b`. */
export function pointerLabel(pointer: string): string {
  const s = parseJsonPointer(pointer)
  return s === null ? pointer : s.join('.')
}

/**
 * A list replaced by another, as the items it loses and gains (each in full; a repeated item counts each time), or
 * null when only the order changes.
 */
function listChange(
  old: readonly unknown[],
  next: readonly unknown[],
): { gone: unknown[]; added: unknown[] } | null {
  const left = [...next]
  const gone: unknown[] = []
  for (const x of old) {
    const i = left.findIndex((y) => jsonEqual(x, y))
    if (i < 0) gone.push(x)
    else left.splice(i, 1)
  }
  return gone.length === 0 && left.length === 0 ? null : { gone, added: left }
}

/**
 * The diff of a patch as lines, `- key: old` / `+ key: new` (no `-` line for a new key, no `+` line for a removed one),
 * against `before` when given (the run's config, the composer's overrides). `test` ops are not shown. A vendor's
 * extraArgs and flagMap values are shown whole (an argument appended to a long list must be seen), and a
 * replaced extraArgs list as the arguments it loses and gains, one per line.
 */
export function patchPreview(ops: readonly JsonPatchOp[], before?: unknown): string {
  const lines: string[] = []
  let doc: unknown = before
  for (const op of ops) {
    if (op.op === 'test') continue
    const key = pointerLabel(op.path)
    const seg = parseJsonPointer(op.path) ?? []
    const whole = seg[0] === 'vendors' && (seg[2] === 'extraArgs' || seg[2] === 'flagMap')
    const old = doc !== undefined ? valueAt(doc, op.path) : undefined
    const change =
      whole && op.op !== 'remove' && Array.isArray(old) && Array.isArray(op.value)
        ? listChange(old, op.value)
        : null
    if (change !== null) {
      for (const x of change.gone) lines.push(`- ${key}: ${previewValue(x, true)}`)
      for (const x of change.added) lines.push(`+ ${key}: ${previewValue(x, true)}`)
    } else {
      if (old !== undefined || op.op === 'remove') lines.push(`- ${key}: ${previewValue(old, whole)}`)
      if (op.op !== 'remove') lines.push(`+ ${key}: ${previewValue(op.value, whole)}`)
    }
    if (doc !== undefined) {
      try {
        doc = applyJsonPatch(doc, [op])
      } catch {
        doc = undefined
      }
    }
  }
  return lines.join('\n')
}
