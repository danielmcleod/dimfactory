// Hardening follow-up ("an ended run whose apply was
// interrupted reads 'not applied' though part may be written"): RunSummary.worktree
// never says "not applied" while an apply Dim Factory's close interrupted waits for [Finish apply]; its state says
// `interrupted` (the renderer's chip "Isolated: apply interrupted").
import { describe, expect, it } from 'vitest'
import { worktreeSummary } from '@core/supervisor/isolation-view.ts'
import type { FinalizeRunState, RunState } from '@core/supervisor/types.ts'

function isolatedRun(finalize: Partial<FinalizeRunState>): RunState {
  return {
    config: { isolation: 'worktree' },
    outcome: 'clean',
    flow: { prepared: 'all' },
    isolation: {
      rows: [],
      worktree: { path: 'C:\\home\\worktrees\\r1', branch: 'dim/r1', base: 'abc' },
      finalize: { state: 'pending', files: 3, lease: 'none', applies: [], applyNo: 0, ...finalize },
    },
  } as unknown as RunState
}

describe('RunSummary.worktree for an interrupted apply', () => {
  it('is not "not applied" while the interrupted apply waits; the same run before it was is', () => {
    expect(worktreeSummary(isolatedRun({ state: 'kept' }))).toEqual({ state: 'kept', notApplied: true })
    expect(worktreeSummary(isolatedRun({ state: 'interrupted', resume: { paths: ['a.ts'] } }))).toEqual({
      state: 'interrupted',
      notApplied: false,
    })
  })
})
