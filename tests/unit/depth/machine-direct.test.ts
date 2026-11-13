// Reducer rows for adaptive depth's Quick shape, quieter reviews and the findings that turned out wrong:
//   - the direct shape: no Plan, no Critic, Implement then one reviewer
//   - Fix is conditional: nothing with evidence → no Fix (clean, or findings open for an unevidenced [must]); a [must]
//     with a file:line, or a failing check → Fix
//   - escalation: a Quick run whose verify:1 fails gets the Critic and Fix until green, once, with a note
//   - the wrong-findings metric: Fix disputed a finding and verify:2 passed
import { describe, expect, it } from 'vitest'
import { DEPTH_ESCALATED_NOTE } from '@shared/depth.ts'
import { QUIET_NOTE, SKIP_REASON } from '@core/supervisor/machine.ts'
import type { FindingInput, RunConfig } from '@core/supervisor/types.ts'
import { makeConfig } from '../supervisor/helpers.ts'
import { VFlow, result, trusted, verifyMust } from '../verify/machine-helpers.ts'

/** The Quick shape as runConfigFromResolved projects it for balanced: Implement on Codex, Review on Claude. */
function directConfig(o: { verify?: boolean; rounds?: number; gate?: boolean } = {}): RunConfig {
  const c = makeConfig({ gates: { afterPlan: false, beforeFix: o.gate ?? false } })
  c.passes.plan.enabled = false
  c.passes.implement.vendor = 'codex'
  c.passes.review = { enabled: true, vendor: 'claude', model: 'sonnet', mode: 'readonly' }
  c.passes.critic = { enabled: false, vendor: 'claude', model: 'opus', mode: 'readonly' }
  c.passes.fix = { enabled: true, vendor: 'codex', model: null, mode: 'autoedit', reuseSession: true }
  c.depth = { depth: 'direct', source: 'auto', reason: 'A small or medium change to an existing project.' }
  c.fixTrigger = 'evidence'
  if (o.verify === true) c.verify = { enabled: true, runAfter: ['implement', 'fix'], baseline: false }
  if (o.rounds !== undefined) c.fixLoop = { rounds: o.rounds, recheck: false }
  return c
}

/** A Flow whose run starts straight at Implement (Plan off). */
class Direct extends VFlow {
  constructor(c: RunConfig) {
    super()
    this.state = { ...this.state, config: c }
  }

  override toImplementRunning(): this {
    this.create()
    this.lock()
    this.preflight()
    this.snapshot('run-start', 'tree-base')
    this.reconcile()
    this.snapshot('S0', 'tree-base')
    this.passPreflight('implement')
    this.ev('implement', { type: 'session', id: 'impl-session' })
    return this
  }

  /** Implement done, S1 changed, verify:1 (when on) answered with `verify`, up to Review spawned. */
  toReview(verify?: 'pass' | 'fail'): this {
    if (verify !== undefined)
      this.toVerified(result('test', verify), verify === 'fail' ? [verifyMust('test')] : [])
    else this.toS1()
    this.reconcile('pre-review')
    for (const k of this.reviewers) this.passPreflight(k)
    return this
  }
}

const located = (id: string, sev: 'must' | 'should', at = 'src/app.ts:12'): FindingInput => ({
  id,
  severity: sev,
  title: `\`${at}\`: ${sev} ${id}`,
  body: '',
  flags: [],
})
const vague = (id: string, sev: 'must' | 'should'): FindingInput => ({
  id,
  severity: sev,
  title: `${sev} ${id} somewhere`,
  body: 'no place named',
  flags: [],
})

describe('Quick: the direct shape', () => {
  it('skips Plan and Critic and runs Implement then one reviewer', () => {
    const f = new Direct(directConfig()).toReview()
    expect(f.step('plan').status).toBe('skipped')
    expect(f.step('plan').reason).toBe(SKIP_REASON.disabled)
    expect(f.step('implement').status).toBe('done')
    expect(f.step('review').status).toBe('running')
    expect(f.step('critic').status).toBe('skipped')
    expect(f.state.config.depth?.depth).toBe('direct')
  })
})

