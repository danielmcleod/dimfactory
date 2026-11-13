// The system tray (the attention count, the tray menu): a thin Electron wrapper that applies
// tray-model.ts and touches the native tray only for the parts that changed.
import { join } from 'node:path'
import { Menu, Tray, nativeImage } from 'electron'
import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import type { Platform } from '../shared/ipc.ts'
import { EMPTY_TRAY_STATE, trayModel } from './tray-model.ts'
import type { TrayAction, TrayMenuItem, TrayModel, TrayState } from './tray-model.ts'

export type { TrayState } from './tray-model.ts'

export interface TrayController {
  update(s: TrayState): void
  dispose(): void
  readonly current: { icon: string; tooltip: string }
}

export interface TrayOptions {
  /** `build/tray` in development, `<resources>/tray` when packaged. */
  iconDir: string
  onOpen(): void
  onNewRun(): void
  onOpenRun(runId: string): void
  onQuit(): void
  /** Pause notifications for 1 hour / Resume notifications (shown once TrayState.notifications is set). */
  onPauseNotifications?(): void
  onResumeNotifications?(): void
}

const platformOf = (p: NodeJS.Platform): Platform => (p === 'win32' || p === 'darwin' ? p : 'linux')

export function createTray(o: TrayOptions): TrayController {
  const platform = platformOf(process.platform)
  const images = new Map<string, NativeImage>()
  const imageFor = (m: TrayModel): NativeImage => {
    let img = images.get(m.icon)
    if (img === undefined) {
      // createFromPath picks up the `@2x` sibling on HiDPI displays.
      img = nativeImage.createFromPath(join(o.iconDir, m.icon))
      if (m.template) img.setTemplateImage(true)
      images.set(m.icon, img)
    }
    return img
  }
  const run = (a: TrayAction): void => {
    switch (a.kind) {
      case 'open':
        return o.onOpen()
      case 'new-run':
        return o.onNewRun()
      case 'open-run':
        return o.onOpenRun(a.runId)
      case 'pause-notifications':
        return o.onPauseNotifications?.()
      case 'resume-notifications':
        return o.onResumeNotifications?.()
      case 'quit':
        return o.onQuit()
    }
  }
  const toTemplate = (item: TrayMenuItem): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' }
    const { action } = item
    return {
      label: item.label,
      enabled: item.enabled,
      ...(item.toolTip !== undefined ? { toolTip: item.toolTip } : {}),
      ...(action !== undefined ? { click: () => run(action) } : {}),
    }
  }

  let model = trayModel(EMPTY_TRAY_STATE, platform)
  let menuKey = JSON.stringify(model.menu)
  const tray = new Tray(imageFor(model))
  tray.setToolTip(model.tooltip)
  if (platform === 'darwin') tray.setTitle(model.title)
  tray.setContextMenu(Menu.buildFromTemplate(model.menu.map(toTemplate)))
  // macOS opens the menu on click; Windows and Linux (where the shell reports clicks) open the window.
  if (platform !== 'darwin') tray.on('click', () => o.onOpen())
  let disposed = false

  return {
    update(s) {
      if (disposed) return
      const next = trayModel(s, platform)
      if (next.icon !== model.icon) tray.setImage(imageFor(next))
      if (next.tooltip !== model.tooltip) tray.setToolTip(next.tooltip)
      if (platform === 'darwin' && next.title !== model.title) tray.setTitle(next.title)
      const nextKey = JSON.stringify(next.menu)
      if (nextKey !== menuKey) {
        tray.setContextMenu(Menu.buildFromTemplate(next.menu.map(toTemplate)))
        menuKey = nextKey
      }
      model = next
    },
    dispose() {
      if (disposed) return
      disposed = true
      tray.destroy()
    },
    get current() {
      return { icon: model.icon, tooltip: model.tooltip }
    },
  }
}
