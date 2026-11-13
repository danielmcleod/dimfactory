// Settings → Catalog's words and checks. Core validates every proposed row and sets its flags and default tick (core/catalog/validate.ts);
// this file only names them. Core's rows are read defensively: every field of the diff is checked before use, and a
// flag or kind this build does not know is still shown, in words made from its name.
import type {
  CatalogDiffRow,
  CatalogHistoryEntry,
  CatalogRejectedRow,
  CatalogSchedule,
  CatalogScheduleUpdate,
  CatalogState,
  PriceField,
} from '@shared/catalog.ts'

// ---- prices ---------------------------------------------------------------------------------------------------------

export const NO_PRICE_TEXT = 'No price'

/** US dollars per million tokens: `$4.00`, `$0.20`, `$0.075`. */
export function formatPrice(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return NO_PRICE_TEXT
  const fixed = usd.toFixed(4).replace(/0+$/, '')
  const [whole, frac = ''] = fixed.split('.')
  return `$${whole}.${frac.padEnd(2, '0')}`
}

export function formatDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export const PRICE_FIELD_LABEL: Readonly<Record<PriceField, string>> = {
  inputPerMTok: 'Input',
  outputPerMTok: 'Output',
  cacheReadPerMTok: 'Cache read',
  cacheWritePerMTok: 'Cache write',
}

/** The highest price per million tokens the validator accepts (a price ≤ 0 or > 1000 is rejected). */
export const PRICE_MAX = 1000
const PRICE_TEXT = /^\d+(?:\.\d+)?$|^\.\d+$/
const MAX_DECIMALS = 6

export type PriceParse = { ok: true; value: number | null } | { ok: false; message: string }

/** The words for a price of $0 (the validator's lower bound; a cache price with none is left empty instead). */
export const PRICE_ABOVE_ZERO = 'More than $0 and at most $1,000 per million tokens.'

/**
 * A price typed in a table cell: `3`, `0.30`, `$15`. Input and output are required; a cache price may be left empty
 * ("No price"). The bounds are the validator's (more than $0, at most $1,000; $0 is refused here too, so
 * the row says so instead of core's toast), so a saved price would also pass an update's checks.
 */
export function parsePriceInput(text: string, required: boolean): PriceParse {
  const t = text.trim().replace(/^\$\s*/, '')
  if (t === '') return required ? { ok: false, message: 'Enter a price.' } : { ok: true, value: null }
  if (!PRICE_TEXT.test(t)) return { ok: false, message: 'Use a number such as 3 or 0.30.' }
  const decimals = t.includes('.') ? (t.split('.')[1]?.length ?? 0) : 0
  if (decimals > MAX_DECIMALS) return { ok: false, message: `Use at most ${MAX_DECIMALS} decimals.` }
  const value = Number(t)
  if (!Number.isFinite(value)) return { ok: false, message: 'Use a number such as 3 or 0.30.' }
  if (value <= 0) return { ok: false, message: PRICE_ABOVE_ZERO }
  if (value > PRICE_MAX) return { ok: false, message: 'At most $1,000 per million tokens.' }
  return { ok: true, value }
}

/** What a cell's box shows when an edit starts: the price as typed, without the dollar sign; empty for none. */
export function priceInputText(usd: number | null): string {
  return usd === null ? '' : String(usd)
}

const MODEL_ID = /^[\w.:@/[\]-]+$/

/** A model id for a new price (the config's model id rule). */
export function parseModelId(text: string): { ok: true; model: string } | { ok: false; message: string } {
  const t = text.trim()
  if (t === '') return { ok: false, message: 'Enter the model id.' }
  if (t.length > 128) return { ok: false, message: 'Model ids are at most 128 characters.' }
  if (!MODEL_ID.test(t)) return { ok: false, message: 'Use letters, digits and . : @ / [ ] - _ only.' }
  return { ok: true, model: t }
}

// ---- diff rows ------------------------------------------------------------------------------------------------------

export type FlagTone = 'warn' | 'bad' | 'info'

export interface FlagInfo {
  label: string
  /** Why the row carries it (the chip's tooltip); core's own reason for the row is shown under the chips. */
  explain: string
  tone: FlagTone
}

