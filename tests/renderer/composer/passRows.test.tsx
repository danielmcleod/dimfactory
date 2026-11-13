// Quick composer pass rows ("Pass rows", "Fix row", "Also", footer; provenance, Save → minimal diff + undo,
// the Critic-swap rule): collapsed lines from core's resolve, provenance badges with run overrides
// in amber, Save to project (config.save row) + Undo, Reset + Undo, Auto gating "Approve everything", read-only
// passes, the Fix session choice, the vendor picker, gates, isolation controls, the Critic swap and the footer save.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigWriteResult } from '@shared/ipc.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  check,
  fakeResolve,
  FOLDER,
  mountComposer,
  probe,
  PROJECT_FILE,
  report,
  runEstimate,
} from './fixtures.tsx'

let mock: MockDimFactory

const written = (over: Partial<ConfigWriteResult> = {}): ConfigWriteResult => ({
  path: PROJECT_FILE,
  changed: true,
  diff: '',
  backupId: 'b1',
  ...over,
})

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'config.save': () => written(),
      'config.restoreBackup': () => written(),
      'config.patch': () => written(),
    },
  })
  upsertProbes([probe('claude', 'ready'), probe('codex', 'ready', { built: false })])
})

afterEach(() => tearDown(mock))

async function ready(): Promise<void> {
  await mountComposer()
  await settle(300)
}

async function openPasses(): Promise<void> {
  fireEvent.click(screen.getByTestId('composer-passes-toggle'))
  await settle()
}

async function openRow(pass: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId(`pass-row-toggle-${pass}`))
  await settle()
  return screen.getByTestId(`pass-row-${pass}`)
}

async function pick(testId: string, option: string | RegExp): Promise<void> {
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
  })
  await settle()
  act(() => {
    fireEvent.keyDown(screen.getByRole('option', { name: option }), { key: 'Enter' })
  })
  await settle(300)
}

async function optionsOf(testId: string): Promise<{ name: string; disabled: boolean }[]> {
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
  })
  await settle()
  const out = screen.getAllByRole('option').map((o) => ({
    name: o.textContent ?? '',
    disabled: o.getAttribute('aria-disabled') === 'true' || o.hasAttribute('data-disabled'),
  }))
  act(() => {
    fireEvent.keyDown(screen.getAllByRole('option')[0] as HTMLElement, { key: 'Escape' })
  })
  await settle()
  return out
}

const lastResolve = () => mock.callsOf('config.resolve').at(-1)
const text = (id: string) => screen.getByTestId(id).textContent

