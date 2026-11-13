// `vendors.models` (the quick composer's model field: CLI list + catalog + free text, with a 'no pricing' chip):
// the models the CLI reported in its token-free probe (Claude: the initialize handshake), then the
// catalog's models.json and pricing.json entries for the vendor that the CLI did not list. Each option says whether
// a price is known (`hasPricing`); the CLI's default is marked (`isDefault`), else the catalog's.
import type { ModelInfo, ModelOption } from '../../shared/vendors.ts'
import type { CatalogData } from '../catalog/store.ts'
import { lookupPrice, normalizeModelId } from '../catalog/store.ts'

/** Ids an option answers to (its id and aliases), normalized the way the catalog compares them. */
const keysOf = (m: { id: string; aliases?: readonly string[] }): string[] =>
  [m.id, ...(m.aliases ?? [])].map(normalizeModelId).filter((k) => k !== '')

export function mergeModelOptions(
  vendor: string,
  cli: readonly ModelInfo[],
  catalog: CatalogData | undefined,
): ModelOption[] {
  const priced = (m: { id: string; aliases?: readonly string[] }): boolean =>
    catalog !== undefined &&
    [m.id, ...(m.aliases ?? [])].some((id) => lookupPrice(catalog, vendor, id) !== null)
  const listed = catalog?.models.vendors[vendor]?.models ?? []
  const deprecated = new Set(listed.filter((m) => m.deprecated === true).flatMap(keysOf))
  // A price entry a refresh marked deprecated flags the model too (by its id only: an alias may have moved on).
  for (const e of catalog?.pricing.entries ?? []) {
    if (e.vendor === vendor && e.deprecated === true) deprecated.add(normalizeModelId(e.model))
  }

  const out: ModelOption[] = []
  const seen = new Set<string>()
  const ids = new Set<string>()
  // Every CLI entry is kept once per id (`default` and `opus` may resolve to the same model); a catalog entry is
  // added only when no listed option answers to its id or one of its aliases.
  for (const m of cli) {
    const id = normalizeModelId(m.id)
    if (ids.has(id)) continue
    ids.add(id)
    for (const k of keysOf(m)) seen.add(k)
    const o: ModelOption = { ...m, hasPricing: priced(m) }
    if (keysOf(m).some((k) => deprecated.has(k))) o.deprecated = true
    out.push(o)
  }
  const add = (o: ModelOption): void => {
    const keys = keysOf(o)
    if (keys.some((k) => seen.has(k))) return
    for (const k of keys) seen.add(k)
    out.push(o)
  }
  const fromCatalog: ModelOption[] = []
  for (const m of listed) {
    if (m.hidden === true) continue
    const o: ModelOption = { id: m.id, source: 'catalog', hasPricing: false }
    if (m.displayName !== undefined) o.label = m.displayName
    if (m.aliases !== undefined && m.aliases.length > 0) o.aliases = [...m.aliases]
    if (m.isDefault === true) o.isDefault = true
    if (m.contextWindow !== undefined) o.contextWindow = m.contextWindow
    if (m.reasoningEfforts !== undefined && m.reasoningEfforts.length > 0) o.efforts = [...m.reasoningEfforts]
    if (m.deprecated === true) o.deprecated = true
    o.hasPricing = priced(o)
    fromCatalog.push(o)
  }
  for (const e of catalog?.pricing.entries ?? []) {
    if (e.vendor !== vendor) continue
    const o: ModelOption = { id: e.model, source: 'catalog', hasPricing: true }
    // A deprecated price keeps its own id only (its aliases now name newer models) and is flagged.
    if (e.deprecated === true) o.deprecated = true
    else if (e.aliases.length > 0) o.aliases = [...e.aliases]
    fromCatalog.push(o)
  }
  fromCatalog.sort((a, b) => a.id.localeCompare(b.id))
  for (const o of fromCatalog) add(o)
  // One default: the CLI's when it reports one, else the catalog's.
  const cliDefault = out.find((o) => o.source !== 'catalog' && o.isDefault === true)
  if (cliDefault !== undefined) {
    for (const o of out) if (o !== cliDefault && o.isDefault === true) delete o.isDefault
  }
  return out
}
