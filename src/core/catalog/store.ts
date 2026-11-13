// Model and pricing catalog store (catalog/*.json); live.ts adds refresh/apply/undo on top.
// DIM_FACTORY_HOME/catalog/pricing.json is created on first read from the built-in seed (seed/pricing.seed.json, all
// `unverified`); catalog/models.json is created empty. A file that cannot be read never blocks a run: the seed (or
// an empty model list) is used in memory, the file on disk is left alone, and a warning says why.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { MODEL_SOURCES, PRICE_CONFIDENCES } from '../../shared/catalog.ts'
import type {
  CatalogModel,
  CatalogVendorModels,
  ModelsFile,
  PriceEntry,
  PricingConfidenceSummary,
  PricingFile,
} from '../../shared/catalog.ts'
import { ModelIdZ, VendorIdZ } from '../../shared/config-schema.ts'
import type { VendorId } from '../../shared/vendors.ts'
import { DimFactoryError, errorMessage } from '../errors.ts'
import type { HomePaths } from '../home.ts'
import { writeJsonAtomic } from '../store/atomic.ts'
import { CURRENT_SCHEMA_VERSION, readVersionedJson, withSchemaVersion } from '../store/versions.ts'
import { isPricingStale } from './cost.ts'

/** The built-in seed, read from disk next to this module (like the builtin prompt texts). */
export const SEED_PRICING_PATH = fileURLToPath(new URL('./seed/pricing.seed.json', import.meta.url))

export type CatalogPaths = Pick<HomePaths, 'catalogDir' | 'catalogModels' | 'catalogPricing'>

// ---- schemas ----------------------------------------------------------------------------------------------------

const ModelStringZ = ModelIdZ.unwrap()
/** USD per 1M tokens. 0 is allowed (local models); the refresh validator applies the stricter ≤ 0 rejection. */
const PriceZ = z.number().min(0).max(1000)
const EpochMsZ = z.number().int().min(0)

const priceEntryShape = {
  vendor: VendorIdZ,
  model: ModelStringZ,
  aliases: z.array(ModelStringZ).max(32),
  inputPerMTok: PriceZ,
  outputPerMTok: PriceZ,
  cacheReadPerMTok: PriceZ.nullable(),
  cacheWritePerMTok: PriceZ.nullable(),
  /** May be empty for a manual (`user`) entry. */
  sourceUrl: z.string().max(2048),
  sourceQuote: z.string().max(200).exactOptional(),
  fetchedAt: EpochMsZ,
  confidence: z.enum(PRICE_CONFIDENCES),
  deprecated: z.boolean().exactOptional(),
}

/** One stored price. Unknown keys are dropped on read (a newer Dim Factory may add fields). */
export const PriceEntryZ = z.object(priceEntryShape) satisfies z.ZodType<PriceEntry>
/** Same fields, unknown keys rejected: used for the built-in seed so a typo'd key fails the build's tests. */
export const PriceEntryStrictZ = z.strictObject(priceEntryShape) satisfies z.ZodType<PriceEntry>

export const PricingFileStrictZ = z.strictObject({
  schemaVersion: z.literal(1),
  updatedAt: EpochMsZ,
  entries: z.array(PriceEntryStrictZ).max(2000),
}) satisfies z.ZodType<PricingFile>

const PricingEnvelopeZ = z.object({
  schemaVersion: z.number().int().min(1),
  updatedAt: EpochMsZ,
  entries: z.array(z.unknown()).max(2000),
})

export const CatalogModelZ = z.object({
  id: ModelStringZ,
  displayName: z.string().max(200).exactOptional(),
  aliases: z.array(ModelStringZ).max(32).exactOptional(),
  isDefault: z.boolean().exactOptional(),
  hidden: z.boolean().exactOptional(),
  contextWindow: z.number().int().positive().exactOptional(),
  maxOutput: z.number().int().positive().exactOptional(),
  reasoningEfforts: z.array(z.string().max(32)).max(16).exactOptional(),
  deprecated: z.boolean().exactOptional(),
  source: z.enum(MODEL_SOURCES),
  fetchedAt: EpochMsZ,
}) satisfies z.ZodType<CatalogModel>

