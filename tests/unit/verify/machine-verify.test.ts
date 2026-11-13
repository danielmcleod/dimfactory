// Verify reducer table (the verify step, the Fix skip rule, R6/R7/R8/R11 and the runner-step note):
// one case per new row or branch: verify off, runAfter subsets, pass / fail / env / untrusted / changed, failFast,
// Auto against non-Auto, the trust and verifyEnv cards, Stop, quit and relaunch during a round.
import { describe, expect, it } from 'vitest'
import { TRUST_CHOICE, VERIFY_ENV_CHOICE, trustPayloadOf } from '@core/supervisor/cards.ts'
import type { TrustCardPayload } from '@core/supervisor/cards.ts'
import { selectedFindings, toRunSnapshot } from '@core/supervisor/derive.ts'
import {
  VERIFY_REASON,
  folderBusyReason,
  fixSkipRuleHolds,
  latestVerifyHasMust,
  reconcileInput,
} from '@core/supervisor/machine.ts'
import { must } from '../supervisor/helpers.review.ts'
import { VFlow, changed, result, trusted, untrusted, verifyMust, verifyShould } from './machine-helpers.ts'

describe('verify:1 after Implement', () => {
  it('verify off → verify:1 skipped "verify off"; no trust check; reconcile(pre-review) at once', () => {
    const f = new VFlow({ enabled: false }).toS1()
    expect(f.step('verify:1')).toMatchObject({ status: 'skipped', reason: 'verify off' })
    expect(f.fx('verifyCheck')).toEqual([])
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-review' })])
  })

  it('runAfter = [fix] → verify:1 skipped "verify off"', () => {
    const f = new VFlow({ runAfter: ['fix'] }).toS1()
    expect(f.step('verify:1')).toMatchObject({ status: 'skipped', reason: 'verify off' })
    expect(f.state.flow.postVerify1).toBeUndefined()
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-review' })])
  })

  it('runAfter ∋ implement → the trust check (bodies re-read) first; the run reads verifying', () => {
    const f = new VFlow().toS1()
    expect(f.step('verify:1')).toMatchObject({ status: 'running', attempt: 1 })
    expect(f.fx('verifyCheck')).toEqual([
      { t: 'verifyCheck', req: f.checkReq(), step: 'verify:1', attempt: 1 },
    ])
    expect(f.state).toMatchObject({ status: 'running', phase: 'verifying' })
    expect(f.fx('reconcile')).toEqual([])
  })

  it('no changes → no verify (R6 completes no-changes first)', () => {
    const f = new VFlow().toS1('tree-base')
    expect(f.state.outcome).toBe('no-changes')
    expect(f.step('verify:1')).toMatchObject({ status: 'skipped', reason: 'no changes' })
  })

  it('trusted commands → the round runs them in configured order', () => {
    const f = new VFlow().toS1()
    f.check([trusted('typecheck'), trusted('test')])
    const [fx] = f.fx('verify')
    expect(fx).toMatchObject({ step: 'verify:1', attempt: 1 })
    expect(fx?.commands).toEqual([
      { name: 'typecheck', argv: ['npm', 'run', 'typecheck'], cwdRel: '.', run: true },
      { name: 'test', argv: ['npm', 'run', 'test'], cwdRel: '.', run: true },
    ])
    expect(f.step('verify:1').verify?.commands.map((c) => c.status)).toEqual(['queued', 'queued'])
  })

  it('a command that cannot run as configured is skipped with its reason, never asked about', () => {
    const f = new VFlow().toS1()
    f.check([
      {
        name: 'lint',
        argv: [],
        cwdRel: '.',
        body: null,
        trust: 'invalid',
        reason: '`|` needs a shell: use a package script',
      },
      trusted('test'),
    ])
    expect(f.state.cards).toEqual([])
    expect(f.fx('verify')[0]?.commands[0]).toEqual({
      name: 'lint',
      argv: [],
      cwdRel: '.',
      run: false,
      status: 'skipped',
      reason: '`|` needs a shell: use a package script',
    })
  })

  it('no enabled command → the round reads skipped "no commands to run"', () => {
    const f = new VFlow().toS1()
    f.check([])
    f.round([])
    expect(f.step('verify:1')).toMatchObject({ status: 'skipped', reason: 'no commands to run' })
  })
})

