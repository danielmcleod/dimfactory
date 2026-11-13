// Desktop notification rules and texts (attention surfaces, events, notification rules; the
// `notifications` config): which surface a core notification reaches, the per-run 5 s window and its burst text, the
// per-platform texts and actions, the arguments a toast carries back, and the Windows toast XML. Pure.
import type { AskDecision } from '@shared/events.ts'
import type { DimFactoryConfig } from '@shared/config-schema.ts'
import { RUN_ID_PATTERN } from '@shared/ids.ts'
import type { Platform, ToastLevel } from '@shared/ipc.ts'
import type { RunOutcome } from '@shared/run.ts'
import { BRAND } from '@shared/brand.ts'

export const NOTIFY_EVENTS = ['ask', 'gate', 'completed', 'failed', 'catalog'] as const
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]

export interface NotificationSettings {
  desktop: boolean
  sound: boolean
  onlyWhenUnfocused: boolean
  events: Record<NotifyEvent, boolean>
}

/** The builtin defaults (a test keeps them equal to core's BUILTIN_DEFAULTS.notifications). */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktop: true,
  sound: false,
  onlyWhenUnfocused: true,
  events: { ask: true, gate: true, completed: true, failed: true, catalog: false },
}

/** The user file's `notifications` over the builtin defaults (the key is user-only). */
export function notificationSettingsOf(
  cfg: Pick<DimFactoryConfig, 'notifications'> | undefined,
): NotificationSettings {
  const n = cfg?.notifications
  const d = DEFAULT_NOTIFICATION_SETTINGS
  return {
    desktop: n?.desktop ?? d.desktop,
    sound: n?.sound ?? d.sound,
    onlyWhenUnfocused: n?.onlyWhenUnfocused ?? d.onlyWhenUnfocused,
    events: {
      ask: n?.events?.ask ?? d.events.ask,
      gate: n?.events?.gate ?? d.events.gate,
      completed: n?.events?.completed ?? d.events.completed,
      failed: n?.events?.failed ?? d.events.failed,
      catalog: n?.events?.catalog ?? d.events.catalog,
    },
  }
}

export type AnswerDecision = Exclude<AskDecision, 'cancel'>

interface RunFacts {
  runId: string
  /** The folder's last path segment. */
  folder: string
}

/** What core says happened; main only words it. `burst` is made here, by coalesce(). */
export type NotificationFacts =
  | (RunFacts & {
      kind: 'ask'
      /** Vendor display name. */
      vendor: string
      requestId: string
      detail: string
      expiresAt: number
      allowSession: boolean
    })
  /** The plan gate; `beforeFix` is the findings gate before Fix, with its card title ("3 findings before Fix: …"). */
  | (RunFacts & { kind: 'gate'; title: string; beforeFix?: { cardTitle: string } })
  | (RunFacts & {
      kind: 'completed'
      title: string
      outcome?: RunOutcome
      durationMs: number | null
      costUsd: number | null
      /** Part of costUsd is a catalog estimate: worded "$0.41 est.", as the Run view words it. */
      costEstimated?: boolean
    })
  | (RunFacts & { kind: 'failed'; title: string; categoryTitle: string })
  | (RunFacts & { kind: 'burst'; count: number })
  | { kind: 'catalog' }

export type FactsKind = NotificationFacts['kind']

export function eventOf(f: NotificationFacts): NotifyEvent {
  return f.kind === 'burst' ? 'ask' : f.kind
}

export function runIdOf(f: NotificationFacts): string | null {
  return f.kind === 'catalog' ? null : f.runId
}

// ---- surface --------------------------------------------------------------------------------------------------------

export type SkipReason = 'event-off' | 'desktop-off' | 'paused' | 'unsupported'
export type Surface = { kind: 'native' } | { kind: 'in-app' } | { kind: 'none'; reason: SkipReason }

