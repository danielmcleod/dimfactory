// Notification rules and texts (src/main/notifications-model.ts; attention surfaces, events,
// notification rules): settings, the surface decision, the per-run 5 s window and bursts, texts per platform, the
// activation arguments round trip and the Windows toast XML.
import { describe, expect, it } from 'vitest'
import { BUILTIN_DEFAULTS } from '../../../src/core/config/defaults.ts'
import {
  ACTION_LABEL,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFY_EVENTS,
  OPEN_TO_ANSWER,
  RUN_NOTIFY_WINDOW_MS,
  RunWindows,
  activationKey,
  coalesce,
  decideSurface,
  decodeActivation,
  durationText,
  encodeActivation,
  inAppToast,
  isPaused,
  notificationSettingsOf,
  notificationSpec,
  notificationText,
  testSpec,
  timeLeft,
  toastXml,
  usdText,
  xmlEscape,
} from '../../../src/main/notifications-model.ts'
import type {
  Activation,
  NotificationFacts,
  NotificationSettings,
  NotifyEvent,
  SurfaceInput,
} from '../../../src/main/notifications-model.ts'

const RUN = '20261006T120000Z-ab12'
const NOW = 1_000_000

const ask = (over: Partial<Extract<NotificationFacts, { kind: 'ask' }>> = {}): NotificationFacts => ({
  kind: 'ask',
  runId: RUN,
  folder: 'my-app',
  vendor: 'Claude',
  requestId: 'req-1',
  detail: 'Bash: npm test',
  expiresAt: NOW + 598_000,
  allowSession: true,
  ...over,
})

const settings = (over: Partial<NotificationSettings> = {}): NotificationSettings => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  ...over,
  events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, ...over.events },
})

const surface = (over: Partial<SurfaceInput> = {}) =>
  decideSurface({
    event: 'ask',
    settings: settings(),
    focused: false,
    pausedUntil: null,
    now: NOW,
    supported: true,
    ...over,
  })

describe('settings', () => {
  it('defaults equal the builtin config layer', () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual(BUILTIN_DEFAULTS.notifications)
    expect(notificationSettingsOf(undefined)).toEqual(BUILTIN_DEFAULTS.notifications)
  })

  it('takes the user file over the defaults, key by key', () => {
    expect(
      notificationSettingsOf({ notifications: { sound: true, events: { catalog: true, ask: false } } }),
    ).toEqual({
      desktop: true,
      sound: true,
      onlyWhenUnfocused: true,
      events: { ask: false, gate: true, completed: true, failed: true, catalog: true },
    })
  })
})

describe('decideSurface', () => {
  it('shows a desktop notification while the window is unfocused', () => {
    expect(surface()).toEqual({ kind: 'native' })
  })

  it.each(NOTIFY_EVENTS)('%s toggled off → nothing, focused or not', (event: NotifyEvent) => {
    const off = settings({ events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, [event]: false } })
    expect(surface({ event, settings: off })).toEqual({ kind: 'none', reason: 'event-off' })
    expect(surface({ event, settings: off, focused: true })).toEqual({ kind: 'none', reason: 'event-off' })
    // the other events are unaffected
    const other = NOTIFY_EVENTS.find((e) => e !== event && off.events[e]) ?? 'ask'
    if (other !== event) expect(surface({ event: other, settings: off }).kind).toBe('native')
  })

  it('focused → in-app toast (onlyWhenUnfocused); both when the user wants desktop while focused', () => {
    expect(surface({ focused: true })).toEqual({ kind: 'in-app' })
    expect(surface({ focused: true, settings: settings({ onlyWhenUnfocused: false }) })).toEqual({
      kind: 'native',
    })
  })

  it('desktop off: nothing while unfocused, in-app while focused', () => {
    const s = settings({ desktop: false })
    expect(surface({ settings: s })).toEqual({ kind: 'none', reason: 'desktop-off' })
    expect(surface({ settings: s, focused: true })).toEqual({ kind: 'in-app' })
    expect(surface({ settings: { ...s, onlyWhenUnfocused: false }, focused: true })).toEqual({
      kind: 'in-app',
    })
  })

  it('paused until a later time: no desktop notification; an ended pause no longer counts', () => {
    expect(surface({ pausedUntil: NOW + 1 })).toEqual({ kind: 'none', reason: 'paused' })
    expect(surface({ pausedUntil: NOW + 1, focused: true })).toEqual({ kind: 'in-app' })
    expect(surface({ pausedUntil: NOW })).toEqual({ kind: 'native' })
    expect(isPaused(null, NOW)).toBe(false)
    expect(isPaused(NOW + 5, NOW)).toBe(true)
  })

  it('unsupported system: nothing unfocused, in-app focused', () => {
    expect(surface({ supported: false })).toEqual({ kind: 'none', reason: 'unsupported' })
    expect(surface({ supported: false, focused: true })).toEqual({ kind: 'in-app' })
  })
})

