// The refresh job's lifecycle and the consent card's numbers (the Dashboard's catalog consent card; IPC
// catalog.refreshPlan / catalog.refresh{consent:true} / catalog.cancel). A job
// starts only from the catalog.refresh handler, which requires the user's literal consent; the scheduler never calls
// this module. One job at a time; Cancel and shutdown stop its process tree through the adapter.
//
// Codex (X17) can run the refresh too, but only while it is ready (built, its launch probe without a blocking
// failure, read-only supported and web-capable). A configured Codex that is not ready falls back to Claude with the
// reason in `fallbackNote`; a request naming it is refused with that reason.
import { rm } from 'node:fs/promises'
import { newRunId } from '../../shared/ids.ts'
import type { AppEvent } from '../../shared/ipc.ts'
import type {
  CatalogDiff,
  CatalogJob,
  CatalogRefreshPlan,
  CatalogRejectedRow,
  CatalogStatus,
} from '../../shared/catalog.ts'
import type { Usage } from '../../shared/events.ts'
import type { VendorId } from '../../shared/vendors.ts'
import type { Adapter } from '../adapters/types.ts'
import { BUILTIN_DEFAULTS } from '../config/defaults.ts'
import { DimFactoryError } from '../errors.ts'
import type { PriceLookup } from '../estimates/estimate.ts'
import { percentile } from '../estimates/defaults.ts'
import { catalogCostUsd } from './cost.ts'
import type { RefreshJobResult, RefreshJobStatus, RefreshLog, RefreshProposal } from './refresh.ts'
import {
  listJobIds,
  localDate,
  readJobStatus,
  refreshJobDir,
  runRefreshJob,
  vendorDisplayName,
  writeJobStatus,
} from './refresh.ts'
import { officialHosts } from './sources.ts'
import type { CatalogData } from './store.ts'

/** Vendors that can run a refresh (Codex's route, X17, joins Claude's), in the order a fallback picks them. */
export const REFRESH_VENDORS: readonly VendorId[] = ['claude', 'codex']

/**
 * Refresh vendors whose job reads pages only on the official hosts (Claude: `--allowedTools
 * WebFetch(domain:…)` with CLAUDE_CODE_EVAL_CONFINED). Codex's `web_search` takes no domain list (live X17
 * opened a page outside them), so its consent card does not say "only" (CatalogRefreshPlan.hostsConfined).
 */
export const HOST_CONFINED_REFRESH_VENDORS: readonly VendorId[] = ['claude']

/**
 * Whether a vendor can run a refresh now; `reason` says why not. `unbuilt`: it cannot in this build at all (not a
 * refresh vendor, or no adapter), so a request naming it is UNSUPPORTED; otherwise it is only not ready now (CONFLICT).
 */
export type RefreshReadiness = { ok: true } | { ok: false; reason: string; unbuilt?: boolean }
/** The consent card's line on what the job may do. */
export const REFRESH_COPY = 'Read-only, web search, cannot change files.'
/** ~time before any refresh has finished: a few searches and official pages, then the answer. */
export const REFRESH_PRIOR_MS = 240_000
/** ≈tokens before any refresh has finished (priced at the refresh model's rate): searches and pages read back. */
export const REFRESH_PRIOR_USAGE: Usage = {
  input: 20_000,
  output: 4_000,
  cacheRead: 120_000,
  cacheWrite: 30_000,
}
/** Past refreshes used for the estimates: the median of the newest ones once there are enough. */
export const REFRESH_HISTORY_SAMPLES = 10
export const REFRESH_HISTORY_MIN = 3
/** Job folders kept under catalog/jobs/ (the newest; a running one is never removed). */
export const REFRESH_JOBS_KEPT = 20

export type CatalogJobEvent = Extract<AppEvent, { kind: 'catalog' }>

/** The settings a refresh reads, fresh for each plan and start (resolved user config). */
export interface RefreshSettings {
  /** `catalog.refresh`. */
  refresh: { enabled: boolean; intervalDays: number; vendor: VendorId; model: string | null }
  /** Vendors whose prices are refreshed (the vendors in use); the refresh vendor is added first. */
  vendors: readonly VendorId[]
  /**
   * `vendors.<id>.flagMap` by vendor: the refresh vendor's renames reach its spawn, minus the safety flags
   * (refresh.ts refreshFlagMap). Its `env` is the adapter's own (createClaudeAdapter vendorEnv).
   */
  flagMaps?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined
}

