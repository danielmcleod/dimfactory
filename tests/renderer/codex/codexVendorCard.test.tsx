// Settings → Vendors, the Codex card (path, version vs floor/testedUpTo, checks
// list with fixes, default model, Test = forced probe; the Codex probe (floor 0.147.0, recommended 0.160.0), the
// probe checks vendor.codex.{bin,version,auth,protocol,plan,winSandbox}, the mode table's honest copy; vendor_setup).
// Each mode reads as core's probe states it on this route; on Windows the Sandbox row holds the chip, and the checks
// list points at it instead of repeating its fixes.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigReadResult } from '@shared/ipc.ts'
import type { ModelOption, ProbeView } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { resetSandboxSetupForTests } from '@renderer/components/recovery/sandboxSetup.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { modeRows, SANDBOX_FIXES_ABOVE } from '@renderer/pages/settings/vendors/VendorCard.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  APP_SERVER_COPY,
  codex,
  CODEX_EXE,
  CODEX_MODELS,
  reprobed,
  SET_UP_MESSAGE,
  SETUP_ACTION,
  setupOutcome,
  setupResult,
  vcheck,
  EXEC_COPY,
  WIN_SANDBOX_AUTOEDIT_COPY,
  WIN_SANDBOX_FULL_COPY,
  WIN_SANDBOX_READONLY_COPY,
} from './fixtures.ts'

let mock: MockDimFactory
let listed: ProbeView[]

function readResult(value: unknown): ConfigReadResult {
  return {
    path: 'C:\\home\\dimfactory.json',
    exists: true,
    text: '{}',
    value,
    issues: [],
    version: 1,
    backups: [],
  }
}

const models: ModelOption[] = CODEX_MODELS.map((m) => ({ ...m, hasPricing: true }))

