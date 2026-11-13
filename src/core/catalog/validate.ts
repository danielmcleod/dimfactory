// Refresh proposal validation (the validation table; the internal/catalog-refresh.md output schema). The AI's answer
// is untrusted web-derived data: nothing in it can change
// anything but proposed rows, and every row passes this validator before the diff review shows it.
//
// Rows (one per proposed change; ids are deterministic so a review's ticks map onto a recomputation at apply time):
//   - `price`: one row per changed price field of a known entry, or per offered field of a model with no price yet;
//   - `confirm`: a known entry whose prices a verified source repeats unchanged; only a ticked one is
//     re-stamped (source, quote, today, `verified`), so nothing the review does not show changes;
//   - `new-model`: a model from `newModels` that neither models.json nor pricing.json knows;
//   - `deprecate`: the page says the model is deprecated, or a known model is missing from the proposal (never a
//     deletion: a tickable `deprecated` flag instead, offered only for a vendor the proposal priced at all; a model the
//     answer named but the job's schema check refused is not missing).
// Table → flags (any flag unticks the row):
//   price ≤ 0 or > 1000 → rejected (never a row) · change > 50% → bigChange · > 10× or < 0.1× → suspicious (instead
//   of bigChange) · a cache price where there was none is compared with the input price those tokens cost now (cost.ts)
//   · a new model's price far (10×) from the vendor's other prices → suspicious · output < input, cacheRead > input or
//   cacheWrite < cacheRead → inconsistent · source host not in sources.ts → unofficial · no page read on the source's
//   host in this job → notFetched · model not reported by the CLI → notReportedByCli (a new model is flagged too while
//   the CLI's list is not known) · the user edited the entry (confidence 'user') → userEdited · missing from the
//   proposal → deprecated.
// Aliases in the answer are never used: they match no entry, count for no CLI check and are never stored,
// so an answer cannot point another model's id at an entry's price. The CLI's own model list maps aliases.
// sourceQuote keeps at most 200 characters; a row is `verified` only from an official host the job read, with a quote.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CATALOG_DIFF_FLAGS, PRICE_FIELDS } from '../../shared/catalog.ts'
import type {
  CatalogDiffFlag,
  CatalogDiffRow,
  CatalogDiffRowKind,
  CatalogRejectedRow,
  CatalogUnverifiable,
  ModelsFile,
  PriceEntry,
  PriceField,
  PricingFile,
  ProposedModel,
  ProposedPrice,
} from '../../shared/catalog.ts'
import { ModelIdZ, VendorIdZ } from '../../shared/config-schema.ts'
import type { VendorId } from '../../shared/vendors.ts'
import { isOfficialSource, sourceHostOf } from './sources.ts'
import { normalizeModelId } from './store.ts'

/** USD per 1M tokens: a proposed price must be more than 0 and at most this. */
export const PRICE_MAX_PER_MTOK = 1000
/** A change of more than this share (50%) is amber and unticked. */
export const BIG_CHANGE_SHARE = 0.5
/** More than this factor up or down (10×, 0.1×) is suspicious and unticked. */
export const SUSPICIOUS_FACTOR = 10
export const SOURCE_QUOTE_MAX = 200
const REASON_MAX = 300
const ENTRIES_MAX = 500
const ALIASES_MAX = 32
/** Row and rejected-row ids stay within the IPC id limit (ipc-schemas ID_MAX). */
const ROW_ID_MAX = 128

const PRICE_LABEL: Readonly<Record<PriceField, string>> = {
  inputPerMTok: 'input',
  outputPerMTok: 'output',
  cacheReadPerMTok: 'cache read',
  cacheWritePerMTok: 'cache write',
}

// ---- context ----------------------------------------------------------------------------------------------------

/** A model the CLI reports: its id (`opus`) and the ids it answers to (`claude-opus-5-5`). */
export type CliModelRef = string | { id: string; aliases?: readonly string[] | undefined }
/** One list for every vendor, or one per vendor id. An absent or empty list is not checked. */
export type CliModels = readonly CliModelRef[] | Readonly<Record<string, readonly CliModelRef[] | undefined>>

