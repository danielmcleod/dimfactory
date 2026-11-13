// NotificationCenter (src/main/notifications.ts) with the E2E recorder (notification-recorder.ts) as the notifier:
// surface per focus/settings, the per-run window and bursts, answers from actions and Action Center activations
// (stale, duplicate, unknown), taking an answered ask's toast down, the test notification, failure fallback.
import { describe, expect, it, vi } from 'vitest'
import type { ToastLevel } from '../../../src/shared/ipc.ts'
import type { AnswerOutcome } from '../../../src/main/core-host.ts'
import { RecordingNotifier } from '../../../src/main/notification-recorder.ts'
import { ActivationQueue, NotificationCenter } from '../../../src/main/notifications.ts'
import type { NativeNotifier, NotificationCenterDeps } from '../../../src/main/notifications.ts'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  STALE_ACTIVATION,
  encodeActivation,
} from '../../../src/main/notifications-model.ts'
import type { NotificationFacts, NotificationSettings } from '../../../src/main/notifications-model.ts'

const RUN = '20261006T120000Z-ab12'
const RUN2 = '20261006T120000Z-cd34'

class ManualTimers {
  now = 0
  #next = 1
  readonly #timers = new Map<number, { at: number; fn: () => void }>()
  set = (fn: () => void, ms: number): unknown => {
    const id = this.#next++
    this.#timers.set(id, { at: this.now + ms, fn })
    return id
  }
  clear = (h: unknown): void => {
    this.#timers.delete(h as number)
  }
  advance(ms: number): void {
    this.now += ms
    for (const [id, t] of [...this.#timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > this.now) continue
      this.#timers.delete(id)
      t.fn()
    }
  }
  get pending(): number {
    return this.#timers.size
  }
}

const ask = (requestId: string, runId = RUN, allowSession = true): NotificationFacts => ({
  kind: 'ask',
  runId,
  folder: 'my-app',
  vendor: 'Claude',
  requestId,
  detail: 'Bash: npm test',
  expiresAt: 600_000,
  allowSession,
})

function setup(over: Partial<NotificationCenterDeps> = {}, notifier?: NativeNotifier) {
  const timers = new ManualTimers()
  const recorder = new RecordingNotifier()
  const toasts: { level: ToastLevel; message: string }[] = []
  const pending = new Map<string, string[]>()
  let focused = false
  let settings: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS
  let pausedUntil: number | null = null
  const answer = vi.fn((a: { runId: string; requestId: string }): Promise<AnswerOutcome> =>
    Promise.resolve(
      (pending.get(a.runId) ?? []).includes(a.requestId) ? { kind: 'answered' } : { kind: 'stale' },
    ),
  )
  const openRun = vi.fn()
  const showWindow = vi.fn()
  const deps: NotificationCenterDeps = {
    platform: 'win32',
    macActions: false,
    notifier: notifier ?? recorder,
    settings: () => settings,
    pausedUntil: () => pausedUntil,
    focused: () => focused,
    now: () => 0,
    wallNow: () => timers.now,
    timers,
    pendingAsks: (runId) => pending.get(runId) ?? [],
    answer,
    openRun,
    showWindow,
    toast: (t) => toasts.push(t),
    ...over,
  }
  const center = new NotificationCenter(deps)
  return {
    center,
    recorder,
    timers,
    toasts,
    pending,
    answer,
    openRun,
    showWindow,
    focus: (v: boolean) => (focused = v),
    setSettings: (s: Partial<NotificationSettings>) => (settings = { ...settings, ...s }),
    pause: (until: number | null) => (pausedUntil = until),
  }
}

describe('NotificationCenter: surfaces', () => {
  it('unfocused ask → a desktop notification with 3 actions, recorded instead of shown', () => {
    const t = setup()
    t.pending.set(RUN, ['r1'])
    t.center.notify(ask('r1'))
    expect(t.recorder.state()).toEqual([
      {
        title: 'Claude needs approval · my-app',
        body: 'Bash: npm test · 10:00 left',
        actions: ['Allow once', 'Allow for this run', 'Deny'],
      },
    ])
    expect(t.toasts).toEqual([])
  })

  it('focused → in-app toast only', () => {
    const t = setup()
    t.focus(true)
    t.center.notify(ask('r1'))
    expect(t.recorder.state()).toEqual([])
    expect(t.toasts).toEqual([{ level: 'warn', message: 'Claude needs approval · my-app', askRunId: RUN }])
  })

  it('event toggled off, desktop off or paused (unfocused) → nothing', () => {
    const off = setup()
    off.setSettings({ events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, ask: false } })
    off.center.notify(ask('r1'))
    const desktop = setup()
    desktop.setSettings({ desktop: false })
    desktop.center.notify(ask('r1'))
    const paused = setup()
    paused.pause(60_000)
    paused.center.notify(ask('r1'))
    for (const t of [off, desktop, paused]) {
      expect(t.recorder.state()).toEqual([])
      expect(t.toasts).toEqual([])
    }
  })

  it('the catalog notice is off by default and has no run window', () => {
    const t = setup()
    t.center.notify({ kind: 'catalog' })
    expect(t.recorder.state()).toEqual([])
    t.setSettings({ events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, catalog: true } })
    t.center.notify({ kind: 'catalog' })
    t.center.notify({ kind: 'catalog' })
    expect(t.recorder.list().map((r) => r.title)).toEqual([
      'Model prices may be out of date',
      'Model prices may be out of date',
    ])
  })

