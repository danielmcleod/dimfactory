// Windows Start-menu shortcut repair (src/main/shortcut.ts; boot step 7): when it applies, what boot and
// [Repair] do with a missing, foreign, correct or incomplete shortcut, and that a non-packaged / E2E / smoke run never
// touches the file system. Also: build/installer.nsh and electron-builder.yml carry the same CLSID.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_ID, TOAST_ACTIVATOR_CLSID } from '../../../src/main/constants.ts'
import {
  normalizeClsid,
  planShortcutRepair,
  repairShortcut,
  shortcutApplicable,
  shortcutStatus,
  startMenuShortcutPath,
} from '../../../src/main/shortcut.ts'
import type {
  ShortcutContext,
  ShortcutDetailsLike,
  ShortcutIo,
  ShortcutWant,
} from '../../../src/main/shortcut.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\Dim Factory\\Dim Factory.exe'
const LNK = 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Dim Factory.lnk'
const want: ShortcutWant = { exePath: EXE, aumid: APP_ID, clsid: TOAST_ACTIVATOR_CLSID }
const live: ShortcutContext = { platform: 'win32', packaged: true, e2e: false, smoke: false }

const good: ShortcutDetailsLike = {
  target: EXE,
  appUserModelId: APP_ID,
  toastActivatorClsid: TOAST_ACTIVATOR_CLSID,
}

/** A fake shell: one shortcut file (or none); throws if touched when `forbid` is set. */
function fakeIo(initial: ShortcutDetailsLike | null, forbid = false) {
  let file = initial
  const writes: { op: string; details: ShortcutDetailsLike }[] = []
  const guard = (): void => {
    if (forbid) throw new Error('the file system must not be touched')
  }
  const io: ShortcutIo = {
    exists: () => {
      guard()
      return file !== null
    },
    read: () => {
      guard()
      if (file === null) throw new Error('no shortcut')
      return { ...file }
    },
    write: (_p, op, details) => {
      guard()
      writes.push({ op, details })
      file = op === 'update' && file !== null ? { ...file, ...details } : { ...details }
      return true
    },
  }
  return { io, writes, file: () => file }
}

describe('shortcutApplicable', () => {
  it.each<[Partial<ShortcutContext>, boolean]>([
    [{}, true],
    [{ platform: 'darwin' }, false],
    [{ platform: 'linux' }, false],
    [{ packaged: false }, false],
    [{ e2e: true }, false],
    [{ smoke: true }, false],
  ])('%j → %s', (over, expected) => {
    expect(shortcutApplicable({ ...live, ...over })).toBe(expected)
  })
})

describe('shortcut status and CLSID normalisation', () => {
  it('compares CLSIDs without case or braces', () => {
    expect(normalizeClsid('5623d05f-66ea-4e4c-993f-a156f0425595')).toBe(TOAST_ACTIVATOR_CLSID)
    expect(normalizeClsid(undefined)).toBe('')
    expect(
      shortcutStatus({ ...good, toastActivatorClsid: TOAST_ACTIVATOR_CLSID.toLowerCase() }, want),
    ).toEqual({
      aumid: true,
      clsid: true,
    })
    expect(shortcutStatus({ target: EXE }, want)).toEqual({ aumid: false, clsid: false })
    expect(shortcutStatus(null, want)).toEqual({ aumid: false, clsid: false })
  })
})

describe('planShortcutRepair', () => {
  it('skips outside a packaged Windows run', () => {
    expect(planShortcutRepair({ ...live, e2e: true }, null, want, 'manual')).toEqual({
      kind: 'skip',
      reason: 'not-applicable',
    })
  })

  it('boot: never creates a shortcut and never touches another install’s', () => {
    expect(planShortcutRepair(live, null, want, 'boot')).toEqual({ kind: 'skip', reason: 'missing' })
    expect(planShortcutRepair(live, { ...good, target: 'D:\\Other\\Dim Factory.exe' }, want, 'boot')).toEqual(
      {
        kind: 'skip',
        reason: 'other-target',
      },
    )
  })

  it('leaves a correct shortcut alone (path case and slashes do not matter)', () => {
    expect(planShortcutRepair(live, { ...good, target: EXE.toUpperCase() }, want, 'boot')).toEqual({
      kind: 'ok',
    })
    expect(planShortcutRepair(live, { ...good, target: EXE.replace(/\\/g, '/') }, want, 'boot')).toEqual({
      kind: 'ok',
    })
  })

  it('updates the AUMID and CLSID of our shortcut, keeping its target', () => {
    expect(planShortcutRepair(live, { target: EXE, appUserModelId: APP_ID }, want, 'boot')).toEqual({
      kind: 'write',
      operation: 'update',
      details: { target: EXE, appUserModelId: APP_ID, toastActivatorClsid: TOAST_ACTIVATOR_CLSID },
    })
  })

  it('[Repair]: creates a missing shortcut and replaces a foreign one', () => {
    expect(planShortcutRepair(live, null, want, 'manual')).toEqual({
      kind: 'write',
      operation: 'create',
      details: {
        target: EXE,
        cwd: 'C:\\Users\\u\\AppData\\Local\\Programs\\Dim Factory',
        description: 'Dim Factory',
        appUserModelId: APP_ID,
        toastActivatorClsid: TOAST_ACTIVATOR_CLSID,
      },
    })
    const foreign = { target: 'D:\\Old\\Dim Factory.exe', description: 'old', args: '--x' }
    expect(planShortcutRepair(live, foreign, want, 'manual')).toEqual({
      kind: 'write',
      operation: 'replace',
      details: { ...foreign, ...good },
    })
  })
})

