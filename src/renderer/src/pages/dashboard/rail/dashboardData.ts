// Dashboard data from core: `dashboard.get` when the Dashboard
// opens, then again (debounced) after run-summary, attention and probe events. Live run cards keep reading the
// bridge's summaries for instant updates; totals, spend, vendor health and catalog status come from here. A core
// without dashboard.get (UNSUPPORTED) leaves the rail's fallback state in place and is not asked again.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { DashboardData } from '@shared/estimates.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { invoke } from '../../../ipc/client.ts'
import { upsertProbes, upsertSummaries } from '../../../state/actions.ts'
import { noteCatalogStatus } from '../../../state/catalog.ts'
import { useStore } from '../../../state/store.ts'

/** Quiet time after the last event before refetching, and the longest a burst of events may hold it back. */
export const DASHBOARD_REFRESH_MS = 500
export const DASHBOARD_REFRESH_MAX_MS = 3000

export type DashboardStatus = 'loading' | 'ready' | 'unsupported' | 'error'

export interface DashboardState {
  status: DashboardStatus
  /** The last answer (kept through a later error). */
  data: DashboardData | null
  error?: string
}

const INITIAL: DashboardState = { status: 'loading', data: null }

/** Last Dashboard data; the shell reads the catalog status from it. */
export const useDashboardStore = create<DashboardState>()(() => INITIAL)

export function resetDashboardForTests(): void {
  useDashboardStore.setState(INITIAL, true)
}

const probeAt = (v: ProbeView | undefined): number => v?.probe?.at ?? -1

/**
 * Bring the store up to date with what core sent, without moving it backwards: active runs the store does not have
 * yet (the bridge's summaries are fresher for the ones it has; recent ones only before the bridge loaded its own,
 * so a run removed meanwhile does not come back) and vendor views newer than the stored ones.
 */
function sync(data: DashboardData): void {
  const s = useStore.getState()
  const candidates = s.summaries.loaded ? data.active : [...data.active, ...data.recent]
  const missing = candidates.filter((r) => s.summaries.byId[r.runId] === undefined)
  if (missing.length > 0) upsertSummaries(missing)
  const newer = data.vendorHealth.filter((v) => {
    const cur = s.probes.byVendor[v.vendor]
    return cur === undefined || probeAt(v) > probeAt(cur)
  })
  if (newer.length > 0) upsertProbes(newer)
  // The catalog's status lives in the store's catalog slice (the consent card, the Settings dot, cost labels).
  noteCatalogStatus(data.catalog)
}

/** Fetch and keep refreshing while mounted (the Dashboard page). */
export function useDashboardData(): DashboardState {
  useEffect(() => {
    let alive = true
    let unsupported = false
    let inFlight = false
    let again = false
    let syncing = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let firstAskedAt: number | null = null

    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true
        return
      }
      inFlight = true
      const r = await invoke('dashboard.get')
      inFlight = false
      if (!alive) return
      if (r.ok) {
        syncing = true
        try {
          sync(r.value)
        } finally {
          syncing = false
        }
        useDashboardStore.setState({ status: 'ready', data: r.value }, true)
      } else if (r.error.code === 'UNSUPPORTED') {
        unsupported = true
        useDashboardStore.setState({ status: 'unsupported', data: null }, true)
      } else {
        useDashboardStore.setState(
          (cur) => ({ status: 'error', data: cur.data, error: r.error.message }),
          true,
        )
      }
      if (again) {
        again = false
        schedule()
      }
    }

    const schedule = (): void => {
      if (!alive || unsupported) return
      const now = Date.now()
      firstAskedAt ??= now
      if (timer !== null) clearTimeout(timer)
      const wait = Math.max(0, Math.min(DASHBOARD_REFRESH_MS, firstAskedAt + DASHBOARD_REFRESH_MAX_MS - now))
      timer = setTimeout(() => {
        timer = null
        firstAskedAt = null
        void load()
      }, wait)
    }

    void load()
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (syncing) return
      if (
        s.summaries.byId !== prev.summaries.byId ||
        s.attention !== prev.attention ||
        s.probes.byVendor !== prev.probes.byVendor
      )
        schedule()
    })
    return () => {
      alive = false
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
  return useDashboardStore()
}

/** Ask core again now (the setup card's git "I ran it → Re-check"); its answer replaces the stored one. */
export async function reloadDashboard(): Promise<void> {
  const r = await invoke('dashboard.get')
  if (!r.ok) return
  sync(r.value)
  useDashboardStore.setState({ status: 'ready', data: r.value }, true)
}

/**
 * A catalog price update is due (the Settings dot): core's newest status (the store's catalog slice, which a `due`
 * event, Not now and Turn off update too), else the Dashboard's last answer; false until either has answered.
 */
export function useCatalogDue(): boolean {
  const own = useStore((s) => s.catalog.status?.refreshDue)
  const dashboard = useDashboardStore((s) => s.data?.catalog.refreshDue === true)
  return own ?? dashboard
}
