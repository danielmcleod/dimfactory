// Isolated runs in the Run view's flow (Finalize; the Run view, Cards; UI standards: a
// card waiting on the user takes focus without scrolling). The Finalize step's card comes with core's finalize card
// after it (which takes focus); after the run, an isolated run's "After the run" says where its changes are and links
// to the Diff tab's Apply panel instead of Revert all (which is for runs that changed the folder itself).
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunEndPanel, isolatedChangesText } from '@renderer/components/run/RunEndPanel.tsx'
import { parseHash } from '@renderer/lib/router.ts'
import { FlowTab } from '@renderer/pages/run/FlowTab.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { RUN } from '../run/helpers.tsx'
import { finalizeCard, finalizeStep, isolatedSnap } from './fixtures.ts'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({ handlers: { 'cards.resolve': () => undefined } })
})

afterEach(() => tearDown(mock))

const ended = isolatedSnap({
  summary: {
    status: 'completed',
    phase: 'done',
    outcome: 'clean',
    endedAt: 1_700_000_900_000,
    progress: { tokens: 10, costUsd: null, filesChanged: 3 },
    worktree: { state: 'kept', notApplied: true },
  },
  prepare: { status: 'done', attempt: 1 },
  steps: { implement: { status: 'done', attempt: 1 } },
  finalize: finalizeStep({ state: 'kept', files: 3 }, { status: 'skipped', reason: 'kept' }),
})

describe('the Finalize step in the flow', () => {
  it('shows the step’s card, then core’s finalize card after it, which takes focus', async () => {
    const snap = isolatedSnap({
      summary: { status: 'waiting', phase: 'ready-to-apply' },
      prepare: { status: 'done', attempt: 1 },
      steps: { implement: { status: 'done', attempt: 1 } },
      finalize: finalizeStep({ state: 'pending', files: 3 }),
      extra: { cards: [finalizeCard()] },
    })
    render(
      <Providers>
        <FlowTab snap={snap} />
      </Providers>,
    )
    await settle()
    const step = screen.getByTestId('pass-card-finalize')
    const card = screen.getByTestId('card-finalize')
    expect(step.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('finalize-state').textContent).toBe('Waiting for your choice below.')
    expect(document.activeElement).toBe(card)
  })
})

describe('After the run, for an isolated run', () => {
  it('says the changes are in the isolated copy and links to Apply to folder… (no Revert all)', () => {
    render(
      <Providers>
        <RunEndPanel snap={ended} />
      </Providers>,
    )
    expect(screen.getByTestId('run-end-changes').textContent).toBe(
      "The run's changes (3 files) are in its isolated copy, not in your folder. Apply them from the Diff tab.",
    )
    const link = screen.getByTestId('run-end-apply')
    expect(link.textContent).toBe('Apply to folder…')
    expect(parseHash(link.getAttribute('href') ?? '')).toEqual({
      name: 'run',
      runId: RUN,
      tab: 'diff',
      query: {},
    })
    expect(screen.queryByTestId('revert-all')).toBeNull()
  })

  it('applied or discarded: says so, with no link', () => {
    const applied = isolatedSnap({
      summary: { ...ended.summary, worktree: { state: 'applied', notApplied: false } },
      finalize: finalizeStep({ state: 'applied', files: 3, applied: 3 }, { status: 'done' }),
    })
    expect(isolatedChangesText(applied)).toBe("The run's changes were applied to your folder.")
    const discarded = isolatedSnap({
      summary: { ...ended.summary, worktree: { state: 'discarded', notApplied: false } },
      finalize: finalizeStep({ state: 'discarded' }, { status: 'done' }),
    })
    expect(isolatedChangesText(discarded)).toBe('The isolated copy was discarded: your folder is unchanged.')
    render(
      <Providers>
        <RunEndPanel snap={applied} />
      </Providers>,
    )
    expect(screen.queryByTestId('run-end-apply')).toBeNull()
  })
})
