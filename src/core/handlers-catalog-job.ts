// Refresh-job commands (the consent card; `consent: z.literal(true)`):
// `catalog.refreshPlan`, `catalog.refresh` and `catalog.cancel`. A HandlerMap fragment createHandlers spreads in; the
// core's side is `ctx.catalogJobs` (catalog/refresh-jobs.ts, wired in app-core.ts), so a context without it answers
// UNSUPPORTED. The refresh never auto-runs: only a request whose `consent` is literally `true` starts a job.
import type { CatalogRefreshPlan } from '../shared/catalog.ts'
import { ModelIdZ, VendorIdZ } from '../shared/config-schema.ts'
import type { VendorId } from '../shared/vendors.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'

/** What the refresh commands need from the core (refresh-jobs.ts `CatalogJobs`). */
export interface CatalogJobHost {
  plan(): Promise<CatalogRefreshPlan>
  start(req: { vendor?: VendorId; model?: string | null }): Promise<{ jobId: string }>
  cancel(jobId: string): Promise<void>
}

/** Commands of the refresh job (the apply, undo, edit and schedule commands are their own module). */
export const CATALOG_JOB_COMMANDS = ['catalog.refreshPlan', 'catalog.refresh', 'catalog.cancel'] as const

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function need(cond: unknown, message: string): void {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

export const CONSENT_MESSAGE =
  'A price refresh starts only from your click on Update now (consent must be true).'

export function catalogJobHandlers(ctx: HandlerContext): HandlerMap {
  const host = (write: boolean): CatalogJobHost => {
    if (write && ctx.readOnly)
      throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
    const h = ctx.catalogJobs
    if (h === undefined) throw new DimFactoryError('UNSUPPORTED', 'Price refresh is not available here.')
    return h
  }
  return {
    'catalog.refreshPlan': () => host(false).plan(),
    'catalog.refresh': (req) => {
      // Checked before anything else: no consent, no job, whatever else the request says.
      need(isObj(req) && req.consent === true, CONSENT_MESSAGE)
      const known = new Set(['consent', 'vendor', 'model'])
      const extra = Object.keys(req).filter((k) => !known.has(k))
      need(extra.length === 0, `Unknown field ${JSON.stringify(extra[0])} in catalog.refresh`)
      need(req.vendor === undefined || VendorIdZ.safeParse(req.vendor).success, 'vendor must be a vendor id')
      need(
        req.model === undefined || ModelIdZ.safeParse(req.model).success,
        'model must be a model id or null',
      )
      const start: { vendor?: VendorId; model?: string | null } = {}
      if (req.vendor !== undefined) start.vendor = req.vendor
      if (req.model !== undefined) start.model = req.model
      return host(true).start(start)
    },
    'catalog.cancel': (req) => {
      need(isObj(req) && typeof req.jobId === 'string' && req.jobId !== '', 'jobId is required')
      return host(true).cancel(req.jobId)
    },
  }
}
