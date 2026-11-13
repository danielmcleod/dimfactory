// The security advisor in the state machine (the reducer only; the controller's answers are played by the drivers):
//   - off (every profile but thorough): the scan, Security and re-check steps are settled as not used from the start,
//     never spawned, never cancelled, never shown
//   - on: S1 → verify:1 → the scan (a runner step, no tokens: its check, its trust, its result) → reconcile(pre-review)
//     → Review ∥ Critic ∥ Security in one join (all three spawn together; the join waits for all three)
//   - join outcomes: all clean → completed(clean); one failing → the run reads failed (the others finish) until Retry
//     or Continue without (then it is not reported clean); one paused → paused
//   - findings: [security:<level>] findings and the scan's join the reviewers' at R8 (critical/high must), and Fix
//     gets them
//   - trust gating of the audits: non-Auto opens a trust card ([Trust] writes the grant, [Skip] leaves it out);
//     Auto never trusts (an info note, never a finding); Stop cancels a running scan
//   - the re-check after Fix: every security must resolved → fixed; one open or an answer naming none →
//     security-open ("Completed with failures"); Continue without it → findings-open; off → not run
import { describe, expect, it } from 'vitest'
import type { AgentStep } from '@shared/run.ts'
import type { Failure } from '@shared/failure.ts'
import type { NormalizedEvent } from '@shared/events.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import { buildPrompt, promptDiffRange, scanSection } from '@core/supervisor/effects.ts'
import { DEFAULT_CONTEXT, SCAN_REASON, recheckTargets } from '@core/supervisor/machine.ts'
import type {
  FindingInput,
  Reduction,
  RunConfig,
  ScanCheckAudit,
  SourceParseStatus,
} from '@core/supervisor/types.ts'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { makeRun } from '../supervisor/helpers.ts'
import { must, should } from '../supervisor/helpers.review.ts'
import { result, trusted, VFlow } from '../verify/machine-helpers.ts'
import type { VerifyOptions } from '../verify/machine-helpers.ts'

const audit = (trust: ScanCheckAudit['trust'] = 'trusted'): ScanCheckAudit => ({
  name: 'npm audit',
  tool: 'npm',
  lockfile: 'package-lock.json',
  argv: ['npm', 'audit', '--json'],
  cwdRel: '.',
  body: '{"test":"vitest"}',
  trust,
})

const secMust = (id: string, level: 'critical' | 'high' = 'critical'): FindingInput => ({
  id,
  severity: 'must',
  level,
  title: `\`src/a.ts:3\`: problem ${id}`,
  body: 'fix it',
})

const secret: FindingInput = {
  id: 'scan-secret',
  severity: 'must',
  level: 'critical',
  title: '`src/config.ts:2`: AWS access key ID committed in the code (AKIA… (20 chars)).',
  body: 'Remove it',
  source: 'scan',
}

class SFlow extends VFlow {
  constructor(o: VerifyOptions & { security?: boolean; recheck?: boolean } = {}) {
    super(o)
    const config: RunConfig = structuredClone(this.state.config)
    config.passes.security = {
      enabled: o.security ?? true,
      vendor: 'claude',
      model: 'opus',
      mode: 'readonly',
      ...(o.recheck === false ? { recheck: false } : {}),
    }
    this.state = makeRun(config)
  }

  override get reviewers(): ('review' | 'critic' | 'security')[] {
    return (['review', 'critic', 'security'] as const).filter((k) => this.state.config.passes[k].enabled)
  }

  agentNo(step: AgentStep): number {
    return this.state.steps[step].proc?.spawnNo ?? 0
  }

  agentEv(step: AgentStep, ev: NormalizedEvent): Reduction {
    return this.send({ t: 'adapter', step, spawnNo: this.agentNo(step), ev })
  }

  agentExit(step: AgentStep, failure?: Failure): Reduction {
    return this.send({
      t: 'exit',
      step,
      spawnNo: this.agentNo(step),
      code: failure !== undefined ? 1 : 0,
      signal: null,
      ranMs: 5000,
      ...(failure !== undefined ? { failure } : {}),
    })
  }

