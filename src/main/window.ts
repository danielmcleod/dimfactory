// The main window (with the theme source): sandboxed, context-isolated renderer with the CJS preload;
// hidden until ready-to-show (shown at once under DIM_FACTORY_E2E so Playwright never waits); backgroundColor and the
// preload's initial theme both come from the resolved ThemeState. No bounds persistence. Page zoom is the
// user's (a UI control standard; WCAG 1.4.4): the zoom keys (menu.ts
// installWindowKeys) and Ctrl+wheel step through keys.ts ZOOM_STEPS, and the level lasts as long as the window
// (installZoom). The layout holds from the 900 × 600 window at 100% up to 150% in a 1280 × 900 one.
// E2E isolation from the developer's own mouse (DIM_FACTORY_E2E=1 only, an E2E-only hook): the window ignores the
// OS pointer (setIgnoreMouseEvents(true), before it is shown), so a pointer resting over it can never hover, pause
// a toast or click. Playwright's input (CDP Input.dispatch*) and webContents.sendInputEvent are injected into the
// page, not routed by the OS, so they still arrive (moves, clicks, hover and the wheel; ui-layout.spec.ts checks both).
// E2E windows on macOS may also be larger than the screen (enableLargerThanScreen; other OSes never limit it): AppKit
// otherwise shrinks a window to the display's visible frame, and a CI Mac's display is shorter than the 1280 × 900
// window the layout specs measure. A normal launch keeps the screen's limit.
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import type { Logger } from '@core/log.ts'
import type { ThemeState } from '@shared/ipc.ts'
import { encodeThemeArg } from '../preload/wire.ts'
import { WINDOW_SIZE, WINDOW_TITLE } from './constants.ts'
import { nextZoomFactor } from './keys.ts'
import type { ZoomAction } from './keys.ts'
import { backgroundFor } from './theme.ts'
import { isMainRoute } from './tray-model.ts'
import type { RendererTarget } from './urls.ts'

export interface MainWindowOptions {
  /** Absolute path of out/preload/index.cjs. */
  preload: string
  target: RendererTarget
  theme: ThemeState
  showImmediately: boolean
  /** The window's own icon (title bar, taskbar, Alt+Tab); undefined keeps the executable's (macOS: the bundle's). */
  icon?: string | undefined
  /**
   * DIM_FACTORY_E2E=1 only: the OS pointer passes through the window (see the file comment); only injected input
   * (Playwright, webContents.sendInputEvent) reaches the page.
   */
  ignoreOsPointer?: boolean
  /**
   * DIM_FACTORY_E2E=1 only: on macOS the window may be sized beyond the screen (see the file comment), so a spec gets
   * the size it sets on any runner's display.
   */
  largerThanScreen?: boolean
  log: Pick<Logger, 'error'>
  /** The page failed to load (smoke runs fail on it). */
  onLoadFailed?: (reason: string) => void
  /** Windows: the taskbar identity of the window (windowsAppDetails); undefined elsewhere. */
  appDetails?: Electron.AppDetailsOptions | undefined
}

/**
 * Windows: the window's taskbar identity. The AUMID alone is not enough for a build that was never installed (no Start
 * menu shortcut carries it), so the taskbar fell back to a generic icon with the overlay badge on top. The window
 * states the AUMID, its icon and how to relaunch it itself: a packaged build's own executable (its icon is embedded at
 * index 0, and relaunching it starts Dim Factory), and in development the window icon file (relaunching
 * electron.exe would not start the app, so no relaunch command then).
 */
export function windowsAppDetails(o: {
  appId: string
  displayName: string
  exePath: string
  packaged: boolean
  iconFile: string | undefined
}): Electron.AppDetailsOptions {
  const icon = o.packaged
    ? { appIconPath: o.exePath, appIconIndex: 0 }
    : o.iconFile !== undefined
      ? { appIconPath: o.iconFile, appIconIndex: 0 }
      : {}
  return {
    appId: o.appId,
    ...icon,
    ...(o.packaged ? { relaunchCommand: `"${o.exePath}"`, relaunchDisplayName: o.displayName } : {}),
  }
}