export const CatalogVendorModelsZ = z.object({
  source: z.enum(MODEL_SOURCES),
  fetchedAt: EpochMsZ,
  cliVersion: z.string().max(64).exactOptional(),
  models: z.array(CatalogModelZ).max(1000),
}) satisfies z.ZodType<CatalogVendorModels>

const ModelsEnvelopeZ = z.object({
  schemaVersion: z.number().int().min(1),
  updatedAt: EpochMsZ,
  vendors: z.record(z.string(), z.unknown()),
})

function issueText(err: z.ZodError): string {
  const first = err.issues[0]
  if (first === undefined) return 'invalid'
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : ''
  return `${path}${first.message}`
}

// ---- seed -------------------------------------------------------------------------------------------------------

const seedCache = new Map<string, Promise<PricingFile>>()

async function readSeed(path: string): Promise<PricingFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new DimFactoryError('INTERNAL', `the built-in pricing seed cannot be read: ${errorMessage(err)}`, {
      cause: err,
      details: { path },
    })
  }
  const r = PricingFileStrictZ.safeParse(parsed)
  if (!r.success) {
    throw new DimFactoryError('INTERNAL', `the built-in pricing seed is invalid: ${issueText(r.error)}`, {
      details: { path },
    })
  }
  return r.data
}

/** The validated built-in seed (cached per path; a fresh copy each call). Throws INTERNAL when it is broken. */
export async function loadSeedPricing(path: string = SEED_PRICING_PATH): Promise<PricingFile> {
  let p = seedCache.get(path)
  if (p === undefined) {
    p = readSeed(path)
    seedCache.set(path, p)
    void p.catch(() => seedCache.delete(path))
  }
  return structuredClone(await p)
}

export function emptyModelsFile(now: number): ModelsFile {
  return { schemaVersion: 1, updatedAt: now, vendors: {} }
}

// ---- read -------------------------------------------------------------------------------------------------------

export interface CatalogData {
  models: ModelsFile
  pricing: PricingFile
}

export interface CatalogReadResult extends CatalogData {
  /** The file was created during this read (pricing from the seed, models empty). */
  seeded: { pricing: boolean; models: boolean }
  /** The file was written by a newer Dim Factory (schemaVersion > 1): shown, never saved. */
  readOnly: { pricing: boolean; models: boolean }
  /** Data came from the built-in seed / an empty list because the file was missing and could not be created, or
   * was unreadable. The file on disk was not touched. */
  fallback: { pricing: boolean; models: boolean }
  /** Human-readable, non-fatal problems (corrupt file, skipped entries, failed seed copy). */
  warnings: string[]
}

export interface ReadCatalogOptions {
  now?: () => number
  /** Override the seed (tests). */
  seedPath?: string
}

function parsePricingDoc(doc: Record<string, unknown>, warnings: string[]): PricingFile {
  const env = PricingEnvelopeZ.parse(doc)
  const entries: PriceEntry[] = []
  const seen = new Set<string>()
  env.entries.forEach((raw, i) => {
    const r = PriceEntryZ.safeParse(raw)
    if (!r.success) {
      warnings.push(`pricing.json entry #${i + 1} ignored (${issueText(r.error)})`)
      return
    }
    const key = `${r.data.vendor}\u0000${normalizeModelId(r.data.model)}`
    if (seen.has(key)) {
      warnings.push(`pricing.json entry #${i + 1} ignored (duplicate ${r.data.vendor}/${r.data.model})`)
      return
    }
    seen.add(key)
    entries.push(r.data)
  })
  return { schemaVersion: 1, updatedAt: env.updatedAt, entries }
}

