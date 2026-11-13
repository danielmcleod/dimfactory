// Codex sandbox chip (the Dashboard setup card "offers the Codex sandbox fix", the executor
// `vendor_setup` "runs on click", "Codex, Windows sandbox not ready", the sandbox procedure X11b/X11c;
// codex-sandbox.spec.ts; the flow "set up the Codex sandbox from the chip"). The chip on the setup card: notConfigured → [Set up the Codex
// sandbox] (a click only) → progress beside the button → core's answer and its new probe: ready, or failed with the
// elevated command to copy (administrator terminal, UAC) and Re-check. The button never changes its label or width;
// nothing runs on its own.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, RecoveryResult } from '@shared/ipc.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { ELEVATED_NOTE, UAC_NOTE } from '@renderer/components/recovery/execute.ts'
import { SandboxChip } from '@renderer/components/recovery/SandboxChip.tsx'
import {
  ELEVATED_NEXT,
  ELEVATED_TOGGLE_LABEL,
  outcomeReason,
  resetSandboxSetupForTests,
  sandboxFailedText,
  sandboxPhase,
  SANDBOX_SET_UP_LABEL,
  setupOutcomeOf,
} from '@renderer/components/recovery/sandboxSetup.ts'
import { LATER_VERSION } from '@renderer/components/ui/DisabledHint.tsx'
import { SANDBOX_BELOW, SetupCard } from '@renderer/pages/dashboard/rail/SetupCard.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  codex,
  ELEVATED_ACTION,
  FAILED_MESSAGE,
  reprobed,
  SET_UP_MESSAGE,
  SETUP_ACTION,
  sandboxCheck,
  setupOutcome,
  WIN_SANDBOX_SETUP_DETAIL,
  setupResult,
} from './fixtures.ts'

let mock: MockDimFactory
let listed: ProbeView[]

const state: AppState = {
  schemaVersion: 1,
  setupDismissed: false,
  firstLaunchCompletedAt: 0,
  catalog: { lastRefreshAt: null, snoozedUntil: null },
  notifications: { pausedUntil: null },
}

const claudeReady = probeView('claude', 'ready', { healthDetail: 'Ready · 2.1.289' })

function install(platform: 'win32' | 'darwin' = 'win32'): void {
  mock = setUp({
    platform,
    handlers: {
      'state.get': () => state,
      'config.resolve': () => resolvedView({ profile: 'claude-only' }),
      'vendors.list': () => listed,
      'vendors.probe': () => listed,
    },
  })
}

beforeEach(() => {
  listed = []
  install()
  resetRecoveryForTests()
  resetSandboxSetupForTests()
})

afterEach(() => {
  resetRecoveryForTests()
  resetSandboxSetupForTests()
  tearDown(mock)
})

async function mountCard(): Promise<void> {
  render(
    <Providers>
      <SetupCard />
    </Providers>,
  )
  await settle()
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

const button = (id = 'setup-codex-sandbox'): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>(id)
const status = (id = 'setup-codex-sandbox'): string => screen.getByTestId(`${id}-status`).textContent ?? ''
const phase = (id = 'setup-codex-sandbox'): string | null =>
  screen.getByTestId(`${id}-chip`).getAttribute('data-phase')
const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)
const setupCalls = () => mock.callsOf('recovery.execute').filter((r) => r.actionId === SETUP_ACTION.id)

/** recovery.execute for the setup answers when the test says so. */
function pendingSetup(): { answer: (r: RecoveryResult) => void; fail: (e: Error) => void } {
  let answer: (r: RecoveryResult) => void = () => undefined
  let fail: (e: Error) => void = () => undefined
  mock.on('recovery.execute', (req) =>
    req.actionId === SETUP_ACTION.id
      ? new Promise<RecoveryResult>((res, rej) => {
          answer = res
          fail = rej
        })
      : { kind: 'shell_copy', copied: ELEVATED_ACTION.command },
  )
  return { answer: (r) => answer(r), fail: (e) => fail(e) }
}