describe('verify:1 terminal → post-verify-1 → reconcile(pre-review) → Review ∥ Critic', () => {
  it('a passing round: done; the post-verify-1 snapshot (still verifying); equal to S1 → no note', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    f.round([result('test', 'pass')])
    expect(f.step('verify:1').status).toBe('done')
    expect(f.fx('snapshot')).toEqual([expect.objectContaining({ label: 'post-verify-1' })])
    expect(f.state.boundary).toEqual({ name: 'post-verify-1', step: 'verify:1' })
    expect(f.state).toMatchObject({ status: 'running', phase: 'verifying' })
    f.snapshot('post-verify-1', 'tree-changed')
    expect(f.state.notes).not.toContain('Files changed while the verify commands ran; the changes are kept.')
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-review' })])
    expect(reconcileInput(f.state, 'pre-review').last).toBe('c-post-verify-1')
  })

  it('post-verify-1 ≠ S1 → a note; the reviewers still get S0..S1 (+ the verify summary)', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    f.round([result('test', 'pass')])
    f.snapshot('post-verify-1', 'tree-with-coverage')
    expect(f.state.notes).toContain('Files changed while the verify commands ran; the changes are kept.')
    f.reconcile('pre-review')
    expect(f.step('review').status).toBe('running')
  })

  it('the post-review compare is against post-verify-1 (verify output is not a reviewer write)', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    f.round([result('test', 'pass')])
    f.snapshot('post-verify-1', 'tree-with-coverage')
    f.reconcile('pre-review')
    for (const k of f.reviewers) f.passPreflight(k)
    f.report('review', 'none')
    f.report('critic', 'none')
    f.snapshot('post-review', 'tree-with-coverage')
    expect(f.state.notes).not.toContain(
      'Files changed while Review/Critic ran (they should not change anything); the changes are kept.',
    )
    expect(f.state.outcome).toBe('clean')
  })
})

