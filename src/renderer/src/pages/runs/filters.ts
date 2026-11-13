// Runs history filters (folder, status, vendor, date, text; 100 per page). Every filter is core's: the page sends them as runs.list's query (folder, status, vendor, from/to, text) and
// shows the rows core returns, so a filter never decides on its own which runs match.
import type { RunListQuery } from '@shared/ipc.ts'
import type { RunStatus } from '@shared/run.ts'
import { ACTIVE_RUN_STATUSES } from '../../state/selectors.ts'

export const RUNS_PAGE_SIZE = 100
/** The text box asks core once typing pauses this long (Enter asks at once). */
export const TEXT_DEBOUNCE_MS = 300

export type StatusFilterId = 'all' | 'active' | 'completed' | 'failed' | 'cancelled'

export interface StatusFilter {
  id: StatusFilterId
  label: string
  /** runs.list `status`; null = every run. */
  statuses: readonly RunStatus[] | null
}

export const STATUS_FILTERS: readonly StatusFilter[] = [
  { id: 'all', label: 'All', statuses: null },
  { id: 'active', label: 'Active', statuses: ACTIVE_RUN_STATUSES },
  { id: 'completed', label: 'Completed', statuses: ['completed'] },
  { id: 'failed', label: 'Failed', statuses: ['failed'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
]

export type DatePreset = 'any' | 'today' | '7d' | '30d' | 'custom'

export const DATE_PRESETS: readonly { id: DatePreset; label: string }[] = [
  { id: 'any', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom range' },
]

export interface RunFilters {
  status: StatusFilterId
  /** A folder path as core lists it; null = every folder. */
  folder: string | null
  vendor: string | null
  date: DatePreset
  /** `YYYY-MM-DD` (an `<input type="date">` value) for the custom range; '' = open. */
  fromDay: string
  toDay: string
  /** Matched by core against run titles; trimmed. */
  text: string
}

export const NO_FILTERS: RunFilters = {
  status: 'all',
  folder: null,
  vendor: null,
  date: 'any',
  fromDay: '',
  toDay: '',
  text: '',
}

export function filtersActive(f: RunFilters): boolean {
  return (
    f.status !== 'all' ||
    f.folder !== null ||
    f.vendor !== null ||
    (f.date !== 'any' && (f.date !== 'custom' || f.fromDay !== '' || f.toDay !== '')) ||
    f.text !== ''
  )
}

const DAY_MS = 86_400_000

/** Local midnight at the start of a `YYYY-MM-DD` day; null for anything else. */
export function dayStart(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return null
  const [y, mo, da] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const d = new Date(y, mo, da)
  // A day that does not exist (2026-02-30) would roll over into the next month: refused instead.
  return d.getFullYear() === y && d.getMonth() === mo && d.getDate() === da ? d.getTime() : null
}

/** The last millisecond of a `YYYY-MM-DD` day (local); null for anything else. */
export function dayEnd(day: string): number | null {
  const start = dayStart(day)
  if (start === null) return null
  const d = new Date(start)
  d.setDate(d.getDate() + 1)
  return d.getTime() - 1
}

function localMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The date filter as runs.list's `from`/`to` (createdAt bounds), as of `now`. */
export function dateBounds(
  f: Pick<RunFilters, 'date' | 'fromDay' | 'toDay'>,
  now: number,
): {
  from?: number
  to?: number
} {
  switch (f.date) {
    case 'any':
      return {}
    case 'today':
      return { from: localMidnight(now) }
    case '7d':
      return { from: now - 7 * DAY_MS }
    case '30d':
      return { from: now - 30 * DAY_MS }
    case 'custom': {
      const from = dayStart(f.fromDay)
      const to = dayEnd(f.toDay)
      return { ...(from !== null ? { from } : {}), ...(to !== null ? { to } : {}) }
    }
  }
}

/**
 * runs.list's query for the filters (without `limit` and `cursor`), as of `now`: only what is set, so every run is
 * `{}`. Load more reuses the query of its first page, so the pages of one listing share their bounds.
 */
export function listQuery(f: RunFilters, now: number): RunListQuery {
  const statuses = STATUS_FILTERS.find((s) => s.id === f.status)?.statuses ?? null
  const text = f.text.trim()
  return {
    ...(f.folder !== null ? { folder: f.folder } : {}),
    ...(statuses !== null ? { status: [...statuses] } : {}),
    ...(f.vendor !== null ? { vendor: f.vendor } : {}),
    ...(text !== '' ? { text } : {}),
    ...dateBounds(f, now),
  }
}
