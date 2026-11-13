// Soak (notification rules: at most one per run per 5 s): main's
// per-run notification windows forget a window once it ended with nothing waiting, so they hold the runs notified in
// the last window instead of every run that ever notified. What a window decides is unchanged.
import { describe, expect, it } from 'vitest'
import { RUN_NOTIFY_WINDOW_MS, RunWindows } from '../../../src/main/notifications-model.ts'
import type { NotificationFacts } from '../../../src/main/notifications-model.ts'

const NOW = 1_000_000
const done = (runId: string): NotificationFacts => ({
  kind: 'completed',
  runId,
  folder: 'my-app',
  title: 'Add a --version flag',
  outcome: 'clean',
  durationMs: 60_000,
  costUsd: 0.1,
})

describe('RunWindows forgets ended windows (soak)', () => {
  it('holds only the runs notified within the last window, however many notified before', () => {
    const w = new RunWindows()
    for (let i = 0; i < 200; i++) {
      const at = NOW + i * (RUN_NOTIFY_WINDOW_MS + 1)
      expect(w.offer(`run-${i}`, done(`run-${i}`), at)).toEqual({ kind: 'now' })
      w.delivered(`run-${i}`, at)
    }
    expect(w.trackedRuns).toBe(1)
  })

  it('keeps an open window and a window something waits in; decides as before', () => {
    const w = new RunWindows()
    w.delivered('a', NOW)
    expect(w.offer('a', done('a'), NOW + 1_000)).toEqual({
      kind: 'later',
      flushAt: NOW + RUN_NOTIFY_WINDOW_MS,
      arm: true,
    })
    // Another run's delivery after a's window ended: a still has something waiting, so its window stays.
    w.delivered('b', NOW + RUN_NOTIFY_WINDOW_MS + 10)
    expect(w.trackedRuns).toBe(2)
    expect(w.offer('a', done('a'), NOW + RUN_NOTIFY_WINDOW_MS + 20)).toEqual({
      kind: 'later',
      flushAt: NOW + RUN_NOTIFY_WINDOW_MS,
      arm: false,
    })
    expect(w.drain('a')).toHaveLength(2)
    // Drained and ended: the next delivery forgets it, and its next notification shows at once.
    w.delivered('b', NOW + 2 * RUN_NOTIFY_WINDOW_MS + 20)
    expect(w.trackedRuns).toBe(1)
    expect(w.offer('a', done('a'), NOW + 2 * RUN_NOTIFY_WINDOW_MS + 30)).toEqual({ kind: 'now' })
  })
})