describe('Results: fail → [must], env → verifyEnv, failFast', () => {
  it('a failing command → a [must] finding (source verify) at the join; the skip rule fails; the gate lists it', () => {
    const f = new VFlow().toVerified(result('test', 'fail'), [verifyMust('test')])
    expect(latestVerifyHasMust(f.state)).toBe(true)
    f.toJoinAfterVerify('none', 'none')
    expect(fixSkipRuleHolds(f.state)).toBe(false)
    expect(f.state.outcome).toBeUndefined()
    const list = f.state.findings?.list ?? []
    expect(list).toEqual([
      expect.objectContaining({ id: 'v-test', severity: 'must', source: 'verify', n: 1, round: 1 }),
    ])
    expect(f.card('gate:beforeFix').view.title).toBe('1 finding before Fix: 1 must, 0 should')
    f.choose('gate:beforeFix', 'continue')
    expect(selectedFindings(f.state).map((x) => x.source)).toEqual(['verify'])
  })

  it('verify findings join after the reviewers: must first (review, critic, verify), F1… renumbered', () => {
    const f = new VFlow().toVerified(result('test', 'fail'), [verifyMust('test')])
    f.toJoinAfterVerify('ok', 'none', [must('r1'), { id: 's1', severity: 'should', title: 's', body: '' }])
    expect(f.state.findings?.list.map((x) => [x.n, x.source, x.severity])).toEqual([
      [1, 'review', 'must'],
      [2, 'verify', 'must'],
      [3, 'review', 'should'],
    ])
  })

  it('all reviewers report nothing and verify passes → completed(clean)', () => {
    const f = new VFlow().toVerified(result('test', 'pass'))
    f.toJoinAfterVerify('none', 'none')
    expect(f.state.outcome).toBe('clean')
  })

  it('no reviewers enabled, verify fails, Fix on → Fix runs on the verify finding (Auto: no gate)', () => {
    const f = new VFlow({ review: false, critic: false, auto: true }).toVerified(result('test', 'fail'), [
      verifyMust('test'),
    ])
    // No reviewer: the join decides at once (R10's reconcile(pre-fix) is Fix's own).
    expect(f.state.outcome).toBeUndefined()
    expect(f.step('fix').status).toBe('running')
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-fix' })])
    expect(f.state.findings?.list.map((x) => x.source)).toEqual(['verify'])
  })

  it('verify fails but Fix is off → completed(findings-open), never clean', () => {
    const f = new VFlow({ fix: false }).toVerified(result('test', 'fail'), [verifyMust('test')])
    f.toJoinAfterVerify('none', 'none')
    expect(f.state.outcome).toBe('findings-open')
  })

  it('env (127/9009) → verifyEnv card, never a finding; the step waits; [Retry] reruns the round (attempt 2)', () => {
    const f = new VFlow().toS1()
    f.check([trusted('lint'), trusted('test')])
    f.round([result('lint', 'env', { reason: '"eslint" was not found' }), result('test', 'pass')])
    const card = f.card('verifyEnv')
    expect(card.view).toMatchObject({ blocking: true, defaultChoice: VERIFY_ENV_CHOICE.skipVerify })
    expect(card.view.choices.map((c) => c.label)).toEqual(['Retry', 'Skip verify'])
    expect(card.view.title).toBe('The lint check could not run')
    expect(f.step('verify:1')).toMatchObject({ status: 'waiting', reason: 'checks could not run' })
    expect(f.state).toMatchObject({ status: 'waiting', phase: 'needs-attention' })
    expect(f.fx('notify')).toEqual([expect.objectContaining({ kind: 'card', cardId: card.view.id })])
    f.choose('verifyEnv', VERIFY_ENV_CHOICE.retry)
    expect(f.step('verify:1')).toMatchObject({ status: 'running', attempt: 2 })
    expect(f.fx('verifyCheck')).toEqual([expect.objectContaining({ attempt: 2 })])
    // The rows stay (queued again) until the check answers: nothing on screen empties.
    expect(f.step('verify:1').verify?.commands.map((c) => [c.name, c.status])).toEqual([
      ['lint', 'queued'],
      ['test', 'queued'],
    ])
  })

  it('[Skip verify] → the round is done without what could not run (a note; no finding)', () => {
    const f = new VFlow().toS1()
    f.check([trusted('lint'), trusted('test')])
    f.round([result('lint', 'env'), result('test', 'pass')])
    f.choose('verifyEnv', VERIFY_ENV_CHOICE.skipVerify)
    expect(f.step('verify:1').status).toBe('done')
    expect(f.state.notes).toContain(
      'Verify went on without lint: it could not run here, so it is not a finding.',
    )
    expect(latestVerifyHasMust(f.state)).toBe(false)
    expect(f.fx('snapshot')).toEqual([expect.objectContaining({ label: 'post-verify-1' })])
  })

  it('Auto: the verifyEnv default (Skip verify) is taken with a note; the run is not blocked', () => {
    const f = new VFlow({ auto: true }).toS1()
    f.check([trusted('lint')])
    f.round([result('lint', 'env')])
    expect(f.state.cards).toEqual([])
    expect(f.state.notes).toContain('Auto: "The lint check could not run" → Skip verify')
    expect(f.step('verify:1')).toMatchObject({ status: 'skipped', reason: 'no command ran' })
    expect(f.fx('snapshot')).toEqual([expect.objectContaining({ label: 'post-verify-1' })])
  })

  it('the round could not run at all → verifyEnv names why', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    f.send({
      t: 'verify-result',
      req: f.roundReq(),
      results: [],
      findings: [],
      failure: { category: 'unknown', message: 'boom', raw: '', classifiedBy: 'app' },
    })
    expect(f.card('verifyEnv').view).toMatchObject({ title: 'Verify could not run' })
    expect(f.card('verifyEnv').view.body).toContain('Verify could not run: boom')
  })

  it('failFast: the round reports the rest skipped and `aborted`; StepView.verify says so', () => {
    const f = new VFlow().toS1()
    f.check([trusted('typecheck'), trusted('test')])
    f.round(
      [
        result('typecheck', 'fail'),
        result('test', 'skipped', { reason: 'Not run: an earlier check failed' }),
      ],
      [verifyMust('typecheck')],
      'verify:1',
      true,
    )
    const view = toRunSnapshot(f.state, 0, f.now).steps['verify:1'].verify
    expect(view).toEqual({
      aborted: true,
      commands: [
        expect.objectContaining({ name: 'typecheck', status: 'fail', exitCode: 1, durationMs: 1500 }),
        expect.objectContaining({
          name: 'test',
          status: 'skipped',
          reason: 'Not run: an earlier check failed',
        }),
      ],
    })
  })
})

