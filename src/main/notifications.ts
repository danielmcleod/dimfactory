// Desktop notifications (attention surfaces, events, notification rules): from a core
// notification's facts to one surface — a desktop notification (Windows toast with Allow/Deny actions, macOS alert,
// Linux open-to-answer), an in-app toast while the window is focused, or nothing — at most once per run per 5 s,
// bursts coalesced; and back: an action or an Action Center activation answers through the core (deny at once,
// via 'notification') or opens the run, with "already answered/expired" for a stale one. Electron-free: the
// native notifier (Electron's Notification, or the E2E recorder), timers and window calls are injected.
import type { Logger } from '@core/log.ts'
import type { NotificationTestResult, Platform } from '@shared/ipc.ts'
import type { AnswerOutcome } from './core-host.ts'
import {
  RunWindows,
  STALE_ACTIVATION,
  activationKey,
  coalesce,
  decideSurface,
  decodeActivation,
  eventOf,
  inAppToast,
  notificationSpec,
  runIdOf,
  testSpec,
} from './notifications-model.ts'
import type {
  AnswerDecision,
  InAppToast,
  NotificationFacts,
  NotificationSettings,
  NotificationSpec,
  Surface,
} from './notifications-model.ts'
import type { TimerApi } from './push-routing.ts'

export interface NativeCallbacks {
  /** An action button, by its index in `spec.actions`. */
  action(index: number): Promise<ActivationOutcome>
  /** The body. */
  click(): Promise<ActivationOutcome>
  failed(error: string): void
  closed(): void
}

export interface NativeHandle {
  close(): void
}

/** Shows desktop notifications: Electron's Notification (native-notifier.ts) or the E2E recorder. */
export interface NativeNotifier {
  readonly supported: boolean
  show(spec: NotificationSpec, on: NativeCallbacks): NativeHandle
}

export type ActivationOutcome =
  | { kind: 'opened'; runId: string | null }
  | { kind: 'answered'; runId: string; requestId: string; decision: AnswerDecision }
  | { kind: 'stale'; runId: string; requestId: string }
  | { kind: 'error'; runId: string; message: string }
  | { kind: 'duplicate' }
  | { kind: 'unknown' }

export interface NotificationCenterDeps {
  platform: Platform
  /** macOS: actions need alert-style notifications of a signed bundle (packaged builds). */
  macActions: boolean
  notifier: NativeNotifier
  settings: () => NotificationSettings
  /** state.json notifications.pausedUntil (wall-clock ms). */
  pausedUntil: () => number | null
  /** The window has the user's focus. */
  focused: () => boolean
  /** Core clock (an ask's time left). */
  now: () => number
  /** Wall clock (pause, the 5 s window, activation de-duplication). */
  wallNow: () => number
  timers: TimerApi
  pendingAsks: (runId: string) => string[]
  answer: (a: { runId: string; requestId: string; decision: AnswerDecision }) => Promise<AnswerOutcome>
  openRun: (runId: string) => void
  showWindow: () => void
  toast: (t: InAppToast) => void
  log?: Pick<Logger, 'info' | 'warn'>
  windowMs?: number
}

/** A second report of the same activation within this long is the same click (Windows: object + handleActivation). */
export const ACTIVATION_DEDUPE_MS = 5_000

interface Shown {
  spec: NotificationSpec
  handle: NativeHandle
}

/**
 * Runs whose last desktop notification stays tracked (to take it down when the run's next one supersedes it), past
 * which the oldest that is not an ask or a burst is forgotten and left where the platform shows it. A run's
 * last notification (Completed, Failed) stayed tracked until the platform reported it closed, which the E2E recorder
 * and some platforms never do, so main kept one per run that ever notified.
 */
export const SHOWN_KEPT = 50

export class NotificationCenter {
  readonly #d: NotificationCenterDeps
  readonly #windows: RunWindows
  readonly #timers = new Map<string, unknown>()
  /** The live desktop notification of each run (one per run; a newer one replaces it). */
  readonly #shown = new Map<string, Shown>()
  readonly #handled = new Map<string, number>()
  #disposed = false

  constructor(d: NotificationCenterDeps) {
    this.#d = d
    this.#windows = new RunWindows(d.windowMs)
  }

