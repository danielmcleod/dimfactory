// DIM_FACTORY_HOME/state.json for `state.get` / `state.set` (setupDismissed,
// firstLaunchCompletedAt, catalog lastRefresh/snooze, notifications pause-until). Versioned like every non-config
// file (schemaVersion 1; a newer file is read but never written), written atomically through the core's writer,
// unknown fields preserved. Defaults when missing or corrupt. Writes go through the core's one serialized state.json
// writer (store/state-file.ts), shared with the catalog, first launch and outside agents, so none loses another's.
import { DEFAULT_APP_STATE } from '@core/config/firstLaunch.ts'
import type { HomePaths } from '@core/home.ts'
import { updateStateFile } from '@core/store/state-file.ts'
import { isPlainObject, readVersionedJson } from '@core/store/versions.ts'
import type { AppState, AppStatePatch } from '@shared/ipc.ts'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The AppState view of a state.json object: every field present and typed, defaults for the rest. */
export function normalizeAppState(raw: Record<string, unknown>): AppState {
  const catalog = isPlainObject(raw['catalog']) ? raw['catalog'] : {}
  const notifications = isPlainObject(raw['notifications']) ? raw['notifications'] : {}
  return {
    schemaVersion: 1,
    setupDismissed: raw['setupDismissed'] === true,
    firstLaunchCompletedAt: num(raw['firstLaunchCompletedAt']),
    catalog: { lastRefreshAt: num(catalog['lastRefreshAt']), snoozedUntil: num(catalog['snoozedUntil']) },
    notifications: { pausedUntil: num(notifications['pausedUntil']) },
  }
}

/** Apply a patch to the raw document, keeping fields this build does not know. */
export function applyAppStatePatch(
  raw: Record<string, unknown>,
  patch: AppStatePatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...DEFAULT_APP_STATE, ...raw }
  if (patch.setupDismissed !== undefined) next['setupDismissed'] = patch.setupDismissed
  if (patch.notificationsPausedUntil !== undefined) {
    const prev = isPlainObject(raw['notifications']) ? raw['notifications'] : {}
    next['notifications'] = {
      ...DEFAULT_APP_STATE.notifications,
      ...prev,
      pausedUntil: patch.notificationsPausedUntil,
    }
  }
  return next
}

export interface AppStateStore {
  get(): Promise<AppState>
  set(patch: AppStatePatch): Promise<AppState>
}

async function readRaw(file: string): Promise<{ raw: Record<string, unknown>; readOnly: boolean }> {
  const r = await readVersionedJson<Record<string, unknown>>(file)
  if (r.kind !== 'ok') return { raw: {}, readOnly: false }
  return { raw: r.value, readOnly: r.readOnly }
}

export function createAppStateStore(paths: Pick<HomePaths, 'state'>): AppStateStore {
  return {
    get: async () => normalizeAppState((await readRaw(paths.state)).raw),
    // updateStateFile refuses (NEWER_SCHEMA) a file written by a newer Dim Factory.
    set: (patch) =>
      updateStateFile(paths.state, (raw) => {
        const next = applyAppStatePatch(raw, patch)
        return { next, value: normalizeAppState(next) }
      }),
  }
}

/** The store, calling `onState` with every state it reads or writes (main follows the notification pause). */
export function observeAppState(store: AppStateStore, onState: (s: AppState) => void): AppStateStore {
  const seen = (s: AppState): AppState => {
    try {
      onState(s)
    } catch {
      // an observer never breaks state.get / state.set
    }
    return s
  }
  return {
    get: async () => seen(await store.get()),
    set: async (patch) => seen(await store.set(patch)),
  }
}
