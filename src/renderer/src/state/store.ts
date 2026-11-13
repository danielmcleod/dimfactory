// The renderer's one zustand store, in slices. It mirrors what core
// sends: summaries, run snapshots, attention, vendor probes; plus app-level UI state and toasts. Nothing here
// derives statuses, phases, costs, findings or estimates: snapshots are replaced wholesale from runs.get.
// Streams are not in the store (lib/streamBuffer.ts).
import { create } from 'zustand'
import type { CatalogJob, CatalogState, CatalogStatus } from '@shared/catalog.ts'
import type { AttentionItem } from '@shared/estimates.ts'
import type { AppInfo, CommandCall, ThemeState, ToastLevel } from '@shared/ipc.ts'
import type { RunSnapshot, RunSummary } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'

export interface RecoveredNotice {
  id: string
  kind: 'recovered'
  runIds: string[]
  detail?: string
}

export type Notice = RecoveredNotice

export interface QuitRequest {
  activeRuns: number
  runIds: string[]
}

export type BridgeState = 'idle' | 'starting' | 'ready' | 'unavailable'

export interface AppSlice {
  info: AppInfo | null
  theme: ThemeState | null
  bridge: BridgeState
  /** No event from main for 15 s (or no bridge at all). */
  lostContact: boolean
  quitRequested: QuitRequest | null
  notices: Notice[]
  /** Bumped on every `config-changed` event; pages showing config refetch when it changes. */
  configEpoch: number
}

export interface SummariesSlice {
  byId: Record<string, RunSummary>
  /** Run ids, newest first (createdAt, then displayNo). */
  order: string[]
  loaded: boolean
  error?: string
}

export type RunLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface RunEntry {
  snapshot: RunSnapshot | null
  /** The seq the snapshot reflects (RunSnapshot.lastSeq). */
  lastSeq: number
  status: RunLoadStatus
  error?: string
}

export interface RunsSlice {
  byId: Record<string, RunEntry>
}

export interface AttentionSlice {
  needsYou: number
  items: AttentionItem[]
}

export interface ProbesSlice {
  byVendor: Record<string, ProbeView>
  /** Vendor ids in the order vendors.list gave them (later arrivals appended). */
  order: string[]
}

/**
 * A toast's action. `disabledReason` shows it disabled with that reason for as long as the toast lasts;
 * `liveDisabledReason` is read from the store while the toast shows, so the action turns available (or not) as core's
 * facts change (Revert all once the stopped run's process has gone and no other run holds the folder).
 */
export type ToastActionSpec = (
  | { label: string; call: CommandCall; disabledReason?: string }
  | { label: string; onClick: () => unknown; disabledReason?: string }
) & { liveDisabledReason?: (s: StoreState) => string | undefined }

export interface ToastItem {
  id: string
  level: ToastLevel
  message: string
  action?: ToastActionSpec
  /** A second action after the first (the Stop toast's Re-run from Fix); the buttons then go under the message. */
  secondary?: ToastActionSpec
  /** null: stays until dismissed. */
  durationMs: number | null
  createdAt: number
}

export interface ToastsSlice {
  items: ToastItem[]
}

/**
 * The model and pricing catalog as core last told it (state/catalog.ts keeps it).
 * Nothing here is worked out by the renderer: whether a refresh is due, the job's state and the price facts are core's.
 */
export interface CatalogSlice {
  /** The last whole catalog core sent: catalog.get, or the answer of catalog.apply / undo / savePrice. */
  state: CatalogState | null
  /** Core's newest status: from that catalog, or dashboard.get's `catalog`. */
  status: CatalogStatus | null
  /** The refresh job core last reported (the catalog's `job`, `catalog` events, catalog.refresh's jobId). */
  job: CatalogJob | null
  /** Bumped when prices or models change (apply, undo, a price edit, an `applied` event): estimates ask again. */
  epoch: number
}

export interface StoreState {
  app: AppSlice
  summaries: SummariesSlice
  runs: RunsSlice
  attention: AttentionSlice
  probes: ProbesSlice
  toasts: ToastsSlice
  catalog: CatalogSlice
}

export function initialState(): StoreState {
  return {
    app: {
      info: null,
      theme: null,
      bridge: 'idle',
      lostContact: false,
      quitRequested: null,
      notices: [],
      configEpoch: 0,
    },
    summaries: { byId: {}, order: [], loaded: false },
    runs: { byId: {} },
    attention: { needsYou: 0, items: [] },
    probes: { byVendor: {}, order: [] },
    toasts: { items: [] },
    catalog: { state: null, status: null, job: null, epoch: 0 },
  }
}

export const useStore = create<StoreState>()(() => initialState())

/** Tests: back to the initial state. */
export function resetStore(): void {
  useStore.setState(initialState(), true)
}