function parseModelsDoc(doc: Record<string, unknown>, warnings: string[]): ModelsFile {
  const env = ModelsEnvelopeZ.parse(doc)
  const vendors: Record<VendorId, CatalogVendorModels> = {}
  for (const [vendor, raw] of Object.entries(env.vendors)) {
    if (!VendorIdZ.safeParse(vendor).success) {
      warnings.push(`models.json vendor ${JSON.stringify(vendor)} ignored (invalid vendor id)`)
      continue
    }
    const r = CatalogVendorModelsZ.safeParse(raw)
    if (!r.success) {
      warnings.push(`models.json vendor ${vendor} ignored (${issueText(r.error)})`)
      continue
    }
    vendors[vendor] = r.data
  }
  return { schemaVersion: 1, updatedAt: env.updatedAt, vendors }
}

async function createFile(file: string, value: object, warnings: string[], what: string): Promise<boolean> {
  try {
    await writeJsonAtomic(file, withSchemaVersion(value, CURRENT_SCHEMA_VERSION))
    return true
  } catch (err) {
    warnings.push(`${what} could not be created (${errorMessage(err)}); using it in memory`)
    return false
  }
}

/**
 * Read catalog/{pricing,models}.json, creating missing files (pricing.json = a copy of the seed; models.json =
 * empty). Never throws for a missing, corrupt or partly invalid file; throws INTERNAL only if the seed is broken.
 */
export async function readCatalog(
  paths: CatalogPaths,
  opts: ReadCatalogOptions = {},
): Promise<CatalogReadResult> {
  const now = opts.now ?? Date.now
  const warnings: string[] = []
  const seeded = { pricing: false, models: false }
  const readOnly = { pricing: false, models: false }
  const fallback = { pricing: false, models: false }

  let pricing: PricingFile
  const pr = await readVersionedJson<PricingFile>(paths.catalogPricing, {
    validate: (doc) => parsePricingDoc(doc, warnings),
  })
  if (pr.kind === 'ok') {
    pricing = pr.value
    readOnly.pricing = pr.readOnly
  } else {
    pricing = await loadSeedPricing(opts.seedPath)
    if (pr.kind === 'missing') {
      seeded.pricing = await createFile(paths.catalogPricing, pricing, warnings, 'pricing.json')
      fallback.pricing = !seeded.pricing
    } else {
      fallback.pricing = true
      warnings.push(`pricing.json is unreadable (${pr.error}); using the built-in prices until it is fixed`)
    }
  }

  let models: ModelsFile
  const mr = await readVersionedJson<ModelsFile>(paths.catalogModels, {
    validate: (doc) => parseModelsDoc(doc, warnings),
  })
  if (mr.kind === 'ok') {
    models = mr.value
    readOnly.models = mr.readOnly
  } else {
    models = emptyModelsFile(now())
    if (mr.kind === 'missing') {
      seeded.models = await createFile(paths.catalogModels, models, warnings, 'models.json')
      fallback.models = !seeded.models
    } else {
      fallback.models = true
      warnings.push(`models.json is unreadable (${mr.error}); using an empty model list until it is fixed`)
    }
  }

  return { models, pricing, seeded, readOnly, fallback, warnings }
}

// ---- lookup -----------------------------------------------------------------------------------------------------

const BRACKET_SUFFIX = /\[[^\]]*\]$/
const DATE_SUFFIX = /-\d{8}$/

/** Comparable model id: trimmed, lower-cased, without a context suffix such as `[1m]`. */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(BRACKET_SUFFIX, '').trim()
}

const undated = (id: string): string => id.replace(DATE_SUFFIX, '')

/**
 * The concrete model id the CLI reports for `model` (an id or one of its aliases) in models.json, else null.
 * CLI-reported lists are preferred over the aliases stored with prices.
 */
