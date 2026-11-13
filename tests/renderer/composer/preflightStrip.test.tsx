// The composer's live preflight (live mode: debounced 300 ms with a request counter; Run disabled
// with ≤ 3 reasons; chips expand into recovery buttons; Run states and the preflight strip): debounce,
// stale answers dropped, chips in order with the first fix inline, "I ran it → Re-check", Fix N issues to run,
// Queue · Folder busy from core's folder.lock, Checking…, re-checks on config-changed and probe events, and
// runs.start's PREFLIGHT_BLOCKED report in the strip. Core's answers fill a summary row of one line (UI standard:
// async content never shifts the page); the chips open only on the user's click.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreflightReport } from '@shared/preflight.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { bumpConfigEpoch, upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
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
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

const runButton = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('composer-run')
/** What Run reads: its constant label, then the state shown beside it (UI standard: the button never changes size). */
const runReads = (): string => {
  const status = screen.getByTestId('composer-run-status').textContent ?? ''
  const label = runButton().textContent ?? ''
  return status === '' ? label : `${label} · ${status}`
}
const preflightCalls = () => mock.callsOf('preflight.run')

async function withTask(): Promise<void> {
  fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a --version flag' } })
  await settle()
}

/** Open the strip's chips (they never open on their own). */
async function showDetails(): Promise<void> {
  const toggle = screen.getByTestId('preflight-details')
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  await settle()
}

