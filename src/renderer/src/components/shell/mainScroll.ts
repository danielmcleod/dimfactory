// The page's one scroll region (UI standards: one scroll region per screen, and nothing moves on its own). The shell locks html/body/#root to the window, and <main> (Shell.tsx) is the only
// element that scrolls the page. Pages read it from here for their sticky bars and "jump to" pills, which must observe
// and scroll that element, not the window.
//
//   const main = useMainScroller()                   // the <main> element, or null before it mounts
//   const where = useViewPosition(ref, { top: 48 })  // 'in' | 'above' | 'below' main's view (under a 48 px bar)
//   scrollIntoMain(main, el, { top: 48 })            // only from a user's click: bring el to main's top
//   useMainScrollPadding({ top: 120, bottom: 44 })   // a page's sticky bars: the browser's own scrolling clears them
//   useStickyRowPadding(ref)                         // a card's sticky action row: the same, while it is mounted
//
// The scroll padding is what the browser keeps clear when it scrolls on its own account for the user: keyboard focus
// moving to a control, the text cursor kept in view while typing, a scrollIntoView. <main> carries the `page-scroller`
// utility (styles/index.css), whose scroll-padding adds up --page-pad-top / --page-pad-bottom (a page's sticky bars)
// and --page-pad-row (a card's sticky action row, which rests just above the bottom bar). The row's share is dropped
// while focus is inside the row: the row is in view wherever it sticks, and padding for it would make the browser
// scroll the page under it for nothing each time Tab moves between its buttons. The same goes for the bars: a page
// marks each with data-sticky-bar="top" or "bottom", and while focus is inside one, that side's padding is dropped
// (a control in a bar sits inside the padding kept for the bar, so the browser would scroll for it at every Tab).
//
// Inner regions that may scroll on their own (a vendor stream, the log) are separate: each has data-scroll-region
// with its own name, a fixed max-height and the `scroll-region` utility (styles/index.css). <main> has no
// data-scroll-region, so the guards can tell the page scroller from the inner regions, and no region nests in another.
import { createContext, useContext, useEffect, useState } from 'react'
import type { RefObject } from 'react'

export const MainScrollContext = createContext<HTMLElement | null>(null)

/** The <main> scroller (null before the shell mounts it, and outside the shell). */
export function useMainScroller(): HTMLElement | null {
  return useContext(MainScrollContext)
}

export interface ViewOptions {
  /** Room a sticky bar takes at main's top (px): an element hidden under it is out of view. */
  top?: number
}

/** Where an element is against main's view: in it (even partly), scrolled past (above) or not reached yet (below). */
export type ViewPosition = 'in' | 'above' | 'below'

/**
 * Where the element is against main's view, followed with an IntersectionObserver rooted at main, or null while that
 * is not known (no main, no observer, nothing measured yet). The observer only reads, so a bar shown from it cannot
 * feed back into it as long as that bar overlays the page instead of pushing it.
 */
export function useViewPosition(
  ref: RefObject<Element | null>,
  { top = 0 }: ViewOptions = {},
): ViewPosition | null {
  const root = useMainScroller()
  const [where, setWhere] = useState<ViewPosition | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el === null || root === null || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries.at(-1)
        if (e === undefined) return
        if (e.isIntersecting) setWhere('in')
        else {
          const rootTop = e.rootBounds?.top ?? root.getBoundingClientRect().top + top
          setWhere(e.boundingClientRect.bottom <= rootTop ? 'above' : 'below')
        }
      },
      { root, rootMargin: `-${top}px 0px 0px 0px`, threshold: 0 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, root, top])
  return where
}

/**
 * Bring `el` to main's top, below a sticky bar `top` px high. Call it only as the direct result of a user action (a
 * click on a "jump to" pill or a compact bar): nothing scrolls the page on its own.
 */
export function scrollIntoMain(main: HTMLElement | null, el: Element, { top = 0 }: ViewOptions = {}): void {
  if (main === null) {
    el.scrollIntoView?.({ block: 'start' })
    return
  }
  const offset = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - top
  main.scrollTo?.({ top: Math.max(0, offset) })
}

/** Set a custom property on main, returning what puts back the value it had. */
function setMainProperty(main: HTMLElement, name: string, value: string): () => void {
  const before = main.style.getPropertyValue(name)
  main.style.setProperty(name, value)
  return () => {
    if (before === '') main.style.removeProperty(name)
    else main.style.setProperty(name, before)
  }
}

/**
 * Keep main's scroll padding at a page's sticky bars while the page is mounted (restored after): the browser's own
 * scrolling (a scrollIntoView, keyboard focus moving to a control, the text cursor while typing) then lands between
 * them, never under them.
 */
export function useMainScrollPadding({ top, bottom }: { top: number; bottom: number }): void {
  const main = useMainScroller()
  useEffect(() => {
    if (main === null) return
    const restoreTop = setMainProperty(main, '--page-pad-top', `${top}px`)
    const restoreBottom = setMainProperty(main, '--page-pad-bottom', `${bottom}px`)
    return () => {
      restoreBottom()
      restoreTop()
    }
  }, [main, top, bottom])
}

/** Room kept between a sticky action row and what the browser brings into view above it (px). */
export const STICKY_ROW_GAP = 8

/** The sticky action rows mounted now (a key per row), by their height (px), and main's share for them. */
const rows = new Map<object, { main: HTMLElement; px: number }>()

function applyRows(main: HTMLElement): void {
  const mine = [...rows.values()].filter((r) => r.main === main)
  if (mine.length === 0) main.style.removeProperty('--page-pad-row')
  else main.style.setProperty('--page-pad-row', `${Math.max(...mine.map((r) => r.px)) + STICKY_ROW_GAP}px`)
}

/**
 * A card's sticky action row (cards/StickyActions.tsx) adds its height to main's bottom scroll padding while it is
 * mounted, so focus moving through the card and the text cursor in its editor stay above the row, never under it.
 * The padding drops the row's share while focus is in the row itself (the `page-scroller` utility).
 */
export function useStickyRowPadding(ref: RefObject<HTMLElement | null>): void {
  const main = useMainScroller()
  useEffect(() => {
    const el = ref.current
    if (el === null || main === null) return
    const key = {}
    const measure = (): void => {
      rows.set(key, { main, px: Math.ceil(el.getBoundingClientRect().height) })
      applyRows(main)
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      rows.delete(key)
      applyRows(main)
    }
  }, [ref, main])
}