  it('a desktop notification that fails to show becomes an in-app toast', () => {
    const failing: NativeNotifier = {
      supported: true,
      show: (_spec, on) => {
        on.failed('toast service unavailable')
        return { close: () => undefined }
      },
    }
    const t = setup({}, failing)
    t.center.notify(ask('r1'))
    expect(t.toasts).toEqual([{ level: 'warn', message: 'Claude needs approval · my-app', askRunId: RUN }])
    const throwing: NativeNotifier = {
      supported: true,
      show: () => {
        throw new Error('boom')
      },
    }
    const u = setup({}, throwing)
    u.center.notify(ask('r1'))
    expect(u.toasts).toHaveLength(1)
  })
})

describe('NotificationCenter: one per run per 5 s, bursts', () => {
  it('coalesces asks raised inside the window into "N approvals waiting" (same id: replaces the first)', () => {
    const t = setup()
    t.pending.set(RUN, ['r1', 'r2', 'r3'])
    t.center.notify(ask('r1'))
    t.timers.advance(1_000)
    t.center.notify(ask('r2'))
    t.center.notify(ask('r3'))
    expect(t.recorder.list()).toHaveLength(1)
    t.timers.advance(3_999)
    expect(t.recorder.list()).toHaveLength(1)
    t.timers.advance(1)
    const [first, burst] = t.recorder.list()
    expect(burst).toMatchObject({ title: '3 approvals waiting · my-app', body: 'Open Dim Factory to answer' })
    expect(burst?.actions).toEqual([])
    expect(burst?.id).toBe(first?.id)
    expect(t.timers.pending).toBe(0)
  })

  it('a second ask answered before the window closes shows nothing more; other runs are not held back', () => {
    const t = setup()
    t.pending.set(RUN, ['r1'])
    t.center.notify(ask('r1'))
    t.center.notify(ask('r2'))
    t.center.notify(ask('x1', RUN2))
    expect(t.recorder.list().map((r) => r.runId)).toEqual([RUN, RUN2])
    t.timers.advance(5_000)
    // r2 is gone (not pending) and r1 is the only one pending → nothing new for RUN
    expect(t.recorder.list()).toHaveLength(2)
  })

  it('a run that completes inside the window ends with its completed notice', () => {
    const t = setup()
    t.pending.set(RUN, ['r1'])
    t.center.notify(ask('r1'))
    t.pending.set(RUN, [])
    t.center.notify({
      kind: 'completed',
      runId: RUN,
      folder: 'my-app',
      title: 'add a flag',
      outcome: 'clean',
      durationMs: 360_000,
      costUsd: 0.42,
    })
    t.timers.advance(5_000)
    expect(t.recorder.list().map((r) => r.title)).toEqual([
      'Claude needs approval · my-app',
      'Completed · Clean · 6 min · $0.42',
    ])
  })

  it('dispose drops queued notifications and their timers', () => {
    const t = setup()
    t.center.notify(ask('r1'))
    t.center.notify(ask('r2'))
    expect(t.timers.pending).toBe(1)
    t.center.dispose()
    expect(t.timers.pending).toBe(0)
    t.center.notify(ask('r3', RUN2))
    expect(t.recorder.list()).toHaveLength(1)
  })
})

