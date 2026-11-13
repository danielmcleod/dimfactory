// components/recovery/RecoveryActions (recovery actions, the executors): every kind runs
// through recovery.execute; shell_copy → "Copied. Run it in a terminal." → [I ran it → Re-check] (forced probe of
// the vendor, then onRecheck); settings_link navigates to core's route; open_docs; later kinds disabled; core's
// errors as toasts; the fallbacks when core answers UNSUPPORTED or does not know the action.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { RecoveryResult } from '@shared/ipc.ts'
import {
  COPIED_ELEVATED_MESSAGE,
  COPIED_MESSAGE,
  ELEVATED_NOTE,
  OPENED_MESSAGE,
  RECHECK_LABEL,
  recheckVendor,
  routeHash,
  settingsLinkHref,
} from '@renderer/components/recovery/execute.ts'
import { RecoveryActions, resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import type { RecoveryActionsProps } from '@renderer/components/recovery/RecoveryActions.tsx'
import { useStore } from '@renderer/state/store.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, settle, setUp, tearDown } from '../dashboard/setup.tsx'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp()
  resetRecoveryForTests()
})

afterEach(() => {
  resetRecoveryForTests()
  tearDown(mock)
})

const login: RecoveryAction = {
  id: 'claude.login',
  label: 'Copy the login command',
  kind: 'shell_copy',
  command: 'claude auth login',
  shell: 'powershell',
  reason: 'Log in to Claude Code',
  recheck: 'vendor.claude.auth',
}
const sandbox: RecoveryAction = {
  id: 'codex.sandbox',
  label: 'Copy the sandbox setup command',
  kind: 'shell_copy',
  command: 'codex sandbox setup --elevated --current-user',
  shell: 'powershell',
  reason: 'Set up the Windows sandbox',
  elevated: true,
  recheck: 'vendor.codex.winSandbox',
}
const setPath: RecoveryAction = {
  id: 'claude.set-path',
  label: 'Set the Claude Code path',
  kind: 'settings_link',
  route: 'settings/vendors',
  pointer: '/vendors/claude/path',
}
const docs: RecoveryAction = {
  id: 'claude.docs',
  label: 'Open the setup guide',
  kind: 'open_docs',
  url: 'https://code.claude.com/docs/en/setup',
}
const retry: RecoveryAction = { id: 'implement:retry', label: 'Retry', kind: 'retry', strategy: 'auto' }
const switchVendor: RecoveryAction = {
  id: 'claude.switch-vendor',
  label: 'Use Codex instead',
  kind: 'switch_vendor',
  pass: 'all',
  to: 'codex',
  model: null,
}

function stubClipboard(): { writes: string[] } {
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (t: string) => {
        writes.push(t)
        return Promise.resolve()
      },
    },
  })
  return { writes }
}

