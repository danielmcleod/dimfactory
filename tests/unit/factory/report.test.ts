// The daily report (factory/report.ts): the day's runs, outcomes, spending, failures, pauses and fallbacks.
import { describe, expect, it } from 'vitest'
import { buildReport, reportMarkdown, runsOfDay, spendOf } from '@core/factory/report.ts'
import type { DayLedger } from '@core/factory/store.ts'
import type { RunSummary } from '@shared/run.ts'

const day = (h: number, d = 24): number => new Date(2026, 9, d, h, 5).getTime()

function run(n: number, o: Partial<RunSummary>): RunSummary {
  return {
    runId: `r${n}`,
    displayNo: n,
    folder: '/work/shop',
    folderKey: 'k',
    title: `task ${n}`,
    status: 'completed',
    phase: 'done',
    profile: 'balanced',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt: day(9),
    progress: { tokens: 0, costUsd: 0.5, filesChanged: 0 },
    findings: { must: 0, should: 0 },
    steps: [],
    ...o,
  }
}

const runs: RunSummary[] = [
  run(1, { outcome: 'fixed', createdAt: day(10), endedAt: day(11) }),
  run(2, { outcome: 'verify-failed', createdAt: day(9), title: 'pipes | in title' }),
  run(3, { status: 'failed', failure: { step: 'implement', category: 'rate_limited' }, createdAt: day(12) }),
  run(4, {
    status: 'cancelled',
    createdAt: day(13),
    progress: { tokens: 0, costUsd: null, filesChanged: 0 },
  }),
  run(5, { status: 'running', createdAt: day(14), progress: { tokens: 0, costUsd: 0.25, filesChanged: 0 } }),
  // Another day.
  run(6, { outcome: 'clean', createdAt: day(10, 23) }),
]

const ledger: DayLedger = {
  date: '2026-10-24',
  queueRuns: ['r1', 'r2'],
  pauses: [{ at: day(15), folder: '/work/shop', text: '2 tasks in a row failed, so the queue paused.' }],
  fallbacks: [
    {
      at: day(12),
      runId: 'r3',
      displayNo: 3,
      step: 'Implement',
      from: 'Claude',
      to: 'Codex',
      why: 'Claude hit a rate limit',
    },
  ],
}

describe('the day', () => {
  it('runsOfDay keeps the local day, oldest first; spendOf adds the priced ones', () => {
    const d = runsOfDay(runs, '2026-10-24')
    expect(d.map((r) => r.runId)).toEqual(['r2', 'r1', 'r3', 'r4', 'r5'])
    expect(spendOf(d)).toEqual({ usd: 1.75, unpriced: 1 })
  })
})

describe('buildReport', () => {
  const v = buildReport({ date: '2026-10-24', summaries: runs, ledger, file: '/home/reports/2026-10-24.md' })

  it("lists the day's runs with the queue flag, outcomes, failures and the ledger", () => {
    expect(v.runs.map((r) => [r.displayNo, r.queued, r.failure])).toEqual([
      [2, true, 'Completed with failures: a check still fails.'],
      [1, true, undefined],
      [3, false, 'Failed at Implement: The vendor rate limit hit'],
      [4, false, 'Stopped'],
      [5, false, undefined],
    ])
    expect(v.outcomes).toEqual({ done: 1, failed: 2, stopped: 1, working: 1 })
    expect(v.spentUsd).toBe(1.75)
    expect(v.unpriced).toBe(1)
    expect(v.pauses).toEqual(ledger.pauses)
    expect(v.fallbacks).toEqual(ledger.fallbacks)
    expect(v.file).toBe('/home/reports/2026-10-24.md')
  })

  it('renders markdown with every section, pipes escaped and no em dash', () => {
    const md = v.markdown
    expect(md.startsWith('# Dim Factory daily report: 2026-10-24\n')).toBe(true)
    expect(md).toContain('5 runs (2 from a queue). Done 1, failed 2, stopped 1, still working 1.')
    expect(md).toContain('Spent $1.75 (1 run has no price).')
    expect(md).toContain('| #2 | 09:05 | shop | pipes \\| in title | Failed (verify-failed) | $0.50 | yes |')
    expect(md).toContain('| #1 | 10:05 | shop | task 1 | Done (fixed) | $0.50 | yes |')
    expect(md).toContain('| #4 | 13:05 | shop | task 4 | Stopped | No price | no |')
    expect(md).toContain('| #5 | 14:05 | shop | task 5 | Running | $0.25 | no |')
    expect(md).toContain(
      '## Failures\n\n- Run #2 (pipes \\| in title): Completed with failures: a check still fails.',
    )
    expect(md).toContain('## Queue pauses\n\n- 15:05 shop: 2 tasks in a row failed, so the queue paused.')
    expect(md).toContain(
      '## Vendor fallbacks\n\n- 12:05 Run #3, Implement: Claude to Codex (Claude hit a rate limit)',
    )
    expect(md).not.toContain('\u2014')
  })

  it('an empty day says None in each section', () => {
    const md = reportMarkdown({
      date: '2026-10-25',
      runs: [],
      spentUsd: 0,
      unpriced: 0,
      outcomes: { done: 0, failed: 0, stopped: 0, working: 0 },
      pauses: [],
      fallbacks: [],
      file: 'f',
    })
    expect(md).toContain('No runs (0 from a queue).')
    expect(md.match(/^None\.$/gm)).toHaveLength(4)
  })
})
