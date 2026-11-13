// Hardening on whenReady (permissions, navigation and window-open blocked; https opens
// externally"). Every webContents may navigate only within the app's own renderer (a frame may not navigate at
// all); allowlisted https links open in the default browser; new windows and <webview> are refused; every permission
// request and check is denied except clipboard writes from the app's own renderer (the Copy buttons; urls.ts
// permissionAllowed).
import { app, session } from 'electron'
import type { Logger } from '@core/log.ts'
import { allowedExternalUrl, isAppUrl, permissionAllowed, urlForLog } from './urls.ts'
import type { RendererTarget } from './urls.ts'

export interface HardeningOptions {
  target: RendererTarget
  openExternal: (url: string) => void
  log: Pick<Logger, 'warn'>
  /**
   * A Run & Preview window's contents (main/preview.ts): it keeps its page inside the preview's own loopback origin
   * itself, on its own session; the app's navigation rules here are for the app's page.
   */
  isPreview?: (contents: Electron.WebContents) => boolean
}

export function installHardening(o: HardeningOptions): void {
  const outside = (url: string, what: string): void => {
    const ext = allowedExternalUrl(url)
    if (ext !== null) o.openExternal(ext)
    else o.log.warn(`blocked ${what}`, { url: urlForLog(url) })
  }

  app.on('web-contents-created', (_e, contents) => {
    const preview = (): boolean => o.isPreview?.(contents) === true
    contents.on('will-navigate', (ev) => {
      if (preview() || isAppUrl(ev.url, o.target)) return
      ev.preventDefault()
      outside(ev.url, 'navigation')
    })
    // will-navigate is the top frame's only. The app has no frames (the CSP's frame-src is 'none'), so a frame
    // that navigates anywhere at all is stopped here too, and never opens anything outside.
    contents.on('will-frame-navigate', (ev) => {
      if (ev.isMainFrame || preview()) return
      ev.preventDefault()
      o.log.warn('blocked frame navigation', { url: urlForLog(ev.url) })
    })
    contents.on('will-redirect', (ev) => {
      if (!ev.isMainFrame || preview() || isAppUrl(ev.url, o.target)) return
      ev.preventDefault()
      o.log.warn('blocked redirect', { url: urlForLog(ev.url) })
    })
    contents.setWindowOpenHandler(({ url }) => {
      outside(url, 'window.open')
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', (ev) => {
      ev.preventDefault()
      o.log.warn('blocked webview')
    })
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(
      permissionAllowed(
        { permission, requestingUrl: details.requestingUrl, isMainFrame: details.isMainFrame },
        o.target,
      ),
    )
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) =>
    permissionAllowed(
      {
        permission,
        // A check may come without the frame's URL; the top frame's is then the page's.
        requestingUrl: details.requestingUrl ?? (details.isMainFrame ? wc?.getURL() : undefined),
        isMainFrame: details.isMainFrame,
      },
      o.target,
    ),
  )
}