export interface SurfaceInput {
  event: NotifyEvent
  settings: NotificationSettings
  focused: boolean
  /** state.json notifications.pausedUntil (wall-clock ms). */
  pausedUntil: number | null
  /** Wall-clock now. */
  now: number
  /** Notification.isSupported(). */
  supported: boolean
}

export function isPaused(pausedUntil: number | null, now: number): boolean {
  return pausedUntil !== null && pausedUntil > now
}

/**
 * The event toggle decides whether the user hears about it at all. A focused window gets an in-app toast unless the
 * user wants desktop notifications while focused too (`onlyWhenUnfocused:false`). Unfocused: a desktop notification
 * when desktop is on, not paused and supported; nothing otherwise (the app shows it when the user comes back).
 */
export function decideSurface(i: SurfaceInput): Surface {
  if (!i.settings.events[i.event]) return { kind: 'none', reason: 'event-off' }
  const blocked: SkipReason | null = !i.settings.desktop
    ? 'desktop-off'
    : isPaused(i.pausedUntil, i.now)
      ? 'paused'
      : !i.supported
        ? 'unsupported'
        : null
  if (i.focused)
    return blocked === null && !i.settings.onlyWhenUnfocused ? { kind: 'native' } : { kind: 'in-app' }
  return blocked === null ? { kind: 'native' } : { kind: 'none', reason: blocked }
}

// ---- per-run window and bursts ----------------------------------------------------------------------------------

/** At most one notification per run per 5 s. */
export const RUN_NOTIFY_WINDOW_MS = 5_000

export type Offer = { kind: 'now' } | { kind: 'later'; flushAt: number; arm: boolean }

/**
 * Leading edge: the first notification of a run shows at once and opens a 5 s window; what arrives inside it waits
 * for the window's end, where it is coalesced into one notification (which opens the next window).
 */
export class RunWindows {
  readonly #windowMs: number
  readonly #last = new Map<string, number>()
  readonly #queued = new Map<string, NotificationFacts[]>()

  constructor(windowMs = RUN_NOTIFY_WINDOW_MS) {
    this.#windowMs = windowMs
  }

