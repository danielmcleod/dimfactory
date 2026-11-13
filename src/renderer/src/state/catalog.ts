// The catalog in the renderer (price refresh and estimates; Settings → Catalog and the Dashboard's consent card).
// One slice of the store (store.ts `catalog`) holds what core last said: the whole
// catalog (catalog.get, or the answer of an apply, an undo or a price edit), its status (also from dashboard.get) and
// the refresh job (also from `catalog` events). The commands that change prices go through here, so every one of
// them bumps `epoch` (the composer's estimate and the model pickers ask core again at once) and offers the same Undo.
//
// A refresh only ever starts from a user's click: `startRefresh` is the one place that sends catalog.refresh, always
// with `consent: true`, and nothing calls it on its own (the scheduler in core only raises the consent card).
import { useShallow } from 'zustand/react/shallow'
import type {
  CatalogJob,
  CatalogSchedule,
  CatalogScheduleUpdate,
  CatalogState,
  CatalogStatus,
  PriceEdit,
} from '@shared/catalog.ts'
import type { AppEventOf, Result } from '@shared/ipc.ts'
import { invoke } from '../ipc/client.ts'
import { coreNow } from '../lib/coreClock.ts'
import { useStore } from './store.ts'
import type { CatalogSlice } from './store.ts'
import { toast } from './toasts.ts'

/** Toast ids: a newer change's toast replaces the older one, so only the newest Undo is on screen. */
export const CATALOG_UNDO_TOAST = 'catalog-undo'
const SCHEDULE_TOAST = 'catalog-schedule'

/** The toast after an update is applied. */
export const PRICES_UPDATED = 'Prices updated'
export const PRICES_UNDONE = 'The last price change was undone'

function patch(next: Partial<CatalogSlice>): void {
  useStore.setState((s) => ({ catalog: { ...s.catalog, ...next } }))
}

/** A whole catalog from core: its status and its job replace what the store had. */
export function setCatalogState(state: CatalogState): void {
  patch({ state, status: state.status, job: state.job })
}

/** dashboard.get's status (the Dashboard asks for it often; it carries no job). */
export function noteCatalogStatus(status: CatalogStatus | undefined): void {
  if (status !== undefined) patch({ status })
}

/** Prices or models changed: whatever was estimated or listed from them is asked for again. */
export function bumpCatalogEpoch(): void {
  useStore.setState((s) => ({ catalog: { ...s.catalog, epoch: s.catalog.epoch + 1 } }))
}

// ---- catalog.get ------------------------------------------------------------------------------------------------

let inFlight: Promise<Result<CatalogState>> | null = null
let again = false

/**
 * Read the catalog now. Calls made while one is in flight share it, and one more read follows it, so the answer that
 * ends up in the store is never older than the last call.
 */
export function loadCatalog(): Promise<Result<CatalogState>> {
  if (inFlight !== null) {
    again = true
    return inFlight
  }
  const p = invoke('catalog.get').then((r) => {
    if (r.ok) setCatalogState(r.value)
    inFlight = null
    if (again) {
      again = false
      return loadCatalog()
    }
    return r
  })
  inFlight = p
  return p
}

/** Tests: forget a read in flight. */
export function resetCatalogForTests(): void {
  inFlight = null
  again = false
}

// ---- events -----------------------------------------------------------------------------------------------------

/**
 * A `catalog` AppEvent: core's scheduler found a refresh due, or the job moved on. The job's progress is taken as it
 * comes; anything else (a new job, its end, a due refresh) reads the catalog again for core's whole account of it.
 */
export function onCatalogEvent(ev: AppEventOf<'catalog'>): void {
  const cur = useStore.getState().catalog
  const known = ev.jobId !== undefined && cur.job?.id === ev.jobId ? cur.job : null
  if (ev.state === 'due') {
    if (cur.status !== null) patch({ status: { ...cur.status, refreshDue: true } })
    void loadCatalog()
    return
  }
  if (ev.jobId === undefined) {
    void loadCatalog()
    return
  }
  // A job the store has not seen yet: its vendor, model and start come with the catalog read below.
  const job: CatalogJob = {
    ...(known ?? {
      id: ev.jobId,
      vendor: cur.job?.vendor ?? 'claude',
      model: cur.job?.model ?? null,
      startedAt: coreNow(),
    }),
    id: ev.jobId,
    state: ev.state,
    ...(ev.progress !== undefined ? { progress: ev.progress } : {}),
    ...(ev.diff !== undefined ? { diff: ev.diff } : {}),
    ...(typeof ev.error === 'string' && ev.error !== '' ? { error: ev.error } : {}),
  }
  patch({ job })
  if (ev.state === 'applied') bumpCatalogEpoch()
  // Progress of a job the store knows needs nothing more; every other change is read whole.
  if (ev.state !== 'running' || known === null) void loadCatalog()
}