describe('RunWindows (at most one per run per 5 s)', () => {
  it('shows the first at once, queues the rest of the window, then opens a new window', () => {
    const w = new RunWindows()
    const a = ask()
    expect(w.offer(RUN, a, NOW)).toEqual({ kind: 'now' })
    w.delivered(RUN, NOW)
    expect(w.offer(RUN, a, NOW + 1_000)).toEqual({
      kind: 'later',
      flushAt: NOW + RUN_NOTIFY_WINDOW_MS,
      arm: true,
    })
    expect(w.offer(RUN, a, NOW + 2_000)).toEqual({
      kind: 'later',
      flushAt: NOW + RUN_NOTIFY_WINDOW_MS,
      arm: false,
    })
    expect(w.queuedRuns).toEqual([RUN])
    expect(w.drain(RUN)).toHaveLength(2)
    expect(w.drain(RUN)).toEqual([])
    w.delivered(RUN, NOW + 5_000)
    expect(w.offer(RUN, a, NOW + 9_999).kind).toBe('later')
    w.drain(RUN)
    expect(w.offer(RUN, a, NOW + 10_000)).toEqual({ kind: 'now' })
  })

  it('keeps runs apart', () => {
    const w = new RunWindows()
    w.delivered(RUN, NOW)
    expect(w.offer('20261006T120000Z-ffff', ask(), NOW + 1)).toEqual({ kind: 'now' })
  })

  it('queues behind a window that has not been delivered yet (nothing shown) only while a queue exists', () => {
    const w = new RunWindows(5_000)
    expect(w.offer(RUN, ask(), NOW).kind).toBe('now')
    // the caller did not deliver (e.g. paused): the next one is shown at once again
    expect(w.offer(RUN, ask(), NOW + 1).kind).toBe('now')
  })
})

describe('coalesce', () => {
  const a1 = ask({ requestId: 'a1' })
  const a2 = ask({ requestId: 'a2' })
  const a3 = ask({ requestId: 'a3' })

  it('bursts become "N approvals waiting" with every pending ask of the run counted', () => {
    const f = coalesce([a2, a3], ['a1', 'a2', 'a3'])
    expect(f).toEqual({ kind: 'burst', runId: RUN, folder: 'my-app', count: 3 })
    expect(notificationText(f!, { now: NOW, actions: true })).toEqual({
      title: '3 approvals waiting · my-app',
      body: OPEN_TO_ANSWER,
    })
  })

  it('a single pending ask stays that ask; answered ones are dropped', () => {
    expect(coalesce([a1, a2], ['a2'])).toBe(a2)
    expect(coalesce([a1, a2], [])).toBeNull()
  })

  it('a finished run wins over its asks; else the last gate', () => {
    const done: NotificationFacts = {
      kind: 'completed',
      runId: RUN,
      folder: 'my-app',
      title: 't',
      durationMs: 1,
      costUsd: null,
    }
    const gate: NotificationFacts = { kind: 'gate', runId: RUN, folder: 'my-app', title: 't' }
    expect(coalesce([a1, done, a3], ['a1', 'a3'])).toBe(done)
    expect(coalesce([gate, a1], [])).toBe(gate)
    expect(coalesce([], [])).toBeNull()
  })
})

