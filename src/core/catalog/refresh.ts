// The catalog refresh job (prompt template internal/catalog-refresh.md): one
// read-only, web-limited pass in catalog/jobs/<id>/ whose answer (the structured output, else the last fenced JSON
// block) is checked against the template's output schema. Only refresh-jobs.ts starts it, on consent. Claude runs it
// (C17/C18) and Codex (X17: read-only, ephemeral, `config:{web_search:'live'}` + `outputSchema` on
// turn/start; the adapter builds those from the same StartOptions, step `catalog`).
//
// Safety (the job is a read-only pass that reads only official pages):
// - argv (adapters/claude/launch.ts, step `catalog`): dontAsk, no permission host, --permission-prompts none,
//   --no-session-persistence, hooks off, no MCP, --tools WebSearch,WebFetch (the pass's only built-in tools; the
//   StructuredOutput answer tool comes with the schema), --disallowedTools Edit,Write,NotebookEdit,AskUserQuestion,
//   Monitor,Bash,PowerShell,Agent (defence in depth), --allowedTools WebSearch,WebFetch(domain:<host>)… for the
//   official hosts of the vendors in use (catalog/sources.ts). The cwd is the job's own folder, never the user's.
// - The user's Claude settings cannot widen it: the spawn's env carries CLAUDE_CODE_EVAL_CONFINED=1
//   (capabilities.ts CATALOG_CONFINED_ENV, after the user's vendor env), so the CLI's allow list is exactly the argv's
//   --allowedTools: no settings allow-rule (a bare `WebFetch` in ~/.claude/settings.json included) and none of
//   WebFetch's built-in preapproved hosts. A fetch anywhere else is denied by dontAsk.
// - `verified` needs a page the job read: the hosts of its successful WebFetch results (Codex: the pages its web
//   searches opened, live X17) go to status.json (`fetchedHosts`), and a price sourced on another host is flagged
//   `notFetched` (validate.ts).
// - Web content is untrusted: the answer can only become proposed rows. Unknown keys are dropped, strings are cleaned
//   and cut, ids must look like ids, prices must be numbers with an https source and a quote; anything else is a
//   rejected row with its reason, and every row then passes validate.ts before the user ticks it.
// - 10 minutes at most; a cancel (AbortSignal) or the timeout stops the process tree through the adapter. No
//   credentials are read or stored; the raw log is redacted.
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type {
  CatalogJobState,
  CatalogRefreshOutput,
  CatalogRejectedRow,
  CatalogUnverifiable,
  PriceEntry,
  PriceField,
  ProposedModel,
  ProposedPrice,
} from '../../shared/catalog.ts'
import { CATALOG_JOB_STATES } from '../../shared/catalog.ts'
import type { AdapterSignal, NormalizedEvent, Usage } from '../../shared/events.ts'
import type { Failure, FailureCategory } from '../../shared/failure.ts'
import { isFailureCategory } from '../../shared/failure.ts'
import type { VendorId } from '../../shared/vendors.ts'
import { VENDOR_DISPLAY_NAMES } from '../adapters/registry.ts'
import type { Adapter, ExitInfo, RunHandle, StartOptions } from '../adapters/types.ts'
import { META_PAGES_READ, META_STRUCTURED_OUTPUT, META_USAGE } from '../adapters/types.ts'
import { assertSafeSegment, homePaths } from '../home.ts'
import { normalizeText, render } from '../prompts/template.ts'
import { flagKey } from '../recovery/config-patch.ts'
import { writeJsonAtomic } from '../store/atomic.ts'
import { RawLog } from '../supervisor/effects.ts'
import { officialHosts, officialSourcesText, sourceHostOf } from './sources.ts'
import type { CatalogData } from './store.ts'
import { normalizeModelId } from './store.ts'

// ---- limits ----------------------------------------------------------------------------------------------------------

/** The refresh gets 10 minutes. */
export const REFRESH_TIMEOUT_MS = 600_000
/** After the answer (or a stop), how long the process may take to exit before it is stopped again. */
const EXIT_GRACE_MS = 10_000
/** A read-only pass never asks; anything that still does is denied at once. */
const REFRESH_ASK_TIMEOUT_MS = 30_000
/** The answer as JSON text; anything larger is refused whole. */
export const ANSWER_MAX_CHARS = 2_000_000
export const ENTRIES_MAX = 200
export const NEW_MODELS_MAX = 50
export const UNVERIFIABLE_MAX = 200
export const ALIASES_MAX = 32
/** The template's quote rule: "up to 200 characters copied verbatim". */
export const QUOTE_MAX = 200
export const REASON_MAX = 300
export const DISPLAY_NAME_MAX = 100
export const URL_MAX = 2048
/** `{{currentCatalog}}` is cut (whole lines) at this size. */
const CURRENT_CATALOG_MAX_CHARS = 64_000
const ERROR_MAX = 2000

/** The template's output: `{generatedAt, entries, newModels, unverifiable}` (shared CatalogRefreshOutput). */
export type RefreshProposal = CatalogRefreshOutput

// ---- template --------------------------------------------------------------------------------------------------------

/**
 * Where internal/catalog-refresh.md is read from: next to the sources, or in the bundled app (core = out/main/index.js)
 * at out/main/internal/, where the build copies the whole internal/ folder (electron.vite.config.ts), as for heal.md.
 */
export const CATALOG_REFRESH_TEMPLATE_CANDIDATES: readonly string[] = [
  fileURLToPath(new URL('../prompts/internal/catalog-refresh.md', import.meta.url)),
  fileURLToPath(new URL('./internal/catalog-refresh.md', import.meta.url)),
]

let templateMemo: string | undefined

