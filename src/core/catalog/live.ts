// The catalog of a writable core: the prices and models every
// cost, estimate, pricingRef and model picker reads, replaced in memory the moment an apply, a manual price or an Undo
// commits (so the next estimates.get uses the new prices at once); `catalog.get`'s state (status, the newest refresh
// job with its diff review, history); the schedule (Turn off / interval through the user dimfactory.json, "Not now"
// in state.json); and the scheduler that raises the consent card. Nothing here starts a refresh.
import { readdir } from 'node:fs/promises'
import { CATALOG_JOB_STATES } from '../../shared/catalog.ts'
import type {
  CatalogDiff,
  CatalogJob,
  CatalogJobState,
  CatalogRejectedRow,
  CatalogSchedule,
  CatalogScheduleUpdate,
  CatalogState,
  CatalogStatus,
  PriceEdit,
} from '../../shared/catalog.ts'
import type { JsonPatchOp } from '../../shared/failure.ts'
import type { AppEvent } from '../../shared/ipc.ts'
import type { ModelInfo, VendorId } from '../../shared/vendors.ts'
import { KNOWN_VENDORS } from '../../shared/vendors.ts'
import { catalogStatus } from '../dashboard/dashboard.ts'
import { DimFactoryError, errnoCode } from '../errors.ts'
import type { HomePaths } from '../home.ts'
import type { Logger } from '../log.ts'
import type { Clock } from '../supervisor/effects.ts'
import {
  applyRows,
  listCatalogHistory,
  readJobProposal,
  readJobStatusRaw,
  recoverPendingCommit,
  savePrice,
  undoCandidate,
  undoLast,
} from './apply.ts'
import type { CatalogIoOptions } from './apply.ts'
import { DAY_MS } from './cost.ts'
import { buildCatalogDiff } from './diff.ts'
import {
  CatalogScheduler,
  catalogNextDueAt,
  readCatalogScheduleState,
  writeCatalogScheduleState,
} from './scheduler.ts'
import type { CatalogCheck, CatalogRefreshSettings, CatalogScheduleState } from './scheduler.ts'
import { CatalogStore, pricesFetchedAt } from './store.ts'
import type { CatalogData } from './store.ts'
import { jobValidateContext } from './validate.ts'
import type { ValidateContext } from './validate.ts'

/** A refresh job runs at most 10 minutes; a `running` status.json older than this is stale. */
const JOB_STALE_MS = 15 * 60_000
const JOB_TEXT_MAX = 500

export interface CatalogUserSettings {
  /** `catalog.refresh` over the builtin defaults. */
  refresh: CatalogRefreshSettings & { vendor: VendorId; model: string | null }
  /** `notifications.events.catalog`. */
  notifyCatalog: boolean
}

