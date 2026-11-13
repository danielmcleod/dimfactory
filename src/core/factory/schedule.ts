// The factory's schedule: when its window is open, when it closes and when it opens next, in local time. Pure: the
// time comes in as `now` (the core's clock, so the E2E clock and the tests' fake clocks move it).
//
// A window opens at `start` on each day in `days` and closes at `end` (before `start`: the next day; equal to `start`:
// 24 hours later; null: never, the queue runs until it is empty). Day-light saving moves with the local clock: the
// window opens at the wall-clock time the user set.
import type { ScheduleSettings } from '../../shared/factory.ts'
import { CLOCK_TIME } from '../../shared/factory.ts'

/** `HH:MM` as minutes after midnight (invalid: null). */
export function clockMinutes(hhmm: string): number | null {
  if (!CLOCK_TIME.test(hhmm)) return null
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** The local date `off` days after `now`'s at `minutes` past midnight (epoch ms). */
function localAt(now: number, off: number, minutes: number): number {
  const d = new Date(now)
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + off,
    Math.floor(minutes / 60),
    minutes % 60,
  ).getTime()
}

export interface WindowState {
  open: boolean
  /** The open window's start (epoch ms). */
  openedAt?: number
  /** The open window's end (absent: open with no end). */
  closesAt?: number
  /** When the next window opens after `now` (absent: never). */
  nextStart?: number
}

/** The schedule's window at `now`: open or not, and the times around it. A disabled schedule is never open. */
export function scheduleWindow(s: ScheduleSettings, now: number): WindowState {
  const start = clockMinutes(s.start)
  if (!s.enabled || start === null || s.days.length === 0) return { open: false }
  const end = s.end === null ? null : clockMinutes(s.end)
  let open: { openedAt: number; closesAt?: number } | undefined
  let nextStart: number | undefined
  // Yesterday's window may still be open (an overnight one); a week ahead finds the next start.
  for (let off = -1; off <= 8; off++) {
    const at = localAt(now, off, start)
    const day = new Date(at).getDay()
    if (!s.days.includes(day)) continue
    let closes: number | undefined
    if (end !== null) closes = end > start ? localAt(now, off, end) : localAt(now, off + 1, end)
    if (at <= now && (closes === undefined || now < closes)) {
      // The latest window that is open now (a window with no end stays open until a later one starts).
      if (open === undefined || at > open.openedAt)
        open = closes !== undefined ? { openedAt: at, closesAt: closes } : { openedAt: at }
    }
    if (at > now && (nextStart === undefined || at < nextStart)) nextStart = at
  }
  return {
    open: open !== undefined,
    ...(open !== undefined ? open : {}),
    ...(nextStart !== undefined ? { nextStart } : {}),
  }
}

/**
 * When the schedule next needs a look after `now`: the open window's end, else the next start (absent: nothing to
 * wait for). The service arms one timer for it.
 */
export function nextScheduleEvent(s: ScheduleSettings, now: number): number | undefined {
  const w = scheduleWindow(s, now)
  if (w.open) return w.closesAt ?? w.nextStart
  return w.nextStart
}

/** `YYYY-MM-DD` of `now` in local time (the daily budget's and the report's day). */
export function localDate(now: number): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The local day `now` falls in, as [start, end) epoch ms. */
export function localDayBounds(now: number): { start: number; end: number } {
  const d = new Date(now)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return { start, end }
}