function install(platform: 'win32' | 'linux' = 'win32'): void {
  mock = setUp({
    platform,
    handlers: {
      'config.read': () => readResult({}),
      'config.patch': () => ({ path: 'C:\\home\\dimfactory.json', changed: true, diff: '', backupId: 'b1' }),
      'vendors.models': () => models,
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

async function mount(): Promise<void> {
  render(
    <Providers>
      <SettingsPage section="vendors" />
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

const card = (): HTMLElement => screen.getByTestId('settings-vendor-codex')
const modes = (): { mode: string | null; support: string | null; text: string }[] =>
  [...screen.getByTestId('vendor-modes-codex').querySelectorAll('li')].map((li) => ({
    mode: li.getAttribute('data-mode'),
    support: li.getAttribute('data-support'),
    text: li.textContent ?? '',
  }))

describe('the Codex card', () => {
  it('shows the version against the floor and tested-up-to, the route, the path and the health', async () => {
    upsertProbes([codex()])
    await mount()
    expect(within(card()).getByRole('heading', { name: 'Codex' })).toBeTruthy()
    expect(card().textContent).toContain('Sandbox setup needed')
    expect(card().textContent).toContain(
      '0.160.1 · at least 0.147.0 · recommended 0.160.0 · tested up to 0.160.1',
    )
    expect(card().textContent).toContain('app-server (codex-app-server)')
    expect(card().textContent).toContain(`In use: ${CODEX_EXE} (from PATH)`)
  })

  it('says what each mode does on this route, in core’s words: sandbox-gated, limited, not available', async () => {
    upsertProbes([codex()])
    await mount()
    expect(modes()).toEqual([
      { mode: 'readonly', support: 'degraded', text: `Read-only: Limited. ${WIN_SANDBOX_READONLY_COPY}` },
      {
        mode: 'autoedit',
        support: 'unsupported',
        text: `Approve edits: Not available. ${WIN_SANDBOX_AUTOEDIT_COPY}`,
      },
      // Full waits for the live X11 recording while the sandbox is not ready.
      {
        mode: 'full',
        support: 'unsupported',
        text: `Approve everything: Not available. ${WIN_SANDBOX_FULL_COPY}`,
      },
    ])
  })

  it('with the sandbox ready, Approve edits is sandbox-gated; on the exec route escalations are auto-denied', async () => {
    upsertProbes([codex({ sandbox: 'ready' })])
    await mount()
    expect(modes()[1]).toEqual({
      mode: 'autoedit',
      support: 'supported',
      text: `Approve edits: Yes. ${APP_SERVER_COPY.autoedit}`,
    })
    act(() => upsertProbes([codex({ sandbox: 'ready', route: 'exec' })]))
    expect(card().textContent).toContain('exec (codex-exec)')
    expect(modes()[1]).toEqual({
      mode: 'autoedit',
      support: 'degraded',
      text: `Approve edits: Limited. ${EXEC_COPY.autoedit}`,
    })
  })

  it('holds the sandbox chip in its Sandbox row; the checks list points there instead of repeating the fix', async () => {
    upsertProbes([codex()])
    await mount()
    const row = screen.getByTestId('vendor-sandbox-codex')
    const setup = within(row).getByTestId<HTMLButtonElement>('vendor-sandbox-setup-codex')
    expect(setup.disabled).toBe(false)
    expect(within(row).getByTestId('vendor-sandbox-setup-codex-status').textContent).toBe(
      'Codex Windows sandbox not set up',
    )
    const checks = within(card()).getByRole('list', { name: 'Codex checks' })
    expect(checks.textContent).toContain('Codex Windows sandbox not set up')
    expect(checks.textContent).toContain(SANDBOX_FIXES_ABOVE)
    expect(within(checks).queryByTestId(`recovery-${SETUP_ACTION.id}`)).toBeNull()
    // Every probe check is listed with its title.
    for (const t of ['Codex found', 'Codex 0.160.1', 'Logged in with ChatGPT', 'app-server protocol 0.160.0'])
      expect(checks.textContent).toContain(t)

    // Set up from the card: core's setup, then core's new probe reads the sandbox ready.
    mock.on('recovery.execute', () => setupResult(setupOutcome(), SET_UP_MESSAGE))
    listed = [reprobed(codex({ sandbox: 'ready' }))]
    await click(setup)
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: SETUP_ACTION.id }])
    expect(within(row).getByTestId('vendor-sandbox-setup-codex-status').textContent).toBe(
      'Codex sandbox ready',
    )
    expect(card().textContent).toContain('Ready · 0.160.1')
    expect(modes()[1]?.support).toBe('supported')
  })

  it('a failing check keeps its own fixes (Codex login: copy the command, then re-check)', async () => {
    const loginNeeded = codex({
      health: 'login-needed',
      checks: [
        vcheck('bin', { title: 'Codex found' }),
        vcheck('auth', {
          status: 'fail',
          blocking: true,
          category: 'auth_required',
          title: 'Codex needs you to log in',
          detail: 'codex login status: Not logged in',
          recovery: [
            {
              id: 'vendor.codex.auth.login',
              label: 'Copy the login command',
              kind: 'shell_copy',
              command: 'codex login',
              shell: 'powershell',
              reason: 'Log in to Codex',
              recheck: 'vendor.codex.auth',
            },
          ],
        }),
      ],
      over: { healthDetail: 'Login needed' },
    })
    upsertProbes([loginNeeded])
    mock.on('recovery.execute', () => ({ kind: 'shell_copy', copied: 'codex login' }))
    await mount()
    const checks = within(card()).getByRole('list', { name: 'Codex checks' })
    expect(checks.textContent).toContain('codex login')
    await click(within(checks).getByTestId('recovery-vendor.codex.auth.login'))
    listed = [reprobed(codex({ sandbox: 'ready' }))]
    await click(within(checks).getByTestId('recheck-vendor.codex.auth.login'))
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'codex', force: true }])
    expect(useStore.getState().probes.byVendor['codex']?.health).toBe('ready')
  })

  it('shows core’s version warning, and Test runs a forced probe', async () => {
    upsertProbes([
      codex({
        sandbox: 'ready',
        checks: [
          vcheck('version', {
            status: 'warn',
            title: 'Codex 0.161.0 is newer than tested (0.160.1)',
          }),
        ],
        over: { health: 'warning', healthDetail: 'Codex 0.161.0 is newer than tested (0.160.1)' },
      }),
    ])
    listed = [reprobed(codex({ sandbox: 'ready' }))]
    await mount()
    expect(screen.getByTestId('vendor-version-note-codex').textContent).toBe(
      'Codex 0.161.0 is newer than tested (0.160.1)',
    )
    await click(screen.getByTestId('vendor-test-codex'))
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'codex', force: true }])
    expect(card().textContent).toContain('Ready · 0.160.1')
  })

  it('lists Codex’s models for the default model, and writes the choice', async () => {
    upsertProbes([codex({ sandbox: 'ready' })])
    await mount()
    await settle()
    expect(mock.callsOf('vendors.models')).toContainEqual({ vendor: 'codex' })
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('vendor-default-model-codex'), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      "The CLI's default (gpt-5.1-codex)",
      'GPT-5.1 Codex (gpt-5.1-codex)',
      'GPT-5.1 Codex Mini (gpt-5.1-codex-mini)',
    ])
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('option', { name: 'GPT-5.1 Codex Mini (gpt-5.1-codex-mini)' }), {
        key: 'Enter',
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('config.patch')).toEqual([
      {
        scope: 'user',
        ops: [{ op: 'replace', path: '/vendors/codex/defaultModel', value: 'gpt-5.1-codex-mini' }],
      },
    ])
  })

  it('has no Sandbox row off Windows when core reports no sandbox check', async () => {
    tearDown(mock)
    install('linux')
    upsertProbes([codex({ sandbox: 'none', health: 'ready' })])
    await mount()
    expect(screen.queryByTestId('vendor-sandbox-codex')).toBeNull()
    expect(modes()[1]?.support).toBe('supported')
  })

  it('reads the modes core did not report as nothing to show', () => {
    const view = codex()
    expect(modeRows({ ...view, probe: null })).toEqual([])
    expect(modeRows(view).map((r) => r.mode)).toEqual(['readonly', 'autoedit', 'full'])
  })
})