async function mount(props: RecoveryActionsProps): Promise<void> {
  render(
    <Providers>
      <RecoveryActions {...props} />
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

const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)
const button = (id: string): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>(id)

describe('shell_copy → I ran it → Re-check', () => {
  it('copies through main, then re-probes the vendor and re-runs the caller', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({ kind: 'shell_copy', copied: 'claude auth login' }))
    mock.on('vendors.probe', () => [probeView('claude', 'ready', { healthDetail: 'Ready · 2.1.288' })])
    const onRecheck = vi.fn()
    await mount({ actions: [login], folder: 'C:\\work\\repo', onRecheck })
    expect(screen.getByText('claude auth login')).toBeTruthy()
    expect(screen.getByText('Log in to Claude Code')).toBeTruthy()

    const copy = button('recovery-claude.login')
    // One button for copy → re-check → checking: every label is reserved, so it never changes size.
    expect([...copy.querySelectorAll('[data-label]')].map((r) => r.getAttribute('data-label'))).toEqual([
      'Copy the login command',
      RECHECK_LABEL,
      'Checking…',
    ])
    await click(copy)
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'claude.login', folder: 'C:\\work\\repo' }])
    expect(toasts()).toContain(COPIED_MESSAGE)
    expect(COPIED_MESSAGE).toBe('Copied. Run it in a terminal.')
    expect(screen.queryByTestId('recovery-claude.login')).toBeNull()
    const again = button('recheck-claude.login')
    expect(again).toBe(copy)
    expect(again.textContent).toBe(RECHECK_LABEL)

    await click(again)
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(useStore.getState().probes.byVendor['claude']?.health).toBe('ready')
    expect(toasts()).toContain('Claude: Ready · 2.1.288')
    expect(onRecheck).toHaveBeenCalledTimes(1)
    // Back to the copy button, in case the check still fails.
    expect(button('recovery-claude.login')).toBeTruthy()
  })

  it('shows "Checking…" while the probe runs', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({ kind: 'shell_copy', copied: 'x' }))
    const hold = deferred<ReturnType<typeof probeView>[]>()
    mock.on('vendors.probe', () => hold.promise)
    await mount({ actions: [login] })
    await click(button('recovery-claude.login'))
    await click(button('recheck-claude.login'))
    expect(button('recheck-claude.login').textContent).toBe('Checking…')
    expect(button('recheck-claude.login').disabled).toBe(true)
    await act(async () => {
      hold.resolve([probeView('claude', 'login-needed')])
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(toasts()).toContain('Claude: Login needed')
    expect(useStore.getState().toasts.items.at(-1)?.level).toBe('warn')
  })

  it('says to use an administrator terminal for an elevated command', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({ kind: 'shell_copy', copied: 'x' }))
    await mount({ actions: [sandbox] })
    expect(screen.getByText(new RegExp(ELEVATED_NOTE))).toBeTruthy()
    await click(button('recovery-codex.sandbox'))
    expect(toasts()).toContain(COPIED_ELEVATED_MESSAGE)
    expect(COPIED_ELEVATED_MESSAGE).toBe('Copied. Run it in an administrator terminal.')
  })

  it('copies in the renderer when core cannot (UNSUPPORTED, or no record of the action)', async () => {
    const clip = stubClipboard()
    await mount({ actions: [login] })
    await click(button('recovery-claude.login'))
    expect(clip.writes).toEqual(['claude auth login'])
    expect(button('recheck-claude.login')).toBeTruthy()

    mock.on('recovery.execute', () => {
      throw mockError('NOT_FOUND', 'No such recovery action.')
    })
    await mount({ actions: [{ ...login, id: 'claude.login-2' }] })
    await click(button('recovery-claude.login-2'))
    expect(clip.writes).toEqual(['claude auth login', 'claude auth login'])
    expect(toasts()).not.toContain('No such recovery action.')
  })

  it('has no Re-check when there is nothing to re-check', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({ kind: 'shell_copy', copied: 'x' }))
    const git: RecoveryAction = { ...login, id: 'git.safe', recheck: 'folder.git' }
    await mount({ actions: [git] })
    await click(button('recovery-git.safe'))
    expect(toasts()).toContain(COPIED_MESSAGE)
    expect(screen.queryByTestId('recheck-git.safe')).toBeNull()
  })
})

describe('settings_link', () => {
  it("waits for core's route, then navigates to it without asking again", async () => {
    const route = '#/settings/vendors?field=%2Fvendors%2Fclaude%2Fpath'
    const hold = deferred<RecoveryResult>()
    mock.on('recovery.execute', () => hold.promise)
    await mount({ actions: [setPath] })
    expect(button('recovery-claude.set-path').disabled).toBe(true)
    await act(async () => {
      hold.resolve({ kind: 'settings_link', route })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(button('recovery-claude.set-path').disabled).toBe(false)
    await click(button('recovery-claude.set-path'))
    expect(window.location.hash).toBe(route)
    expect(mock.callsOf('recovery.execute')).toHaveLength(1)
  })

  it('renders disabled for a later version when core has no settings_link executor', async () => {
    await mount({ actions: [setPath], runId: 'r1' })
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'claude.set-path', runId: 'r1' }])
    expect(button('recovery-claude.set-path').disabled).toBe(true)
    expect(
      screen.getByRole('group', { name: 'Set the Claude Code path Available in a later version' }),
    ).toBeTruthy()
  })

  it("navigates to the action's own route when core has no record of it", async () => {
    mock.on('recovery.execute', () => {
      throw mockError('NOT_FOUND', 'No such recovery action.')
    })
    await mount({ actions: [setPath] })
    expect(button('recovery-claude.set-path').disabled).toBe(false)
    await click(button('recovery-claude.set-path'))
    expect(window.location.hash).toBe('#/settings/vendors?field=%2Fvendors%2Fclaude%2Fpath')
  })
})