describe('Trust per round (commands and trust; Auto never implies trust)', () => {
  it('untrusted, non-Auto → a trust card (command + body); the step waits; nothing runs yet', () => {
    const f = new VFlow().toS1()
    f.check([untrusted('test'), trusted('lint')])
    const c = f.card('trust')
    expect(c.view).toMatchObject({ kind: 'trust', blocking: true, title: 'Trust the test check?' })
    expect(c.view.defaultChoice).toBeUndefined()
    expect(c.view.choices).toEqual([
      { id: TRUST_CHOICE.trust, label: 'Trust for this project', primary: true },
      { id: TRUST_CHOICE.skip, label: 'Skip' },
    ])
    expect(c.view.body).toContain('`npm run test`')
    expect(c.view.body).toContain('Script: vitest run')
    expect(c.step).toBe('verify:1')
    expect(f.step('verify:1')).toMatchObject({ status: 'waiting', reason: 'trust needed' })
    expect(f.fx('verify')).toEqual([])
    expect(f.state.phase).toBe('needs-attention')
  })

  it('[Trust for this project] writes the command grant (with the body shown), then the round runs it', () => {
    const f = new VFlow().toS1()
    f.check([untrusted('test')])
    f.choose('trust', TRUST_CHOICE.trust)
    expect(f.fx('trustGrant')).toEqual([
      {
        t: 'trustGrant',
        req: f.grantReq('test'),
        command: { kind: 'verify', argv: ['npm', 'run', 'test'], cwdRel: '.', body: 'vitest run' },
      },
    ])
    expect(f.fx('verify')).toEqual([])
    f.grant('test')
    expect(f.state.notes).toContain('Trusted the verify command test for this project.')
    expect(f.fx('verify')[0]?.commands).toEqual([
      { name: 'test', argv: ['npm', 'run', 'test'], cwdRel: '.', run: true },
    ])
    expect(f.step('verify:1').status).toBe('running')
  })

  it('[Skip] leaves the command out of this round (no finding); the others run', () => {
    const f = new VFlow().toS1()
    f.check([untrusted('test'), trusted('lint')])
    f.choose('trust', TRUST_CHOICE.skip)
    expect(f.fx('verify')[0]?.commands).toEqual([
      {
        name: 'test',
        argv: ['npm', 'run', 'test'],
        cwdRel: '.',
        run: false,
        status: 'skipped',
        reason: VERIFY_REASON.userSkipped,
      },
      { name: 'lint', argv: ['npm', 'run', 'lint'], cwdRel: '.', run: true },
    ])
  })

  it('one card per command; the round waits for every answer', () => {
    const f = new VFlow().toS1()
    f.check([untrusted('lint'), untrusted('test')])
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['trust', 'trust'])
    const [a, b] = f.state.cards
    f.user({ kind: 'card', cardId: a?.view.id ?? '', choiceId: TRUST_CHOICE.skip })
    expect(f.fx('verify')).toEqual([])
    f.user({ kind: 'card', cardId: b?.view.id ?? '', choiceId: TRUST_CHOICE.trust })
    f.grant('test')
    expect(f.fx('verify')).toHaveLength(1)
  })

  it('a grant that cannot be written → the command is skipped with the reason and a note', () => {
    const f = new VFlow().toS1()
    f.check([untrusted('test')])
    f.choose('trust', TRUST_CHOICE.trust)
    f.grant('test', false, 'trust.json is read-only')
    expect(f.fx('verify')[0]?.commands[0]).toMatchObject({ run: false, status: 'skipped' })
    expect(f.state.notes).toContain(
      'The verify command test was skipped: Dim Factory could not save the trust for it (trust.json is read-only).',
    )
  })

  it('body changed since the grant → a trust card with the diff against the granted body', () => {
    const f = new VFlow().toS1()
    f.check([changed('test', 'vitest run', 'vitest run --coverage')])
    const c = f.card('trust')
    expect(c.view.title).toBe('The test check changed since you trusted it')
    const p = c.view.payload as TrustCardPayload
    expect(p).toMatchObject({ trust: 'changed', grantedBody: 'vitest run', body: 'vitest run --coverage' })
    expect(p.diff).toEqual([
      { op: 'del', text: 'vitest run' },
      { op: 'add', text: 'vitest run --coverage' },
    ])
    expect(c.view.body).toContain('- vitest run\n+ vitest run --coverage')
    expect(trustPayloadOf(c.view)).toMatchObject({ step: 'verify:1', name: 'test', trust: 'changed' })
  })

  it('Auto: an untrusted command is skipped (no card) and reported skipped-untrusted; a note says so', () => {
    const f = new VFlow({ auto: true }).toS1()
    f.check([untrusted('test'), trusted('lint')])
    expect(f.state.cards).toEqual([])
    expect(f.fx('trustGrant')).toEqual([])
    expect(f.state.notes).toContain(
      'Auto skipped the verify command test: it is not trusted for this project. Trust it in Settings to run it.',
    )
    expect(f.fx('verify')[0]?.commands[0]).toEqual({
      name: 'test',
      argv: ['npm', 'run', 'test'],
      cwdRel: '.',
      run: false,
      status: 'skipped-untrusted',
      reason: VERIFY_REASON.notTrusted,
    })
  })

  it('Auto: a changed body is skipped too; its [should] finding is listed but does not block the skip rule', () => {
    const f = new VFlow({ auto: true }).toS1()
    f.check([changed('test')])
    expect(f.state.cards).toEqual([])
    f.round([result('test', 'skipped-untrusted', { reason: VERIFY_REASON.changed })], [verifyShould('test')])
    expect(f.step('verify:1')).toMatchObject({ status: 'skipped', reason: 'no command ran' })
    expect(latestVerifyHasMust(f.state)).toBe(false)
    f.snapshot('post-verify-1', 'tree-changed')
    f.toJoinAfterVerify('none', 'none')
    // The skip rule looks at the latest verify's [must] failures only.
    expect(f.state.outcome).toBe('clean')
    expect(f.state.findings?.list).toEqual([
      expect.objectContaining({
        severity: 'should',
        source: 'verify',
        title: 'Skipped untrusted command `npm run test`',
      }),
    ])
  })
})