export interface ValidateContext {
  /** The models each CLI reports (its probe); a proposed model none of them answers to is `notReportedByCli`. */
  cliModels?: CliModels | undefined
  /** Official hosts, or a check of a URL for a vendor. Default: sources.ts (the vendor's publisher's hosts). */
  sources?: readonly string[] | ((url: string, vendor: VendorId) => boolean) | undefined
  /** `vendor/model` keys the user edited, on top of entries stored with confidence 'user'. */
  userEdited?: Iterable<string> | undefined
  /** Vendors the refresh covered (default: the vendors the proposal priced). Deprecation is offered only for these. */
  vendors?: readonly VendorId[] | undefined
  /**
   * The hosts whose pages the refresh read (its successful WebFetch results, status.json `fetchedHosts`).
   * When given, a source on any other host is `notFetched`: never verified, unticked. Absent: not checked.
   */
  fetchedHosts?: readonly string[] | undefined
  /**
   * Models the answer named that never reached proposal.json (the job's schema check refused them,
   * status.json `mentioned`); they are not "missing from the proposal".
   */
  mentioned?: readonly { vendor: string; model: string }[] | undefined
}

/** What the validator compares against: the current pricing, and models.json when known. */
export interface CatalogCurrent {
  pricing: PricingFile
  models?: ModelsFile | undefined
}

// ---- proposal parsing ---------------------------------------------------------------------------------------------

const ModelStringZ = ModelIdZ.unwrap()

const ProposedPriceZ = z.object({
  vendor: VendorIdZ,
  model: ModelStringZ,
  aliases: z.array(z.unknown()).max(64).optional(),
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  cacheReadPerMTok: z.number().nullable().optional(),
  cacheWritePerMTok: z.number().nullable().optional(),
  sourceUrl: z.string().max(2048),
  sourceQuote: z.string().max(10_000).optional(),
  deprecated: z.boolean().optional(),
})

const ProposedModelZ = z.object({
  vendor: VendorIdZ,
  id: ModelStringZ,
  displayName: z.string().max(10_000).optional(),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  sourceUrl: z.string().max(2048),
})

const UnverifiableZ = z.object({
  vendor: VendorIdZ,
  model: ModelStringZ,
  reason: z.string().max(10_000).optional(),
})

/** One proposal entry that passed the shape check, its aliases filtered and its quote trimmed. */
export interface CheckedPrice extends ProposedPrice {
  /** Index in the proposal's `entries` (stable tie-break). */
  index: number
  /** Official for the vendor, read by the job, with a quote: an applied price from it is `verified`. */
  verified: boolean
  official: boolean
  /** The job read a page on the source's host (true when the job's reads are not known). */
  fetched: boolean
}

export interface ParsedProposal {
  generatedAt: string | null
  entries: CheckedPrice[]
  newModels: ProposedModel[]
  unverifiable: CatalogUnverifiable[]
  /** Shape failures (zod, an unusable sourceUrl). */
  rejected: CatalogRejectedRow[]
  /** Every vendor/model the answer names, valid or not (a model it names is never "missing"). */
  mentioned: { vendor: string; model: string }[]
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The job-specific part of the context from a refresh job's status.json (`fetchedHosts`, `mentioned`, `vendors`),
 * read defensively: anything malformed is left out (and then not checked).
 */
export function jobValidateContext(raw: Readonly<Record<string, unknown>> | null): ValidateContext {
  const out: ValidateContext = {}
  if (raw === null) return out
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined
  const hosts = strings(raw['fetchedHosts'])
  if (hosts !== undefined) out.fetchedHosts = hosts.map((h) => h.toLowerCase())
  const vendors = strings(raw['vendors'])
  if (vendors !== undefined && vendors.length > 0) out.vendors = vendors
  const m = raw['mentioned']
  if (Array.isArray(m)) {
    out.mentioned = m.flatMap((x) =>
      isObj(x) && typeof x['vendor'] === 'string' && typeof x['model'] === 'string'
        ? [{ vendor: x['vendor'], model: x['model'] }]
        : [],
    )
  }
  return out
}

/** Plain one-line text: control characters and runs of white space become one space. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
}

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ''
  for (const ch of text) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

/** The quote as stored: one line, at most 200 characters (the rest of a longer quote is dropped, the start kept). */
export function cleanQuote(quote: string | undefined): string {
  return clip(plain(quote ?? ''), SOURCE_QUOTE_MAX)
}

/** An http(s) URL without credentials; anything else (javascript:, data:, a bare word) is not a source. */
export function isUsableSourceUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === ''
}

function issueText(err: z.ZodError): string {
  const first = err.issues[0]
  if (first === undefined) return 'invalid'
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : ''
  return `${path}${first.message}`
}