describe('texts (events)', () => {
  it('ask: "<Vendor> needs approval · <folder>" / "<detail> · 9:58 left"', () => {
    expect(notificationText(ask(), { now: NOW, actions: true })).toEqual({
      title: 'Claude needs approval · my-app',
      body: 'Bash: npm test · 9:58 left',
    })
  })

  it('ask without actions (Linux, unsigned macOS) says how to answer', () => {
    const t = notificationText(ask({ vendor: 'Codex' }), { now: NOW, actions: false })
    expect(t.title).toBe('Codex needs approval · my-app')
    expect(t.body).toBe(`Bash: npm test · 9:58 left\n${OPEN_TO_ANSWER}`)
  })

  it('gate: "Plan ready · <folder>"', () => {
    const t = notificationText(
      { kind: 'gate', runId: RUN, folder: 'my-app', title: 'add a flag' },
      {
        now: NOW,
        actions: true,
      },
    )
    expect(t).toEqual({ title: 'Plan ready · my-app', body: 'add a flag' })
  })

  it('the findings gate before Fix: "Findings ready · <folder>" with the card title', () => {
    const t = notificationText(
      {
        kind: 'gate',
        runId: RUN,
        folder: 'my-app',
        title: 'add a flag',
        beforeFix: { cardTitle: '3 findings before Fix: 2 must, 1 should' },
      },
      { now: NOW, actions: true },
    )
    expect(t).toEqual({ title: 'Findings ready · my-app', body: '3 findings before Fix: 2 must, 1 should' })
  })

  it('completed: "Completed · <outcome> · <duration> · $<est>", leaving out what is unknown', () => {
    const base = { kind: 'completed' as const, runId: RUN, folder: 'my-app', title: 'add a flag' }
    expect(
      notificationText(
        { ...base, outcome: 'clean', durationMs: 6 * 60_000 + 10_000, costUsd: 0.4231 },
        {
          now: NOW,
          actions: true,
        },
      ),
    ).toEqual({ title: 'Completed · Clean · 6 min · $0.42', body: 'my-app · add a flag' })
    expect(
      notificationText(
        { ...base, outcome: 'fixed', durationMs: null, costUsd: null },
        { now: NOW, actions: true },
      ).title,
    ).toBe('Completed · Fixed')
    expect(
      notificationText({ ...base, durationMs: 45_000, costUsd: 0.004 }, { now: NOW, actions: true }).title,
    ).toBe('Completed · 45 s · <$0.01')
  })

  it('failed: "Failed · <category title>"', () => {
    const t = notificationText(
      {
        kind: 'failed',
        runId: RUN,
        folder: 'my-app',
        title: 'add a flag',
        categoryTitle: 'Claude needs you to log in',
      },
      { now: NOW, actions: true },
    )
    expect(t).toEqual({ title: 'Failed · Claude needs you to log in', body: 'my-app · add a flag' })
  })

  it('catalog: "Model prices may be out of date"', () => {
    expect(notificationText({ kind: 'catalog' }, { now: NOW, actions: true }).title).toBe(
      'Model prices may be out of date',
    )
  })

  it('formats time left, durations and dollars', () => {
    expect(timeLeft(598_000)).toBe('9:58')
    expect(timeLeft(-5)).toBe('0:00')
    expect(timeLeft(3_723_000)).toBe('1:02:03')
    expect(durationText(45_000)).toBe('45 s')
    expect(durationText(64 * 60_000)).toBe('1 h 4 min')
    expect(durationText(120 * 60_000)).toBe('2 h')
    expect(usdText(1.5)).toBe('$1.50')
    expect(usdText(0)).toBe('$0.00')
  })

  it('clips a long ask detail to one line', () => {
    const t = notificationText(ask({ detail: `${'x'.repeat(300)}\nsecond` }), { now: NOW, actions: true })
    expect(t.body.length).toBeLessThan(170)
    expect(t.body).toContain('…')
    expect(t.body).not.toContain('\n')
  })

  it('in-app toasts carry the title, warn for asks and error for failures', () => {
    expect(inAppToast(ask(), NOW)).toEqual({
      level: 'warn',
      message: 'Claude needs approval · my-app',
      askRunId: RUN,
    })
    expect(
      inAppToast({ kind: 'failed', runId: RUN, folder: 'f', title: 't', categoryTitle: 'Network' }, NOW),
    ).toEqual({ level: 'error', message: 'Failed · Network' })
    expect(inAppToast({ kind: 'gate', runId: RUN, folder: 'f', title: 't' }, NOW).level).toBe('info')
  })

  it("a gate's in-app toast names its run, so the renderer leaves it out in that run's own view", () => {
    expect(inAppToast({ kind: 'gate', runId: RUN, folder: 'f', title: 't' }, NOW)).toEqual({
      level: 'info',
      message: 'Plan ready · f',
      skipInRunView: RUN,
    })
    expect(
      inAppToast(
        { kind: 'gate', runId: RUN, folder: 'f', title: 't', beforeFix: { cardTitle: '3 findings' } },
        NOW,
      ),
    ).toEqual(expect.objectContaining({ message: 'Findings ready · f', skipInRunView: RUN }))
    // Asks, completions and failures are not shown as cards in a way a toast would cover: they keep theirs.
    expect(inAppToast(ask(), NOW)).not.toHaveProperty('skipInRunView')
    expect(
      inAppToast({ kind: 'failed', runId: RUN, folder: 'f', title: 't', categoryTitle: 'Network' }, NOW),
    ).not.toHaveProperty('skipInRunView')
  })
})