async function setModel(pass: string, model: string): Promise<void> {
  const box = screen.getByTestId<HTMLInputElement>(`pass-model-${pass}`)
  fireEvent.change(box, { target: { value: model } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await settle(300)
}

describe('pass rows from config.resolve', () => {
  it('summarizes the profile and shows each pass as one collapsed line with core values', async () => {
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.passes.critic.enabled = false) }))
    mock.on('estimates.get', () => runEstimate())
    await ready()
    expect(text('composer-passes')).toBe(
      'Plan · Claude · opus · Implement · Claude · default · Review · Claude · sonnet · Fix · Claude · default',
    )
    expect(screen.queryByTestId('pass-row-plan')).toBeNull()
    await openPasses()
    expect(screen.getByTestId('composer-passes-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(text('pass-summary-plan')).toBe('Plan · Claude · opus · Native plan')
    expect(text('pass-summary-implement')).toBe('Implement · Claude · CLI default · Approve edits')
    expect(text('pass-summary-review')).toBe('Review · Claude · sonnet · Read-only')
    expect(text('pass-summary-critic')).toBe('Critic · off')
    expect(text('pass-summary-fix')).toBe("Fix · Claude · CLI default · Reuse Implement's session")
    // Each row ends with core's step estimate (`~2 min · ~$0.08`).
    expect(screen.getByTestId('pass-row-plan').textContent).toContain('~1 min · ~$0.05')
    expect(screen.getByTestId('pass-row-toggle-plan').textContent).toContain('▾')
  })

  it('reads "Plan template" when core says Plan has no native mode', async () => {
    mock.on('preflight.run', () =>
      report({ info: [check('pass.plan.native', { title: 'Plan uses the plan template' })] }),
    )
    await ready()
    await openPasses()
    expect(text('pass-summary-plan')).toBe('Plan · Claude · opus · Plan template')
  })

  it('shows a provenance badge per field, and a run override in amber once core resolved it', async () => {
    await ready()
    await openPasses()
    await openRow('plan')
    const vendor = screen.getByTestId('pass-provenance-plan-vendor')
    expect(vendor.getAttribute('data-source')).toBe('user')
    expect(vendor.textContent).toBe('user')
    expect(vendor.getAttribute('aria-label')).toBe('user: Your settings: C:\\home\\dimfactory.json:4')
    expect(screen.getByTestId('pass-provenance-plan-model').textContent).toBe('profile')
    await openRow('review')
    expect(screen.getByTestId('pass-provenance-review-model').getAttribute('data-source')).toBe('project')
    expect(screen.queryByTestId('composer-override-count')).toBeNull()

    await setModel('plan', 'sonnet')
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { passes: { plan: { model: 'sonnet' } } } })
    const badge = screen.getByTestId('pass-provenance-plan-model')
    expect(badge.getAttribute('data-source')).toBe('run')
    expect(badge.textContent).toBe('run')
    expect(badge.querySelector('[data-slot="badge"]')?.className).toContain('text-auto')
    expect(screen.getByTestId('pass-row-plan').getAttribute('data-run-override')).toBe('true')
    expect(text('composer-override-count')).toBe('1 run override')
    expect(text('pass-summary-plan')).toBe('Plan · Claude · sonnet · Native plan')
    // The overrides go to the live checks and the run as they are.
    expect(mock.callsOf('preflight.run').at(-1)).toEqual({
      folder: FOLDER,
      overrides: { passes: { plan: { model: 'sonnet' } } },
    })
  })

  it('refuses a model id the config would reject, and says why', async () => {
    await ready()
    await openPasses()
    await openRow('plan')
    const before = mock.callsOf('config.resolve').length
    await setModel('plan', 'opus 4')
    expect(screen.getByRole('alert').textContent).toBe('Use letters, digits and . : @ / [ ] - _ only.')
    expect(mock.callsOf('config.resolve')).toHaveLength(before)
    // An empty box is the CLI default (null).
    await setModel('plan', '')
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { passes: { plan: { model: null } } } })
  })

  it('shows a "no pricing" chip for a model core cannot price', async () => {
    mock.on('vendors.models', () => [
      { id: 'opus', source: 'cli', hasPricing: true },
      { id: 'mystery-1', source: 'cli', hasPricing: false },
    ])
    mock.on('estimates.get', () => runEstimate({ missingPricing: ['claude/haiku-x'] }))
    await ready()
    await openPasses()
    await openRow('plan')
    fireEvent.focus(screen.getByTestId('pass-model-plan'))
    await settle()
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'claude' }])
    expect(screen.queryByTestId('pass-no-pricing-plan')).toBeNull()
    await setModel('plan', 'mystery-1')
    expect(screen.getByTestId('pass-no-pricing-plan').textContent).toBe('no pricing')
    await setModel('plan', 'haiku-x')
    expect(screen.getByTestId('pass-no-pricing-plan')).toBeTruthy()
    await setModel('plan', 'opus')
    expect(screen.queryByTestId('pass-no-pricing-plan')).toBeNull()
  })
})

