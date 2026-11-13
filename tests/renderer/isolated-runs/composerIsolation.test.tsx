// Composer: In place | Isolated run (the composer's In place | Isolated run choice, which warns about uncommitted
// changes; worktree eligibility; Isolated run is opt-in; "the composer warns 'N uncommitted
// changes not included'"). Isolated run is a run override like In place: it shows at once, core resolves, checks and
// estimates with it, and runs.start carries it. Chosen, a line says what it leaves out from core's count (core's live
// checks); the folder's eligibility problems (core's words) disable it with the reason.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { isolationIneligible, uncommittedCount, uncommittedText } from '@renderer/components/run/isolation.ts'
import {
  ISOLATED_CLEAN,
  ISOLATED_UNCOMMITTED_WARNING,
  isolationWarning,
} from '@renderer/pages/dashboard/composer/IsolationControls.tsx'
import { setIsolationMode } from '@renderer/pages/dashboard/composer/overrides.ts'
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

const EM_DASH = '—'

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  setLiveSupportForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
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

const isolated = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('isolation-worktree')
const lastOf = <T,>(list: T[]): T | undefined => list.at(-1)

/** core's live checks with the isolated-run check saying how many uncommitted changes it leaves out. */
function withUncommitted(n: number) {
  const base = report()
  return report({
    info: [
      ...base.info,
      check('run.isolation.worktree', {
        title: 'Isolated run',
        detail: `The run works in its own copy of the repository. ${uncommittedText(n)}.`,
      }),
    ],
  })
}

describe('Isolated run in the composer', () => {
  it('is a live run override: shown at once, resolved, checked and estimated with, and carried by runs.start', async () => {
    mock.on('runs.start', () => ({ runId: 'r1', displayNo: 1 }))
    await ready()
    expect(isolated().disabled).toBe(false)
    expect(isolated().closest('[data-disabled-hint]')).toBeNull()
    expect(screen.queryByTestId('isolation-warning')).toBeNull()
    fireEvent.click(isolated())
    // The user's choice shows at once, before core answers.
    expect(isolated().getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('isolation-inplace').getAttribute('aria-pressed')).toBe('false')
    await settle(300)
    const overrides = { isolation: { mode: 'worktree' } }
    expect(lastOf(mock.callsOf('config.resolve'))).toEqual({ folder: FOLDER, overrides })
    expect(lastOf(mock.callsOf('preflight.run'))).toEqual({ folder: FOLDER, overrides })
    expect(lastOf(mock.callsOf('estimates.get'))).toEqual({ folder: FOLDER, overrides })
    // Core has not counted: the line says isolated runs start from the last commit.
    expect(screen.getByTestId('isolation-warning').textContent).toBe(ISOLATED_UNCOMMITTED_WARNING)

    fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a --version flag' } })
    await settle(300)
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-run'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toEqual([{ folder: FOLDER, task: 'Add a --version flag', overrides }])

    // In place again: the override goes back to in place and the line goes (the user's own click).
    fireEvent.click(screen.getByTestId('isolation-inplace'))
    await settle(300)
    expect(lastOf(mock.callsOf('config.resolve'))?.overrides).toEqual({ isolation: { mode: 'inPlace' } })
    expect(screen.queryByTestId('isolation-warning')).toBeNull()
  })

  it('says "N uncommitted changes not included" from core’s count, its words changing in place', async () => {
    mock.on('preflight.run', () => withUncommitted(3))
    await ready()
    fireEvent.click(isolated())
    await settle(300)
    const line = screen.getByTestId('isolation-warning')
    expect(line.textContent).toBe(
      '3 uncommitted changes not included: isolated runs start from your last commit.',
    )
    expect(line.getAttribute('data-count')).toBe('3')
    expect(line.className).toContain('text-warning')
    expect(line.className).toContain('truncate')
    expect(line.textContent?.includes(EM_DASH)).toBe(false)
  })

  it('a clean folder: no warning tone, just where the run starts', async () => {
    mock.on('preflight.run', () => withUncommitted(0))
    await ready()
    fireEvent.click(isolated())
    await settle(300)
    expect(screen.getByTestId('isolation-warning').textContent).toBe(ISOLATED_CLEAN)
    expect(screen.getByTestId('isolation-warning').className).toContain('text-muted-foreground')
  })

  it('is disabled with core’s reason when the folder cannot have an isolated run', async () => {
    mock.on('preflight.run', () =>
      report({
        info: [
          check('folder.git', {
            title: 'Not a git repository',
            detail: 'Dim Factory still snapshots and diffs every run in its own shadow repository.',
          }),
        ],
      }),
    )
    await ready()
    expect(isolated().disabled).toBe(true)
    const hint = isolated().closest('[data-disabled-hint]')
    expect(hint?.textContent).toContain(
      'Not a git repository: isolated runs need a git repository with at least one commit.',
    )
    // The button keeps its label.
    expect(isolated().textContent).toBe('Isolated run')
    // In place stays choosable.
    expect(screen.getByTestId<HTMLButtonElement>('isolation-inplace').disabled).toBe(false)
  })

  it('reads the reasons from core’s checks: no commit yet, the isolated-run check failing', () => {
    expect(
      isolationIneligible(
        report({
          warnings: [
            check('folder.git.head', { status: 'warn', title: 'The repository has no commits yet' }),
          ],
        }),
      ),
    ).toEqual(['The repository has no commits yet: isolated runs need at least one commit.'])
    expect(
      isolationIneligible(
        report({
          blocking: [
            check('run.isolation.worktree', {
              status: 'fail',
              title: 'This folder cannot run isolated',
              detail: 'Not enough disk space for the copy.\nRun in place, or fix this first.',
            }),
          ],
        }),
      ),
    ).toEqual([
      'This folder cannot run isolated: Not enough disk space for the copy. Run in place, or fix this first.',
    ])
    expect(isolationIneligible(report())).toEqual([])
    expect(isolationIneligible(null)).toEqual([])
    expect(uncommittedCount(withUncommitted(1))).toBe(1)
    expect(uncommittedCount(report())).toBeNull()
    expect(uncommittedText(1)).toBe('1 uncommitted change not included')
    expect(isolationWarning(null).warn).toBe(true)
    expect(setIsolationMode({}, 'worktree')).toEqual({ isolation: { mode: 'worktree' } })
  })
})
