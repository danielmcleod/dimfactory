// Lazy file bodies: a file's diff is fetched and laid out only once
// its section comes near the page scroller's view (shell/mainScroll.ts), and stays once it has. Read with an
// IntersectionObserver, which only reads: showing a body never scrolls anything, and the section holds its estimated
// height until then (FileSection), so the page does not jump as bodies arrive.
import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { useMainScroller } from '../shell/mainScroll.ts'

/** How far beyond the view a section counts as near (px): bodies are ready a little before they are reached. */
export const NEAR_MARGIN_PX = 600

export function useNearView(ref: RefObject<Element | null>, enabled = true): boolean {
  const root = useMainScroller()
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (near || !enabled || el === null || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { root, rootMargin: `${NEAR_MARGIN_PX}px 0px ${NEAR_MARGIN_PX}px 0px`, threshold: 0 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, root, near, enabled])
  return near
}
