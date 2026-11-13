// Windows Start-menu shortcut repair (toast actions need the AUMID
// and the ToastActivatorCLSID on the app's shortcut; the NSIS installer writes both, this repairs them at runtime).
// Only a packaged Windows build outside E2E and smoke runs ever reads or writes a shortcut; at boot it only updates
// our own existing shortcut, and the Settings [Repair] (notifications.repairShortcut) may create or replace it. Ours is
// the per-user one, or the all-users one a per-machine install made ("Anyone who uses this computer").
import { win32 } from 'node:path'
import type { NotificationShortcutStatus } from '@shared/ipc.ts'
import { BRAND } from '@shared/brand.ts'

/** The fields of Electron's ShortcutDetails this reads and writes. */
export interface ShortcutDetailsLike {
  target: string
  args?: string
  cwd?: string
  description?: string
  appUserModelId?: string
  toastActivatorClsid?: string
}

export interface ShortcutContext {
  platform: NodeJS.Platform
  packaged: boolean
  e2e: boolean
  smoke: boolean
}

export interface ShortcutWant {
  /** process.execPath of the packaged app. */
  exePath: string
  aumid: string
  clsid: string
}

export type ShortcutMode = 'boot' | 'manual'

export type ShortcutPlan =
  | { kind: 'skip'; reason: 'not-applicable' | 'missing' | 'other-target' }
  | { kind: 'ok' }
  | { kind: 'write'; operation: 'update' | 'create' | 'replace'; details: ShortcutDetailsLike }

/** Never on this developer's machine: dev builds, E2E and smoke runs report without touching anything. */
export function shortcutApplicable(c: ShortcutContext): boolean {
  return c.platform === 'win32' && c.packaged && !c.e2e && !c.smoke
}

/** `{4e3a…}` / `4E3A…` → `{4E3A…}`. */
export function normalizeClsid(s: string | undefined): string {
  const bare = (s ?? '')
    .trim()
    .replace(/^\{|\}$/g, '')
    .toUpperCase()
  return bare === '' ? '' : `{${bare}}`
}

const samePath = (a: string, b: string): boolean =>
  a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

export function shortcutStatus(
  d: ShortcutDetailsLike | null,
  want: Pick<ShortcutWant, 'aumid' | 'clsid'>,
): { aumid: boolean; clsid: boolean } {
  if (d === null) return { aumid: false, clsid: false }
  return {
    aumid: d.appUserModelId === want.aumid,
    clsid: normalizeClsid(d.toastActivatorClsid) === normalizeClsid(want.clsid),
  }
}

/**
 * What to do with the Start-menu shortcut. Boot: fix the AUMID / CLSID of our own shortcut only (never create one,
 * never touch a shortcut to another install). Manual [Repair]: also create a missing one or replace a foreign one.
 */
export function planShortcutRepair(
  c: ShortcutContext,
  current: ShortcutDetailsLike | null,
  want: ShortcutWant,
  mode: ShortcutMode,
): ShortcutPlan {
  if (!shortcutApplicable(c)) return { kind: 'skip', reason: 'not-applicable' }
  const ours = {
    target: want.exePath,
    appUserModelId: want.aumid,
    toastActivatorClsid: normalizeClsid(want.clsid),
  }
  if (current === null) {
    if (mode === 'boot') return { kind: 'skip', reason: 'missing' }
    return {
      kind: 'write',
      operation: 'create',
      details: { ...ours, cwd: want.exePath.replace(/[\\/][^\\/]*$/, ''), description: BRAND.displayName },
    }
  }
  if (!samePath(current.target, want.exePath)) {
    if (mode === 'boot') return { kind: 'skip', reason: 'other-target' }
    return { kind: 'write', operation: 'replace', details: { ...current, ...ours } }
  }
  const s = shortcutStatus(current, want)
  if (s.aumid && s.clsid) return { kind: 'ok' }
  // `update` changes only the given properties; the target is required by the API and stays the same.
  return { kind: 'write', operation: 'update', details: { ...ours, target: current.target } }
}

