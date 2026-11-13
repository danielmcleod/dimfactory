// Stable selector hooks over the store. Each returns a value whose
// identity changes only when that data changed, so components re-render only for their own slice. Lists of ids use
// useShallow; filtering by status is selection, not derivation.
import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { RunStatus, RunSummary } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { ensureRun } from './runs.ts'
import { useStore } from './store.ts'
import type { AppSlice, AttentionSlice, Notice, QuitRequest, RunEntry, ToastItem } from './store.ts'

/** Statuses of a run that is still going (Dashboard "Active", Runs mini-list, `runs.list` at start). */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting', 'paused']

export function isActiveStatus(s: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(s)
}

export const useAppInfo = (): AppSlice['info'] => useStore((s) => s.app.info)
export const useTheme = (): AppSlice['theme'] => useStore((s) => s.app.theme)
export const useBridgeState = (): AppSlice['bridge'] => useStore((s) => s.app.bridge)
export const useLostContact = (): boolean => useStore((s) => s.app.lostContact)
export const useQuitRequested = (): QuitRequest | null => useStore((s) => s.app.quitRequested)
export const useNotices = (): Notice[] => useStore((s) => s.app.notices)
export const useConfigEpoch = (): number => useStore((s) => s.app.configEpoch)

export const useSummary = (runId: string): RunSummary | undefined => useStore((s) => s.summaries.byId[runId])
export const useSummariesLoaded = (): boolean => useStore((s) => s.summaries.loaded)

/** Run ids newest first; `active` = queued/running/waiting/paused, `finished` = everything else. */
export function useRunIds(which: 'all' | 'active' | 'finished' = 'all', limit?: number): string[] {
  return useStore(
    useShallow((s) => {
      const ids = s.summaries.order.filter((id) => {
        if (which === 'all') return true
        const sum = s.summaries.byId[id]
        if (sum === undefined) return false
        return isActiveStatus(sum.status) === (which === 'active')
      })
      return limit === undefined ? ids : ids.slice(0, limit)
    }),
  )
}

/** Number of active runs (sidebar badge). */
export function useActiveRunCount(): number {
  return useStore(
    (s) =>
      s.summaries.order.filter((id) => isActiveStatus(s.summaries.byId[id]?.status ?? 'completed')).length,
  )
}

/** The run's store entry, or undefined before anything asked for it. */
export const useRunEntry = (runId: string): RunEntry | undefined => useStore((s) => s.runs.byId[runId])

/** The run's entry, loading its snapshot on mount when it is not in the store yet. */
export function useRun(runId: string): RunEntry | undefined {
  useEffect(() => ensureRun(runId), [runId])
  return useRunEntry(runId)
}

export const useAttention = (): AttentionSlice => useStore((s) => s.attention)
export const useNeedsYou = (): number => useStore((s) => s.attention.needsYou)

export const useProbe = (vendor: string): ProbeView | undefined => useStore((s) => s.probes.byVendor[vendor])
export function useProbes(): ProbeView[] {
  return useStore(
    useShallow((s) => s.probes.order.map((v) => s.probes.byVendor[v]).filter((p) => p !== undefined)),
  )
}

export const useToasts = (): ToastItem[] => useStore((s) => s.toasts.items)