  /** A core notification's facts (null facts are dropped by the caller). */
  notify(f: NotificationFacts): void {
    if (this.#disposed) return
    if (!this.#d.settings().events[eventOf(f)]) return
    const runId = runIdOf(f)
    if (runId === null) {
      this.#deliver(f)
      return
    }
    const offer = this.#windows.offer(runId, f, this.#d.wallNow())
    if (offer.kind === 'now') {
      if (this.#deliver(f)) this.#windows.delivered(runId, this.#d.wallNow())
      return
    }
    if (!offer.arm) return
    const delay = Math.max(0, offer.flushAt - this.#d.wallNow())
    this.#timers.set(
      runId,
      this.#d.timers.set(() => this.#flush(runId), delay),
    )
  }

  /** The window of `runId` closed: one notification for what waited in it. */
  #flush(runId: string): void {
    this.#timers.delete(runId)
    if (this.#disposed) return
    const f = coalesce(this.#windows.drain(runId), this.#d.pendingAsks(runId))
    if (f !== null && this.#deliver(f)) this.#windows.delivered(runId, this.#d.wallNow())
  }

  /** Show it on the surface the rules pick; true when it reached the user. */
  #deliver(f: NotificationFacts): boolean {
    const surface = this.#surface(f)
    if (surface.kind === 'none') {
      this.#d.log?.info('notification skipped', { kind: f.kind, reason: surface.reason })
      return false
    }
    if (surface.kind === 'in-app') {
      this.#d.toast(inAppToast(f, this.#d.now()))
      return true
    }
    const s = this.#d.settings()
    const spec = notificationSpec(f, {
      platform: this.#d.platform,
      now: this.#d.now(),
      sound: s.sound,
      macActions: this.#d.macActions,
    })
    return this.#show(spec, () => this.#d.toast(inAppToast(f, this.#d.now())))
  }

  #surface(f: NotificationFacts): Surface {
    return decideSurface({
      event: eventOf(f),
      settings: this.#d.settings(),
      focused: this.#d.focused(),
      pausedUntil: this.#d.pausedUntil(),
      now: this.#d.wallNow(),
      supported: this.#d.notifier.supported,
    })
  }

  #show(spec: NotificationSpec, onFailed: () => void): boolean {
    let handle: NativeHandle
    const key = spec.runId ?? spec.id
    // One notification per run: the earlier one is taken down first, while its handle can still close it. Windows
    // and macOS would replace it by id anyway; a Linux notification has no id, so a superseded ask would otherwise
    // stay on screen, untracked, after it was answered.
    this.#close(key)
    try {
      handle = this.#d.notifier.show(spec, {
        action: (index) => {
          const args = spec.actionArgs[index]
          return args !== undefined ? this.activate(args) : Promise.resolve({ kind: 'unknown' })
        },
        click: () => this.activate(spec.launch),
        failed: (error) => {
          this.#d.log?.warn('desktop notification failed', { kind: spec.kind, error })
          if (this.#shown.get(key)?.spec === spec) this.#shown.delete(key)
          onFailed()
        },
        closed: () => {
          // An ask's toast may close into Action Center (a timeout): keep its handle so it can still be taken down
          // there once the ask is answered in the app.
          if (spec.kind !== 'ask' && spec.kind !== 'burst' && this.#shown.get(key)?.spec === spec) {
            this.#shown.delete(key)
          }
        },
      })
    } catch (err) {
      this.#d.log?.warn('desktop notification failed', { kind: spec.kind, err })
      onFailed()
      return false
    }
    this.#shown.set(key, { spec, handle })
    // Oldest first (a run's newer notification was deleted above, so it is set again at the end).
    for (const [k, s] of this.#shown) {
      if (this.#shown.size <= SHOWN_KEPT) break
      if (s.spec.kind !== 'ask' && s.spec.kind !== 'burst') this.#shown.delete(k)
    }
    return true
  }

  /** Desktop notifications tracked (tests; at most SHOWN_KEPT that are not asks or bursts). */
  get shownCount(): number {
    return this.#shown.size
  }

  /**
   * A click or an action, from a live notification or from Action Center (Notification.handleActivation, possibly
   * after a restart). Answers go through the core; a gone ask opens the run with "already answered/expired".
   */
  async activate(args: string): Promise<ActivationOutcome> {
    const a = decodeActivation(args)
    if (a === null) {
      this.#d.showWindow()
      return { kind: 'unknown' }
    }
    const now = this.#d.wallNow()
    for (const [k, at] of this.#handled) if (now - at >= ACTIVATION_DEDUPE_MS) this.#handled.delete(k)
    const key = activationKey(a)
    if (this.#handled.has(key)) return { kind: 'duplicate' }
    this.#handled.set(key, now)
    if (a.kind === 'open') {
      if (a.runId === null) this.#d.showWindow()
      else this.#d.openRun(a.runId)
      return { kind: 'opened', runId: a.runId }
    }
    let r: AnswerOutcome
    try {
      r = await this.#d.answer({ runId: a.runId, requestId: a.requestId, decision: a.decision })
    } catch (err) {
      r = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
    if (r.kind === 'answered') {
      this.#d.log?.info('ask answered from a notification', { runId: a.runId, decision: a.decision })
      this.#closeIf(a.runId, (s) => s.kind === 'ask' && s.requestId === a.requestId)
      return { kind: 'answered', runId: a.runId, requestId: a.requestId, decision: a.decision }
    }
    this.#d.openRun(a.runId)
    if (r.kind === 'stale') {
      this.#d.toast({ level: 'info', message: STALE_ACTIVATION })
      return { kind: 'stale', runId: a.runId, requestId: a.requestId }
    }
    this.#d.log?.warn('answer from a notification failed', { runId: a.runId, message: r.message })
    this.#d.toast({ level: 'error', message: r.message })
    return { kind: 'error', runId: a.runId, message: r.message }
  }

  /** Attention changed: take down a run's ask notification once nothing it offers is pending any more. */
  attentionChanged(): void {
    for (const [runId, s] of [...this.#shown]) {
      if (s.spec.kind !== 'ask' && s.spec.kind !== 'burst') continue
      if (s.spec.runId === null) continue
      const pending = this.#d.pendingAsks(s.spec.runId)
      const live = s.spec.kind === 'ask' ? pending.includes(s.spec.requestId ?? '') : pending.length > 0
      if (!live) this.#close(runId)
    }
  }

  /** notifications.test: a desktop notification whatever the focus and pause (the user asked for it). */
  test(): NotificationTestResult {
    const s = this.#d.settings()
    const inApp = (reason: string): NotificationTestResult => {
      this.#d.toast({ level: 'info', message: `Test notification · ${reason}` })
      return { shown: true, surface: 'in-app', reason }
    }
    if (!s.desktop) return inApp('Desktop notifications are off in Settings.')
    if (!this.#d.notifier.supported) return inApp('This system does not support desktop notifications.')
    const ok = this.#show(testSpec({ sound: s.sound }), () => undefined)
    return ok ? { shown: true, surface: 'native' } : inApp('The desktop notification could not be shown.')
  }

  dispose(): void {
    this.#disposed = true
    for (const t of this.#timers.values()) this.#d.timers.clear(t)
    this.#timers.clear()
    this.#windows.clear()
  }

  #closeIf(runId: string, pred: (s: NotificationSpec) => boolean): void {
    const s = this.#shown.get(runId)
    if (s !== undefined && pred(s.spec)) this.#close(runId)
  }

  #close(key: string): void {
    const s = this.#shown.get(key)
    if (s === undefined) return
    this.#shown.delete(key)
    try {
      s.handle.close()
    } catch (err) {
      this.#d.log?.warn('closing a desktop notification failed', { err })
    }
  }
}

/**
 * Activations that arrive before the window's page is up (Electron replays the one that launched the app as soon as
 * handleActivation is registered) wait for it, so "already answered/expired" and the run's page are not lost.
 */
export class ActivationQueue {
  readonly #run: (args: string) => void
  #open = false
  #queued: string[] = []

  constructor(run: (args: string) => void) {
    this.#run = run
  }

  push(args: string): void {
    if (this.#open) this.#run(args)
    else if (this.#queued.length < 20) this.#queued.push(args)
  }

  /** The page is ready: run what waited, then everything as it comes. */
  open(): void {
    if (this.#open) return
    this.#open = true
    const q = this.#queued
    this.#queued = []
    for (const args of q) this.#run(args)
  }
}