export interface CatalogLiveDeps {
  paths: HomePaths
  clock: Pick<Clock, 'now' | 'setTimer' | 'clearTimer'>
  log: Logger
  settings(): CatalogUserSettings
  /** Turn off / change the interval: a minimal edit of the user dimfactory.json (`config.patch`, user scope). */
  patchUserConfig(ops: JsonPatchOp[]): Promise<void>
  /** The models a vendor's CLI reported in its probe (undefined: not probed). */
  cliModels(vendor: VendorId): readonly ModelInfo[] | undefined
  /** The `catalog` AppEvent (`due` from the scheduler, `applied` after an apply). */
  emit(ev: Extract<AppEvent, { kind: 'catalog' }>): void
  /** The host's `catalog` notification (it applies the focus and pause rules). */
  notify?: (() => void) | undefined
  /** Tests: fs injection, history size, seed. */
  io?: Omit<CatalogIoOptions, 'now'>
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

const text = (v: unknown): string | undefined => {
  const s =
    typeof v === 'string'
      ? v
      : typeof v === 'object' && v !== null
        ? (v as { message?: unknown }).message
        : undefined
  return typeof s === 'string' && s.trim() !== '' ? s.trim().slice(0, JOB_TEXT_MAX) : undefined
}

const STATE_ALIASES: Readonly<Record<string, CatalogJobState>> = {
  done: 'diff-ready',
  ok: 'diff-ready',
  completed: 'diff-ready',
  succeeded: 'diff-ready',
  error: 'failed',
  canceled: 'cancelled',
}

/** A job's status.json as CatalogJob (lenient: the refresh job owns the file). */
function jobOf(id: string, raw: Record<string, unknown>): CatalogJob | null {
  const s = raw['state'] ?? raw['status']
  const state =
    typeof s === 'string'
      ? (CATALOG_JOB_STATES as readonly string[]).includes(s)
        ? (s as CatalogJobState)
        : STATE_ALIASES[s]
      : undefined
  const startedAt = num(raw['startedAt'])
  if (state === undefined || startedAt === null) return null
  const job: CatalogJob = {
    id,
    state,
    vendor: typeof raw['vendor'] === 'string' && raw['vendor'] !== '' ? raw['vendor'] : 'claude',
    model: typeof raw['model'] === 'string' ? raw['model'] : null,
    startedAt,
  }
  const endedAt = num(raw['endedAt'])
  if (endedAt !== null) job.endedAt = endedAt
  const progress = text(raw['progress'])
  if (progress !== undefined) job.progress = progress
  const error = text(raw['error'])
  if (error !== undefined) job.error = error
  return job
}

/** The shape-rejected rows the refresh job kept in status.json (they never reach proposal.json). */
function statusRejected(raw: Record<string, unknown> | null): CatalogRejectedRow[] {
  const list = raw?.['rejected']
  if (!Array.isArray(list)) return []
  const out: CatalogRejectedRow[] = []
  for (const r of list.slice(0, 500)) {
    if (typeof r !== 'object' || r === null) continue
    const o = r as Record<string, unknown>
    const reason = text(o['reason'])
    if (reason === undefined) continue
    const row: CatalogRejectedRow = {
      vendor: typeof o['vendor'] === 'string' ? o['vendor'].slice(0, 64) : '?',
      model: typeof o['model'] === 'string' ? o['model'].slice(0, 128) : '?',
      value: typeof o['value'] === 'number' || o['value'] === null ? o['value'] : null,
      reason,
    }
    if (typeof o['field'] === 'string') {
      const f = o['field']
      if (
        f === 'inputPerMTok' ||
        f === 'outputPerMTok' ||
        f === 'cacheReadPerMTok' ||
        f === 'cacheWritePerMTok'
      )
        row.field = f
    }
    out.push(row)
  }
  return out
}

export class CatalogLive {
  readonly #d: CatalogLiveDeps
  readonly #bootAt: number
  #data: CatalogData | undefined
  #jobSource: (() => CatalogJob | null) | undefined
  #scheduler: CatalogScheduler | undefined

  constructor(d: CatalogLiveDeps) {
    this.#d = d
    this.#bootAt = d.clock.now()
  }

  #io(): CatalogIoOptions {
    return { ...this.#d.io, now: () => this.#d.clock.now() }
  }

