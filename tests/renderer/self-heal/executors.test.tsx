// Executor controls in components/recovery/RecoveryActions (recovery actions, the executors, the "Snag" card):
// config_patch shows its change before it is applied and pairs core's
// apply and save actions (Undo from core's backup), wait_until counts down on core's clock with Arm / Re-arm / Disarm
// and Retry now, grant says what it trusts (the vendorFolder grant runs), switch_vendor stays disabled with a
// reason until another vendor is ready, a run-less heal shows its outcome, and core's `disabledReason` disables any
// action. Every control keeps its width while its state changes.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonPatchOp, RecoveryAction } from '@shared/failure.ts'
import type { RecoveryResult } from '@shared/ipc.ts'
import type { WaitView } from '@shared/run.ts'
import {
  APPLY_NEXT_LABEL,
  APPLY_RUN_LABEL,
  opsPreview,
  previewLineKind,
  SAVE_PROJECT_LABEL,
  SAVE_USER_LABEL,
} from '@renderer/components/recovery/ConfigPatchControl.tsx'
import { laterReason, NO_OVERRIDES_MESSAGE } from '@renderer/components/recovery/execute.ts'
import { HEAL_LABEL } from '@renderer/components/recovery/heal.ts'
import { RecoveryActions, resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import type { RecoveryActionsProps } from '@renderer/components/recovery/RecoveryActions.tsx'
import {
  ARM_LABEL,
  DISARM_LABEL,
  REARM_LABEL,
  countdownReserve,
  timeOfDay,
} from '@renderer/components/recovery/WaitUntilControl.tsx'
import { LATER_VERSION } from '@renderer/components/ui/DisabledHint.tsx'
import { observeCoreTime, resetCoreClock } from '@renderer/lib/coreClock.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { Providers, probeView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import {
  T0,
  flagPatch,
  flagPatchSave,
  grantCommand,
  grantLarge,
  grantVendorFolder,
  heal,
  healAction,
  modelPatch,
  modelPatchSave,
  retryAction,
  switchCodex,
  waitAction,
} from './fixtures.ts'

const RUN = 'run-1'
const EM_DASH = '\u2014'
let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({ handlers: { 'runs.get': () => Promise.reject(new Error('not needed')) } })
  resetRecoveryForTests()
  resetCoreClock()
})

afterEach(() => {
  resetRecoveryForTests()
  resetCoreClock()
  tearDown(mock)
})

async function mount(props: RecoveryActionsProps): Promise<ReturnType<typeof render>> {
  const r = render(
    <Providers>
      <RecoveryActions {...props} />
    </Providers>,
  )
  await settle()
  return r
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

const button = (id: string): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>(id)
const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)
const reserved = (el: HTMLElement): (string | null)[] =>
  [...el.querySelectorAll('[data-label]')].map((r) => r.getAttribute('data-label'))