describe('live preflight requests', () => {
  it('waits 300 ms after the last change, then checks once (preflight.run and estimates.get together)', async () => {
    await mountComposer()
    expect(preflightCalls()).toHaveLength(0)
    await settle(299)
    expect(preflightCalls()).toHaveLength(0)
    await settle(1)
    expect(preflightCalls()).toEqual([{ folder: FOLDER }])
    expect(mock.callsOf('estimates.get')).toEqual([{ folder: FOLDER }])
    // Three quick changes are one check, with the last overrides.
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(100)
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(100)
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(299)
    expect(preflightCalls()).toHaveLength(1)
    await settle(1)
    expect(preflightCalls()).toHaveLength(2)
    expect(preflightCalls().at(-1)).toEqual({ folder: FOLDER, overrides: { auto: true } })
  })

  it('drops an answer to an older request (request counter)', async () => {
    const first = deferred<PreflightReport>()
    const second = deferred<PreflightReport>()
    const replies = [first.promise, second.promise]
    mock.on('preflight.run', () => replies.shift() ?? Promise.resolve(report()))
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(300)
    expect(preflightCalls()).toHaveLength(2)
    await act(async () => {
      second.resolve(
        report({ warnings: [check('pass.implement.relay', { status: 'warn', title: 'Newest' })] }),
      )
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      first.resolve(report({ blocking: [authBlocker] }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await showDetails()
    expect(screen.getByTestId('preflight-chip-pass.implement.relay')).toBeTruthy()
    expect(screen.queryByTestId('preflight-chip-vendor.claude.auth')).toBeNull()
  })

  it('checks again on config-changed and probe events, and never for a folder that is not a full path', async () => {
    await mountComposer()
    await settle(300)
    expect(preflightCalls()).toHaveLength(1)
    act(() => bumpConfigEpoch())
    await settle(300)
    expect(preflightCalls()).toHaveLength(2)
    act(() => upsertProbes([probe('claude', 'login-needed')]))
    await settle(300)
    expect(preflightCalls()).toHaveLength(3)
    fireEvent.change(screen.getByTestId('composer-folder-input'), { target: { value: 'work\\repo' } })
    await settle(1000)
    expect(preflightCalls()).toHaveLength(3)
    expect(screen.queryByTestId('preflight-strip')).toBeNull()
  })

  it('keeps the older behaviour when this core has no live preflight (UNSUPPORTED): no strip, Run enabled', async () => {
    mock.on('preflight.run', () => {
      throw mockError('UNSUPPORTED', 'preflight.run is not available in this build.')
    })
    await mountComposer()
    await withTask()
    await settle(300)
    expect(screen.queryByTestId('preflight-strip')).toBeNull()
    expect(runButton().disabled).toBe(false)
    expect(runReads()).toBe('Run')
  })

  it("shows core's message when the check itself fails", async () => {
    mock.on('preflight.run', () => {
      throw mockError('INTERNAL', 'The folder could not be read.')
    })
    await mountComposer()
    await settle(300)
    expect(screen.getByTestId('preflight-error').textContent).toBe(
      'Could not check this folder: The folder could not be read.',
    )
  })
})

describe('the strip', () => {
  const warn = check('pass.review.relay', {
    status: 'warn',
    title: 'Review: asks are auto-denied, not prompted',
    detail: 'Claude cannot relay asks for this pass.',
  })

  it('sums the checks up in one line; on request it lists blocking chips, then warnings, with the first fix inline', async () => {
    mock.on('preflight.run', () => report({ blocking: [authBlocker], warnings: [warn] }))
    await mountComposer()
    await settle(300)
    const strip = screen.getByTestId('preflight-strip')
    // One row: Check again, ✓ N checks ok, what the checks say, Show details. No chip until the user asks.
    const summary = screen.getByTestId('preflight-summary')
    expect(summary.className.split(' ')).toEqual(expect.arrayContaining(['h-7', 'items-center']))
    expect(summary.className.split(' ')).not.toContain('flex-wrap')
    expect(screen.getByTestId('preflight-summary-text').textContent).toBe(
      '1 issue blocks the run: Claude needs you to log in · 1 warning',
    )
    expect(
      [...summary.querySelectorAll('[data-testid]')]
        .map((e) => e.getAttribute('data-testid'))
        .filter((id) => id !== 'preflight-summary-text'),
    ).toEqual(['preflight-recheck', 'preflight-ok', 'preflight-details'])
    expect(strip.querySelectorAll('[data-testid^="preflight-chip-"]')).toHaveLength(0)
    await showDetails()
    const order = Array.from(strip.querySelectorAll('[data-testid^="preflight-chip-"]')).map((e) =>
      e.getAttribute('data-testid'),
    )
    expect(order).toEqual(['preflight-chip-vendor.claude.auth', 'preflight-chip-pass.review.relay'])
    const blocker = screen.getByTestId('preflight-chip-vendor.claude.auth')
    expect(blocker.getAttribute('data-severity')).toBe('blocking')
    expect(screen.getByTestId('preflight-chip-pass.review.relay').getAttribute('data-severity')).toBe(
      'warning',
    )
    // Collapsed: the title and only the first fix.
    expect(within(blocker).getByTestId('recovery-vendor.claude.auth.login')).toBeTruthy()
    expect(within(blocker).queryByTestId('recovery-vendor.claude.auth.settings')).toBeNull()
    expect(blocker.textContent).not.toContain('exited with code 1')
    // Expanded: the detail and every fix.
    fireEvent.click(
      within(blocker).getByRole('button', { name: 'Show details and fixes: Claude needs you to log in' }),
    )
    await settle()
    expect(blocker.textContent).toContain('claude auth status exited with code 1.')
    expect(within(blocker).getByTestId('recovery-vendor.claude.auth.settings')).toBeTruthy()
    expect(within(blocker).getByRole('button', { name: 'Copy: Copy the login command' })).toBeTruthy()
    const ok = screen.getByTestId('preflight-ok')
    expect(ok.textContent).toBe('✓ 5 checks ok')
    fireEvent.click(ok)
    await settle()
    expect(screen.getByTestId('preflight-ok-list').textContent).toContain(
      'Folder availability · No other run is using this folder.',
    )
  })

  it('copies a fix through recovery.execute, then "I ran it → Re-check" re-probes and checks again at once', async () => {
    mock.on('preflight.run', () => report({ blocking: [authBlocker] }))
    mock.on('recovery.execute', () => ({ kind: 'shell_copy', copied: 'claude auth login' }))
    mock.on('vendors.probe', () => [probe('claude', 'ready')])
    await mountComposer()
    await settle(300)
    await showDetails()
    const chip = screen.getByTestId('preflight-chip-vendor.claude.auth')
    await act(async () => {
      fireEvent.click(within(chip).getByTestId('recovery-vendor.claude.auth.login'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('recovery.execute')).toEqual([
      { actionId: 'vendor.claude.auth.login', folder: FOLDER },
    ])
    const before = preflightCalls().length
    mock.on('preflight.run', () => report())
    await act(async () => {
      fireEvent.click(within(chip).getByTestId('recheck-vendor.claude.auth.login'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(preflightCalls().length).toBeGreaterThan(before)
    expect(screen.queryByTestId('preflight-chip-vendor.claude.auth')).toBeNull()
  })

  it('"Check again" re-runs the check without waiting', async () => {
    await mountComposer()
    await settle(300)
    await act(async () => {
      fireEvent.click(screen.getByTestId('preflight-recheck'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(preflightCalls()).toHaveLength(2)
  })
})

describe('Run button', () => {
  it('reads "Fix N issues to run", is disabled, and lists at most three reasons', async () => {
    const titles = [
      'Claude needs you to log in',
      'Git not found',
      'The folder’s drive is almost full',
      'Unknown profile',
    ]
    mock.on('preflight.run', () =>
      report({ blocking: titles.map((title, i) => check(`x.${i}`, { status: 'fail', title })) }),
    )
    await mountComposer()
    await withTask()
    await settle(300)
    expect(runReads()).toBe('Run · Fix 4 issues to run')
    expect(runButton().disabled).toBe(true)
    // The state is text beside the button, which names it; the button reserves Run and Queue, so it never resizes.
    expect(runButton().getAttribute('aria-describedby')).toBe('composer-run-status')
    expect(
      [...runButton().querySelectorAll('[data-label]')].map((r) => r.getAttribute('data-label')),
    ).toEqual(['Run', 'Queue'])
    const reason =
      'Fix 4 issues to run: Claude needs you to log in; Git not found; The folder’s drive is almost full; and 1 more'
    expect(screen.getByLabelText(reason)).toBeTruthy()
    fireEvent.keyDown(screen.getByTestId('composer-task'), { key: 'Enter', code: 'Enter', ctrlKey: true })
    await settle()
    expect(mock.callsOf('runs.start')).toHaveLength(0)
  })

  it('sits at the end of a row that never wraps; the status beside it gives way (ellipsis) instead of moving it', async () => {
    mock.on('preflight.run', () => report({ blocking: [authBlocker] }))
    await mountComposer()
    await withTask()
    await settle(300)
    const status = screen.getByTestId('composer-run-status')
    expect(status.textContent).toBe('Fix 1 issue to run')
    const row = screen.getByTestId('composer-run-row')
    const classes = (el: Element | null): string[] => (el?.className ?? '').toString().split(' ')
    // One line: a longer status can neither wrap the row nor push Run onto a new line (ui-standards.spec.ts measures it).
    expect(classes(row)).not.toContain('flex-wrap')
    expect(row.contains(runButton())).toBe(true)
    // Run is the last thing in the row, after the status and the key chip, and it never shrinks.
    const group = status.parentElement
    expect(group?.parentElement).toBe(row)
    expect(classes(group)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0', 'justify-end']))
    expect(group?.lastElementChild?.contains(runButton())).toBe(true)
    expect(classes(runButton())).toContain('shrink-0')
    // The status takes what room is left and is cut with an ellipsis; its whole text stays in its title and is what
    // Run's aria-describedby reads.
    expect(classes(status)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))
    expect(status.getAttribute('title')).toBe('Fix 1 issue to run')
    expect(runButton().getAttribute('aria-describedby')).toBe(status.id)
    // The profile and Auto never shrink under it.
    for (const left of [...row.children].slice(0, -1)) expect(classes(left)).toContain('shrink-0')
  })

  it('shows one chip for checks core reported with the same fixes, and one reason for them', async () => {
    const perPass = (p: string) =>
      check(`pass.${p}.vendor`, {
        status: 'fail',
        title: `${p}: Claude needs you to log in`,
        recovery: authBlocker.recovery,
      })
    mock.on('preflight.run', () => report({ blocking: [authBlocker, perPass('plan'), perPass('implement')] }))
    await mountComposer()
    await withTask()
    await settle(300)
    await showDetails()
    const chips = screen.getAllByTestId(/^preflight-chip-/)
    expect(chips.map((c) => c.getAttribute('data-testid'))).toEqual(['preflight-chip-vendor.claude.auth'])
    expect(chips[0]?.getAttribute('data-also')).toBe('pass.plan.vendor pass.implement.vendor')
    expect(chips[0]?.textContent).toContain('Claude needs you to log in · and 2 more with the same fix')
    // One problem (three checks with the same fix): the label counts it once, as the strip and the reason do.
    expect(runReads()).toBe('Run · Fix 1 issue to run')
    expect(screen.getByLabelText('Fix 1 issue to run: Claude needs you to log in')).toBeTruthy()
    fireEvent.click(
      within(chips[0] as HTMLElement).getByRole('button', {
        name: 'Show details and fixes: Claude needs you to log in',
      }),
    )
    await settle()
    expect(within(chips[0] as HTMLElement).getByRole('list', { name: 'Also reported' }).textContent).toBe(
      'plan: Claude needs you to log inimplement: Claude needs you to log in',
    )
  })

  it('reads "Fix 1 issue to run" for one blocker', async () => {
    mock.on('preflight.run', () => report({ blocking: [authBlocker] }))
    await mountComposer()
    await withTask()
    await settle(300)
    expect(runReads()).toBe('Run · Fix 1 issue to run')
    expect(screen.getByLabelText('Fix 1 issue to run: Claude needs you to log in')).toBeTruthy()
  })

  it("reads Queue · Folder busy from core's folder.lock answer, not from the runs it knows", async () => {
    mock.on('preflight.run', () =>
      report({
        info: [
          check('folder.lock', {
            title: 'Queues behind run #12 (running 4 min)',
            detail: 'Run #12 is using this folder; this run starts when it finishes.',
          }),
        ],
      }),
    )
    await mountComposer()
    await withTask()
    await settle(300)
    expect(runReads()).toBe('Queue · Folder busy')
    expect(runButton().disabled).toBe(false)
  })

  it('a free folder per core reads Run even while the store holds a run in the same folder', async () => {
    // This core answers preflight.run (learned earlier in the session).
    setLiveSupportForTests('yes')
    upsertSummaries([makeSummary({ runId: 'a', status: 'running', folder: FOLDER })], { loaded: true })
    await mountComposer()
    await withTask()
    // Before core answers for this folder, Run is plain Run: the renderer reads nothing from the run statuses.
    expect(runReads()).toBe('Run')
    await settle(300)
    expect(runReads()).toBe('Run')
  })

  it('reads Checking… while a check takes longer than 300 ms, and still starts the run', async () => {
    const hold = deferred<PreflightReport>()
    mock.on('preflight.run', () => hold.promise)
    mock.on('runs.start', () => ({ runId: 'r1', displayNo: 1 }))
    await mountComposer()
    await withTask()
    await settle(300)
    expect(runReads()).toBe('Run')
    await settle(300)
    expect(runReads()).toBe('Run · Checking…')
    expect(runButton().disabled).toBe(false)
    await act(async () => {
      fireEvent.click(runButton())
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toEqual([{ folder: FOLDER, task: 'Add a --version flag' }])
  })

  it("shows runs.start's PREFLIGHT_BLOCKED report in the strip until the next live check replaces it", async () => {
    mock.on('runs.start', () => {
      throw mockError('PREFLIGHT_BLOCKED', 'Blocked', report({ blocking: [authBlocker] }))
    })
    await mountComposer()
    await withTask()
    await settle(300)
    await act(async () => {
      fireEvent.click(runButton())
      await vi.advanceTimersByTimeAsync(0)
    })
    const strip = screen.getByTestId('preflight-strip')
    expect(strip.getAttribute('data-source')).toBe('start')
    // An alert in the summary row; the chips wait for the user's click (it moves the page only then).
    const blockers = within(strip).getByTestId('composer-blockers')
    expect(blockers.getAttribute('role')).toBe('alert')
    expect(blockers.textContent).toBe(
      'No run was created. 1 issue blocks the run: Claude needs you to log in',
    )
    expect(strip.querySelectorAll('[data-testid^="preflight-chip-"]')).toHaveLength(0)
    // Shown, its chips are expanded at once: detail and every fix.
    await showDetails()
    expect(within(strip).getByTestId('preflight-chips').textContent).toContain(
      'claude auth status exited with code 1.',
    )
    expect(runReads()).toBe('Run · Fix 1 issue to run')
    await act(async () => {
      fireEvent.click(screen.getByTestId('preflight-recheck'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(screen.queryByTestId('composer-blockers')).toBeNull()
    expect(screen.getByTestId('preflight-strip').getAttribute('data-source')).toBe('live')
    expect(runReads()).toBe('Run')
  })
})
