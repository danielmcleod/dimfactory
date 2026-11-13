// A run's own limits (factory/run-limits.ts) on a manual clock, a fake bus and published summaries: no limit by default
// (nothing is ever stopped), a cost limit stops the run once its cost passes it (also while it waits at a card), a time
// limit counts working time only (waiting for the user or the folder does not count), the stop is recorded beside the
// run before Stop is sent, and a run that ended is forgotten.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventBus, GlobalEvent } from '@core/bus/bus.ts'
import { silentLogger } from '@core/log.ts'
import { RunLimitsWatcher, readLimitStop } from '@core/factory/run-limits.ts'
import type { Clock, TimerHandle } from '@core/supervisor/effects.ts'
import type { RunLimits } from '@shared/config-schema.ts'
import { RUN_LIMITS_NONE, RunLimitsZ, RunOverridesZ } from '@shared/config-schema.ts'
import type { RunStatus, RunSummary } from '@shared/run.ts'

const dirs: string[] = []
const watchers: RunLimitsWatcher[] = []
afterEach(() => {
  for (const w of watchers.splice(0)) w.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function manualClock(start: number): Clock & { advance(ms: number): number } {
  let now = start
  let seq = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  return {
    now: () => now,
    setTimer: (fn, at) => {
      const id = ++seq
      timers.set(id, { fn, at })
      return id as unknown as TimerHandle
    },
    clearTimer: (h) => {
      timers.delete(h as unknown as number)
    },
    scale: 1,
    advance: (ms) => {
      now += ms
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue
        timers.delete(id)
        t.fn()
      }
      return now
    },
  }
}

function fakeBus(): EventBus {
  const sinks = new Set<{ global?: (e: GlobalEvent) => void }>()
  return {
    attach: (s: { global?: (e: GlobalEvent) => void }) => {
      sinks.add(s)
      return () => sinks.delete(s)
    },
    global: (e: GlobalEvent) => {
      for (const s of sinks) s.global?.(e)
    },
  } as unknown as EventBus
}

const MIN = 60_000
const START = new Date(2026, 9, 25, 10, 0).getTime()

function world(limits: RunLimits | null) {
  const home = mkdtempSync(join(tmpdir(), 'dimf-limits-'))
  dirs.push(home)
  const clock = manualClock(START)
  const bus = fakeBus()
  const runs = new Map<string, RunSummary>()
  const stops: string[] = []
  const w = new RunLimitsWatcher({
    clock,
    log: silentLogger,
    bus,
    limitsOf: () => limits,
    summary: (id) => runs.get(id),
    stopRun: (id) => {
      stops.push(id)
      return Promise.resolve()
    },
    stopFile: (id) => join(home, id, 'limit-stop.json'),
  })
  watchers.push(w)
  w.start()
  const publish = (status: RunStatus, costUsd: number | null = 0): RunSummary => {
    const s: RunSummary = {
      runId: 'r1',
      displayNo: 1,
      folder: '/f',
      folderKey: 'k',
      title: 't',
      status,
      phase: 'planning',
      profile: 'claude-only',
      auto: false,
      isolation: 'inPlace',
      pinned: false,
      createdAt: START,
      progress: { tokens: 0, costUsd, filesChanged: 0 },
      findings: { must: 0, should: 0 },
      steps: [],
    }
    runs.set('r1', s)
    bus.global({ kind: 'run-summary', summary: s })
    return s
  }
  /** Lets the stop's file write and Stop resolve. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
  }
  return { home, clock, publish, stops, w, settle }
}

describe('run limits', () => {
  it('are off by default: no limit, nothing is ever stopped', async () => {
    expect(RunLimitsZ.parse(RUN_LIMITS_NONE)).toEqual({ maxCostUsd: null, maxMinutes: null })
    for (const limits of [null, { ...RUN_LIMITS_NONE }]) {
      const t = world(limits)
      t.publish('running', 500)
      t.clock.advance(10_000 * MIN)
      t.publish('running', 9_000)
      await t.settle()
      expect(t.stops).toEqual([])
      expect(await readLimitStop(join(t.home, 'r1', 'limit-stop.json'))).toBeUndefined()
    }
  })

  it('are a run-overrides key, like the composer sends', () => {
    expect(RunOverridesZ.safeParse({ limits: { maxCostUsd: 5, maxMinutes: 45 } }).success).toBe(true)
    expect(RunOverridesZ.safeParse({ limits: { maxCostUsd: 0 } }).success).toBe(false)
    expect(RunOverridesZ.safeParse({ limits: { maxMinutes: 1.5 } }).success).toBe(false)
  })

  it('a cost limit stops the run once its cost passes it, recorded first; a run waiting at a card too', async () => {
    const t = world({ maxCostUsd: 1, maxMinutes: null })
    t.publish('running', 0.4)
    t.publish('running', 1)
    await t.settle()
    expect(t.stops).toEqual([])
    t.clock.advance(3 * MIN)
    // The plan pass ended over the limit and its gate is open: the run waits, and is stopped all the same.
    t.publish('waiting', 1.2)
    await t.settle()
    await vi.waitFor(() => expect(t.stops).toEqual(['r1']))
    expect(await readLimitStop(join(t.home, 'r1', 'limit-stop.json'))).toEqual({
      kind: 'cost',
      limit: 1,
      costUsd: 1.2,
      // Three minutes of work before the gate opened.
      workedMs: 3 * MIN,
      at: START + 3 * MIN,
    })
    // Once: more summaries while it stops send no second Stop.
    t.publish('running', 1.3)
    await t.settle()
    expect(t.stops).toEqual(['r1'])
  })

  it('a time limit counts working time only: waiting for the user does not count', async () => {
    const t = world({ maxCostUsd: null, maxMinutes: 10 })
    t.publish('running')
    t.clock.advance(6 * MIN)
    // Six minutes of work, then twenty minutes waiting on a question.
    t.publish('waiting')
    t.clock.advance(20 * MIN)
    await t.settle()
    expect(t.stops).toEqual([])
    t.publish('running')
    t.clock.advance(3 * MIN)
    await t.settle()
    expect(t.stops).toEqual([])
    expect(t.w.workedMs({ runId: 'r1', createdAt: START } as RunSummary)).toBe(9 * MIN)
    // The timer fires at ten minutes of work.
    t.clock.advance(1 * MIN)
    await t.settle()
    await vi.waitFor(() => expect(t.stops).toEqual(['r1']))
    const stop = await readLimitStop(join(t.home, 'r1', 'limit-stop.json'))
    expect(stop).toMatchObject({ kind: 'time', limit: 10, workedMs: 10 * MIN })
  })

  it('queued and paused runs are idle too; an ended run is forgotten', async () => {
    const t = world({ maxCostUsd: null, maxMinutes: 5 })
    t.publish('queued')
    t.clock.advance(30 * MIN)
    t.publish('running')
    t.clock.advance(2 * MIN)
    t.publish('paused')
    t.clock.advance(30 * MIN)
    await t.settle()
    expect(t.stops).toEqual([])
    t.publish('completed')
    t.clock.advance(60 * MIN)
    await t.settle()
    expect(t.stops).toEqual([])
  })

  it('readLimitStop ignores a file it cannot read', async () => {
    const t = world(null)
    expect(await readLimitStop(join(t.home, 'missing.json'))).toBeUndefined()
  })
})