export interface DiffInput {
  jobId: string
  vendor: VendorId
  model: string | null
  /** When the job ended (epoch ms). */
  at: number
  proposal: RefreshProposal
  /** Entries the schema refused (refresh.ts); they belong in CatalogDiff.rejected. */
  rejected: CatalogRejectedRow[]
  vendors: readonly VendorId[]
  /** The hosts of the job's successful page fetches (validate.ts `notFetched`). */
  fetchedHosts: readonly string[]
  /** Every model the answer named, refused ones included (never offered as missing). */
  mentioned: readonly { vendor: string; model: string }[]
}

export interface CatalogJobsDeps {
  /** DIM_FACTORY_HOME. */
  home: string
  /** A built adapter for the vendor, else undefined. */
  adapter(vendor: VendorId): Adapter | undefined
  /**
   * Whether the vendor can run the read-only web pass now (built, its probe without a blocking failure, read-only
   * not unsupported, web-capable). Absent: every built refresh vendor counts as ready.
   */
  ready?(vendor: VendorId): RefreshReadiness
  settings(): Promise<RefreshSettings>
  /** The catalog as loaded now; undefined when it is not available (no job can start). */
  catalog(): CatalogData | undefined
  /** The schedule and pricing status (catalog.get's `status`). */
  status(): Promise<CatalogStatus>
  /** The rates the refresh model's tokens cost (app-core's estimate price; `null` model = the CLI default). */
  price: PriceLookup
  /** Subscription login for the vendor: the cost is "API-equiv.". */
  apiEquivalent?(vendor: VendorId): boolean
  /**
   * The concrete model the vendor's CLI runs when none is named (its probe's default), so the consent card
   * names the model whose rate the cost is priced at. Absent or null: not known.
   */
  defaultModel?(vendor: VendorId): string | null
  /** The `catalog` AppEvent (running with progress, diff-ready with the diff, failed, cancelled). */
  emit(ev: CatalogJobEvent): void
  /** The diff review of a finished job (validate.ts / diff.ts); absent: the job ends without one. */
  buildDiff?(i: DiffInput): CatalogDiff | Promise<CatalogDiff>
  /** A refresh finished with a price list (state.json `catalog.lastRefreshAt`). */
  onRefreshed?(at: number): void | Promise<void>
  now?: () => number
  timeoutMs?: number
  log?: RefreshLog
  /** Test seam: the job runner (default refresh.ts runRefreshJob). */
  run?: typeof runRefreshJob
}

interface Choice {
  vendor: VendorId
  model: string | null
  adapter: Adapter | undefined
  note?: string
}

interface Running {
  job: CatalogJob
  abort: AbortController
  done: Promise<void>
}

/** A job id: `YYYYMMDDTHHMMSSZ-xxxx` like a run id, so job folders sort by start. */
export function newJobId(at: number): string {
  return newRunId(new Date(at))
}

const median = (values: readonly number[]): number => percentile(values, 50)

/** The job as CatalogState.job shows it, from its status.json. */
export function jobFromStatus(s: RefreshJobStatus, diff?: CatalogDiff): CatalogJob {
  const job: CatalogJob = {
    id: s.id,
    state: s.state,
    vendor: s.vendor,
    model: s.model,
    startedAt: s.startedAt,
  }
  if (s.endedAt !== undefined) job.endedAt = s.endedAt
  if (s.error !== undefined) job.error = s.error
  if (diff !== undefined) job.diff = diff
  return job
}

export class CatalogJobs {
  readonly #d: CatalogJobsDeps
  #running: Running | undefined
  #starting = false
  #last: CatalogJob | null = null
  #initialized: Promise<void> | undefined

  constructor(d: CatalogJobsDeps) {
    this.#d = d
  }

  #now(): number {
    return (this.#d.now ?? Date.now)()
  }

