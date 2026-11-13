// The composer's pending run overrides (the config's run layer). The composer holds ONLY the
// user's choices as a RunOverrides object; core resolves them (config.resolve with provenance, preflight.run,
// estimates.get) and runs.start receives them as they are. Pure functions: every change returns a new object,
// empty branches are pruned, and an unchanged result keeps its identity so React effects do not re-run.
import type {
  FixConfig,
  ImplementConfig,
  PassConfig,
  PlanConfig,
  ReviewConfig,
  RunOverrides,
} from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { PassName } from '@shared/run.ts'
import type { DepthSetting } from '@shared/depth.ts'

/** Per-pass keys the composer edits (exactly vendor/model/mode/enabled/promptTemplate; Fix adds two). */
export type PassField = keyof PassConfig
export type FixField = keyof FixConfig
/**
 * A pass row's values: the pass keys, plus Fix's (session, rounds), the Plan pass's Clarify keys (and Explain's), the
 * Implement pass's Deploy keys and the Review pass's acceptance review.
 */
export type PassValues = FixConfig & PlanConfig & ImplementConfig & ReviewConfig

export type GateName = 'afterPlan' | 'beforeFix'

export const NO_OVERRIDES: RunOverrides = {}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Remove empty objects (recursively) and undefined values. */
export function pruneEmpty<T extends object>(o: T): T {
  const out: Obj = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue
    if (isObj(v)) {
      const inner = pruneEmpty(v)
      if (Object.keys(inner).length > 0) out[k] = inner
    } else {
      out[k] = v
    }
  }
  return out as T
}

/** Same content (key order ignored for objects). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]))
  }
  return false
}

/** `next` pruned, or `prev` itself when the content did not change. */
export function settle(prev: RunOverrides, next: RunOverrides): RunOverrides {
  const pruned = pruneEmpty(next)
  return sameValue(prev, pruned) ? prev : pruned
}

export function isEmptyOverrides(o: RunOverrides): boolean {
  return Object.keys(pruneEmpty(o)).length === 0
}

/** Leaves (values that are not objects) of the overrides: what "N run overrides" counts. */
export function countOverrides(o: RunOverrides): number {
  const walk = (v: unknown): number =>
    isObj(v) ? Object.values(v).reduce<number>((n, x) => n + walk(x), 0) : v === undefined ? 0 : 1
  return walk(o)
}

/** The run overrides of one pass row (undefined when the row has none). */
export function passOverride(o: RunOverrides, pass: PassName): PassValues | undefined {
  const row = o.passes?.[pass] as PassValues | undefined
  return row !== undefined && Object.keys(row).length > 0 ? row : undefined
}

/** Set some fields of a pass row and remove others. */
export function setPassValues(
  o: RunOverrides,
  pass: PassName,
  values: PassValues,
  remove: readonly FixField[] = [],
): RunOverrides {
  const row: Obj = { ...(o.passes?.[pass] ?? {}), ...values }
  for (const k of remove) delete row[k]
  const passes: Obj = { ...(o.passes ?? {}), [pass]: row }
  return settle(o, { ...o, passes: passes })
}

/** Drop a pass row's run overrides (Reset). */
export function dropPass(o: RunOverrides, pass: PassName): RunOverrides {
  if (o.passes?.[pass] === undefined) return o
  const passes: Obj = { ...o.passes }
  delete passes[pass]
  return settle(o, { ...o, passes: passes })
}

/** Put a pass row's overrides back exactly as they were (Undo of Reset / Save to project). */
export function restorePass(o: RunOverrides, pass: PassName, row: PassValues | undefined): RunOverrides {
  const without = dropPass(o, pass)
  if (row === undefined) return without
  const passes: Obj = { ...(without.passes ?? {}), [pass]: row }
  return settle(o, { ...without, passes: passes })
}

export function setGate(o: RunOverrides, gate: GateName, value: boolean): RunOverrides {
  return settle(o, { ...o, gates: { ...(o.gates ?? {}), [gate]: value } })
}

export function setProfile(o: RunOverrides, profile: string | null): RunOverrides {
  const next: RunOverrides = { ...o }
  if (profile === null) delete next.profile
  else next.profile = profile
  return settle(o, next)
}

/** `depth` for this run: Auto (no override: the config's, `auto` by default), Quick or Thorough. */
export function setDepth(o: RunOverrides, depth: DepthSetting): RunOverrides {
  const next: RunOverrides = { ...o }
  if (depth === 'auto') delete next.depth
  else next.depth = depth
  return settle(o, next)
}

export function setAuto(o: RunOverrides, auto: boolean): RunOverrides {
  return settle(o, { ...o, auto })
}

export function setIsolationMode(o: RunOverrides, mode: 'inPlace' | 'worktree'): RunOverrides {
  return settle(o, { ...o, isolation: { ...(o.isolation ?? {}), mode } })
}

/** `isolation.branch` for this run, `runBranch` = a new branch before Implement. */
export function setIsolationBranch(o: RunOverrides, branch: 'none' | 'runBranch'): RunOverrides {
  return settle(o, { ...o, isolation: { ...(o.isolation ?? {}), branch } })
}

/** `verify.enabled` for this run (Verify is opt-in). */
export function setVerifyEnabled(o: RunOverrides, enabled: boolean): RunOverrides {
  return settle(o, { ...o, verify: { ...(o.verify ?? {}), enabled } })
}

/** The overrides to send with a request, or undefined when there are none (requests then omit the key). */
export function overridesForRequest(o: RunOverrides): RunOverrides | undefined {
  const pruned = pruneEmpty(o)
  return Object.keys(pruned).length > 0 ? pruned : undefined
}

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** A JSON Pointer's segments (`/passes/review/enabled` → passes, review, enabled); null for '' or a bad pointer. */
function pointerSegments(path: string): string[] | null {
  if (!path.startsWith('/')) return null
  const segs = path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  return segs.some((s) => s === '' || UNSAFE_KEYS.has(s)) ? null : segs
}

/**
 * A composer preflight fix (config_patch `runOverrides`: "Run without Review", "Run
 * without Auto mode"). Core checked the ops against its config-patch allowlist and answered those a run can take
 * (RecoveryResult.overrides); they apply to the pending overrides here (add / replace set a value, remove drops it;
 * `test` and pointers outside an object are ignored). Nothing is written to a file.
 */
export function applyOverrideOps(o: RunOverrides, ops: readonly JsonPatchOp[]): RunOverrides {
  const next = structuredClone(o) as Obj
  for (const op of ops) {
    if (op.op === 'test') continue
    const segs = pointerSegments(op.path)
    if (segs === null) continue
    const last = segs[segs.length - 1] as string
    let parent: Obj | undefined = next
    for (const s of segs.slice(0, -1)) {
      const child: unknown = parent[s]
      if (!isObj(child)) {
        if (op.op === 'remove') {
          parent = undefined
          break
        }
        parent[s] = {}
      }
      parent = parent[s] as Obj
    }
    if (parent === undefined) continue
    if (op.op === 'remove') delete parent[last]
    else parent[last] = op.value
  }
  return settle(o, next)
}
