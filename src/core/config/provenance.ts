// Provenance: JSON pointer into ResolvedConfig → where the value came from
// ({source, file?, line?, via?}). Drives the composer badges ("default", "user", "project", "recipe", "run", amber "auto",
// "= implement", "CLI default") and the "open the file at this line" links.
import type { Provenance, ProvenanceMap, ProvenanceSource } from '../../shared/config-schema.ts'
import { PROVENANCE_SOURCES, toJsonPointer } from '../../shared/config-schema.ts'
import { isPlainObject, leaves } from './merge.ts'

export { toJsonPointer }

/** The layer a value was read from. `lines` maps a JSON pointer INTO THE FILE to the 1-based line of its key. */
export interface LayerOrigin {
  source: Extract<ProvenanceSource, 'default' | 'user' | 'project' | 'recipe' | 'run'>
  file?: string
  lines?: Readonly<Record<string, number>>
}

/** RFC 6901 decode (`~1` → `/`, `~0` → `~`). `''` is the root (no segments). */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new Error(`not a JSON pointer: ${JSON.stringify(pointer)}`)
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/** The pointer itself, then each ancestor up to the root. */
export function pointerAncestry(pointer: string): string[] {
  const segs = parseJsonPointer(pointer)
  const out: string[] = []
  for (let n = segs.length; n >= 0; n--) out.push(toJsonPointer(segs.slice(0, n)))
  return out
}

/** Provenance for a value read from `origin` at `filePointer` (a pointer into that layer's file). */
export function provenanceFrom(origin: LayerOrigin, filePointer: string, via?: string): Provenance {
  const line = origin.lines?.[filePointer]
  return {
    source: origin.source,
    ...(origin.file !== undefined ? { file: origin.file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(via !== undefined ? { via } : {}),
  }
}

/** Exact entry, else the nearest ancestor's (a whole array or empty record is recorded once at its own pointer). */
export function provenanceAt(map: ProvenanceMap, pointer: string): Provenance | undefined {
  for (const p of pointerAncestry(pointer)) {
    const hit = map[p]
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Builds a ProvenanceMap; later writes to a pointer win, like the layers they describe. */
export class ProvenanceRecorder {
  readonly #map = new Map<string, Provenance>()

  set(pointer: string, p: Provenance): void {
    // A leaf replaces whatever was recorded below it (e.g. an array that replaced a longer one).
    for (const k of [...this.#map.keys()]) if (k.startsWith(`${pointer}/`)) this.#map.delete(k)
    this.#map.set(pointer, p)
  }

  get(pointer: string): Provenance | undefined {
    return this.#map.get(pointer)
  }

  /**
   * Record every leaf of `value` (placed at `prefix` in the resolved config). `prov` gets the leaf's segments so a
   * file layer can look up the line of the matching file pointer.
   */
  setLeaves(value: unknown, prefix: readonly string[], prov: (segments: string[]) => Provenance): void {
    for (const [segs, leaf] of leaves(value, prefix)) {
      const pointer = toJsonPointer(segs)
      // An empty object merges over (never clears) what lower layers set, so it only fills a gap.
      if (isPlainObject(leaf) && this.#hasAtOrBelow(pointer)) continue
      this.set(pointer, prov(segs))
    }
  }

  #hasAtOrBelow(pointer: string): boolean {
    for (const k of this.#map.keys()) if (k === pointer || k.startsWith(`${pointer}/`)) return true
    return false
  }

  /** Record `p` only when nothing is recorded at or below `pointer` (e.g. vendor fields filled with defaults). */
  setIfAbsent(pointer: string, p: Provenance): void {
    if (this.#hasAtOrBelow(pointer)) return
    this.#map.set(pointer, p)
  }

  /** Sorted by pointer, so equal configs give byte-equal maps. */
  toMap(): ProvenanceMap {
    const out: ProvenanceMap = {}
    for (const k of [...this.#map.keys()].sort()) {
      const v = this.#map.get(k)
      if (v !== undefined) out[k] = v
    }
    return out
  }
}

/** Composer badge text (the badge for each provenance source). */
export function provenanceBadge(p: Provenance | undefined): string {
  switch (p?.source) {
    case undefined:
    case 'default':
      return 'default'
    case 'user':
    case 'project':
    case 'recipe':
    case 'run':
      return p.source
    case 'auto':
      return 'auto'
    case 'inherit':
      return '= implement'
    case 'vendor':
      return 'vendor default'
    case 'cli':
      return 'CLI default'
  }
}

/** One line for logs and the CLI, e.g. `user (C:\…\dimfactory.json:12, profile:balanced)`. */
export function describeProvenance(p: Provenance | undefined): string {
  if (p === undefined) return 'default'
  const where = p.file !== undefined ? `${p.file}${p.line !== undefined ? `:${p.line}` : ''}` : undefined
  const extra = [where, p.via].filter((x): x is string => x !== undefined)
  return extra.length > 0 ? `${p.source} (${extra.join(', ')})` : p.source
}

/** Loose reader for a stored map (resolved.json): keeps only well-formed entries. */
export function parseProvenanceMap(v: unknown): ProvenanceMap {
  const out: ProvenanceMap = {}
  if (!isPlainObject(v)) return out
  for (const [k, e] of Object.entries(v)) {
    if (k !== '' && !k.startsWith('/')) continue
    if (!isPlainObject(e)) continue
    const source = e['source']
    if (typeof source !== 'string' || !(PROVENANCE_SOURCES as readonly string[]).includes(source)) continue
    const p: Provenance = { source: source as ProvenanceSource }
    if (typeof e['file'] === 'string') p.file = e['file']
    if (typeof e['line'] === 'number' && Number.isInteger(e['line']) && e['line'] > 0) p.line = e['line']
    if (typeof e['via'] === 'string') p.via = e['via']
    out[k] = p
  }
  return out
}
