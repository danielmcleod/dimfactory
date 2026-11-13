// Isolated-run recovery (boot step 6, "Crash relaunch", R12): an isolated run's finalize work is
// relaunched (a preview, an apply or undo in flight, a deferred discard), and a run whose outcome is fixed is not ended
// before finalize when run.json is projected from the log.
import { describe, expect, it } from 'vitest'
import { FINALIZE_CHOICE } from '@core/supervisor/cards.ts'
import { finalizeWorkPending, needsRelaunch, projectFromLog } from '@core/supervisor/recovery.ts'
import { IFlow } from './helpers.ts'

describe('recovery of isolated runs', () => {
  it('a preview, an apply waiting for the folder and a deferred discard need a relaunch; a card does not', () => {
    const h = new IFlow().toR12Clean()
    expect(finalizeWorkPending(h.state)).toBe(true)
    h.preview(2)
    expect(finalizeWorkPending(h.state)).toBe(false)
    expect(needsRelaunch(h.state)).toBe(false)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    expect(finalizeWorkPending(h.state)).toBe(true)
  })

  it('a relaunch while the apply waited for the folder asks for the lease again (it did not write yet)', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.send({ t: 'relaunch' })
    expect(h.fx('lease')).toEqual([{ t: 'lease' }])
    expect(h.state.cards.some((c) => c.view.kind === 'interruptedApply')).toBe(false)
  })

  it('projectFromLog: an outcome fixed at R12 (status waiting) does not end the run', () => {
    const h = new IFlow().toImplementRunning()
    const s = projectFromLog(h.state, [
      {
        runId: h.state.runId,
        seq: 99,
        ts: 5,
        body: { t: 'run-status', status: 'waiting', phase: 'ready-to-apply', outcome: 'clean' },
      },
    ])
    expect(s.outcome).toBe('clean')
    expect(s.endedAt).toBeUndefined()
  })
})