  /**
   * Boot: a job a previous Dim Factory left `running` (it was closed during the refresh) is marked failed, and the
   * newest job becomes `current()`. Idempotent.
   */
  init(): Promise<void> {
    this.#initialized ??= (async () => {
      const ids = await listJobIds(this.#d.home)
      for (const id of ids) {
        const s = await readJobStatus(this.#d.home, id)
        if (s === null) continue
        if (s.state === 'running' && this.#running?.job.id !== id) {
          const fixed: RefreshJobStatus = {
            ...s,
            state: 'failed',
            error: 'Dim Factory closed while this price refresh was running.',
            category: 'process_crash',
          }
          await writeJobStatus(this.#d.home, fixed).catch(() => undefined)
          if (this.#last === null) this.#last = jobFromStatus(fixed)
          continue
        }
        if (this.#last === null) this.#last = jobFromStatus(s)
      }
    })().catch((err: unknown) => {
      this.#d.log?.warn('catalog jobs could not be read', { err: String(err) })
    })
    return this.#initialized
  }

  /** A refresh is running now. */
  running(): boolean {
    return this.#running !== undefined
  }

  /** The running job, else the newest one this home knows (CatalogState.job). */
  current(): CatalogJob | null {
    const j = this.#running?.job ?? this.#last
    return j === null ? null : { ...j }
  }

  /** Whether `vendor` can run a refresh now (a refresh vendor, built and ready). */
  #readiness(vendor: VendorId): RefreshReadiness {
    if (!REFRESH_VENDORS.includes(vendor)) {
      return { ok: false, reason: `${vendorDisplayName(vendor)} cannot refresh prices.`, unbuilt: true }
    }
    if (this.#d.adapter(vendor) === undefined) {
      return {
        ok: false,
        reason: `${vendorDisplayName(vendor)} is not available in this build.`,
        unbuilt: true,
      }
    }
    return this.#d.ready?.(vendor) ?? { ok: true }
  }

  /**
   * The refresh vendor and its model. The configured vendor while it can run a refresh (Claude or a
   * ready Codex), else the first refresh vendor that can (Claude), with the reason in the note.
   */
  #choose(s: RefreshSettings, req: { vendor?: VendorId; model?: string | null } = {}): Choice {
    if (req.vendor !== undefined) {
      if (!REFRESH_VENDORS.includes(req.vendor)) {
        throw new DimFactoryError(
          'UNSUPPORTED',
          `${vendorDisplayName(req.vendor)} cannot refresh prices. Claude or Codex does.`,
        )
      }
      const r = this.#readiness(req.vendor)
      if (!r.ok) throw new DimFactoryError(r.unbuilt === true ? 'UNSUPPORTED' : 'CONFLICT', r.reason)
    }
    const configured = s.refresh.vendor
    let vendor: VendorId
    let note: string | undefined
    if (req.vendor !== undefined) vendor = req.vendor
    else {
      const own = this.#readiness(configured)
      if (own.ok) vendor = configured
      else {
        vendor =
          REFRESH_VENDORS.find((v) => v !== configured && this.#readiness(v).ok) ??
          REFRESH_VENDORS[0] ??
          'claude'
        const why = REFRESH_VENDORS.includes(configured)
          ? own.reason
          : `${vendorDisplayName(configured)} cannot refresh prices.`
        // No refresh vendor is ready: the configured one runs and its job reports what failed.
        if (vendor !== configured) note = `${why} ${vendorDisplayName(vendor)} refreshes the prices instead.`
      }
    }
    // A model id belongs to its vendor: a fallback runs the built-in refresh model on the built-in vendor (Claude),
    // else that vendor's CLI default.
    const builtin = BUILTIN_DEFAULTS.catalog.refresh
    const model =
      req.model !== undefined
        ? req.model
        : vendor === configured
          ? s.refresh.model
          : vendor === builtin.vendor
            ? builtin.model
            : null
    const adapter = this.#d.adapter(vendor)
    if (adapter === undefined) note = `${vendorDisplayName(vendor)} is not available in this build.`
    return { vendor, model, adapter, ...(note !== undefined ? { note } : {}) }
  }

  /** The vendors a refresh by `vendor` checks: the vendors in use, the refresh vendor first. */
  #vendors(s: RefreshSettings, vendor: VendorId): VendorId[] {
    return [...new Set([vendor, ...s.vendors])]
  }

  /** ~time and ≈cost: the median of the newest finished refreshes once there are 3, else the priors. */
  async #estimate(c: Choice): Promise<{ durationMs: number; costUsd: number | null; samples: number }> {
    const runs: { ranMs: number; costUsd?: number }[] = []
    for (const id of await listJobIds(this.#d.home)) {
      if (runs.length >= REFRESH_HISTORY_SAMPLES) break
      const s = await readJobStatus(this.#d.home, id)
      if (s === null || s.vendor !== c.vendor || (s.state !== 'diff-ready' && s.state !== 'applied')) continue
      if (typeof s.ranMs !== 'number' || s.ranMs <= 0) continue
      runs.push({ ranMs: s.ranMs, ...(typeof s.costUsd === 'number' ? { costUsd: s.costUsd } : {}) })
    }
    const costs = runs.flatMap((r) => (r.costUsd !== undefined ? [r.costUsd] : []))
    const prior = (): number | null => {
      const p = this.#d.price(c.vendor, c.model)
      return 'rates' in p ? catalogCostUsd(REFRESH_PRIOR_USAGE, p.rates, p.reasoningIncludedInOutput) : null
    }
    if (runs.length >= REFRESH_HISTORY_MIN) {
      return {
        durationMs: median(runs.map((r) => r.ranMs)),
        costUsd: costs.length >= REFRESH_HISTORY_MIN ? median(costs) : prior(),
        samples: runs.length,
      }
    }
    return { durationMs: REFRESH_PRIOR_MS, costUsd: prior(), samples: 0 }
  }

  /** `catalog.refreshPlan`: what the consent card shows before any refresh (never starts one). */
  async plan(): Promise<CatalogRefreshPlan> {
    const s = await this.#d.settings()
    const c = this.#choose(s)
    const [status, est] = await Promise.all([this.#d.status(), this.#estimate(c)])
    const vendors = this.#vendors(s, c.vendor)
    const out: CatalogRefreshPlan = {
      vendor: c.vendor,
      model: c.model,
      estDurationMs: est.durationMs,
      estCostUsd: est.costUsd,
      lastRefreshAt: status.schedule.lastRefreshAt,
      due: status.refreshDue,
      vendorName: vendorDisplayName(c.vendor),
      copy: REFRESH_COPY,
      vendors,
      hosts: officialHosts(vendors),
      hostsConfined: HOST_CONFINED_REFRESH_VENDORS.includes(c.vendor),
      estSamples: est.samples,
      apiEquivalent: this.#d.apiEquivalent?.(c.vendor) ?? false,
    }
    if (c.model === null) {
      const d = this.#d.defaultModel?.(c.vendor) ?? null
      if (d !== null && d !== '') out.defaultModel = d
    }
    if (c.note !== undefined) out.fallbackNote = c.note
    if (this.#running !== undefined) out.runningJobId = this.#running.job.id
    return out
  }

  /**
   * Start a refresh. The caller (the catalog.refresh handler) has checked the user's consent. CONFLICT while one runs;
   * UNSUPPORTED when the vendor cannot refresh or the catalog is not loaded. Returns once the job is under way.
   */
  async start(req: { vendor?: VendorId; model?: string | null } = {}): Promise<{ jobId: string }> {
    if (this.#running !== undefined || this.#starting) {
      throw new DimFactoryError('CONFLICT', 'A price refresh is already running.', {
        ...(this.#running !== undefined ? { details: { jobId: this.#running.job.id } } : {}),
      })
    }
    this.#starting = true
    try {
      await this.init()
      const s = await this.#d.settings()
      const c = this.#choose(s, req)
      if (c.adapter === undefined) {
        throw new DimFactoryError('UNSUPPORTED', c.note ?? 'No vendor can refresh prices in this build.')
      }
      const catalog = this.#d.catalog()
      if (catalog === undefined)
        throw new DimFactoryError('UNSUPPORTED', 'The model catalog is not available here.')
      const vendors = this.#vendors(s, c.vendor)
      const at = this.#now()
      const jobId = newJobId(at)
      const progress = `Starting ${vendorDisplayName(c.vendor)}`
      const job: CatalogJob = {
        id: jobId,
        state: 'running',
        vendor: c.vendor,
        model: c.model,
        startedAt: at,
        progress,
      }
      const abort = new AbortController()
      const running: Running = { job, abort, done: Promise.resolve() }
      this.#running = running
      this.#d.emit({ kind: 'catalog', state: 'running', jobId, progress })
      running.done = this.#run(running, c.adapter, catalog, vendors, s)
      void this.#prune(jobId)
      return { jobId }
    } finally {
      this.#starting = false
    }
  }

  async #run(
    r: Running,
    adapter: Adapter,
    catalog: CatalogData,
    vendors: VendorId[],
    s: RefreshSettings,
  ): Promise<void> {
    const job = r.job
    const run = this.#d.run ?? runRefreshJob
    const flagMap = s.flagMaps?.[job.vendor]
    let result: RefreshJobResult
    try {
      result = await run(
        {
          home: this.#d.home,
          adapter,
          catalog,
          vendors,
          ...(flagMap !== undefined ? { flagMap } : {}),
          ...(this.#d.timeoutMs !== undefined ? { timeoutMs: this.#d.timeoutMs } : {}),
          ...(this.#d.now !== undefined ? { now: this.#d.now } : {}),
          ...(this.#d.log !== undefined ? { log: this.#d.log } : {}),
          onProgress: (text) => {
            if (this.#running !== r) return
            job.progress = text
            this.#d.emit({ kind: 'catalog', state: 'running', jobId: job.id, progress: text })
          },
        },
        {
          jobId: job.id,
          vendor: job.vendor,
          model: job.model,
          today: localDate(job.startedAt),
          signal: r.abort.signal,
        },
      )
    } catch (err) {
      result = {
        ok: false,
        cancelled: false,
        ranMs: this.#now() - job.startedAt,
        failure: {
          category: 'unknown',
          message: `The price refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          raw: '',
          classifiedBy: 'app',
        },
      }
    }
    const endedAt = this.#now()
    delete job.progress
    job.endedAt = endedAt
    if (result.ok) {
      let diff: CatalogDiff | undefined
      if (this.#d.buildDiff !== undefined) {
        try {
          diff = await this.#d.buildDiff({
            jobId: job.id,
            vendor: job.vendor,
            model: job.model,
            at: endedAt,
            proposal: result.proposal,
            rejected: result.rejected,
            vendors,
            fetchedHosts: result.fetchedHosts,
            mentioned: result.mentioned,
          })
        } catch (err) {
          this.#d.log?.warn('catalog diff failed', { jobId: job.id, err: String(err) })
        }
      }
      job.state = 'diff-ready'
      if (diff !== undefined) job.diff = diff
      try {
        await this.#d.onRefreshed?.(endedAt)
      } catch (err) {
        this.#d.log?.warn('catalog lastRefreshAt write failed', { err: String(err) })
      }
      this.#finish(r)
      this.#d.emit({
        kind: 'catalog',
        state: 'diff-ready',
        jobId: job.id,
        ...(diff !== undefined ? { diff } : {}),
      })
      return
    }
    job.state = result.cancelled ? 'cancelled' : 'failed'
    job.error = result.failure.message
    this.#finish(r)
    this.#d.emit(
      result.cancelled
        ? { kind: 'catalog', state: 'cancelled', jobId: job.id }
        : { kind: 'catalog', state: 'failed', jobId: job.id, error: result.failure.message },
    )
  }

  #finish(r: Running): void {
    if (this.#running === r) this.#running = undefined
    this.#last = r.job
  }

  /**
   * `catalog.cancel`: stop the running job's process tree (resolves once it has ended). A job that already ended is
   * left as it is; an unknown id is NOT_FOUND.
   */
  async cancel(jobId: string): Promise<void> {
    const r = this.#running
    if (r !== undefined && r.job.id === jobId) {
      r.abort.abort('user')
      await r.done
      return
    }
    if (this.#last?.id === jobId) return
    // readJobStatus answers null for a missing job and for an id that is not one path segment.
    if ((await readJobStatus(this.#d.home, jobId)) === null) {
      throw new DimFactoryError('NOT_FOUND', 'That price refresh does not exist.')
    }
  }

  /** Shutdown: stop a running job (its status reads cancelled) and wait for it. */
  async dispose(): Promise<void> {
    const r = this.#running
    if (r === undefined) return
    r.abort.abort('shutdown')
    await r.done
  }

  /** Keep the newest job folders (never the one just started). Best effort. */
  async #prune(keepId: string): Promise<void> {
    try {
      const ids = (await listJobIds(this.#d.home)).filter((id) => id !== keepId)
      for (const id of ids.slice(REFRESH_JOBS_KEPT - 1)) {
        await rm(refreshJobDir(this.#d.home, id), {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 200,
        })
      }
    } catch (err) {
      this.#d.log?.warn('old catalog jobs not removed', { err: String(err) })
    }
  }
}
