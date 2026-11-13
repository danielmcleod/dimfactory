// The grounding checks in the state machine (the reducer only; the controller's answers are played by the drivers):
//   - off without a controller (ReducerContext.grounding absent): no request, the flow as before
//   - on: after verify:1 and its snapshot, one `groundingCheck` over Implement's own snapshots, with its result,
//     the plan, the tool evidence and the Verify round; the run waits on it (Implement's boundary)
//   - its findings (source grounding) join the reviewers' at R8, count against the Fix skip rule and go to Fix
//   - none: the run completes clean; a failure: a note, the run goes on
//   - after Fix: Fix said "F1 fixed" but verify:2 still fails with the same stable id: a [must] contradiction, then the
//     checks over Fix (listed after the others, never sent to the Fix that ran)
//   - a relaunch asks again for a check that was outstanding
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTEXT } from '@core/supervisor/machine.ts'
import type { EffectOf, FindingInput } from '@core/supervisor/types.ts'
import { VFlow, result, trusted, verifyMust } from '../verify/machine-helpers.ts'
import type { VerifyOptions } from '../verify/machine-helpers.ts'

class GFlow extends VFlow {
  constructor(o: VerifyOptions & { grounding?: boolean } = {}) {
    super(o)
    if (o.grounding !== false) this.ctx = { ...DEFAULT_CONTEXT, grounding: true }
  }

  groundingReq(): string {
    return this.req((r) => r.kind === 'grounding', 'grounding')
  }

  ground(findings: FindingInput[] = [], notes: string[] = []): this {
    this.send({ t: 'grounding-result', req: this.groundingReq(), findings, notes })
    return this
  }
}

const ghost: FindingInput = {
  id: 'g-ghost',
  severity: 'must',
  title: 'The AI said it changed `src/x.ts`, but there is no such file.',
  body: '',
  source: 'grounding',
  flags: ['possible-hallucination'],
}

const lastCheck = (f: GFlow): EffectOf<'groundingCheck'> | undefined =>
  f.log.filter((e): e is EffectOf<'groundingCheck'> => e.t === 'groundingCheck').at(-1)