/** The builtin catalog-refresh template (normalized). Throws when no copy is found. */
export function readCatalogRefreshTemplate(
  candidates: readonly string[] = CATALOG_REFRESH_TEMPLATE_CANDIDATES,
): string {
  if (candidates === CATALOG_REFRESH_TEMPLATE_CANDIDATES && templateMemo !== undefined) return templateMemo
  for (const path of candidates) {
    try {
      const text = normalizeText(readFileSync(path, 'utf8'))
      if (candidates === CATALOG_REFRESH_TEMPLATE_CANDIDATES) templateMemo = text
      return text
    } catch {
      // try the next location
    }
  }
  throw new Error(`The price refresh prompt template is missing (looked in ${candidates.join(', ')})`)
}

// ---- the output schema (sent in initialize jsonSchema and shown in the prompt) ----------------------------------------

const PUBLISHER_NAMES: Readonly<Record<string, string>> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  gemini: 'Google',
  grok: 'xAI',
  muse: 'Meta',
}

/**
 * The template's output schema as JSON Schema, with `vendor` limited to the vendors being refreshed. Every object is
 * closed (`additionalProperties: false`); string lengths and list sizes match what the parser keeps, so a CLI that
 * checks the schema asks the model to fix an oversized answer instead of Dim Factory cutting it.
 */
export function refreshJsonSchema(vendors: readonly VendorId[]): Record<string, unknown> {
  const vendor = { type: 'string', enum: [...vendors], description: 'Dim Factory vendor id' }
  const model = { type: 'string', maxLength: 128, description: 'Exact model id the vendor API/CLI accepts' }
  const url = { type: 'string', maxLength: URL_MAX, description: 'https URL of the official page read' }
  const price = { type: 'number', description: 'USD per 1,000,000 tokens, standard tier' }
  const optionalPrice = {
    type: ['number', 'null'],
    description: 'USD per 1,000,000 tokens, or null if not offered',
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['generatedAt', 'entries', 'newModels', 'unverifiable'],
    properties: {
      generatedAt: { type: 'string', maxLength: 64, description: 'ISO 8601 time of this answer' },
      entries: {
        type: 'array',
        maxItems: ENTRIES_MAX,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'vendor',
            'model',
            'inputPerMTok',
            'outputPerMTok',
            'cacheReadPerMTok',
            'cacheWritePerMTok',
            'sourceUrl',
            'sourceQuote',
          ],
          properties: {
            vendor,
            model,
            aliases: { type: 'array', maxItems: ALIASES_MAX, items: { type: 'string', maxLength: 128 } },
            inputPerMTok: price,
            outputPerMTok: price,
            cacheReadPerMTok: optionalPrice,
            cacheWritePerMTok: optionalPrice,
            sourceUrl: url,
            sourceQuote: {
              type: 'string',
              maxLength: QUOTE_MAX,
              description: 'Up to 200 characters copied verbatim from sourceUrl',
            },
            deprecated: { type: 'boolean', description: 'true only when the page says so' },
          },
        },
      },
      newModels: {
        type: 'array',
        maxItems: NEW_MODELS_MAX,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['vendor', 'id', 'sourceUrl'],
          properties: {
            vendor,
            id: model,
            displayName: { type: 'string', maxLength: DISPLAY_NAME_MAX },
            contextWindow: { type: 'integer', description: 'tokens' },
            sourceUrl: url,
          },
        },
      },
      unverifiable: {
        type: 'array',
        maxItems: UNVERIFIABLE_MAX,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['vendor', 'model', 'reason'],
          properties: {
            vendor,
            model: { type: 'string', maxLength: 128 },
            reason: { type: 'string', maxLength: REASON_MAX },
          },
        },
      },
    },
  }
}

// ---- prompt ------------------------------------------------------------------------------------------------------------

export interface RefreshPromptInput {
  vendors: readonly VendorId[]
  catalog: CatalogData
  /** `YYYY-MM-DD`. */
  today: string
  schema: Record<string, unknown>
}

/** `claude (Anthropic), codex (OpenAI)`: the ids the answer must use, with the publisher whose pages count. */
export function vendorsText(vendors: readonly VendorId[]): string {
  return vendors
    .map((v) => {
      const org = PUBLISHER_NAMES[v]
      return org !== undefined ? `${v} (${org})` : v
    })
    .join(', ')
}

function priceLine(e: PriceEntry): string {
  const o: Record<string, unknown> = {
    vendor: e.vendor,
    model: e.model,
    aliases: e.aliases,
    inputPerMTok: e.inputPerMTok,
    outputPerMTok: e.outputPerMTok,
    cacheReadPerMTok: e.cacheReadPerMTok,
    cacheWritePerMTok: e.cacheWritePerMTok,
    sourceUrl: e.sourceUrl,
  }
  if (e.deprecated === true) o['deprecated'] = true
  return JSON.stringify(o)
}

/**
 * `{{currentCatalog}}`: one JSON line per known price of the vendors being refreshed, then the models the CLI reported
 * that have no price yet. Cut at whole lines with a note when it would exceed 64 KB.
 */
export function currentCatalogText(catalog: CatalogData, vendors: readonly VendorId[]): string {
  const lines: string[] = []
  for (const v of vendors) {
    const priced = catalog.pricing.entries.filter((e) => e.vendor === v)
    for (const e of priced) lines.push(priceLine(e))
    const known = new Set(
      priced.flatMap((e) => [e.model, ...e.aliases].map((m) => normalizeModelId(m))).filter((m) => m !== ''),
    )
    for (const m of catalog.models.vendors[v]?.models ?? []) {
      if (m.hidden === true || known.has(normalizeModelId(m.id))) continue
      lines.push(
        JSON.stringify({ vendor: v, model: m.id, aliases: m.aliases ?? [], prices: 'not known yet' }),
      )
    }
  }
  if (lines.length === 0) return '(none yet)'
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    const next = `${out}${out === '' ? '' : '\n'}${lines[i]}`
    if (next.length > CURRENT_CATALOG_MAX_CHARS) return `${out}\n(${lines.length - i} more entries not shown)`
    out = next
  }
  return out
}

