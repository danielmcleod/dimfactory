// A run's resolved.json (config, provenance, layer hashes, vendors, pricingRef, preflight warnings, the estimate and
// `patches[]`; Re-run loads resolved.json.config through ResolvedConfigZ): the config as the run last ran it (its
// recovery patches applied), and the re-run equality.
import type { ResolvedConfig } from '../shared/config-schema.ts'
import type { JsonPatchOp } from '../shared/failure.ts'
import { ConfigResolveError, resolvedFromFile } from './config/resolve.ts'
import { replayRecoveryPatch } from './recovery/config-patch.ts'
import { isPlainObject } from './store/versions.ts'

/**
 * resolved.json `config` with its `patches[]` applied in order (changes are appended as patches[]). Each
 * entry is `{ops}` (recovery patches) or a bare op list, replayed as it was applied in the run (a vendor entry
 * the config did not list is created first: config-patch.ts replayRecoveryPatch). An entry that no longer applies (a
 * hand-edited file) is left out and reported through `onSkip`; the schema check after this still guards.
 */
export function resolvedConfigWithPatches(
  resolvedJson: Record<string, unknown>,
  onSkip?: (index: number, error: string) => void,
): unknown {
  let cfg: unknown = resolvedJson['config']
  const patches = Array.isArray(resolvedJson['patches']) ? (resolvedJson['patches'] as unknown[]) : []
  patches.forEach((p, index) => {
    const ops = Array.isArray(p) ? p : isPlainObject(p) && Array.isArray(p['ops']) ? p['ops'] : undefined
    if (ops === undefined) {
      onSkip?.(index, 'not a list of operations')
      return
    }
    try {
      cfg = replayRecoveryPatch(cfg, ops as JsonPatchOp[])
    } catch (err) {
      onSkip?.(index, err instanceof Error ? err.message : String(err))
    }
  })
  return cfg
}

/**
 * Chaos: resolved.json with the recovery patches the run accepted (RunState.configPatches, written with the
 * reducer's transition) that its `patches[]` lacks: the reducer accepts a patch before the controller appends it here,
 * so a Dim Factory closed in between leaves the file a patch behind. Entries are matched as written (each carries its
 * own `at`), so patches[] entries a run recorded before RunState kept them (an earlier version) count as they are.
 * The same object when nothing is missing.
 */
export function withAcceptedPatches(
  resolvedJson: Record<string, unknown>,
  accepted: readonly unknown[] | undefined,
): Record<string, unknown> {
  if (accepted === undefined || accepted.length === 0) return resolvedJson
  const recorded = Array.isArray(resolvedJson['patches']) ? (resolvedJson['patches'] as unknown[]) : []
  const have = new Map<string, number>()
  for (const p of recorded) {
    const key = JSON.stringify(p)
    have.set(key, (have.get(key) ?? 0) + 1)
  }
  const missing = accepted.filter((p) => {
    const key = JSON.stringify(p)
    const n = have.get(key) ?? 0
    if (n > 0) have.set(key, n - 1)
    return n === 0
  })
  return missing.length === 0 ? resolvedJson : { ...resolvedJson, patches: [...recorded, ...missing] }
}

export type RerunConfigResult =
  | { ok: true; config: ResolvedConfig }
  | { ok: false; message: string; issues: { pointer: string; message: string }[] }

/**
 * Re-run: the config a re-run starts with, the source's resolved.json `config` with its `patches[]`
 * applied, through ResolvedConfigZ (resolvedFromFile: mode "full" only together with auto: true; the file-only
 * rules are skipped). A tampered or damaged config is refused with its issues; nothing is started.
 */
export function rerunConfig(
  resolvedJson: Record<string, unknown>,
  onSkip?: (index: number, error: string) => void,
): RerunConfigResult {
  try {
    const r = resolvedFromFile(resolvedJson, {
      applyPatches: (config, patches) => resolvedConfigWithPatches({ config, patches: [...patches] }, onSkip),
    })
    return { ok: true, config: r.config }
  } catch (err) {
    if (!(err instanceof ConfigResolveError)) throw err
    const issues = err.issues.map((i) => ({ pointer: i.pointer, message: i.message }))
    const first = issues[0]
    return {
      ok: false,
      message: first !== undefined ? `${first.pointer}: ${first.message}` : err.message,
      issues,
    }
  }
}

/**
 * resolved.json keys that describe one run's start rather than the settings it runs with: the vendors as probed then
 * (route, version, capabilities, failing checks), the catalog prices, the preflight's warnings, the estimate, the
 * recovery patches (folded into `config` for the comparison) and which run it re-runs. The re-run equality ignores
 * them; a re-run records its own.
 */
export const RESOLVED_RUN_FACTS: readonly string[] = [
  'vendors',
  'pricingRef',
  'preflightWarnings',
  'estimate',
  'patches',
  'rerunOf',
]

/**
 * The part of a resolved.json two runs with the same settings share ("Re-run with same config"): every key but
 * RESOLVED_RUN_FACTS, with `config` as the run last ran it (its patches applied). Re-run writes its source's
 * `config` (patched), `provenance`, `layerHashes`, `layers`, `scopeRoot` and `folderKey`, so this is equal for both.
 */
export function comparableResolved(resolvedJson: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(resolvedJson)) {
    if (!RESOLVED_RUN_FACTS.includes(k)) out[k] = v
  }
  out['config'] = resolvedConfigWithPatches(resolvedJson)
  return out
}

/** JSON with object keys sorted (key order never makes two documents differ). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k])
    return out
  }
  return v
}

/** Two resolved.json documents run with the same settings (equal up to RESOLVED_RUN_FACTS). */
export function sameResolvedSettings(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(canonical(comparableResolved(a))) === JSON.stringify(canonical(comparableResolved(b)))
}