const shortStr = (v: unknown, max = 128): string | null =>
  typeof v === 'string' && v.trim() !== '' ? clip(plain(v), max) : null

function rejectedOf(
  raw: unknown,
  field: PriceField | undefined,
  value: unknown,
  reason: string,
): CatalogRejectedRow {
  const r = isObj(raw) ? raw : {}
  const row: CatalogRejectedRow = {
    vendor: shortStr(r['vendor'], 64) ?? '?',
    model: shortStr(r['model'] ?? r['id'], 128) ?? '?',
    value:
      typeof value === 'number' || typeof value === 'boolean' || value === null
        ? value
        : (shortStr(value, 200) ?? null),
    reason: clip(reason, REASON_MAX),
  }
  if (field !== undefined) row.field = field
  return row
}

function arrayAt(doc: Record<string, unknown>, key: string): unknown[] {
  const v = doc[key]
  return Array.isArray(v) ? v.slice(0, ENTRIES_MAX) : []
}

function validAliases(raw: readonly unknown[] | undefined, model: string): string[] {
  const out: string[] = []
  const seen = new Set([normalizeModelId(model)])
  for (const a of raw ?? []) {
    if (typeof a !== 'string' || !ModelStringZ.safeParse(a).success) continue
    const k = normalizeModelId(a)
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    out.push(a)
    if (out.length >= ALIASES_MAX) break
  }
  return out
}

/** The proposal document: the refresh's structured output, or `{proposal: …}` around it. */
function proposalDoc(raw: unknown): Record<string, unknown> {
  if (!isObj(raw)) return {}
  if (!Array.isArray(raw['entries']) && isObj(raw['proposal'])) return raw['proposal']
  return raw
}

/**
 * Parse the AI's answer entry by entry. A malformed entry is a rejected row, never an error; a document that is not
 * an object is an empty proposal.
 */
export function parseProposal(
  raw: unknown,
  isOfficial: (url: string, vendor: VendorId) => boolean,
  isFetched: (url: string) => boolean = () => true,
): ParsedProposal {
  const doc = proposalDoc(raw)
  const out: ParsedProposal = {
    generatedAt: typeof doc['generatedAt'] === 'string' ? clip(doc['generatedAt'], 64) : null,
    entries: [],
    newModels: [],
    unverifiable: [],
    rejected: [],
    mentioned: [],
  }
  const mention = (v: unknown): void => {
    if (!isObj(v)) return
    const vendor = shortStr(v['vendor'], 64)
    const model = shortStr(v['model'] ?? v['id'], 128)
    if (vendor !== null && model !== null) out.mentioned.push({ vendor, model })
  }

  arrayAt(doc, 'entries').forEach((raw, index) => {
    mention(raw)
    const r = ProposedPriceZ.safeParse(raw)
    if (!r.success) {
      out.rejected.push(rejectedOf(raw, undefined, null, `Not a valid price entry (${issueText(r.error)}).`))
      return
    }
    const e = r.data
    if (!isUsableSourceUrl(e.sourceUrl)) {
      out.rejected.push(rejectedOf(raw, undefined, e.sourceUrl, 'The source is not a web page address.'))
      return
    }
    const quote = cleanQuote(e.sourceQuote)
    const official = isOfficial(e.sourceUrl, e.vendor)
    const fetched = isFetched(e.sourceUrl)
    const p: CheckedPrice = {
      index,
      vendor: e.vendor,
      model: e.model,
      aliases: validAliases(e.aliases, e.model),
      inputPerMTok: e.inputPerMTok,
      outputPerMTok: e.outputPerMTok,
      cacheReadPerMTok: e.cacheReadPerMTok ?? null,
      cacheWritePerMTok: e.cacheWritePerMTok ?? null,
      sourceUrl: e.sourceUrl,
      sourceQuote: quote,
      official,
      fetched,
      verified: official && fetched && quote !== '',
    }
    if (e.deprecated === true) p.deprecated = true
    out.entries.push(p)
  })

  for (const raw of arrayAt(doc, 'newModels')) {
    mention(raw)
    const r = ProposedModelZ.safeParse(raw)
    if (!r.success || !isUsableSourceUrl(r.data.sourceUrl)) continue
    const m: ProposedModel = { vendor: r.data.vendor, id: r.data.id, sourceUrl: r.data.sourceUrl }
    const name = r.data.displayName !== undefined ? clip(plain(r.data.displayName), 200) : ''
    if (name !== '') m.displayName = name
    if (r.data.contextWindow !== undefined) m.contextWindow = r.data.contextWindow
    out.newModels.push(m)
  }

  for (const raw of arrayAt(doc, 'unverifiable')) {
    mention(raw)
    const r = UnverifiableZ.safeParse(raw)
    if (!r.success) continue
    out.unverifiable.push({
      vendor: r.data.vendor,
      model: r.data.model,
      reason: clip(plain(r.data.reason ?? ''), REASON_MAX) || 'No reason given.',
    })
  }
  return out
}

