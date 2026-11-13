// Git cards (Cards: reconcile "Paths + core-built choices", planMutated "[Revert Plan's changes]
// [Keep]", retryPartial "[Revert partial then fresh] [Keep changes, fresh] [Cancel]"; the reconciliation table):
// core's reasons in plain words with their copyable commands, the external and overlapping paths (the first few, then
// "and N more", the full list in a disclosure), core's choices with the default as the primary button, Recheck, and
// cards.resolve carrying core's choice ids as they are, with no input.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CardView as CardData } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { PATHS_SHOWN } from '@renderer/components/cards/PathList.tsx'
import { choicesWithDefault, planChangedPaths, reconcileOf } from '@renderer/components/cards/payload.ts'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, settle, snapWith, stubClipboard } from '../run/helpers.tsx'
import { blockCard, mergeAbortAction, overlapCard, planMutatedCard, retryPartialCard } from './fixtures.ts'

let mock: MockDimFactory
const FOLDER = 'C:\\work\\repo'

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  clearToasts()
  resetRecoveryForTests()
  resetLaterChoicesForTests()
  setMacForTests(false)
  mock = installMockDimFactory({
    handlers: {
      'cards.resolve': () => undefined,
      'runs.get': () => snapWith(),
    },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  setMacForTests(null)
  resetBridgeForTests()
})

function show(card: CardData): void {
  renderUi(<CardView runId={RUN} card={card} folder={FOLDER} />)
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

const choice = (id: string): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>(`card-choice-${id}`)
const isPrimary = (el: HTMLElement): boolean => el.className.split(/\s+/).includes('bg-primary')
const toastMessages = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

describe('reconcile card: external edits overlapping the run (choice)', () => {
  it("lists the reasons, the overlapping files and the other external files, and core's choices", () => {
    show(overlapCard())
    const card = screen.getByTestId('card-reconcile')
    expect(within(card).getByRole('heading').textContent).toBe(
      '2 files the run changed were edited outside it',
    )
    const reason = screen.getByTestId('reconcile-reason-external-overlap')
    expect(reason.getAttribute('data-severity')).toBe('choice')
    expect(reason.textContent).toContain('Needs your choice: ')
    expect(reason.textContent).toContain("Include your edits, or restore the run's version")
    const overlap = screen.getByTestId('reconcile-overlapping')
    expect(overlap.textContent).toContain('Changed by the run and edited outside it (2 files)')
    expect(
      within(overlap)
        .getAllByTestId('reconcile-overlapping-path')
        .map((p) => p.textContent),
    ).toEqual(['src/cli.ts', 'src/version.ts'])
    // The other external files: the overlapping ones are not listed twice.
    const external = screen.getByTestId('reconcile-external')
    expect(external.textContent).toContain('Edited outside the run (1 file)')
    expect(
      within(external)
        .getAllByTestId('reconcile-external-path')
        .map((p) => p.textContent),
    ).toEqual(['README.md'])
    expect(card.querySelectorAll('button[data-testid^="card-choice-"]')).toHaveLength(3)
    expect(choice('include-my-edits').textContent).toBe('Include my edits')
    expect(choice('restore-run-version').textContent).toBe("Restore run's version")
    expect(choice('stop').textContent).toBe('Stop run')
    expect(choice('stop').className).toContain('text-destructive')
    // Core's body leads with where it checked; its list of reasons is not repeated (they are shown above).
    expect(screen.getByTestId('reconcile-lead').textContent).toBe(
      'Dim Factory checked the folder before Review.',
    )
    expect(card.textContent?.match(/were edited outside it/g)).toHaveLength(2)
  })

  it('makes the default the one primary button (Auto takes it)', () => {
    // Core flags Restore as primary here; the default is Include my edits, so that is the primary.
    show(
      overlapCard({
        choices: [
          { id: 'include-my-edits', label: 'Include my edits' },
          { id: 'restore-run-version', label: "Restore run's version", primary: true },
          { id: 'stop', label: 'Stop' },
        ],
      }),
    )
    expect(isPrimary(choice('include-my-edits'))).toBe(true)
    expect(isPrimary(choice('restore-run-version'))).toBe(false)
    expect(isPrimary(choice('stop'))).toBe(false)
  })

  it.each(['include-my-edits', 'restore-run-version', 'stop'])(
    'sends %s to cards.resolve as core named it, with no input',
    async (id) => {
      show(overlapCard())
      await click(choice(id))
      expect(mock.callsOf('cards.resolve')).toEqual([{ runId: RUN, cardId: 'reconcile-3', choiceId: id }])
      expect(Object.keys(mock.callsOf('cards.resolve')[0] ?? {})).not.toContain('input')
    },
  )

  it('keeps every choice in place while one is being sent, and shows core error as a toast', async () => {
    mock.on('cards.resolve', () => {
      throw mockError('NOT_FOUND', 'This card is no longer open.')
    })
    show(overlapCard())
    await click(choice('restore-run-version'))
    expect(toastMessages()).toContain('This card is no longer open.')
    expect(choice('include-my-edits').disabled).toBe(false)
  })

  it('offers [Continue on <branch>] first when the folder switched branch (branch: none)', async () => {
    show({
      id: 'reconcile-4',
      kind: 'reconcile',
      title: 'The folder switched to feature',
      body: 'The run started on main.',
      payload: {
        verdict: 'choice',
        reasons: [
          {
            row: 'ref-switched',
            severity: 'choice',
            title: 'The folder switched to feature',
            detail: 'The run started on main. Diffs compare snapshots, so the run can continue on feature.',
            commands: [],
          },
        ],
        paths: { external: [], overlapping: [] },
        branch: 'feature',
      },
      blocking: true,
      defaultChoice: 'continue-on-branch',
      choices: [
        { id: 'continue-on-branch', label: 'Continue on feature', primary: true },
        { id: 'stop', label: 'Stop' },
        { id: 'recheck', label: 'Recheck' },
      ],
    })
    expect(isPrimary(choice('continue-on-branch'))).toBe(true)
    expect(choice('continue-on-branch').textContent).toBe('Continue on feature')
    expect(screen.queryByTestId('reconcile-external')).toBeNull()
    await click(choice('continue-on-branch'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'reconcile-4', choiceId: 'continue-on-branch' },
    ])
  })
})