describe('NotificationCenter: answers and activations', () => {
  it('an action answers through the core (deny, via the toast) and takes the toast down', async () => {
    const t = setup()
    t.pending.set(RUN, ['r1'])
    t.center.notify(ask('r1'))
    const out = await t.recorder.act(0, 'Deny')
    expect(out).toEqual({ kind: 'answered', runId: RUN, requestId: 'r1', decision: 'deny' })
    expect(t.answer).toHaveBeenCalledWith({ runId: RUN, requestId: 'r1', decision: 'deny' })
    expect(t.recorder.list()[0]?.closed).toBe(true)
    expect(t.openRun).not.toHaveBeenCalled()
    expect(t.toasts).toEqual([])
  })

  it('allowSession:false offers two actions and maps index 1 to Deny', async () => {
    const t = setup()
    t.pending.set(RUN, ['r1'])
    t.center.notify(ask('r1', RUN, false))
    expect(t.recorder.list()[0]?.actions).toEqual(['Allow once', 'Deny'])
    expect(await t.recorder.act(-1, 1)).toMatchObject({ kind: 'answered', decision: 'deny' })
  })

  it('a stale activation (Action Center after the ask was answered) opens the run with "already answered/expired"', async () => {
    const t = setup()
    t.pending.set(RUN, ['r1'])
    t.center.notify(ask('r1'))
    const args = t.recorder.list()[0]?.actionArgs[0] ?? ''
    t.pending.set(RUN, [])
    expect(await t.center.activate(args)).toEqual({ kind: 'stale', runId: RUN, requestId: 'r1' })
    expect(t.openRun).toHaveBeenCalledWith(RUN)
    expect(t.toasts).toEqual([{ level: 'info', message: STALE_ACTIVATION }])
  })

  it('the same activation reported twice (live object + handleActivation) is handled once', async () => {
    const t = setup()
    t.pending.set(RUN, ['r1'])
    const args = encodeActivation({ kind: 'answer', runId: RUN, requestId: 'r1', decision: 'allow' })
    expect((await t.center.activate(args)).kind).toBe('answered')
    expect(await t.center.activate(args)).toEqual({ kind: 'duplicate' })
    expect(t.answer).toHaveBeenCalledTimes(1)
    t.timers.advance(5_000)
    // later, it is a new activation (and now stale)
    t.pending.set(RUN, [])
    expect((await t.center.activate(args)).kind).toBe('stale')
  })

  it('a body click opens the run; the test / catalog notification shows the window', async () => {
    const t = setup()
    t.center.notify({ kind: 'gate', runId: RUN, folder: 'my-app', title: 't' })
    expect(await t.recorder.act(0, 'click')).toEqual({ kind: 'opened', runId: RUN })
    expect(t.openRun).toHaveBeenCalledWith(RUN)
    expect(await t.center.activate(encodeActivation({ kind: 'open', runId: null }))).toEqual({
      kind: 'opened',
      runId: null,
    })
    expect(t.showWindow).toHaveBeenCalledTimes(1)
  })

  it('arguments that are not ours only show the window', async () => {
    const t = setup()
    expect(await t.center.activate('launch-from-somewhere')).toEqual({ kind: 'unknown' })
    expect(t.showWindow).toHaveBeenCalled()
    expect(t.answer).not.toHaveBeenCalled()
  })

  it('a core error opens the run and shows the message', async () => {
    const t = setup({
      answer: () => Promise.resolve({ kind: 'error', message: 'This Dim Factory process is read-only.' }),
    })
    const out = await t.center.activate(
      encodeActivation({ kind: 'answer', runId: RUN, requestId: 'r1', decision: 'allow' }),
    )
    expect(out).toEqual({ kind: 'error', runId: RUN, message: 'This Dim Factory process is read-only.' })
    expect(t.openRun).toHaveBeenCalledWith(RUN)
    expect(t.toasts).toEqual([{ level: 'error', message: 'This Dim Factory process is read-only.' }])
  })

  it('an ask answered in the app takes its desktop notification down', () => {
    const t = setup()
    t.pending.set(RUN, ['r1'])
    t.center.notify(ask('r1'))
    t.center.attentionChanged()
    expect(t.recorder.list()[0]?.closed).toBe(false)
    t.pending.set(RUN, [])
    t.center.attentionChanged()
    expect(t.recorder.list()[0]?.closed).toBe(true)
  })

  it('a burst stays up while any of its asks is pending', () => {
    const t = setup()
    t.pending.set(RUN, ['r1', 'r2'])
    t.center.notify(ask('r1'))
    t.center.notify(ask('r2'))
    t.timers.advance(5_000)
    t.pending.set(RUN, ['r2'])
    t.center.attentionChanged()
    expect(t.recorder.list()[1]?.closed).toBe(false)
    t.pending.set(RUN, [])
    t.center.attentionChanged()
    expect(t.recorder.list()[1]?.closed).toBe(true)
  })
})

