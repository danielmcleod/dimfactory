// First launch: pick a profile from which vendors are ready,
// write it to the user dimfactory.json only when that file has no `profile`, and record `firstLaunchCompletedAt` in
// state.json. Nothing is ever overwritten. Also the Critic swap suggestion ("[Swap Critic to X]", never silent).
//
//   Claude      Codex       Profile
//   ready       ready       balanced
//   ready       not ready   claude-only
//   not ready   ready       codex-only
//   not ready   not ready   balanced; Run disabled; the setup card lists fixes
//
// Codex counts as ready only if `support({mode:'autoedit'}) ≠ unsupported` (no Windows sandbox → claude-only).
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import type { AppState } from '../../shared/ipc.ts'
import type { ProbeResult, SupportStatus } from '../../shared/vendors.ts'
import type { Adapter } from '../adapters/types.ts'
import type { HomePaths } from '../home.ts'
import { updateStateFile } from '../store/state-file.ts'
import { isPlainObject, readVersionedJson } from '../store/versions.ts'
import type { BuiltinProfileName } from './defaults.ts'
import { loadConfigFile } from './load.ts'

// ---- readiness --------------------------------------------------------------------------------------------------------

export interface VendorReadiness {
  /** The launch probe passed (installed, version ≥ floor, auth ok: no blocking failure). */
  probeOk: boolean
  /** `adapter.support({pass:'implement', mode:'autoedit'}).status`; undefined when unknown. */
  autoedit?: SupportStatus
}

/** Ready = probe ok and autoedit not unsupported (`requireAutoedit`: an unknown autoedit support is not ready). */
export function isVendorReady(
  r: VendorReadiness | undefined,
  o: { requireAutoedit?: boolean } = {},
): boolean {
  if (r === undefined || !r.probeOk) return false
  if (r.autoedit === 'unsupported') return false
  return o.requireAutoedit !== true || r.autoedit !== undefined
}

/** Readiness from a registry entry: not built or never probed → not ready. */
export function readinessOf(
  adapter: Pick<Adapter, 'support'> | undefined,
  probe: Pick<ProbeResult, 'ok'> | null | undefined,
  built = true,
): VendorReadiness {
  const autoedit = adapter?.support({
    pass: 'implement',
    mode: 'autoedit',
    planNative: false,
    trustFolder: false,
  }).status
  return { probeOk: built && probe?.ok === true, ...(autoedit !== undefined ? { autoedit } : {}) }
}

export interface FirstLaunchReadiness {
  claude?: VendorReadiness
  codex?: VendorReadiness
}

export interface FirstLaunchSelection {
  profile: BuiltinProfileName
  claudeReady: boolean
  codexReady: boolean
  /** False when no vendor is ready (Run disabled; the setup card lists fixes). */
  runnable: boolean
}

/** The 4-row matrix. */
export function selectFirstLaunchProfile(r: FirstLaunchReadiness): FirstLaunchSelection {
  const claudeReady = isVendorReady(r.claude)
  const codexReady = isVendorReady(r.codex, { requireAutoedit: true })
  const profile: BuiltinProfileName =
    claudeReady && !codexReady ? 'claude-only' : !claudeReady && codexReady ? 'codex-only' : 'balanced'
  return { profile, claudeReady, codexReady, runnable: claudeReady || codexReady }
}

// ---- first launch ------------------------------------------------------------------------------------------------------

export interface FirstLaunchDeps {
  paths: HomePaths
  readiness: FirstLaunchReadiness
  /**
   * Writes `profile` into the user dimfactory.json through the config save path (jsonc.modify, backup, atomic).
   * Called only when the user file has no `profile` key.
   */
  writeProfile: (profile: BuiltinProfileName) => Promise<void>
  now?: () => number
}

