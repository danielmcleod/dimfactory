// E2E stand-in for desktop notifications (notifications.spec.ts; DIM_FACTORY_E2E=1): nothing reaches the
// developer's desktop. Each notification is recorded for `e2e.state.notifications`, and the main-process global lets
// Playwright press an action or the body of a recorded one (`act`) or replay an Action Center activation (`activate`).
import type { E2EState } from '@shared/ipc.ts'
import type { NotificationSpec } from './notifications-model.ts'
import type { ActivationOutcome, NativeCallbacks, NativeHandle, NativeNotifier } from './notifications.ts'

export interface RecordedNotification {
  /** Position in the record (0 = first). */
  index: number
  id: string
  runId: string | null
  kind: NotificationSpec['kind']
  requestId?: string
  title: string
  body: string
  actions: string[]
  /** Activation arguments: the body's, then each action's (what Action Center hands back). */
  launch: string
  actionArgs: string[]
  sticky: boolean
  silent: boolean
  closed: boolean
}

/** At most this many recorded (oldest dropped). */
export const RECORDED_MAX = 200

export class RecordingNotifier implements NativeNotifier {
  readonly supported = true
  #items: { rec: RecordedNotification; on: NativeCallbacks }[] = []
  #next = 0

  show(spec: NotificationSpec, on: NativeCallbacks): NativeHandle {
    const rec: RecordedNotification = {
      index: this.#next++,
      id: spec.id,
      runId: spec.runId,
      kind: spec.kind,
      ...(spec.requestId !== undefined ? { requestId: spec.requestId } : {}),
      title: spec.title,
      body: spec.body,
      actions: spec.actions.map((a) => a.label),
      launch: spec.launch,
      actionArgs: [...spec.actionArgs],
      sticky: spec.sticky,
      silent: spec.silent,
      closed: false,
    }
    this.#items.push({ rec, on })
    if (this.#items.length > RECORDED_MAX) this.#items.splice(0, this.#items.length - RECORDED_MAX)
    return {
      close: () => {
        if (rec.closed) return
        rec.closed = true
        on.closed()
      },
    }
  }

  list(): RecordedNotification[] {
    return this.#items.map((i) => ({
      ...i.rec,
      actions: [...i.rec.actions],
      actionArgs: [...i.rec.actionArgs],
    }))
  }

  /** e2e.state.notifications. */
  state(): E2EState['notifications'] {
    return this.#items.map((i) => ({ title: i.rec.title, body: i.rec.body, actions: [...i.rec.actions] }))
  }

  /**
   * Press `action` on a recorded notification: an action index or label, or 'click' for the body. `target` is its
   * record index (negative counts from the end) or its id (the newest with that id). Resolves with what the press
   * did; null when there is no such notification or action.
   */
  async act(target: number | string, action: number | string): Promise<ActivationOutcome | null> {
    const item = this.#find(target)
    if (item === undefined) return null
    if (action === 'click') return item.on.click()
    const index = typeof action === 'number' ? action : item.rec.actions.indexOf(action)
    if (!Number.isInteger(index) || index < 0 || index >= item.rec.actions.length) return null
    return item.on.action(index)
  }

  clear(): void {
    this.#items = []
  }

  #find(target: number | string): { rec: RecordedNotification; on: NativeCallbacks } | undefined {
    if (typeof target === 'string') return [...this.#items].reverse().find((i) => i.rec.id === target)
    if (target < 0) return this.#items[this.#items.length + target]
    return this.#items.find((i) => i.rec.index === target)
  }
}