export function resolveModelId(models: ModelsFile, vendor: VendorId, model: string): string | null {
  const key = normalizeModelId(model)
  const list = models.vendors[vendor]?.models ?? []
  const hit =
    list.find((m) => normalizeModelId(m.id) === key) ??
    list.find((m) => (m.aliases ?? []).some((a) => normalizeModelId(a) === key))
  return hit?.id ?? null
}

function findEntry(entries: readonly PriceEntry[], key: string): PriceEntry | undefined {
  const byId = entries.find((e) => normalizeModelId(e.model) === key)
  if (byId) return byId
  const byAlias = entries.filter((e) => e.aliases.some((a) => normalizeModelId(a) === key))
  return byAlias.find((e) => e.deprecated !== true) ?? byAlias[0]
}

/**
 * The price for `vendor`'s `model` (a concrete id or an alias), else null:
 * 1. an entry whose model id matches (case-insensitive, `[1m]`-style suffix ignored);
 * 2. when models.json maps `model` to a different concrete id, that id's entry — or null if it has no price
 *    (the CLI moved the alias; an old alias stored with a price must not be used);
 * 3. an entry listing `model` among its aliases;
 * 4. the same, ignoring a `-YYYYMMDD` snapshot suffix on either side.
 * `model: null` (the CLI default) has no price here: resolve it to the probe's `isDefault` model first.
 */
export function lookupPrice(
  data: CatalogData,
  vendor: VendorId,
  model: string | null | undefined,
): PriceEntry | null {
  if (model === null || model === undefined) return null
  const key = normalizeModelId(model)
  if (key === '') return null
  const entries = data.pricing.entries.filter((e) => e.vendor === vendor)

  const direct = entries.find((e) => normalizeModelId(e.model) === key)
  if (direct) return direct

  const cliId = resolveModelId(data.models, vendor, model)
  if (cliId !== null && normalizeModelId(cliId) !== key) {
    const k = normalizeModelId(cliId)
    return (
      entries.find((e) => normalizeModelId(e.model) === k) ??
      entries.find((e) => undated(normalizeModelId(e.model)) === undated(k)) ??
      null
    )
  }

  const hit = findEntry(entries, key)
  if (hit) return hit

  const bare = undated(key)
  return (
    entries.find((e) => undated(normalizeModelId(e.model)) === bare) ??
    (bare !== key ? findEntry(entries, bare) : undefined) ??
    null
  )
}

// ---- status -----------------------------------------------------------------------------------------------------

export function pricingConfidenceSummary(entries: readonly PriceEntry[]): PricingConfidenceSummary {
  const kinds = new Set(entries.map((e) => e.confidence))
  if (kinds.size === 0) return 'none'
  if (kinds.size > 1) return 'mixed'
  return [...kinds][0] ?? 'none'
}

/** The pricing half of CatalogStatus (live.ts adds the schedule/job half). */
export interface PricingStatus {
  pricingUpdatedAt: number | null
  confidence: PricingConfidenceSummary
  /** pricing.json was last updated more than 2× the refresh interval ago (shown amber). */
  stale: boolean
}

/**
 * When the prices were last read from the vendors' pages: the newest fetchedAt of a price the user did not set (null
 * when every price is the user's own). A manual edit never moves it, so editing one price does not make
 * every other price look fresh.
 */
export function pricesFetchedAt(pricing: PricingFile): number | null {
  let at: number | null = null
  for (const e of pricing.entries) {
    if (e.confidence !== 'user' && (at === null || e.fetchedAt > at)) at = e.fetchedAt
  }
  return at
}

/**
 * `pricingUpdatedAt` is when the prices were last checked against the vendors' pages: the later of
 * {@link pricesFetchedAt} and the last finished refresh (`lastRefreshAt`, which counts even when the user applied
 * nothing). Stale is measured from it; with only the user's own prices and no refresh, it is pricing.json's date and
 * never stale.
 */
