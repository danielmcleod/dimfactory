// Catalog refresh schedule (the `catalog` event "Model prices may be out of date"; the `catalog.refresh` config;
// state.json "catalog lastRefresh/snooze").
// - Due: `enabled`, and `intervalDays` passed since the last refresh (or, before the first one, since the shipped
//   prices' date), and no "Not now" snooze runs. Off (`enabled:false`) is never due.
// - The scheduler checks at launch (after a short boot delay) and every 6 h on core's clock. It only raises the
//   consent card (the `catalog` AppEvent `due`) and, once per due date, the `catalog` notification (the host applies
//   the event toggle and the focus rule). It NEVER starts a refresh: that takes `catalog.refresh{consent:true}` from a
//   click.
// - state.json's `catalog.lastRefreshAt` / `catalog.snoozedUntil` are written here (other fields kept).
import { updateStateFile } from '../store/state-file.ts'
import { CURRENT_SCHEMA_VERSION, isPlainObject, readVersionedJson } from '../store/versions.ts'
import type { Logger } from '../log.ts'
import type { Clock, TimerHandle } from '../supervisor/effects.ts'
import { DAY_MS, DEFAULT_REFRESH_INTERVAL_DAYS } from './cost.ts'

/** How often the scheduler looks: it runs on launch and every 6 h. */
export const CATALOG_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** First look after boot: the window and the host's notification hook are up by then. */
export const CATALOG_BOOT_DELAY_MS = 10_000
/** "Not now (7 days)". */
export const CATALOG_SNOOZE_DAYS = 7

/** state.json `catalog` (defaults when missing). */
export interface CatalogScheduleState {
  lastRefreshAt: number | null
  snoozedUntil: number | null
}

/** `catalog.refresh` from the config: Off/7/14/30 in the UI (Off = enabled false). */
export interface CatalogRefreshSettings {
  enabled: boolean
  intervalDays: number
}

const intervalOf = (days: number): number =>
  Number.isFinite(days) && days > 0 ? days : DEFAULT_REFRESH_INTERVAL_DAYS

/**
 * When the next refresh is due (epoch ms), or null when the schedule is off. The base is the last refresh, else the
 * shipped prices' date (`pricingUpdatedAt`), else `now`; a snooze pushes it to `snoozedUntil`.
 */
export function catalogNextDueAt(
  state: CatalogScheduleState,
  config: CatalogRefreshSettings,
  now: number,
  pricingUpdatedAt: number | null = null,
): number | null {
  if (!config.enabled) return null
  const base = state.lastRefreshAt ?? pricingUpdatedAt
  const due = base !== null ? base + intervalOf(config.intervalDays) * DAY_MS : now
  return Math.max(due, state.snoozedUntil ?? 0)
}

/** A refresh is due now (see {@link catalogNextDueAt}). */
export function catalogDue(
  state: CatalogScheduleState,
  config: CatalogRefreshSettings,
  now: number,
  pricingUpdatedAt: number | null = null,
): boolean {
  const next = catalogNextDueAt(state, config, now, pricingUpdatedAt)
  return next !== null && now >= next
}

// ---- state.json -----------------------------------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** state.json's catalog fields (defaults when the file is missing, corrupt or newer). Reads only. */
export async function readCatalogScheduleState(stateFile: string): Promise<CatalogScheduleState> {
  try {
    const r = await readVersionedJson<Record<string, unknown>>(stateFile)
    if (r.kind !== 'ok') return { lastRefreshAt: null, snoozedUntil: null }
    const c = isPlainObject(r.value['catalog']) ? r.value['catalog'] : {}
    return { lastRefreshAt: num(c['lastRefreshAt']), snoozedUntil: num(c['snoozedUntil']) }
  } catch {
    return { lastRefreshAt: null, snoozedUntil: null }
  }
}

/**
 * Set state.json's catalog fields (others kept; a corrupt file is replaced). NEWER_SCHEMA when a newer Dim Factory
 * wrote the file. Goes through the one serialized state.json writer (store/state-file.ts).
 */
