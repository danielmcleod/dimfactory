// Quick composer review fixes ("the renderer never derives …", Run states, Pass rows, accessibility; the Critic
// swap; the Fix session; Queue waits "until preflight.run answers it"):
//   - Queue ("Folder busy") is core's folder.lock answer only, once this core is known to answer preflight.run;
//   - "Fix N issues to run" counts problems, as the strip's chips and the reason do;
//   - ⌘/Ctrl+Enter in a pass row's Model box runs with the typed model;
//   - a polite live region says what core's live checks mean for Run;
//   - the Critic swap and the Fix session are core's answers (config.resolve suggestions), not the probes' reading.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { ComposerSuggestions, ResolvedWithProvenance } from '@shared/ipc.ts'
import type { CheckResult } from '@shared/preflight.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  authBlocker,
  check,
  fakeResolve,
  FOLDER,
  mountComposer,
  probe,
  report,
  runEstimate,
} from './fixtures.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  setLiveSupportForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'runs.start': () => ({ runId: 'r1', displayNo: 1 }),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => {
  setLiveSupportForTests()
  tearDown(mock)
})

const runButton = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('composer-run')
/** What Run reads: its constant label, then the state shown beside it (UI standard: the button never changes size). */
const runReads = (): string => {
  const status = screen.getByTestId('composer-run-status').textContent ?? ''
  const label = runButton().textContent ?? ''
  return status === '' ? label : `${label} · ${status}`
}
const status = (): string => screen.getByTestId('composer-checks-status').textContent ?? ''

async function withTask(): Promise<void> {
  fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a --version flag' } })
  await settle()
}

const busyRun = () =>
  upsertSummaries([makeSummary({ runId: 'a', status: 'running', folder: FOLDER })], { loaded: true })

const queued = report({
  info: [
    check('folder.lock', {
      title: 'Queues behind run #12 (running 4 min)',
      detail: 'Run #12 is using this folder; this run starts when it finishes.',
    }),
  ],
})

describe('Queue (Folder busy) comes from core', () => {
  it('only before core first answered this session do the run statuses stand in; then never again', async () => {
    busyRun()
    await mountComposer()
    await withTask()
    // Nothing is known about this core yet (an older one would never answer): the older reading stands in.
    expect(runReads()).toBe('Queue · Folder busy')
    await settle(300)
    // Core: the folder is free.
    expect(runReads()).toBe('Run')
    // Typing another path (not settled, no answer for it yet): plain Run, nothing read from the run statuses.
    fireEvent.change(screen.getByTestId('composer-folder-input'), {
      target: { value: 'C:\\work\\repo\\packages\\cli' },
    })
    expect(runReads()).toBe('Run')
    mock.on('preflight.run', () => queued)
    await settle(400)
    expect(runReads()).toBe('Run')
    await settle(300)
    expect(runReads()).toBe('Queue · Folder busy')
  })

  it('a check that fails says so and leaves Run plain, whatever the run statuses', async () => {
    setLiveSupportForTests('yes')
    busyRun()
    mock.on('preflight.run', () => {
      throw mockError('INTERNAL', 'git did not answer in time')
    })
    await mountComposer()
    await withTask()
    await settle(300)
    expect(screen.getByTestId('preflight-error').textContent).toContain('git did not answer in time')
    expect(runReads()).toBe('Run')
  })

  it('an older core without preflight.run (UNSUPPORTED) keeps the older reading', async () => {
    busyRun()
    mock.on('preflight.run', () => {
      throw mockError('UNSUPPORTED', 'not in this build')
    })
    await mountComposer()
    await withTask()
    await settle(300)
    expect(runReads()).toBe('Queue · Folder busy')
  })

  it('asks core again when a run releases its folder lock (no status change: a stopped run lets go last)', async () => {
    setLiveSupportForTests('yes')
    const stopping = makeSummary({ runId: 'a', status: 'cancelled', folder: FOLDER, lock: 'held' })
    upsertSummaries([stopping], { loaded: true })
    mock.on('preflight.run', () => queued)
    await mountComposer()
    await withTask()
    await settle(300)
    expect(runReads()).toBe('Queue · Folder busy')
    const asked = mock.callsOf('preflight.run').length
    mock.on('preflight.run', () => report())
    const { lock: _held, ...released } = stopping
    act(() => upsertSummaries([released]))
    await settle(300)
    expect(mock.callsOf('preflight.run').length).toBe(asked + 1)
    expect(runReads()).toBe('Run')
  })
})

describe('Fix N issues to run', () => {
  /** A logged-out Claude under claude-only: its own check and every pass that uses it, with the same fixes. */
  const loggedOut = (): CheckResult[] => [
    authBlocker,
    ...['plan', 'implement', 'review', 'critic', 'fix'].map((p) =>
      check(`pass.${p}.vendor`, {
        status: 'fail',
        title: 'Claude needs you to log in',
        recovery: authBlocker.recovery,
      }),
    ),
  ]

  it('one problem reported six times reads "Fix 1 issue to run", like its one chip and one reason', async () => {
    mock.on('preflight.run', () => report({ blocking: loggedOut() }))
    await mountComposer()
    await withTask()
    await settle(300)
    // The chips open on the user's click (UI standard: core's answers never shift the page on their own).
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    expect(screen.getAllByTestId(/^preflight-chip-/)).toHaveLength(1)
    expect(runReads()).toBe('Run · Fix 1 issue to run')
    expect(screen.getByLabelText('Fix 1 issue to run: Claude needs you to log in')).toBeTruthy()
  })

  it('two distinct problems read "Fix 2 issues to run"', async () => {
    const noRepo = check('folder.git', { status: 'fail', title: 'Not a git repository' })
    mock.on('preflight.run', () => report({ blocking: [...loggedOut(), noRepo] }))
    await mountComposer()
    await withTask()
    await settle(300)
    expect(runReads()).toBe('Run · Fix 2 issues to run')
    expect(
      screen.getByLabelText('Fix 2 issues to run: Claude needs you to log in; Not a git repository'),
    ).toBeTruthy()
  })
})