describe('notificationSpec (actions per platform)', () => {
  const opts = { now: NOW, sound: false, macActions: false }

  it('Windows: [Allow once] [Allow for this run] [Deny], sticky, one id per run', () => {
    const s = notificationSpec(ask(), { ...opts, platform: 'win32' })
    expect(s.actions.map((a) => a.label)).toEqual(['Allow once', 'Allow for this run', 'Deny'])
    expect(s.actions.map((a) => a.decision)).toEqual(['allow', 'allow-session', 'deny'])
    expect(s.sticky).toBe(true)
    expect(s.silent).toBe(true)
    expect(s.id).toBe(`dim-factory-run-${RUN}`)
    expect(s.requestId).toBe('req-1')
    expect(s.actionArgs.map((a) => decodeActivation(a))).toEqual([
      { kind: 'answer', runId: RUN, requestId: 'req-1', decision: 'allow' },
      { kind: 'answer', runId: RUN, requestId: 'req-1', decision: 'allow-session' },
      { kind: 'answer', runId: RUN, requestId: 'req-1', decision: 'deny' },
    ])
    expect(decodeActivation(s.launch)).toEqual({ kind: 'open', runId: RUN })
  })

  it('allowSession:false → two actions (no "Allow for this run")', () => {
    const s = notificationSpec(ask({ allowSession: false }), { ...opts, platform: 'win32' })
    expect(s.actions.map((a) => a.label)).toEqual([ACTION_LABEL.allow, ACTION_LABEL.deny])
    expect(s.actionArgs).toHaveLength(2)
  })

  it('Linux: no actions; the body says "Open Dim Factory to answer" and a click opens the run', () => {
    const s = notificationSpec(ask(), { ...opts, platform: 'linux' })
    expect(s.actions).toEqual([])
    expect(s.actionArgs).toEqual([])
    expect(s.body).toContain(OPEN_TO_ANSWER)
    expect(decodeActivation(s.launch)).toEqual({ kind: 'open', runId: RUN })
  })

  it('macOS: actions only for a signed (alert-style) build', () => {
    expect(notificationSpec(ask(), { ...opts, platform: 'darwin' }).actions).toEqual([])
    expect(notificationSpec(ask(), { ...opts, platform: 'darwin' }).body).toContain(OPEN_TO_ANSWER)
    expect(notificationSpec(ask(), { ...opts, platform: 'darwin', macActions: true }).actions).toHaveLength(3)
  })

  it('gate, completed and failed only open the run; sound follows the setting', () => {
    const gate = notificationSpec(
      { kind: 'gate', runId: RUN, folder: 'f', title: 't' },
      { ...opts, platform: 'win32', sound: true },
    )
    expect(gate.actions).toEqual([])
    expect(gate.sticky).toBe(false)
    expect(gate.silent).toBe(false)
    expect(decodeActivation(gate.launch)).toEqual({ kind: 'open', runId: RUN })
    const cat = notificationSpec({ kind: 'catalog' }, { ...opts, platform: 'win32' })
    expect(cat.runId).toBeNull()
    expect(decodeActivation(cat.launch)).toEqual({ kind: 'open', runId: null })
  })

  it('the test notification opens the window', () => {
    const t = testSpec({ sound: false })
    expect(t.kind).toBe('test')
    expect(t.title).toBe('Dim Factory notifications are on')
    expect(decodeActivation(t.launch)).toEqual({ kind: 'open', runId: null })
  })
})

