// JSON Patch (RFC 6902 subset) for dimfactory.json: pointer parsing, the `config_patch` allowlist and user-only
// scope routing (Save; the config_patch executor). Pure: no fs. save.ts applies the ops.
//
// Two callers:
// - recovery `config_patch` actions and self-heal (allowlist ON): only the allowlisted paths, never executable paths,
//   verify or install commands, `auto`, or a mode escalation;
// - Settings sections and the PlanGate "don't stop" checkbox (allowlist OFF): any path the schema accepts.
// Both route user-only paths (`/vendors/*`, `/selfHeal/*`, …) to the user file; a `project` scope for them is dropped
// as unsafe (a committed project file must never carry them).
import type { ConfigScope } from '../../shared/config-schema.ts'
import { FLAG_VALUE_PATTERN, USER_ONLY_KEYS } from '../../shared/config-schema.ts'
import type { JsonPatchOp } from '../../shared/failure.ts'
import { JSON_PATCH_OPS } from '../../shared/failure.ts'
import { PASS_NAMES, READONLY_PASSES } from '../../shared/run.ts'
import { VENDOR_ID_PATTERN } from '../../shared/vendors.ts'

/** The `config_patch` allowlist (documentation form; {@link checkAllowlisted} is the implementation). */
export const CONFIG_PATCH_ALLOWLIST = [
  '/profile',
  '/passes/*/vendor',
  '/passes/*/model',
  '/passes/*/effort',
  // Only ever to "none": a recovery action narrows a pass's extensions, never widens them.
  '/passes/*/extensions',
  '/passes/{plan,review,critic}/enabled',
  '/passes/fix/reuseSession',
  '/timeouts/*',
  '/isolation/branch',
  '/isolation/worktree/install',
  '/vendors/*/extraArgs',
  '/vendors/*/flagMap/*',
] as const

const TIMEOUT_KEYS: readonly string[] = ['stallMs', 'hardKillMs', 'toolStallMs', 'askMs']
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Vendor arguments that widen permissions or drop the sandbox. A patch may never add them (as an extraArgs entry or
 * as a flagMap target): that would be a mode escalation by another name.
 */
const ESCALATING_ARG = /dangerously|yolo|full-auto|bypass|danger-full-access|skip-permissions|no-sandbox/i

// ---- pointers ------------------------------------------------------------------------------------------------

/** RFC 6901 → segments. `''` is the whole document (`[]`). Returns null for a malformed pointer. */
export function parseJsonPointer(pointer: string): string[] | null {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) return null
  const out: string[] = []
  for (const raw of pointer.slice(1).split('/')) {
    if (/~[^01]|~$/.test(raw)) return null
    out.push(raw.replace(/~1/g, '/').replace(/~0/g, '~'))
  }
  return out
}

/** The top-level key is user-only (an error in a project file). */
export function isUserOnlyPath(segments: readonly string[]): boolean {
  const top = segments[0]
  return top !== undefined && (USER_ONLY_KEYS as readonly string[]).includes(top)
}

/** Structural check for ops that arrive over IPC or from a heal response. */
export function isJsonPatchOp(v: unknown): v is JsonPatchOp {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (typeof o['op'] !== 'string' || !(JSON_PATCH_OPS as readonly string[]).includes(o['op'])) return false
  if (typeof o['path'] !== 'string') return false
  const keys = Object.keys(o)
  const allowed = o['op'] === 'remove' ? ['op', 'path'] : ['op', 'path', 'value']
  if (keys.some((k) => !allowed.includes(k))) return false
  return o['op'] === 'remove' || 'value' in o
}

// ---- allowlist ------------------------------------------------------------------------------------------------

export type AllowlistVerdict = { ok: true } | { ok: false; reason: string }

const deny = (reason: string): AllowlistVerdict => ({ ok: false, reason })
const ALLOW: AllowlistVerdict = { ok: true }
const NOT_LISTED = 'This setting cannot be changed by a recovery action'
const NARROW_ONLY = "A recovery action may only turn a pass's extensions off (none), never widen them"

