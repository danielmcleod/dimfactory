// Catalog data commands (Apply/Undo/manual edits, Settings → Catalog): `catalog.get` (with the newest refresh job,
// its diff review and the history), `catalog.apply`,
// `catalog.undo`, `catalog.savePrice`, `catalog.setSchedule`. A HandlerMap fragment createHandlers spreads in; the
// core's live catalog comes through `ctx.catalog` (catalog/live.ts), read when a command runs. Without it,
// `catalog.get` answers read-only (handlers-dashboard.ts) and the writes are UNSUPPORTED. The refresh itself
// (`catalog.refresh`, `refreshPlan`, `cancel`) is the refresh job's.
import { PRICE_FIELDS } from '../shared/catalog.ts'
import type { CatalogSchedule, CatalogScheduleUpdate, CatalogState, PriceEdit } from '../shared/catalog.ts'
import type { Cmd } from '../shared/ipc.ts'
import { DimFactoryError } from './errors.ts'
import { dashboardHandlers } from './handlers-dashboard.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'

/** What the commands need from the core (catalog/live.ts CatalogLive implements it). */
export interface CatalogDataHost {
  state(): Promise<CatalogState>
  apply(jobId: string, rowIds: readonly string[]): Promise<CatalogState>
  undo(): Promise<CatalogState>
  savePrice(edit: PriceEdit): Promise<CatalogState>
  setSchedule(u: CatalogScheduleUpdate): Promise<CatalogSchedule>
}

/** Commands of the catalog data side (`catalog.get` also has a read-only answer in handlers-dashboard.ts). */
export const CATALOG_DATA_COMMANDS = [
  'catalog.apply',
  'catalog.undo',
  'catalog.savePrice',
  'catalog.setSchedule',
] as const satisfies readonly Cmd[]

const ID_MAX = 128
const ROWS_MAX = 10_000

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX

const optionalDays = (v: unknown): boolean =>
  v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365)

function priceEditOf(v: unknown): PriceEdit {
  need(isObj(v), 'entry must be an object')
  need(typeof v['vendor'] === 'string' && v['vendor'] !== '', 'entry.vendor is required')
  need(typeof v['model'] === 'string' && v['model'] !== '', 'entry.model is required')
  for (const f of PRICE_FIELDS) {
    const x = v[f]
    const nullable = f === 'cacheReadPerMTok' || f === 'cacheWritePerMTok'
    need(
      typeof x === 'number' || (nullable && x === null),
      `entry.${f} must be a number${nullable ? ' or null' : ''}`,
    )
  }
  const aliases = v['aliases']
  need(
    aliases === undefined || (Array.isArray(aliases) && aliases.every((a) => typeof a === 'string')),
    'entry.aliases must be a list of model ids',
  )
  need(v['sourceUrl'] === undefined || typeof v['sourceUrl'] === 'string', 'entry.sourceUrl must be a string')
  const edit: PriceEdit = {
    vendor: v['vendor'],
    model: v['model'],
    inputPerMTok: v['inputPerMTok'] as number,
    outputPerMTok: v['outputPerMTok'] as number,
    cacheReadPerMTok: v['cacheReadPerMTok'] as number | null,
    cacheWritePerMTok: v['cacheWritePerMTok'] as number | null,
  }
  if (Array.isArray(aliases)) edit.aliases = aliases
  if (typeof v['sourceUrl'] === 'string') edit.sourceUrl = v['sourceUrl']
  return edit
}

export function catalogDataHandlers(ctx: HandlerContext): HandlerMap {
  const catalogGet = dashboardHandlers(ctx)['catalog.get']
  const host = (): CatalogDataHost => {
    if (ctx.catalog === undefined) {
      throw new DimFactoryError('UNSUPPORTED', 'The model catalog is not available here.')
    }
    return ctx.catalog
  }
  const writable = (): CatalogDataHost => {
    const h = host()
    if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
    return h
  }
  return {
    'catalog.get': (req) => {
      if (ctx.catalog !== undefined) return ctx.catalog.state()
      if (catalogGet === undefined)
        throw new DimFactoryError('UNSUPPORTED', 'The model catalog is not available here.')
      return catalogGet(req)
    },
    'catalog.apply': (req) => {
      need(isObj(req) && isId(req.jobId), 'jobId is required')
      need(
        Array.isArray(req.rowIds) && req.rowIds.length <= ROWS_MAX && req.rowIds.every(isId),
        'rowIds must be a list of row ids',
      )
      return writable().apply(req.jobId, req.rowIds)
    },
    'catalog.undo': () => writable().undo(),
    'catalog.savePrice': (req) => {
      need(isObj(req), 'entry is required')
      return writable().savePrice(priceEditOf(req.entry))
    },
    'catalog.setSchedule': (req) => {
      const r: unknown = req
      need(isObj(r), 'a schedule change is required')
      const { enabled, intervalDays, snoozeDays } = r
      need(enabled === undefined || typeof enabled === 'boolean', 'enabled must be true or false')
      need(optionalDays(intervalDays), 'intervalDays must be 1 to 365')
      need(optionalDays(snoozeDays), 'snoozeDays must be 1 to 365')
      const u: CatalogScheduleUpdate = {}
      if (typeof enabled === 'boolean') u.enabled = enabled
      if (typeof intervalDays === 'number') u.intervalDays = intervalDays
      if (typeof snoozeDays === 'number') u.snoozeDays = snoozeDays
      return writable().setSchedule(u)
    },
  }
}