describe('Quick: Fix runs only when something real fails', () => {
  it('a reviewer with only suggestions without evidence: no Fix, clean, with a note', () => {
    const f = new Direct(directConfig()).toReview()
    f.report('review', 'ok', [vague('s1', 'should'), located('s2', 'should')])
    f.snapshot('post-review', 'tree-changed')
    expect(f.step('fix').status).toBe('skipped')
    expect(f.step('fix').reason).toBe(SKIP_REASON.noEvidence)
    expect(f.state.outcome).toBe('clean')
    expect(f.state.notes).toContain(QUIET_NOTE(2))
    // Everything is still listed; nothing is selected for Fix.
    expect(f.state.findings?.list.map((x) => x.id).sort()).toEqual(['s1', 's2'])
    expect(f.state.findings?.selected).toEqual([])
  })

  it('a [must] without evidence is listed for the user and leaves findings open, still without Fix', () => {
    const f = new Direct(directConfig()).toReview()
    f.report('review', 'ok', [vague('m1', 'must')])
    f.snapshot('post-review', 'tree-changed')
    expect(f.step('fix').status).toBe('skipped')
    expect(f.state.outcome).toBe('findings-open')
  })

  it('a [must] with a file:line goes to Fix (and a [should] does not)', () => {
    const f = new Direct(directConfig()).toReview()
    f.report('review', 'ok', [located('m1', 'must'), located('s1', 'should', 'src/b.ts:3')])
    f.snapshot('post-review', 'tree-changed')
    expect(f.state.findings?.selected).toEqual(['m1'])
    expect(f.step('fix').status).toBe('running')
  })

  it('with Fix until green on, a [should] with evidence goes to Fix too', () => {
    const f = new Direct(directConfig({ rounds: 3 })).toReview()
    f.report('review', 'ok', [located('s1', 'should'), vague('s2', 'should')])
    f.snapshot('post-review', 'tree-changed')
    expect(f.state.findings?.selected).toEqual(['s1'])
    expect(f.step('fix').status).toBe('running')
  })

  it('the before-Fix gate pre-ticks only the findings with evidence (the user may tick the rest)', () => {
    const f = new Direct(directConfig({ gate: true })).toReview()
    f.report('review', 'ok', [located('m1', 'must'), vague('s1', 'should')])
    f.snapshot('post-review', 'tree-changed')
    const gate = f.card('gate:beforeFix')
    expect(gate).toBeDefined()
    expect(f.state.findings?.selected).toEqual(['m1'])
  })

  it('an earlier build (no fixTrigger) still sends every finding to Fix', () => {
    const c = directConfig()
    delete c.fixTrigger
    const f = new Direct(c).toReview()
    f.report('review', 'ok', [vague('s1', 'should')])
    f.snapshot('post-review', 'tree-changed')
    expect(f.state.findings?.selected).toEqual(['s1'])
    expect(f.step('fix').status).toBe('running')
  })
})

describe('Quick: a failed check escalates to thorough checks', () => {
  it('verify:1 fails: the Critic joins Review, Fix until green turns on, once, with a note', () => {
    const f = new Direct(directConfig({ verify: true })).toReview('fail')
    expect(f.state.config.depth?.escalated).toBe('test')
    expect(f.state.config.passes.critic.enabled).toBe(true)
    expect(f.state.config.fixLoop).toEqual({ rounds: 3, recheck: false })
    expect(f.state.notes).toContain(DEPTH_ESCALATED_NOTE('test'))
    expect(f.step('critic').status).toBe('running')
    expect(f.step('review').status).toBe('running')
  })

  it('verify:1 passes: no escalation, one reviewer', () => {
    const f = new Direct(directConfig({ verify: true })).toReview('pass')
    expect(f.state.config.depth?.escalated).toBeUndefined()
    expect(f.state.config.passes.critic.enabled).toBe(false)
    expect(f.step('critic').status).toBe('skipped')
  })

  it('a Thorough run never escalates', () => {
    const c = directConfig({ verify: true })
    c.depth = { depth: 'full', source: 'auto', reason: 'x' }
    const f = new Direct(c).toReview('fail')
    expect(f.state.config.depth?.escalated).toBeUndefined()
    expect(f.state.config.passes.critic.enabled).toBe(false)
  })
})

describe('the findings that turned out wrong', () => {
  it('Fix disputes a finding and verify:2 passes: counted as wrong, in findings.json and the note', () => {
    const f = new Direct(directConfig({ verify: true })).toReview('pass')
    f.report('review', 'ok', [located('m1', 'must'), located('m2', 'must', 'src/c.ts:9')])
    f.snapshot('post-review', 'tree-changed')
    f.toFixSpawned()
    f.ev('fix', {
      type: 'done',
      result: 'F1 fixed\nF2 disputed: the null check is already there',
      usage: { input: 1, output: 1 },
    })
    f.exit('fix')
    f.reconcile('end-of-pass')
    f.snapshot('S2', 'tree-fixed')
    f.check([trusted('test')], 'verify:2')
    f.round([result('test', 'pass')], [], 'verify:2')
    expect(f.state.findings?.wrong).toEqual({ disputed: ['m2'], wrong: ['m2'] })
    const doc = f.log.filter((e) => e.t === 'writeFindings').at(-1)
    expect(doc?.t === 'writeFindings' && doc.doc.metrics).toEqual({ disputed: 1, wrong: 1, wrongIds: ['m2'] })
    expect(f.state.notes.some((n) => n.startsWith('One finding turned out wrong'))).toBe(true)
  })

  it('without checks after Fix a dispute stays unconfirmed (disputed, not wrong)', () => {
    const f = new Direct(directConfig()).toReview()
    f.report('review', 'ok', [located('m1', 'must')])
    f.snapshot('post-review', 'tree-changed')
    f.toFixSpawned()
    f.ev('fix', { type: 'done', result: 'F1 disputed: not a bug', usage: { input: 1, output: 1 } })
    f.exit('fix')
    f.reconcile('end-of-pass')
    f.snapshot('S2', 'tree-fixed')
    expect(f.state.findings?.wrong).toEqual({ disputed: ['m1'], wrong: [] })
  })
})