describe('Save to project and Reset', () => {
  it('saves one row with config.save (mode row), drops its run overrides, and Undo restores both', async () => {
    await ready()
    await openPasses()
    await openRow('plan')
    expect(screen.getByTestId<HTMLButtonElement>('pass-save-plan').disabled).toBe(true)
    await setModel('plan', 'sonnet')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pass-save-plan'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(mock.callsOf('config.save')).toEqual([
      {
        scope: 'project',
        folder: FOLDER,
        overrides: { passes: { plan: { model: 'sonnet' } } },
        mode: 'row',
        pass: 'plan',
      },
    ])
    expect(lastResolve()).toEqual({ folder: FOLDER })
    const toastItem = useStore.getState().toasts.items.at(-1)
    expect(toastItem?.message).toBe(`Saved Plan to ${PROJECT_FILE}`)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(mock.callsOf('config.restoreBackup')).toEqual([
      { scope: 'project', folder: FOLDER, backupId: 'b1' },
    ])
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { passes: { plan: { model: 'sonnet' } } } })
  })

  it('undoes a save that created the project file by removing what it wrote', async () => {
    mock.on('config.save', () => written({ backupId: null }))
    await ready()
    await openPasses()
    await openRow('review')
    await setModel('review', 'opus')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pass-save-review'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'project', folder: FOLDER, ops: [{ op: 'remove', path: '/passes/review/model' }] },
    ])
  })

  it('shows core’s error and keeps the overrides when the save is refused', async () => {
    mock.on('config.save', () => {
      throw mockError('VALIDATION', 'The change would make dimfactory.json invalid')
    })
    await ready()
    await openPasses()
    await openRow('plan')
    await setModel('plan', 'sonnet')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pass-save-plan'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(useStore.getState().toasts.items.at(-1)).toMatchObject({
      level: 'error',
      message: 'The change would make dimfactory.json invalid',
    })
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { passes: { plan: { model: 'sonnet' } } } })
  })

  it('Reset drops the row’s run overrides; Undo puts them back', async () => {
    await ready()
    await openPasses()
    const row = await openRow('implement')
    expect(within(row).getByTestId<HTMLButtonElement>('pass-reset-implement').disabled).toBe(true)
    await setModel('implement', 'opus')
    fireEvent.click(screen.getByTestId('pass-reset-implement'))
    await settle(300)
    expect(lastResolve()).toEqual({ folder: FOLDER })
    expect(useStore.getState().toasts.items.at(-1)?.message).toBe("Implement reset to the folder's settings")
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { passes: { implement: { model: 'opus' } } } })
  })

  it('offers the footer save with the rows hidden once Auto or the profile is overridden', async () => {
    await ready()
    expect(screen.queryByTestId('save-project-default')).toBeNull()
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(300)
    expect(screen.queryByTestId('pass-row-plan')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-project-default'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('config.save')).toEqual([
      { scope: 'project', folder: FOLDER, overrides: { auto: true }, mode: 'projectDefault' },
    ])
  })

  it('saves every override as the project default (mode projectDefault) with Undo', async () => {
    await ready()
    await openPasses()
    expect(screen.getByTestId<HTMLButtonElement>('save-project-default').disabled).toBe(true)
    fireEvent.click(screen.getByTestId('gate-before-fix'))
    await settle(300)
    await openRow('plan')
    await setModel('plan', 'sonnet')
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-project-default'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(mock.callsOf('config.save')).toEqual([
      {
        scope: 'project',
        folder: FOLDER,
        overrides: { gates: { beforeFix: true }, passes: { plan: { model: 'sonnet' } } },
        mode: 'projectDefault',
      },
    ])
    expect(lastResolve()).toEqual({ folder: FOLDER })
    expect(useStore.getState().toasts.items.at(-1)?.message).toBe(
      `Saved as the project default in ${PROJECT_FILE}`,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(mock.callsOf('config.restoreBackup')).toHaveLength(1)
    expect(lastResolve()).toEqual({
      folder: FOLDER,
      overrides: { gates: { beforeFix: true }, passes: { plan: { model: 'sonnet' } } },
    })
  })
})

