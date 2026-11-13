// Data for a Settings section (performance.spec.ts: Settings navigation < 200 ms). A section
// renders at once and reads core only once it has been open for SECTION_LOAD_DELAY_MS, so a switch never waits on
// IPC and passing through a section costs none. `key` names what is read (a different key starts empty again);
// `version` reads the same thing again (a config change) while the last answer stays on screen, so nothing flashes
// or moves while it reloads. Also here: a section's own deep-link targets (useLinkFocus, for core's settings_link
// pointers that are not rows of the Settings index) and byte sizes in words.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result } from '@shared/ipc.ts'
import { useMainScroller } from '../../components/shell/mainScroll.ts'
import { currentHash, useRoute } from '../../lib/router.ts'

/** How long a section is open before it reads its data (SelfHealSection uses the same). */
export const SECTION_LOAD_DELAY_MS = 150

export interface SectionData<T> {
  /** The last answer for this key, or null before the first one. */
  value: T | null
  /** The last read's error message (the value, if any, is the one before it). */
  error: string | null
  /** A read for this key is waiting or in flight. */
  loading: boolean
  /** Read again now (after the delay). */
  reload: () => void
  /** Replace the value with a newer answer core gave elsewhere (e.g. `storage.clearShadow`'s usage). */
  set: (value: T) => void
}

interface State<T> {
  key: string | null
  value: T | null
  error: string | null
  /** The read that answered (key, version, nonce): loading until it matches the current one. */
  answered: string | null
}

export function useSectionData<T>(
  key: string | null,
  load: () => Promise<Result<T>>,
  version: number | string = 0,
): SectionData<T> {
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<State<T>>({ key: null, value: null, error: null, answered: null })
  const read = JSON.stringify([key, version, nonce])

  useEffect(() => {
    if (key === null) return
    let alive = true
    const t = setTimeout(() => {
      void loadRef.current().then((r) => {
        if (!alive) return
        setState((s) => {
          const same = s.key === key
          return r.ok
            ? { key, value: r.value, error: null, answered: read }
            : { key, value: same ? s.value : null, error: r.error.message, answered: read }
        })
      })
    }, SECTION_LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [key, read])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const set = useCallback((value: T) => setState((s) => ({ ...s, key, value, error: null })), [key])
  const mine = state.key === key && key !== null
  return {
    value: mine ? state.value : null,
    error: mine ? state.error : null,
    loading: key !== null && state.answered !== read,
    reload,
    set,
  }
}

/**
 * A deep link into a section (`#/settings/<section>?field=…`, e.g. core's settings_link pointers) brings its target into
 * view and focuses it, once per navigation and as soon as the target exists (it may wait for the section's data). That
 * is the direct result of the user's navigation (UI standard: nothing scrolls automatically except as the direct
 * result of a user action); if the page was scrolled since the link was followed, the target is only focused. `ready` is
 * anything that changes when the target may have appeared.
 */
export function useLinkFocus(
  matches: (field: string) => boolean,
  find: () => HTMLElement | null,
  ready: unknown,
): void {
  const route = useRoute()
  const field = route.name === 'settings' ? route.query['field'] : undefined
  const wanted = field !== undefined && field !== '' && matches(field)
  const main = useMainScroller()
  const findRef = useRef(find)
  useEffect(() => {
    findRef.current = find
  })
  const focusKey = currentHash()
  const doneFor = useRef<string | null>(null)
  const scrolledAt = useRef<{ key: string; top: number } | null>(null)
  useEffect(() => {
    if (!wanted || doneFor.current === focusKey) return
    if (scrolledAt.current?.key !== focusKey)
      scrolledAt.current = { key: focusKey, top: main?.scrollTop ?? 0 }
    const el = findRef.current()
    if (el === null) return
    doneFor.current = focusKey
    const userScrolled = main !== null && Math.abs(main.scrollTop - scrolledAt.current.top) > 1
    if (!userScrolled) el.scrollIntoView?.({ block: 'center' })
    el.focus({ preventScroll: true })
  }, [wanted, focusKey, ready, main])
}

/** `1.2 MB`, `830 KB`, `0 B` (binary units, one decimal from KB up). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${Math.round(v)} B` : `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