/** The rendered catalog-refresh prompt (throws a TemplateError when the template is broken). */
export function renderRefreshPrompt(i: RefreshPromptInput, template?: string): string {
  return render(
    template ?? readCatalogRefreshTemplate(),
    {
      vendors: vendorsText(i.vendors),
      officialSources: officialSourcesText(i.vendors),
      today: i.today,
      currentCatalog: currentCatalogText(i.catalog, i.vendors),
      jsonSchema: JSON.stringify(i.schema, null, 2),
    },
    { template: 'catalog' },
  ).text
}

/** The user's local calendar date as `YYYY-MM-DD` ("Today is …"). */
export function localDate(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---- the answer --------------------------------------------------------------------------------------------------------

export type AnswerSource = 'structured_output' | 'fenced-json' | 'message-json'

export type ExtractResult = { ok: true; value: unknown; source: AnswerSource } | { ok: false; error: string }

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g

/**
 * The answer: `result.structured_output` when the CLI gave one (C17); else the LAST fenced JSON block of the final
 * message (C18a), or a message that is one JSON object by itself. Earlier blocks are drafts and are ignored.
 */
export function extractRefreshAnswer(structured: unknown, finalText: string): ExtractResult {
  if (structured !== undefined && structured !== null) {
    if (typeof structured !== 'string') return { ok: true, value: structured, source: 'structured_output' }
    try {
      return { ok: true, value: JSON.parse(structured) as unknown, source: 'structured_output' }
    } catch {
      // A string that is not JSON: read the message instead.
    }
  }
  const src = finalText.replace(/\r\n?/g, '\n')
  const blocks = [...src.matchAll(FENCE)].filter((m) => {
    const lang = (m[1] ?? '').toLowerCase()
    return lang === 'json' || lang === 'jsonc' || (lang === '' && /^\s*\{/.test(m[2] ?? ''))
  })
  for (const block of blocks.reverse()) {
    try {
      return { ok: true, value: JSON.parse(block[2] ?? '') as unknown, source: 'fenced-json' }
    } catch {
      // try the block before it
    }
  }
  if (/^\s*\{[\s\S]*\}\s*$/.test(src)) {
    try {
      return { ok: true, value: JSON.parse(src) as unknown, source: 'message-json' }
    } catch {
      // fall through
    }
  }
  return {
    ok: false,
    error:
      blocks.length > 0
        ? "Claude's answer had a JSON block that is not valid JSON."
        : 'Claude answered without the price list (no JSON in the answer).',
  }
}

const ELLIPSIS = '\u2026'
/** Format characters (bidi overrides, zero-width): never shown, never kept. */
const FORMAT_CHARS = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g

/**
 * Text from the web as one plain line: format characters removed, control characters and line breaks become spaces,
 * an em dash becomes a hyphen (UI copy standard), runs of spaces collapse, cut to `max` with an ellipsis.
 */
export function cleanText(s: string, max: number): string {
  const one = s
    .replace(FORMAT_CHARS, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s*\u2014\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > max ? `${one.slice(0, max - 1)}${ELLIPSIS}` : one
}

/** A model id or alias: what ModelIdZ allows, starting with a letter or digit, at most 128 characters. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.:@/[\]-]{0,127}$/

const HttpsUrlZ = z
  .string()
  .max(URL_MAX)
  .refine((u) => sourceHostOf(u) !== null, { message: 'is not an https link' })
const ModelZ = z.string().regex(MODEL_ID_PATTERN, { message: 'is not a model id' })

/**
 * One proposed price as answered; unknown keys are dropped (they can never set confidence, dates or anything else). An
 * optional field may also be null: Codex answers its strict outputSchema with null for one it leaves out (live X17).
 */
const EntryInZ = z.object({
  vendor: z.string(),
  model: ModelZ,
  aliases: z.array(z.unknown()).max(1000).nullish(),
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  cacheReadPerMTok: z.number().nullable(),
  cacheWritePerMTok: z.number().nullable(),
  sourceUrl: HttpsUrlZ,
  sourceQuote: z.string(),
  deprecated: z.boolean().nullish(),
})
const NewModelInZ = z.object({
  vendor: z.string(),
  id: ModelZ,
  displayName: z.string().nullish(),
  contextWindow: z.number().int().positive().max(100_000_000).nullish(),
  sourceUrl: HttpsUrlZ,
})
const UnverifiableInZ = z.object({ vendor: z.string(), model: z.string(), reason: z.string() })
const AnswerInZ = z.object({
  generatedAt: z.unknown().optional(),
  entries: z.array(z.unknown()),
  newModels: z.array(z.unknown()).optional(),
  unverifiable: z.array(z.unknown()).optional(),
})

export interface ParsedProposal {
  proposal: RefreshProposal
  /** Entries and new models the schema refused, with the reason (CatalogDiff.rejected: never offered for apply). */
  rejected: CatalogRejectedRow[]
  /** What was cut or dropped beyond the rejected rows (extra keys, long lists, bad aliases), for status.json. */
  notes: string[]
  /**
   * Every vendor/model the answer named, kept or refused (status.json `mentioned`): a model the schema
   * check refused is still named, so the review never offers to deprecate it as missing.
   */
  mentioned: { vendor: string; model: string }[]
}

export type ParseProposalResult = ({ ok: true } & ParsedProposal) | { ok: false; error: string }

const PRICE_FIELD_SET: ReadonlySet<string> = new Set([
  'inputPerMTok',
  'outputPerMTok',
  'cacheReadPerMTok',
  'cacheWritePerMTok',
])

function issueReason(err: z.ZodError, input: unknown): { field?: string; reason: string } {
  const issue = err.issues[0]
  if (issue === undefined) return { reason: 'does not match the price list format' }
  const field = typeof issue.path[0] === 'string' ? issue.path[0] : undefined
  const value =
    field !== undefined && input !== null && typeof input === 'object'
      ? (input as Record<string, unknown>)[field]
      : undefined
  let what: string
  if (issue.code === 'invalid_type')
    what =
      value === undefined
        ? 'is missing'
        : `is not ${issue.expected === 'number' ? 'a number' : issue.expected}`
  else if (issue.code === 'too_big') what = 'is too large'
  else if (issue.code === 'too_small') what = 'is too small'
  else what = issue.message.startsWith('is ') ? issue.message : 'is not valid'
  return field !== undefined ? { field, reason: `${field} ${what}` } : { reason: what }
}

/** A short, safe rendering of a refused value for the rejected list. */
function valueFor(v: unknown): unknown {
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v
  if (typeof v === 'string') return cleanText(v, 80)
  return null
}

const label = (v: unknown, max: number): string => (typeof v === 'string' ? cleanText(v, max) : '')

/**
 * Check the answer against the template's output schema, entry by entry. The answer is data from the web: only
 * well-formed entries for the vendors being refreshed become proposals; every other entry or new model becomes a
 * rejected row with its reason. Fails only when the answer is not a price list at all.
 */
export function parseRefreshProposal(
  value: unknown,
  o: { vendors: readonly VendorId[]; now: number },
): ParseProposalResult {
  let size: number
  try {
    size = JSON.stringify(value)?.length ?? 0
  } catch {
    return { ok: false, error: 'The answer is not JSON data.' }
  }
  if (size > ANSWER_MAX_CHARS) {
    return { ok: false, error: `The answer is too large (${Math.ceil(size / 1000)} KB).` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'The answer is not a price list (expected one JSON object).' }
  }
  const top = AnswerInZ.safeParse(value)
  if (!top.success) {
    const r = issueReason(top.error, value)
    return { ok: false, error: `The answer does not match the price list format: ${r.reason}.` }
  }
  const notes: string[] = []
  const rejected: CatalogRejectedRow[] = []
  const vendors = new Set<string>(o.vendors)
  const mentioned: { vendor: string; model: string }[] = []
  const seenMention = new Set<string>()
  const mention = (raw: unknown, key: 'model' | 'id'): void => {
    if (raw === null || typeof raw !== 'object') return
    const rec = raw as Record<string, unknown>
    const vendor = rec['vendor']
    const id = rec[key]
    if (typeof vendor !== 'string' || typeof id !== 'string' || !vendors.has(vendor)) return
    const model = cleanText(id, 128)
    const k = `${vendor}/${normalizeModelId(model)}`
    if (model === '' || seenMention.has(k)) return
    seenMention.add(k)
    mentioned.push({ vendor, model })
  }
  const extra = Object.keys(value).filter(
    (k) => !['generatedAt', 'entries', 'newModels', 'unverifiable'].includes(k),
  )
  if (extra.length > 0)
    notes.push(
      `Dropped unknown fields: ${extra
        .slice(0, 10)
        .map((k) => cleanText(k, 40))
        .join(', ')}`,
    )

  const generatedAt =
    typeof top.data.generatedAt === 'string' && top.data.generatedAt.trim() !== ''
      ? cleanText(top.data.generatedAt, 64)
      : new Date(o.now).toISOString()

  // ---- entries
  const entries: ProposedPrice[] = []
  const seen = new Set<string>()
  const rawEntries = top.data.entries
  if (rawEntries.length > ENTRIES_MAX)
    notes.push(`Kept the first ${ENTRIES_MAX} of ${rawEntries.length} entries`)
  for (const raw of rawEntries.slice(0, ENTRIES_MAX)) {
    mention(raw, 'model')
    const rec = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const vendorLabel = label(rec['vendor'], 32) || 'unknown'
    const modelLabel = label(rec['model'], 128)
    const r = EntryInZ.safeParse(raw)
    if (!r.success) {
      const why = issueReason(r.error, raw)
      const row: CatalogRejectedRow = {
        vendor: vendorLabel,
        model: modelLabel,
        value: why.field !== undefined ? valueFor(rec[why.field]) : null,
        reason: why.reason,
      }
      if (why.field !== undefined && PRICE_FIELD_SET.has(why.field)) row.field = why.field as PriceField
      rejected.push(row)
      continue
    }
    const e = r.data
    if (!vendors.has(e.vendor)) {
      rejected.push({
        vendor: vendorLabel,
        model: e.model,
        value: null,
        reason: `${vendorLabel} is not being refreshed`,
      })
      continue
    }
    const quote = cleanText(e.sourceQuote, QUOTE_MAX)
    if (quote === '') {
      rejected.push({ vendor: e.vendor, model: e.model, value: null, reason: 'sourceQuote is empty' })
      continue
    }
    const key = `${e.vendor}\u0000${normalizeModelId(e.model)}`
    if (seen.has(key)) {
      rejected.push({ vendor: e.vendor, model: e.model, value: null, reason: 'listed twice' })
      continue
    }
    seen.add(key)
    const aliases: string[] = []
    let badAliases = 0
    for (const a of e.aliases ?? []) {
      if (typeof a === 'string' && MODEL_ID_PATTERN.test(a)) {
        if (!aliases.includes(a) && a !== e.model) aliases.push(a)
      } else badAliases++
    }
    if (badAliases > 0)
      notes.push(`${e.vendor}/${e.model}: dropped ${badAliases} aliases that are not model ids`)
    if (aliases.length > ALIASES_MAX) notes.push(`${e.vendor}/${e.model}: kept ${ALIASES_MAX} aliases`)
    const out: ProposedPrice = {
      vendor: e.vendor,
      model: e.model,
      aliases: aliases.slice(0, ALIASES_MAX),
      inputPerMTok: e.inputPerMTok,
      outputPerMTok: e.outputPerMTok,
      cacheReadPerMTok: e.cacheReadPerMTok,
      cacheWritePerMTok: e.cacheWritePerMTok,
      sourceUrl: e.sourceUrl,
      sourceQuote: quote,
    }
    if (e.deprecated === true) out.deprecated = true
    entries.push(out)
  }

  // ---- new models
  const newModels: ProposedModel[] = []
  const rawModels = top.data.newModels ?? []
  if (rawModels.length > NEW_MODELS_MAX)
    notes.push(`Kept the first ${NEW_MODELS_MAX} of ${rawModels.length} new models`)
  const seenModels = new Set<string>()
  for (const raw of rawModels.slice(0, NEW_MODELS_MAX)) {
    mention(raw, 'id')
    const rec = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const vendorLabel = label(rec['vendor'], 32) || 'unknown'
    const r = NewModelInZ.safeParse(raw)
    if (!r.success) {
      const why = issueReason(r.error, raw)
      rejected.push({
        vendor: vendorLabel,
        model: label(rec['id'], 128),
        value: why.field !== undefined ? valueFor(rec[why.field]) : null,
        reason: `New model: ${why.reason}`,
      })
      continue
    }
    const m = r.data
    if (!vendors.has(m.vendor)) {
      rejected.push({
        vendor: vendorLabel,
        model: m.id,
        value: null,
        reason: `New model: ${vendorLabel} is not being refreshed`,
      })
      continue
    }
    const key = `${m.vendor}\u0000${normalizeModelId(m.id)}`
    if (seenModels.has(key)) continue
    seenModels.add(key)
    const out: ProposedModel = { vendor: m.vendor, id: m.id, sourceUrl: m.sourceUrl }
    const name = typeof m.displayName === 'string' ? cleanText(m.displayName, DISPLAY_NAME_MAX) : ''
    if (name !== '') out.displayName = name
    if (typeof m.contextWindow === 'number') out.contextWindow = m.contextWindow
    newModels.push(out)
  }

  // ---- unverifiable
  const unverifiable: CatalogUnverifiable[] = []
  const rawUnverifiable = top.data.unverifiable ?? []
  let droppedUnverifiable = 0
  for (const raw of rawUnverifiable.slice(0, UNVERIFIABLE_MAX)) {
    mention(raw, 'model')
    const r = UnverifiableInZ.safeParse(raw)
    if (!r.success || !vendors.has(r.data.vendor)) {
      droppedUnverifiable++
      continue
    }
    const model = cleanText(r.data.model, 128)
    if (model === '') {
      droppedUnverifiable++
      continue
    }
    unverifiable.push({ vendor: r.data.vendor, model, reason: cleanText(r.data.reason, REASON_MAX) })
  }
  if (rawUnverifiable.length > UNVERIFIABLE_MAX)
    notes.push(`Kept the first ${UNVERIFIABLE_MAX} of ${rawUnverifiable.length} unverifiable models`)
  if (droppedUnverifiable > 0) notes.push(`Dropped ${droppedUnverifiable} malformed unverifiable items`)

  return { ok: true, proposal: { generatedAt, entries, newModels, unverifiable }, rejected, notes, mentioned }
}

// ---- job files ---------------------------------------------------------------------------------------------------------

/** `catalog/jobs/<id>/`: the job's cwd and its files (prompt.md, raw.ndjson, proposal.json, status.json). */
export function refreshJobDir(home: string, jobId: string): string {
  return join(homePaths(home).catalogJobsDir, assertSafeSegment(jobId, 'catalog job id'))
}

export const JOB_FILES = {
  prompt: 'prompt.md',
  raw: 'raw.ndjson',
  proposal: 'proposal.json',
  status: 'status.json',
} as const

/** `catalog/jobs/<id>/status.json`. */
export interface RefreshJobStatus {
  schemaVersion: 1
  id: string
  state: CatalogJobState
  vendor: VendorId
  model: string | null
  startedAt: number
  endedAt?: number
  ranMs?: number
  /** Failed or cancelled: what happened, as the user reads it. */
  error?: string
  category?: FailureCategory
  /** The job's own spend (its usage; `costUsd` is the CLI's figure). */
  usage?: Usage
  costUsd?: number
  answerSource?: AnswerSource
  counts?: { entries: number; newModels: number; unverifiable: number; rejected: number }
  rejected?: CatalogRejectedRow[]
  notes?: string[]
  /** The official hosts the job could fetch from. */
  hosts?: string[]
  /** The vendors whose prices it checked (the review offers deprecation only for these). */
  vendors?: VendorId[]
  /** The hosts of its successful page fetches (a price sourced elsewhere is `notFetched`, validate.ts). */
  fetchedHosts?: string[]
  /** Every vendor/model the answer named, refused ones included (never "missing"). */
  mentioned?: { vendor: string; model: string }[]
}

export async function writeJobStatus(home: string, status: RefreshJobStatus): Promise<void> {
  await writeJsonAtomic(join(refreshJobDir(home, status.id), JOB_FILES.status), status)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** A job's status.json, or null when it is missing or unreadable. */
export async function readJobStatus(home: string, jobId: string): Promise<RefreshJobStatus | null> {
  try {
    const v: unknown = JSON.parse(await readFile(join(refreshJobDir(home, jobId), JOB_FILES.status), 'utf8'))
    if (
      !isObj(v) ||
      v['id'] !== jobId ||
      typeof v['startedAt'] !== 'number' ||
      typeof v['vendor'] !== 'string' ||
      !(CATALOG_JOB_STATES as readonly unknown[]).includes(v['state'])
    )
      return null
    const s = v as unknown as RefreshJobStatus
    if (s.category !== undefined && !isFailureCategory(s.category)) delete s.category
    return s
  } catch {
    return null
  }
}

/** Job ids under catalog/jobs/, newest first (ids sort by their UTC start stamp). */
export async function listJobIds(home: string): Promise<string[]> {
  try {
    const dirs = await readdir(homePaths(home).catalogJobsDir, { withFileTypes: true })
    return dirs
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

// ---- flags -------------------------------------------------------------------------------------------------------------

/**
 * The flags that keep the refresh read-only, web-limited and hermetic: the user's flagMap never renames them for this
 * spawn (as the healer's). Should the CLI really have renamed one, the job fails with the CLI's own error.
 */
const REFRESH_OWN_FLAGS: ReadonlySet<string> = new Set(
  [
    '--disallowedTools',
    '--allowedTools',
    '--tools',
    '--strict-mcp-config',
    '--settings',
    '--permission-prompts',
    '--permission-mode',
    '--no-session-persistence',
    // Codex (X17): its read-only sandbox, approvals and ephemeral thread (exec route: `--sandbox read-only`, …).
    '--sandbox',
    '-s',
    '--ask-for-approval',
    '--ephemeral',
    '--config',
  ].map(flagKey),
)

export function refreshFlagMap(
  flagMap: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (flagMap === undefined) return undefined
  const out = Object.fromEntries(
    Object.entries(flagMap).filter(([from]) => !REFRESH_OWN_FLAGS.has(flagKey(from))),
  )
  return Object.keys(out).length > 0 ? out : undefined
}

// ---- runRefreshJob -----------------------------------------------------------------------------------------------------

export type RefreshLog = { [K in 'info' | 'warn']: (msg: string, data?: Record<string, unknown>) => void }

export interface RefreshJobDeps {
  /** DIM_FACTORY_HOME. */
  home: string
  /** The refresh vendor's adapter: Claude, or Codex (X17). */
  adapter: Adapter
  /** The catalog at job start ({{currentCatalog}}). */
  catalog: CatalogData
  /** Vendors whose prices are refreshed (and whose official hosts the job may fetch). */
  vendors: readonly VendorId[]
  /** `vendors.<id>.flagMap`, filtered by {@link refreshFlagMap}; extraArgs never reach this spawn. */
  flagMap?: Readonly<Record<string, string>> | undefined
  /** `vendors.<id>.env` for the spawn (E2E fakes); credentials are never read. */
  env?: Record<string, string> | undefined
  /** Default 10 minutes. */
  timeoutMs?: number
  now?: () => number
  /** The template text (default internal/catalog-refresh.md). */
  template?: string
  /** A short, plain line on what the job does now ("Reading platform.claude.com"). */
  onProgress?: (text: string) => void
  log?: RefreshLog
}

export interface RefreshJobRequest {
  jobId: string
  vendor: VendorId
  model: string | null
  /** `YYYY-MM-DD` ({{today}}). */
  today: string
  /** Cancel: stops the process tree. */
  signal?: AbortSignal
}

export type RefreshJobResult =
  | ({
      ok: true
      answerSource: AnswerSource
      usage?: Usage
      ranMs: number
      /** The hosts of the job's successful page fetches. */
      fetchedHosts: string[]
    } & ParsedProposal)
  | { ok: false; failure: Failure; cancelled: boolean; usage?: Usage; ranMs: number }

type Conversation =
  | { kind: 'done'; text: string; structured: unknown }
  | { kind: 'failed'; failure: Failure; cancelled?: boolean }

/** Codex's web search item (`webSearch`; its `openPage` / `findInPage` / `other` actions name the pages read). */
const CODEX_WEB_TOOL = /^web[ _-]?search$/i

/** The adapter's "(+N more)" after the first page a Codex web search read (codex/map-item.ts). */
const MORE_PAGES = /\s\(\+\d+ more\)$/

/**
 * The host a finished page read, or null (not a page read, not done, refused or failed). Claude: a WebFetch. Codex
 * (X17): a web search item whose summary is the https page it opened (the first of several, the rest arrive as
 * {@link META_PAGES_READ}); a plain search (its summary is the query) reads no page.
 */
export function fetchedHostOf(
  e: Extract<NormalizedEvent, { type: 'tool' }>,
  vendor: VendorId = 'claude',
): string | null {
  if (e.phase !== 'end' || e.status !== 'ok') return null
  if (vendor === 'codex')
    return CODEX_WEB_TOOL.test(e.name) ? sourceHostOf(e.summary.trim().replace(MORE_PAGES, '')) : null
  if (e.name !== 'WebFetch') return null
  return sourceHostOf(e.summary)
}

/**
 * The https hosts of the pages a {@link META_PAGES_READ} signal names (live X17: a Codex web search that opened
 * several pages, on more than one host); none for any other signal.
 */
export function pageHostsOf(s: AdapterSignal): string[] {
  if (s.type !== 'meta' || s.key !== META_PAGES_READ || !isObj(s.value)) return []
  const urls = s.value['urls']
  if (!Array.isArray(urls)) return []
  return urls.flatMap((u) => {
    const host = typeof u === 'string' ? sourceHostOf(u) : null
    return host !== null ? [host] : []
  })
}

function delay(ms: number): Promise<'late'> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('late'), ms).unref()
  })
}

async function settleProcess(adapter: Adapter, handle: RunHandle): Promise<void> {
  const r = await Promise.race([handle.exited, delay(EXIT_GRACE_MS)])
  if (r !== 'late') return
  await adapter.stop(handle, 'user').catch(() => undefined)
  await Promise.race([handle.exited, delay(EXIT_GRACE_MS)])
}

function exitText(info: ExitInfo): string {
  return info.signal !== null ? `signal ${info.signal}` : `exit code ${info.code ?? 'unknown'}`
}

function minutes(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`
}

/** What a tool start means for the progress line; null leaves the line as it is. */
function progressFor(e: Extract<NormalizedEvent, { type: 'tool' }>): string | null {
  if (e.phase !== 'start') return null
  if (CODEX_WEB_TOOL.test(e.name) && e.name !== 'WebSearch') {
    const host = sourceHostOf(e.summary.trim())
    return host !== null ? `Reading ${host}` : 'Searching the web'
  }
  if (e.name === 'WebSearch') return 'Searching the web'
  if (e.name === 'WebFetch') {
    const host = sourceHostOf(e.summary)
    return host !== null ? `Reading ${host}` : 'Reading a page'
  }
  if (e.name === 'StructuredOutput') return 'Writing the price list'
  return null
}

const usageOf = (s: AdapterSignal): Usage | undefined =>
  s.type === 'meta' && s.key === META_USAGE && isObj(s.value) ? (s.value as unknown as Usage) : undefined

function converse(
  adapter: Adapter,
  opts: StartOptions,
  o: { timeoutMs: number; signal?: AbortSignal; onProgress?: (text: string) => void },
): {
  handle: RunHandle
  result: Promise<Conversation>
  usage: () => Usage | undefined
  fetchedHosts: () => string[]
} {
  const handle = adapter.start(opts)
  let text = ''
  let structured: unknown
  let usage: Usage | undefined
  let lastProgress = ''
  const fetched = new Set<string>()
  const result = new Promise<Conversation>((resolve) => {
    let settled = false
    const finish = (r: Conversation): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const timer = setTimeout(() => {
      finish({
        kind: 'failed',
        failure: {
          category: 'timeout_hard',
          message: `The price refresh took longer than ${minutes(o.timeoutMs)}, so Dim Factory stopped it.`,
          raw: '',
          classifiedBy: 'app',
        },
      })
      void adapter.stop(handle, 'timeout').catch(() => undefined)
    }, o.timeoutMs)
    const onAbort = (): void => {
      const shutdown = o.signal?.reason === 'shutdown'
      finish({
        kind: 'failed',
        cancelled: true,
        failure: {
          category: 'user_cancelled',
          message: shutdown
            ? 'Dim Factory closed during the price refresh.'
            : 'You cancelled the price refresh.',
          raw: '',
          classifiedBy: 'app',
        },
      })
      void adapter.stop(handle, shutdown ? 'shutdown' : 'user').catch(() => undefined)
    }
    if (o.signal?.aborted === true) onAbort()
    else o.signal?.addEventListener('abort', onAbort, { once: true })
    handle.onSignal((s) => {
      if (s.type === 'meta' && s.key === META_STRUCTURED_OUTPUT) structured = s.value
      for (const host of pageHostsOf(s)) fetched.add(host)
      const u = usageOf(s)
      if (u !== undefined) usage = u
    })
    handle.onEvent((e) => {
      switch (e.type) {
        case 'text':
          text += e.delta
          return
        case 'done':
          if (e.usage !== undefined) usage = e.usage
          finish({ kind: 'done', text: e.result.trim() !== '' ? e.result : text, structured })
          return
        case 'error':
          if (e.fatal) {
            finish({
              kind: 'failed',
              failure: {
                category: e.category ?? 'unknown',
                message: e.message,
                raw: e.raw.slice(0, ERROR_MAX),
                classifiedBy: e.classifiedBy ?? 'structured',
              },
            })
          }
          return
        case 'ask':
          // A read-only refresh never needs a permission; refuse anything that asks.
          adapter.answer(handle, e.requestId, 'deny')
          return
        case 'tool': {
          const host = fetchedHostOf(e, adapter.id)
          if (host !== null) fetched.add(host)
          const p = progressFor(e)
          if (p !== null && p !== lastProgress) {
            lastProgress = p
            o.onProgress?.(p)
          }
          return
        }
        case 'session':
          return
      }
    })
    void handle.exited.then((info) =>
      finish({
        kind: 'failed',
        failure: {
          category: 'process_crash',
          message: `${adapter.displayName} ended without an answer (${exitText(info)}).`,
          raw: '',
          classifiedBy: 'app',
        },
      }),
    )
  })
  return { handle, result, usage: () => usage, fetchedHosts: () => [...fetched].sort() }
}

/**
 * Run one refresh: write the prompt, spawn the read-only web pass in the job folder, read its answer and check it.
 * Never throws: every problem (no CLI, a timeout, a cancel, an answer that is not a price list) is `{ok:false}` with a
 * Failure, and status.json says what happened. On success proposal.json holds the checked proposal and status.json
 * is `diff-ready` with the job's usage and cost.
 */
export async function runRefreshJob(deps: RefreshJobDeps, req: RefreshJobRequest): Promise<RefreshJobResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  let dir: string
  try {
    dir = refreshJobDir(deps.home, req.jobId)
  } catch (err) {
    return {
      ok: false,
      failure: {
        category: 'config_invalid',
        message: String(err instanceof Error ? err.message : err),
        raw: '',
        classifiedBy: 'app',
      },
      cancelled: false,
      ranMs: 0,
    }
  }
  const hosts = officialHosts(deps.vendors)
  const status: RefreshJobStatus = {
    schemaVersion: 1,
    id: req.jobId,
    state: 'running',
    vendor: req.vendor,
    model: req.model,
    startedAt,
    hosts,
    vendors: [...deps.vendors],
  }
  const end = async (patch: Partial<RefreshJobStatus>): Promise<void> => {
    Object.assign(status, patch, { endedAt: now(), ranMs: now() - startedAt })
    await writeJobStatus(deps.home, status).catch((err: unknown) =>
      deps.log?.warn('catalog job status write failed', { jobId: req.jobId, err: String(err) }),
    )
  }
  const fail = async (failure: Failure, cancelled: boolean, usage?: Usage): Promise<RefreshJobResult> => {
    await end({
      state: cancelled ? 'cancelled' : 'failed',
      error: failure.message,
      category: failure.category,
      ...(usage !== undefined ? { usage } : {}),
      ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    })
    deps.log?.warn('catalog refresh failed', { jobId: req.jobId, category: failure.category, cancelled })
    return {
      ok: false,
      failure,
      cancelled,
      ...(usage !== undefined ? { usage } : {}),
      ranMs: now() - startedAt,
    }
  }
  const dimFactoryFailure = (category: FailureCategory, message: string): Failure => ({
    category,
    message,
    raw: '',
    classifiedBy: 'app',
  })

  try {
    await mkdir(dir, { recursive: true })
    await writeJobStatus(deps.home, status)
  } catch (err) {
    return {
      ok: false,
      failure: dimFactoryFailure('disk_full', `Dim Factory could not create the job folder: ${String(err)}`),
      cancelled: false,
      ranMs: 0,
    }
  }
  if (req.signal?.aborted === true)
    return fail(dimFactoryFailure('user_cancelled', 'You cancelled the price refresh.'), true)

  const schema = refreshJsonSchema(deps.vendors)
  let prompt: string
  try {
    prompt = renderRefreshPrompt(
      { vendors: deps.vendors, catalog: deps.catalog, today: req.today, schema },
      deps.template,
    )
  } catch (err) {
    return fail(dimFactoryFailure('config_invalid', err instanceof Error ? err.message : String(err)), false)
  }
  await writeFile(join(dir, JOB_FILES.prompt), prompt, { encoding: 'utf8', mode: 0o600 }).catch(
    () => undefined,
  )

  const raw = new RawLog(join(dir, JOB_FILES.raw), now(), homedir())
  const flagMap = refreshFlagMap(deps.flagMap)
  const opts: StartOptions = {
    runId: req.jobId,
    step: 'catalog',
    cwd: dir,
    prompt,
    model: req.model,
    mode: 'readonly',
    planNative: false,
    allowRules: [],
    trustFolder: false,
    ephemeral: true,
    askTimeoutMs: REFRESH_ASK_TIMEOUT_MS,
    web: { allowedDomains: hosts },
    outputSchema: schema,
    tap: (d, line) => raw.write(d, line),
    ...(flagMap !== undefined ? { flagMap } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  }
  deps.log?.info('catalog refresh started', { jobId: req.jobId, vendor: req.vendor, model: req.model, hosts })
  let talk: ReturnType<typeof converse>
  try {
    talk = converse(deps.adapter, opts, {
      timeoutMs: deps.timeoutMs ?? REFRESH_TIMEOUT_MS,
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
    })
  } catch (err) {
    await raw.close()
    return fail(
      dimFactoryFailure(
        'unknown',
        `Could not start ${deps.adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
      ),
      false,
    )
  }
  const r = await talk.result
  await settleProcess(deps.adapter, talk.handle)
  await raw.close()
  const usage = talk.usage()
  const fetchedHosts = talk.fetchedHosts()
  status.fetchedHosts = fetchedHosts
  if (r.kind === 'failed') return fail(r.failure, r.cancelled === true, usage)

  const answer = extractRefreshAnswer(r.structured, r.text)
  if (!answer.ok) return fail(dimFactoryFailure('stream_malformed', answer.error), false, usage)
  const parsed = parseRefreshProposal(answer.value, { vendors: deps.vendors, now: now() })
  if (!parsed.ok) return fail(dimFactoryFailure('stream_malformed', parsed.error), false, usage)

  try {
    await writeJsonAtomic(join(dir, JOB_FILES.proposal), parsed.proposal)
  } catch (err) {
    return fail(
      dimFactoryFailure('disk_full', `Dim Factory could not save the proposal: ${String(err)}`),
      false,
      usage,
    )
  }
  await end({
    state: 'diff-ready',
    answerSource: answer.source,
    counts: {
      entries: parsed.proposal.entries.length,
      newModels: parsed.proposal.newModels.length,
      unverifiable: parsed.proposal.unverifiable.length,
      rejected: parsed.rejected.length,
    },
    rejected: parsed.rejected,
    notes: parsed.notes,
    mentioned: parsed.mentioned,
    ...(usage !== undefined ? { usage } : {}),
    ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
  })
  deps.log?.info('catalog refresh answered', {
    jobId: req.jobId,
    source: answer.source,
    entries: parsed.proposal.entries.length,
    rejected: parsed.rejected.length,
  })
  return {
    ok: true,
    proposal: parsed.proposal,
    rejected: parsed.rejected,
    notes: parsed.notes,
    mentioned: parsed.mentioned,
    fetchedHosts,
    answerSource: answer.source,
    ...(usage !== undefined ? { usage } : {}),
    ranMs: now() - startedAt,
  }
}

/** The display name of a vendor for copy ("Claude"). */
export function vendorDisplayName(vendor: VendorId): string {
  return (VENDOR_DISPLAY_NAMES as Readonly<Record<string, string>>)[vendor] ?? vendor
}