export function writeCatalogScheduleState(
  stateFile: string,
  patch: Partial<CatalogScheduleState>,
): Promise<CatalogScheduleState> {
  return updateStateFile(stateFile, (raw) => {
    const prev = isPlainObject(raw['catalog']) ? raw['catalog'] : {}
    const catalog = {
      ...prev,
      lastRefreshAt: num(prev['lastRefreshAt']),
      snoozedUntil: num(prev['snoozedUntil']),
      ...patch,
    }
    return {
      next: { ...raw, schemaVersion: CURRENT_SCHEMA_VERSION, catalog },
      value: { lastRefreshAt: num(catalog.lastRefreshAt), snoozedUntil: num(catalog.snoozedUntil) },
    }
  })
}

// ---- the scheduler ----------------------------------------------------------------------------------------------------

/** What one look found. */
export interface CatalogCheck {
  due: boolean
  nextDueAt: number | null
  /** A refresh is running (the card shows its progress instead). */
  jobRunning: boolean
}

export interface CatalogTickResult extends CatalogCheck {
  /** The consent card was raised (AppEvent `catalog` state `due`). */
  raised: boolean
  /** The `catalog` notification was handed to the host. */
  notified: boolean
}

export interface CatalogSchedulerDeps {
  clock: Pick<Clock, 'now' | 'setTimer' | 'clearTimer'>
  /** The schedule as it stands now (config, state.json, pricing date, a running job). */
  check(): Promise<CatalogCheck>
  /** `notifications.events.catalog` (user config). */
  notifyEnabled(): boolean
  /** Raise the consent card: the `catalog` AppEvent with state `due`. */
  raise(c: CatalogCheck): void
  /** The `catalog` notification ("Model prices may be out of date"); the host applies focus and pause rules. */
  notify(c: CatalogCheck): void
  intervalMs?: number
  bootDelayMs?: number
  log?: Logger
}

/**
 * Looks at the schedule at launch and every 6 h (see the header). Each look raises the consent card while a refresh
 * is due and none runs; the notification goes once per due date (a snooze or a refresh makes a new one).
 */
export class CatalogScheduler {
  readonly #d: CatalogSchedulerDeps
  #timer: TimerHandle | undefined
  #stopped = true
  #notifiedFor: number | null = null
  #running: Promise<CatalogTickResult | null> = Promise.resolve(null)

  constructor(d: CatalogSchedulerDeps) {
    this.#d = d
  }

  get intervalMs(): number {
    return this.#d.intervalMs ?? CATALOG_CHECK_INTERVAL_MS
  }

  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.#arm(this.#d.bootDelayMs ?? CATALOG_BOOT_DELAY_MS)
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== undefined) this.#d.clock.clearTimer(this.#timer)
    this.#timer = undefined
  }

  /** Resolves when the look in progress (if any) is over. */
  idle(): Promise<CatalogTickResult | null> {
    return this.#running
  }

  #arm(inMs: number): void {
    if (this.#stopped) return
    const clock = this.#d.clock
    this.#timer = clock.setTimer(
      () => {
        // The next look is 6 h from this one (a woken machine looks once, not once per missed slot); looks never
        // overlap (tick() runs them one after the other).
        this.#timer = undefined
        this.#arm(this.intervalMs)
        void this.tick()
      },
      clock.now() + Math.max(0, inMs),
    )
    ;(this.#timer as { unref?: () => void } | undefined)?.unref?.()
  }

  /** One look now (the timer's, or a test's). Never starts a refresh. */
  tick(): Promise<CatalogTickResult | null> {
    const run = async (): Promise<CatalogTickResult | null> => {
      let c: CatalogCheck
      try {
        c = await this.#d.check()
      } catch (err) {
        this.#d.log?.warn('catalog schedule check failed', { err })
        return null
      }
      const out: CatalogTickResult = { ...c, raised: false, notified: false }
      if (!c.due || c.jobRunning) return out
      this.#d.raise(c)
      out.raised = true
      if (this.#d.notifyEnabled() && this.#notifiedFor !== c.nextDueAt) {
        this.#notifiedFor = c.nextDueAt
        this.#d.notify(c)
        out.notified = true
      }
      return out
    }
    const p = this.#running.then(run, run)
    this.#running = p.catch(() => null)
    return p
  }
}
