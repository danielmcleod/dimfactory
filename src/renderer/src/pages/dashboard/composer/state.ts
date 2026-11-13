// Composer state: the user's pending run overrides and the per-viewer layout
// conveniences (the pass rows' and the Brief panel's open state and heights). The overrides keep their identity until their content changes, so the
// effects that ask core (config.resolve, preflight.run, estimates.get) run once per real change. The layout keys live
// in the page origin's browser storage (app://dim-factory; they started over once, when the renderer moved there
// from file://).
import { useCallback, useRef, useState } from 'react'
import type { RunOverrides } from '@shared/config-schema.ts'
import { NO_OVERRIDES, settle } from './overrides.ts'
import { BRAND } from '@shared/brand.ts'

export type OverridesUpdate = (o: RunOverrides) => RunOverrides

/**
 * The pending overrides, the updater, and `latest()`: what the updates so far amount to, before React re-renders.
 * Run reads `latest()`, so a field that commits as ⌘/Ctrl+Enter is pressed (the model box) is in the request.
 */
export function useOverrides(): [RunOverrides, (update: OverridesUpdate) => void, () => RunOverrides] {
  const [overrides, set] = useState<RunOverrides>(NO_OVERRIDES)
  const current = useRef<RunOverrides>(NO_OVERRIDES)
  const update = useCallback((fn: OverridesUpdate) => {
    const next = settle(current.current, fn(current.current))
    current.current = next
    set(next)
  }, [])
  const latest = useCallback(() => current.current, [])
  return [overrides, update, latest]
}

export const PASSES_OPEN_KEY = `${BRAND.storagePrefix}composer.passesOpen`

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch {
    // Browser storage is a convenience: blocked or full storage just forgets the layout.
  }
}

/** Whether the pass rows are shown (remembered for this viewer). */
export function usePassesOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readFlag(PASSES_OPEN_KEY))
  const set = useCallback((v: boolean) => {
    setOpen(v)
    writeFlag(PASSES_OPEN_KEY, v)
  }, [])
  return [open, set]
}

export const PASSES_HEIGHT_KEY = `${BRAND.storagePrefix}composer.passesHeight`
/** The open pass rows' height (px) before this viewer's first measurement: five rows, gates, where, the footer. */
export const DEFAULT_PASSES_HEIGHT = 236

/**
 * The open pass rows' height (rows collapsed), as last measured for this viewer: the composer reserves it while it
 * waits for core's configuration, so the rows arriving move nothing below them (UI standard: async content never
 * shifts the page). Returns the height and a function that records a new measurement.
 */
export function usePassesHeight(): [number, (px: number) => void] {
  const [px, setPx] = useState(() => {
    try {
      const v = Number(window.localStorage.getItem(PASSES_HEIGHT_KEY))
      return Number.isFinite(v) && v > 0 ? v : DEFAULT_PASSES_HEIGHT
    } catch {
      return DEFAULT_PASSES_HEIGHT
    }
  })
  const record = useCallback((next: number) => {
    const v = Math.round(next)
    if (v <= 0) return
    setPx(v)
    try {
      window.localStorage.setItem(PASSES_HEIGHT_KEY, String(v))
    } catch {
      // A convenience only: blocked storage just reserves the default next time.
    }
  }, [])
  return [px, record]
}

export const BRIEF_OPEN_KEY = `${BRAND.storagePrefix}composer.briefOpen`

/** Whether the Brief panel is open (remembered for this viewer; closed by default). */
export function useBriefOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readFlag(BRIEF_OPEN_KEY))
  const set = useCallback((v: boolean) => {
    setOpen(v)
    writeFlag(BRIEF_OPEN_KEY, v)
  }, [])
  return [open, set]
}

export const BRIEF_HEIGHT_KEY = `${BRAND.storagePrefix}composer.briefHeight`
/** The open Brief panel's height (px) before this viewer's first measurement. */
export const DEFAULT_BRIEF_HEIGHT = 420

/**
 * The open Brief panel's height, as last measured for this viewer: reserved while core's detection is on its way, so
 * the rows arriving move nothing below them (the Run row). Returns the height and a function that records a new one.
 */
export function useBriefHeight(): [number, (px: number) => void] {
  const [px, setPx] = useState(() => {
    try {
      const v = Number(window.localStorage.getItem(BRIEF_HEIGHT_KEY))
      return Number.isFinite(v) && v > 0 ? v : DEFAULT_BRIEF_HEIGHT
    } catch {
      return DEFAULT_BRIEF_HEIGHT
    }
  })
  const record = useCallback((next: number) => {
    const v = Math.round(next)
    if (v <= 0) return
    setPx(v)
    try {
      window.localStorage.setItem(BRIEF_HEIGHT_KEY, String(v))
    } catch {
      // A convenience only: blocked storage just reserves the default next time.
    }
  }, [])
  return [px, record]
}