// ---- matching -----------------------------------------------------------------------------------------------------

const DATE_SUFFIX = /-\d{8}$/
const undated = (k: string): string => k.replace(DATE_SUFFIX, '')

/**
 * The current entry a proposed model is: its id, one of the entry's stored aliases, or the same id without a
 * `-YYYYMMDD` snapshot suffix on either side. Aliases the proposal gives never match (an answer naming a
 * new model with another entry's id as its alias would otherwise rewrite that entry).
 */
export function matchEntry(
  entries: readonly PriceEntry[],
  vendor: string,
  model: string,
): PriceEntry | undefined {
  const list = entries.filter((e) => e.vendor === vendor)
  const key = normalizeModelId(model)
  return (
    list.find((e) => normalizeModelId(e.model) === key) ??
    list.find((e) => e.aliases.some((a) => normalizeModelId(a) === key)) ??
    list.find((e) => undated(normalizeModelId(e.model)) === undated(key))
  )
}

function cliListFor(cli: CliModels | undefined, vendor: string): readonly CliModelRef[] {
  if (cli === undefined) return []
  if (Array.isArray(cli)) return cli as readonly CliModelRef[]
  return (cli as Readonly<Record<string, readonly CliModelRef[] | undefined>>)[vendor] ?? []
}

/** Normalized ids (and their undated forms) the vendor's CLI answers to; null when its list is unknown. */
function cliKeys(cli: CliModels | undefined, vendor: string): Set<string> | null {
  const list = cliListFor(cli, vendor)
  if (list.length === 0) return null
  const keys = new Set<string>()
  for (const m of list) {
    const ids = typeof m === 'string' ? [m] : [m.id, ...(m.aliases ?? [])]
    for (const id of ids) {
      const k = normalizeModelId(id)
      if (k === '') continue
      keys.add(k)
      keys.add(undated(k))
    }
  }
  return keys
}

function reportedByCli(keys: Set<string> | null, ids: readonly string[]): boolean {
  if (keys === null) return true
  return ids.some((id) => {
    const k = normalizeModelId(id)
    return keys.has(k) || keys.has(undated(k))
  })
}

// ---- rows ---------------------------------------------------------------------------------------------------------

/** Deterministic row id: `kind|vendor|model[|field]`, hashed when it would pass the IPC id limit. */
export function catalogRowId(
  kind: CatalogDiffRowKind,
  vendor: string,
  model: string,
  field?: PriceField,
): string {
  const raw = [kind, vendor, normalizeModelId(model), ...(field !== undefined ? [field] : [])].join('|')
  if (raw.length <= ROW_ID_MAX) return raw
  return `${kind}|${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`
}

const EPS = 1e-9
const samePrice = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b))

const inBounds = (n: number): boolean => Number.isFinite(n) && n > 0 && n <= PRICE_MAX_PER_MTOK

const usd = (n: number): string => `$${Number(n.toPrecision(6))}`

const FLAG_ORDER = new Map(CATALOG_DIFF_FLAGS.map((f, i) => [f, i]))
const ordered = (flags: Iterable<CatalogDiffFlag>): CatalogDiffFlag[] =>
  [...new Set(flags)].sort((a, b) => (FLAG_ORDER.get(a) ?? 0) - (FLAG_ORDER.get(b) ?? 0))

