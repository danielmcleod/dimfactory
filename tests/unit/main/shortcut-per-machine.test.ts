// The Start-menu shortcut of a per-machine install (src/main/shortcut.ts; boot step 7). The
// assisted installer offers "Anyone who uses this computer", which puts the shortcut, with the AUMID and CLSID,
// in the all-users Start menu (%ProgramData%). Boot reports that shortcut's status and repairs it. [Repair] never
// adds a second, per-user entry next to it. A per-user shortcut that starts this exe still comes first.
import { describe, expect, it } from 'vitest'
import { APP_ID, TOAST_ACTIVATOR_CLSID } from '../../../src/main/constants.ts'
import {
  allUsersStartMenuShortcutPath,
  repairShortcut,
  startMenuShortcutPath,
} from '../../../src/main/shortcut.ts'
import type {
  ShortcutContext,
  ShortcutDetailsLike,
  ShortcutIo,
  ShortcutWant,
} from '../../../src/main/shortcut.ts'

const EXE = 'C:\\Program Files\\Dim Factory\\Dim Factory.exe'
const USER = startMenuShortcutPath('C:\\Users\\u\\AppData\\Roaming')
const COMMON = allUsersStartMenuShortcutPath('C:\\ProgramData')
const want: ShortcutWant = { exePath: EXE, aumid: APP_ID, clsid: TOAST_ACTIVATOR_CLSID }
const live: ShortcutContext = { platform: 'win32', packaged: true, e2e: false, smoke: false }
const good: ShortcutDetailsLike = {
  target: EXE,
  appUserModelId: APP_ID,
  toastActivatorClsid: TOAST_ACTIVATOR_CLSID,
}

/** A fake shell over several shortcut files; `readOnly` paths refuse writes (no elevation). */
function fakeShell(files: Record<string, ShortcutDetailsLike>, readOnly: string[] = []) {
  const disk = new Map(Object.entries(files))
  const writes: { path: string; op: string }[] = []
  const reads: string[] = []
  const io: ShortcutIo = {
    exists: (p) => disk.has(p),
    read: (p) => {
      reads.push(p)
      const d = disk.get(p)
      if (d === undefined) throw new Error('no shortcut')
      return { ...d }
    },
    write: (p, op, details) => {
      writes.push({ path: p, op })
      if (readOnly.includes(p)) return false
      const cur = disk.get(p)
      disk.set(p, op === 'update' && cur !== undefined ? { ...cur, ...details } : { ...details })
      return true
    },
  }
  return { io, writes, reads, file: (p: string) => disk.get(p) }
}

const repair = (io: ShortcutIo, mode: 'boot' | 'manual') =>
  repairShortcut({ context: live, io, path: USER, allUsersPath: COMMON, want, mode })

describe('per-machine install: the all-users Start-menu shortcut', () => {
  it('builds the all-users path', () => {
    expect(COMMON).toBe('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Dim Factory.lnk')
  })

  it('boot reports the installer’s AUMID and CLSID from the all-users shortcut and writes nothing', () => {
    const s = fakeShell({ [COMMON]: good })
    expect(repair(s.io, 'boot')).toEqual({ applicable: true, aumid: true, clsid: true })
    expect(s.writes).toEqual([])
  })

  it('[Repair] does not create a per-user shortcut next to an all-users one that starts this exe', () => {
    const s = fakeShell({ [COMMON]: good })
    expect(repair(s.io, 'manual')).toEqual({ applicable: true, aumid: true, clsid: true })
    expect(s.writes).toEqual([])
    expect(s.file(USER)).toBeUndefined()
  })

  it('boot and [Repair] update an incomplete all-users shortcut in place', () => {
    const s = fakeShell({ [COMMON]: { target: EXE, appUserModelId: APP_ID } })
    expect(repair(s.io, 'boot')).toEqual({ applicable: true, aumid: true, clsid: true })
    expect(s.writes).toEqual([{ path: COMMON, op: 'update' }])
    expect(s.file(USER)).toBeUndefined()
  })

  it('without elevation the all-users write fails: reported as it is, still no per-user copy', () => {
    const s = fakeShell({ [COMMON]: { target: EXE, appUserModelId: APP_ID } }, [COMMON])
    // Repair without admin rights: the status says the write needs administrator rights.
    expect(repair(s.io, 'manual')).toEqual({ applicable: true, aumid: true, clsid: false, needsAdmin: true })
    expect(s.writes).toEqual([{ path: COMMON, op: 'update' }])
    expect(s.file(USER)).toBeUndefined()
  })

  it('a per-user shortcut that starts this exe comes first; the all-users one is not read', () => {
    const s = fakeShell({ [USER]: { target: EXE }, [COMMON]: good })
    expect(repair(s.io, 'boot')).toEqual({ applicable: true, aumid: true, clsid: true })
    expect(s.writes).toEqual([{ path: USER, op: 'update' }])
    expect(s.reads).not.toContain(COMMON)
  })

  it('an all-users shortcut of another install is left alone; [Repair] creates the per-user one as before', () => {
    const other = { ...good, target: 'D:\\Old\\Dim Factory.exe' }
    const s = fakeShell({ [COMMON]: other })
    expect(repair(s.io, 'boot')).toEqual({ applicable: true, aumid: false, clsid: false })
    expect(s.writes).toEqual([])
    expect(repair(s.io, 'manual')).toEqual({ applicable: true, aumid: true, clsid: true })
    expect(s.writes).toEqual([{ path: USER, op: 'create' }])
    expect(s.file(COMMON)).toEqual(other)
  })

  it('outside a packaged, non-E2E, non-smoke Windows run neither location is touched', () => {
    const s = fakeShell({ [COMMON]: good })
    for (const context of [
      { ...live, packaged: false },
      { ...live, e2e: true },
      { ...live, smoke: true },
    ]) {
      expect(
        repairShortcut({ context, io: s.io, path: USER, allUsersPath: COMMON, want, mode: 'manual' }),
      ).toEqual({ applicable: false, aumid: false, clsid: false })
    }
    expect(s.reads).toEqual([])
    expect(s.writes).toEqual([])
  })
})
