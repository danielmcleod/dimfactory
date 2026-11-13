// The diff review and what applying it does (refresh Apply; manual edits set confidence:'user'; Settings →
// Catalog). Pure: apply.ts writes the result with its history backup.
//
// Applying ticked rows (recomputed from the job's proposal against the catalog as it is now; a ticked id that no
// longer exists is CONFLICT, nothing is written). Only ticked rows change anything: an entry without a
// ticked row stays byte for byte as it was, and an apply with no ticked row writes nothing.
//   - price rows set their field on the stored entry (source, quote and fetchedAt follow the proposal; the answer's
//     aliases are never stored). The entry is `verified` only when every price now equals an official page the job
//     read, quoted; otherwise `unverified`, or still `user` when the user's own prices were only partly replaced.
//     A model with no price yet is added only with both its input and output rows ticked (no aliases: the CLI's model
//     list maps those).
//   - confirm rows re-stamp an entry the official page repeats unchanged: its source, quote, today's fetchedAt and
//     `verified` (the prices do not change).
//   - new-model rows add the model to models.json (source `ai-refresh`); deprecate rows set `deprecated:true` on the
//     price entry (and the models.json model of that id). Nothing is ever deleted.
import { PRICE_FIELDS } from '../../shared/catalog.ts'
import type {
  CatalogDiff,
  CatalogModel,
  ModelsFile,
  PriceEdit,
  PriceEntry,
  PriceField,
  PricingFile,
} from '../../shared/catalog.ts'
import { ModelIdZ, VendorIdZ } from '../../shared/config-schema.ts'
import type { VendorId } from '../../shared/vendors.ts'
import { DimFactoryError } from '../errors.ts'
import { PriceEntryZ, normalizeModelId } from './store.ts'
import type { CatalogData } from './store.ts'
import { checkProposal, isUsableSourceUrl, priceEditProblem } from './validate.ts'
import type { CatalogCurrent, CheckedPrice, ValidateContext, ValidatedProposal } from './validate.ts'

const ALIASES_MAX = 32

export interface CatalogDiffMeta {
  jobId: string
  /** Epoch ms the diff was made. */
  generatedAt: number
  vendor: VendorId
  model: string | null
}

/** The diff review of a proposal against the current catalog (rows, rejected values, unverifiable models). */
export function buildCatalogDiff(
  meta: CatalogDiffMeta,
  current: CatalogCurrent,
  proposal: unknown,
  ctx: ValidateContext = {},
): CatalogDiff {
  const v = checkProposal(current, proposal, ctx)
  return { ...meta, rows: v.rows, rejected: v.rejected, unverifiable: v.unverifiable }
}

export interface RowsApplied {
  next: CatalogData
  /** Distinct vendor/model pairs whose price or model entry changed (ticked confirmations included). */
  entries: number
  /** Entries re-stamped by ticked confirm rows. */
  confirmed: number
  /** Something differs from `current` (a write is needed). */
  changed: boolean
  /** The models that were not in the catalog before: a model row added, or a first price entry. */
  added: { vendor: string; model: string }[]
}

const keyOf = (vendor: string, model: string): string => `${vendor}/${normalizeModelId(model)}`

const same = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

function setPrice(e: PriceEntry, f: PriceField, v: number | null): void {
  if (f === 'inputPerMTok' || f === 'outputPerMTok') {
    if (v !== null) e[f] = v
  } else e[f] = v
}

function mergeAliases(existing: readonly string[], extra: readonly string[], model: string): string[] {
  const out = [...existing]
  const seen = new Set([normalizeModelId(model), ...existing.map(normalizeModelId)])
  for (const a of extra) {
    const k = normalizeModelId(a)
    if (seen.has(k) || out.length >= ALIASES_MAX) continue
    seen.add(k)
    out.push(a)
  }
  return out
}

function stamp(e: PriceEntry, p: Pick<CheckedPrice, 'sourceUrl' | 'sourceQuote'>, now: number): void {
  e.sourceUrl = p.sourceUrl
  if (p.sourceQuote !== '') e.sourceQuote = p.sourceQuote
  else delete e.sourceQuote
  e.fetchedAt = now
}

function staleReview(missing: string[]): DimFactoryError {
  const n = missing.length
  return new DimFactoryError(
    'CONFLICT',
    `${n === 1 ? 'One ticked row no longer matches' : `${n} ticked rows no longer match`} the current prices. Close this review and open it again.`,
    { details: { missing } },
  )
}