/** The relations a set of prices breaks: output below input; cache reads above input; cache writes below cache reads. */
function inconsistentFields(p: Record<PriceField, number | null>): Map<PriceField, string> {
  const out = new Map<PriceField, string>()
  const add = (f: PriceField, why: string): void => {
    out.set(f, [out.get(f), why].filter((s) => s !== undefined).join(' '))
  }
  const input = p.inputPerMTok
  const output = p.outputPerMTok
  const cacheRead = p.cacheReadPerMTok
  if (input !== null && output !== null && output < input - EPS) {
    const why = 'Output would cost less than input.'
    add('inputPerMTok', why)
    add('outputPerMTok', why)
  }
  if (input !== null && cacheRead !== null && cacheRead > input + EPS) {
    const why = 'Cache reads would cost more than input.'
    add('inputPerMTok', why)
    add('cacheReadPerMTok', why)
  }
  // Writing to the cache never costs less than reading from it (every vendor's page so far).
  const cacheWrite = p.cacheWritePerMTok
  if (cacheRead !== null && cacheWrite !== null && cacheWrite < cacheRead - EPS) {
    const why = 'Cache writes would cost less than cache reads.'
    add('cacheReadPerMTok', why)
    add('cacheWritePerMTok', why)
  }
  return out
}

interface RowInit {
  kind: CatalogDiffRowKind
  vendor: string
  model: string
  field?: PriceField
  current: number | null
  proposed: number | null
  sourceUrl: string | null
  sourceQuote: string | null
  verified: boolean
  flags: Set<CatalogDiffFlag>
  reasons: string[]
}

function makeRow(i: RowInit): CatalogDiffRow {
  const flags = ordered(i.flags)
  const deltaPct =
    i.current !== null && i.proposed !== null && i.current > 0
      ? Math.round(((i.proposed - i.current) / i.current) * 100 * 100) / 100
      : null
  const row: CatalogDiffRow = {
    id: catalogRowId(i.kind, i.vendor, i.model, i.field),
    vendor: i.vendor,
    model: i.model,
    kind: i.kind,
    current: i.current,
    proposed: i.proposed,
    deltaPct,
    sourceUrl: i.sourceUrl,
    sourceQuote: i.sourceQuote !== null && i.sourceQuote !== '' ? i.sourceQuote : null,
    flags,
    ticked: flags.length === 0,
  }
  if (i.field !== undefined) row.field = i.field
  if (i.verified) row.verified = true
  const reason = clip([...new Set(i.reasons)].join(' '), REASON_MAX)
  if (flags.length > 0 && reason !== '') row.reason = reason
  return row
}

/** The lowest and highest price the vendor's current entries have for a field (null: none has one). */
function vendorRange(
  entries: readonly PriceEntry[],
  vendor: string,
  f: PriceField,
): { min: number; max: number } | null {
  const values = entries
    .filter((e) => e.vendor === vendor && e.deprecated !== true)
    .map((e) => e[f])
    .filter((v): v is number => v !== null && v > 0)
  return values.length > 0 ? { min: Math.min(...values), max: Math.max(...values) } : null
}

// ---- the check ----------------------------------------------------------------------------------------------------

export interface ValidatedProposal {
  rows: CatalogDiffRow[]
  rejected: CatalogRejectedRow[]
  unverifiable: CatalogUnverifiable[]
  /** The parsed proposal the rows were made from (diff.ts applies ticked rows from it). */
  parsed: ParsedProposal
  /** Proposal entry for each price row id (its stored model when known). */
  sources: ReadonlyMap<string, { entry: CheckedPrice; current: PriceEntry | undefined }>
  /** The verified source and the stored entry for each confirm row id. */
  confirmations: ReadonlyMap<string, { entry: CheckedPrice; current: PriceEntry }>
  /** Proposed model for each new-model row id. */
  models: ReadonlyMap<string, ProposedModel>
  /** Stored entry for each deprecate row id. */
  deprecations: ReadonlyMap<string, PriceEntry>
}

function officialCheck(ctx: ValidateContext): (url: string, vendor: VendorId) => boolean {
  const s = ctx.sources
  if (typeof s === 'function') return s
  if (s === undefined) return (url, vendor) => isOfficialSource(url, vendor)
  const hosts = new Set(s.map((h) => h.toLowerCase()))
  return (url) => {
    const host = sourceHostOf(url)
    return host !== null && hosts.has(host)
  }
}

const keyOf = (vendor: string, model: string): string => `${vendor}/${normalizeModelId(model)}`

/** Whether the job read a page on a URL's host; true when its reads are not known. */
function fetchedCheck(ctx: ValidateContext): (url: string) => boolean {
  if (ctx.fetchedHosts === undefined) return () => true
  const hosts = new Set(ctx.fetchedHosts.map((h) => h.toLowerCase()))
  return (url) => {
    const host = sourceHostOf(url)
    return host !== null && hosts.has(host)
  }
}

