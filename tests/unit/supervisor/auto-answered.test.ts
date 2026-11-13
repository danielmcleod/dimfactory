// "The Log tab shows AUTO approved N" (P6, auto.spec.ts): core counts the asks an adapter
// answered itself per step (StepView.autoAnswered) and per run (RunSnapshot.autoAnswered), so the renderer formats
// the number without counting envelopes. The native plan's capture is not counted; recovery counts the bodies a
// crash left past the run.json checkpoint.
import { describe, expect, it } from 'vitest'
import type { RunEnvelope, RunEventBody } from '@shared/run.ts'
import { addAutoAnswered, runAutoAnswered, toRunSnapshot, toStepView } from '@core/supervisor/derive.ts'
import { projectFromLog } from '@core/supervisor/recovery.ts'
import { Harness } from './helpers.ts'

describe('auto-answered counts', () => {
  it('counts allow-cache allows as approved and read-only / unsupported denials as denied, per step', () => {
    const h = new Harness().toImplementRunning()
    h.signal('implement', {
      type: 'auto-answered',
      requestId: 'a1',
      decision: 'allow',
      tool: 'Bash',
      why: 'allow-cache',
    })
    expect(h.bodies('auto-answered')).toEqual([
      expect.objectContaining({ step: 'implement', requestId: 'a1', decision: 'allow', why: 'allow-cache' }),
    ])
    h.signal('implement', {
      type: 'auto-answered',
      requestId: 'a2',
      decision: 'allow',
      tool: 'Bash',
      why: 'allow-cache',
    })
    h.signal('implement', {
      type: 'auto-answered',
      requestId: 'a3',
      decision: 'deny',
      tool: 'AskUserQuestion',
      why: 'unsupported',
    })
    expect(h.step('implement').autoAnswered).toEqual({ approved: 2, denied: 1 })
    expect(toStepView(h.step('implement')).autoAnswered).toEqual({ approved: 2, denied: 1 })
    const snap = toRunSnapshot(h.state, 0)
    expect(snap.autoAnswered).toEqual({ approved: 2, denied: 1 })
    expect(snap.steps.implement.autoAnswered).toEqual({ approved: 2, denied: 1 })
    expect(snap.steps.plan.autoAnswered).toBeUndefined()
    // No asks were raised to the user for any of them.
    expect(h.step('implement').asks).toEqual([])
    expect(h.step('implement').status).toBe('running')
  })

  it('the plan capture is not counted; a run without auto answers has no counts', () => {
    const h = new Harness().toPlanRunning()
    h.signal('plan', {
      type: 'auto-answered',
      requestId: 'p1',
      decision: 'deny',
      tool: 'ExitPlanMode',
      why: 'plan-capture',
    })
    expect(h.bodies('auto-answered')).toHaveLength(1)
    expect(h.step('plan').autoAnswered).toBeUndefined()
    expect(runAutoAnswered(h.state)).toBeUndefined()
    expect(toRunSnapshot(h.state, 0).autoAnswered).toBeUndefined()
    expect(toStepView(h.step('plan')).autoAnswered).toBeUndefined()
  })

  it('sums every step for the run total', () => {
    const h = new Harness().toImplementRunning()
    const st = h.state
    addAutoAnswered(st.steps.implement, 'allow-session', 'allow-cache')
    addAutoAnswered(st.steps.review, 'deny', 'readonly')
    addAutoAnswered(st.steps.fix, 'allow', 'allow-cache')
    expect(runAutoAnswered(st)).toEqual({ approved: 2, denied: 1 })
  })

  it('projectFromLog counts the auto-answered bodies after the run.json checkpoint', () => {
    const h = new Harness().toImplementRunning()
    const body = (requestId: string, why: 'allow-cache' | 'plan-capture'): RunEventBody => ({
      t: 'auto-answered',
      step: 'implement',
      attempt: 1,
      requestId,
      tool: 'Bash',
      decision: 'allow',
      why,
    })
    const env = (seq: number, b: RunEventBody): RunEnvelope => ({
      runId: h.state.runId,
      seq,
      ts: h.now,
      body: b,
    })
    const s = projectFromLog(h.state, [env(1, body('x1', 'allow-cache')), env(2, body('x2', 'plan-capture'))])
    expect(s.steps.implement.autoAnswered).toEqual({ approved: 1, denied: 0 })
    expect(h.state.steps.implement.autoAnswered).toBeUndefined()
  })

  it('projectFromLog applies ask-extended to a pending ask', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    const s = projectFromLog(h.state, [
      {
        runId: h.state.runId,
        seq: 1,
        ts: h.now,
        body: { t: 'ask-extended', step: 'implement', requestId: 'q1', expiresAt: 42 },
      },
    ])
    expect(s.steps.implement.asks[0]?.expiresAt).toBe(42)
  })
})
