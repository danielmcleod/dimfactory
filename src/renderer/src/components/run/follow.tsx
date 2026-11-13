// The Run view's inner scroll regions and jumps (UI standards: one scroll region per screen, and nothing moves on
// its own).
//
// - An allowed inner region (a pass's vendor output, the Log tab's rows) follows new output only while the user is at
//   its bottom, and only by writing its own scrollTop: the page never moves. Once the user scrolls up it stays where
//   they left it, and "Jump to latest" (an overlay, so it changes no layout) takes them back on click.
// - Every region carries data-scroll-region="<name>" (the guards' whitelist), a fixed maximum height and the shell's
//   `scroll-region` utility (stable gutter, overscroll containment: a wheel at its end never scrolls the page).
// - In the Run view that maximum is also at most --run-region-max (RunPage): the reading area between the sticky
//   header and the SummaryBar less REGION_SLACK_PX. A region never fills the reading area, so the wheel always finds
//   page to scroll beside it, and its bottom edge (with "Jump to latest") is never under the SummaryBar.
// - jumpTo() is how the Run view scrolls the page to something, and only from a click (a jump pill): it brings the
//   element under the sticky header in the shell's page scroller (shell/mainScroll.ts) and focuses it.
import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { scrollIntoMain } from '../shell/mainScroll.ts'
import { Button } from '../ui/Button.tsx'

/** The classes every inner scroll region shares (with its own max height and data-scroll-region). */
export const REGION = 'overflow-y-auto scroll-region'

/** Room an inner scroll region leaves in the Run view's reading area (px): page the wheel still scrolls. */
export const REGION_SLACK_PX = 48
/** The least an inner scroll region gets, however small the reading area (px). */
export const REGION_MIN_PX = 96

/** Within this many px of its bottom, a region counts as at the bottom (and follows new output). */
export const PINNED_SLACK_PX = 24

/** A scroll event this soon after the region changed size is the layout's doing, not the user's (ms). */
export const RESIZE_SCROLL_MS = 150

export function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_SLACK_PX
}

export interface FollowBottom<T extends HTMLElement> {
  /** The scroll region. */
  ref: React.RefObject<T | null>
  /** Its content (resized rows keep a pinned region at the bottom). */
  innerRef: React.RefObject<HTMLDivElement | null>
  onScroll: (e: React.UIEvent<T>) => void
  /** False while the user has scrolled up from the bottom: the region does not follow, "Jump to latest" shows. */
  atBottom: boolean
  /** Back to the newest output, following again (a click). */
  jumpToLatest: () => void
}

/**
 * Keep a region at its bottom as `version` changes (new output), but only while the user is there. Writes the
 * region's own scrollTop and nothing else.
 */
export function useFollowBottom<T extends HTMLElement>(version: unknown, enabled = true): FollowBottom<T> {
  const ref = useRef<T>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (el === null || !enabled || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }, [version, enabled])

  // When the region itself last changed size (the window, zoom, its own cap), and a pending re-pin for it.
  const resizedAt = useRef(Number.NEGATIVE_INFINITY)
  const repinFrame = useRef(0)
  const repin = useCallback((el: T) => {
    if (repinFrame.current !== 0 || typeof requestAnimationFrame === 'undefined') return
    repinFrame.current = requestAnimationFrame(() => {
      repinFrame.current = 0
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
  }, [])

  // Rows sized lazily (content-visibility) grow once they come into view, without a scroll event; keep a pinned
  // region at the bottom as they do. A change of the region's own size only notes the time and re-pins once on the
  // next frame: it must cost nothing per event while a stream fills the region (performance.spec.ts).
  useEffect(() => {
    const el = ref.current
    const body = innerRef.current
    if (el === null || body === null || !enabled || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      if (entries.some((e) => e.target === el)) {
        resizedAt.current = performance.now()
        if (pinned.current) repin(el)
      }
      if (pinned.current && entries.some((e) => e.target === body)) el.scrollTop = el.scrollHeight
    })
    ro.observe(body)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (repinFrame.current !== 0) cancelAnimationFrame(repinFrame.current)
      repinFrame.current = 0
    }
  }, [enabled, repin])

  const onScroll = useCallback(
    (e: React.UIEvent<T>) => {
      const el = e.currentTarget
      const at = isAtBottom(el)
      if (!at && pinned.current && performance.now() - resizedAt.current < RESIZE_SCROLL_MS) {
        // The browser moved the scroll position because the region changed size, not the user: keep following.
        repin(el)
        return
      }
      pinned.current = at
      setAtBottom(at)
    },
    [repin],
  )

  const jumpToLatest = useCallback(() => {
    const el = ref.current
    pinned.current = true
    setAtBottom(true)
    if (el === null) return
    el.scrollTop = el.scrollHeight
    // The button goes away with the jump: keep a keyboard user's focus in the region they were reading.
    el.focus({ preventScroll: true })
  }, [])

  return { ref, innerRef, onScroll, atBottom, jumpToLatest }
}

/** "Jump to latest" over a region's bottom right corner: an overlay, so showing it moves nothing. */
export function JumpToLatest({
  onClick,
  testId,
  className,
}: {
  onClick: () => void
  testId: string
  className?: string
}): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant="secondary"
      data-testid={testId}
      icon={<ArrowDown aria-hidden />}
      onClick={onClick}
      className={cn('absolute right-5 bottom-2 z-10 border shadow-md', className)}
    >
      Jump to latest
    </Button>
  )
}

/**
 * Bring `el` to the top of the page scroller's reading area, `top` px under the sticky header, and focus it without
 * a second scroll. Only ever called from a click.
 */
export function jumpTo(main: HTMLElement | null, el: HTMLElement, top: number): void {
  scrollIntoMain(main, el, { top })
  el.focus({ preventScroll: true })
}

/**
 * A jump target's gap under the sticky header. The Run view sets the page scroller's scroll-padding to the header, so
 * a timeline node's scrollIntoView and keyboard focus land below it too.
 */
export const JUMP_MARGIN = 'scroll-mt-2'
