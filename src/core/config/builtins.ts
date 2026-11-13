// Builtin config (layer 0) and the five built-in profiles, re-exported from defaults.ts, plus the
// original entry point `resolveBuiltinConfig` (layer 0 + the run layer). It has no resolver of its own: it delegates
// to resolve.ts with no user or project layer, which produces the same ResolvedConfig and the same error codes.
import type { RunOverrides } from '../../shared/config-schema.ts'
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import { resolve } from './resolve.ts'

export {
  BUILTIN_DEFAULTS,
  BUILTIN_PROFILES,
  BUILTIN_PROFILE_NAMES,
  BuiltinConfigError,
  DEFAULT_PROFILE,
  INHERITED_KEYS,
  PASS_BASE,
  builtinLayerWith,
  enabledPasses,
  isBuiltinProfile,
} from './defaults.ts'
export type {
  BuiltinConfigErrorCode,
  BuiltinConfigIssue,
  BuiltinLayer,
  BuiltinProfileName,
} from './defaults.ts'

// ---- merge ------------------------------------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function clone<T>(v: T): T {
  return structuredClone(v)
}

/**
 * Config merge: objects (and records) merge per key, arrays replace, `null` is a value, `undefined` is
 * skipped. Never mutates its inputs.
 */
export function deepMerge<T>(base: T, ...layers: readonly unknown[]): T {
  let out: unknown = clone(base)
  for (const layer of layers) out = mergeTwo(out, layer)
  return out as T
}

function mergeTwo(a: unknown, b: unknown): unknown {
  if (b === undefined) return a
  if (!isPlainObject(a) || !isPlainObject(b)) return clone(b)
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue
    out[k] = mergeTwo(out[k], v)
  }
  return out
}

/** Combine run-layer overrides; later layers win (e.g. `mergeOverrides(projectSets, cliSets)`). */
export function mergeOverrides(...layers: readonly (RunOverrides | undefined)[]): RunOverrides {
  return deepMerge<RunOverrides>({}, ...layers)
}

/**
 * The first build ran only Plan → gate → Implement (Review, Critic and Fix disabled). Retired since: no producer
 * applies it any more (every built-in profile runs all five passes; verify stays off). Kept for tests of that
 * tail.
 */
export function planImplementOverrides(): RunOverrides {
  return { passes: { review: { enabled: false }, critic: { enabled: false }, fix: { enabled: false } } }
}

// ---- resolve (the original entry point) -------------------------------------------------------------------------

export interface ResolveBuiltinOptions {
  /** `--profile`; wins over `overrides.profile`. Default `balanced`. */
  profile?: string
  /** The run layer (composer / CLI `--set`), validated with RunOverridesZ. */
  overrides?: unknown
  /** Run folder, for the project prompt layer. */
  folder?: string
  /** DIM_FACTORY_HOME, for the user prompt layer. */
  home?: string
  /** Test seam for the builtin prompt directory. */
  builtinDir?: string
}

/**
 * Layer 0 + run overrides → ResolvedConfig (Resolve steps 1–6, without user/project layers): `resolve()`
 * with only the run layer. Throws BuiltinConfigError (a ConfigResolveError; category `config_invalid`).
 */
export function resolveBuiltinConfig(o: ResolveBuiltinOptions = {}): ResolvedConfig {
  return resolve({
    run: o.overrides ?? {},
    ...(o.profile !== undefined ? { profile: o.profile } : {}),
    ...(o.folder !== undefined ? { folder: o.folder } : {}),
    ...(o.home !== undefined ? { home: o.home } : {}),
    ...(o.builtinDir !== undefined ? { builtinDir: o.builtinDir } : {}),
  }).config
}
