// Close and quit wiring (policy in quit.ts). Every quit trigger reaches the one
// QuitController: tray Quit, the macOS app menu / Cmd+Q (before-quit), Ctrl+Q (menu.ts), the app.quit IPC, and the
// OS ending the session. The process leaves through app.exit after core.shutdown, so before-quit never loops.
import { app, powerMonitor } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Logger } from '@core/log.ts'
import { decideClose } from './quit.ts'
import type { CloseToTray, QuitController } from './quit.ts'

export interface LifecycleOptions {
  quit: QuitController
  /** DIM_FACTORY_E2E=1: a programmatic app.quit() (Playwright's close) is a confirmed quit, so a test never hangs. */
  e2e: boolean
  showWindow: () => void
  log: Pick<Logger, 'info'>
}

export function installAppLifecycle(o: LifecycleOptions): void {
  app.on('before-quit', (e) => {
    // Always ours: the final step is app.exit, which skips before-quit.
    e.preventDefault()
    if (!o.quit.quitting) void o.quit.request(o.e2e)
  })
  // The window never closes outside the quit path, so this fires only while quitting; on macOS an app outlives its
  // windows anyway. Having a listener keeps Electron from quitting on its own.
  app.on('window-all-closed', () => undefined)
  app.on('activate', () => o.showWindow())
  // Linux/macOS: the system is shutting down or rebooting.
  powerMonitor.on('shutdown', () => o.quit.endSession('system shutdown'))
}

export function attachWindowLifecycle(
  win: BrowserWindow,
  o: { quit: QuitController; closeToTray: () => CloseToTray; platform: NodeJS.Platform },
): void {
  win.on('close', (e) => {
    const action = decideClose({
      quitting: o.quit.quitting,
      closeToTray: o.closeToTray(),
      platform: o.platform,
    })
    switch (action) {
      case 'allow':
        return
      case 'hide':
        e.preventDefault()
        win.hide()
        return
      case 'minimize':
        e.preventDefault()
        win.minimize()
        return
      case 'quit':
        e.preventDefault()
        void o.quit.request(false)
        return
    }
  })
  if (o.platform === 'win32') {
    // Shutdown, restart or log-off: nothing can delay it; the next launch recovers what is left.
    win.on('session-end', () => o.quit.endSession('session end'))
  }
}
