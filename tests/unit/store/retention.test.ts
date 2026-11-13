import { describe, expect, it } from 'vitest'
import type { RunStatus, RunSummary } from '../../../src/shared/run.ts'
import { DEFAULT_RETENTION, planRetention, retentionPolicyOf } from '../../../src/core/store/retention.ts'

const DAY = 86_400_000
const NOW = 100 * DAY

function s(n: number, status: RunStatus, ageDays: number, pinned = false): RunSummary {
  return {
    runId: `r${n}`,
    displayNo: n,
    folder: '/f',
    folderKey: 'k',
    title: '',
    status,
    phase: 'done',
    profile: 'p',
    auto: false,
    isolation: 'inPlace',
    pinned,
    createdAt: NOW - ageDays * DAY,
    progress: { tokens: 0, costUsd: null, filesChanged: 0 },
    findings: { must: 0, should: 0 },
    steps: [],
  }
}

describe('planRetention', () => {
  it('defaults to keepRuns 300, keepDays 60, rawLogDays 14', () => {
    expect(DEFAULT_RETENTION).toEqual({ keepRuns: 300, keepDays: 60, rawLogDays: 14 })
  })

  it('removes old terminal or lock-free failed runs beyond keepRuns, never pinned/active/locked ones', () => {
    const runs = [
      s(1, 'completed', 90),
      s(2, 'cancelled', 80),
      s(3, 'failed', 75),
      s(4, 'failed', 74),
      s(5, 'paused', 70),
      s(6, 'completed', 70, true),
      s(7, 'completed', 65),
      s(8, 'completed', 10),
      s(9, 'completed', 1),
    ]
    const plan = planRetention(
      runs,
      { keepRuns: 2, keepDays: 60, rawLogDays: 14 },
      {
        now: NOW,
        lockHeld: new Set(['r4']),
      },
    )
    expect(plan.remove).toEqual(['r1', 'r2', 'r3', 'r7'])
    expect(plan.keep.sort()).toEqual(['r4', 'r5', 'r6', 'r8', 'r9'])
  })

  it('keeps the newest keepRuns even when they are old', () => {
    const plan = planRetention([s(1, 'completed', 500), s(2, 'completed', 400)], DEFAULT_RETENTION, {
      now: NOW,
    })
    expect(plan.remove).toEqual([])
  })
})

// Retention's execution is tested with history.ts (tests/unit/history); the placeholder that answered UNSUPPORTED
// is gone. What stays here is the policy the execution reads.
describe('retention policy', () => {
  it('comes from storage in the user config, missing keys from the defaults', () => {
    expect(retentionPolicyOf(undefined)).toEqual(DEFAULT_RETENTION)
    expect(retentionPolicyOf({ keepDays: 7 })).toEqual({ keepRuns: 300, keepDays: 7, rawLogDays: 14 })
  })
})