export function createMainWindow(o: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...WINDOW_SIZE,
    show: false,
    title: WINDOW_TITLE,
    ...(o.icon !== undefined ? { icon: o.icon } : {}),
    backgroundColor: backgroundFor(o.theme.resolved),
    ...(o.largerThanScreen === true ? { enableLargerThanScreen: true } : {}),
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: [encodeThemeArg(o.theme)],
    },
  })
  installZoom(win.webContents)
  if (o.appDetails !== undefined) {
    try {
      win.setAppDetails(o.appDetails)
    } catch (err) {
      o.log.error('setAppDetails failed', { err })
    }
  }
  if (o.ignoreOsPointer === true) ignoreOsPointer(win)
  if (o.showImmediately) win.show()
  else win.once('ready-to-show', () => win.show())

  const failed = (reason: string): void => {
    o.log.error('renderer failed to load', { reason })
    o.onLoadFailed?.(reason)
  }
  win.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    // -3 (ABORTED) is a navigation replaced by another one (e.g. a reload), not a failure.
    if (isMainFrame && code !== -3) failed(`${description} (${code})`)
  })
  // The dev server's page, or the built renderer as app://dim-factory/index.html (renderer-files.ts).
  const load = win.loadURL(o.target.url)
  // did-fail-load reports the same failure; the promise is only kept from going unhandled.
  load.catch(() => undefined)
  return win
}

/**
 * E2E: the OS pointer passes through the window (on Windows Electron gives it WS_EX_TRANSPARENT) and nothing is
 * forwarded. Input injected into the page (CDP, sendInputEvent) does not come from the OS and still arrives.
 */
export function ignoreOsPointer(win: Pick<BrowserWindow, 'setIgnoreMouseEvents'>): void {
  win.setIgnoreMouseEvents(true)
}

/**
 * The window icon under the tray icon directory (scripts/make-tray-icons.mjs): the .ico on Windows (every size, so
 * the title bar and the taskbar each get a sharp one), the 256 px PNG on Linux. macOS windows have no icon of their
 * own (the Dock shows the bundle's), so none there.
 */
export function windowIcon(iconDir: string, platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') return undefined
  return join(iconDir, platform === 'win32' ? 'window.ico' : 'window.png')
}

/** What the zoom needs of a window's webContents. */
export interface ZoomTarget {
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  on(event: 'zoom-changed', listener: (event: unknown, direction: 'in' | 'out') => void): unknown
  once(event: 'did-finish-load', listener: () => void): unknown
}

/** Zoom the page one step (a zoom key, a View menu item, a Ctrl+wheel notch). */
export function zoomPage(wc: Pick<ZoomTarget, 'getZoomFactor' | 'setZoomFactor'>, action: ZoomAction): void {
  const now = wc.getZoomFactor()
  const next = nextZoomFactor(now, action)
  if (next !== now) wc.setZoomFactor(next)
}

/**
 * Page zoom is the user's: Ctrl+wheel steps it like the zoom keys (Electron only reports the wheel, as
 * 'zoom-changed'), and nothing ever puts it back on its own. It lasts as long as the window, across reloads: Chromium
 * keeps a level per page origin from one launch to the next, so the first load of a new window starts at 100%.
 */
export function installZoom(wc: ZoomTarget): void {
  wc.on('zoom-changed', (_event, direction) => zoomPage(wc, direction === 'in' ? 'zoomIn' : 'zoomOut'))
  wc.once('did-finish-load', () => {
    if (wc.getZoomFactor() !== 1) wc.setZoomFactor(1)
  })
}

/** Bring the window forward: restore, show and focus. */
export function revealWindow(win: BrowserWindow | null): void {
  if (win === null || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/**
 * Reveal the window on a renderer route (tray: New run, a run; tray-model trayRoute). The hash router follows
 * `location.hash`, so a same-document hash change is enough: no reload, the page keeps its state.
 */
export function revealRoute(win: BrowserWindow | null, hash: string, log: Pick<Logger, 'warn'>): void {
  revealWindow(win)
  if (win === null || win.isDestroyed() || !isMainRoute(hash)) return
  win.webContents
    .executeJavaScript(`window.location.hash = ${JSON.stringify(hash)}`)
    .catch((err: unknown) => log.warn('could not open the route', { err }))
}
