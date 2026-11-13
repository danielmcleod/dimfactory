// Dashboard commands (estimates and the Dashboard's data):
// `estimates.get`, `dashboard.get`, `stats.get`, `usage.get` (the Plops page), `folders.recent`; and a read-only `catalog.get` (Settings →
// Catalog). A HandlerMap fragment createHandlers spreads in.
// Everything a handler needs from the core beyond HandlerContext comes through `ctx.dashboard` (app-core.ts), read
// when a command runs, so a context without it answers UNSUPPORTED instead of failing at creation.
import { isAbsolute, resolve } from 'node:path'
import type { CatalogStatus } from '../shared/catalog.ts'
import type { RunOverrides } from '../shared/config-schema.ts'
import type { BriefInput } from '../shared/brief.ts'
import type { RunEstimate } from '../shared/estimates.ts'
import type { CheckResult } from '../shared/preflight.ts'
import { STATS_RANGES } from '../shared/estimates.ts'
import { USAGE_RANGES } from '../shared/usage.ts'
import type { ProbeView } from '../shared/vendors.ts'
import type { CatalogData } from './catalog/store.ts'
import { buildDashboard } from './dashboard/dashboard.ts'
import { folderFacts, recentFolders } from './dashboard/recent-folders.ts'
import type { FolderFactsLookup } from './dashboard/recent-folders.ts'
import { buildStats } from './dashboard/stats.ts'
import type { SpendPricing } from './dashboard/stats.ts'
import { buildUsage } from './dashboard/usage.ts'
import { readContextReport } from './context/report.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'
import type { Attention } from './supervisor/attention.ts'

/** What the dashboard commands need from the core (app-core.ts implements it). */
export interface DashboardDeps {
  /** The same aggregate as Core.attention() (loaded runs, plus runs left waiting, paused or failed at boot). */
  attention(): Attention
  /** One row per registered vendor, as `vendors.list` answers. */
  vendorHealth(): ProbeView[]
  catalogStatus(): Promise<CatalogStatus>
  /** `catalog.get`: the catalog the core loaded (undefined: a read-only core, or the catalog failed to load). */
  catalogData?(): CatalogData | undefined
  /** Step pricing for the spend split. */
  readonly pricing: SpendPricing
  /** `estimates.get`: the config resolved exactly as `runs.start` would (VALIDATION when it does not resolve). */
  estimate(
    folder: string,
    overrides?: RunOverrides,
    brief?: BriefInput,
    recipe?: string,
  ): Promise<RunEstimate>
  /** Default: recent-folders.ts `folderFacts` (stat-only). */
  folderFacts?: FolderFactsLookup
  /**
   * The app-scope checks of a folder-less live preflight (git, home, disk; cached per their TTLs), their fixes
   * executable through recovery.execute. Omitted: dashboard.get carries no `appChecks`.
   */
  appChecks?(): Promise<CheckResult[]>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function need(cond: unknown, message: string): void {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

export function dashboardHandlers(ctx: HandlerContext): HandlerMap {
  const deps = (): DashboardDeps => {
    const d = ctx.dashboard
    if (d === undefined) throw new DimFactoryError('UNSUPPORTED', 'Dashboard data is not available here.')
    return d
  }
  return {
    'estimates.get': (req) => {
      need(isObj(req) && typeof req.folder === 'string' && req.folder.trim() !== '', 'folder is required')
      need(req.overrides === undefined || isObj(req.overrides), 'overrides must be an object')
      const folder = isAbsolute(req.folder) ? req.folder : resolve(req.folder)
      return deps().estimate(folder, req.overrides, req.brief, req.recipe)
    },
    'dashboard.get': async () => {
      const d = deps()
      const [catalog, appChecks] = await Promise.all([d.catalogStatus(), d.appChecks?.()])
      const data = buildDashboard({
        now: ctx.now(),
        summaries: ctx.summaries(),
        attention: d.attention(),
        vendorHealth: d.vendorHealth(),
        catalog,
        pricing: d.pricing,
      })
      return appChecks !== undefined ? { ...data, appChecks } : data
    },
    'stats.get': (req) => {
      need(
        isObj(req) && (STATS_RANGES as readonly unknown[]).includes(req.range),
        `range must be one of ${STATS_RANGES.join(', ')}`,
      )
      return Promise.resolve(buildStats(ctx.summaries(), req.range, ctx.now(), deps().pricing))
    },
    'usage.get': (req) => {
      need(
        isObj(req) && (USAGE_RANGES as readonly unknown[]).includes(req.range),
        `range must be one of ${USAGE_RANGES.join(', ')}`,
      )
      return Promise.resolve(buildUsage(ctx.summaries(), req.range, ctx.now(), deps().pricing))
    },
    // Settings > Extensions: the project's Context report (its runs' context-health.json; names reach the app only).
    'context.report': (req) => {
      need(isObj(req) && typeof req.folder === 'string' && req.folder.trim() !== '', 'folder is required')
      const folder = isAbsolute(req.folder) ? req.folder : resolve(req.folder)
      return readContextReport(folder, ctx.summaries(), (runId) => ctx.paths.run(runId).dir)
    },
    'folders.recent': () => recentFolders(ctx.summaries(), ctx.dashboard?.folderFacts ?? folderFacts),
    // Settings → Catalog, read-only (no live catalog): the prices and models the core loaded, with their status. No
    // refresh job or history exists here.
    'catalog.get': async () => {
      const d = deps()
      const data = d.catalogData?.()
      if (data === undefined)
        throw new DimFactoryError('UNSUPPORTED', 'The model catalog is not available here.')
      return {
        models: data.models,
        pricing: data.pricing,
        status: await d.catalogStatus(),
        job: null,
        history: [],
      }
    },
  }
}