describe('mode, on/off and Auto', () => {
  it('offers "Approve everything" only while Auto is on (core then resolves Implement to it)', async () => {
    await ready()
    await openPasses()
    await openRow('implement')
    expect((await optionsOf('pass-mode-implement')).map((o) => o.name)).toEqual([
      'Read-only',
      'Approve edits',
    ])
    await pick('pass-mode-implement', 'Read-only')
    expect(lastResolve()).toEqual({
      folder: FOLDER,
      overrides: { passes: { implement: { mode: 'readonly' } } },
    })
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(300)
    const trigger = screen.getByTestId<HTMLButtonElement>('pass-mode-implement')
    expect(trigger.textContent).toBe('Approve everything')
    expect(trigger.disabled).toBe(true)
    expect(screen.getByTestId('pass-provenance-implement-mode').getAttribute('data-source')).toBe('auto')
    expect(
      screen.getByLabelText(
        'Implement mode: Approve everything. Auto approves everything for Implement and Fix. Turn Auto off to choose.',
      ),
    ).toBeTruthy()
  })

  it('keeps read-only passes read-only: the only mode is Read-only and it cannot change', async () => {
    await ready()
    await openPasses()
    for (const pass of ['plan', 'review', 'critic']) {
      await openRow(pass)
      const trigger = screen.getByTestId<HTMLButtonElement>(`pass-mode-${pass}`)
      expect(trigger.textContent).toBe('Read-only')
      expect(trigger.disabled).toBe(true)
    }
    expect(screen.getByLabelText('Review mode: Read-only. Review always runs read-only')).toBeTruthy()
  })

  it('turns a pass off and on as a run override', async () => {
    await ready()
    await openPasses()
    await openRow('critic')
    fireEvent.click(screen.getByTestId('pass-enabled-critic'))
    await settle(300)
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { passes: { critic: { enabled: false } } } })
    expect(text('pass-summary-critic')).toBe('Critic · off')
    expect(screen.getByTestId('pass-provenance-critic-enabled').getAttribute('data-source')).toBe('run')
  })
})

describe('vendor picker and the Fix row', () => {
  it('lists Claude and Codex first, then More; not-installed greyed with the install command; unbuilt disabled', async () => {
    upsertProbes([probe('gemini', 'not-installed'), probe('grok', 'ready', { built: false })])
    await ready()
    await openPasses()
    await openRow('review')
    const opts = await optionsOf('pass-vendor-review')
    expect(opts).toEqual([
      { name: 'Claude', disabled: false },
      { name: 'Codex · Not available in this build', disabled: true },
      { name: 'Gemini · Not installed', disabled: true },
      { name: 'Grok · Not available in this build', disabled: true },
    ])
    act(() => {
      fireEvent.keyDown(screen.getByTestId('pass-vendor-review'), { key: 'Enter' })
    })
    await settle()
    expect(screen.getByRole('option', { name: 'Gemini · Not installed' }).getAttribute('title')).toBe(
      'npm install -g gemini-cli',
    )
  })

  it('changing the vendor sets it with the CLI default model as run overrides', async () => {
    upsertProbes([probe('codex', 'ready')])
    await ready()
    await openPasses()
    await openRow('review')
    await pick('pass-vendor-review', 'Codex')
    expect(lastResolve()).toEqual({
      folder: FOLDER,
      overrides: { passes: { review: { vendor: 'codex', model: null, effort: null } } },
    })
    expect(text('pass-summary-review')).toBe('Review · Codex · CLI default · Read-only')
  })

  it('offers Reuse / Fresh / Fresh, different vendor and maps them to reuseSession + vendor', async () => {
    await ready()
    await openPasses()
    await openRow('fix')
    // No other vendor is ready yet: "Fresh, different vendor" is unavailable.
    expect(await optionsOf('fix-session')).toEqual([
      { name: "Reuse Implement's session", disabled: false },
      { name: 'Fresh session', disabled: false },
      { name: 'Fresh, different vendor · no other vendor is ready', disabled: true },
    ])
    await pick('fix-session', 'Fresh session')
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { passes: { fix: { reuseSession: false } } } })
    expect(text('pass-summary-fix')).toBe('Fix · Claude · CLI default · Fresh session')

    act(() => upsertProbes([probe('codex', 'ready')]))
    await settle(300)
    await pick('fix-session', 'Fresh, different vendor (Codex)')
    expect(lastResolve()).toEqual({
      folder: FOLDER,
      overrides: { passes: { fix: { reuseSession: false, vendor: 'codex', model: null, effort: null } } },
    })
    expect(text('pass-summary-fix')).toBe('Fix · Codex · CLI default · Fresh, different vendor')
    await pick('fix-session', "Reuse Implement's session")
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { passes: { fix: { reuseSession: true } } } })
  })

  it("shows core's reason when Fix cannot reuse the session", async () => {
    mock.on('preflight.run', () =>
      report({
        info: [
          check('pass.fix.resume', {
            title: 'Fix starts a fresh session',
            detail: 'Fix runs on Codex and Implement on Claude.',
          }),
        ],
      }),
    )
    await ready()
    await openPasses()
    await openRow('fix')
    expect(text('fix-session-note')).toBe(
      'Fix starts a fresh session · Fix runs on Codex and Implement on Claude.',
    )
  })
})