export function pricingStatus(
  pricing: PricingFile,
  intervalDays: number,
  now: number,
  lastRefreshAt: number | null = null,
): PricingStatus {
  if (pricing.entries.length === 0) return { pricingUpdatedAt: null, confidence: 'none', stale: false }
  const fetched = pricesFetchedAt(pricing)
  const checked =
    fetched === null ? lastRefreshAt : lastRefreshAt === null ? fetched : Math.max(fetched, lastRefreshAt)
  return {
    pricingUpdatedAt: checked ?? pricing.updatedAt,
    confidence: pricingConfidenceSummary(pricing.entries),
    stale: checked !== null && isPricingStale(checked, intervalDays, now),
  }
}

/** The single price is older than 2× the refresh interval. */
export function isEntryStale(
  entry: Pick<PriceEntry, 'fetchedAt'>,
  intervalDays: number,
  now: number,
): boolean {
  return isPricingStale(entry.fetchedAt, intervalDays, now)
}

// ---- pricingRef (resolved.json) ------------------------------------------------------------------------------------

export type PricingRefEntry = Pick<
  PriceEntry,
  | 'vendor'
  | 'model'
  | 'inputPerMTok'
  | 'outputPerMTok'
  | 'cacheReadPerMTok'
  | 'cacheWritePerMTok'
  | 'fetchedAt'
  | 'confidence'
  | 'sourceUrl'
> & {
  /** The model as configured (an alias, or the id itself). */
  requested: string
}

/** `resolved.json.pricingRef`: the prices a run's passes would be costed with, frozen at run creation. */
export interface PricingRef {
  pricingUpdatedAt: number
  entries: PricingRefEntry[]
  /** `vendor/model` pairs without a price (`vendor/default` for a null model). */
  missing: string[]
}

export function pricingRefFor(
  data: CatalogData,
  pairs: readonly { vendor: VendorId; model: string | null }[],
): PricingRef {
  const entries: PricingRefEntry[] = []
  const missing: string[] = []
  const done = new Set<string>()
  for (const { vendor, model } of pairs) {
    const tag = `${vendor}/${model ?? 'default'}`
    if (done.has(tag)) continue
    done.add(tag)
    const e = lookupPrice(data, vendor, model)
    if (e === null || model === null) {
      missing.push(tag)
      continue
    }
    entries.push({
      requested: model,
      vendor: e.vendor,
      model: e.model,
      inputPerMTok: e.inputPerMTok,
      outputPerMTok: e.outputPerMTok,
      cacheReadPerMTok: e.cacheReadPerMTok,
      cacheWritePerMTok: e.cacheWritePerMTok,
      fetchedAt: e.fetchedAt,
      confidence: e.confidence,
      sourceUrl: e.sourceUrl,
    })
  }
  return { pricingUpdatedAt: data.pricing.updatedAt, entries, missing }
}

/**
 * resolved.json's `pricingRef` read back (null when absent or not that shape; malformed entries are left
 * out), so a run's passes are costed at the prices it recorded.
 */
export function parsePricingRef(v: unknown): PricingRef | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o['entries'])) return null
  const price = (x: unknown, nullable: boolean): x is number | null =>
    (nullable && x === null) || (typeof x === 'number' && Number.isFinite(x) && x >= 0)
  const entries: PricingRefEntry[] = []
  for (const raw of o['entries']) {
    if (typeof raw !== 'object' || raw === null) continue
    const e = raw as Record<string, unknown>
    const conf = e['confidence']
    if (
      typeof e['requested'] !== 'string' ||
      typeof e['vendor'] !== 'string' ||
      typeof e['model'] !== 'string' ||
      !price(e['inputPerMTok'], false) ||
      !price(e['outputPerMTok'], false) ||
      !price(e['cacheReadPerMTok'], true) ||
      !price(e['cacheWritePerMTok'], true) ||
      typeof e['fetchedAt'] !== 'number' ||
      (conf !== 'verified' && conf !== 'unverified' && conf !== 'user')
    ) {
      continue
    }
    entries.push({
      requested: e['requested'],
      vendor: e['vendor'],
      model: e['model'],
      inputPerMTok: e['inputPerMTok'] as number,
      outputPerMTok: e['outputPerMTok'] as number,
      cacheReadPerMTok: e['cacheReadPerMTok'],
      cacheWritePerMTok: e['cacheWritePerMTok'],
      fetchedAt: e['fetchedAt'],
      confidence: conf,
      sourceUrl: typeof e['sourceUrl'] === 'string' ? e['sourceUrl'] : '',
    })
  }
  const missing = Array.isArray(o['missing'])
    ? o['missing'].filter((m): m is string => typeof m === 'string')
    : []
  return {
    pricingUpdatedAt: typeof o['pricingUpdatedAt'] === 'number' ? o['pricingUpdatedAt'] : 0,
    entries,
    missing,
  }
}