  offer(runId: string, f: NotificationFacts, now: number): Offer {
    const last = this.#last.get(runId)
    const queued = this.#queued.get(runId)
    if (queued === undefined && (last === undefined || now - last >= this.#windowMs)) return { kind: 'now' }
    const flushAt = (last ?? now) + this.#windowMs
    if (queued !== undefined) {
      queued.push(f)
      return { kind: 'later', flushAt, arm: false }
    }
    this.#queued.set(runId, [f])
    return { kind: 'later', flushAt, arm: true }
  }

  /** The window's end: what waited, oldest first (empty when nothing did). */
  drain(runId: string): NotificationFacts[] {
    const q = this.#queued.get(runId) ?? []
    this.#queued.delete(runId)
    return q
  }

  /** A notification for the run reached the user now: its window starts. */
  delivered(runId: string, now: number): void {
    this.#last.set(runId, now)
    // Windows that ended (nothing waiting) are forgotten, as offer reads an ended window as none, so this
    // holds the runs notified within the last window instead of every run that ever notified.
    for (const [id, at] of this.#last)
      if (now - at >= this.#windowMs && !this.#queued.has(id)) this.#last.delete(id)
  }

  /** Runs whose window is remembered (stays small however many runs notified). */
  get trackedRuns(): number {
    return this.#last.size
  }

  get queuedRuns(): string[] {
    return [...this.#queued.keys()]
  }

  clear(): void {
    this.#last.clear()
    this.#queued.clear()
  }
}

/**
 * One notification for what waited in a run's window. A finished run's notice wins (its asks are gone). Asks: when
 * the run has two or more approvals pending, "N approvals waiting"; one → that ask. Else the last plan gate.
 */
export function coalesce(
  queued: readonly NotificationFacts[],
  pendingAsks: readonly string[],
): NotificationFacts | null {
  const last = <K extends FactsKind>(kind: K): Extract<NotificationFacts, { kind: K }> | undefined =>
    [...queued].reverse().find((f): f is Extract<NotificationFacts, { kind: K }> => f.kind === kind)
  const terminal = [...queued].reverse().find((f) => f.kind === 'completed' || f.kind === 'failed')
  if (terminal !== undefined) return terminal
  const pending = new Set(pendingAsks)
  const asks = queued.filter(
    (f): f is Extract<NotificationFacts, { kind: 'ask' }> => f.kind === 'ask' && pending.has(f.requestId),
  )
  const ask = asks[asks.length - 1]
  if (ask !== undefined) {
    if (pending.size >= 2) return { kind: 'burst', runId: ask.runId, folder: ask.folder, count: pending.size }
    return ask
  }
  return last('gate') ?? null
}

// ---- activation arguments -----------------------------------------------------------------------------------------

export type Activation =
  | { kind: 'open'; runId: string | null }
  | { kind: 'answer'; runId: string; requestId: string; decision: AnswerDecision }

const ARG_SCHEME = `${BRAND.slug}:`
const ARG_VERSION = '1'
const REQUEST_ID_MAX = 256
const DECISIONS: readonly AnswerDecision[] = ['allow', 'allow-session', 'deny']

/** `dim-factory:open?v=1&run=<id>` / `dim-factory:answer?v=1&run=<id>&req=<id>&d=<decision>`. */
export function encodeActivation(a: Activation): string {
  const q = new URLSearchParams({ v: ARG_VERSION })
  if (a.runId !== null) q.set('run', a.runId)
  if (a.kind === 'answer') {
    q.set('req', a.requestId)
    q.set('d', a.decision)
  }
  return `${ARG_SCHEME}${a.kind}?${q.toString()}`
}

/** The toast's own arguments back; null for anything else (another app's, a newer format, a bad id). */
export function decodeActivation(raw: string): Activation | null {
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.startsWith(ARG_SCHEME)) return null
  const rest = raw.slice(ARG_SCHEME.length)
  const qAt = rest.indexOf('?')
  if (qAt < 0) return null
  const kind = rest.slice(0, qAt)
  const q = new URLSearchParams(rest.slice(qAt + 1))
  if (q.get('v') !== ARG_VERSION) return null
  const run = q.get('run')
  if (run !== null && !RUN_ID_PATTERN.test(run)) return null
  if (kind === 'open') return { kind: 'open', runId: run }
  if (kind !== 'answer' || run === null) return null
  const requestId = q.get('req')
  const decision = q.get('d')
  if (requestId === null || requestId === '' || requestId.length > REQUEST_ID_MAX) return null
  if (!DECISIONS.includes(decision as AnswerDecision)) return null
  return { kind: 'answer', runId: run, requestId, decision: decision as AnswerDecision }
}

/** Activations already handled (Windows reports a live toast both to its object and to handleActivation). */
export function activationKey(a: Activation): string {
  return a.kind === 'answer' ? `answer:${a.runId}:${a.requestId}` : `open:${a.runId ?? ''}`
}

// ---- texts ------------------------------------------------------------------------------------------------------

export const OPEN_TO_ANSWER = 'Open Dim Factory to answer'
export const STALE_ACTIVATION = 'This question was already answered or has expired.'
export const ACTION_LABEL: Readonly<Record<AnswerDecision, string>> = {
  allow: 'Allow once',
  'allow-session': 'Allow for this run',
  deny: 'Deny',
}
const DETAIL_MAX = 140
const LINE_MAX = 200

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

/** Ask time left as `9:58` (never negative). */
export function timeLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** `45 s`, `6 min`, `1 h 4 min`. */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

export function usdText(usd: number): string {
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

export const OUTCOME_LABEL: Readonly<Record<RunOutcome, string>> = {
  fixed: 'Fixed',
  clean: 'Clean',
  'no-changes': 'No changes',
  'findings-open': 'Findings open',
  'verify-failed': 'Verify failed',
  'security-open': 'Security findings open',
  'fix-stopped': 'Fix rounds stopped',
  'gates-failed': 'Quality gates not passed',
  failed: 'Failed',
}

export interface NotificationText {
  title: string
  body: string
}

/** The events. `actions` says whether the platform shows the ask's buttons (else it says how to answer). */
export function notificationText(
  f: NotificationFacts,
  o: { now: number; actions: boolean },
): NotificationText {
  switch (f.kind) {
    case 'ask': {
      const line = `${oneLine(f.detail, DETAIL_MAX)} · ${timeLeft(f.expiresAt - o.now)} left`
      return {
        title: oneLine(`${f.vendor} needs approval · ${f.folder}`, LINE_MAX),
        body: o.actions ? line : `${line}\n${OPEN_TO_ANSWER}`,
      }
    }
    case 'burst':
      return {
        title: oneLine(`${f.count} approvals waiting · ${f.folder}`, LINE_MAX),
        body: OPEN_TO_ANSWER,
      }
    case 'gate':
      // Open only: a gate is never approved from a notification.
      return f.beforeFix !== undefined
        ? {
            title: oneLine(`Findings ready · ${f.folder}`, LINE_MAX),
            body: oneLine(f.beforeFix.cardTitle, LINE_MAX),
          }
        : { title: oneLine(`Plan ready · ${f.folder}`, LINE_MAX), body: oneLine(f.title, LINE_MAX) }
    case 'completed': {
      const parts = ['Completed']
      if (f.outcome !== undefined) parts.push(OUTCOME_LABEL[f.outcome])
      if (f.durationMs !== null) parts.push(durationText(f.durationMs))
      if (f.costUsd !== null) parts.push(`${usdText(f.costUsd)}${f.costEstimated === true ? ' est.' : ''}`)
      return { title: parts.join(' · '), body: oneLine(`${f.folder} · ${f.title}`, LINE_MAX) }
    }
    case 'failed':
      return {
        title: oneLine(`Failed · ${f.categoryTitle}`, LINE_MAX),
        body: oneLine(`${f.folder} · ${f.title}`, LINE_MAX),
      }
    case 'catalog':
      return { title: 'Model prices may be out of date', body: 'Refresh them in Settings → Catalog.' }
  }
}

export const TEST_TEXT: NotificationText = {
  title: 'Dim Factory notifications are on',
  body: 'Approvals, plan gates and finished runs will show up here.',
}

export interface InAppToast {
  level: ToastLevel
  message: string
  /** A gate's run: the renderer skips the toast while that run's view is open (it shows the gate already). */
  skipInRunView?: string
  /**
   * An approval's run (an ask, or a burst of them): the toast is about what waits there now, so the renderer keeps one
   * per run and takes it down once nothing waits (answered, timed out, or the run ended).
   */
  askRunId?: string
}

/**
 * The in-app toast a focused window gets instead. A gate's says which run it is about: in that run's own view the
 * gate card, its jump pill and the assertive announcement say it already, and a toast would cover the card's actions.
 */
export function inAppToast(f: NotificationFacts, now: number): InAppToast {
  const { title } = notificationText(f, { now, actions: true })
  const level: ToastLevel =
    f.kind === 'failed' ? 'error' : f.kind === 'ask' || f.kind === 'burst' ? 'warn' : 'info'
  if (f.kind === 'gate') return { level, message: title, skipInRunView: f.runId }
  if (f.kind === 'ask' || f.kind === 'burst') return { level, message: title, askRunId: f.runId }
  return { level, message: title }
}

// ---- native spec ------------------------------------------------------------------------------------------------

export interface NativeAction {
  label: string
  decision: AnswerDecision
}

export interface NotificationSpec {
  /** One live notification per run: a newer one replaces it (Windows Tag, macOS identifier). */
  id: string
  runId: string | null
  kind: FactsKind | 'test'
  requestId?: string
  title: string
  body: string
  actions: NativeAction[]
  /** Arguments of a body click. */
  launch: string
  /** Arguments of each action, same order. */
  actionArgs: string[]
  /** Stays until answered (`timeoutType:'never'`, Windows reminder scenario): asks. */
  sticky: boolean
  silent: boolean
}

export interface SpecOptions {
  platform: Platform
  /** Core clock now (ask time left). */
  now: number
  sound: boolean
  /** macOS shows actions only on alert-style notifications of a signed bundle. */
  macActions: boolean
}

/** Whether this platform answers an ask from the notification itself. */
export function platformHasActions(platform: Platform, macActions: boolean): boolean {
  return platform === 'win32' || (platform === 'darwin' && macActions)
}

export function notificationId(f: NotificationFacts): string {
  return f.kind === 'catalog' ? 'dim-factory-catalog' : `dim-factory-run-${f.runId}`
}

export function notificationSpec(f: NotificationFacts, o: SpecOptions): NotificationSpec {
  const runId = runIdOf(f)
  const withActions = f.kind === 'ask' && platformHasActions(o.platform, o.macActions)
  const text = notificationText(f, { now: o.now, actions: withActions })
  const actions: NativeAction[] = []
  if (f.kind === 'ask' && withActions) {
    actions.push({ label: ACTION_LABEL.allow, decision: 'allow' })
    if (f.allowSession) actions.push({ label: ACTION_LABEL['allow-session'], decision: 'allow-session' })
    actions.push({ label: ACTION_LABEL.deny, decision: 'deny' })
  }
  return {
    id: notificationId(f),
    runId,
    kind: f.kind,
    ...(f.kind === 'ask' ? { requestId: f.requestId } : {}),
    title: text.title,
    body: text.body,
    actions,
    launch: encodeActivation({ kind: 'open', runId }),
    actionArgs:
      f.kind === 'ask'
        ? actions.map((a) =>
            encodeActivation({
              kind: 'answer',
              runId: f.runId,
              requestId: f.requestId,
              decision: a.decision,
            }),
          )
        : [],
    sticky: f.kind === 'ask' || f.kind === 'burst',
    silent: !o.sound,
  }
}

export function testSpec(o: { sound: boolean }): NotificationSpec {
  return {
    id: 'dim-factory-test',
    runId: null,
    kind: 'test',
    ...TEST_TEXT,
    actions: [],
    launch: encodeActivation({ kind: 'open', runId: null }),
    actionArgs: [],
    sticky: false,
    silent: !o.sound,
  }
}

// ---- Windows toast XML ------------------------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * The toast Windows shows (Electron's `toastXml`): our own `launch` / action `arguments`, so a click in Action Center
 * after the toast left the screen (Notification.handleActivation) still says which run and which ask. Asks use the
 * reminder scenario, which keeps them on screen until answered (`timeoutType:'never'`).
 */
export function toastXml(spec: NotificationSpec): string {
  const sticky = spec.sticky && spec.actions.length > 0
  const head =
    `<toast launch="${xmlEscape(spec.launch)}" activationType="foreground"` +
    (sticky ? ' scenario="reminder"' : '') +
    '>'
  const visual =
    '<visual><binding template="ToastGeneric">' +
    `<text>${xmlEscape(spec.title)}</text>` +
    (spec.body !== '' ? `<text>${xmlEscape(spec.body)}</text>` : '') +
    '</binding></visual>'
  const actions =
    spec.actions.length === 0
      ? ''
      : '<actions>' +
        spec.actions
          .map(
            (a, i) =>
              `<action content="${xmlEscape(a.label)}" arguments="${xmlEscape(spec.actionArgs[i] ?? '')}"` +
              ' activationType="foreground"/>',
          )
          .join('') +
        '</actions>'
  const audio = spec.silent ? '<audio silent="true"/>' : ''
  return `${head}${visual}${actions}${audio}</toast>`
}