describe('activation arguments', () => {
  it.each<Activation>([
    { kind: 'open', runId: RUN },
    { kind: 'open', runId: null },
    { kind: 'answer', runId: RUN, requestId: 'toolu_01ABC', decision: 'allow' },
    { kind: 'answer', runId: RUN, requestId: 'a&b=c d/é?#', decision: 'allow-session' },
    { kind: 'answer', runId: RUN, requestId: '42', decision: 'deny' },
  ])('round-trips %j', (a) => {
    const raw = encodeActivation(a)
    expect(raw.startsWith('dim-factory:')).toBe(true)
    expect(decodeActivation(raw)).toEqual(a)
  })

  it.each([
    '',
    'something else',
    'https://example.com/?run=x',
    'dim-factory:open',
    `dim-factory:open?v=2&run=${RUN}`,
    'dim-factory:open?v=1&run=not-a-run',
    `dim-factory:answer?v=1&run=${RUN}&d=allow`,
    `dim-factory:answer?v=1&run=${RUN}&req=r&d=cancel`,
    `dim-factory:answer?v=1&req=r&d=allow`,
    `dim-factory:answer?v=1&run=${RUN}&req=${'r'.repeat(300)}&d=deny`,
    `dim-factory:delete?v=1&run=${RUN}`,
    `dim-factory:open?v=1&run=${RUN}&${'x'.repeat(3000)}`,
  ])('rejects %j', (raw) => {
    expect(decodeActivation(raw)).toBeNull()
  })

  it('keys one ask (whatever the decision) or one run', () => {
    expect(activationKey({ kind: 'answer', runId: RUN, requestId: 'r', decision: 'allow' })).toBe(
      activationKey({ kind: 'answer', runId: RUN, requestId: 'r', decision: 'deny' }),
    )
    expect(activationKey({ kind: 'open', runId: RUN })).not.toBe(
      activationKey({ kind: 'answer', runId: RUN, requestId: 'r', decision: 'deny' }),
    )
  })
})

describe('toastXml (Windows)', () => {
  it('carries our launch and action arguments, escaped, and keeps asks on screen', () => {
    const s = notificationSpec(ask({ detail: 'echo "<a & b>"', requestId: 'x&y' }), {
      platform: 'win32',
      now: NOW,
      sound: false,
      macActions: false,
    })
    const xml = toastXml(s)
    expect(
      xml.startsWith(
        `<toast launch="${xmlEscape(s.launch)}" activationType="foreground" scenario="reminder">`,
      ),
    ).toBe(true)
    expect(xml).toContain('<text>Claude needs approval · my-app</text>')
    expect(xml).toContain('<text>echo &quot;&lt;a &amp; b&gt;&quot; · 9:58 left</text>')
    for (const [i, a] of s.actions.entries()) {
      expect(xml).toContain(
        `<action content="${a.label}" arguments="${xmlEscape(s.actionArgs[i] ?? '')}" activationType="foreground"/>`,
      )
    }
    expect(xml).toContain('<audio silent="true"/>')
    expect(xml.endsWith('</toast>')).toBe(true)
    // nothing unescaped inside attribute values
    expect(xml).not.toMatch(/="[^"]*[<&](?!amp;|lt;|gt;|quot;|apos;)[^"]*"/)
  })

  it('a gate is a plain toast: no actions, no reminder scenario, sound when enabled', () => {
    const xml = toastXml(
      notificationSpec(
        { kind: 'gate', runId: RUN, folder: 'my-app', title: 't' },
        { platform: 'win32', now: NOW, sound: true, macActions: false },
      ),
    )
    expect(xml).not.toContain('scenario=')
    expect(xml).not.toContain('<actions>')
    expect(xml).not.toContain('<audio')
  })
})