function checked(entries: readonly PriceEntry[]): void {
  for (const e of entries) {
    const r = PriceEntryZ.safeParse(e)
    if (!r.success) {
      throw new DimFactoryError(
        'INTERNAL',
        `The updated price of ${e.vendor}/${e.model} failed its own check.`,
      )
    }
  }
}

/**
 * The catalog after applying the ticked `rowIds` of a validated proposal (see the header). Throws CONFLICT for a row
 * id the proposal no longer yields, VALIDATION for a new model ticked without both its input and output prices.
 */
export function applySelectedRows(
  current: CatalogData,
  v: ValidatedProposal,
  rowIds: readonly string[],
  now: number,
): RowsApplied {
  const byId = new Map(v.rows.map((r) => [r.id, r]))
  const wanted = [...new Set(rowIds)]
  const missing = wanted.filter((id) => !byId.has(id))
  if (missing.length > 0) throw staleReview(missing)

  const pricing: PricingFile = structuredClone(current.pricing)
  const models: ModelsFile = structuredClone(current.models)
  const touched = new Set<string>()
  const added = new Map<string, { vendor: string; model: string }>()
  let pricingChanged = false
  let modelsChanged = false
  const stored = (vendor: string, model: string): PriceEntry | undefined =>
    pricing.entries.find((e) => e.vendor === vendor && e.model === model)

  // Price rows, grouped by the entry they change.
  const groups = new Map<string, { p: CheckedPrice; cur: PriceEntry | undefined; fields: Set<PriceField> }>()
  for (const id of wanted) {
    const row = byId.get(id)
    const src = v.sources.get(id)
    if (row?.kind !== 'price' || row.field === undefined || src === undefined) continue
    const k = keyOf(row.vendor, row.model)
    const g = groups.get(k) ?? { p: src.entry, cur: src.current, fields: new Set<PriceField>() }
    g.fields.add(row.field)
    groups.set(k, g)
  }
  for (const { p, cur, fields } of groups.values()) {
    if (cur === undefined) {
      if (!fields.has('inputPerMTok') || !fields.has('outputPerMTok')) {
        throw new DimFactoryError(
          'VALIDATION',
          `Tick both the input and output price of ${p.model} to add it.`,
        )
      }
      const e: PriceEntry = {
        vendor: p.vendor,
        model: p.model,
        aliases: [],
        inputPerMTok: p.inputPerMTok,
        outputPerMTok: p.outputPerMTok,
        cacheReadPerMTok: fields.has('cacheReadPerMTok') ? p.cacheReadPerMTok : null,
        cacheWritePerMTok: fields.has('cacheWritePerMTok') ? p.cacheWritePerMTok : null,
        sourceUrl: p.sourceUrl,
        fetchedAt: now,
        confidence: 'unverified',
      }
      stamp(e, p, now)
      const full = PRICE_FIELDS.every((f) => same(e[f], p[f]))
      e.confidence = full && p.verified ? 'verified' : 'unverified'
      pricing.entries.push(e)
      touched.add(keyOf(e.vendor, e.model))
      added.set(keyOf(e.vendor, e.model), { vendor: e.vendor, model: e.model })
      pricingChanged = true
      continue
    }
    const e = stored(cur.vendor, cur.model)
    if (e === undefined) continue
    for (const f of fields) setPrice(e, f, p[f])
    stamp(e, p, now)
    const full = PRICE_FIELDS.every((f) => same(e[f], p[f]))
    e.confidence = full
      ? p.verified
        ? 'verified'
        : 'unverified'
      : cur.confidence === 'user'
        ? 'user'
        : 'unverified'
    touched.add(keyOf(e.vendor, e.model))
    pricingChanged = true
  }

  let confirmed = 0
  for (const id of wanted) {
    const row = byId.get(id)
    if (row === undefined) continue
    if (row.kind === 'confirm') {
      const c = v.confirmations.get(id)
      const e = c !== undefined ? stored(c.current.vendor, c.current.model) : undefined
      if (c === undefined || e === undefined) continue
      stamp(e, c.entry, now)
      e.confidence = 'verified'
      touched.add(keyOf(e.vendor, e.model))
      confirmed++
      pricingChanged = true
    } else if (row.kind === 'new-model') {
      const m = v.models.get(id)
      if (m === undefined) continue
      const block = (models.vendors[m.vendor] ??= { source: 'ai-refresh', fetchedAt: now, models: [] })
      if (block.models.some((x) => normalizeModelId(x.id) === normalizeModelId(m.id))) continue
      const model: CatalogModel = { id: m.id, source: 'ai-refresh', fetchedAt: now }
      if (m.displayName !== undefined) model.displayName = m.displayName
      if (m.contextWindow !== undefined) model.contextWindow = m.contextWindow
      block.models.push(model)
      touched.add(keyOf(m.vendor, m.id))
      added.set(keyOf(m.vendor, m.id), { vendor: m.vendor, model: m.id })
      modelsChanged = true
    } else if (row.kind === 'deprecate') {
      const target = v.deprecations.get(id)
      const e = target !== undefined ? stored(target.vendor, target.model) : undefined
      if (e === undefined) continue
      e.deprecated = true
      pricingChanged = true
      touched.add(keyOf(e.vendor, e.model))
      for (const m of models.vendors[e.vendor]?.models ?? []) {
        if (normalizeModelId(m.id) !== normalizeModelId(e.model) || m.deprecated === true) continue
        m.deprecated = true
        modelsChanged = true
      }
    }
  }

  if (pricingChanged) {
    pricing.updatedAt = now
    checked(pricing.entries)
  }
  if (modelsChanged) models.updatedAt = now
  return {
    next: { pricing, models },
    entries: touched.size,
    confirmed,
    changed: pricingChanged || modelsChanged,
    added: [...added.values()],
  }
}

