// Attention: needsYou = pending asks + open blocking cards (gates included) + stalled steps + paused
// steps + failed steps with an open snag. Also the card builders and default snag buttons.
import { describe, expect, it } from 'vitest'
import { aggregateAttention, runAttention } from '@core/supervisor/attention.ts'
import {
  afterPlanGateCard,
  defaultSnagActions,
  insufficientContextCard,
  preflightCard,
  retryPartialCard,
  stallCard,
} from '@core/supervisor/cards.ts'
import { timerId } from '@core/supervisor/timers.ts'
import { Harness, blockedReport, failure, makeConfig } from './helpers.ts'

describe('attention', () => {
  it('counts each pending ask', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.ask('implement', 'q2')
    const items = runAttention(h.state)
    expect(items.map((i) => i.id)).toEqual(['ask:q1', 'ask:q2'])
    expect(items[0]).toMatchObject({
      kind: 'ask',
      runId: h.state.runId,
      displayNo: 7,
      folder: h.state.folder,
    })
  })

  it('counts open blocking cards (gate included)', () => {
    const h = new Harness().toPlanGate()
    expect(runAttention(h.state)).toEqual([
      expect.objectContaining({ kind: 'card', cardKind: 'gate:afterPlan', blocking: true }),
    ])
  })

  it('a stalled step counts once (its stall card is informational)', () => {
    const h = new Harness().toImplementRunning()
    h.fire('stall|implement')
    expect(runAttention(h.state).map((i) => i.kind)).toEqual(['stalled'])
  })

  it('counts paused steps and failed steps with an open snag', () => {
    const p = new Harness().toImplementRunning()
    p.ask('implement', 'q1')
    p.fire(timerId.ask('implement', 'q1'))
    expect(runAttention(p.state)).toEqual([
      expect.objectContaining({ kind: 'paused', step: 'implement', pause: 'ask-timeout' }),
    ])
    const f = new Harness().toImplementRunning()
    f.ev('implement', { type: 'error', message: 'x', raw: '', fatal: true, category: 'auth_required' })
    expect(runAttention(f.state)).toEqual([
      expect.objectContaining({ kind: 'failed', step: 'implement', category: 'auth_required' }),
    ])
  })

  it('R2b counts once: the preflight card, not a snag', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.preflight(blockedReport({ category: 'git_missing' }))
    expect(runAttention(h.state).map((i) => i.kind)).toEqual(['card'])
  })

  it('finished runs need nobody; aggregation sums runs oldest first', () => {
    const done = new Harness().toPlanGate()
    done.user({ kind: 'stop' })
    expect(runAttention(done.state)).toEqual([])
    const a = new Harness().toPlanGate()
    const b = new Harness(makeConfig()).toImplementRunning()
    b.tick(5000).ask('implement', 'q9')
    const agg = aggregateAttention([b.state, a.state])
    expect(agg.needsYou).toBe(2)
    expect(agg.items.map((i) => i.kind)).toEqual(['card', 'ask'])
  })
})

describe('cards', () => {
  it('builds the plan gate cards with stable choice ids', () => {
    expect(afterPlanGateCard('g', 'p').choices.map((c) => c.id)).toEqual(['approve', 'cancel'])
    expect(afterPlanGateCard('g', 'p').choices[0]?.input).toBe('plan')
    const ic = insufficientContextCard('i', 'why', 'task')
    expect(ic.choices.map((c) => c.id)).toEqual(['replan', 'proceed', 'cancel'])
    expect(ic.defaultChoice).toBeUndefined()
    expect(preflightCard('p', blockedReport({ title: 'One' })).title).toBe('One')
    expect(stallCard('s', 'implement', 300_000)).toMatchObject({ blocking: false, title: 'No output for 5m' })
    expect(retryPartialCard('r', 'implement', undefined).choices.map((c) => c.id)).toEqual([
      'revert-then-fresh',
      'keep-changes',
      'cancel',
    ])
  })

  it('default snag buttons: Resume only for resumable categories with a session; no skip for Implement', () => {
    const ids = (
      step: 'implement' | 'plan',
      cat: Parameters<typeof failure>[0],
      hasSession: boolean,
    ): string[] => defaultSnagActions(step, failure(cat), { hasSession, hints: [] }).map((a) => a.id)
    expect(ids('implement', 'timeout_hard', true)).toEqual([
      'implement:resume',
      'implement:retry',
      'run:close',
    ])
    expect(ids('implement', 'timeout_hard', false)).toEqual(['implement:retry', 'run:close'])
    expect(ids('plan', 'network', false)).toEqual(['plan:retry', 'plan:skip', 'run:close'])
  })
})
