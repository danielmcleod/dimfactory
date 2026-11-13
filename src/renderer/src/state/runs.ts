// Run snapshot loading. A structural envelope (anything but a stream event; an ask counts
// as structural) schedules a trailing, per-run debounced runs.get that replaces the snapshot: the renderer reflects
// core state and never patches statuses itself. One request per run is in flight at a time; changes that arrive
// meanwhile cause exactly one more fetch.
import { invoke } from '../ipc/client.ts'
import { applySnapshot, setRunError, setRunLoading } from './actions.ts'
import { useStore } from './store.ts'

/** Trailing debounce for structural changes. */
export const REFETCH_DEBOUNCE_MS = 120
/** Under a steady stream of structural changes, fetch at least this often. */
export const REFETCH_MAX_WAIT_MS = 1000

interface Lane {
  timer: ReturnType<typeof setTimeout> | null
  firstScheduledAt: number | null
  inFlight: boolean
  again: boolean
}

const lanes = new Map<string, Lane>()

function lane(runId: string): Lane {
  let l = lanes.get(runId)
  if (l === undefined) {
    l = { timer: null, firstScheduledAt: null, inFlight: false, again: false }
    lanes.set(runId, l)
  }
  return l
}

/** Debounced snapshot refetch (structural envelope, resync). */
export function scheduleRefetch(runId: string): void {
  const l = lane(runId)
  if (l.inFlight) {
    l.again = true
    return
  }
  const now = Date.now()
  l.firstScheduledAt ??= now
  if (l.timer !== null) clearTimeout(l.timer)
  const wait = Math.max(0, Math.min(REFETCH_DEBOUNCE_MS, l.firstScheduledAt + REFETCH_MAX_WAIT_MS - now))
  l.timer = setTimeout(() => {
    l.timer = null
    l.firstScheduledAt = null
    void fetchSnapshot(runId)
  }, wait)
}

/** Fetch now (or right after the request in flight). Resolves once the snapshot is in the store or failed. */
export async function fetchSnapshot(runId: string): Promise<void> {
  const l = lane(runId)
  if (l.inFlight) {
    l.again = true
    return
  }
  if (l.timer !== null) {
    clearTimeout(l.timer)
    l.timer = null
    l.firstScheduledAt = null
  }
  l.inFlight = true
  const cur = useStore.getState().runs.byId[runId]
  if (cur?.snapshot == null) setRunLoading(runId)
  try {
    const r = await invoke('runs.get', { runId })
    if (r.ok) applySnapshot(r.value)
    else if (useStore.getState().runs.byId[runId]?.snapshot == null) setRunError(runId, r.error.message)
  } finally {
    l.inFlight = false
    if (l.again) {
      l.again = false
      scheduleRefetch(runId)
    }
  }
}

/** Load a run's snapshot unless it is loaded or loading (pages call this on mount). */
export function ensureRun(runId: string): void {
  const cur = useStore.getState().runs.byId[runId]
  if (cur !== undefined && (cur.status === 'ready' || cur.status === 'loading')) return
  void fetchSnapshot(runId)
}

/** Forget a run's refetch lane when nothing is scheduled or in flight (its snapshot was dropped). */
export function forgetRunLane(runId: string): void {
  const l = lanes.get(runId)
  if (l !== undefined && l.timer === null && !l.inFlight) lanes.delete(runId)
}

/** Stop every pending refetch (bridge stop, tests). */
export function cancelRefetches(): void {
  for (const l of lanes.values()) if (l.timer !== null) clearTimeout(l.timer)
  lanes.clear()
}