// ---- commands -----------------------------------------------------------------------------------------------------

/**
 * Update now (the consent card's and Settings' button; a refresh never runs on its own): the only sender of
 * catalog.refresh. Returns the job id, or null when core refused (its message is shown). `who` is the vendor and model
 * core's plan named, shown for the job until core's catalog read answers.
 */
export async function startRefresh(who?: { vendor: string; model: string | null }): Promise<string | null> {
  const r = await invoke('catalog.refresh', { consent: true })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return null
  }
  const cur = useStore.getState().catalog
  if (cur.job?.id !== r.value.jobId) {
    patch({
      job: {
        id: r.value.jobId,
        state: 'running',
        vendor: who?.vendor ?? cur.job?.vendor ?? 'claude',
        model: who !== undefined ? who.model : (cur.job?.model ?? null),
        startedAt: coreNow(),
      },
    })
  }
  void loadCatalog()
  return r.value.jobId
}

export async function cancelRefresh(jobId: string): Promise<boolean> {
  const r = await invoke('catalog.cancel', { jobId })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  toast({ level: 'info', message: 'The price update was cancelled' })
  await loadCatalog()
  return true
}

/** catalog.undo: the prices from before the newest change (the toast's Undo, and the history's). */
export async function undoCatalog(): Promise<boolean> {
  const r = await invoke('catalog.undo')
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  setCatalogState(r.value)
  bumpCatalogEpoch()
  // Its own toast: the Undo toast it may come from closes once its action has run.
  toast({ level: 'info', message: PRICES_UNDONE })
  return true
}

function undoToast(message: string): void {
  toast({
    id: CATALOG_UNDO_TOAST,
    level: 'info',
    message,
    action: { label: 'Undo', onClick: () => undoCatalog() },
  })
}

/** Apply the ticked rows of a reviewed update: "Prices updated · Undo". */
export async function applyCatalogRows(jobId: string, rowIds: readonly string[]): Promise<boolean> {
  const r = await invoke('catalog.apply', { jobId, rowIds: [...rowIds] })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  setCatalogState(r.value)
  bumpCatalogEpoch()
  undoToast(PRICES_UPDATED)
  return true
}

/** A price typed in Settings → Catalog (stored by core as `confidence: 'user'`), with the same Undo. */
export async function saveCatalogPrice(entry: PriceEdit): Promise<boolean> {
  const r = await invoke('catalog.savePrice', { entry })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  setCatalogState(r.value)
  bumpCatalogEpoch()
  undoToast(`Price saved for ${entry.model}`)
  return true
}

/**
 * catalog.setSchedule (Turn off, Not now (7 days), the interval presets), then the catalog read again, so whether a
 * refresh is due is core's answer. `undo` is the update that puts the schedule back, when there is one.
 */
export async function setCatalogSchedule(
  update: CatalogScheduleUpdate,
  said: string,
  undo?: CatalogScheduleUpdate,
): Promise<CatalogSchedule | null> {
  const r = await invoke('catalog.setSchedule', update)
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return null
  }
  const status = useStore.getState().catalog.status
  if (status !== null) patch({ status: { ...status, schedule: r.value } })
  toast({
    id: SCHEDULE_TOAST,
    level: 'info',
    message: said,
    ...(undo !== undefined
      ? {
          action: {
            label: 'Undo',
            onClick: async () => {
              const back = await invoke('catalog.setSchedule', undo)
              if (!back.ok) toast({ level: 'error', message: back.error.message })
              await loadCatalog()
            },
          },
        }
      : {}),
  })
  await loadCatalog()
  return r.value
}

// ---- hooks ------------------------------------------------------------------------------------------------------

export const useCatalogState = (): CatalogState | null => useStore((s) => s.catalog.state)
export const useCatalogStatus = (): CatalogStatus | null => useStore((s) => s.catalog.status)
export const useCatalogJob = (): CatalogJob | null => useStore((s) => s.catalog.job)
export const useCatalogEpoch = (): number => useStore((s) => s.catalog.epoch)

/** Status and job together (the consent card). */
export function useCatalogLive(): { status: CatalogStatus | null; job: CatalogJob | null } {
  return useStore(useShallow((s) => ({ status: s.catalog.status, job: s.catalog.job })))
}