const BIG_CHANGE: FlagInfo = {
  label: 'Over 50%',
  explain: 'The price changes by more than 50%, so the row starts unticked.',
  tone: 'warn',
}
const NOT_IN_CLI: FlagInfo = {
  label: 'Not in the CLI',
  explain: 'The CLI does not list this model.',
  tone: 'info',
}

/** Every flag core's validator sets (shared/catalog.ts CATALOG_DIFF_FLAGS), and the names it may use for them. */
const FLAG_INFO: Readonly<Record<string, FlagInfo>> = {
  bigChange: BIG_CHANGE,
  over50: BIG_CHANGE,
  suspicious: {
    label: 'Suspicious',
    explain: 'More than 10 times or under a tenth of the current price, so the row starts unticked.',
    tone: 'warn',
  },
  inconsistent: {
    label: 'Inconsistent',
    explain: 'Output would cost less than input, or a cache read more than input.',
    tone: 'warn',
  },
  outputBelowInput: {
    label: 'Output below input',
    explain: 'Output would cost less than input.',
    tone: 'warn',
  },
  cacheReadAboveInput: {
    label: 'Cache read above input',
    explain: 'A cache read would cost more than input.',
    tone: 'warn',
  },
  unofficial: {
    label: 'Unofficial source',
    explain: "The page it was read from is not on one of the vendor's official sites.",
    tone: 'warn',
  },
  notFetched: {
    label: 'Page not read',
    explain: 'The update read no page on this site, so the price is not confirmed. The row starts unticked.',
    tone: 'warn',
  },
  notReportedByCli: NOT_IN_CLI,
  notInCli: NOT_IN_CLI,
  userEdited: {
    label: 'You edited this',
    explain: 'You set this price yourself. Applying the row replaces it.',
    tone: 'warn',
  },
  deprecated: {
    label: 'Deprecated',
    explain:
      'The update no longer lists this model. Nothing is deleted: ticking the row marks it deprecated.',
    tone: 'info',
  },
  rejected: {
    label: 'Rejected',
    explain: 'At most $0 or over $1,000 per million tokens, so it cannot be applied.',
    tone: 'bad',
  },
}

/** A flag's chip: core's known flags in words, any other one from its name (`someFlag` → "Some flag"). */
export function flagInfo(flag: string): FlagInfo {
  const known = FLAG_INFO[flag]
  if (known !== undefined) return known
  const words = flag
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
  return { label: words.charAt(0).toUpperCase() + words.slice(1), explain: '', tone: 'info' }
}

const flagsOf = (row: CatalogDiffRow): readonly string[] => (Array.isArray(row.flags) ? row.flags : [])

/** A row core will not apply (a `rejected` flag): shown, never tickable. */
export function isRejected(row: CatalogDiffRow): boolean {
  return flagsOf(row).includes('rejected')
}

export function rowFlags(row: CatalogDiffRow): string[] {
  return [...new Set(flagsOf(row))]
}

/** The kind of change, in the names core may use. */
export function rowKind(row: CatalogDiffRow): 'price' | 'confirm' | 'new-model' | 'deprecate' {
  const k = row.kind as string
  if (k === 'new-model' || k === 'model') return 'new-model'
  if (k === 'deprecate' || k === 'deprecated') return 'deprecate'
  if (k === 'confirm') return 'confirm'
  return 'price'
}

/**
 * What the row changes: `Input`, `New model`, `Mark deprecated`; `Confirm prices` (the page repeats the
 * stored prices; ticked, they are recorded as verified with that page, today).
 */
export function rowWhat(row: CatalogDiffRow): string {
  switch (rowKind(row)) {
    case 'new-model':
      return 'New model'
    case 'deprecate':
      return 'Mark deprecated'
    case 'confirm':
      return 'Confirm prices'
    case 'price':
      return row.field !== undefined && row.field in PRICE_FIELD_LABEL
        ? PRICE_FIELD_LABEL[row.field]
        : 'Price'
  }
}

const MINUS = '−'

/** `+25%`, `−40%` (core's deltaPct, whole percent); null when core gives none. */
export function deltaText(pct: number | null | undefined): string | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null
  const r = Math.round(pct)
  if (r === 0) return pct === 0 ? '0%' : pct > 0 ? '+<1%' : `${MINUS}<1%`
  return r > 0 ? `+${r}%` : `${MINUS}${Math.abs(r)}%`
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The row's old and new side in words. */
export function rowChange(row: CatalogDiffRow): { from: string; to: string; delta: string | null } {
  switch (rowKind(row)) {
    case 'new-model':
      return { from: 'Not listed', to: 'Listed', delta: null }
    case 'deprecate':
      return { from: 'Listed', to: 'Deprecated', delta: null }
    case 'confirm':
      return { from: 'Unchanged', to: 'Verified', delta: null }
    case 'price':
      return {
        from: formatPrice(num(row.current)),
        to: formatPrice(num(row.proposed)),
        delta: deltaText(row.deltaPct),
      }
  }
}

