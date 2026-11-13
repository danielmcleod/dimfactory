// The estimates aggregate's boot build (src/core/estimates/aggregate.ts): app-core
// builds it from runs/index.jsonl, which lists runs newest first, on Electron's main process. Any order gives the
// same windows, and a newest-first build of thousands of runs stays well under a second (it was quadratic: about
// 11 s for 10 000 runs on the dev machine).
import { describe, expect, it } from 'vitest'
import { EstimateAggregate, sampleKey } from '@core/estimates/aggregate.ts'
import type { RunSummary } from '@shared/run.ts'
import { claude, run, usage } from './helpers.ts'

const S = 1000

/** n finished runs, oldest first, each with five sampled pass rows. */
function history(n: number): RunSummary[] {
  return Array.from({ length: n }, (_, i) =>
    run(
      [
        claude('plan', (10 + (i % 7)) * S, 'opus', 'readonly', { usage: usage(1000, 100) }),
        claude('implement', (60 + (i % 11)) * S, null, 'autoedit', { usage: usage(5000, 900) }),
        claude('review', (20 + (i % 5)) * S, 'sonnet', 'readonly'),
        claude('critic', (25 + (i % 3)) * S, 'opus', 'readonly'),
        claude('fix', (30 + (i % 4)) * S, null, 'autoedit', i % 2 === 0 ? {} : { status: 'skipped' }),
      ],
      { folderKey: i % 3 === 0 ? 'folder-a' : 'folder-b' },
    ),
  )
}

const KEYS = [
  sampleKey.step('plan'),
  sampleKey.step('implement'),
  sampleKey.model('claude', 'opus', 'critic'),
  sampleKey.exactAnyBucket('claude', null, 'autoedit', 'implement'),
  sampleKey.vendor('claude', 'fix'),
]

const windows = (a: EstimateAggregate): unknown[] => KEYS.map((k) => a.window(k).map((x) => x.runId))

describe('EstimateAggregate boot build', () => {
  it('newest first (the index order), oldest first and one by one give the same windows and P(fix)', () => {
    const runs = history(300)
    const oldest = EstimateAggregate.from(runs)
    const newest = EstimateAggregate.from([...runs].reverse())
    const shuffled = new EstimateAggregate()
    for (const [i, s] of runs.entries()) if (i % 2 === 1) shuffled.put(s)
    for (const [i, s] of [...runs].reverse().entries()) if (i % 2 === 1) shuffled.put(s)
    expect(windows(newest)).toEqual(windows(oldest))
    expect(windows(shuffled)).toEqual(windows(oldest))
    expect(newest.pFix('folder-a')).toEqual(oldest.pFix('folder-a'))
    expect(newest.pFix(null)).toEqual(oldest.pFix(null))
    expect(newest.runs).toBe(300)
    // The window is the newest 50, oldest first.
    expect(newest.window(sampleKey.step('plan')).map((x) => x.runId)).toEqual(
      runs.slice(-50).map((s) => s.runId),
    )
  })

  it('putAll adds a newest-first index of 10 000 runs in well under a second', () => {
    const runs = history(10_000).reverse()
    const a = new EstimateAggregate()
    const t = performance.now()
    a.putAll(runs)
    const ms = performance.now() - t
    expect(a.runs).toBe(10_000)
    // Generous for a slow machine: the quadratic build took ~11 s here.
    expect(ms).toBeLessThan(2000)
  })

  it('a run inserted out of order lands in its place; re-putting a run replaces its samples', () => {
    const runs = history(40)
    const a = EstimateAggregate.from([...runs.slice(0, 10), ...runs.slice(11)])
    a.put(runs[10] as RunSummary)
    a.put(runs[0] as RunSummary)
    expect(a.window(sampleKey.step('plan')).map((x) => x.runId)).toEqual(runs.map((s) => s.runId))
    const last = runs.at(-1) as RunSummary
    a.put({ ...last, status: 'failed' })
    expect(a.window(sampleKey.step('plan')).map((x) => x.runId)).not.toContain(last.runId)
    a.put(last)
    expect(a.window(sampleKey.step('plan')).at(-1)?.runId).toBe(last.runId)
  })
})