describe('reconcile card: a block (merge in progress)', () => {
  it('shows the copyable abort command (text) with Copy, and Recheck as the primary', async () => {
    const clip = stubClipboard()
    show(blockCard())
    const reason = screen.getByTestId('reconcile-reason-operation')
    expect(reason.getAttribute('data-severity')).toBe('block')
    expect(reason.textContent).toContain('Blocks the run: A git merge is in progress')
    expect(within(reason).getByTestId('reconcile-commands-0-command').textContent).toBe('git merge --abort')
    // No default: the block waits for the user, even in Auto; core's own primary stays.
    expect(isPrimary(choice('recheck'))).toBe(true)
    expect(isPrimary(choice('stop'))).toBe(false)
    const copy = within(reason).getByRole('button', { name: 'Copy: git merge --abort' })
    await click(copy)
    expect(clip.writes).toEqual(['git merge --abort'])
    expect(toastMessages()).toContain('Command copied to the clipboard')
    await click(choice('recheck'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'reconcile-5', choiceId: 'recheck' },
    ])
  })

  it('runs an abort command core sent as an action through recovery.execute, then Re-check takes Recheck', async () => {
    mock.on('recovery.execute', () => ({ kind: 'shell_copy', copied: 'git merge --abort' }))
    show(blockCard({ action: true }))
    const reason = screen.getByTestId('reconcile-reason-operation')
    // The command is shown once: as the action's line, not again as text.
    expect(within(reason).queryByTestId('reconcile-commands-0')).toBeNull()
    expect(within(reason).getAllByText('git merge --abort')).toHaveLength(1)
    await click(screen.getByTestId(`recovery-${mergeAbortAction.id}`))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: mergeAbortAction.id, runId: RUN }])
    expect(toastMessages()).toContain('Copied. Run it in a terminal.')
    await click(screen.getByTestId(`recheck-${mergeAbortAction.id}`))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'reconcile-5', choiceId: 'recheck' },
    ])
  })

  it("says core's body when the payload has no reasons", () => {
    show({ ...blockCard(), payload: {} })
    expect(screen.queryByTestId('reconcile-reasons')).toBeNull()
    expect(screen.getByTestId('card-reconcile').textContent).toContain(
      'A git merge is in progress in the folder.',
    )
  })
})

