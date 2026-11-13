// Retention planning, raw logs and the schedule (storage {keepRuns, keepDays, rawLogDays}, boot
// "background probes and retention": 2 minutes after boot when idle, then every 24 hours).
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import type { Logger } from '../../../src/core/log.ts'
import {
  DEFAULT_RETENTION,
  RETENTION_BOOT_DELAY_MS,
  RETENTION_GC_RETRY_MS,
  RETENTION_INTERVAL_MS,
  RETENTION_RETRY_MS,
  RetentionScheduler,
  planRetention,
  pruneRawLogs,
  retentionPolicyOf,
} from '../../../src/core/store/retention.ts'
import { DAY, ManualTimers, rawLog, summary } from './helpers.ts'

const NOW = 400 * DAY
const paths = (): ReturnType<typeof homePaths> => homePaths(process.env['DIM_FACTORY_HOME'] ?? '')

describe('planRetention', () => {
  it('names why a run past both rules stays: pinned, not finished, or holding its folder', () => {
    const old = (n: number, over: Parameters<typeof summary>[1] = {}) =>
      summary(n, { createdAt: NOW - (200 - n) * DAY, ...over })
    const plan = planRetention(
      [
        old(1, { pinned: true }),
        old(2, { status: 'paused' }),
        old(3, { status: 'failed' }),
        old(4, { status: 'completed' }),
        old(5),
        old(6),
      ],
      { keepRuns: 1, keepDays: 30, rawLogDays: 14 },
      { now: NOW, lockHeld: new Set(['run-3', 'run-4']) },
    )
    expect(plan.remove).toEqual(['run-5'])
    expect(plan.keep).toEqual(['run-6', 'run-4', 'run-3', 'run-2', 'run-1'])
    expect(plan.exempt).toEqual([
      { runId: 'run-1', reason: 'pinned' },
      { runId: 'run-2', reason: 'active' },
      { runId: 'run-3', reason: 'lock' },
      { runId: 'run-4', reason: 'lock' },
    ])
  })

  it('reads the policy from the config, missing keys from the defaults', () => {
    expect(retentionPolicyOf(undefined)).toEqual(DEFAULT_RETENTION)
    expect(retentionPolicyOf({ keepRuns: 5, rawLogDays: 0 })).toEqual({
      keepRuns: 5,
      keepDays: 60,
      rawLogDays: 0,
    })
  })
})

describe('pruneRawLogs (rawLogDays, even for kept runs)', () => {
  it('deletes raw logs written before the cutoff, and only those; a dry run counts them', async () => {
    const p = paths()
    const oldA = rawLog(p, 'run-1', 'implement-1.ndjson', 20 * DAY, 100)
    const oldB = rawLog(p, 'run-2', 'plan-1.ndjson', 15 * DAY, 50)
    const fresh = rawLog(p, 'run-2', 'fix-1.ndjson', 1 * DAY, 7)
    const other = rawLog(p, 'run-3', 'plan-1.ndjson', 30 * DAY, 9)
    const cutoff = Date.now() - 14 * DAY
    const dry = await pruneRawLogs(p, ['run-1', 'run-2', 'missing'], cutoff, { dryRun: true })
    expect(dry).toEqual({ files: 2, bytes: 150 })
    expect([oldA, oldB, fresh, other].every((f) => existsSync(f))).toBe(true)
    const real = await pruneRawLogs(p, ['run-1', 'run-2'], cutoff)
    expect(real).toEqual({ files: 2, bytes: 150 })
    expect(existsSync(oldA)).toBe(false)
    expect(existsSync(oldB)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    // A run not listed (live, or holding its folder) keeps its logs.
    expect(existsSync(other)).toBe(true)
  })
})

describe('RetentionScheduler', () => {
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

  it('runs 2 minutes after boot when idle, then daily; waits while runs work', async () => {
    const timers = new ManualTimers()
    let idle = false
    const calls: string[] = []
    const s = new RetentionScheduler({
      run: () => {
        calls.push('run')
        return Promise.resolve({ gcPending: false })
      },
      gc: () => {
        calls.push('gc')
        return Promise.resolve({ gcPending: false })
      },
      idle: () => idle,
      timers,
    })
    s.start()
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([RETENTION_BOOT_DELAY_MS])
    expect(timers.fireAll()).toEqual([RETENTION_BOOT_DELAY_MS])
    await s.settled()
    // Not idle: nothing ran, it looks again in 5 minutes.
    expect(calls).toEqual([])
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([RETENTION_RETRY_MS])
    idle = true
    timers.fireAll()
    await s.settled()
    await flush()
    expect(calls).toEqual(['run'])
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([RETENTION_INTERVAL_MS])
    s.stop()
    expect(timers.pending.size).toBe(0)
  })

  it('tries a gc that had to wait again every 10 minutes', async () => {
    const timers = new ManualTimers()
    let pending = true
    const calls: string[] = []
    const s = new RetentionScheduler({
      run: () => {
        calls.push('run')
        return Promise.resolve({ gcPending: true })
      },
      gc: () => {
        calls.push('gc')
        return Promise.resolve({ gcPending: pending })
      },
      idle: () => true,
      timers,
    })
    s.start()
    timers.fireAll()
    await s.settled()
    await flush()
    expect(calls).toEqual(['run'])
    expect([...timers.pending.values()].map((t) => t.ms).sort((a, b) => a - b)).toEqual([
      RETENTION_GC_RETRY_MS,
      RETENTION_INTERVAL_MS,
    ])
    // Fire only the gc retry.
    const [gcId] = [...timers.pending].find(([, t]) => t.ms === RETENTION_GC_RETRY_MS) ?? []
    const gcTimer = timers.pending.get(gcId as number)
    timers.pending.delete(gcId as number)
    pending = false
    gcTimer?.fn()
    await s.settled()
    await flush()
    expect(calls).toEqual(['run', 'gc'])
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([RETENTION_INTERVAL_MS])
    s.stop()
  })

  it('a failing pass is logged and the next one is still scheduled', async () => {
    const timers = new ManualTimers()
    const errors: string[] = []
    const log: Logger = {
      error: (msg) => {
        errors.push(msg)
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      child: () => log,
      flush: () => Promise.resolve(),
    }
    const s = new RetentionScheduler({
      run: () => Promise.reject(new Error('disk')),
      gc: () => Promise.resolve({ gcPending: false }),
      idle: () => true,
      timers,
      log,
    })
    s.start()
    timers.fireAll()
    await s.settled()
    await flush()
    expect(errors).toEqual(['retention full pass failed'])
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([RETENTION_INTERVAL_MS])
    s.stop()
  })
})