describe('config_patch', () => {
  it('previews the change and pairs core’s apply and save actions in one block', async () => {
    await mount({ actions: [modelPatch, retryAction, modelPatchSave], runId: RUN, step: 'implement' })
    const block = screen.getByTestId(`patch-${modelPatch.id}`)
    expect(block.textContent).toContain("Use Claude's default model")
    const lines = [...screen.getByTestId(`patch-preview-${modelPatch.id}`).children] as HTMLElement[]
    expect(lines.map((l) => l.dataset['kind'])).toEqual(['del', 'add'])
    expect(lines[0]?.className).toContain('bg-diff-del-bg')
    expect(lines[1]?.className).toContain('bg-diff-add-bg')
    expect(screen.getByRole('group', { name: 'Change preview: 1 added, 1 removed' })).toBeTruthy()
    // One block: the save action is not a second block or a loose button.
    expect(screen.queryByTestId(`patch-${modelPatchSave.id}`)).toBeNull()
    expect(button(`recovery-${modelPatch.id}`).textContent).toBe(APPLY_RUN_LABEL)
    expect(button(`recovery-${modelPatchSave.id}`).textContent).toBe(SAVE_PROJECT_LABEL)
    // The block is core's first action: its apply button is the one primary button.
    expect(button(`recovery-${modelPatch.id}`).className).toContain('bg-primary')
    expect(button(`recovery-${modelPatchSave.id}`).className).not.toContain('bg-primary')
    expect(button(`recovery-${retryAction.id}`).className).not.toContain('bg-primary')
    expect(block.textContent).not.toContain(EM_DASH)
  })

  it('Apply to this run executes the apply action (P22 retries in core) and refetches the run', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'config_patch',
      message: 'Applied. Retrying Implement.',
    }))
    mock.on('runs.get', () => {
      throw mockError('NOT_FOUND', 'gone')
    })
    await mount({ actions: [modelPatch, modelPatchSave], runId: RUN, step: 'implement' })
    await click(button(`recovery-${modelPatch.id}`))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: modelPatch.id, runId: RUN }])
    expect(mock.callsOf('config.patch')).toEqual([])
    expect(toasts()).toContain('Applied. Retrying Implement.')
    expect(mock.callsOf('runs.get')).toEqual([{ runId: RUN }])
  })

  it('Apply and save: core writes the file and the toast undoes it from core’s backup', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'config_patch',
      persisted: [
        {
          scope: 'project',
          folder: 'C:\\work\\repo',
          path: 'C:\\work\\repo\\dimfactory.json',
          backupId: 'b-7',
          diff: '',
        },
      ],
    }))
    mock.on('config.restoreBackup', () => ({ path: 'x', changed: true, diff: '', backupId: null }))
    await mount({ actions: [modelPatch, modelPatchSave], runId: RUN, step: 'implement' })
    await click(button(`recovery-${modelPatchSave.id}`))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: modelPatchSave.id, runId: RUN }])
    expect(toasts()).toContain("Saved to the project's config.")
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.restoreBackup')).toEqual([
      { scope: 'project', folder: 'C:\\work\\repo', backupId: 'b-7' },
    ])
  })

  it('undoes a save into a file core created by removing the keys it added', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'config_patch',
      message: 'Saved to your user config.',
      persisted: [{ scope: 'user', path: 'C:\\home\\dimfactory.json', backupId: null, diff: '' }],
    }))
    mock.on('config.patch', () => ({ path: 'x', changed: true, diff: '', backupId: null }))
    await mount({ actions: [flagPatch, flagPatchSave], runId: RUN, step: 'implement' })
    expect(button(`recovery-${flagPatchSave.id}`).textContent).toBe(SAVE_USER_LABEL)
    await click(button(`recovery-${flagPatchSave.id}`))
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'remove', path: '/vendors/claude/flagMap/--output-format' }] },
    ])
  })

  it('previews from the ops when core sent no preview text', async () => {
    await mount({ actions: [flagPatch], runId: RUN })
    const preview = screen.getByTestId(`patch-preview-${flagPatch.id}`)
    expect(preview.textContent).toContain('+ /vendors/claude/flagMap/--output-format = "--format"')
    expect(opsPreview([{ op: 'remove', path: '/timeouts/stallMs' }])).toBe('- /timeouts/stallMs')
    expect(opsPreview([{ op: 'replace', path: '/passes/fix/model', value: null }])).toBe(
      '+ /passes/fix/model = null (the default)',
    )
    expect(previewLineKind('@@ -1,2 +1,2 @@')).toBe('hunk')
    expect(previewLineKind('--- a/dimfactory.json')).toBe('hunk')
    expect(previewLineKind('\u2212 old')).toBe('del')
    expect(previewLineKind('  same')).toBe('same')
  })

  it('a composer fix hands core’s checked ops to the composer (Apply to the next run)', async () => {
    const ops: JsonPatchOp[] = [{ op: 'replace', path: '/passes/implement/model', value: null }]
    mock.on('recovery.execute', (): RecoveryResult => ({ kind: 'config_patch', overrides: ops }))
    const onOverrides = vi.fn()
    await mount({ actions: [modelPatch], folder: 'C:\\work\\repo', onOverrides })
    expect(button(`recovery-${modelPatch.id}`).textContent).toBe(APPLY_NEXT_LABEL)
    await click(button(`recovery-${modelPatch.id}`))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: modelPatch.id, folder: 'C:\\work\\repo' }])
    expect(onOverrides).toHaveBeenCalledWith(ops)
  })

  it('a composer fix with nothing to take its ops says where to change it instead of core’s words', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'config_patch',
      message: 'Changed for this run.',
      overrides: [{ op: 'replace', path: '/passes/implement/model', value: null }],
    }))
    await mount({ actions: [modelPatch], folder: 'C:\\work\\repo' })
    await click(button(`recovery-${modelPatch.id}`))
    expect(toasts()).toContain(NO_OVERRIDES_MESSAGE)
    expect(toasts()).not.toContain('Changed for this run.')
  })

  it('renders disabled for a later version when this build’s core has no executor', async () => {
    await mount({ actions: [modelPatch, modelPatchSave], runId: RUN })
    await click(button(`recovery-${modelPatch.id}`))
    expect(toasts()).toContain(`Use Claude's default model: ${LATER_VERSION.toLowerCase()}.`)
    expect(button(`recovery-${modelPatch.id}`).disabled).toBe(true)
    expect(screen.getByRole('group', { name: `${APPLY_RUN_LABEL} ${LATER_VERSION}` })).toBeTruthy()
  })
})