export type FirstLaunchOutcome =
  | { status: 'already-done'; at: number }
  | {
      status: 'completed'
      at: number
      selection: FirstLaunchSelection
      wroteProfile: boolean
      userProfile?: string
    }
  | {
      status: 'deferred'
      /**
       * `no-vendor-ready`: nothing to choose between yet, so the choice waits for a launch where a vendor is ready.
       * `user-config-invalid`: the user file cannot be read safely. `state-read-only`: state.json is from a newer
       * Dim Factory.
       */
      reason: 'no-vendor-ready' | 'user-config-invalid' | 'state-read-only'
      selection: FirstLaunchSelection
    }

export const DEFAULT_APP_STATE: AppState = {
  schemaVersion: 1,
  setupDismissed: false,
  firstLaunchCompletedAt: null,
  catalog: { lastRefreshAt: null, snoozedUntil: null },
  notifications: { pausedUntil: null },
}

/**
 * Run the first-launch selection once. Idempotent: a recorded `firstLaunchCompletedAt` makes it a no-op, a
 * `profile` already in the user file is kept, and unknown state.json fields are preserved.
 */
export async function runFirstLaunch(d: FirstLaunchDeps): Promise<FirstLaunchOutcome> {
  const now = d.now ?? Date.now
  const state = await readVersionedJson<Record<string, unknown>>(d.paths.state)
  const selection = selectFirstLaunchProfile(d.readiness)
  if (state.kind === 'ok') {
    const done = state.value['firstLaunchCompletedAt']
    if (typeof done === 'number') return { status: 'already-done', at: done }
    if (state.readOnly) return { status: 'deferred', reason: 'state-read-only', selection }
  }
  if (!selection.runnable) return { status: 'deferred', reason: 'no-vendor-ready', selection }

  const user = await loadConfigFile(d.paths.userConfig, { scope: 'user' })
  const raw = user.raw
  let userProfile: string | undefined
  let wroteProfile = false
  if (user.exists && isPlainObject(raw) && raw['profile'] !== undefined) {
    // Never overwrite the user's choice (even one that is currently invalid).
    userProfile = typeof raw['profile'] === 'string' ? raw['profile'] : JSON.stringify(raw['profile'])
  } else if (user.exists && user.value === undefined) {
    return { status: 'deferred', reason: 'user-config-invalid', selection }
  } else {
    await d.writeProfile(selection.profile)
    wroteProfile = true
  }

  const at = now()
  // Read again inside the one serialized state.json writer (store/state-file.ts): other writers may have changed the
  // file while the profile was written. A newer state.json returned above (and updateStateFile refuses one that
  // appeared since); a corrupt one is replaced (keeping nothing is all that is possible).
  await updateStateFile(d.paths.state, (prev) => ({
    next: { ...DEFAULT_APP_STATE, ...prev, firstLaunchCompletedAt: at },
    value: undefined,
  }))
  return {
    status: 'completed',
    at,
    selection,
    wroteProfile,
    ...(userProfile !== undefined ? { userProfile } : {}),
  }
}

// ---- Critic swap -------------------------------------------------------------------------------------------------------

export interface ReadyVendor {
  id: string
  /** `support({pass:'critic', mode:'readonly'}).status !== 'unsupported'`. */
  supportsReadonly: boolean
}

/**
 * Critic swap: when Critic runs on Implement's vendor and another ready vendor can run read-only, offer
 * [Swap Critic to X] as a run override. Returns the first such vendor in `readyVendors` order, else null.
 */
export function criticSwapSuggestion(
  cfg: Pick<ResolvedConfig, 'passes'>,
  readyVendors: readonly ReadyVendor[],
  o: { resolveId?: (vendor: string) => string } = {},
): { to: string } | null {
  const id = o.resolveId ?? ((v: string) => v)
  const { implement, critic } = cfg.passes
  if (!critic.enabled || !implement.enabled) return null
  const own = id(implement.vendor)
  if (id(critic.vendor) !== own) return null
  const other = readyVendors.find((v) => v.supportsReadonly && id(v.id) !== own)
  return other !== undefined ? { to: other.id } : null
}