/** Is `segments` (a write target) on the allowlist? `test` ops are not checked here (they write nothing). */
export function checkAllowlisted(segments: readonly string[]): AllowlistVerdict {
  const [top, a, b, c] = segments
  const n = segments.length
  switch (top) {
    case 'profile':
      return n === 1 ? ALLOW : deny(NOT_LISTED)
    case 'auto':
      return deny('Auto mode is never turned on by a recovery action')
    case 'verify':
      return deny('Verify commands are never changed by a recovery action')
    case 'passes':
    case 'profiles': {
      // profiles/<name>/<pass>/<key> mirrors passes/<pass>/<key>; only `passes` is patchable.
      const [pass, key] = top === 'passes' ? [a, b] : [b, c]
      if (key === 'mode') return deny('A pass mode is never changed by a recovery action (mode escalation)')
      if (top === 'profiles') return deny(NOT_LISTED)
      if (pass === undefined || !(PASS_NAMES as readonly string[]).includes(pass) || n !== 3) {
        return deny(NOT_LISTED)
      }
      if (key === 'vendor' || key === 'model' || key === 'effort') return ALLOW
      if (key === 'extensions') return ALLOW
      if (key === 'enabled') {
        return (READONLY_PASSES as readonly string[]).includes(pass)
          ? ALLOW
          : deny('Only Plan, Review and Critic can be switched on or off by a recovery action')
      }
      if (key === 'reuseSession' && pass === 'fix') return ALLOW
      return deny(NOT_LISTED)
    }
    case 'timeouts':
      return n === 2 && a !== undefined && TIMEOUT_KEYS.includes(a) ? ALLOW : deny(NOT_LISTED)
    case 'isolation':
      if (a === 'branch' && n === 2) return ALLOW
      if (a === 'worktree' && b === 'installCommand') {
        return deny('Install commands are never changed by a recovery action')
      }
      if (a === 'worktree' && b === 'install' && n === 3) return ALLOW
      return deny(NOT_LISTED)
    case 'vendors':
      if (a === undefined || !VENDOR_ID_PATTERN.test(a)) return deny(NOT_LISTED)
      if (b === 'path') return deny('Executable paths are never changed by a recovery action')
      if (b === 'extraArgs' && (n === 3 || (n === 4 && /^(-|0|[1-9]\d*)$/.test(c ?? '')))) return ALLOW
      if (b === 'flagMap' && n === 4) return ALLOW
      return deny(NOT_LISTED)
    case undefined:
    default:
      return deny(NOT_LISTED)
  }
}

/** Value rules on allowlisted targets (escalations hidden behind an allowed path). */
function checkAllowlistedValue(
  segments: readonly string[],
  value: unknown,
  managedFlags: Readonly<Record<string, readonly string[]>> | undefined,
): AllowlistVerdict {
  const [top, a, b, c] = segments
  if (top === 'passes' && b === 'extensions' && value !== 'none') {
    return deny(NARROW_ONLY)
  }
  if (top === 'isolation' && a === 'worktree' && b === 'install' && value === 'auto') {
    return deny('install: "auto" runs installs without asking (escalation)')
  }
  if (top === 'vendors' && a !== undefined && b === 'extraArgs') {
    const args = segments.length === 4 ? [value] : value
    if (!Array.isArray(args) || args.some((x) => typeof x !== 'string')) {
      return deny('extraArgs must be a list of strings')
    }
    const managed = managedFlags?.[a]
    for (const arg of args as string[]) {
      if (ESCALATING_ARG.test(arg)) return deny(`${arg} widens the vendor's permissions (mode escalation)`)
      const name = arg.split('=', 1)[0] ?? arg
      if (managed?.includes(name)) return deny(`${name} is managed by Dim Factory; use flagMap to rename it`)
      // `-pc` is `-p -c` to the CLI's parser; every letter of a combined short flag counts.
      const letter =
        /^-[^-]/.test(arg) && arg.length > 2
          ? [...arg.slice(1)].map((ch) => `-${ch}`).find((l) => managed?.includes(l))
          : undefined
      if (letter !== undefined) {
        return deny(`${arg} combines ${letter} with other short flags; Dim Factory manages ${letter}`)
      }
    }
  }
  if (top === 'vendors' && a !== undefined && b === 'flagMap' && c !== undefined) {
    if (typeof value !== 'string' || !FLAG_VALUE_PATTERN.test(value)) {
      return deny(`flagMap values must look like a flag (e.g. --new-name)`)
    }
    if (ESCALATING_ARG.test(value)) return deny(`${value} widens the vendor's permissions (mode escalation)`)
    const managed = managedFlags?.[a]
    if (managed && !managed.includes(c)) return deny(`${c} is not a flag Dim Factory manages for ${a}`)
  }
  return ALLOW
}

