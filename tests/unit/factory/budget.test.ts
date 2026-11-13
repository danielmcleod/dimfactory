// Budgets and stop rules (factory/budget.ts): the answer before a task starts, while its run works, and after it ends.
import { describe, expect, it } from 'vitest'
import { afterTask, beforeStart, duringRun, timeLimitAt, usd } from '@core/factory/budget.ts'

const NONE = {
  maxCostPerRunUsd: null,
  maxCostPerDayUsd: null,
  maxMinutesPerRun: null,
  stopAfterFailures: null,
}

describe('usd', () => {
  it('two decimals, and less than a cent in words', () => {
    expect(usd(1.5)).toBe('$1.50')
    expect(usd(0.004)).toBe('less than $0.01')
    expect(usd(0)).toBe('$0.00')
  })
})

describe('beforeStart', () => {
  it('no daily budget: always may start', () => {
    expect(beforeStart(NONE, { daySpentUsd: 1e6, estimateUsd: 5 })).toBeUndefined()
  })

  it('a spent budget pauses with what was spent and how to go on', () => {
    expect(beforeStart({ ...NONE, maxCostPerDayUsd: 10 }, { daySpentUsd: 10 })).toEqual({
      reason: 'day-budget',
      text: "Today's budget of $10.00 is spent ($10.00 so far). Raise the limit in Settings, Factory, or wait for tomorrow, then resume the queue.",
    })
  })

  it('an estimate that would pass the budget pauses; an unknown estimate does not', () => {
    const l = { ...NONE, maxCostPerDayUsd: 10 }
    expect(beforeStart(l, { daySpentUsd: 8, estimateUsd: 3 })?.text).toBe(
      'The next task is estimated at $3.00, which would take today past its budget of $10.00 ($8.00 spent). Raise the limit in Settings, Factory, or wait for tomorrow, then resume the queue.',
    )
    expect(beforeStart(l, { daySpentUsd: 8, estimateUsd: 2 })).toBeUndefined()
    expect(beforeStart(l, { daySpentUsd: 8, estimateUsd: null })).toBeUndefined()
  })
})

describe('duringRun', () => {
  const base = { runCostUsd: 1, daySpentUsd: 1, startedAt: 0, now: 0, displayNo: 7 }

  it('the cost per run stops the run (budget_exceeded)', () => {
    const hit = duringRun({ ...NONE, maxCostPerRunUsd: 0.5 }, base)
    expect(hit).toMatchObject({ reason: 'run-budget', category: 'budget_exceeded' })
    expect(hit?.text).toBe(
      'Run #7 cost $1.00, more than the limit of $0.50 per run, so Dim Factory stopped it. Raise the limit in Settings, Factory, or retry the task with a smaller scope, then resume the queue.',
    )
    // At the limit is not past it; an unpriced run is never stopped for its cost.
    expect(duringRun({ ...NONE, maxCostPerRunUsd: 1 }, base)).toBeUndefined()
    expect(duringRun({ ...NONE, maxCostPerRunUsd: 0.5 }, { ...base, runCostUsd: null })).toBeUndefined()
  })

  it("today's spending past the daily budget stops the run", () => {
    expect(duringRun({ ...NONE, maxCostPerDayUsd: 0.5 }, base)).toMatchObject({
      reason: 'day-budget',
      category: 'budget_exceeded',
    })
  })

  it('the time per run stops it (time_limit), at the limit exactly', () => {
    const l = { ...NONE, maxMinutesPerRun: 90 }
    expect(duringRun(l, { ...base, now: 90 * 60_000 - 1 })).toBeUndefined()
    const hit = duringRun(l, { ...base, now: 90 * 60_000 })
    expect(hit).toMatchObject({ reason: 'run-time', category: 'time_limit' })
    expect(hit?.text).toContain('ran longer than the limit of 1 h 30 min per run')
    expect(duringRun({ ...NONE, maxMinutesPerRun: 45 }, { ...base, now: 45 * 60_000 })?.text).toContain(
      '45 min',
    )
    expect(duringRun({ ...NONE, maxMinutesPerRun: 120 }, { ...base, now: 120 * 60_000 })?.text).toContain(
      '2 h per',
    )
  })

  it('the first limit reached wins: the run, then the day, then the time', () => {
    const all = { maxCostPerRunUsd: 0.5, maxCostPerDayUsd: 0.5, maxMinutesPerRun: 1, stopAfterFailures: null }
    expect(duringRun(all, { ...base, now: 60_000 })?.reason).toBe('run-budget')
    expect(duringRun({ ...all, maxCostPerRunUsd: null }, { ...base, now: 60_000 })?.reason).toBe('day-budget')
  })

  it('no limits: nothing stops', () => {
    expect(duringRun(NONE, { ...base, now: 1e12, runCostUsd: 1e6, daySpentUsd: 1e6 })).toBeUndefined()
  })
})

describe('timeLimitAt and afterTask', () => {
  it('timeLimitAt is the start plus the limit', () => {
    expect(timeLimitAt({ ...NONE, maxMinutesPerRun: 2 }, 1000)).toBe(121_000)
    expect(timeLimitAt(NONE, 1000)).toBeUndefined()
  })

  it('afterTask pauses at N failures in a row', () => {
    expect(afterTask(3, 2)).toBeUndefined()
    expect(afterTask(null, 50)).toBeUndefined()
    expect(afterTask(1, 1)).toEqual({
      reason: 'failures',
      text: 'A task failed, so the queue paused. Look at the failed run, then resume the queue (or retry the tasks).',
    })
    expect(afterTask(3, 3)?.text).toBe(
      '3 tasks in a row failed, so the queue paused. Look at the failed runs, then resume the queue (or retry the tasks).',
    )
  })

  it('no text has an em dash', () => {
    const texts = [
      beforeStart({ ...NONE, maxCostPerDayUsd: 1 }, { daySpentUsd: 2 })?.text,
      duringRun(
        { ...NONE, maxMinutesPerRun: 1 },
        { runCostUsd: 0, daySpentUsd: 0, startedAt: 0, now: 1e9, displayNo: 1 },
      )?.text,
      afterTask(2, 2)?.text,
    ]
    for (const t of texts) expect(t).not.toContain('\u2014')
  })
})
