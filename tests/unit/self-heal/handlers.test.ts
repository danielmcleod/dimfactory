// `heal.diagnose{runId, step}` (the IPC command, self-heal): validated, refused on a
// read-only core, handed to the run's controller as a `heal` command; the outcome arrives as StepView.heal.
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_AREA } from '@shared/ipc.ts'
import { HEAL_COMMANDS, createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import type { UserCommand } from '@core/supervisor/types.ts'

const RUN = '20261008T120000Z-m10h'

function setup(o: { readOnly?: boolean; reject?: boolean } = {}) {
  const command = vi.fn((_cmd: UserCommand) =>
    Promise.resolve(
      o.reject === true
        ? {
            ok: false as const,
            error: { code: 'CONFLICT' as const, message: 'Only a failed pass can be diagnosed.' },
          }
        : { ok: true as const, value: undefined },
    ),
  )
  const controller = vi.fn(() => Promise.resolve({ command, state: { steps: {} } }))
  const ctx = { kind: 'app', readOnly: o.readOnly === true, controller } as unknown as HandlerContext
  return { h: createHandlers(ctx), command, controller }
}

describe('heal.diagnose', () => {
  it('is a routed core command', () => {
    for (const c of HEAL_COMMANDS) expect(Object.prototype.hasOwnProperty.call(COMMAND_AREA, c)).toBe(true)
  })

  it("starts a diagnosis of the run's failed pass", async () => {
    const { h, command, controller } = setup()
    expect(await dispatch(h, 'heal.diagnose', { runId: RUN, step: 'implement' })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(controller).toHaveBeenCalledWith(RUN)
    expect(command).toHaveBeenCalledWith({ kind: 'heal', step: 'implement' })
  })

  it("passes the run's refusal on; validates the step; refused on a read-only core", async () => {
    const r = setup({ reject: true })
    expect(await dispatch(r.h, 'heal.diagnose', { runId: RUN, step: 'implement' })).toEqual({
      ok: false,
      error: { code: 'CONFLICT', message: 'Only a failed pass can be diagnosed.' },
    })
    const v = setup()
    const bad = await dispatch(v.h, 'heal.diagnose', { runId: RUN, step: 'preflight' })
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')
    const noRun = await dispatch(v.h, 'heal.diagnose', { runId: '', step: 'plan' })
    expect(noRun.ok ? null : noRun.error.code).toBe('VALIDATION')
    expect(v.command).not.toHaveBeenCalled()
    const ro = setup({ readOnly: true })
    const f = await dispatch(ro.h, 'heal.diagnose', { runId: RUN, step: 'plan' })
    expect(f.ok ? null : f.error.code).toBe('FORBIDDEN')
  })
})