/** The host of a source page, or null when it is no URL. */
export function hostOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** A rejected proposal core lists apart (`CatalogDiff.rejected`): its value in words. */
export function rejectedValue(r: CatalogRejectedRow): string {
  const v = num(r.value)
  return v !== null ? formatPrice(v) : 'Not a price'
}

/** The rows' default ticks: core's `ticked`, never for a rejected row. */
export function defaultTicks(rows: readonly CatalogDiffRow[]): Set<string> {
  return new Set(rows.filter((r) => r.ticked === true && !isRejected(r)).map((r) => r.id))
}

/** Apply's label for N ticked rows. */
export function applyLabel(n: number): string {
  return n === 1 ? 'Apply 1 change' : `Apply ${n} changes`
}

/** Every label Apply can show for a diff of `total` rows (the button keeps the widest). */
export function applyLabels(total: number): string[] {
  return Array.from({ length: total + 1 }, (_, n) => applyLabel(n))
}

// ---- schedule -------------------------------------------------------------------------------------------------------

/** The schedule presets Off/7/14/30 (14 by default). */
export const SCHEDULE_PRESETS = [
  { value: 'off', label: 'Off' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
] as const

export function scheduleValue(s: Pick<CatalogSchedule, 'enabled' | 'intervalDays'>): string {
  return s.enabled ? String(s.intervalDays) : 'off'
}

/** The label of a schedule value; an interval set in the file that is no preset reads `10 days`. */
export function scheduleLabel(value: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.value === value)
  return preset !== undefined ? preset.label : `${value} days`
}

/** The catalog.setSchedule request for a chosen value. */
export function scheduleUpdate(value: string): CatalogScheduleUpdate {
  return value === 'off' ? { enabled: false } : { enabled: true, intervalDays: Number(value) }
}

/** The request that puts a schedule back (Undo). */
export function scheduleRestore(s: Pick<CatalogSchedule, 'enabled' | 'intervalDays'>): CatalogScheduleUpdate {
  return { enabled: s.enabled, intervalDays: s.intervalDays }
}

export function scheduleSaid(value: string): string {
  return value === 'off' ? 'Price checks are off' : `Dim Factory checks prices every ${scheduleLabel(value)}`
}

/** Core's schedule facts in one line: when prices were last updated and when Dim Factory asks next. */
export function scheduleFacts(s: CatalogSchedule, due: boolean, now: number): string {
  const last =
    s.lastRefreshAt !== null
      ? `Last updated with AI on ${formatDay(s.lastRefreshAt)}.`
      : 'Never updated with AI.'
  if (!s.enabled) return `${last} Dim Factory does not ask.`
  if (due) return `${last} An update is due.`
  if (s.snoozedUntil !== null && s.snoozedUntil > now)
    return `${last} Asks again on ${formatDay(s.snoozedUntil)}.`
  if (s.nextDueAt !== null) return `${last} Asks again on ${formatDay(s.nextDueAt)}.`
  return last
}

// ---- history --------------------------------------------------------------------------------------------------------

export const HISTORY_SOURCE: Readonly<Record<CatalogHistoryEntry['source'], string>> = {
  refresh: 'AI update',
  manual: 'Price edited by you',
  undo: 'Undo',
  restore: 'Restored',
}

export function historySource(source: string): string {
  return (HISTORY_SOURCE as Readonly<Record<string, string>>)[source] ?? source
}

export function priceCount(n: number): string {
  return n === 1 ? '1 price' : `${n} prices`
}

/**
 * The history entry catalog.undo puts back now: core's `undoId` (null: nothing to undo), else, from a core that does
 * not send it, the newest entry not marked undone.
 */
export function undoableId(state: Pick<CatalogState, 'history' | 'undoId'>): string | null {
  if (state.undoId !== undefined) return state.undoId
  return state.history.find((h) => h.undone !== true)?.id ?? null
}
