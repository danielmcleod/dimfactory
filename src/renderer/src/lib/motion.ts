// prefers-reduced-motion, followed live. The stylesheet stops CSS animations and transitions under it
// (styles/index.css); SVG animations (the Plops') are elements, so their components read this and draw still.
import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function media(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null
}

function subscribe(cb: () => void): () => void {
  const m = media()
  if (m === null) return () => {}
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}

export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false)
}
