// Dashboard chip ("Unfinalized worktrees are never auto-deleted. The Dashboard shows a chip
// 'Isolated: not applied'"; the Dashboard's active and recent run cards). Core says when it applies
// (RunSummary.worktree.notApplied); the chip shows it on the active card and the recent row, and nowhere else. Its
// tooltip says where the changes are and how to apply them; no em dash.
import '../helpers/rtl.ts'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/run.ts'
import {
  ISOLATED_NOT_APPLIED,
  ISOLATED_NOT_APPLIED_HINT,
  isolatedNotApplied,
} from '@renderer/components/run/isolation.ts'
import { ActiveRunCard } from '@renderer/pages/dashboard/ActiveRunCard.tsx'
import { RecentRuns } from '@renderer/pages/dashboard/RecentRuns.tsx'
import { upsertSummaries } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = '—'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({ handlers: { 'runs.get': () => ({}) as never } })
})

afterEach(() => tearDown(mock))

function summary(runId: string, over: Partial<RunSummary>): RunSummary {
  return makeSummary({ runId, isolation: 'worktree', ...over })
}

describe('Isolated: not applied', () => {
  it('shows on an active isolated run core says is not applied, with its hint', async () => {
    act(() =>
      upsertSummaries(
        [
          summary('r1', {
            status: 'waiting',
            phase: 'ready-to-apply',
            worktree: { state: 'pending', notApplied: true },
          }),
        ],
        { loaded: true },
      ),
    )
    render(
      <Providers>
        <ActiveRunCard runId="r1" />
      </Providers>,
    )
    await settle()
    const chip = screen.getByTestId('isolated-chip-r1')
    expect(chip.textContent).toBe(ISOLATED_NOT_APPLIED)
    expect(chip.getAttribute('title')).toBe(ISOLATED_NOT_APPLIED_HINT)
    expect(`${chip.textContent ?? ''} ${ISOLATED_NOT_APPLIED_HINT}`.includes(EM_DASH)).toBe(false)
  })

  it('shows on recent runs kept for later or stopped, not on applied, discarded or in-place runs', async () => {
    act(() =>
      upsertSummaries(
        [
          summary('kept', {
            status: 'completed',
            phase: 'done',
            outcome: 'clean',
            endedAt: 1_700_000_000_000,
            worktree: { state: 'kept', notApplied: true },
          }),
          summary('applied', {
            status: 'completed',
            phase: 'done',
            outcome: 'fixed',
            endedAt: 1_700_000_000_000,
            worktree: { state: 'applied', notApplied: false },
          }),
          summary('discarded', {
            status: 'completed',
            phase: 'done',
            outcome: 'clean',
            endedAt: 1_700_000_000_000,
            worktree: { state: 'discarded', notApplied: false },
          }),
          makeSummary({ runId: 'inplace', status: 'completed', phase: 'done', endedAt: 1_700_000_000_000 }),
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
    expect(screen.getByTestId('isolated-chip-kept').textContent).toBe(ISOLATED_NOT_APPLIED)
    expect(screen.queryByTestId('isolated-chip-applied')).toBeNull()
    expect(screen.queryByTestId('isolated-chip-discarded')).toBeNull()
    expect(screen.queryByTestId('isolated-chip-inplace')).toBeNull()
  })

  it('is core’s fact only: an isolated run without core’s worktree summary shows no chip', () => {
    expect(isolatedNotApplied({})).toBe(false)
    expect(isolatedNotApplied({ worktree: { state: 'working', notApplied: false } })).toBe(false)
    expect(isolatedNotApplied({ worktree: { state: 'kept', notApplied: true } })).toBe(true)
  })
})
