// Times of day as Dim Factory writes them (UI copy standards; the wait_until executor):
// one 24-hour form for core's labels ("Retry at 14:05") and the renderer's status lines ("(at 14:05)"), so a card
// never shows the same time two ways.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** `14:05` (local time), or `Mon 14:05` when `at` is 20 hours or more after `now`. */
export function localClockText(at: number, now: number): string {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (at - now < 20 * 3_600_000) return hm
  return `${DAYS[d.getDay()] ?? ''} ${hm}`
}
