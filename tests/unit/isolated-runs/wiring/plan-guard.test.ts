// Integration fix (R2: an isolated run's Plan runs alongside prepare's deps install and
// verify:0 baseline in the same isolated copy; the plan-end guard): found in isolated.spec.ts, where the install's files made the
// plan-end tree differ from run-start and opened planMutated, whose Revert would have undone the install. When the
// install or the baseline wrote in the copy during Plan, the guard notes it instead (nothing reverted; it all stays in
// S0, which Apply never copies). With nothing else writing there, the in-place guard is unchanged.
import { describe, expect, it } from 'vitest'
import { PLAN_WROTE_IN_COPY } from '@core/supervisor/machine.ts'
import { PLAN_TEXT } from '../../supervisor/helpers.ts'
import { IFlow, PNPM } from '../engine/helpers.ts'

/** Plan reports a Write (Claude's native plan file), then its plan; the plan-end snapshot differs from run-start. */
function planWroteAndTreeMoved(h: IFlow): void {
  h.ev('plan', { type: 'session', id: 'plan-session' })
  h.ev('plan', { type: 'tool', id: 't1', name: 'Write', summary: 'plan.md', phase: 'start' })
  h.ev('plan', { type: 'tool', id: 't1', name: 'Write', summary: 'plan.md', phase: 'end', status: 'ok' })
  h.ev('plan', { type: 'done', result: PLAN_TEXT })
  h.exit('plan')
  h.send({
    t: 'snapshot-done',
    req: h.req((r) => r.kind === 'snapshot' && r.label === 'plan-end', 'plan-end'),
    commit: 'c-plan-end',
    tree: 'tree-moved',
    changed: ['.deps/installed.txt'],
  })
}

describe('isolated run: the plan-end guard and prepare writing in the same copy', () => {
  it('the install ran during Plan: a note, no planMutated, the gate opens', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'trusted')
    expect(h.state.isolation?.deps?.phase).toBe('installing')
    expect(h.state.isolation?.copyWritten).toBe(true)
    planWroteAndTreeMoved(h)
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['gate:afterPlan'])
    expect(h.state.notes).toContain(PLAN_WROTE_IN_COPY)
    expect(h.state.flow.planEnd).toBe('done')
    expect(h.log.some((e) => e.t === 'revert')).toBe(false)
  })

  it('nothing else wrote in the copy (nothing to install): the in-place guard opens planMutated as before', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(null)
    expect(h.state.isolation?.copyWritten).toBeUndefined()
    planWroteAndTreeMoved(h)
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['planMutated'])
    expect(h.state.notes).not.toContain(PLAN_WROTE_IN_COPY)
  })

  it('the note has no em dash (UI standards)', () => {
    expect(PLAN_WROTE_IN_COPY).not.toContain(String.fromCharCode(0x2014))
  })
})