describe('the setup card chip', () => {
  it('offers the setup when Codex reports its sandbox not set up, and leaves the fix to the chip', async () => {
    upsertProbes([claudeReady, codex()])
    await mountCard()
    const row = screen.getByTestId('setup-vendor-codex')
    expect(within(row).getByText('Codex: sandbox setup needed')).toBeTruthy()
    // One button for one fix: the row points at the chip instead of repeating its setup and command.
    expect(row.textContent).toContain(SANDBOX_BELOW)
    expect(within(row).queryByTestId(`recovery-${SETUP_ACTION.id}`)).toBeNull()
    expect(row.textContent).not.toContain(ELEVATED_ACTION.command)
    expect(phase()).toBe('needed')
    expect(button().disabled).toBe(false)
    expect(button().textContent).toBe(SANDBOX_SET_UP_LABEL)
    expect(status()).toBe('Codex Windows sandbox not set up')
    // The elevated command waits behind its disclosure, which only the user opens.
    const more = screen.getByTestId<HTMLButtonElement>('setup-codex-sandbox-more')
    expect(more.textContent).toBe(ELEVATED_TOGGLE_LABEL)
    expect(more.disabled).toBe(false)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('setup-codex-sandbox-elevated')).toBeNull()
    // Nothing runs on its own.
    await settle(60_000)
    expect(mock.callsOf('recovery.execute')).toEqual([])
  })

  it('runs vendor_setup on the click, shows progress, then the ready sandbox from core’s new probe', async () => {
    upsertProbes([claudeReady, codex()])
    const setup = pendingSetup()
    await mountCard()
    await click(button())
    expect(setupCalls()).toEqual([{ actionId: SETUP_ACTION.id }])
    expect(phase()).toBe('running')
    expect(button().getAttribute('aria-busy')).toBe('true')
    expect(button().textContent).toBe(SANDBOX_SET_UP_LABEL)
    expect(status()).toBe('Setting up the Codex sandbox… 0:00')
    await settle(12_000)
    expect(status()).toBe('Setting up the Codex sandbox… 0:12')
    // A second click while it runs does nothing.
    fireEvent.click(button())
    await settle()
    expect(setupCalls()).toHaveLength(1)

    listed = [claudeReady, reprobed(codex({ sandbox: 'ready' }), 20_000)]
    await act(async () => {
      setup.answer(setupResult(setupOutcome(), SET_UP_MESSAGE))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(phase()).toBe('ready')
    expect(status()).toBe('Codex sandbox ready')
    // Live stage A: a ready sandbox leaves nothing to set up, so the chip is its status line alone (no disabled
    // button beside it cutting the line to "Codex s…").
    expect(screen.queryByTestId('setup-codex-sandbox')).toBeNull()
    expect(screen.queryByRole('group', { name: /The Codex sandbox is set up/ })).toBeNull()
    expect(toasts()).toContain(SET_UP_MESSAGE)
    // Core probed again with the setup: its probe is read, not forced a second time.
    expect(mock.callsOf('vendors.list').length).toBeGreaterThan(0)
    expect(mock.callsOf('vendors.probe')).toEqual([])
    expect(useStore.getState().probes.byVendor['codex']?.health).toBe('ready')
    expect(screen.getByTestId('setup-vendor-codex').getAttribute('data-health')).toBe('ready')
  })

  it('after a setup that did not finish: core’s reason, the elevated command (UAC) and Re-check', async () => {
    upsertProbes([claudeReady, codex()])
    const setup = pendingSetup()
    await mountCard()
    await click(button())
    listed = [claudeReady, reprobed(codex())]
    await act(async () => {
      setup.answer(
        setupResult(setupOutcome({ ok: false, ready: false, detail: 'Access is denied.' }), FAILED_MESSAGE),
      )
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(phase()).toBe('failed')
    expect(status()).toBe(sandboxFailedText('Access is denied.'))
    expect(status()).toBe('Setup did not finish: Access is denied.')
    expect(toasts()).toContain(FAILED_MESSAGE)
    // The setup can be tried again.
    expect(button().disabled).toBe(false)
    // A failed setup never opens the elevated command on its own (it would move the page); the user does.
    expect(screen.queryByTestId('setup-codex-sandbox-elevated')).toBeNull()
    await click(screen.getByTestId('setup-codex-sandbox-more'))
    expect(screen.getByTestId('setup-codex-sandbox-more').getAttribute('aria-expanded')).toBe('true')
    const elevated = screen.getByTestId('setup-codex-sandbox-elevated')
    expect(elevated.textContent).toContain(ELEVATED_NEXT)
    expect(elevated.textContent).toContain('codex sandbox setup --elevated --current-user')
    expect(elevated.textContent).toContain(ELEVATED_NOTE)
    expect(elevated.textContent).toContain(UAC_NOTE)

    // Copy goes through core (shell_copy, never executed); then "I ran it → Re-check" probes Codex again.
    await click(within(elevated).getByTestId(`recovery-${ELEVATED_ACTION.id}`))
    expect(mock.callsOf('recovery.execute').at(-1)).toEqual({ actionId: ELEVATED_ACTION.id })
    listed = [claudeReady, reprobed(codex({ sandbox: 'ready' }), 60_000)]
    await click(within(elevated).getByTestId(`recheck-${ELEVATED_ACTION.id}`))
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'codex', force: true }])
    expect(phase()).toBe('ready')
    expect(status()).toBe('Codex sandbox ready')
    expect(screen.queryByTestId('setup-codex-sandbox-elevated')).toBeNull()
  })

  it('says why when core’s setup finished but the sandbox still is not ready', async () => {
    upsertProbes([claudeReady, codex()])
    const setup = pendingSetup()
    await mountCard()
    await click(button())
    listed = [claudeReady, reprobed(codex())]
    await act(async () => {
      setup.answer(
        setupResult(
          setupOutcome({ ok: true, ready: false, stillNotReady: 'readiness still answers notConfigured' }),
          'The setup finished, but Codex still reports the sandbox is not ready. Try the elevated setup command.',
        ),
      )
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(phase()).toBe('failed')
    expect(status()).toBe('Setup did not finish: readiness still answers notConfigured.')
    expect(screen.queryByTestId('setup-codex-sandbox-elevated')).toBeNull()
    await click(screen.getByTestId('setup-codex-sandbox-more'))
    expect(screen.getByTestId('setup-codex-sandbox-elevated')).toBeTruthy()
  })

  it('an error from core (another setup running) ends the progress with core’s message', async () => {
    upsertProbes([claudeReady, codex()])
    mock.on('recovery.execute', () => {
      throw mockError('CONFLICT', 'The Codex sandbox setup is already running.')
    })
    await mountCard()
    await click(button())
    expect(phase()).toBe('failed')
    expect(status()).toBe('Setup did not finish: The Codex sandbox setup is already running.')
    expect(toasts().at(-1)).toBe(
      'Codex sandbox: Setup did not finish: The Codex sandbox setup is already running.',
    )
  })

  it('a core without the executor: the button reads "Available in a later version" from then on', async () => {
    upsertProbes([claudeReady, codex()])
    mock.on('recovery.execute', () => {
      throw mockError('UNSUPPORTED', 'The sandbox setup is not available here.')
    })
    await mountCard()
    await click(button())
    expect(button().disabled).toBe(true)
    expect(screen.getByRole('group', { name: `${SANDBOX_SET_UP_LABEL} ${LATER_VERSION}` })).toBeTruthy()
  })

  it('a ready sandbox: the chip is its status line alone, nothing to set up', async () => {
    // (Claude still needs a login, so the card shows: with both vendors ready it would not.) Live stage A: the
    // everyday Codex profile read ready, and the disabled button left its line "Codex s…"; tests/renderer/codex/
    // sandboxChipReady.test.tsx holds the layout.
    upsertProbes([probeView('claude', 'login-needed'), codex({ sandbox: 'ready' })])
    await mountCard()
    expect(phase()).toBe('ready')
    expect(status()).toBe('Codex sandbox ready')
    expect(screen.queryByTestId('setup-codex-sandbox')).toBeNull()
    expect(screen.queryByTestId('setup-codex-sandbox-more')).toBeNull()
    expect(screen.queryByRole('group', { name: /The Codex sandbox is set up/ })).toBeNull()
  })

  it('Codex not installed: "Install Codex first"; a build without Codex: a later version', async () => {
    upsertProbes([
      claudeReady,
      probeView('codex', 'not-installed', { healthDetail: 'Not installed', probe: null }),
    ])
    await mountCard()
    expect(screen.getByRole('group', { name: `${SANDBOX_SET_UP_LABEL} Install Codex first` })).toBeTruthy()
    act(() =>
      upsertProbes([
        probeView('codex', 'not-built', { built: false, healthDetail: 'Not available in this build' }),
      ]),
    )
    expect(screen.getByRole('group', { name: `${SANDBOX_SET_UP_LABEL} ${LATER_VERSION}` })).toBeTruthy()
  })

  it('an unavailable sandbox check is the chip’s too: the row does not repeat its command', async () => {
    upsertProbes([claudeReady, codex({ sandbox: 'unavailable' })])
    await mountCard()
    const row = screen.getByTestId('setup-vendor-codex')
    expect(row.textContent).toContain(SANDBOX_BELOW)
    expect(within(row).queryByTestId(`recovery-${ELEVATED_ACTION.id}`)).toBeNull()
  })

  it('a readiness Codex cannot report: no setup to run, the elevated command offered at once', async () => {
    upsertProbes([claudeReady, codex({ sandbox: 'unavailable' })])
    await mountCard()
    expect(phase()).toBe('unavailable')
    expect(button().disabled).toBe(true)
    expect(status()).toBe('Codex Windows sandbox unavailable')
    // Offered at once behind its disclosure (enabled), opened by the user.
    expect(screen.getByTestId<HTMLButtonElement>('setup-codex-sandbox-more').disabled).toBe(false)
    await click(screen.getByTestId('setup-codex-sandbox-more'))
    expect(screen.getByTestId('setup-codex-sandbox-elevated').textContent).toContain(
      'codex sandbox setup --elevated --current-user',
    )
  })

  it('review: while Codex has not reported, the chip is its line alone; core’s answer brings the button and the disclosure', async () => {
    upsertProbes([claudeReady, probeView('codex', 'checking', { checking: true, probe: null })])
    await mountCard()
    expect(phase()).toBe('unknown')
    expect(status()).toBe('Checking Codex…')
    // Nothing held under the line while Codex is checked (a sandbox ready at launch leaves no empty room).
    expect(screen.queryByTestId('setup-codex-sandbox')).toBeNull()
    expect(screen.queryByTestId('setup-codex-sandbox-more')).toBeNull()
    act(() => upsertProbes([codex()]))
    await settle()
    expect(button().disabled).toBe(false)
    const more = screen.getByTestId<HTMLButtonElement>('setup-codex-sandbox-more')
    expect(more.disabled).toBe(false)
    expect(more.parentElement?.className).not.toContain('invisible')
    expect(screen.queryByTestId('setup-codex-sandbox-elevated')).toBeNull()
  })

  it('review: once Codex has answered without a setup to offer, the disclosure’s row is held (invisible)', async () => {
    upsertProbes([
      claudeReady,
      probeView('codex', 'not-installed', { healthDetail: 'Not installed', probe: null }),
    ])
    await mountCard()
    expect(phase()).toBe('unknown')
    expect(button().disabled).toBe(true)
    const held = screen.getByTestId<HTMLButtonElement>('setup-codex-sandbox-more')
    expect(held.disabled).toBe(true)
    expect(held.parentElement?.className).toContain('invisible')
    expect(held.parentElement?.getAttribute('aria-hidden')).toBe('true')
  })

  it('is not shown off Windows', async () => {
    tearDown(mock)
    install('darwin')
    upsertProbes([claudeReady, codex({ sandbox: 'none', health: 'ready' })])
    await mountCard()
    expect(screen.queryByTestId('setup-codex-sandbox')).toBeNull()
  })
})

describe('the chip in Settings → Vendors and on a run’s check', () => {
  it('shares one setup per vendor: a second chip shows the same progress and does not start another', async () => {
    upsertProbes([codex()])
    const setup = pendingSetup()
    render(
      <Providers>
        <SandboxChip testId="a" />
        <SandboxChip testId="b" check={sandboxCheck('notConfigured')} ctx={{ folder: 'C:\\work\\repo' }} />
      </Providers>,
    )
    await settle()
    await click(button('a'))
    expect(phase('a')).toBe('running')
    expect(phase('b')).toBe('running')
    fireEvent.click(button('b'))
    await settle()
    expect(setupCalls()).toHaveLength(1)
    listed = [reprobed(codex({ sandbox: 'ready' }))]
    await act(async () => {
      setup.answer(setupResult(setupOutcome(), SET_UP_MESSAGE))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(phase('a')).toBe('ready')
    expect(phase('b')).toBe('ready')
  })

  it('sends the folder it was offered for, and checks again after', async () => {
    upsertProbes([codex()])
    const onRecheck = vi.fn()
    mock.on('recovery.execute', () => setupResult(setupOutcome(), SET_UP_MESSAGE))
    listed = [reprobed(codex({ sandbox: 'ready' }))]
    render(
      <Providers>
        <SandboxChip
          testId="c"
          check={sandboxCheck('notConfigured')}
          ctx={{ folder: 'C:\\work\\repo' }}
          onRecheck={onRecheck}
        />
      </Providers>,
    )
    await settle()
    await click(button('c'))
    expect(setupCalls()).toEqual([{ actionId: SETUP_ACTION.id, folder: 'C:\\work\\repo' }])
    expect(onRecheck).toHaveBeenCalledTimes(1)
    expect(phase('c')).toBe('ready')
  })

  it('forces a probe only when core’s probe is not newer than the one before the click', async () => {
    upsertProbes([codex()])
    mock.on('recovery.execute', () => setupResult(setupOutcome({ ok: true, ready: false }), 'Not yet.'))
    listed = [codex()]
    render(
      <Providers>
        <SandboxChip testId="d" />
      </Providers>,
    )
    await settle()
    await click(button('d'))
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'codex', force: true }])
    expect(phase('d')).toBe('failed')
  })
})

describe('reading core', () => {
  it('reads core’s setup outcome defensively', () => {
    expect(setupOutcomeOf({ kind: 'vendor_setup' })).toBeUndefined()
    expect(setupOutcomeOf({ setup: { ok: 'yes', ready: true } })).toBeUndefined()
    expect(setupOutcomeOf({ setup: { ok: true, ready: false, stillNotReady: 'x' } })).toEqual({
      vendor: '',
      ok: true,
      ready: false,
      detail: '',
      probed: false,
      stillNotReady: 'x',
    })
  })

  it('names why a setup did not leave the sandbox ready', () => {
    const view = codex()
    expect(outcomeReason(setupOutcome({ ready: false, stillNotReady: 'still notConfigured' }), view)).toBe(
      'still notConfigured',
    )
    expect(outcomeReason(setupOutcome({ ok: false, ready: false, detail: 'Access is denied.' }), view)).toBe(
      'Access is denied.',
    )
    expect(outcomeReason(setupOutcome({ ready: false, probed: false }), view)).toBe(
      'Dim Factory could not check the sandbox again',
    )
    expect(outcomeReason(setupOutcome({ ready: false }), view)).toBe(WIN_SANDBOX_SETUP_DETAIL)
  })

  it('takes the phase from core’s probe, the setup the user started, and the check offered', () => {
    const needed = codex()
    const ready = codex({ sandbox: 'ready' })
    expect(sandboxPhase(needed, undefined)).toBe('needed')
    expect(sandboxPhase(ready, undefined)).toBe('ready')
    expect(sandboxPhase(needed, { state: 'running', actionId: 'x', startedAt: 0 })).toBe('running')
    expect(sandboxPhase(needed, { state: 'failed', actionId: 'x', at: 0, message: '' })).toBe('failed')
    // Core's probe reading ready wins over a failed setup (the user ran the elevated command since).
    expect(sandboxPhase(ready, { state: 'failed', actionId: 'x', at: 0, message: '' })).toBe('ready')
    expect(sandboxPhase(codex({ sandbox: 'none' }), undefined)).toBe('unknown')
    // A preflight check offering the setup, before the vendor's probe has a sandbox check.
    expect(sandboxPhase(undefined, undefined, sandboxCheck('notConfigured'))).toBe('needed')
    expect(sandboxPhase(codex({ sandbox: 'unavailable' }), undefined)).toBe('unavailable')
  })
})