describe('other kinds', () => {
  it('open_docs: says it opened the page in the browser', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'open_docs',
      url: docs.kind === 'open_docs' ? docs.url : '',
    }))
    await mount({ actions: [docs] })
    await click(button('recovery-claude.docs'))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'claude.docs' }])
    expect(toasts()).toContain(OPENED_MESSAGE)
  })

  it('open_docs falls back to shell.open when core cannot run it', async () => {
    mock.on('shell.open', () => undefined)
    await mount({ actions: [docs] })
    await click(button('recovery-claude.docs'))
    expect(mock.callsOf('shell.open')).toEqual([
      { target: 'url', url: 'https://code.claude.com/docs/en/setup' },
    ])
    expect(toasts()).toContain(OPENED_MESSAGE)
  })

  it('retry runs through recovery.execute with the run, then refetches the run', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({ kind: 'retry' }))
    mock.on('runs.get', () => {
      throw mockError('NOT_FOUND', 'gone')
    })
    await mount({ actions: [retry], runId: 'r1', step: 'implement' })
    await click(button('recovery-implement:retry'))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'implement:retry', runId: 'r1' }])
    expect(mock.callsOf('runs.retryPass')).toEqual([])
    expect(mock.callsOf('runs.get')).toEqual([{ runId: 'r1' }])
  })

  it("shows core's error as a toast", async () => {
    mock.on('recovery.execute', () => {
      throw mockError('CONFLICT', 'The pass is no longer failed.')
    })
    await mount({ actions: [retry], runId: 'r1', step: 'implement' })
    await click(button('recovery-implement:retry'))
    expect(toasts()).toContain('The pass is no longer failed.')
    expect(useStore.getState().toasts.items.at(-1)?.level).toBe('error')
  })

  it('renders kinds of a later version disabled, and keeps one primary button', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({ kind: 'retry' }))
    await mount({ actions: [retry, switchVendor, login], runId: 'r1', step: 'implement' })
    expect(button('recovery-claude.switch-vendor').disabled).toBe(true)
    expect(screen.getByRole('group', { name: 'Use Codex instead Available in a later version' })).toBeTruthy()
    const buttons = [retry, switchVendor, login].map((a) => button(`recovery-${a.id}`))
    expect(buttons.map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON'])
    expect(buttons.map((b) => b.className.includes('bg-primary'))).toEqual([true, false, false])
    // Keyboard: enabled actions are plain buttons in the tab order.
    expect(buttons[0]?.tabIndex).toBe(0)
  })

  it("'commands' layout: each command on its line with a [Copy] named after the action", async () => {
    const clip = stubClipboard()
    await mount({ actions: [login, switchVendor], layout: 'commands', check: { title: 'x', detail: 'y' } })
    const copy = screen.getByRole('button', { name: 'Copy: Copy the login command' })
    expect(copy.textContent).toBe('Copy')
    await click(copy)
    expect(clip.writes).toEqual(['claude auth login'])
    expect(button('recheck-claude.login')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Use Codex instead' }).disabled).toBe(true)
  })

  it('leaves out a reason that repeats the check', async () => {
    await mount({ actions: [login], check: { title: 'Log in to Claude Code', detail: '' } })
    expect(screen.queryByText('Log in to Claude Code')).toBeNull()
  })
})

describe('helpers', () => {
  it('reads the vendor of a check id and turns routes into hashes', () => {
    expect(recheckVendor('vendor.claude.auth')).toBe('claude')
    expect(recheckVendor('vendor.local-ollama.bin')).toBe('local-ollama')
    expect(recheckVendor('app.git')).toBeNull()
    expect(routeHash('#/settings/vendors')).toBe('#/settings/vendors')
    expect(routeHash('settings/vendors')).toBe('#/settings/vendors')
    expect(
      settingsLinkHref({
        id: 'c',
        label: 'Choose',
        kind: 'settings_link',
        route: 'composer',
        pointer: '/folder',
      }),
    ).toBe('#/?field=%2Ffolder')
  })
})