describe('NotificationCenter.test (notifications.test)', () => {
  it('shows a desktop notification even while focused or paused', () => {
    const t = setup()
    t.focus(true)
    t.pause(Number.MAX_SAFE_INTEGER)
    expect(t.center.test()).toEqual({ shown: true, surface: 'native' })
    expect(t.recorder.state()[0]?.title).toBe('Dim Factory notifications are on')
  })

  it('falls back to an in-app toast with the reason', () => {
    const off = setup()
    off.setSettings({ desktop: false })
    expect(off.center.test()).toEqual({
      shown: true,
      surface: 'in-app',
      reason: 'Desktop notifications are off in Settings.',
    })
    expect(off.toasts).toHaveLength(1)
    const unsupported = setup({}, { supported: false, show: () => ({ close: () => undefined }) })
    expect(unsupported.center.test()).toMatchObject({ surface: 'in-app' })
  })
})

describe('ActivationQueue', () => {
  it('holds activations until the page is ready, then passes them straight through', () => {
    const seen: string[] = []
    const q = new ActivationQueue((a) => seen.push(a))
    q.push('a')
    q.push('b')
    expect(seen).toEqual([])
    q.open()
    q.open()
    q.push('c')
    expect(seen).toEqual(['a', 'b', 'c'])
  })
})

describe('RecordingNotifier', () => {
  it('finds a notification by index, negative index or id, and an action by index or label', async () => {
    const t = setup()
    t.pending.set(RUN, ['r1'])
    t.pending.set(RUN2, ['x1'])
    t.center.notify(ask('r1'))
    t.center.notify(ask('x1', RUN2))
    const list = t.recorder.list()
    expect(list.map((r) => r.index)).toEqual([0, 1])
    expect(await t.recorder.act(`dim-factory-run-${RUN2}`, 'Allow once')).toMatchObject({
      kind: 'answered',
      runId: RUN2,
      decision: 'allow',
    })
    expect(await t.recorder.act(0, 'Allow for this run')).toMatchObject({ decision: 'allow-session' })
    expect(await t.recorder.act(7, 'Deny')).toBeNull()
    expect(await t.recorder.act(-1, 'Nope')).toBeNull()
    expect(await t.recorder.act(-1, 9)).toBeNull()
    t.recorder.clear()
    expect(t.recorder.list()).toEqual([])
    expect(t.recorder.state()).toEqual([])
  })
})