/** Electron's shell.readShortcutLink / writeShortcutLink and a file check (injected; tests use a fake). */
export interface ShortcutIo {
  exists(path: string): boolean
  read(path: string): ShortcutDetailsLike
  write(path: string, operation: 'update' | 'create' | 'replace', details: ShortcutDetailsLike): boolean
}

/** Per-user NSIS install (`perMachine:false`): `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Dim Factory.lnk`. */
export function startMenuShortcutPath(appData: string, productName: string = BRAND.displayName): string {
  return win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${productName}.lnk`)
}

/**
 * Per-machine install: the assisted installer (`oneClick:false`) still offers "Anyone who uses this computer", and
 * then the shortcut, with the AUMID and CLSID customInstall wrote, is in the all-users Start menu:
 * `%ProgramData%\Microsoft\Windows\Start Menu\Programs\Dim Factory.lnk`.
 */
export function allUsersStartMenuShortcutPath(
  programData: string,
  productName: string = BRAND.displayName,
): string {
  return startMenuShortcutPath(programData, productName)
}

export interface RepairInput {
  context: ShortcutContext
  io: ShortcutIo
  /** The per-user shortcut: created or replaced here by [Repair] when no shortcut starts this exe. */
  path: string
  /** The all-users shortcut of a per-machine install; used instead of `path` when it starts this exe. */
  allUsersPath?: string
  want: ShortcutWant
  mode: ShortcutMode
  log?: {
    info(msg: string, data?: Record<string, unknown>): void
    warn(msg: string, data?: Record<string, unknown>): void
  }
}

function readShortcut(io: ShortcutIo, path: string): ShortcutDetailsLike | null {
  if (!io.exists(path)) return null
  try {
    return io.read(path)
  } catch {
    return null
  }
}

const startsExe = (d: ShortcutDetailsLike | null, exePath: string): boolean =>
  d !== null && samePath(d.target, exePath)

/**
 * The shortcut to check and repair: the per-user one when it starts this exe, else the all-users one when that
 * does (a per-machine install, so [Repair] never adds a second, per-user entry), else the per-user one again.
 */
function ourShortcut(i: RepairInput): { path: string; current: ShortcutDetailsLike | null } {
  const user = readShortcut(i.io, i.path)
  if (i.allUsersPath === undefined || startsExe(user, i.want.exePath)) return { path: i.path, current: user }
  const common = readShortcut(i.io, i.allUsersPath)
  if (startsExe(common, i.want.exePath)) return { path: i.allUsersPath, current: common }
  return { path: i.path, current: user }
}

/** Plan and apply the repair; the status read back afterwards. Never throws. */
export function repairShortcut(i: RepairInput): NotificationShortcutStatus {
  if (!shortcutApplicable(i.context)) return { applicable: false, aumid: false, clsid: false }
  try {
    const { path, current } = ourShortcut(i)
    const plan = planShortcutRepair(i.context, current, i.want, i.mode)
    let refused = false
    if (plan.kind === 'write') {
      // The all-users Start menu needs elevation: a failed write is logged and the status read back says so.
      const ok = i.io.write(path, plan.operation, plan.details)
      refused = !ok && path !== i.path
      i.log?.info('start menu shortcut repaired', {
        operation: plan.operation,
        ok,
        allUsers: path !== i.path,
      })
    } else if (plan.kind === 'skip') {
      i.log?.info('start menu shortcut left alone', { reason: plan.reason })
    }
    const after = plan.kind === 'write' ? readShortcut(i.io, path) : current
    const status = shortcutStatus(after, i.want)
    // The all-users shortcut could not be written without administrator rights.
    const needsAdmin = refused && !(status.aumid && status.clsid)
    return { applicable: true, ...status, ...(needsAdmin ? { needsAdmin: true as const } : {}) }
  } catch (err) {
    i.log?.warn('start menu shortcut repair failed', { err })
    return { applicable: true, aumid: false, clsid: false }
  }
}
