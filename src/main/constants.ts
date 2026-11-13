// Main-process constants (platform integration): app identity, window and
// timing values, the E2E environment switches and the https host allowlist for links that open externally.
import type { ResolvedTheme } from '@shared/ipc.ts'
import { BRAND, envName } from '@shared/brand.ts'

/** Windows AUMID = electron-builder appId (the app's identity). */
export const APP_ID = BRAND.appId
/**
 * Fixed toast activator GUID; build/installer.nsh (DIM_FACTORY_TOAST_CLSID) writes the same value into the Start-menu
 * shortcut and shortcut.ts repairs it.
 */
export const TOAST_ACTIVATOR_CLSID = BRAND.toastActivatorClsid

/** BrowserWindow backgroundColor = the renderer's `--background` token, so the first paint never flashes. */
export const WINDOW_BACKGROUND: Readonly<Record<ResolvedTheme, string>> = {
  light: '#ffffff',
  dark: '#0c0e12',
}
export const WINDOW_SIZE = { width: 1280, height: 840, minWidth: 900, minHeight: 600 } as const
export const WINDOW_TITLE = BRAND.displayName

export const E2E_ENV = envName('E2E')
/** E2E only: dialog.pickFolder answers this absolute path without showing a dialog. */
export const E2E_PICK_FOLDER_ENV = envName('E2E_PICK_FOLDER')
/** E2E only: dialog.pickFiles answers these absolute paths (joined by the platform's path delimiter) without a dialog. */
export const E2E_PICK_FILES_ENV = envName('E2E_PICK_FILES')
/** E2E only: diagnostics.save writes the bundle to this absolute path without showing a dialog. */
export const E2E_DIAGNOSTICS_PATH_ENV = envName('E2E_DIAGNOSTICS_PATH')
export const SMOKE_FLAG = '--smoke-test'

export const HEARTBEAT_MS = 5_000
/** `run-summary` push window per run (debounced 1 s). */
export const SUMMARY_DEBOUNCE_MS = 1_000
/** Tray "Pause notifications for 1 hour" (state.json notifications.pausedUntil). */
export const NOTIFICATION_PAUSE_MS = 60 * 60 * 1000
/** Close and quit: core.shutdown gets 8 s, then the process exits regardless. */
export const QUIT_BUDGET_MS = 8_000
export const SMOKE_READY_TIMEOUT_MS = 45_000
export const EVENT_LOOP_LOG_MS = 60_000
export const EVENT_LOOP_RESOLUTION_MS = 10

/** log.write caps (the logger also redacts and cuts long strings). */
export const LOG_WRITE_MSG_MAX = 2 * 1024
export const LOG_WRITE_DATA_MAX = 8 * 1024

/** https hosts links may open in the default browser: the one shared allowlist (core's `open_docs` uses it too). */
export { EXTERNAL_HOSTS } from '@shared/external-links.ts'

export function isE2E(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[E2E_ENV] === '1'
}

/**
 * A packaged build honours none of the E2E switches (DIM_FACTORY_E2E, its time scale, the folder
 * and save-path answers, the vendor search and user home overrides). Playwright cannot drive a packaged app anyway
 * (its enableNodeCliInspectArguments fuse is off), so in a packaged app's environment they could only turn test hooks
 * on for someone else. They are removed from `env` before main or core reads it; the names removed are returned.
 */
export function dropE2EEnv(env: Record<string, string | undefined>, packaged: boolean): string[] {
  if (!packaged) return []
  const removed = Object.keys(env).filter((k) => k.toUpperCase().startsWith(E2E_ENV))
  for (const k of removed) delete env[k]
  return removed
}