/**
 * The price a run's pass is costed at: the run's recorded price ({@link pricingRefPrice}) for the model as
 * configured (`requested`), else, for a model the run recorded none for (a model switched mid-run, a run from before
 * pricingRef), the live catalog's for the concrete model. So an apply, an Undo or a manual price during a run never
 * reprices it, and its costs always match resolved.json's pricingRef.
 */
export function runPassPrice(
  ref: PricingRef | null,
  live: CatalogData | undefined,
  vendor: VendorId,
  requested: string | null,
  concrete: string | null,
): PriceEntry | null {
  const frozen = ref !== null ? pricingRefPrice(ref, vendor, requested) : null
  if (frozen !== null) return frozen
  return live !== undefined ? lookupPrice(live, vendor, concrete) : null
}

/**
 * The price a run recorded for `vendor`'s `requested` model (its pricingRef entry, as configured: an alias, an id, or
 * the CLI default resolved at run creation), as a PriceEntry for costing; null when the run recorded none.
 */
export function pricingRefPrice(
  ref: PricingRef,
  vendor: VendorId,
  requested: string | null,
): PriceEntry | null {
  if (requested === null) return null
  const e = ref.entries.find((x) => x.vendor === vendor && x.requested === requested)
  if (e === undefined) return null
  return {
    vendor: e.vendor,
    model: e.model,
    aliases: [],
    inputPerMTok: e.inputPerMTok,
    outputPerMTok: e.outputPerMTok,
    cacheReadPerMTok: e.cacheReadPerMTok,
    cacheWritePerMTok: e.cacheWritePerMTok,
    sourceUrl: e.sourceUrl,
    fetchedAt: e.fetchedAt,
    confidence: e.confidence,
  }
}

// ---- store ------------------------------------------------------------------------------------------------------

export interface CatalogStoreOptions extends ReadCatalogOptions {
  paths: CatalogPaths
}

/**
 * Cached read-only access to the catalog. The first `read()` seeds missing files; later calls reuse the result
 * until `invalidate()` (or `read({reload:true})`). Concurrent reads share one load.
 */
export class CatalogStore {
  readonly paths: CatalogPaths
  readonly #opts: ReadCatalogOptions
  #loading: Promise<CatalogReadResult> | null = null

  constructor(opts: CatalogStoreOptions) {
    this.paths = opts.paths
    this.#opts = {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.seedPath !== undefined ? { seedPath: opts.seedPath } : {}),
    }
  }

  read(opts: { reload?: boolean } = {}): Promise<CatalogReadResult> {
    if (opts.reload === true || this.#loading === null) {
      const p = readCatalog(this.paths, this.#opts)
      this.#loading = p
      void p.catch(() => {
        if (this.#loading === p) this.#loading = null
      })
    }
    return this.#loading
  }

  invalidate(): void {
    this.#loading = null
  }

  async lookup(vendor: VendorId, model: string | null | undefined): Promise<PriceEntry | null> {
    return lookupPrice(await this.read(), vendor, model)
  }
}
