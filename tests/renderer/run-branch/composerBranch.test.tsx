// Composer: New run branch (the composer's New run branch box; `isolation.branch`; the
// `run.branch` and `folder.git` checks). The box is a run override like the gates: it shows the pending choice at once and
// core's value otherwise, with core's provenance badge (run in amber); core's live checks run with it
// (preflight.run overrides), its run.branch check shows in the strip like any other, and runs.start carries it.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { RUN_BRANCH_HINT, runBranchTooltip } from '@renderer/pages/dashboard/composer/IsolationControls.tsx'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  check,
  fakeResolve,
  FOLDER,
  mountComposer,
  probe,
  report,
  runEstimate,
} from '../composer/fixtures.tsx'

let mock: MockDimFactory

/** core's config.resolve for the branch: the run override wins with run provenance, else the built-in default. */
function resolveWithBranch() {
  const base = fakeResolve()
  return (req: { folder?: string; overrides?: RunOverrides }) => {
    const r = base(req)
    const b = req.overrides?.isolation?.branch
    if (b !== undefined) r.config.isolation.branch = b
    r.provenance['/isolation/branch'] = b !== undefined ? { source: 'run' } : { source: 'default' }
    return r
  }
}

const BRANCH_CHECK = check('run.branch', {
  title: 'Run branch name',
  detail: 'Dim Factory will make dim/20261008-add-a-version-flag.',
})

beforeEach(() => {
  resetRecoveryForTests()
  setLiveSupportForTests()
  mock = setUp({
    handlers: {
      'config.resolve': resolveWithBranch(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

async function ready(): Promise<void> {
  await mountComposer()
  await settle(300)
  fireEvent.click(screen.getByTestId('composer-passes-toggle'))
  await settle()
}

async function toggleBranch(): Promise<void> {
  fireEvent.click(screen.getByTestId('run-branch'))
  await settle(300)
}

const box = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('run-branch')
const lastOf = <T,>(list: T[]): T | undefined => list.at(-1)

describe('New run branch', () => {
  it('is a live checkbox with core provenance', async () => {
    await ready()
    expect(box().disabled).toBe(false)
    expect(box().getAttribute('aria-checked')).toBe('false')
    expect(box().closest('[data-disabled-hint]')).toBeNull()
    expect(screen.getByTestId('run-branch-provenance').getAttribute('data-source')).toBe('default')
  })

  it('becomes the run override isolation.branch: runBranch, in amber, and core checks with it', async () => {
    await ready()
    await toggleBranch()
    expect(box().getAttribute('aria-checked')).toBe('true')
    expect(lastOf(mock.callsOf('config.resolve'))).toEqual({
      folder: FOLDER,
      overrides: { isolation: { branch: 'runBranch' } },
    })
    const badge = screen.getByTestId('run-branch-provenance')
    expect(badge.getAttribute('data-source')).toBe('run')
    expect(badge.getAttribute('aria-label')).toBe('run: This run only')
    expect(screen.getByTestId('composer-override-count').textContent).toBe('1 run override')
    expect(lastOf(mock.callsOf('preflight.run'))).toEqual({
      folder: FOLDER,
      overrides: { isolation: { branch: 'runBranch' } },
    })
    expect(lastOf(mock.callsOf('estimates.get'))).toEqual({
      folder: FOLDER,
      overrides: { isolation: { branch: 'runBranch' } },
    })
    // Unticked again: an explicit `none` for this run, like a gate set back.
    await toggleBranch()
    expect(box().getAttribute('aria-checked')).toBe('false')
    expect(lastOf(mock.callsOf('config.resolve'))?.overrides).toEqual({ isolation: { branch: 'none' } })
  })

  it('shows a project default of runBranch from core, with its provenance', async () => {
    mock.on('config.resolve', (req) => {
      const r = resolveWithBranch()(req)
      if (req.overrides?.isolation?.branch === undefined) {
        r.config.isolation.branch = 'runBranch'
        r.provenance['/isolation/branch'] = {
          source: 'project',
          file: 'C:\\work\\repo\\.dimfactory\\dimfactory.json',
          line: 3,
        }
      }
      return r
    })
    await ready()
    expect(box().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('run-branch-provenance').getAttribute('data-source')).toBe('project')
  })

  it('starts the run with it (runs.start overrides)', async () => {
    mock.on('runs.start', () => ({ runId: 'r1', displayNo: 1 }))
    await ready()
    await toggleBranch()
    fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a --version flag' } })
    await settle(300)
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-run'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toEqual([
      { folder: FOLDER, task: 'Add a --version flag', overrides: { isolation: { branch: 'runBranch' } } },
    ])
  })

  it("shows core's run.branch check in the strip when it blocks, and Run says so", async () => {
    mock.on('preflight.run', (req) =>
      req.overrides?.isolation?.branch === 'runBranch'
        ? report({
            blocking: [
              check('run.branch', {
                status: 'fail',
                title: 'The run branch name is not valid',
                detail: 'git check-ref-format refused dim/..bad.',
              }),
            ],
          })
        : report(),
    )
    await ready()
    expect(screen.queryByTestId('preflight-details')).toBeNull()
    await toggleBranch()
    expect(screen.getByTestId('preflight-summary-text').textContent).toBe(
      '1 issue blocks the run: The run branch name is not valid',
    )
    expect(screen.getByTestId('composer-run-status').textContent).toBe('Fix 1 issue to run')
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    const chip = screen.getByTestId('preflight-chip-run.branch')
    expect(chip.getAttribute('data-severity')).toBe('blocking')
    expect(chip.textContent).toContain('The run branch name is not valid')
  })

  it("lists a passing run.branch check with the others, and its tooltip carries core's words", async () => {
    mock.on('preflight.run', () => report({ info: [...report().info, BRANCH_CHECK] }))
    await ready()
    await toggleBranch()
    fireEvent.click(screen.getByTestId('preflight-ok'))
    await settle()
    const list = screen.getByTestId('preflight-ok-list')
    expect(within(list).getByText('Run branch name')).toBeTruthy()
    expect(runBranchTooltip(BRANCH_CHECK)).toBe(
      `${RUN_BRANCH_HINT}\nRun branch name: Dim Factory will make dim/20261008-add-a-version-flag.`,
    )
    expect(runBranchTooltip(undefined)).toBe(RUN_BRANCH_HINT)
  })

  it('keeps the box where it is when core names the provenance (the badge room is reserved)', async () => {
    // An older core without the provenance entry: the badge's room is held, unseen.
    mock.on('config.resolve', (req) => {
      const r = resolveWithBranch()(req)
      delete r.provenance['/isolation/branch']
      return r
    })
    await ready()
    expect(screen.queryByTestId('run-branch-provenance')).toBeNull()
    const control = screen.getByTestId('run-branch-control')
    expect(control.querySelector('[aria-hidden] [data-stable-label]')).not.toBeNull()
  })
})