describe('wait_until', () => {
  it('counts down on core’s clock while armed, keeping its width', async () => {
    await mount({ actions: [waitAction()], runId: RUN, step: 'implement' })
    const status = screen.getByTestId('wait-status-implement.wait')
    expect(status.textContent).toBe(`Retrying automatically in 4:00 (at ${timeOfDay(T0 + 240_000)}).`)
    await settle(1000)
    expect(status.textContent).toContain('in 3:59')
    // Core's clock runs a minute ahead of this window's: the countdown follows core, never the local clock.
    act(() => observeCoreTime(Date.now() + 60_000))
    await settle(1000)
    expect(status.textContent).toContain('in 2:58')
    const toggle = button('recovery-implement.wait')
    expect(toggle.textContent).toBe(DISARM_LABEL)
    expect(reserved(toggle)).toEqual([ARM_LABEL, REARM_LABEL, DISARM_LABEL])
    // The countdown sits in a reserved width (tabular digits), so the text after it never moves.
    expect(status.querySelector('[data-stable-label]')?.className).toContain('tabular-nums')
    expect(status.querySelector('[data-label]')?.getAttribute('data-label')).toBe('00:00')
  })

  it('Disarm executes the action and shows core’s answer; Re-arm arms it again', async () => {
    const now: WaitView = { actionId: 'implement.wait', until: T0 + 240_000, armed: false, disarmed: 'user' }
    mock.on('recovery.execute', (): RecoveryResult => ({ kind: 'wait_until', wait: now }))
    await mount({ actions: [waitAction()], runId: RUN, step: 'implement' })
    const toggle = button('recovery-implement.wait')
    await click(toggle)
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'implement.wait', runId: RUN }])
    expect(button('recovery-implement.wait')).toBe(toggle)
    expect(toggle.textContent).toBe(REARM_LABEL)
    expect(screen.getByTestId('wait-implement.wait').dataset['armed']).toBe('false')
    expect(screen.getByTestId('wait-status-implement.wait').textContent).toBe(
      `Automatic retry is off. The limit resets in 4:00 (at ${timeOfDay(T0 + 240_000)}).`,
    )
  })

  it('loads disarmed after a relaunch (core’s StepView.wait), offering Re-arm and Retry now', async () => {
    mock.on('runs.retryPass', () => undefined)
    const wait: WaitView = {
      actionId: 'implement.wait',
      until: T0 + 90_000,
      armed: false,
      disarmed: 'relaunch',
    }
    await mount({ actions: [waitAction()], runId: RUN, step: 'implement', wait })
    expect(screen.getByTestId('wait-status-implement.wait').textContent).toBe(
      `Dim Factory restarted, so the automatic retry is off. The limit resets in 1:30 (at ${timeOfDay(T0 + 90_000)}).`,
    )
    expect(button('recovery-implement.wait').textContent).toBe(REARM_LABEL)
    // Disarmed and first: arming is the primary action.
    expect(button('recovery-implement.wait').className).toContain('bg-primary')
    await click(button('wait-retry-implement.wait'))
    expect(mock.callsOf('runs.retryPass')).toEqual([{ runId: RUN, pass: 'implement' }])
  })

  it('a usage limit core does not arm on its own offers Arm; past the reset it says so', async () => {
    await mount({ actions: [waitAction({ armed: false, until: T0 - 1 })], runId: RUN, step: 'implement' })
    expect(button('recovery-implement.wait').textContent).toBe(ARM_LABEL)
    expect(screen.getByTestId('wait-status-implement.wait').textContent).toBe(
      'Dim Factory does not retry this on its own. The limit should have reset by now.',
    )
  })

  it('says it is retrying once an armed wait is due', async () => {
    await mount({ actions: [waitAction({ until: T0 + 2000 })], runId: RUN, step: 'implement' })
    await settle(3000)
    expect(screen.getByTestId('wait-status-implement.wait').textContent).toBe('Retrying now.')
  })

  it('writes the time as core’s label does (24-hour), never in a second format', async () => {
    await mount({ actions: [waitAction()], runId: RUN, step: 'implement' })
    const card = screen.getByTestId('wait-implement.wait')
    // The fixture's label is core's: "Retry at 15:04"; the status line names the same time the same way.
    expect(card.textContent).toContain('Retry at 15:04')
    expect(screen.getByTestId('wait-status-implement.wait').textContent).toContain('(at 15:04).')
    expect(timeOfDay(T0 + 240_000, T0)).toBe('15:04')
    expect(timeOfDay(T0 + 26 * 3_600_000, T0)).toMatch(/^[A-Z][a-z]{2} 17:00$/)
    expect(card.textContent).not.toMatch(/\b[AP]M\b/)
  })

  it('reserves the countdown’s widest form for the wait’s whole life', async () => {
    expect(countdownReserve(240_000)).toBe('00:00')
    expect(countdownReserve(2 * 3_600_000)).toBe('0:00:00')
    expect(countdownReserve(150 * 3_600_000)).toBe('000:00:00')
    // A wait an hour and a minute away keeps h:mm:ss reserved once it counts below an hour.
    await mount({ actions: [waitAction({ until: T0 + 3_660_000 })], runId: RUN, step: 'implement' })
    const status = screen.getByTestId('wait-status-implement.wait')
    expect(status.querySelector('[data-label]')?.getAttribute('data-label')).toBe('0:00:00')
    await settle(61_000)
    expect(status.textContent).toContain('in 59:59')
    expect(status.querySelector('[data-label]')?.getAttribute('data-label')).toBe('0:00:00')
  })
})