describe('grounding checks in the reducer', () => {
  it('without a controller to answer them, nothing is asked and the run completes as before', () => {
    const f = new GFlow({
      grounding: false,
      runAfter: ['implement'],
      review: false,
      critic: false,
      fix: false,
    })
    f.toVerified(result('test', 'pass'))
    expect(lastCheck(f)).toBeUndefined()
    expect(f.state.outcome).toBe('clean')
  })

  it('asks once after verify:1 with what the reducer knows, and waits for the answer', () => {
    const f = new GFlow({ runAfter: ['implement'], review: false, critic: false, fix: false })
    f.toS1()
    f.ev('implement', { type: 'tool', id: 't1', name: 'Bash', summary: 'npm test', phase: 'start', fp: 'a' })
    f.check([trusted('test')])
    f.round([result('test', 'pass')])
    f.snapshot('post-verify-1', 'tree-changed')
    const e = lastCheck(f)
    expect(e).toMatchObject({
      step: 'implement',
      from: 'c-S0',
      to: 'c-S1',
      finalText: 'implemented',
      registryCheck: false,
      verify: [{ name: 'test', argv: ['npm', 'run', 'test'], status: 'pass' }],
    })
    expect(e?.judge).toBeUndefined()
    expect(f.state.boundary).toEqual({ name: 'grounding-check', step: 'implement' })
    expect(f.state.outcome).toBeUndefined()
    // A repeat reduction asks nothing more.
    f.tick(1).send({ t: 'timer', id: 'none', due: f.now })
    expect(f.log.filter((x) => x.t === 'groundingCheck')).toHaveLength(1)
    f.ground()
    expect(f.state.outcome).toBe('clean')
    expect(f.state.grounding?.checks['implement']).toMatchObject({ phase: 'done', findings: [] })
  })

  it('counts the evidence of shell commands by kind (never the commands)', () => {
    const f = new GFlow({ runAfter: [], review: false, critic: false, fix: false })
    f.toImplementRunning()
    f.ev('implement', { type: 'tool', id: 't1', name: 'Bash', summary: 'npm test', phase: 'start', fp: 'a' })
    f.ev('implement', { type: 'tool', id: 't2', name: 'Bash', summary: 'ls', phase: 'start', fp: 'b' })
    expect(f.step('implement').grounding).toMatchObject({ shells: 2, tests: 1, builds: 0 })
    expect(JSON.stringify(f.step('implement').grounding)).not.toContain('npm test')
  })

  it('a grounding finding joins at R8, blocks the clean outcome and goes to Fix', () => {
    const f = new GFlow({
      runAfter: ['implement'],
      review: false,
      critic: false,
      fix: true,
      beforeFix: false,
    })
    f.toVerified(result('test', 'pass'))
    f.ground([ghost], ['The plan names a file the run did not change: src/y.ts.'])
    const list = f.state.findings?.list ?? []
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'g-ghost', source: 'grounding', severity: 'must', n: 1 })
    expect(list[0]?.flags).toEqual(['possible-hallucination'])
    expect(f.state.findings?.selected).toEqual(['g-ghost'])
    expect(f.state.outcome).toBeUndefined()
    expect(f.state.notes).toContain('The plan names a file the run did not change: src/y.ts.')
    expect(f.state.notes.some((n) => n.includes('grounding checks found one problem'))).toBe(true)
    // findings.json lists the grounding source.
    const write = f.log.filter((e): e is EffectOf<'writeFindings'> => e.t === 'writeFindings').at(-1)
    expect(write?.doc.sources.grounding).toMatchObject({ status: 'ok', count: 1 })
    // Fix's launch starts (R10's reconcile).
    expect(f.findReq((r) => r.kind === 'reconcile' && r.boundary === 'pre-fix')).toBeDefined()
  })

  it('a check that could not run is a note and the run goes on', () => {
    const f = new GFlow({ runAfter: ['implement'], review: false, critic: false, fix: false })
    f.toVerified(result('test', 'pass'))
    f.send({
      t: 'grounding-result',
      req: f.groundingReq(),
      findings: [],
      notes: [],
      failure: { category: 'snapshot_failed', message: 'git broke', raw: '', classifiedBy: 'app' },
    })
    expect(f.state.notes).toContain(
      'Dim Factory could not run the grounding checks after Implement: git broke',
    )
    expect(f.state.outcome).toBe('clean')
  })

  it('Fix said F1 fixed but verify:2 still fails with the same id: a [must] contradiction, then the checks over Fix', () => {
    const f = new GFlow({ runAfter: ['implement', 'fix'], review: false, critic: false, beforeFix: false })
    f.toVerified(result('test', 'fail'), [verifyMust('test')])
    f.ground()
    expect(f.state.findings?.list.map((x) => x.id)).toEqual(['v-test'])
    f.fixToS2()
    f.check([trusted('test')], 'verify:2')
    f.round([result('test', 'fail')], [verifyMust('test')], 'verify:2')
    const list = f.state.findings?.list ?? []
    const contradiction = list.find((x) => x.source === 'grounding')
    expect(contradiction).toMatchObject({ severity: 'must', n: list.length })
    expect(contradiction?.title).toMatch(/^Fix said F1 was fixed, but the next check still finds it/)
    // Not sent to the Fix that already ran.
    expect(f.state.findings?.selected).toEqual(['v-test'])
    expect(f.state.notes).toContain('Fix said a finding was fixed, but the next check still finds it.')
    // The checks over Fix: its own snapshots and verify:2.
    expect(lastCheck(f)).toMatchObject({ step: 'fix', from: 'c-fix-start', to: 'c-S2' })
    expect(f.state.outcome).toBeUndefined()
    const ghostAfter = { ...ghost, id: 'g-after-fix', severity: 'should' as const }
    f.ground([ghostAfter])
    expect(f.state.findings?.list.at(-1)).toMatchObject({ id: 'g-after-fix', n: list.length + 1 })
    expect(f.state.outcome).toBe('verify-failed')
  })

  it('a Fix that reports nothing fixed raises no contradiction', () => {
    const f = new GFlow({ runAfter: ['implement', 'fix'], review: false, critic: false, beforeFix: false })
    f.toVerified(result('test', 'fail'), [verifyMust('test')])
    f.ground()
    f.toFixSpawned()
    f.ev('fix', { type: 'done', result: 'I could not reproduce it.' })
    f.exit('fix')
    f.reconcile('end-of-pass')
    f.snapshot('S2', 'tree-fixed')
    f.check([trusted('test')], 'verify:2')
    f.round([result('test', 'fail')], [verifyMust('test')], 'verify:2')
    expect(f.state.findings?.list.filter((x) => x.source === 'grounding')).toEqual([])
  })

  it('a relaunch asks again for a check that was outstanding', () => {
    const f = new GFlow({ runAfter: ['implement'], review: false, critic: false, fix: false })
    f.toVerified(result('test', 'pass'))
    f.send({ t: 'relaunch' })
    expect(f.fx('groundingCheck')).toHaveLength(1)
    expect(f.state.grounding?.checks['implement']?.phase).toBe('requested')
    f.ground()
    expect(f.state.grounding?.checks['implement']?.phase).toBe('done')
  })
})