describe('repairShortcut', () => {
  it('never touches the file system outside a packaged, non-E2E, non-smoke Windows run', () => {
    for (const context of [
      { ...live, packaged: false },
      { ...live, e2e: true },
      { ...live, smoke: true },
      { ...live, platform: 'linux' as const },
    ]) {
      const f = fakeIo(null, true)
      expect(repairShortcut({ context, io: f.io, path: LNK, want, mode: 'manual' })).toEqual({
        applicable: false,
        aumid: false,
        clsid: false,
      })
    }
  })

  it('boot repairs an incomplete shortcut and reports what it reads back', () => {
    const f = fakeIo({ target: EXE, appUserModelId: APP_ID })
    expect(repairShortcut({ context: live, io: f.io, path: LNK, want, mode: 'boot' })).toEqual({
      applicable: true,
      aumid: true,
      clsid: true,
    })
    expect(f.writes.map((w) => w.op)).toEqual(['update'])
  })

  it('boot reports a missing shortcut without creating it; [Repair] creates it', () => {
    const f = fakeIo(null)
    expect(repairShortcut({ context: live, io: f.io, path: LNK, want, mode: 'boot' })).toEqual({
      applicable: true,
      aumid: false,
      clsid: false,
    })
    expect(f.writes).toEqual([])
    expect(repairShortcut({ context: live, io: f.io, path: LNK, want, mode: 'manual' })).toEqual({
      applicable: true,
      aumid: true,
      clsid: true,
    })
    expect(f.writes.map((w) => w.op)).toEqual(['create'])
  })

  it('an unreadable shortcut counts as missing; a throwing write reports failure without throwing', () => {
    const unreadable: ShortcutIo = {
      exists: () => true,
      read: () => {
        throw new Error('corrupt')
      },
      write: () => {
        throw new Error('denied')
      },
    }
    const logged: string[] = []
    const log = { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m) }
    expect(repairShortcut({ context: live, io: unreadable, path: LNK, want, mode: 'boot', log })).toEqual({
      applicable: true,
      aumid: false,
      clsid: false,
    })
    expect(repairShortcut({ context: live, io: unreadable, path: LNK, want, mode: 'manual', log })).toEqual({
      applicable: true,
      aumid: false,
      clsid: false,
    })
    expect(logged).toContain('start menu shortcut repair failed')
  })

  it('builds the per-user Start-menu path', () => {
    expect(startMenuShortcutPath('C:\\Users\\u\\AppData\\Roaming')).toBe(LNK)
  })
})

describe('installer (build/installer.nsh, electron-builder.yml)', () => {
  const nsh = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')

  it('writes the same toast activator CLSID the app sets', () => {
    expect(nsh).toContain(`!define DIM_FACTORY_TOAST_CLSID "${TOAST_ACTIVATOR_CLSID}"`)
  })

  it('defines the customInstall / customUnInstall hooks and sets PKEY_AppUserModel_ToastActivatorCLSID', () => {
    expect(nsh).toMatch(/!macro customInstall\b/)
    expect(nsh).toMatch(/!macro customUnInstall\b/)
    expect(nsh).toContain('{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}')
    expect(nsh).toContain('DIM_FACTORY_PKEY_TOAST_PID 26')
    expect(nsh).toContain('WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"')
    // balanced macro blocks
    expect(nsh.match(/^!macro /gm)?.length).toBe(nsh.match(/^!macroend/gm)?.length)
  })

  it('is wired as the NSIS include', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/^nsis:\n(?:\s{2}.*\n)*\s{2}include: build\/installer\.nsh$/m)
  })
})