describe('grant', () => {
  it('runs through recovery.execute and says what it trusts', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'grant',
      message: 'Trusted for this project.',
    }))
    const onRecheck = vi.fn()
    await mount({ actions: [grantCommand, grantLarge], folder: 'C:\\work\\repo', onRecheck })
    expect(screen.getByTestId('grant-note-verify.trust').textContent).toBe(
      'Runs the tests after Implement and Fix.pnpm test (in packages/app)',
    )
    expect(screen.getByTestId('grant-note-folder.large').textContent).toBe('48,210 files (2.1 GB)')
    await click(button('recovery-verify.trust'))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'verify.trust', folder: 'C:\\work\\repo' }])
    expect(toasts()).toContain('Trusted for this project.')
    // A grant changes what preflight sees: the composer checks again.
    expect(onRecheck).toHaveBeenCalledTimes(1)
  })

  it('the vendorFolder grant arrived with Gemini: it runs through recovery.execute and says what it trusts', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'grant',
      message: 'Gemini trusted in this folder.',
    }))
    await mount({ actions: [grantVendorFolder], runId: RUN })
    expect(button('recovery-gemini.trust').disabled).toBe(false)
    expect(screen.queryByRole('group', { name: `Trust this folder for Gemini ${LATER_VERSION}` })).toBeNull()
    expect(screen.getByTestId('grant-note-gemini.trust').textContent).toBe(
      'Gemini runs here without asking about the folder.',
    )
    await click(button('recovery-gemini.trust'))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'gemini.trust', runId: RUN }])
    expect(toasts()).toContain('Gemini trusted in this folder.')
  })
})