  /** Settle an interrupted commit, then read (and on first use seed) catalog/{pricing,models}.json. */
  async load(): Promise<CatalogData> {
    const p = this.#d.paths
    try {
      const settled = await recoverPendingCommit(p, this.#io())
      if (settled !== 'none')
        this.#d.log.warn('catalog: an interrupted price update was settled', { settled })
    } catch (err) {
      this.#d.log.warn('catalog: an interrupted price update could not be settled yet', { err })
    }
    const read = await new CatalogStore({
      paths: p,
      now: () => this.#d.clock.now(),
      ...(this.#d.io?.seedPath !== undefined ? { seedPath: this.#d.io.seedPath } : {}),
    }).read()
    for (const w of read.warnings) this.#d.log.warn('catalog problem', { warning: w })
    this.#data = { models: read.models, pricing: read.pricing }
    return this.#data
  }

  /** The prices and models costs, estimates, pricingRef and pickers read now. */
  data(): CatalogData | undefined {
    return this.#data
  }

  /** The refresh runner's live job (refresh-jobs.ts): preferred over status.json while it runs. */
  setJobSource(fn: (() => CatalogJob | null) | undefined): void {
    this.#jobSource = fn
  }

  /** What validate.ts checks proposals against: every CLI's reported models; official sources from sources.ts. */
  validateContext(): ValidateContext {
    const cli: Record<string, readonly ModelInfo[]> = {}
    for (const v of KNOWN_VENDORS) {
      const list = this.#d.cliModels(v)
      if (list !== undefined && list.length > 0) cli[v] = list
    }
    return { cliModels: cli }
  }

  /**
   * The diff review of a proposal against the catalog as it is now. `job`: the job's own part of the context (its
   * status.json: the pages it read, the models it named, the vendors it covered; validate.ts jobValidateContext), the
   * same one catalog.apply checks the ticks against.
   */
  diffFor(
    meta: { jobId: string; vendor: VendorId; model: string | null },
    proposal: unknown,
    job: ValidateContext = {},
  ): CatalogDiff | null {
    const data = this.#data
    if (data === undefined) return null
    return buildCatalogDiff({ ...meta, generatedAt: this.#d.clock.now() }, data, proposal, {
      ...this.validateContext(),
      ...job,
    })
  }

  // ---- jobs ----------------------------------------------------------------------------------------------------------

  async #diskJob(): Promise<{ job: CatalogJob; raw: Record<string, unknown> } | null> {
    let names: string[]
    try {
      names = (await readdir(this.#d.paths.catalogJobsDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') this.#d.log.warn('catalog jobs unreadable', { err })
      return null
    }
    let best: { job: CatalogJob; raw: Record<string, unknown> } | null = null
    for (const name of names) {
      const raw = await readJobStatusRaw(this.#d.paths, name)
      const job = raw !== null ? jobOf(name, raw) : null
      if (job === null || raw === null) continue
      if (
        best === null ||
        job.startedAt > best.job.startedAt ||
        (job.startedAt === best.job.startedAt && name > best.job.id)
      ) {
        best = { job, raw }
      }
    }
    return best
  }

  /** The newest refresh job (live first), with its diff review when it is ready (unless `diff: false`). */
  async latestJob(o: { diff?: boolean } = {}): Promise<CatalogJob | null> {
    const live = this.#jobSource?.() ?? null
    const disk = await this.#diskJob()
    let job: CatalogJob | null = null
    let raw: Record<string, unknown> | null = null
    // A running job is live (status.json lags its progress); once it ends, status.json is the record.
    const liveWins =
      live !== null &&
      (live.state === 'running' ||
        disk === null ||
        (disk.job.id !== live.id && live.startedAt > disk.job.startedAt))
    if (live !== null && liveWins) {
      job = { ...live }
      if (disk?.job.id === live.id) raw = disk.raw
    } else if (disk !== null) {
      job = { ...disk.job }
      raw = disk.raw
    }
    if (job === null) return null
    // The diff is always made against the catalog as it is now.
    delete job.diff
    if (job.state === 'running' && (live === null || live.id !== job.id)) {
      // Not this process's job: it stopped with a Dim Factory that closed (or it hangs past its 10 minutes).
      const now = this.#d.clock.now()
      if (job.startedAt < this.#bootAt || now - job.startedAt > JOB_STALE_MS) {
        job = {
          ...job,
          state: 'failed',
          error: job.error ?? 'The update stopped when Dim Factory closed. Start it again.',
        }
      }
    }
    if (job.state === 'diff-ready' && o.diff !== false) {
      try {
        const proposal = await readJobProposal(this.#d.paths, job.id)
        const diff = this.diffFor(
          { jobId: job.id, vendor: job.vendor, model: job.model },
          proposal,
          jobValidateContext(raw),
        )
        if (diff !== null) {
          diff.generatedAt = job.endedAt ?? diff.generatedAt
          const extra = statusRejected(raw)
          if (extra.length > 0) diff.rejected = [...extra, ...diff.rejected]
          job = { ...job, diff }
        }
      } catch (err) {
        job = {
          ...job,
          state: 'failed',
          error: err instanceof DimFactoryError ? err.message : 'The results of this update cannot be read.',
        }
      }
    }
    return job
  }

  // ---- schedule and status -------------------------------------------------------------------------------------------

  /**
   * state.json's catalog fields; a refresh that finished (diff ready or applied) counts as the last refresh even when
   * nothing was applied (the user reviewed it).
   */
  async scheduleState(job?: CatalogJob | null): Promise<CatalogScheduleState> {
    const st = await readCatalogScheduleState(this.#d.paths.state)
    const j = job === undefined ? await this.latestJob({ diff: false }) : job
    const done =
      j !== null && (j.state === 'diff-ready' || j.state === 'applied') ? (j.endedAt ?? j.startedAt) : null
    if (done === null || (st.lastRefreshAt !== null && st.lastRefreshAt >= done)) return st
    return { ...st, lastRefreshAt: done }
  }

  async status(job?: CatalogJob | null): Promise<CatalogStatus> {
    const j = job === undefined ? await this.latestJob({ diff: false }) : job
    const s = this.#d.settings()
    return catalogStatus({
      pricing: this.#data?.pricing ?? null,
      refresh: { enabled: s.refresh.enabled, intervalDays: s.refresh.intervalDays },
      state: await this.scheduleState(j),
      now: this.#d.clock.now(),
      jobRunning: j?.state === 'running',
    })
  }

  /** `catalog.get`. */
  async state(): Promise<CatalogState> {
    const data = this.#data
    if (data === undefined)
      throw new DimFactoryError('UNSUPPORTED', 'The model catalog is not available here.')
    const job = await this.latestJob()
    const history = await listCatalogHistory(this.#d.paths)
    return {
      models: data.models,
      pricing: data.pricing,
      status: await this.status(job),
      job,
      history,
      undoId: undoCandidate(history)?.id ?? null,
    }
  }

  // ---- writes --------------------------------------------------------------------------------------------------------

  #writable(): void {
    if (this.#data === undefined)
      throw new DimFactoryError('UNSUPPORTED', 'The model catalog is not available here.')
  }

  /** `catalog.apply`: the ticked rows of a finished refresh; the last refresh is now. */
  async apply(jobId: string, rowIds: readonly string[]): Promise<CatalogState> {
    this.#writable()
    const r = await applyRows(this.#d.paths, jobId, rowIds, { ...this.#io(), ctx: this.validateContext() })
    this.#data = r.data
    await writeCatalogScheduleState(this.#d.paths.state, { lastRefreshAt: this.#d.clock.now() }).catch(
      (err: unknown) => this.#d.log.warn('state.json: last refresh not recorded', { err }),
    )
    this.#d.log.info('catalog: price update applied', {
      jobId,
      rows: rowIds.length,
      entries: r.entries,
      confirmed: r.confirmed,
    })
    this.#d.emit({ kind: 'catalog', state: 'applied', jobId })
    return this.state()
  }

  /** `catalog.savePrice`: a manual price, `confidence:'user'`, undoable like an apply. */
  async savePrice(edit: PriceEdit): Promise<CatalogState> {
    this.#writable()
    const r = await savePrice(this.#d.paths, edit, this.#io())
    this.#data = r.data
    return this.state()
  }

  /** `catalog.undo`: the newest change not undone yet. */
  async undo(): Promise<CatalogState> {
    this.#writable()
    const r = await undoLast(this.#d.paths, this.#io())
    this.#data = r.data
    return this.state()
  }

  /** `catalog.setSchedule`: Turn off / interval (user dimfactory.json), "Not now (N days)" (state.json). */
  async setSchedule(u: CatalogScheduleUpdate): Promise<CatalogSchedule> {
    const ops: JsonPatchOp[] = []
    if (u.enabled !== undefined) ops.push({ op: 'add', path: '/catalog/refresh/enabled', value: u.enabled })
    if (u.intervalDays !== undefined) {
      if (!Number.isInteger(u.intervalDays) || u.intervalDays < 1 || u.intervalDays > 365) {
        throw new DimFactoryError('VALIDATION', 'The interval must be 1 to 365 days.')
      }
      ops.push({ op: 'add', path: '/catalog/refresh/intervalDays', value: u.intervalDays })
    }
    if (
      u.snoozeDays !== undefined &&
      (!Number.isInteger(u.snoozeDays) || u.snoozeDays < 1 || u.snoozeDays > 365)
    ) {
      throw new DimFactoryError('VALIDATION', 'Not now takes 1 to 365 days.')
    }
    if (ops.length > 0) await this.#d.patchUserConfig(ops)
    if (u.snoozeDays !== undefined) {
      await writeCatalogScheduleState(this.#d.paths.state, {
        snoozedUntil: this.#d.clock.now() + u.snoozeDays * DAY_MS,
      })
    }
    return (await this.status()).schedule
  }

  // ---- the scheduler -------------------------------------------------------------------------------------------------

  /** What the scheduler sees now. */
  async check(): Promise<CatalogCheck> {
    const job = await this.latestJob({ diff: false })
    const s = this.#d.settings()
    const now = this.#d.clock.now()
    const pricing = this.#data?.pricing
    // Before the first refresh the due date counts from the shipped prices' date (the newest fetchedAt
    // of a price the user did not set), never from a manual edit (catalogStatus uses the same base).
    const nextDueAt = catalogNextDueAt(
      await this.scheduleState(job),
      s.refresh,
      now,
      pricing !== undefined ? pricesFetchedAt(pricing) : null,
    )
    return { due: nextDueAt !== null && now >= nextDueAt, nextDueAt, jobRunning: job?.state === 'running' }
  }

  /** Start the launch + every-6-h look (app hosts). It raises the consent card; it never starts a refresh. */
  startScheduler(o: { bootDelayMs?: number; intervalMs?: number } = {}): CatalogScheduler {
    this.#scheduler?.stop()
    const s = new CatalogScheduler({
      clock: this.#d.clock,
      check: () => this.check(),
      notifyEnabled: () => this.#d.settings().notifyCatalog,
      raise: () => this.#d.emit({ kind: 'catalog', state: 'due' }),
      notify: () => this.#d.notify?.(),
      log: this.#d.log.child({ part: 'catalog-schedule' }),
      ...(o.bootDelayMs !== undefined ? { bootDelayMs: o.bootDelayMs } : {}),
      ...(o.intervalMs !== undefined ? { intervalMs: o.intervalMs } : {}),
    })
    this.#scheduler = s
    s.start()
    return s
  }

  get scheduler(): CatalogScheduler | undefined {
    return this.#scheduler
  }

  stop(): void {
    this.#scheduler?.stop()
  }
}