describe('verify:2 after Fix', () => {
  const toFix = (o: ConstructorParameters<typeof VFlow>[0] = {}): VFlow => {
    const f = new VFlow(o).toVerified(result('test', 'fail'), [verifyMust('test')])
    f.toJoinAfterVerify('none', 'none')
    f.choose('gate:beforeFix', 'continue')
    return f
  }

  it('Fix done → S2 → verify:2 (final-verify); passes → completed(fixed)', () => {
    const f = toFix().fixToS2()
    expect(f.step('verify:2')).toMatchObject({ status: 'running', attempt: 1 })
    expect(f.state.phase).toBe('final-verify')
    f.check([trusted()], 'verify:2')
    f.round([result('test', 'pass')], [], 'verify:2')
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'fixed', lock: 'none' })
    expect(latestVerifyHasMust(f.state)).toBe(false)
  })

  it('failing again → completed(verify-failed) ("Completed with failures"), its findings listed after Fix', () => {
    const f = toFix().fixToS2()
    f.check([trusted()], 'verify:2')
    f.round([result('test', 'fail')], [verifyMust('test')], 'verify:2')
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'verify-failed', lock: 'none' })
    expect(f.state.notes).toContain('Completed with failures: test still fails after Fix.')
    const list = f.state.findings?.list ?? []
    expect(list.map((x) => [x.id, x.n, x.round])).toEqual([
      ['v-test', 1, 1],
      ['v-test-2', 2, 2],
    ])
    const doc = f.log.filter((e) => e.t === 'writeFindings').at(-1)
    expect(doc?.t === 'writeFindings' ? doc.doc.selected : undefined).toEqual({
      'v-test': true,
      'v-test-2': false,
    })
    expect(doc?.t === 'writeFindings' ? doc.doc.sources.verify : undefined).toEqual({
      status: 'ok',
      count: 1,
      rawFile: 'verify/verify-2/output.log',
    })
  })

  it('runAfter = [implement] → verify:2 skipped "verify off" → fixed', () => {
    const f = toFix({ runAfter: ['implement'] }).fixToS2()
    expect(f.step('verify:2')).toMatchObject({ status: 'skipped', reason: 'verify off' })
    expect(f.state.outcome).toBe('fixed')
  })

  it('runAfter = [fix]: verify:1 skipped; verify:2 runs after Fix', () => {
    const f = new VFlow({ runAfter: ['fix'] }).toS1()
    f.toJoinAfterVerify('ok', 'none', [must('r1')])
    f.choose('gate:beforeFix', 'continue')
    f.fixToS2()
    expect(f.step('verify:2').status).toBe('running')
  })

  it('Fix skipped as clean → verify:2 "not needed"', () => {
    const f = new VFlow().toVerified(result('test', 'pass'))
    f.toJoinAfterVerify('none', 'none')
    expect(f.state.outcome).toBe('clean')
    expect(f.step('verify:2')).toMatchObject({ status: 'skipped', reason: 'not needed' })
  })
})

