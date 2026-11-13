// Store mutations. Each one replaces what core sent; none computes a
// status, phase, cost, finding count or estimate. The bridge and the pages call these; components read through
// state/selectors.ts.
import type { AttentionItem } from '@shared/estimates.ts'
import type { AppInfo, ThemeState } from '@shared/ipc.ts'
import type { RunSnapshot, RunSummary } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { useStore } from './store.ts'
import type { Notice, QuitRequest, RunEntry, StoreState } from './store.ts'

const set = useStore.setState
const get = useStore.getState

function byNewest(byId: Record<string, RunSummary>): string[] {
  return Object.values(byId)
    .sort((a, b) => b.createdAt - a.createdAt || b.displayNo - a.displayNo)
    .map((s) => s.runId)
}

// ---- app ------------------------------------------------------------------------------------------------------------

export function setAppInfo(info: AppInfo | null): void {
  set((s) => ({ app: { ...s.app, info } }))
}

export function setThemeState(theme: ThemeState): void {
  set((s) => ({ app: { ...s.app, theme } }))
}

export function setBridgeState(bridge: StoreState['app']['bridge']): void {
  if (get().app.bridge === bridge) return
  set((s) => ({ app: { ...s.app, bridge } }))
}

export function setLostContact(lostContact: boolean): void {
  if (get().app.lostContact === lostContact) return
  set((s) => ({ app: { ...s.app, lostContact } }))
}

export function setQuitRequested(q: QuitRequest | null): void {
  set((s) => ({ app: { ...s.app, quitRequested: q } }))
}

export function addNotice(n: Notice): void {
  set((s) => ({ app: { ...s.app, notices: [...s.app.notices.filter((x) => x.id !== n.id), n] } }))
}

export function dismissNotice(id: string): void {
  set((s) => ({ app: { ...s.app, notices: s.app.notices.filter((n) => n.id !== id) } }))
}

export function bumpConfigEpoch(): void {
  set((s) => ({ app: { ...s.app, configEpoch: s.app.configEpoch + 1 } }))
}

// ---- summaries ------------------------------------------------------------------------------------------------------

/** Insert or replace summaries (runs.list pages, `run-summary` events, snapshots). */
export function upsertSummaries(list: readonly RunSummary[], opts: { loaded?: boolean } = {}): void {
  if (list.length === 0 && opts.loaded !== true) return
  set((s) => {
    const byId = { ...s.summaries.byId }
    for (const sum of list) byId[sum.runId] = sum
    return {
      summaries: {
        byId,
        order: byNewest(byId),
        loaded: s.summaries.loaded || opts.loaded === true,
      },
    }
  })
}

export function setSummariesError(error: string): void {
  set((s) => ({ summaries: { ...s.summaries, loaded: true, error } }))
}

/** Drop runs that core removed (runs.remove); their snapshots go too. */
export function removeRuns(runIds: readonly string[]): void {
  set((s) => {
    const byId = { ...s.summaries.byId }
    const runs = { ...s.runs.byId }
    for (const id of runIds) {
      delete byId[id]
      delete runs[id]
    }
    return { summaries: { ...s.summaries, byId, order: byNewest(byId) }, runs: { byId: runs } }
  })
}

// ---- run snapshots --------------------------------------------------------------------------------------------------

export function setRunEntry(runId: string, entry: RunEntry): void {
  set((s) => ({ runs: { byId: { ...s.runs.byId, [runId]: entry } } }))
}

export function setRunLoading(runId: string): void {
  const cur = get().runs.byId[runId]
  setRunEntry(runId, { snapshot: cur?.snapshot ?? null, lastSeq: cur?.lastSeq ?? 0, status: 'loading' })
}

/**
 * Replace a run's snapshot with the one core returned. An older snapshot (lower lastSeq) than the one held is
 * ignored, so overlapping runs.get calls cannot move the view backwards. Returns whether it was applied.
 */
export function applySnapshot(snapshot: RunSnapshot): boolean {
  const runId = snapshot.summary.runId
  const cur = get().runs.byId[runId]
  if (cur?.snapshot != null && snapshot.lastSeq < cur.lastSeq) return false
  set((s) => {
    const byId = { ...s.summaries.byId, [runId]: snapshot.summary }
    return {
      runs: { byId: { ...s.runs.byId, [runId]: { snapshot, lastSeq: snapshot.lastSeq, status: 'ready' } } },
      summaries: { ...s.summaries, byId, order: byNewest(byId) },
    }
  })
  return true
}

/**
 * Snapshots kept for finished runs nobody shows, the newest this many by creation (the Dashboard's recent
 * rows and Settings → Self-heal's history, HISTORY_RUNS, read them).
 */
export const FINISHED_SNAPSHOTS_KEPT = 20

const FINISHED: ReadonlySet<string> = new Set(['completed', 'cancelled'])

/**
 * Drop the snapshots of finished runs (completed or cancelled) that are not in `keep` (the bridge's focused runs: an
 * open Run view, a run with asks) and not among the newest FINISHED_SNAPSHOTS_KEPT runs. Their summaries stay, and a
 * view that opens one loads it again (ensureRun). Before, every run of a session kept its snapshot here until the app
 * restarted (a soak test saw the renderer grow). Returns the runs dropped.
 */
export function pruneRunSnapshots(keep: ReadonlySet<string>): string[] {
  const s = get()
  const newest = new Set(s.summaries.order.slice(0, FINISHED_SNAPSHOTS_KEPT))
  const drop = Object.entries(s.runs.byId)
    .filter(([id, e]) => {
      if (keep.has(id) || newest.has(id) || e.status === 'loading') return false
      const status = s.summaries.byId[id]?.status ?? e.snapshot?.summary.status
      return status !== undefined && FINISHED.has(status)
    })
    .map(([id]) => id)
  if (drop.length === 0) return drop
  set((st) => {
    const runs = { ...st.runs.byId }
    for (const id of drop) delete runs[id]
    return { runs: { byId: runs } }
  })
  return drop
}

export function setRunError(runId: string, error: string): void {
  const cur = get().runs.byId[runId]
  setRunEntry(runId, { snapshot: cur?.snapshot ?? null, lastSeq: cur?.lastSeq ?? 0, status: 'error', error })
}

// ---- attention / probes -----------------------------------------------------------------------------------------------

export function setAttention(needsYou: number, items: AttentionItem[]): void {
  set({ attention: { needsYou, items } })
}

export function upsertProbes(views: readonly ProbeView[]): void {
  if (views.length === 0) return
  set((s) => {
    const byVendor = { ...s.probes.byVendor }
    const order = [...s.probes.order]
    for (const v of views) {
      if (byVendor[v.vendor] === undefined) order.push(v.vendor)
      byVendor[v.vendor] = v
    }
    return { probes: { byVendor, order } }
  })
}
