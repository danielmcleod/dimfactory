// windowIcon (src/main/window.ts): the main window's own icon on Windows and Linux, from the tray icon directory
// (build/tray in development, <resources>/tray when packaged); none on macOS, where the Dock shows the bundle's.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const { windowIcon, windowsAppDetails } = await import('../../../src/main/window.ts')

const TRAY_DIR = join(import.meta.dirname, '..', '..', '..', 'build', 'tray')

describe('windowIcon', () => {
  it('is the .ico on Windows and the PNG on Linux, both generated under build/tray', () => {
    const win = windowIcon(TRAY_DIR, 'win32')
    const linux = windowIcon(TRAY_DIR, 'linux')
    expect(win).toBe(join(TRAY_DIR, 'window.ico'))
    expect(linux).toBe(join(TRAY_DIR, 'window.png'))
    for (const path of [win, linux]) expect(path !== undefined && existsSync(path), path).toBe(true)
  })

  it('is left to the bundle on macOS', () => {
    expect(windowIcon(TRAY_DIR, 'darwin')).toBeUndefined()
  })
})

describe('windowsAppDetails (the taskbar identity of a build that was never installed)', () => {
  const appId = 'com.dimfactory.desktop'

  it('packaged: the AUMID, the executable as the icon (index 0) and the relaunch command', () => {
    const exe = 'C:\\apps\\Dim Factory\\Dim Factory.exe'
    expect(
      windowsAppDetails({
        appId,
        displayName: 'Dim Factory',
        exePath: exe,
        packaged: true,
        iconFile: 'x.ico',
      }),
    ).toEqual({
      appId,
      appIconPath: exe,
      appIconIndex: 0,
      relaunchCommand: `"${exe}"`,
      relaunchDisplayName: 'Dim Factory',
    })
  })

  it('development: the window icon file, and no relaunch of electron.exe', () => {
    const ico = join(TRAY_DIR, 'window.ico')
    expect(
      windowsAppDetails({
        appId,
        displayName: 'Dim Factory',
        exePath: 'electron.exe',
        packaged: false,
        iconFile: ico,
      }),
    ).toEqual({ appId, appIconPath: ico, appIconIndex: 0 })
  })
})

describe('createMainWindow on Windows', () => {
  it('sets the app details on the window it creates', async () => {
    vi.resetModules()
    const setAppDetails = vi.fn()
    vi.doMock('electron', () => ({
      BrowserWindow: class {
        webContents = { on: vi.fn(), once: vi.fn(), getZoomFactor: () => 1, setZoomFactor: vi.fn() }
        setAppDetails = setAppDetails
        once = vi.fn()
        show = vi.fn()
        loadURL = (): Promise<void> => Promise.resolve()
      },
    }))
    const m = await import('../../../src/main/window.ts')
    const details = { appId: 'com.dimfactory.desktop', appIconPath: 'a.exe', appIconIndex: 0 }
    m.createMainWindow({
      preload: 'p.cjs',
      target: { url: 'app://dim-factory/index.html' } as never,
      theme: { source: 'system', resolved: 'light' } as never,
      showImmediately: false,
      log: { error: vi.fn() },
      appDetails: details,
    })
    expect(setAppDetails).toHaveBeenCalledWith(details)
  })
})