describe('gates, isolation and the Critic swap', () => {
  it('states the gates as core resolved them and toggles them as run overrides; Auto turns them off', async () => {
    await ready()
    await openPasses()
    expect(text('gates-text')).toBe('Stops after Plan · runs Fix without stopping')
    fireEvent.click(screen.getByTestId('gate-before-fix'))
    await settle(300)
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { gates: { beforeFix: true } } })
    expect(text('gates-text')).toBe('Stops after Plan · stops before Fix')
    expect(screen.getByTestId('gate-provenance-beforeFix').getAttribute('data-source')).toBe('run')
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(300)
    expect(text('gates-text')).toBe('Auto: runs through without stopping')
    expect(screen.getByTestId<HTMLButtonElement>('gate-after-plan').disabled).toBe(true)
  })

  it('renders In place, Isolated run, New run branch and Verify, all live', async () => {
    await ready()
    await openPasses()
    expect(screen.getByTestId('isolation-inplace').getAttribute('aria-pressed')).toBe('true')
    // New run branch is a live run override (tests/renderer/run-branch/composerBranch.test.tsx).
    expect(screen.getByTestId<HTMLButtonElement>('run-branch').disabled).toBe(false)
    // Isolated run is a live run override (tests/renderer/isolated-runs/composerIsolation.test.tsx).
    const el = screen.getByTestId<HTMLButtonElement>('isolation-worktree')
    expect(el.disabled).toBe(false)
    expect(el.closest('[data-disabled-hint]')).toBeNull()
    expect(el.getAttribute('aria-pressed')).toBe('false')
    // Verify is a live run override (tests/renderer/verify/composerVerify.test.tsx).
    expect(screen.getByTestId<HTMLButtonElement>('verify-enabled').disabled).toBe(false)
    expect(screen.getByTestId('verify-enabled').closest('[data-disabled-hint]')).toBeNull()
    expect(text('verify-commands')).toBe('Verify: no commands')
    expect(screen.queryByTestId('isolation-warning')).toBeNull()
  })

  it('lets a project that defaults to an isolated run run in place, with the uncommitted-changes warning shown', async () => {
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.isolation.mode = 'worktree') }))
    await ready()
    await openPasses()
    expect(text('isolation-warning')).toContain(
      'Uncommitted changes in this folder are not copied into the run.',
    )
    fireEvent.click(screen.getByTestId('isolation-inplace'))
    await settle(300)
    expect(lastResolve()).toEqual({ folder: FOLDER, overrides: { isolation: { mode: 'inPlace' } } })
    expect(screen.queryByTestId('isolation-warning')).toBeNull()
  })

  it('offers [Swap Critic to X] only when Critic shares Implement’s vendor and another vendor is ready', async () => {
    await ready()
    // Only Claude is ready: no suggestion.
    expect(screen.queryByTestId('critic-swap')).toBeNull()
    act(() => upsertProbes([probe('codex', 'ready')]))
    await settle(300)
    expect(text('critic-swap')).toBe('Swap Critic to Codex')
    fireEvent.click(screen.getByTestId('critic-swap'))
    await settle(300)
    expect(lastResolve()).toEqual({
      folder: FOLDER,
      overrides: { passes: { critic: { vendor: 'codex', model: null } } },
    })
    // Critic now differs from Implement: the chip is gone. Undo brings both back.
    expect(screen.queryByTestId('critic-swap')).toBeNull()
    expect(useStore.getState().toasts.items.at(-1)?.message).toBe('Critic runs on Codex for this run')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(300)
    expect(lastResolve()).toEqual({ folder: FOLDER })
    expect(screen.getByTestId('critic-swap')).toBeTruthy()
  })

  it('never offers the swap for a vendor that cannot run read-only', async () => {
    upsertProbes([probe('codex', 'ready', { modes: { readonly: { status: 'unsupported', copy: 'no' } } })])
    await ready()
    expect(screen.queryByTestId('critic-swap')).toBeNull()
  })
})