describe('the round as a runner step (own statuses, Stop, quit, relaunch, Resume)', () => {
  it('progress: the running command, a finished one, output (an `output verify:1` body each; not a transition)', () => {
    const f = new VFlow().toS1()
    f.check([trusted('typecheck'), trusted('test')])
    const req = f.roundReq()
    f.send({ t: 'verify-progress', req, running: 'typecheck' })
    expect(f.step('verify:1').verify?.commands.map((c) => c.status)).toEqual(['running', 'queued'])
    expect(f.bodies('output')).toEqual([{ t: 'output', file: 'verify:1', version: 1 }])
    expect(f.last?.transition).toBe(false)
    f.send({ t: 'verify-progress', req, done: result('typecheck', 'pass') })
    f.send({ t: 'verify-progress', req, running: 'test', output: true })
    expect(f.step('verify:1').verify?.commands.map((c) => c.status)).toEqual(['pass', 'running'])
    expect(f.state.outputs['verify:1']).toBe(3)
  })

  it('Stop during a round → verifyStop; cancelled; the lock waits for the round to answer', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    const req = f.roundReq()
    f.user({ kind: 'stop' })
    expect(f.fx('verifyStop')).toEqual([{ t: 'verifyStop', req }])
    expect(f.step('verify:1')).toMatchObject({ status: 'cancelled' })
    expect(f.state.lock).toBe('held')
    f.round([result('test', 'skipped', { reason: 'Stopped' })])
    expect(f.fx('snapshot')).toEqual([expect.objectContaining({ label: 'stopped' })])
    f.snapshot('stopped')
    expect(f.state.lock).toBe('none')
  })

  it('folder busy while verify runs (no revert interleaves with it)', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    expect(folderBusyReason(f.state)).toBe(
      'The verify commands are running in this folder. Revert when they have finished.',
    )
  })

  it('quit during a round → verifyStop and paused(interrupted-by-quit)', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    const req = f.roundReq()
    f.send({ t: 'quit' })
    expect(f.fx('verifyStop')).toEqual([{ t: 'verifyStop', req }])
    expect(f.step('verify:1')).toMatchObject({ status: 'paused', pause: 'interrupted-by-quit' })
  })

  it('relaunch during a round → paused(interrupted) (sweep); Resume reruns it from the trust check', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    f.send({ t: 'relaunch' })
    expect(f.step('verify:1')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    expect(f.fx('sweep')).toHaveLength(1)
    expect(f.state.requests).not.toHaveProperty(f.findReq((r) => r.kind === 'verify') ?? 'x')
    // A late answer of the dead instance's round is dropped.
    f.user({ kind: 'resume' })
    expect(f.step('verify:1')).toMatchObject({ status: 'running', attempt: 2 })
    expect(f.fx('verifyCheck')).toEqual([expect.objectContaining({ step: 'verify:1', attempt: 2 })])
    f.check([trusted()])
    f.round([result('test', 'pass')])
    expect(f.step('verify:1').status).toBe('done')
  })

  it('relaunch while a grant was being written → the grant is written again; the card answers stay', () => {
    const f = new VFlow().toS1()
    f.check([untrusted('test')])
    f.choose('trust', TRUST_CHOICE.trust)
    f.send({ t: 'relaunch' })
    expect(f.fx('trustGrant').map((e) => e.command.body)).toEqual(['vitest run'])
    f.grant('test')
    expect(f.fx('verify')).toHaveLength(1)
  })

  it('relaunch while trust cards are open → the cards stay and the step keeps waiting', () => {
    const f = new VFlow().toS1()
    f.check([untrusted('test')])
    f.send({ t: 'relaunch' })
    expect(f.card('trust')).toBeDefined()
    expect(f.step('verify:1').status).toBe('waiting')
    f.choose('trust', TRUST_CHOICE.skip)
    expect(f.fx('verify')).toHaveLength(1)
  })

  it('relaunch during the post-verify-1 snapshot → re-requested; the reviewers wait paused for Resume', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    f.round([result('test', 'pass')])
    f.send({ t: 'relaunch' })
    expect(f.fx('snapshot')).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'post-verify-1' })]),
    )
    expect(f.state.flow.hold).toBe('interrupted')
    f.snapshot('post-verify-1', 'tree-changed')
    f.reconcile('pre-review')
    expect(f.step('review')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    f.user({ kind: 'resume' })
    expect(f.step('review').status).toBe('running')
  })

  it('relaunch during S1 with verify on → verify:1 is held paused, Resume starts it', () => {
    const f = new VFlow().toImplementDone()
    f.send({ t: 'relaunch' })
    f.snapshot('S1', 'tree-changed')
    expect(f.step('verify:1')).toMatchObject({ status: 'paused', pause: 'interrupted', attempt: 1 })
    expect(f.fx('verifyCheck')).toEqual([])
    f.user({ kind: 'resume' })
    expect(f.step('verify:1')).toMatchObject({ status: 'running', attempt: 1 })
  })

  it('a stale answer (an earlier attempt) is dropped', () => {
    const f = new VFlow().toS1()
    f.check([trusted('lint')])
    f.round([result('lint', 'env')])
    f.choose('verifyEnv', VERIFY_ENV_CHOICE.retry)
    const before = structuredClone(f.state.steps['verify:1'])
    f.send({ t: 'verify-result', req: 'r1', results: [result('lint', 'pass')], findings: [] })
    expect(f.state.steps['verify:1']).toEqual(before)
  })
})

describe('Fix skip rule with verify', () => {
  it('the latest round decides: verify:2 passing clears verify:1’s failure', () => {
    const f = new VFlow().toVerified(result('test', 'fail'), [verifyMust('test')])
    expect(latestVerifyHasMust(f.state)).toBe(true)
    f.toJoinAfterVerify('none', 'none')
    f.choose('gate:beforeFix', 'continue')
    f.fixToS2()
    f.check([trusted()], 'verify:2')
    f.round([result('test', 'pass')], [], 'verify:2')
    expect(latestVerifyHasMust(f.state)).toBe(false)
  })
})
