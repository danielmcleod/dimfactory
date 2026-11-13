// Budgets and stop rules, pure. The queue service asks these before it starts a task, while a task's run works, and
// after it ends; each answer that stops something says why in words the user reads (no em dashes, always the next
// step). A null limit is no limit. Costs are what the runs recorded: a pass's cost is known once it ends, so a
// running run's figure grows pass by pass.
import type { FactorySettings } from '../../shared/config-schema.ts'
import type { QueuePauseReason, QueueStopCategory } from '../../shared/factory.ts'

export interface LimitHit {
  reason: QueuePauseReason
  text: string
  /** The failure category a run stopped for this gets (absent: the run is not stopped). */
  category?: QueueStopCategory
}

type Limits = Pick<
  FactorySettings,
  'maxCostPerRunUsd' | 'maxCostPerDayUsd' | 'maxMinutesPerRun' | 'stopAfterFailures'
>

export function usd(v: number): string {
  return v > 0 && v < 0.01 ? 'less than $0.01' : `$${v.toFixed(2)}`
}

function minutesText(m: number): string {
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

const RAISE = 'Raise the limit in Settings, Factory, or wait for tomorrow, then resume the queue.'

/**
 * Before a task starts: the daily budget is spent, or the task's estimate (p50, when known) would take today past it.
 * Undefined: it may start.
 */
export function beforeStart(
  limits: Limits,
  o: { daySpentUsd: number; estimateUsd?: number | null },
): LimitHit | undefined {
  const cap = limits.maxCostPerDayUsd
  if (cap === null) return undefined
  if (o.daySpentUsd >= cap) {
    return {
      reason: 'day-budget',
      text: `Today's budget of ${usd(cap)} is spent (${usd(o.daySpentUsd)} so far). ${RAISE}`,
    }
  }
  const est = o.estimateUsd
  if (est !== undefined && est !== null && o.daySpentUsd + est > cap) {
    return {
      reason: 'day-budget',
      text: `The next task is estimated at ${usd(est)}, which would take today past its budget of ${usd(cap)} (${usd(o.daySpentUsd)} spent). ${RAISE}`,
    }
  }
  return undefined
}

/**
 * While a queued run works: its own cost, today's spending and its working time against the limits. The first limit
 * reached, or undefined. A hit stops the run (its category says why) and pauses the queue.
 */
export function duringRun(
  limits: Limits,
  o: { runCostUsd: number | null; daySpentUsd: number; startedAt: number; now: number; displayNo: number },
): LimitHit | undefined {
  const run = `Run #${o.displayNo}`
  const perRun = limits.maxCostPerRunUsd
  if (perRun !== null && o.runCostUsd !== null && o.runCostUsd > perRun) {
    return {
      reason: 'run-budget',
      category: 'budget_exceeded',
      text: `${run} cost ${usd(o.runCostUsd)}, more than the limit of ${usd(perRun)} per run, so Dim Factory stopped it. Raise the limit in Settings, Factory, or retry the task with a smaller scope, then resume the queue.`,
    }
  }
  const perDay = limits.maxCostPerDayUsd
  if (perDay !== null && o.daySpentUsd > perDay) {
    return {
      reason: 'day-budget',
      category: 'budget_exceeded',
      text: `Today's spending reached ${usd(o.daySpentUsd)}, more than the daily budget of ${usd(perDay)}, so Dim Factory stopped ${run}. ${RAISE}`,
    }
  }
  const minutes = limits.maxMinutesPerRun
  if (minutes !== null && o.now - o.startedAt >= minutes * 60_000) {
    return {
      reason: 'run-time',
      category: 'time_limit',
      text: `${run} ran longer than the limit of ${minutesText(minutes)} per run, so Dim Factory stopped it. Raise the limit in Settings, Factory, or split the task, then resume the queue.`,
    }
  }
  return undefined
}

/** When the time limit stops a run that started at `startedAt` (undefined: no time limit). */
export function timeLimitAt(limits: Limits, startedAt: number): number | undefined {
  return limits.maxMinutesPerRun === null ? undefined : startedAt + limits.maxMinutesPerRun * 60_000
}

/** After a task ends: too many failures in a row pause the queue (`stopAfterFailures` null: never). */
export function afterTask(
  stopAfterFailures: number | null,
  consecutiveFailures: number,
): LimitHit | undefined {
  const n = stopAfterFailures
  if (n === null || consecutiveFailures < n) return undefined
  return {
    reason: 'failures',
    text: `${consecutiveFailures === 1 ? 'A task' : `${consecutiveFailures} tasks in a row`} failed, so the queue paused. Look at the failed ${consecutiveFailures === 1 ? 'run' : 'runs'}, then resume the queue (or retry the tasks).`,
  }
}