describe('switch_vendor', () => {
  it('stays disabled with a reason until the other vendor is ready, then runs', async () => {
    mock.on('recovery.execute', (): RecoveryResult => ({
      kind: 'switch_vendor',
      message: 'Implement runs on Codex.',
    }))
    await mount({ actions: [retryAction, switchCodex], runId: RUN, step: 'implement' })
    // No probe for it: a vendor this build does not have.
    expect(screen.getByRole('group', { name: `Use another vendor ${LATER_VERSION}` })).toBeTruthy()
    act(() =>
      upsertProbes([probeView('codex', 'not-built', { built: false, healthDetail: 'Not in this build' })]),
    )
    expect(screen.getByRole('group', { name: `Use another vendor ${LATER_VERSION}` })).toBeTruthy()
    act(() => upsertProbes([probeView('codex', 'login-needed')]))
    expect(
      screen.getByRole('group', { name: 'Use another vendor Codex is not ready: Login needed' }),
    ).toBeTruthy()
    act(() => upsertProbes([probeView('codex', 'ready')]))
    expect(button('recovery-implement.switch').disabled).toBe(false)
    await click(button('recovery-implement.switch'))
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'implement.switch', runId: RUN }])
    expect(toasts()).toContain('Implement runs on Codex.')
  })

  it('core’s disabledReason wins for any action', async () => {
    act(() => upsertProbes([probeView('codex', 'ready')]))
    const blocked: RecoveryAction = { ...switchCodex, disabledReason: 'Codex arrives in a later version.' }
    await mount({ actions: [blocked], runId: RUN })
    expect(button('recovery-implement.switch').disabled).toBe(true)
    expect(
      screen.getByRole('group', { name: 'Use another vendor Codex arrives in a later version.' }),
    ).toBeTruthy()
    expect(laterReason(blocked, undefined)).toBe('Codex arrives in a later version.')
    expect(laterReason(retryAction, undefined)).toBeNull()
  })
})

describe('heal outside a run', () => {
  it('asks core and shows the outcome under the buttons, keeping the label while it works', async () => {
    const hold = deferred<RecoveryResult>()
    mock.on('recovery.execute', () => hold.promise)
    await mount({ actions: [healAction] })
    const b = button('recovery-implement.heal')
    expect(b.textContent).toBe(HEAL_LABEL)
    await click(b)
    expect(b.textContent).toBe(HEAL_LABEL)
    expect(b.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('recovery-heal').dataset['status']).toBe('running')
    await act(async () => {
      hold.resolve({ kind: 'heal', heal: heal({ hidden: 2 }) })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(screen.getByTestId('recovery-heal-text').textContent).toBe(
      'Diagnosis (AI, medium confidence): The CLI renamed --output-format to --format in 2.4.',
    )
    expect(screen.getByTestId('recovery-heal-hidden').textContent).toBe(
      'Dim Factory hid 2 unsafe suggestions',
    )
  })
})