// ---- validation + routing ------------------------------------------------------------------------------------------

export interface RejectedPatchOp {
  op: unknown
  /** `forbidden`: well-formed but outside the allowlist (or an escalation); `invalid`: malformed. */
  kind: 'invalid' | 'forbidden'
  reason: string
}

export interface PatchValidation {
  ok: boolean
  rejected: RejectedPatchOp[]
  /** Accepted ops grouped by the file they persist to (input order kept within each group). */
  routed: Record<ConfigScope, JsonPatchOp[]>
  /** Ops whose requested `project` scope was dropped because the path is user-only. */
  forcedToUser: JsonPatchOp[]
}

export interface ValidatePatchOptions {
  /** The scope the caller asked for. */
  scope: ConfigScope
  /** Enforce the `config_patch` allowlist (recovery `config_patch`, self-heal). Default true; Settings pass false. */
  allowlist?: boolean
  /** Per-vendor `adapter.managedFlags` (re-validates extraArgs and flagMap keys). */
  managedFlags?: Readonly<Record<string, readonly string[]>>
}

/**
 * Check every op: shape, pointer, unsafe segments, the allowlist (unless disabled) and its value rules; then route
 * each accepted op to the user or project file. `ok` is false when any op was rejected (callers refuse the whole
 * patch; nothing is applied partially).
 */
export function validatePatchOps(ops: readonly unknown[], opts: ValidatePatchOptions): PatchValidation {
  const out: PatchValidation = { ok: true, rejected: [], routed: { user: [], project: [] }, forcedToUser: [] }
  const allowlist = opts.allowlist ?? true
  for (const op of ops) {
    const reject = (reason: string, kind: RejectedPatchOp['kind'] = 'invalid'): void => {
      out.rejected.push({ op, kind, reason })
    }
    if (!isJsonPatchOp(op)) {
      reject('Not a JSON Patch operation (add, replace, remove or test with a path)')
      continue
    }
    const segments = parseJsonPointer(op.path)
    if (segments === null) {
      reject(`"${op.path}" is not a JSON pointer`)
      continue
    }
    if (segments.length === 0) {
      reject('A patch cannot replace the whole file')
      continue
    }
    if (segments.some((s) => UNSAFE_SEGMENTS.has(s))) {
      reject('Unsafe path segment')
      continue
    }
    if (allowlist && op.op !== 'test') {
      const verdict = checkAllowlisted(segments)
      if (!verdict.ok) {
        reject(verdict.reason, 'forbidden')
        continue
      }
      // Removing a pass's level would hand it the level of a lower layer, which may be wider.
      if (op.op === 'remove' && segments[0] === 'passes' && segments[2] === 'extensions') {
        reject(NARROW_ONLY, 'forbidden')
        continue
      }
      if (op.op !== 'remove') {
        const valueVerdict = checkAllowlistedValue(segments, op.value, opts.managedFlags)
        if (!valueVerdict.ok) {
          reject(valueVerdict.reason, 'forbidden')
          continue
        }
      }
    }
    if (isUserOnlyPath(segments)) {
      out.routed.user.push(op)
      if (opts.scope === 'project') out.forcedToUser.push(op)
    } else {
      out.routed[opts.scope].push(op)
    }
  }
  out.ok = out.rejected.length === 0
  return out
}
