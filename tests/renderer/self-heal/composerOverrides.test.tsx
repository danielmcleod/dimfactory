// Composer wiring (the config_patch recovery action's `runOverrides`, the executors, the Quick composer and
// Preflight strip): a preflight fix for this run only ("Run without Review", "Run without Auto mode") runs through
// recovery.execute, core answers the ops it checked (RecoveryResult.overrides), and the composer applies them to its
// pending run overrides, so the next config.resolve / preflight.run see them. Nothing is written to a file.
import '../helpers/rtl.ts'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { RecoveryResult } from '@shared/ipc.ts'
import { NO_OVERRIDES_MESSAGE } from '@renderer/components/recovery/execute.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { applyOverrideOps } from '@renderer/pages/dashboard/composer/overrides.ts'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import {
  check,
  fakeResolve,
  FOLDER,
  mountComposer,
  probe,
  report,
  runEstimate,
} from '../composer/fixtures.tsx'

describe('applyOverrideOps', () => {
  it('adds, replaces and removes values in the pending overrides, pruning what empties', () => {
    const a = applyOverrideOps({}, [{ op: 'add', path: '/passes/review/enabled', value: false }])
    expect(a).toEqual({ passes: { review: { enabled: false } } })
    const b = applyOverrideOps(a, [
      { op: 'replace', path: '/auto', value: false },
      { op: 'test', path: '/auto', value: true },
    ])
    expect(b).toEqual({ passes: { review: { enabled: false } }, auto: false })
    expect(applyOverrideOps(b, [{ op: 'remove', path: '/passes/review/enabled' }])).toEqual({ auto: false })
    // A remove of something absent changes nothing, and nothing changed keeps the object's identity.
    expect(applyOverrideOps(b, [{ op: 'remove', path: '/gates/afterPlan' }])).toBe(b)
    expect(applyOverrideOps(b, [{ op: 'add', path: '/auto', value: false }])).toBe(b)
  })

  it('ignores pointers it cannot place (prototype keys, an empty pointer) and never mutates its input', () => {
    const o: RunOverrides = { profile: 'claude-only' }
    const out = applyOverrideOps(o, [
      { op: 'add', path: '/__proto__/polluted', value: true },
      { op: 'add', path: '', value: { auto: true } },
      { op: 'add', path: 'auto', value: true },
    ])
    expect(out).toBe(o)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(o).toEqual({ profile: 'claude-only' })
  })
})

describe('a preflight fix for this run only, in the composer', () => {
  let mock: MockDimFactory
  const turnOff = check('pass.review.mode', {
    status: 'fail',
    category: 'capability_missing',
    title: 'Claude cannot run Review in readonly mode',
    recovery: [
      {
        id: 'pass.review.mode.disable',
        label: 'Run without Review',
        kind: 'config_patch',
        target: 'runOverrides',
        ops: [{ op: 'add', path: '/passes/review/enabled', value: false }],
        preview: 'passes.review.enabled: false',
      },
    ],
  })

  beforeEach(() => {
    resetRecoveryForTests()
    setLiveSupportForTests()
    mock = setUp({
      handlers: {
        'config.resolve': fakeResolve(),
        'preflight.run': (req: { overrides?: RunOverrides }) =>
          req.overrides?.passes?.review?.enabled === false ? report() : report({ blocking: [turnOff] }),
        'estimates.get': () => runEstimate(),
        'recovery.execute': (): RecoveryResult => ({
          kind: 'config_patch',
          overrides: [{ op: 'add', path: '/passes/review/enabled', value: false }],
          message: 'Changed for this run.',
        }),
      },
    })
    upsertProbes([probe('claude', 'ready')])
  })

  afterEach(() => tearDown(mock))

  it("applies core's checked ops to the run overrides; the next checks see them", async () => {
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    const fix = screen.getByTestId('recovery-pass.review.mode.disable')
    expect(fix.textContent).toBe('Apply to the next run')
    fireEvent.click(fix)
    await settle()
    expect(mock.callsOf('recovery.execute')).toEqual([
      { actionId: 'pass.review.mode.disable', folder: FOLDER },
    ])
    const toasts = useStore.getState().toasts.items.map((t) => t.message)
    expect(toasts).toContain('Changed for this run.')
    expect(toasts).not.toContain(NO_OVERRIDES_MESSAGE)
    await settle(300)
    expect(mock.callsOf('preflight.run').at(-1)).toEqual({
      folder: FOLDER,
      overrides: { passes: { review: { enabled: false } } },
    })
    expect(screen.queryByTestId('preflight-chip-pass.review.mode')).toBeNull()
  })
})
