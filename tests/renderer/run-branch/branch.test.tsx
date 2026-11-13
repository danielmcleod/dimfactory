// Run branch in the Run view (branch prep and the end of the run; RunHeader): the header's branch
// line "On dim/20261008-add-version-flag (from main)" (full: on the facts line, cut to fit and whole in its
// title; compact: an icon named by it, and in the title's tooltip), from core's RunSnapshot.branch; at the end of the
// run, "After the run" offers [Return to main] [Delete run branch]. Core decides on each press (runs.branch): done, or
// why not with the commands to run instead (copyable); a core without runs.branch shows "Available in a later version".
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BranchActionResult } from '@shared/ipc.ts'
import type { RunBranchInfo, RunSnapshot } from '@shared/run.ts'
import {
  branchLineText,
  previousLabel,
  resetBranchOutcomesForTests,
  returnLabel,
} from '@renderer/components/run/branch.ts'
import { RunEndPanel } from '@renderer/components/run/RunEndPanel.tsx'
import { RunHeader } from '@renderer/components/run/RunHeader.tsx'
import { resetRevertForTests } from '@renderer/components/run/revert.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, settle, snapWith, stubClipboard } from '../run/helpers.tsx'
import { BASE_SHA, RUN_BRANCH } from './fixtures.ts'

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  clearToasts()
  resetBranchOutcomesForTests()
  resetRevertForTests()
  setMacForTests(false)
  mock = installMockDimFactory({
    handlers: {
      'runs.get': () => ended(),
      'runs.branch': (): BranchActionResult => ({ done: true, commands: [] }),
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

/** A completed run with core's branch record (`branch: null`: a run without a run branch). */
function ended(o: { branch?: RunBranchInfo | null } = {}): RunSnapshot {
  const base = snapWith({
    summary: {
      status: 'completed',
      phase: 'done',
      outcome: 'fixed',
      endedAt: 1_700_000_900_000,
      progress: { tokens: 1, costUsd: null, filesChanged: 3 },
    },
  })
  const branch = o.branch === undefined ? RUN_BRANCH : o.branch
  return branch === null ? base : { ...base, branch }
}

const runningWithBranch = (): RunSnapshot => ({
  ...snapWith({ summary: { status: 'running', phase: 'implementing' } }),
  branch: RUN_BRANCH,
})

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

const toastMessages = (): string[] => useStore.getState().toasts.items.map((t) => t.message)
const LINE = 'On dim/20261008-add-version-flag (from main)'

describe('the branch line', () => {
  it('words the branch and where the run started', () => {
    expect(branchLineText(RUN_BRANCH)).toBe(LINE)
    expect(previousLabel('refs/heads/release/1.2')).toBe('release/1.2')
    expect(previousLabel(`detached:${'b'.repeat(40)}`)).toBe('detached HEAD at bbbbbbb')
    expect(returnLabel(RUN_BRANCH)).toBe('Return to main')
    expect(returnLabel({ ...RUN_BRANCH, previous: `detached:${'c'.repeat(40)}` })).toBe('Return to ccccccc')
  })

  it("is on the full header's facts line, cut to fit and whole in its title", () => {
    renderUi(<RunHeader snap={runningWithBranch()} onStop={() => undefined} stopping={false} />)
    const line = screen.getByTestId('run-branch')
    expect(line.textContent).toBe(LINE)
    expect(line.getAttribute('title')).toBe(LINE)
    // On the one-line facts row with the folder and profile (it never adds a line to the sticky header).
    expect(line.parentElement?.textContent).toContain('Profile claude-only')
  })

  it('in the compact header: an icon named by the line, and the line in the title tooltip', () => {
    renderUi(<RunHeader snap={runningWithBranch()} onStop={() => undefined} stopping={false} compact />)
    expect(screen.getByRole('img', { name: LINE })).toBe(screen.getByTestId('run-branch'))
    const title = screen.getByRole('heading').getAttribute('title') ?? ''
    expect(title.split('\n')).toEqual([
      '#1 Add a --version flag',
      'C:\\work\\repo · Profile claude-only',
      LINE,
    ])
  })

  it('is absent without a run branch', () => {
    renderUi(<RunHeader snap={snapWith()} onStop={() => undefined} stopping={false} />)
    expect(screen.queryByTestId('run-branch')).toBeNull()
  })
})

describe('end-of-run branch actions ("After the run")', () => {
  it('offers Return to main and Delete run branch with the branch named', () => {
    renderUi(<RunEndPanel snap={ended()} />)
    const branch = screen.getByTestId('run-end-branch')
    expect(branch.textContent).toContain(
      'The run worked on its own branch dim/20261008-add-version-flag, made from main. Dim Factory made no commits.',
    )
    expect(screen.getByTestId('branch-return').textContent).toBe('Return to main')
    expect(screen.getByTestId('branch-delete').textContent).toBe('Delete run branch')
  })

  it('has no branch part for a run without a run branch', () => {
    renderUi(<RunEndPanel snap={ended({ branch: null })} />)
    expect(screen.getByTestId('run-end')).toBeTruthy()
    expect(screen.queryByTestId('run-end-branch')).toBeNull()
  })

  it('Return: core moves HEAD back; the button then waits with what happened', async () => {
    renderUi(<RunEndPanel snap={ended()} />)
    await click(screen.getByTestId('branch-return'))
    expect(mock.callsOf('runs.branch')).toEqual([{ runId: RUN, action: 'return' }])
    expect(toastMessages()).toContain('Back on main.')
    expect(screen.getByTestId('branch-return-done').textContent).toBe('Back on main.')
    expect(screen.getByTestId<HTMLButtonElement>('branch-return').disabled).toBe(true)
    expect(screen.getByRole('group', { name: 'Return to main Back on main.' })).toBeTruthy()
    // Delete is still core's to decide.
    expect(screen.getByTestId<HTMLButtonElement>('branch-delete').disabled).toBe(false)
  })

  it("Delete refused: core's reason and the commands to run instead, each with Copy", async () => {
    const clip = stubClipboard()
    mock.on('runs.branch', () => ({
      done: false,
      reason: 'dim/20261008-add-version-flag is checked out. Go back to main first.',
      commands: ['git checkout main', 'git branch -d dim/20261008-add-version-flag'],
    }))
    renderUi(<RunEndPanel snap={ended()} />)
    await click(screen.getByTestId('branch-delete'))
    expect(mock.callsOf('runs.branch')).toEqual([{ runId: RUN, action: 'delete' }])
    const refused = screen.getByTestId('branch-delete-refused')
    expect(refused.textContent).toContain('is checked out. Go back to main first.')
    expect(refused.textContent).toContain('Run it yourself in a terminal in the folder:')
    expect(
      within(refused)
        .getAllByTestId('branch-delete-commands-command')
        .map((c) => c.textContent),
    ).toEqual(['git checkout main', 'git branch -d dim/20261008-add-version-flag'])
    await click(within(refused).getByRole('button', { name: 'Copy: git checkout main' }))
    expect(clip.writes).toEqual(['git checkout main'])
    expect(toastMessages()).toContain('Command copied to the clipboard')
    // Nothing was done, so both stay available (the user may fix it and press again).
    expect(screen.getByTestId<HTMLButtonElement>('branch-delete').disabled).toBe(false)
  })

  it('Return from a detached start: core cannot move HEAD, the command says how', async () => {
    const detached = { ...RUN_BRANCH, previous: `detached:${BASE_SHA}` }
    mock.on('runs.branch', () => ({
      done: false,
      reason:
        'The run started on a detached HEAD at aaaaaaa. Dim Factory only moves HEAD between branches; run the command to go back.',
      commands: [`git checkout --detach ${BASE_SHA}`],
    }))
    renderUi(<RunEndPanel snap={ended({ branch: detached })} />)
    expect(screen.getByTestId('branch-return').textContent).toBe('Return to aaaaaaa')
    expect(screen.getByTestId('run-end-branch').textContent).toContain('made from detached HEAD at aaaaaaa')
    await click(screen.getByTestId('branch-return'))
    expect(screen.getByTestId('branch-return-refused').textContent).toContain('run the command to go back')
    expect(screen.getByTestId('branch-return-commands-command').textContent).toBe(
      `git checkout --detach ${BASE_SHA}`,
    )
  })

  it("a branch already gone counts as done, in core's words", async () => {
    mock.on('runs.branch', () => ({
      done: true,
      reason: 'dim/20261008-add-version-flag no longer exists.',
      commands: [],
    }))
    renderUi(<RunEndPanel snap={ended()} />)
    await click(screen.getByTestId('branch-delete'))
    expect(screen.getByTestId('branch-delete-done').textContent).toBe(
      'dim/20261008-add-version-flag no longer exists.',
    )
  })

  it("an error is a toast with core's message, and the buttons stay", async () => {
    mock.on('runs.branch', () => {
      throw mockError('GIT', 'git could not read the repository.')
    })
    renderUi(<RunEndPanel snap={ended()} />)
    await click(screen.getByTestId('branch-return'))
    expect(toastMessages()).toContain('git could not read the repository.')
    expect(screen.getByTestId<HTMLButtonElement>('branch-return').disabled).toBe(false)
  })

  it('a core without runs.branch: the action shows "Available in a later version"', async () => {
    mock.on('runs.branch', () => {
      throw mockError('UNSUPPORTED', 'runs.branch is not available')
    })
    renderUi(<RunEndPanel snap={ended()} />)
    await click(screen.getByTestId('branch-delete'))
    expect(toastMessages()).toContain('Delete run branch: available in a later version.')
    expect(screen.getByRole('group', { name: 'Delete run branch Available in a later version' })).toBeTruthy()
  })

  it('keeps what core answered when the panel mounts again (a tab switch)', async () => {
    const first = renderUi(<RunEndPanel snap={ended()} />)
    await click(screen.getByTestId('branch-return'))
    first.unmount()
    renderUi(<RunEndPanel snap={ended()} />)
    expect(screen.getByTestId('branch-return-done').textContent).toBe('Back on main.')
    expect(mock.callsOf('runs.branch')).toHaveLength(1)
  })
})
