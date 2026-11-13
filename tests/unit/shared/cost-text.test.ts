// shared/cost-text.ts: the one set of words the app and the dev CLI use for a run total without a figure
// (UI copy standard: a word, never a dash), with "no figure yet" kept apart from "no price known".
import { describe, expect, it } from 'vitest'
import { NO_RUN_COST, noRunCost, runCostGap } from '../../../src/shared/cost-text.ts'
import { RUN_STATUSES } from '../../../src/shared/run.ts'
import type { RunSummary } from '../../../src/shared/run.ts'

const EM_DASH = String.fromCodePoint(0x2014)

const summary = (o: Partial<Pick<RunSummary, 'status' | 'steps' | 'progress'>>) => ({
  status: 'running' as const,
  steps: [],
  progress: { tokens: 0, costUsd: null, filesChanged: 0 },
  ...o,
})

describe('run cost words', () => {
  it('are words, not dashes, and say three different things', () => {
    expect(NO_RUN_COST).toEqual({
      pending: 'No cost yet',
      unreported: 'No cost reported',
      unpriced: 'No price',
    })
    for (const w of Object.values(NO_RUN_COST)) expect(w).not.toContain(EM_DASH)
  })

  it('no figure yet while the run goes on; none reported once it ended; no price once usage was reported', () => {
    for (const status of RUN_STATUSES) {
      const ended = status === 'completed' || status === 'failed' || status === 'cancelled'
      expect(noRunCost({ status, usageReported: false })).toBe(ended ? 'unreported' : 'pending')
      expect(noRunCost({ status, usageReported: true })).toBe('unpriced')
    }
  })

  it('reads a summary: a figure means no gap; tokens or any step usage count as reported', () => {
    expect(runCostGap(summary({ progress: { tokens: 10, costUsd: 0.2, filesChanged: 0 } }))).toBeNull()
    expect(runCostGap(summary({}))).toBe('pending')
    expect(runCostGap(summary({ status: 'completed' }))).toBe('unreported')
    expect(runCostGap(summary({ progress: { tokens: 10, costUsd: null, filesChanged: 0 } }))).toBe('unpriced')
    expect(
      runCostGap(
        summary({ steps: [{ key: 'plan', status: 'done', activeMs: 1, usage: { input: 0, output: 0 } }] }),
      ),
    ).toBe('unpriced')
  })
})
