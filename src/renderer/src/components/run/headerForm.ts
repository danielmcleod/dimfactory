// The Run view's sticky block in two forms (UI standards: one scroll region per screen, nothing moves on its own). The full form is the RunHeader's three lines, the tabs and the step
// timeline. Where it would leave the reading area between it and the SummaryBar under COMPACT_BELOW of <main>'s
// height (a small window, or page zoom, which makes the page's CSS viewport smaller), the block takes its compact
// form instead: one header row, the tabs and a one-line step strip.
//
// The form is decided from measurements of <main> and the bars (a ResizeObserver, so a window resize and a zoom step
// both count), before the browser paints: a switch never shows one form and then the other. While the compact form
// shows, what the full one would take is worked out at the page's width now: the full block's height besides its
// timeline (the header and the tabs, lines that never wrap, so the same at any width) as measured while it last
// showed, plus the height of the full timeline laid out unseen at the current width (TimelineRuler: its nodes wrap to
// more rows on a narrower page). A height remembered from another width would keep the compact form where the full one
// fits (zoomed to 150% and back to 110%). Going back needs NORMAL_FROM (more than COMPACT_BELOW), so a size between
// the two keeps the form it has and the two forms never take turns. A switch keeps
// the reading position: main's scroll offset is held, so what was at the top of the reading area stays at its top,
// just under the block; a page read to its end stays at its end. The browser's scroll anchoring is off from a switch
// until the page next scrolls: it would follow the content the block's new height moves (at once, or at a later
// layout from the anchor it chose before the switch) and scroll the page on its own. A scroll drops that anchor.
import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { flushSync } from 'react-dom'
import { useMainScroller } from '../shell/mainScroll.ts'

export type HeaderForm = 'full' | 'compact'

/** Below this share of <main>'s height for the reading area under the full block, the block turns compact. */
export const COMPACT_BELOW = 0.55
/** The full block comes back once it would leave the reading area at least this share (hysteresis). */
export const NORMAL_FROM = 0.6

export interface HeaderMeasures {
  /** <main>'s height (px). */
  main: number
  /** The full sticky block's height (px) at the page's width now; null while that is not known. */
  full: number | null
  /** The SummaryBar's height (px). */
  bottom: number
}

/** The form the block should take, given the one it has now. */
export function nextHeaderForm(current: HeaderForm, m: HeaderMeasures): HeaderForm {
  if (m.main <= 0 || m.full === null) return current
  const reading = (m.main - m.full - m.bottom) / m.main
  if (current === 'full') return reading < COMPACT_BELOW ? 'compact' : 'full'
  return reading >= NORMAL_FROM ? 'full' : 'compact'
}

/**
 * What the full block would take now (px): its height while it shows; while the compact one shows, its height
 * besides the timeline (`rest`, measured while it last showed) plus the full timeline's height at the current width
 * (`timeline`, the ruler's); the last full height when there is no ruler; null before anything is measured.
 */
export function fullBlockHeight(
  shown: HeaderForm,
  m: { block: number; timeline: number | null; rest: number | null; lastFull: number | null },
): number | null {
  if (shown === 'full' && m.block > 0) return m.block
  if (m.rest !== null && m.timeline !== null) return m.rest + m.timeline
  return m.lastFull
}

/**
 * The form of the Run view's sticky block (`top`) above the SummaryBar (`bottom`), decided as described above, with
 * `ruler` the full timeline laid out unseen at the block's width. It starts full: its first measure (before the first
 * paint) turns it compact where it must.
 */
export function useHeaderForm(
  top: RefObject<HTMLElement | null>,
  bottom: RefObject<HTMLElement | null>,
  ruler?: RefObject<HTMLElement | null>,
): HeaderForm {
  const main = useMainScroller()
  const [form, setForm] = useState<HeaderForm>('full')
  const shown = useRef<HeaderForm>('full')
  const full = useRef<number | null>(null)
  const rest = useRef<number | null>(null)
  useLayoutEffect(() => {
    const t = top.current
    const b = bottom.current
    const r = ruler?.current ?? null
    if (main === null || t === null || b === null) return
    let restore = 0
    const anchoringBack = (): void => {
      main.style.removeProperty('overflow-anchor')
    }
    const decide = (sync: boolean): void => {
      const height = t.getBoundingClientRect().height
      const timeline = r !== null ? r.getBoundingClientRect().height : null
      if (shown.current === 'full' && height > 0) {
        full.current = height
        // The ruler is the shown timeline's twin: the rest is the header, the tabs and the timeline's padding.
        rest.current = timeline !== null ? height - timeline : null
      }
      const next = nextHeaderForm(shown.current, {
        main: main.clientHeight,
        full: fullBlockHeight(shown.current, {
          block: height,
          timeline,
          rest: rest.current,
          lastFull: full.current,
        }),
        bottom: b.getBoundingClientRect().height,
      })
      if (next === shown.current) return
      shown.current = next
      // Keep the reading position: hold main's offset, with the browser's scroll anchoring off. A page read to its
      // end stays at its end (a window grown at the end of the page has just been held there by the browser).
      const offset = main.scrollTop
      const end = main.scrollHeight - main.clientHeight
      const atEnd = offset > 0 && end > 0 && offset >= end - 1
      main.style.overflowAnchor = 'none'
      if (sync) flushSync(() => setForm(next))
      else setForm(next)
      const keep = atEnd ? Math.max(0, main.scrollHeight - main.clientHeight) : offset
      if (main.scrollTop !== keep) main.scrollTop = keep
      // Anchoring comes back with the page's next scroll (listened for from the next frame, past any scroll event
      // already on its way).
      main.removeEventListener('scroll', anchoringBack)
      cancelAnimationFrame(restore)
      restore = requestAnimationFrame(() =>
        main.addEventListener('scroll', anchoringBack, { once: true, passive: true }),
      )
    }
    decide(false)
    // In the observer's callback the layout is done and the paint not yet: flushSync renders the switch now.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => decide(true)) : null
    ro?.observe(main)
    ro?.observe(t)
    ro?.observe(b)
    if (r !== null) ro?.observe(r)
    return () => {
      ro?.disconnect()
      cancelAnimationFrame(restore)
      main.removeEventListener('scroll', anchoringBack)
      anchoringBack()
    }
  }, [main, top, bottom, ruler])
  return form
}
