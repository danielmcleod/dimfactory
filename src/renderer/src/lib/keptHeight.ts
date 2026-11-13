// An element that keeps the tallest height it reached while it lives (UI standard: async content never shifts the
// page; reserve its space). Content core replaces with shorter content
// (a vendor row whose fix took effect seconds after the click) leaves its room instead of pulling the page up.
import { useCallback, useRef, useState } from 'react'
import type { CSSProperties, RefCallback } from 'react'

export function useKeptHeight<T extends HTMLElement>(): [RefCallback<T>, CSSProperties | undefined] {
  const [px, setPx] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (el === null) return
    const grow = (): void => {
      const h = el.getBoundingClientRect().height
      setPx((p) => (h > p ? h : p))
    }
    grow()
    if (typeof ResizeObserver === 'undefined') return
    const o = new ResizeObserver(grow)
    o.observe(el)
    observer.current = o
  }, [])
  return [ref, px > 0 ? { minHeight: px } : undefined]
}
