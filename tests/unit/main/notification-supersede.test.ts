// A run's newer desktop notification supersedes the earlier one (src/main/notifications.ts;
// notification rules: at most one per run, bursts coalesced). The earlier one is closed before the newer one is
// shown. A Linux notification has no id, so nothing replaced it and a sticky ask stayed on screen, untracked, after
// it was answered. Checked with the E2E recorder and with Electron's notifier against a fake `electron`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnswerOutcome } from '../../../src/main/core-host.ts'
import { RecordingNotifier } from '../../../src/main/notification-recorder.ts'
import { NotificationCenter } from '../../../src/main/notifications.ts'
import type { NativeNotifier, NotificationCenterDeps } from '../../../src/main/notifications.ts'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../../src/main/notifications-model.ts'
import type { NotificationFacts } from '../../../src/main/notifications-model.ts'
import type { Platform } from '../../../src/shared/ipc.ts'

const fake = vi.hoisted(() => {
  const created: FakeNotification[] = []
  /** `show:<n>` / `close:<n>` in the order they happened (n = creation index). */
  const order: string[] = []
  class FakeNotification {
    static isSupported(): boolean {
      return true
    }
    readonly index: number
    readonly options: Record<string, unknown>
    closed = 0
    constructor(options: Record<string, unknown>) {
      this.options = options
      this.index = created.length
      created.push(this)
    }
    on(): this {
      return this
    }
    show(): void {
      order.push(`show:${this.index}`)
    }
    close(): void {
      this.closed++
      order.push(`close:${this.index}`)
    }
  }
  return {
    created,
    order,
    FakeNotification,
    reset: () => {
      created.length = 0
      order.length = 0
    },
  }
})

vi.mock('electron', () => ({ Notification: fake.FakeNotification }))

const { createElectronNotifier } = await import('../../../src/main/native-notifier.ts')

const RUN = '20261006T120000Z-ab12'

const ask = (requestId: string): NotificationFacts => ({
  kind: 'ask',
  runId: RUN,
  folder: 'my-app',
  vendor: 'Claude',
  requestId,
  detail: 'Bash: npm test',
  expiresAt: 600_000,
  allowSession: true,
})

function setup(platform: Platform, notifier: NativeNotifier) {
  let now = 0
  const timers: { at: number; fn: () => void }[] = []
  const pending = new Map<string, string[]>()
  const deps: NotificationCenterDeps = {
    platform,
    macActions: false,
    notifier,
    settings: () => DEFAULT_NOTIFICATION_SETTINGS,
    pausedUntil: () => null,
    focused: () => false,
    now: () => 0,
    wallNow: () => now,
    timers: {
      set: (fn: () => void, ms: number) => timers.push({ at: now + ms, fn }),
      clear: () => undefined,
    },
    pendingAsks: (runId) => pending.get(runId) ?? [],
    answer: (): Promise<AnswerOutcome> => Promise.resolve({ kind: 'answered' }),
    openRun: () => undefined,
    showWindow: () => undefined,
    toast: () => undefined,
  }
  const advanceTo = (t: number): void => {
    now = t
    for (const x of timers.splice(0)) {
      if (x.at <= now) x.fn()
      else timers.push(x)
    }
  }
  return { center: new NotificationCenter(deps), pending, advanceTo }
}

afterEach(() => fake.reset())

describe('a newer notification of the same run', () => {
  it('Linux, recorder: the first ask is closed when the burst takes its place; the burst once both are answered', () => {
    const recorder = new RecordingNotifier()
    const t = setup('linux', recorder)
    t.pending.set(RUN, ['a'])
    t.center.notify(ask('a'))
    t.advanceTo(1_000)
    t.pending.set(RUN, ['a', 'b'])
    t.center.notify(ask('b'))
    t.advanceTo(5_000)
    expect(recorder.list().map((n) => [n.kind, n.closed])).toEqual([
      ['ask', true],
      ['burst', false],
    ])
    t.pending.set(RUN, [])
    t.center.attentionChanged()
    expect(recorder.list().map((n) => n.closed)).toEqual([true, true])
  })

  it('Linux, Electron: the first ask’s notification is closed through its own object; nothing stays on screen', () => {
    const t = setup('linux', createElectronNotifier({ platform: 'linux' }))
    t.pending.set(RUN, ['a'])
    t.center.notify(ask('a'))
    t.advanceTo(1_000)
    t.pending.set(RUN, ['a', 'b'])
    t.center.notify(ask('b'))
    t.advanceTo(5_000)
    expect(fake.created).toHaveLength(2)
    // Linux notifications carry no id: nothing would have replaced the first one.
    expect(fake.created[0]?.options['id']).toBeUndefined()
    expect(fake.order).toEqual(['show:0', 'close:0', 'show:1'])
    t.pending.set(RUN, [])
    t.center.attentionChanged()
    expect(fake.created.map((n) => n.closed)).toEqual([1, 1])
  })

  it('Windows, Electron: the earlier toast is closed before the newer one (same tag) is shown', () => {
    const t = setup('win32', createElectronNotifier({ platform: 'win32' }))
    t.pending.set(RUN, ['a'])
    t.center.notify(ask('a'))
    t.center.notify({ kind: 'gate', runId: RUN, folder: 'my-app', title: 't' })
    t.advanceTo(5_000)
    expect(fake.created.map((n) => n.options['id'])).toEqual([
      `dim-factory-run-${RUN}`,
      `dim-factory-run-${RUN}`,
    ])
    expect(fake.order).toEqual(['show:0', 'close:0', 'show:1'])
    // The newer one is not touched by the earlier one's close.
    expect(fake.created[1]?.closed).toBe(0)
  })
})
