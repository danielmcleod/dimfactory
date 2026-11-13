// Where the reader is in the Diff tab (the J/K/R/S Diff navigation keys): which file R marks and where
// J / K go from, read from the page as it is laid out when the key is pressed. A file the keyboard is in (focus, or
// the last J / K) counts while any of it is in the reading area (the page scroller below the Run view's sticky header,
// above its SummaryBar); otherwise the file at the top of the reading area does, so a reader who scrolled with the
// wheel acts on what is in front of them, never on a file out of sight. Pure: the caller passes the rectangles.

export interface Span {
  top: number
  bottom: number
}

/** A section shows some of itself in the reading area. */
const inView = (r: Span | undefined, area: Span): boolean =>
  r !== undefined && r.bottom > area.top + 1 && r.top < area.bottom - 1

/** The section under the reading area's top line (`gap` px into it), else -1. */
function atTopLine(rects: readonly Span[], area: Span, gap: number): number {
  const line = area.top + gap + 1
  return rects.findIndex((r) => r.top <= line && r.bottom > line)
}

/**
 * The file R acts on: the keyboard's file (`focused`, else `cursor`) while it is in view, else the file at the top of
 * the reading area, else the first one in view; -1 when no file is in view (R then does nothing).
 */
export function currentFile(
  rects: readonly Span[],
  area: Span,
  focused: number,
  cursor: number,
  gap = 0,
): number {
  for (const i of [focused, cursor]) if (i !== -1 && inView(rects[i], area)) return i
  const top = atTopLine(rects, area, gap)
  if (top !== -1) return top
  return rects.findIndex((r) => inView(r, area))
}

/**
 * The file J (`by` 1) or K (`by` -1) goes to. From the keyboard's file while it is in view, the next or previous one.
 * Otherwise from the reading area's top line: J goes to the next file starting below it, K to the start of the file
 * it is in (when that file's header is above it) or else to the previous one. Clamped to the list; -1 when empty.
 */
export function stepFile(
  rects: readonly Span[],
  area: Span,
  by: 1 | -1,
  focused: number,
  cursor: number,
  gap = 0,
): number {
  const n = rects.length
  if (n === 0) return -1
  const clamp = (i: number): number => Math.min(n - 1, Math.max(0, i))
  for (const i of [focused, cursor]) if (i !== -1 && inView(rects[i], area)) return clamp(i + by)
  const line = area.top + gap + 1
  if (by === 1) {
    const below = rects.findIndex((r) => r.top > line)
    return below === -1 ? n - 1 : below
  }
  const at = atTopLine(rects, area, gap)
  if (at !== -1) return (rects[at]?.top ?? 0) < line - 2 ? at : clamp(at - 1)
  let above = -1
  rects.forEach((r, i) => {
    if (r.bottom <= line) above = i
  })
  return above === -1 ? 0 : above
}
