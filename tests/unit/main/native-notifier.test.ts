// Electron's notifications (src/main/native-notifier.ts) against a fake `electron`: Windows toasts carry our XML and
// get clicks only through Notification.handleActivation; macOS uses the object's action events; Linux a body click;
// a newer notification of the same run is never closed by an older handle.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notificationSpec, testSpec, toastXml } from '../../../src/main/notifications-model.ts'
import type { NotificationFacts } from '../../../src/main/notifications-model.ts'

const fake = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const created: FakeNotification[] = []
  let activation: ((d: { arguments: string }) => void) | undefined
  class FakeNotification {
    static supported = true
    static isSupported(): boolean {
      return FakeNotification.supported
    }
    static handleActivation(cb: (d: { arguments: string }) => void): void {
      activation = cb
    }
    readonly listeners = new Map<string, Listener>()
    shown = 0
    closed = 0
    readonly options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      this.options = options
      created.push(this)
    }
    on(event: string, l: Listener): this {
      this.listeners.set(event, l)
      return this
    }
    show(): void {
      this.shown++
    }
    close(): void {
      this.closed++
    }
    emit(event: string, ...args: unknown[]): void {
      this.listeners.get(event)?.(...args)
    }
  }
  return {
    created,
    FakeNotification,
    activate: (args: string) => activation?.({ arguments: args }),
    reset: () => {
      created.length = 0
      activation = undefined
    },
  }
})

vi.mock('electron', () => ({ Notification: fake.FakeNotification }))

const { createElectronNotifier, installActivationHandler, nativeOptions } =
  await import('../../../src/main/native-notifier.ts')

const RUN = '20261006T120000Z-ab12'
const ask: NotificationFacts = {
  kind: 'ask',
  runId: RUN,
  folder: 'my-app',
  vendor: 'Claude',
  requestId: 'r1',
  detail: 'npm test',
  expiresAt: 600_000,
  allowSession: true,
}
const spec = (platform: 'win32' | 'darwin' | 'linux', macActions = false) =>
  notificationSpec(ask, { platform, now: 0, sound: false, macActions })

const callbacks = () => ({
  action: vi.fn(() => Promise.resolve({ kind: 'duplicate' as const })),
  click: vi.fn(() => Promise.resolve({ kind: 'duplicate' as const })),
  failed: vi.fn(),
  closed: vi.fn(),
})

afterEach(() => fake.reset())

describe('nativeOptions', () => {
  it('Windows with handleActivation: our toast XML, the run id as tag, never times out', () => {
    const s = spec('win32')
    expect(nativeOptions(s, 'win32', true)).toEqual({
      title: s.title,
      body: s.body,
      silent: true,
      id: s.id,
      timeoutType: 'never',
      toastXml: toastXml(s),
    })
  })

  it('Windows without handleActivation: Electron’s own buttons', () => {
    expect(nativeOptions(spec('win32'), 'win32', false).actions).toEqual([
      { type: 'button', text: 'Allow once' },
      { type: 'button', text: 'Allow for this run' },
      { type: 'button', text: 'Deny' },
    ])
  })

  it('macOS: buttons only when the spec has them; Linux: sticky asks are critical', () => {
    expect(nativeOptions(spec('darwin'), 'darwin', false).actions).toBeUndefined()
    expect(nativeOptions(spec('darwin', true), 'darwin', false).actions).toHaveLength(3)
    expect(nativeOptions(spec('linux'), 'linux', false)).toMatchObject({
      timeoutType: 'never',
      urgency: 'critical',
    })
    expect(nativeOptions(testSpec({ sound: true }), 'linux', false)).toMatchObject({
      timeoutType: 'default',
      urgency: 'normal',
      silent: false,
    })
  })
})

describe('createElectronNotifier', () => {
  it('Windows: shows the toast; clicks and actions come only through handleActivation', () => {
    const n = createElectronNotifier({ platform: 'win32' })
    const on = callbacks()
    n.show(spec('win32'), on)
    const [toast] = fake.created
    expect(toast?.shown).toBe(1)
    expect(typeof toast?.options['toastXml']).toBe('string')
    expect(toast?.listeners.has('action')).toBe(false)
    expect(toast?.listeners.has('click')).toBe(false)
    toast?.emit('failed', {}, 'no AUMID')
    expect(on.failed).toHaveBeenCalledWith('no AUMID')
    const seen: string[] = []
    expect(installActivationHandler('win32', (a) => seen.push(a))).toBe(true)
    fake.activate('dim-factory:open?v=1')
    expect(seen).toEqual(['dim-factory:open?v=1'])
  })

  it('macOS / Linux: the object’s action and click events', () => {
    const n = createElectronNotifier({ platform: 'darwin' })
    const on = callbacks()
    n.show(spec('darwin', true), on)
    const [note] = fake.created
    note?.emit('action', { actionIndex: 2 }, 2)
    note?.emit('click', {})
    expect(on.action).toHaveBeenCalledWith(2)
    expect(on.click).toHaveBeenCalledTimes(1)
    expect(installActivationHandler('darwin', () => undefined)).toBe(false)
    expect(installActivationHandler('linux', () => undefined)).toBe(false)
  })

  it('an older handle of the same run does not close the newer notification', () => {
    const n = createElectronNotifier({ platform: 'win32' })
    const first = n.show(spec('win32'), callbacks())
    const second = n.show(spec('win32'), callbacks())
    first.close()
    expect(fake.created.map((c) => c.closed)).toEqual([0, 0])
    second.close()
    expect(fake.created.map((c) => c.closed)).toEqual([0, 1])
  })

  it('reports support from Notification.isSupported', () => {
    const n = createElectronNotifier({ platform: 'linux' })
    expect(n.supported).toBe(true)
    fake.FakeNotification.supported = false
    expect(n.supported).toBe(false)
    fake.FakeNotification.supported = true
  })
})
