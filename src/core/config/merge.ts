// Layer merge (Resolve step 1): objects merge, arrays replace, `null` is a value, a missing
// (`undefined`) key inherits, and records (`profiles`, `vendors`, `env`, `flagMap`) merge per key like objects.
// The same semantics as `deepMerge` in builtins.ts (the original producer); this module is where the resolver uses it.

/** A JSON object (not an array, not null). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Merge `layers` over `base`, left to right. Never mutates its inputs; the result shares no structure with them. */
export function deepMerge<T>(base: T, ...layers: readonly unknown[]): T {
  let out: unknown = structuredClone(base)
  for (const layer of layers) out = mergeTwo(out, layer)
  return out as T
}

function mergeTwo(a: unknown, b: unknown): unknown {
  if (b === undefined) return a
  if (!isPlainObject(a) || !isPlainObject(b)) return structuredClone(b)
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue
    out[k] = mergeTwo(out[k], v)
  }
  return out
}

/** A copy of `obj` without `keys` (top level only). */
export function omitKeys<T extends object, K extends string>(obj: T, keys: readonly K[]): Omit<T, K> {
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) }
  for (const k of keys) delete out[k]
  return out as Omit<T, K>
}

/**
 * Every leaf of `value` as `[segments, leaf]`: scalars, `null`, arrays (arrays replace, so they are leaves) and empty
 * objects. `undefined` members are skipped.
 */
export function leaves(value: unknown, prefix: readonly string[] = []): [string[], unknown][] {
  if (!isPlainObject(value)) return value === undefined ? [] : [[[...prefix], value]]
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return [[[...prefix], value]]
  return entries.flatMap(([k, v]) => leaves(v, [...prefix, k]))
}