  agentPreflight(step: AgentStep): Reduction {
    const req = this.req(
      (r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === step,
      `passBoundary ${step}`,
    )
    return this.send({
      t: 'preflight-result',
      req,
      report: { mode: 'passBoundary', ok: true, blocking: [], warnings: [], info: [] },
    })
  }

  scanCheck(audits: ScanCheckAudit[] = [], notes: string[] = []): Reduction {
    const req = this.req((r) => r.kind === 'scan-check', 'scan-check')
    return this.send({ t: 'scan-check-result', req, audits, notes })
  }

  scanResult(
    findings: FindingInput[] = [],
    o: { audits?: { name: string; status: 'done' }[] } = {},
  ): Reduction {
    const req = this.req((r) => r.kind === 'scan', 'scan')
    return this.send({
      t: 'scan-result',
      req,
      secrets: findings
        .filter((f) => f.id === 'scan-secret')
        .map(() => ({
          file: 'src/config.ts',
          line: 2,
          label: 'AWS access key ID',
          masked: 'AKIA… (20 chars)',
          confidence: 'pattern' as const,
          level: 'critical' as const,
        })),
      audits: o.audits ?? [],
      advisories: [],
      existing: 0,
      notes: [],
      findings,
    })
  }

  /** S1 → verify:1 (pass) → post-verify-1 → the scan (no audits) → reconcile(pre-review) → reviewers spawned. */
  toThreeReviewers(scanFindings: FindingInput[] = []): this {
    this.toVerified(result('test', 'pass'))
    this.scanCheck()
    this.scanResult(scanFindings)
    this.reconcile('pre-review')
    for (const k of this.reviewers) this.passPreflight(k)
    return this
  }

  reportAll(
    review: [SourceParseStatus, FindingInput[]] = ['none', []],
    critic: [SourceParseStatus, FindingInput[]] = ['none', []],
    security: [SourceParseStatus, FindingInput[]] = ['none', []],
  ): this {
    this.report('review', ...review)
    this.report('critic', ...critic)
    this.report('security', ...security)
    if (this.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review') !== undefined) {
      this.snapshot('post-review', 'tree-changed')
    }
    return this
  }

  /** Fix → S2 → verify:2 passes → the re-check spawned (when it applies). */
  fixToRecheck(): this {
    this.fixToS2()
    this.check([trusted('test')], 'verify:2')
    this.round([result('test', 'pass')], [], 'verify:2')
    if (this.findReq((r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === 'recheck')) {
      this.agentPreflight('recheck')
    }
    return this
  }

  recheckAnswer(text: string): this {
    this.agentEv('recheck', { type: 'done', result: text, usage: { input: 5, output: 5 } })
    this.agentExit('recheck')
    return this
  }
}

const spawned = (f: SFlow): string[] =>
  f.log.flatMap((e) => (e.t === 'spawn' ? [e.step] : e.t === 'scanCheck' || e.t === 'scan' ? [e.t] : []))

describe('security advisor off', () => {
  it('settles its steps as not used from the start: never spawned, hidden, untouched by Stop', () => {
    const f = new SFlow({ security: false, runAfter: ['implement'] })
    for (const k of ['scan', 'security', 'recheck'] as const) {
      expect(f.step(k).status).toBe('skipped')
      expect(f.step(k).reason).toBe('not used')
      expect(f.step(k).attempt).toBe(0)
    }
    f.toVerified(result('test', 'pass'))
    f.reconcile('pre-review')
    for (const k of f.reviewers) f.passPreflight(k)
    expect(f.reviewers).toEqual(['review', 'critic'])
    f.report('review', 'none')
    f.report('critic', 'none')
    f.snapshot('post-review', 'tree-changed')
    expect(f.state.outcome).toBe('clean')
    expect(spawned(f)).not.toContain('security')
    expect(spawned(f)).not.toContain('scanCheck')
    const snap = toRunSnapshot(f.state, 0)
    expect(snap.steps.scan.planned).toBeUndefined()
    expect(snap.steps.recheck.planned).toBeUndefined()
  })

  it('reads a run.json written before the advisor (no Security pass) as off', () => {
    const f = new SFlow({ security: false })
    const passes = { ...f.state.config.passes } as Partial<RunConfig['passes']>
    delete passes.security
    const legacy = { ...f.state, config: { ...f.state.config, passes: passes as RunConfig['passes'] } }
    expect(() => toRunSnapshot(legacy, 0)).not.toThrow()
  })
})

describe('Review ∥ Critic ∥ Security join', () => {
  it('plans the scan and the re-check from the start and runs the scan before the reviewers', () => {
    const f = new SFlow({ runAfter: ['implement'] })
    const before = toRunSnapshot(f.state, 0)
    expect(before.steps.scan.planned).toBe(true)
    expect(before.steps.recheck.planned).toBe(true)
    f.toVerified(result('test', 'pass'))
    expect(f.step('scan').status).toBe('running')
    expect(f.state.phase).toBe('reviewing')
    // The reviewers wait for the scan.
    expect(f.findReq((r) => r.kind === 'reconcile' && r.boundary === 'pre-review')).toBeUndefined()
    f.scanCheck()
    expect(f.fx('scan')[0]).toMatchObject({ from: 'c-S0', to: 'c-S1', audits: [] })
    f.scanResult()
    expect(f.step('scan').status).toBe('done')
    f.reconcile('pre-review')
    for (const k of f.reviewers) f.passPreflight(k)
    // All three spawn in the same reduction (the join's barrier).
    const last = f.effects.filter((e) => e.t === 'spawn').map((e) => (e.t === 'spawn' ? e.step : ''))
    expect(last.sort()).toEqual(['critic', 'review', 'security'])
    expect(f.fx('spawn').find((e) => e.step === 'security')).toMatchObject({
      model: 'opus',
      mode: 'readonly',
    })
  })

  it('all three clean (and a clean scan) completes clean; the re-check is not needed', () => {
    const f = new SFlow({ runAfter: ['implement'] }).toThreeReviewers()
    f.reportAll()
    expect(f.state.outcome).toBe('clean')
    expect(f.step('recheck').status).toBe('skipped')
    expect(f.step('fix').status).toBe('skipped')
  })

  it('waits for the slowest of the three', () => {
    const f = new SFlow({ runAfter: ['implement'] }).toThreeReviewers()
    f.report('review', 'none')
    f.report('critic', 'none')
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review')).toBeUndefined()
    expect(f.state.outcome).toBeUndefined()
    f.report('security', 'none')
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review')).toBeDefined()
  })

  it('a failing Security reads failed while the others finish; Continue without it is never clean', () => {
    const f = new SFlow({ runAfter: ['implement'] }).toThreeReviewers()
    f.ev('security', { type: 'session', id: 'sec-session' })
    f.exit('security', {
      code: 1,
      failure: { category: 'stream_malformed', message: 'broke', raw: '', classifiedBy: 'app' },
    })
    f.report('review', 'none')
    f.report('critic', 'none')
    // Its automatic retry first.
    if (f.step('security').status !== 'failed') {
      f.passPreflight('security')
      f.exit('security', {
        code: 1,
        failure: { category: 'stream_malformed', message: 'broke again', raw: '', classifiedBy: 'app' },
      })
    }
    expect(f.step('security').status).toBe('failed')
    expect(f.state.status).toBe('failed')
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review')).toBeUndefined()
    f.user({ kind: 'skip', step: 'security' })
    f.snapshot('post-review', 'tree-changed')
    expect(f.state.outcome).toBeUndefined()
    expect(f.state.notes.some((n) => n.includes('Security did not review the change'))).toBe(true)
    expect(f.card('gate:beforeFix')).toBeDefined()
  })

  it('a paused Security (relaunch) holds the join until Resume', () => {
    const f = new SFlow({ runAfter: ['implement'] }).toThreeReviewers()
    f.ev('security', { type: 'session', id: 'sec-session' })
    f.report('review', 'none')
    f.report('critic', 'none')
    f.send({ t: 'relaunch' })
    expect(f.step('security').status).toBe('paused')
    expect(f.state.status).toBe('paused')
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review')).toBeUndefined()
  })
})

describe('security findings', () => {
  it('join the reviewers at R8 (with the scan’s), must first, and reach Fix with their level', () => {
    const f = new SFlow({ runAfter: ['implement'] }).toThreeReviewers([secret])
    f.reportAll(
      ['ok', [should('r1')]],
      ['none', []],
      ['ok', [secMust('s1'), { ...should('s2'), level: 'low' }]],
    )
    const fs = f.state.findings
    expect(fs?.list.map((x) => [x.source, x.severity, x.level])).toEqual([
      ['security', 'must', 'critical'],
      ['scan', 'must', 'critical'],
      ['review', 'should', undefined],
      ['security', 'should', 'low'],
    ])
    const gate = f.card('gate:beforeFix')
    expect(gate.view.body).toContain('(security)')
    const cfg = resolveBuiltinConfig({ profile: 'thorough' })
    f.choose('gate:beforeFix', 'continue')
    f.toFixSpawned()
    const spawn = f.log.filter((e) => e.t === 'spawn').at(-1)
    if (spawn?.t !== 'spawn') throw new Error('no Fix spawn')
    const prompt = buildPrompt(f.state, cfg, spawn).text
    expect(prompt).toContain('[security:critical]')
    expect(prompt).toContain('Never silence a check')
    expect(prompt).toContain('3 findings below are about security.')
  })

  it('scan findings alone block the Fix skip rule', () => {
    const f = new SFlow({ runAfter: ['implement'] }).toThreeReviewers([secret])
    f.reportAll()
    expect(f.state.outcome).toBeUndefined()
    expect(f.card('gate:beforeFix').view.title).toContain('1 must')
  })

  it('the Security pass gets {{scan}} (masked) and the run diff; the re-check gets the Fix diff', () => {
    const f = new SFlow({ runAfter: ['implement'] }).toThreeReviewers([secret])
    const text = scanSection(f.state)
    expect(text).toContain('AKIA… (20 chars)')
    expect(text).toContain('`src/config.ts:2`')
    const spawn = f.log.find((e) => e.t === 'spawn' && e.step === 'security')
    if (spawn?.t !== 'spawn') throw new Error('no Security spawn')
    expect(promptDiffRange(f.state, spawn)?.label).toBe('S0..S1')
    const cfg: ResolvedConfig = resolveBuiltinConfig({ profile: 'thorough' })
    const p = buildPrompt(f.state, cfg, spawn, { diff: 'DIFF' }).text
    expect(p).toContain('OWASP Top 10')
    expect(p).toContain('AKIA… (20 chars)')
    expect(p).toContain('DIFF')
    expect(promptDiffRange(f.state, { step: 'recheck', launch: { fresh: {} } })?.label).toBe('F0..S2')
  })
})

describe('trust gating of the dependency audits', () => {
  it('non-Auto: a trust card for an untrusted audit; Trust writes the grant and the audit runs', () => {
    const f = new SFlow({ runAfter: ['implement'] })
    f.toVerified(result('test', 'pass'))
    f.scanCheck([audit('untrusted')])
    expect(f.step('scan').status).toBe('waiting')
    const card = f.card('trust')
    expect(card.view.payload).toMatchObject({ step: 'scan', name: 'npm audit' })
    expect(card.view.body).toContain('The security scan wants to run `npm audit --json`')
    expect(card.view.defaultChoice).toBeUndefined()
    f.choose('trust', 'trust')
    expect(f.fx('trustGrant')[0]?.command).toMatchObject({ kind: 'verify', argv: ['npm', 'audit', '--json'] })
    const req = f.req((r) => r.kind === 'scan-grant', 'scan-grant')
    f.send({ t: 'trust-grant-result', req, ok: true })
    expect(f.fx('scan')[0]?.audits[0]).toMatchObject({ name: 'npm audit', run: true })
  })

  it('non-Auto: Skip leaves the audit out (not run, not a finding)', () => {
    const f = new SFlow({ runAfter: ['implement'] })
    f.toVerified(result('test', 'pass'))
    f.scanCheck([audit('changed')])
    f.choose('trust', 'skip')
    expect(f.fx('scan')[0]?.audits[0]).toMatchObject({
      run: false,
      status: 'skipped',
      reason: SCAN_REASON.userSkipped,
    })
    f.scanResult()
    expect(f.state.security?.scan?.findings).toEqual([])
  })

  it('Auto never trusts an audit: no card, not run, an info note', () => {
    const f = new SFlow({ runAfter: ['implement'], auto: true })
    f.toVerified(result('test', 'pass'))
    f.scanCheck([audit('untrusted')])
    expect(f.state.cards.some((c) => c.view.kind === 'trust')).toBe(false)
    expect(f.fx('scan')[0]?.audits[0]).toMatchObject({ run: false })
    expect(f.state.security?.scan?.notes.some((n) => n.startsWith('Auto did not run npm audit'))).toBe(true)
  })

  it('Stop cancels a running scan and settles its rows', () => {
    const f = new SFlow({ runAfter: ['implement'] })
    f.toVerified(result('test', 'pass'))
    f.scanCheck([audit('trusted')])
    const req = f.req((r) => r.kind === 'scan', 'scan')
    f.user({ kind: 'stop' })
    expect(f.fx('scanStop')).toEqual([{ t: 'scanStop', req }])
    expect(f.state.security?.scan?.audits[0]).toMatchObject({
      status: 'skipped',
      reason: SCAN_REASON.stopped,
    })
    expect(f.step('scan').status).toBe('cancelled')
  })

  it('a relaunch pauses the scan; Resume runs it again from its check', () => {
    const f = new SFlow({ runAfter: ['implement'] })
    f.toVerified(result('test', 'pass'))
    f.scanCheck([audit('trusted')])
    f.send({ t: 'relaunch' })
    expect(f.step('scan').status).toBe('paused')
    f.user({ kind: 'resume' })
    expect(f.step('scan').status).toBe('running')
    expect(f.fx('scanCheck')).toHaveLength(1)
  })
})

describe('the security re-check after Fix', () => {
  const toRecheck = (o: { recheck?: boolean } = {}): SFlow => {
    const f = new SFlow({ runAfter: ['implement', 'fix'], ...o }).toThreeReviewers([secret])
    f.reportAll(['ok', [must('plain')]], ['none', []], ['ok', [secMust('s1', 'high')]])
    f.choose('gate:beforeFix', 'continue')
    return f.fixToRecheck()
  }

  it('checks only the security [must] findings Fix was given, on the Security pass config', () => {
    const f = toRecheck()
    expect(recheckTargets(f.state).map((x) => x.source)).toEqual(['security', 'scan'])
    const spawn = f.fx('spawn').find((e) => e.step === 'recheck')
    expect(spawn).toMatchObject({ vendor: 'claude', model: 'opus', mode: 'readonly' })
    expect(f.state.phase).toBe('security-recheck')
    const cfg = resolveBuiltinConfig({ profile: 'thorough' })
    if (spawn === undefined) throw new Error('no recheck spawn')
    const prompt = buildPrompt(f.state, cfg, spawn, { diff: 'FIXDIFF' }).text
    expect(prompt).toContain('F<n> resolved')
    expect(prompt).toContain('FIXDIFF')
    expect(prompt).toContain('(security) [security:high]')
    expect(prompt).not.toContain('must plain')
  })

  // The list is must first in source order: Review's [must] is F1, Security's F2, the scan's secret F3.
  it('every one resolved → fixed', () => {
    const f = toRecheck()
    expect(recheckTargets(f.state).map((x) => x.n)).toEqual([2, 3])
    f.recheckAnswer('F2 resolved\nF3 resolved')
    expect(f.state.outcome).toBe('fixed')
    expect(toRunSnapshot(f.state, 0).steps.recheck.recheck).toEqual({
      status: 'resolved',
      resolved: [2, 3],
      open: [],
    })
  })

  it('one still open → security-open, with a note', () => {
    const f = toRecheck().recheckAnswer('- F2 resolved\n- **F3** open: the key is still in config.ts')
    expect(f.state.outcome).toBe('security-open')
    expect(f.state.notes.some((n) => n.includes('security re-check found F3 still open'))).toBe(true)
    expect(f.state.security?.recheck?.open).toEqual([{ n: 3, reason: 'the key is still in config.ts' }])
  })

  it('an answer naming none of them → unclear, treated as open', () => {
    const f = toRecheck().recheckAnswer('Looks fine to me.')
    expect(f.state.security?.recheck?.status).toBe('unclear')
    expect(f.state.outcome).toBe('security-open')
  })

  it('Continue without the re-check → findings-open (not confirmed)', () => {
    const f = toRecheck()
    f.agentExit('recheck', { category: 'stream_malformed', message: 'x', raw: '', classifiedBy: 'app' })
    if (f.step('recheck').status !== 'failed') {
      f.agentPreflight('recheck')
      f.agentExit('recheck', {
        category: 'stream_malformed',
        message: 'y',
        raw: '',
        classifiedBy: 'app',
      })
    }
    expect(f.step('recheck').status).toBe('failed')
    f.user({ kind: 'skip', step: 'recheck' })
    expect(f.state.outcome).toBe('findings-open')
  })

  it('turned off: skipped from the start (hidden); Fix ends the run as usual', () => {
    const f = toRecheck({ recheck: false })
    expect(f.step('recheck')).toMatchObject({ status: 'skipped', reason: 'disabled', attempt: 0 })
    expect(f.state.outcome).toBe('fixed')
  })

  it('a failing verify:2 still wins over an open security finding', () => {
    const f = new SFlow({ runAfter: ['implement', 'fix'] }).toThreeReviewers()
    f.reportAll(['none', []], ['none', []], ['ok', [secMust('s1')]])
    f.choose('gate:beforeFix', 'continue')
    f.fixToS2()
    f.check([trusted('test')], 'verify:2')
    f.round([result('test', 'fail')], [], 'verify:2')
    f.agentPreflight('recheck')
    f.recheckAnswer('F1 open: no')
    expect(f.state.outcome).toBe('verify-failed')
    expect(f.state.notes.some((n) => n.startsWith('Also, the security re-check'))).toBe(true)
  })
})

describe('reducer context', () => {
  it('builds the security steps in this build', () => {
    expect(DEFAULT_CONTEXT.buildSteps).toEqual(expect.arrayContaining(['scan', 'security', 'recheck']))
  })
})