// ---- manual edits ---------------------------------------------------------------------------------------------------

const ModelStringZ = ModelIdZ.unwrap()

export interface PriceEditApplied {
  pricing: PricingFile
  entry: PriceEntry
  changed: boolean
}

/**
 * A manual price from Settings → Catalog: same bounds as a refresh, stored with `confidence:'user'` (the quote is
 * dropped: it no longer backs the numbers). Edits the entry whose id (else alias) is `edit.model`, or adds one.
 */
export function applyPriceEdit(pricing: PricingFile, edit: PriceEdit, now: number): PriceEditApplied {
  if (!VendorIdZ.safeParse(edit.vendor).success)
    throw new DimFactoryError('VALIDATION', 'vendor is not a vendor id')
  if (!ModelStringZ.safeParse(edit.model).success) {
    throw new DimFactoryError('VALIDATION', 'The model id may use letters, digits and . : @ / [ ] - only.')
  }
  const problem = priceEditProblem(edit)
  if (problem !== null) throw new DimFactoryError('VALIDATION', problem)
  if (edit.aliases !== undefined) {
    if (edit.aliases.length > ALIASES_MAX || edit.aliases.some((a) => !ModelStringZ.safeParse(a).success)) {
      throw new DimFactoryError('VALIDATION', 'Each alias must be a model id (at most 32 aliases).')
    }
  }
  if (edit.sourceUrl !== undefined && edit.sourceUrl !== '' && !isUsableSourceUrl(edit.sourceUrl)) {
    throw new DimFactoryError('VALIDATION', 'The source must be a web page address (https://…).')
  }

  const next = structuredClone(pricing)
  const key = normalizeModelId(edit.model)
  const list = next.entries.filter((e) => e.vendor === edit.vendor)
  const existing =
    list.find((e) => normalizeModelId(e.model) === key) ??
    list.find((e) => e.aliases.some((a) => normalizeModelId(a) === key))
  const prices = {
    inputPerMTok: edit.inputPerMTok,
    outputPerMTok: edit.outputPerMTok,
    cacheReadPerMTok: edit.cacheReadPerMTok,
    cacheWritePerMTok: edit.cacheWritePerMTok,
  }
  let entry: PriceEntry
  let changed: boolean
  if (existing !== undefined) {
    const aliases =
      edit.aliases !== undefined ? mergeAliases([], edit.aliases, existing.model) : existing.aliases
    const sourceUrl = edit.sourceUrl ?? existing.sourceUrl
    changed =
      existing.confidence !== 'user' ||
      PRICE_FIELDS.some((f) => !same(existing[f], prices[f])) ||
      sourceUrl !== existing.sourceUrl ||
      aliases.join('\n') !== existing.aliases.join('\n')
    Object.assign(existing, prices, { aliases, sourceUrl, fetchedAt: changed ? now : existing.fetchedAt })
    if (changed) {
      existing.confidence = 'user'
      delete existing.sourceQuote
    }
    entry = existing
  } else {
    entry = {
      vendor: edit.vendor,
      model: edit.model,
      aliases: mergeAliases([], edit.aliases ?? [], edit.model),
      ...prices,
      sourceUrl: edit.sourceUrl ?? '',
      fetchedAt: now,
      confidence: 'user',
    }
    next.entries.push(entry)
    changed = true
  }
  if (changed) next.updatedAt = now
  checked([entry])
  return { pricing: next, entry, changed }
}