describe('reconcile card: long path lists', () => {
  it('shows the first few with "and N more", and every path in a disclosure', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/file-${String(i + 1).padStart(2, '0')}.ts`)
    show(overlapCard({ external: many, overlapping: [] }))
    const external = screen.getByTestId('reconcile-external')
    expect(external.textContent).toContain('Edited outside the run (12 files)')
    expect(within(external).getAllByTestId('reconcile-external-path')).toHaveLength(PATHS_SHOWN)
    expect(screen.getByTestId('reconcile-external-more').textContent).toBe(`and ${12 - PATHS_SHOWN} more`)
    const summary = screen.getByTestId('reconcile-external-all')
    expect(summary.textContent).toBe('Show all 12 files')
    const details = summary.closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    await click(summary)
    const full = screen.getByTestId('reconcile-external-full')
    expect([...full.querySelectorAll('li')].map((li) => li.textContent)).toEqual(many)
    // The full list reads in the page flow: no scroller of its own (UI standard: one scroll region per screen).
    expect(full.className).not.toMatch(/overflow/)
  })

  it('lists nothing after the first few when there are no more', () => {
    show(overlapCard())
    expect(screen.queryByTestId('reconcile-overlapping-more')).toBeNull()
    expect(screen.queryByTestId('reconcile-overlapping-all')).toBeNull()
  })
})

describe('planMutated card', () => {
  it("lists the files Plan changed and sends core's choices as they are", async () => {
    show(planMutatedCard())
    const card = screen.getByTestId('card-planMutated')
    expect(card.textContent).toContain('Plan is meant to only read the folder')
    const paths = screen.getByTestId('plan-mutated-paths')
    expect(paths.textContent).toContain('Changed while Plan ran (2 files)')
    expect(
      within(paths)
        .getAllByTestId('plan-mutated-paths-path')
        .map((p) => p.textContent),
    ).toEqual(['src/cli.ts', 'notes.md'])
    expect(choice('revert-plan').textContent).toBe("Revert Plan's changes")
    expect(choice('keep').textContent).toBe('Keep')
    expect(isPrimary(choice('keep'))).toBe(true)
    await click(choice('revert-plan'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'planMutated-1', choiceId: 'revert-plan' },
    ])
  })

  it('reads the changed files from `files` records too', () => {
    const card = planMutatedCard({ payload: { files: [{ path: 'a.txt', status: 'A' }, { path: 'b.txt' }] } })
    expect(planChangedPaths(card)).toEqual(['a.txt', 'b.txt'])
    show(card)
    expect(screen.getByTestId('plan-mutated-paths').textContent).toContain('(2 files)')
  })

  it('shows no list when core named no files', () => {
    show(planMutatedCard({ payload: {} }))
    expect(screen.queryByTestId('plan-mutated-paths')).toBeNull()
    expect(choice('keep')).toBeTruthy()
  })

  it("keeps core's primary when the card has no default (it waits, even in Auto)", () => {
    const { defaultChoice: _none, ...noDefault } = planMutatedCard({
      choices: [
        { id: 'revert-plan', label: "Revert Plan's changes", primary: true },
        { id: 'keep', label: 'Keep' },
      ],
    })
    show(noDefault)
    expect(isPrimary(choice('revert-plan'))).toBe(true)
    expect(isPrimary(choice('keep'))).toBe(false)
  })
})

describe('retryPartial card', () => {
  it('offers Revert partial then fresh (P21 revert-then-fresh) and sends it', async () => {
    show(retryPartialCard())
    const revert = choice('revert-then-fresh')
    expect(revert.disabled).toBe(false)
    expect(revert.closest('[data-disabled-hint]')).toBeNull()
    expect(isPrimary(choice('keep-changes'))).toBe(true)
    await click(revert)
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'retryPartial-1', choiceId: 'revert-then-fresh' },
    ])
  })
})

describe('payload readers', () => {
  it('reads core ReconcileResult reasons, paths and commands; ignores what is not there', () => {
    const v = reconcileOf(blockCard())
    expect(v.reasons).toEqual([
      {
        row: 'operation',
        severity: 'block',
        title: 'A git merge is in progress',
        detail: 'Finish or abort the merge, then recheck. The run waits until then.',
        actions: [],
        commands: ['git merge --abort'],
      },
    ])
    expect(v.external).toEqual([])
    expect(reconcileOf({ ...blockCard(), payload: null })).toEqual({
      reasons: [],
      external: [],
      overlapping: [],
      actions: [],
    })
    // Paths at the top of the payload are read as well.
    const flat = reconcileOf({ ...blockCard(), payload: { external: ['a'], overlapping: ['a'] } })
    expect([flat.external, flat.overlapping]).toEqual([['a'], ['a']])
  })

  it("keeps core's primary flags when the card has no default", () => {
    const card = blockCard()
    expect(choicesWithDefault(card)).toBe(card.choices)
  })
})
