// Review: switch_vendor outside a run (live once a second
// vendor is ready). In the composer's strip core answers the switch as run overrides, which the composer applies
// (like a config_patch `runOverrides`); where nothing can take them (the setup card, Settings → Vendors) the button is
// disabled with what to do instead, never an error toast naming a kind id.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonPatchOp, RecoveryAction } from '@shared/failure.ts'
import { RecoveryActions, resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, settle, setUp, tearDown } from '../dashboard/setup.tsx'

let mock: MockDimFactory
const FOLDER = 'C:\\work\\app'

const USE_CODEX: RecoveryAction = {
  id: 'claude.switch-vendor',
  label: 'Use Codex instead',
  kind: 'switch_vendor',
  pass: 'all',
  to: 'codex',
  model: null,
}
const OVERRIDES: JsonPatchOp[] = [
  { op: 'add', path: '/passes/implement/vendor', value: 'codex' },
  { op: 'add', path: '/passes/implement/model', value: null },
]

beforeEach(() => {
  mock = setUp({
    handlers: {
      'recovery.execute': () => ({
        kind: 'switch_vendor',
        overrides: OVERRIDES,
        message: 'Implement now uses Codex for this run.',
      }),
    },
  })
  resetRecoveryForTests()
  upsertProbes([probeView('claude', 'login-needed'), probeView('codex', 'ready')])
})

afterEach(() => {
  resetRecoveryForTests()
  tearDown(mock)
})

const button = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>(`recovery-${USE_CODEX.id}`)
const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

describe('switch_vendor outside a run', () => {
  it('in the composer: core’s overrides go to the composer, with core’s words', async () => {
    const applied: JsonPatchOp[][] = []
    render(
      <Providers>
        <RecoveryActions
          actions={[USE_CODEX]}
          folder={FOLDER}
          onOverrides={(ops) => {
            applied.push(ops)
          }}
        />
      </Providers>,
    )
    await settle()
    expect(button().disabled).toBe(false)
    await act(async () => {
      fireEvent.click(button())
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: USE_CODEX.id, folder: FOLDER }])
    expect(applied).toEqual([OVERRIDES])
    expect(toasts()).toContain('Implement now uses Codex for this run.')
    expect(toasts().join(' ')).not.toMatch(/switch_vendor/)
  })

  it('where no composer or run can take it: disabled with what to do instead', async () => {
    render(
      <Providers>
        <RecoveryActions actions={[USE_CODEX]} />
      </Providers>,
    )
    await settle()
    expect(button().disabled).toBe(true)
    expect(
      screen.getByRole('group', { name: 'Use Codex instead Choose Codex for each pass in the composer' }),
    ).toBeTruthy()
    fireEvent.click(button())
    await settle()
    expect(mock.callsOf('recovery.execute')).toEqual([])
  })

  it('a vendor that is not ready keeps its own reason first', async () => {
    upsertProbes([probeView('codex', 'login-needed', { healthDetail: 'Login needed' })])
    render(
      <Providers>
        <RecoveryActions actions={[USE_CODEX]} />
      </Providers>,
    )
    await settle()
    expect(
      screen.getByRole('group', { name: 'Use Codex instead Codex is not ready: Login needed' }),
    ).toBeTruthy()
  })
})