const UNOFFICIAL = 'The source is not an official page of this vendor.'
const NOT_FETCHED = 'The update read no page on this site, so this price is not confirmed.'
const NOT_IN_CLI = 'The CLI does not list this model.'
const CLI_UNKNOWN = "The CLI's model list is not known yet, so this model could not be checked."
const USER_EDITED = 'You edited this price.'

/**
 * Validate a refresh proposal against the current catalog: the diff rows (one per proposed change, in a fixed order:
 * vendor, model, then input, output, cache read, cache write, confirm, new model, deprecate), the rejected values and
 * the models the AI could not verify.
 */
export function checkProposal(
  current: CatalogCurrent,
  proposal: unknown,
  ctx: ValidateContext = {},
): ValidatedProposal {
  const isOfficial = officialCheck(ctx)
  const isFetched = fetchedCheck(ctx)
  const parsed = parseProposal(proposal, isOfficial, isFetched)
  const entries = current.pricing.entries
  const userEdited = new Set<string>()
  for (const k of ctx.userEdited ?? []) {
    const i = k.indexOf('/')
    userEdited.add(i > 0 ? keyOf(k.slice(0, i), k.slice(i + 1)) : k)
  }
  const isUserEdited = (e: PriceEntry | undefined): boolean =>
    e !== undefined && (e.confidence === 'user' || userEdited.has(keyOf(e.vendor, e.model)))

  const rows: CatalogDiffRow[] = []
  const rejected: CatalogRejectedRow[] = [...parsed.rejected]
  const confirmations = new Map<string, { entry: CheckedPrice; current: PriceEntry }>()
  const sources = new Map<string, { entry: CheckedPrice; current: PriceEntry | undefined }>()
  const models = new Map<string, ProposedModel>()
  const deprecations = new Map<string, PriceEntry>()
  const claimed = new Set<string>()
  const pricedVendors = new Set<string>()

  for (const p of parsed.entries) {
    const cur = matchEntry(entries, p.vendor, p.model)
    const model = cur?.model ?? p.model
    const claim = keyOf(p.vendor, model)
    if (claimed.has(claim)) {
      rejected.push(
        rejectedOf(p, undefined, null, `${model} is listed more than once; the first listing is used.`),
      )
      continue
    }
    claimed.add(claim)
    pricedVendors.add(p.vendor)

    const proposed: Record<PriceField, number | null> = {
      inputPerMTok: p.inputPerMTok,
      outputPerMTok: p.outputPerMTok,
      cacheReadPerMTok: p.cacheReadPerMTok,
      cacheWritePerMTok: p.cacheWritePerMTok,
    }
    const bad = new Set<PriceField>()
    for (const f of PRICE_FIELDS) {
      const v = proposed[f]
      if (v !== null && !inBounds(v)) {
        bad.add(f)
        rejected.push({
          vendor: p.vendor,
          model,
          field: f,
          value: v,
          reason: `The ${PRICE_LABEL[f]} price must be more than $0 and at most $1,000 per million tokens.`,
        })
      }
    }
    if (cur === undefined && (bad.has('inputPerMTok') || bad.has('outputPerMTok'))) {
      rejected.push({
        vendor: p.vendor,
        model,
        value: null,
        reason: 'Not added: a new model needs valid input and output prices.',
      })
      continue
    }

    const effective = { ...proposed }
    for (const f of PRICE_FIELDS) if (bad.has(f)) effective[f] = cur !== undefined ? cur[f] : null
    const broken = inconsistentFields(effective)
    const common = new Set<CatalogDiffFlag>()
    const commonWhy: string[] = []
    if (!p.official) {
      common.add('unofficial')
      commonWhy.push(UNOFFICIAL)
    }
    if (!p.fetched) {
      common.add('notFetched')
      commonWhy.push(NOT_FETCHED)
    }
    const cli = cliKeys(ctx.cliModels, p.vendor)
    if (!reportedByCli(cli, [model, p.model, ...(cur?.aliases ?? [])])) {
      common.add('notReportedByCli')
      commonWhy.push(NOT_IN_CLI)
    } else if (cli === null && cur === undefined) {
      // A model with no price yet is checked against the CLI's list; with no list it waits for the user.
      common.add('notReportedByCli')
      commonWhy.push(CLI_UNKNOWN)
    }
    if (isUserEdited(cur)) {
      common.add('userEdited')
      commonWhy.push(USER_EDITED)
    }

    let changed = 0
    for (const f of PRICE_FIELDS) {
      if (bad.has(f)) continue
      const next = proposed[f]
      const was = cur !== undefined ? cur[f] : null
      if (cur === undefined && next === null) continue
      if (cur !== undefined && samePrice(was, next)) continue
      changed++
      const flags = new Set(common)
      const reasons = [...commonWhy]
      if (was !== null && next !== null && was > 0) {
        const ratio = next / was
        if (ratio > SUSPICIOUS_FACTOR || ratio < 1 / SUSPICIOUS_FACTOR) {
          flags.add('suspicious')
          reasons.unshift(
            `${ratio > 1 ? 'More than 10 times the' : 'Less than a tenth of the'} current price (${usd(was)}).`,
          )
        } else if (Math.abs(ratio - 1) > BIG_CHANGE_SHARE) {
          flags.add('bigChange')
          reasons.unshift(`Changes by more than 50% (from ${usd(was)}).`)
        }
      } else if (was !== null && next === null) {
        flags.add('bigChange')
        reasons.unshift(
          `The page lists no separate ${PRICE_LABEL[f]} price; those tokens would cost the input price.`,
        )
      } else if (was === null && next !== null && cur !== undefined && cur.inputPerMTok > 0) {
        // No cache price yet means those tokens cost the input price now (cost.ts), so a new one is a
        // change from that rate, judged like any other.
        const base = cur.inputPerMTok
        const ratio = next / base
        if (ratio > SUSPICIOUS_FACTOR || ratio < 1 / SUSPICIOUS_FACTOR) {
          flags.add('suspicious')
          reasons.unshift(
            `${ratio > 1 ? 'More than 10 times' : 'Less than a tenth of'} what those tokens cost now: the input price (${usd(base)}).`,
          )
        } else if (Math.abs(ratio - 1) > BIG_CHANGE_SHARE) {
          flags.add('bigChange')
          reasons.unshift(`Changes by more than 50%: those tokens now cost the input price (${usd(base)}).`)
        }
      } else if (cur === undefined && next !== null) {
        // A model with no price yet is compared with the vendor's other prices for the same field.
        const range = vendorRange(entries, p.vendor, f)
        if (
          range !== null &&
          (next > range.max * SUSPICIOUS_FACTOR || next < range.min / SUSPICIOUS_FACTOR)
        ) {
          flags.add('suspicious')
          reasons.unshift(
            `Far from this vendor's other ${PRICE_LABEL[f]} prices (${usd(range.min)} to ${usd(range.max)}).`,
          )
        }
      }
      const why = broken.get(f)
      if (why !== undefined) {
        flags.add('inconsistent')
        reasons.push(why)
      }
      const row = makeRow({
        kind: 'price',
        vendor: p.vendor,
        model,
        field: f,
        current: was,
        proposed: next,
        sourceUrl: p.sourceUrl,
        sourceQuote: p.sourceQuote,
        verified: p.verified,
        flags,
        reasons,
      })
      rows.push(row)
      sources.set(row.id, { entry: p, current: cur })
    }

    if (cur !== undefined && p.deprecated === true && cur.deprecated !== true) {
      const flags = new Set([...common].filter((f) => f !== 'notReportedByCli'))
      const reasons = commonWhy.filter((r) => r !== NOT_IN_CLI)
      const row = makeRow({
        kind: 'deprecate',
        vendor: p.vendor,
        model,
        current: null,
        proposed: null,
        sourceUrl: p.sourceUrl,
        sourceQuote: p.sourceQuote,
        verified: p.verified,
        flags,
        reasons,
      })
      rows.push(row)
      deprecations.set(row.id, cur)
    }

    // The same prices on a verified page are a row of their own; only a ticked one changes the entry.
    if (cur !== undefined && changed === 0 && bad.size === 0 && p.verified && !isUserEdited(cur)) {
      const row = makeRow({
        kind: 'confirm',
        vendor: p.vendor,
        model,
        current: null,
        proposed: null,
        sourceUrl: p.sourceUrl,
        sourceQuote: p.sourceQuote,
        verified: true,
        flags: new Set(common),
        reasons: [...commonWhy],
      })
      rows.push(row)
      confirmations.set(row.id, { entry: p, current: cur })
    }
  }

  // New models: not in models.json and without a price entry.
  const seenNew = new Set<string>()
  for (const m of parsed.newModels) {
    const k = keyOf(m.vendor, m.id)
    if (seenNew.has(k)) continue
    seenNew.add(k)
    const listed = current.models?.vendors[m.vendor]?.models ?? []
    const id = normalizeModelId(m.id)
    const known =
      listed.some((x) => [x.id, ...(x.aliases ?? [])].some((a) => normalizeModelId(a) === id)) ||
      matchEntry(entries, m.vendor, m.id) !== undefined
    if (known) continue
    const flags = new Set<CatalogDiffFlag>()
    const reasons: string[] = []
    if (!isOfficial(m.sourceUrl, m.vendor)) {
      flags.add('unofficial')
      reasons.push(UNOFFICIAL)
    }
    if (!isFetched(m.sourceUrl)) {
      flags.add('notFetched')
      reasons.push(NOT_FETCHED)
    }
    const cli = cliKeys(ctx.cliModels, m.vendor)
    if (cli === null || !reportedByCli(cli, [m.id])) {
      flags.add('notReportedByCli')
      reasons.push(cli === null ? CLI_UNKNOWN : NOT_IN_CLI)
    }
    const row = makeRow({
      kind: 'new-model',
      vendor: m.vendor,
      model: m.id,
      current: null,
      proposed: m.contextWindow ?? null,
      sourceUrl: m.sourceUrl,
      sourceQuote: null,
      verified: false,
      flags,
      reasons,
    })
    rows.push(row)
    models.set(row.id, m)
  }

  // Missing from the proposal: a tickable deprecated flag, never a deletion.
  const scope = new Set<string>(
    ctx.vendors ?? [...pricedVendors, ...parsed.unverifiable.map((u) => u.vendor)],
  )
  for (const e of entries) {
    if (!scope.has(e.vendor) || !pricedVendors.has(e.vendor) || e.deprecated === true) continue
    const named = [...parsed.mentioned, ...(ctx.mentioned ?? [])].some(
      (m) => m.vendor === e.vendor && matchEntry([e], m.vendor, m.model) !== undefined,
    )
    if (named) continue
    const flags = new Set<CatalogDiffFlag>(['deprecated'])
    const reasons = ['Not in this update: the vendor may have retired it. Tick to mark it deprecated.']
    if (isUserEdited(e)) {
      flags.add('userEdited')
      reasons.push(USER_EDITED)
    }
    const row = makeRow({
      kind: 'deprecate',
      vendor: e.vendor,
      model: e.model,
      current: null,
      proposed: null,
      sourceUrl: null,
      sourceQuote: null,
      verified: false,
      flags,
      reasons,
    })
    if (deprecations.has(row.id)) continue
    rows.push(row)
    deprecations.set(row.id, e)
  }

  const KIND_ORDER: Record<CatalogDiffRowKind, number> = {
    price: 0,
    confirm: 1,
    'new-model': 2,
    deprecate: 3,
  }
  const fieldOrder = (r: CatalogDiffRow): number =>
    r.field !== undefined ? PRICE_FIELDS.indexOf(r.field) : 0
  rows.sort(
    (a, b) =>
      a.vendor.localeCompare(b.vendor) ||
      normalizeModelId(a.model).localeCompare(normalizeModelId(b.model)) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      fieldOrder(a) - fieldOrder(b),
  )
  return {
    rows,
    rejected,
    unverifiable: parsed.unverifiable,
    confirmations,
    parsed,
    sources,
    models,
    deprecations,
  }
}

/** The diff rows for a proposal (see {@link checkProposal} for the rejected values and the rest). */
export function validateProposal(
  current: CatalogCurrent,
  proposal: unknown,
  ctx: ValidateContext = {},
): CatalogDiffRow[] {
  return checkProposal(current, proposal, ctx).rows
}

// ---- manual edits ---------------------------------------------------------------------------------------------------

/** Why a manual price is refused (same bounds as a refresh: more than $0, at most $1,000 per 1M tokens), else null. */
export function priceEditProblem(edit: Readonly<Record<PriceField, unknown>>): string | null {
  for (const f of PRICE_FIELDS) {
    const v = edit[f]
    const nullable = f === 'cacheReadPerMTok' || f === 'cacheWritePerMTok'
    if (v === null && nullable) continue
    if (typeof v !== 'number' || !inBounds(v)) {
      return `The ${PRICE_LABEL[f]} price must be more than $0 and at most $1,000 per million tokens${nullable ? ', or empty when the vendor has none' : ''}.`
    }
  }
  return null
}
