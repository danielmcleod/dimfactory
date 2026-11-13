// Soak (attention surfaces): main tracks the last desktop notification
// of at most SHOWN_KEPT runs, besides asks and bursts, which it must still take down once answered. Before, a run's
// last notification (Completed) stayed tracked until the platform reported it closed, which the E2E recorder and some
// platforms never do: the soak's heap kept one per run that notified while the window was unfocused.
import { describe, expect, it } from 'vitest'
import type { AnswerOutcome } from '../../../src/main/core-host.ts'
import { RecordingNotifier } from '../../../src/main/notification-recorder.ts'
import { NotificationCenter, SHOWN_KEPT } from '../../../src/main/notifications.ts'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../../src/main/notifications-model.ts'
import type { NotificationFacts } from '../../../src/main/notifications-model.ts'

const completed = (runId: string): NotificationFacts => ({
  kind: 'completed',
  runId,
  folder: 'my-app',
  title: 'Add a --version flag',
  outcome: 'clean',
  durationMs: 60_000,
  costUsd: 0.1,
})

const ask = (runId: string, requestId: string): NotificationFacts => ({
  kind: 'ask',
  runId,
  folder: 'my-app',
  vendor: 'Claude',
  requestId,
  detail: 'Bash: npm test',
  expiresAt: 600_000,
  allowSession: true,
})

function setup() {
  const recorder = new RecordingNotifier()
  const pending = new Map<string, string[]>()
  let now = 0
  const center = new NotificationCenter({
    platform: 'linux',
    macActions: false,
    notifier: recorder,
    settings: () => DEFAULT_NOTIFICATION_SETTINGS,
    pausedUntil: () => null,
    focused: () => false,
    now: () => 0,
    wallNow: () => now,
    timers: { set: () => 0, clear: () => undefined },
    pendingAsks: (runId) => pending.get(runId) ?? [],
    answer: (): Promise<AnswerOutcome> => Promise.resolve({ kind: 'answered' }),
    openRun: () => undefined,
    showWindow: () => undefined,
    toast: () => undefined,
  })
  return { center, recorder, pending, tick: () => (now += 10_000) }
}

describe('tracked desktop notifications (soak)', () => {
  it('keeps the last notification of at most SHOWN_KEPT runs, the newest ones', () => {
    const t = setup()
    for (let i = 0; i < 4 * SHOWN_KEPT; i++) {
      t.center.notify(completed(`run-${i}`))
      t.tick()
    }
    expect(t.recorder.list()).toHaveLength(Math.min(4 * SHOWN_KEPT, 200))
    expect(t.center.shownCount).toBe(SHOWN_KEPT)
    // The newest run's notification is still tracked: its next one takes it down first.
    const last = `run-${4 * SHOWN_KEPT - 1}`
    t.pending.set(last, ['r1'])
    t.center.notify(ask(last, 'r1'))
    const forLast = t.recorder.list().filter((n) => n.runId === last)
    expect(forLast.map((n) => [n.kind, n.closed])).toEqual([
      ['completed', true],
      ['ask', false],
    ])
  })

  it('never forgets an ask: answered elsewhere, it is still taken down', () => {
    const t = setup()
    for (let i = 0; i < 3; i++) {
      t.pending.set(`asking-${i}`, [`r${i}`])
      t.center.notify(ask(`asking-${i}`, `r${i}`))
      t.tick()
    }
    for (let i = 0; i < 2 * SHOWN_KEPT; i++) {
      t.center.notify(completed(`run-${i}`))
      t.tick()
    }
    expect(t.center.shownCount).toBe(SHOWN_KEPT)
    t.pending.delete('asking-0')
    t.center.attentionChanged()
    const first = t.recorder.list().find((n) => n.runId === 'asking-0')
    expect(first?.closed).toBe(true)
    expect(t.recorder.list().find((n) => n.runId === 'asking-1')?.closed).toBe(false)
    expect(t.center.shownCount).toBe(SHOWN_KEPT - 1)
  })
})
