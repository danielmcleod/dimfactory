// An ended isolated run whose apply Dim Factory's close interrupted shows "Isolated: apply interrupted" (part of its
// changes may be in the folder), never "Isolated: not applied", on the Dashboard's recent runs; its hint says how to
// finish it. No em dash.
import '../helpers/rtl.ts'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/run.ts'
import {
  ISOLATED_APPLY_INTERRUPTED,
  ISOLATED_APPLY_INTERRUPTED_HINT,
  ISOLATED_NOT_APPLIED,
  isolatedChipOf,
} from '@renderer/components/run/isolation.ts'
import { RecentRuns } from '@renderer/pages/dashboard/RecentRuns.tsx'
import { upsertSummaries } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({ handlers: { 'runs.get': () => ({}) as never } })
})
afterEach(() => tearDown(mock))

const ended = (runId: string, worktree: RunSummary['worktree']): RunSummary =>
  makeSummary({
    runId,
    isolation: 'worktree',
    status: 'completed',
    phase: 'done',
    outcome: 'clean',
    endedAt: 1_700_000_000_000,
    ...(worktree !== undefined ? { worktree } : {}),
  })

describe('Isolated: apply interrupted', () => {
  it('reads "apply interrupted" with how to finish it; a kept run still reads "not applied"', async () => {
    act(() =>
      upsertSummaries(
        [
          ended('cut', { state: 'interrupted', notApplied: false }),
          ended('kept', { state: 'kept', notApplied: true }),
        ],
        { loaded: true },
      ),
    )
    render(
      <Providers>
        <RecentRuns />
      </Providers>,
    )
    await settle()
    const cut = screen.getByTestId('isolated-chip-cut')
    expect(cut.textContent).toBe(ISOLATED_APPLY_INTERRUPTED)
    expect(cut.getAttribute('title')).toBe(ISOLATED_APPLY_INTERRUPTED_HINT)
    expect(ISOLATED_APPLY_INTERRUPTED_HINT).toContain('Finish apply')
    expect(`${ISOLATED_APPLY_INTERRUPTED} ${ISOLATED_APPLY_INTERRUPTED_HINT}`).not.toContain('—')
    expect(screen.getByTestId('isolated-chip-kept').textContent).toBe(ISOLATED_NOT_APPLIED)
  })

  it('an older core that still says "not applied" for an interrupted apply gets the interrupted chip', () => {
    expect(isolatedChipOf({ worktree: { state: 'interrupted', notApplied: true } })?.text).toBe(
      ISOLATED_APPLY_INTERRUPTED,
    )
    expect(isolatedChipOf({ worktree: { state: 'applied', notApplied: false } })).toBeNull()
    expect(isolatedChipOf({})).toBeNull()
  })
})