describe('⌘/Ctrl+Enter in a Model box', () => {
  async function typeModel(model: string): Promise<HTMLInputElement> {
    fireEvent.click(screen.getByTestId('composer-passes-toggle'))
    await settle()
    fireEvent.click(screen.getByTestId('pass-row-toggle-plan'))
    await settle()
    const box = screen.getByTestId<HTMLInputElement>('pass-model-plan')
    fireEvent.change(box, { target: { value: model } })
    return box
  }

  it('commits the typed model first, so the run gets it', async () => {
    await mountComposer()
    await withTask()
    await settle(300)
    const box = await typeModel('sonnet')
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', ctrlKey: true })
      await vi.advanceTimersByTimeAsync(0)
    })
    const sent = mock.callsOf('runs.start') as { overrides?: RunOverrides }[]
    expect(sent).toHaveLength(1)
    expect(sent[0]?.overrides).toEqual({ passes: { plan: { model: 'sonnet' } } })
  })

  it('an id the config would refuse stops the run there, with its message', async () => {
    await mountComposer()
    await withTask()
    await settle(300)
    const box = await typeModel('not a model')
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', ctrlKey: true })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toHaveLength(0)
    expect(screen.getByText('Use letters, digits and . : @ / [ ] - _ only.')).toBeTruthy()
  })
})

describe('the live region', () => {
  it('says what core’s checks mean for Run: passed, blocked, queued, or the check failed', async () => {
    await mountComposer()
    await withTask()
    expect(screen.getByTestId('composer-checks-status').getAttribute('aria-live')).toBe('polite')
    expect(status()).toBe('')
    await settle(300)
    expect(status()).toBe('All checks passed.')

    mock.on('preflight.run', () => report({ blocking: [authBlocker] }))
    fireEvent.click(screen.getByTestId('preflight-recheck'))
    await settle()
    expect(status()).toBe('Checks: 1 issue blocks the run. Claude needs you to log in.')

    mock.on('preflight.run', () => queued)
    fireEvent.click(screen.getByTestId('preflight-recheck'))
    await settle()
    expect(status()).toBe('All checks passed. The run will queue behind another run in this folder.')

    mock.on('preflight.run', () =>
      report({ warnings: [check('app.git', { status: 'warn', title: 'Old git' })] }),
    )
    fireEvent.click(screen.getByTestId('preflight-recheck'))
    await settle()
    expect(status()).toBe('Nothing blocks the run; 1 warning.')

    mock.on('preflight.run', () => {
      throw mockError('INTERNAL', 'git did not answer in time')
    })
    fireEvent.click(screen.getByTestId('preflight-recheck'))
    await settle()
    expect(status()).toBe('Could not check this folder: git did not answer in time')
  })
})

describe('Critic swap and Fix session are core’s answers', () => {
  const resolveWith =
    (suggestions: ComposerSuggestions, edit?: Parameters<typeof fakeResolve>[0]) =>
    (req: { folder?: string; overrides?: RunOverrides }): ResolvedWithProvenance => ({
      ...fakeResolve(edit)(req),
      suggestions,
    })

  it('shows core’s swap target even when the probes the renderer holds say nothing about it', async () => {
    mock.on(
      'config.resolve',
      resolveWith({ criticSwap: { to: 'codex' }, fixSession: { choice: 'reuse' }, otherFixVendor: null }),
    )
    await mountComposer()
    await settle(300)
    expect(screen.getByTestId('critic-swap').textContent).toBe('Swap Critic to Codex')
  })

  it('offers no swap when core offers none, although another probe is ready', async () => {
    upsertProbes([probe('codex', 'ready')])
    mock.on(
      'config.resolve',
      resolveWith({ criticSwap: null, fixSession: { choice: 'reuse' }, otherFixVendor: 'codex' }),
    )
    await mountComposer()
    await settle(300)
    expect(screen.queryByTestId('critic-swap')).toBeNull()
  })

  it('a Fix vendor override with reuseSession on reads as core decides: fresh, not "Reuse"', async () => {
    mock.on(
      'config.resolve',
      resolveWith(
        {
          criticSwap: null,
          fixSession: { choice: 'fresh-other', reason: 'vendor-differs' },
          otherFixVendor: null,
        },
        { config: (c) => void (c.passes.fix.vendor = 'codex') },
      ),
    )
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('composer-passes-toggle'))
    await settle()
    expect(screen.getByTestId('pass-summary-fix').textContent).toBe(
      'Fix · Codex · CLI default · Fresh, different vendor',
    )
  })
})
