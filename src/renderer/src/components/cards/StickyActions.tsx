// A card's action row, sticky at the bottom of the reading area while the card is on screen (UI
// standard: one scroll region per screen). The plan and the findings read in the page flow with no
// inner scroller, so a long one would otherwise put Approve or Continue out of reach; this row stays in view instead.
// Sticky is not a scroll region and never scrolls anything. It rests just above the Run view's sticky SummaryBar
// (--run-sticky-bottom), spans the card's width and repeats the card's opaque tint (--card-surface, CardView). The
// toast stack keeps above where it sticks, so a toast never covers Approve, Edit or Continue. While it is mounted the
// page scroller keeps its height clear too (mainScroll.ts useStickyRowPadding): keyboard focus moving through the card
// and the text cursor at the end of a long plan land above the row, never under it.
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { useStickyRowPadding } from '../shell/mainScroll.ts'
import { useToastClearance } from '../ui/Toaster.tsx'

/** Where the row sticks, whatever its place now: its bottom offset (the SummaryBar's height) plus its own height. */
function stuckClearance(el: HTMLElement): number {
  const bottom = Number.parseFloat(getComputedStyle(el).bottom)
  return (Number.isFinite(bottom) ? bottom : 0) + el.getBoundingClientRect().height
}

export function StickyActions({
  children,
  testId,
}: {
  children: ReactNode
  testId: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useToastClearance(ref, stuckClearance)
  useStickyRowPadding(ref)
  return (
    <div
      ref={ref}
      data-testid={testId}
      data-sticky-actions=""
      className="sticky bottom-[var(--run-sticky-bottom,0px)] z-10 -mx-3 flex flex-col gap-2 border-t bg-[var(--card-surface,var(--background))] px-3 py-2 [overflow-anchor:none]"
    >
      {children}
    </div>
  )
}
