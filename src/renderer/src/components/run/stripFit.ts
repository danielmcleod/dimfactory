// Which items of the compact step strip fit its one line (UI standard: one scroll region per screen, so the strip never wraps and never scrolls sideways). Pure: widths in, counts out.
//
// Everything shows when it fits. Otherwise the settled items at the start (steps that are done or skipped, and the
// gates passed between them) give way first, oldest first, behind one "+N" chip; if the line is still too long, the
// steps at the end that have not begun give way behind a second "+N" chip. The item the run is at always shows.

export interface StripItem {
  /** The item's width on the line (px). */
  width: number
  /** Done with: it may give way at the start of the line. */
  settled: boolean
}

export interface StripRoom {
  /** The line's width (px). */
  available: number
  /** The gap between items (px). */
  gap: number
  /** A "+N" chip's width (px). */
  more: number
}

/** How many items at the start and at the end give way to the "+N" chips. */
export interface StripFit {
  before: number
  after: number
}

function lineWidth(items: readonly StripItem[], gap: number): number {
  if (items.length === 0) return 0
  return items.reduce((sum, i) => sum + i.width, 0) + gap * (items.length - 1)
}

export function fitStrip(items: readonly StripItem[], room: StripRoom): StripFit {
  const { available, gap, more } = room
  const fits = (before: number, after: number): boolean => {
    const shown = items.slice(before, items.length - after)
    const chips = (before > 0 ? 1 : 0) + (after > 0 ? 1 : 0)
    return lineWidth(shown, gap) + chips * (more + gap) <= available
  }
  if (fits(0, 0)) return { before: 0, after: 0 }
  let settled = 0
  while (settled < items.length - 1 && items[settled]?.settled === true) settled++
  for (let before = 1; before <= settled; before++) if (fits(before, 0)) return { before, after: 0 }
  // Still too long: the steps not yet begun give way from the end, never the first item left.
  const left = items.length - settled
  for (let after = 1; after < left; after++) if (fits(settled, after)) return { before: settled, after }
  return { before: settled, after: Math.max(0, left - 1) }
}
