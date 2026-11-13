// Electron's desktop notifications (the ask notification). Windows: our own
// toast XML (actions, reminder scenario for asks, launch/action arguments) and Notification.handleActivation as the
// one source of clicks and actions, live or from Action Center; the object's own click/action events are not used
// there, since custom XML carries our arguments only through the activation. macOS: `actions` (shown on alert-style
// notifications of a signed bundle) and the object's events. Linux: body click. Never used under E2E or smoke runs.
import { Notification } from 'electron'
import type { NotificationConstructorOptions } from 'electron'
import type { Logger } from '@core/log.ts'
import type { Platform } from '@shared/ipc.ts'
import { toastXml } from './notifications-model.ts'
import type { NotificationSpec } from './notifications-model.ts'
import type { NativeCallbacks, NativeHandle, NativeNotifier } from './notifications.ts'

export function electronActivationAvailable(platform: Platform): boolean {
  return platform === 'win32' && typeof Notification.handleActivation === 'function'
}

/** The constructor options for one spec on this platform. */
export function nativeOptions(
  spec: NotificationSpec,
  platform: Platform,
  activation: boolean,
): NotificationConstructorOptions {
  const base: NotificationConstructorOptions = { title: spec.title, body: spec.body, silent: spec.silent }
  if (platform === 'win32') {
    return {
      ...base,
      id: spec.id,
      timeoutType: spec.sticky ? 'never' : 'default',
      // Without handleActivation (older Electron) Electron's own XML and the object's events are used instead.
      ...(activation
        ? { toastXml: toastXml(spec) }
        : { actions: spec.actions.map((a) => ({ type: 'button' as const, text: a.label })) }),
    }
  }
  if (platform === 'darwin') {
    return {
      ...base,
      id: spec.id,
      ...(spec.actions.length > 0
        ? { actions: spec.actions.map((a) => ({ type: 'button' as const, text: a.label })) }
        : {}),
    }
  }
  return {
    ...base,
    timeoutType: spec.sticky ? 'never' : 'default',
    urgency: spec.sticky ? 'critical' : 'normal',
  }
}

export function createElectronNotifier(o: {
  platform: Platform
  log?: Pick<Logger, 'warn'>
}): NativeNotifier {
  const activation = electronActivationAvailable(o.platform)
  // A Notification must stay referenced or its events stop: one live object per notification id.
  const live = new Map<string, Notification>()
  return {
    get supported() {
      try {
        return Notification.isSupported()
      } catch {
        return false
      }
    },
    show(spec: NotificationSpec, on: NativeCallbacks): NativeHandle {
      const n = new Notification(nativeOptions(spec, o.platform, activation))
      live.set(spec.id, n)
      if (!activation) {
        n.on('action', (details, legacyIndex) => void on.action(details.actionIndex ?? legacyIndex))
        n.on('click', () => void on.click())
      }
      n.on('failed', (_e, error) => on.failed(error))
      n.on('close', () => {
        if (live.get(spec.id) === n) live.delete(spec.id)
        on.closed()
      })
      n.show()
      return {
        close: () => {
          // Windows: closing by tag would remove a newer toast of the same run, so only the current one closes.
          if (live.get(spec.id) !== n) return
          live.delete(spec.id)
          n.close()
        },
      }
    },
  }
}

/**
 * Windows: every toast click or action, including one from Action Center after the toast left the screen or after
 * a restart (Electron replays an activation that launched the app). Hands over the raw arguments string.
 */
export function installActivationHandler(platform: Platform, handle: (args: string) => void): boolean {
  if (!electronActivationAvailable(platform)) return false
  Notification.handleActivation((details) => handle(details.arguments))
  return true
}
