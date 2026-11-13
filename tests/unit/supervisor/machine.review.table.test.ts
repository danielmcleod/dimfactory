// Run rows R6–R11 (the full Claude-only sequence, no verify), one case per row, plus the
// Review ∥ Critic join, P15 read-only ⇒ parse findings, the Fix skip rule, the gate:beforeFix and emptyFindings
// cards, decideSession at R10 and the phase walk implementing → reviewing → findings-review → fixing → done.
import { describe, expect, it } from 'vitest'
import { runAttention } from '@core/supervisor/attention.ts'
import { selectedFindings, toRunSummary } from '@core/supervisor/derive.ts'
import { fixSkipRuleHolds, joinFindings } from '@core/supervisor/machine.ts'
import type { EffectOf, Finding } from '@core/supervisor/types.ts'
import { effectTypes } from './helpers.ts'
import { Flow, IMPL_TOTALS, must, should } from './helpers.review.ts'

const spawnSteps = (f: Flow): string[] => f.fx('spawn').map((e) => e.step)

describe('R6 Implement done', () => {
  it('tree(S0) = tree(S1) → completed(no-changes): Review, Critic and Fix skipped "no changes"', () => {
    const f = new Flow().toS1('tree-base')
    expect(f.state).toMatchObject({ status: 'completed', phase: 'done', outcome: 'no-changes', lock: 'none' })
    for (const k of ['verify:1', 'review', 'critic', 'fix', 'verify:2', 'finalize'] as const) {
      expect(f.step(k)).toMatchObject({ status: 'skipped', reason: 'no changes' })
    }
    expect(f.fx('reconcile')).toEqual([])
  })

  it('changes → verify:1 row skipped (verify off) → reconcile(pre-review); the run reads reviewing', () => {
    const f = new Flow().toS1()
    expect(f.step('verify:1')).toMatchObject({ status: 'skipped', reason: 'verify off' })
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-review' })])
    expect(f.state.flow.review).toBe('reconcile')
    expect(f.state).toMatchObject({ status: 'running', phase: 'reviewing' })
    expect(f.step('review').status).toBe('queued')
    expect(f.fx('spawn')).toEqual([])
  })

  it('verify:1 / verify:2 stay their own rows: verify on → verify:1 runs, then R7 → reconcile(pre-review)', () => {
    const f = new Flow({ verify: true }).toS1()
    expect(f.step('verify:1')).toMatchObject({ status: 'running', attempt: 1 })
    expect(f.fx('verifyCheck')).toEqual([expect.objectContaining({ step: 'verify:1', attempt: 1 })])
    expect(f.fx('reconcile')).toEqual([])
    expect(f.state).toMatchObject({ status: 'running', phase: 'verifying' })
    f.send({
      t: 'verify-check-result',
      req: f.req((r) => r.kind === 'verify-check'),
      commands: [{ name: 'test', argv: ['npm', 'test'], cwdRel: '.', body: 'vitest', trust: 'trusted' }],
    })
    f.send({
      t: 'verify-result',
      req: f.req((r) => r.kind === 'verify'),
      results: [
        {
          name: 'test',
          argv: ['npm', 'test'],
          status: 'pass',
          exitCode: 0,
          durationMs: 1200,
          excerpt: '',
          logPath: '',
        },
      ],
      findings: [],
    })
    expect(f.step('verify:1').status).toBe('done')
    f.snapshot('post-verify-1', 'tree-changed')
    f.reconcile('pre-review')
    expect(f.step('review').status).toBe('running')
  })

  it('Review ∥ Critic: both launch after the reconcile and spawn in the same reduction (one join node)', () => {
    const f = new Flow().toS1()
    f.reconcile('pre-review')
    expect(f.fx('preflight').map((e) => (e.mode === 'passBoundary' ? e.step : e.mode))).toEqual([
      'review',
      'critic',
    ])
    expect(f.step('review').status).toBe('running')
    expect(f.step('critic').status).toBe('running')
    f.passPreflight('critic')
    expect(f.fx('spawn')).toEqual([])
    expect(f.step('critic').launch?.ready).toBe(true)
    f.passPreflight('review')
    expect(spawnSteps(f)).toEqual(['review', 'critic'])
    expect(f.fx('spawn').every((e) => e.mode === 'readonly' && e.launch.fresh !== undefined)).toBe(true)
    expect(f.state).toMatchObject({ status: 'running', phase: 'reviewing' })
  })

  it('a sibling whose pass-boundary preflight fails releases the barrier', () => {
    const f = new Flow().toS1()
    f.reconcile('pre-review')
    f.passPreflight('review')
    expect(f.fx('spawn')).toEqual([])
    f.passPreflight('critic', {
      mode: 'passBoundary',
      ok: false,
      blocking: [
        {
          id: 'pass.critic.vendor',
          scope: 'pass',
          status: 'fail',
          blocking: true,
          category: 'capability_missing',
          title: 'Critic vendor unsupported',
          detail: '',
          recovery: [],
          at: 0,
          ttlMs: 0,
        },
      ],
      warnings: [],
      info: [],
    })
    expect(f.step('critic').status).toBe('failed')
    expect(spawnSteps(f)).toEqual(['review'])
  })

  it('one reviewer enabled → it runs alone; none enabled → no reconcile, straight to the join rules', () => {
    const one = new Flow({ critic: false }).toS1()
    expect(one.step('critic')).toMatchObject({ status: 'skipped', reason: 'disabled' })
    one.reconcile('pre-review')
    one.passPreflight('review')
    expect(spawnSteps(one)).toEqual(['review'])

    const none = new Flow({ review: false, critic: false }).toS1()
    expect(none.fx('reconcile')).toEqual([])
    expect(none.fx('snapshot')).toEqual([])
    expect(none.state).toMatchObject({ status: 'completed', outcome: 'clean' })
    expect(none.step('fix')).toMatchObject({ status: 'skipped', reason: 'no findings' })
  })
})

describe('P15 read-only ⇒ parse findings', () => {
  it('done → review.md + parseFindings; the step stays running until findings-result, then done', () => {
    const f = new Flow().toReviewRunning()
    f.ev('review', { type: 'done', result: '- [must] `a.ts:1` — bug' })
    expect(f.fx('writeOutput')).toEqual([
      expect.objectContaining({ file: 'review', text: '- [must] `a.ts:1` — bug', version: 1 }),
    ])
    const parse = f.fx('parseFindings')
    expect(parse).toEqual([
      expect.objectContaining({ step: 'review', attempt: 1, text: '- [must] `a.ts:1` — bug' }),
    ])
    expect(f.step('review').status).toBe('running')
    expect(f.state.findings?.sources.review?.status).toBe('parsing')
    f.exit('review')
    expect(f.step('review').status).toBe('running')
    f.parsed('review', 'ok', [must('r1')])
    expect(f.step('review').status).toBe('done')
    expect(f.state.findings?.sources.review).toMatchObject({
      status: 'ok',
      attempt: 1,
      findings: [expect.objectContaining({ id: 'r1', source: 'review', n: 0, flags: [] })],
    })
  })

  it('an empty output retries once with the budget: attempt 2, fresh, after the old process exits', () => {
    const f = new Flow().toReviewRunning()
    f.ev('review', { type: 'done', result: '' })
    f.parsed('review', 'empty')
    expect(f.step('review')).toMatchObject({
      status: 'running',
      attempt: 2,
      autoRetryUsed: true,
      reason: 'retrying after an empty output',
    })
    expect(f.fx('spawn')).toEqual([])
    f.exit('review')
    f.passPreflight('review')
    expect(f.fx('spawn')).toEqual([expect.objectContaining({ step: 'review', attempt: 2, spawnNo: 2 })])
  })

  it('empty twice (non-Auto) → emptyFindings [Retry][Treat as none]; Treat as none counts as zero', () => {
    const f = new Flow().toReviewRunning()
    f.report('critic', 'none')
    f.report('review', 'empty')
    f.exit('review')
    f.passPreflight('review')
    f.report('review', 'empty')
    const card = f.card('emptyFindings')
    expect(card).toMatchObject({ step: 'review' })
    expect(card.view).toMatchObject({
      blocking: true,
      defaultChoice: 'treat-as-none',
      choices: [
        expect.objectContaining({ id: 'retry', primary: true }),
        expect.objectContaining({ id: 'treat-as-none' }),
      ],
    })
    expect(f.step('review')).toMatchObject({ status: 'waiting', reason: 'empty output' })
    expect(f.state).toMatchObject({ status: 'waiting', phase: 'needs-attention' })
    f.choose('emptyFindings', 'treat-as-none')
    expect(f.step('review')).toMatchObject({ status: 'done' })
    expect(f.state.findings?.sources.review).toMatchObject({ status: 'none', treatedAsNone: true })
    f.snapshot('post-review', 'tree-changed')
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'clean' })
  })

  it('the card says what happened: two empty outputs → "twice"', () => {
    const f = new Flow().toReviewRunning()
    f.report('review', 'empty')
    f.passPreflight('review')
    f.report('review', 'empty')
    expect(f.card('emptyFindings').view.body).toMatch(/^Review returned no output twice, so Dim Factory/)
  })

  it('a crash spent the retry, then one empty output → the card opens at once and says so (not "twice")', () => {
    const f = new Flow().toReviewRunning()
    f.report('critic', 'none')
    f.exit('review', { code: 1 })
    expect(f.step('review')).toMatchObject({ status: 'running', attempt: 2, autoRetryUsed: true })
    f.passPreflight('review')
    f.report('review', 'empty')
    const body = f.card('emptyFindings').view.body
    expect(body).toMatch(
      /^Review returned no output on attempt 2 \(its automatic retry was already used\), so Dim Factory/,
    )
    expect(body).not.toContain('twice')
    expect(f.state.findings?.sources.review?.emptyOutputs).toBe(1)
  })

  it('Auto after a crash spent the retry: the note names the one empty output', () => {
    const f = autoReviewRunning()
    f.report('critic', 'none')
    f.exit('review', { code: 1 })
    f.passPreflight('review')
    f.report('review', 'empty')
    expect(f.state.notes).toContain(
      'Auto: Review returned no output on attempt 2 (its automatic retry was already used); treated as no findings.',
    )
  })

  it('empty twice → Retry is a user click: attempt 3, no budget, fresh', () => {
    const f = new Flow().toReviewRunning()
    f.report('review', 'empty')
    f.passPreflight('review')
    f.report('review', 'empty')
    f.choose('emptyFindings', 'retry')
    expect(f.state.cards).toEqual([])
    expect(f.step('review')).toMatchObject({ status: 'running', attempt: 3 })
    f.passPreflight('review')
    expect(f.fx('spawn')).toEqual([
      expect.objectContaining({ step: 'review', attempt: 3, launch: { fresh: {} } }),
    ])
  })

  it('empty twice in Auto → treated as none with a warning note; no card', () => {
    const f = new Flow({ auto: true })
    f.toPlanRunning()
    f.ev('plan', { type: 'done', result: 'plan' })
    f.exit('plan')
    f.reconcile()
    f.snapshot('S0', 'tree-base')
    f.passPreflight('implement')
    f.ev('implement', { type: 'session', id: 'impl-session' })
    f.ev('implement', { type: 'done', result: 'ok' })
    f.exit('implement')
    f.reconcile('end-of-pass')
    f.snapshot('S1', 'tree-changed')
    f.reconcile('pre-review')
    f.passPreflight('review')
    f.passPreflight('critic')
    f.report('critic', 'none')
    f.report('review', 'empty')
    f.passPreflight('review')
    f.report('review', 'empty')
    expect(f.state.cards).toEqual([])
    expect(f.state.notes).toContain('Auto: Review returned no output twice; treated as no findings.')
    expect(f.state.findings?.sources.review).toMatchObject({ status: 'none', treatedAsNone: true })
  })

  it('a findings-result for a stale request is ignored', () => {
    const f = new Flow().toReviewRunning()
    f.reviewerDone('review')
    const req = f.findingsReq('review')
    f.parsed('review', 'none')
    f.send({ t: 'findings-result', req, status: 'ok', findings: [must('late')] })
    expect(f.state.findings?.sources.review).toMatchObject({ status: 'none', findings: [] })
  })
})

describe('R8 Review/Critic join', () => {
  it('both terminal → post-review snapshot (still reviewing); ≠ S1 → warning note, changes kept', () => {
    const f = new Flow().toReviewRunning()
    f.report('review', 'ok', [must('r1')])
    expect(f.fx('snapshot')).toEqual([])
    f.report('critic', 'none')
    expect(f.fx('snapshot')).toEqual([expect.objectContaining({ label: 'post-review' })])
    expect(f.state).toMatchObject({ status: 'running', phase: 'reviewing' })
    expect(f.state.boundary).toEqual({ name: 'post-review', step: 'review' })
    f.snapshot('post-review', 'tree-reviewer-wrote')
    expect(f.state.notes.some((n) => n.includes('Review/Critic ran'))).toBe(true)
    expect(f.state.flow.review).toBe('joined')
  })

  it('any failed → failed: the survivor finishes and keeps its findings; Continue without → the join goes on', () => {
    const f = new Flow().toReviewRunning()
    f.ev('critic', {
      type: 'error',
      message: 'Not logged in',
      raw: '',
      fatal: true,
      category: 'auth_required',
    })
    expect(f.step('critic').status).toBe('failed')
    expect(f.state.status).toBe('running')
    f.report('review', 'ok', [must('r1'), should('r2')])
    expect(f.state).toMatchObject({ status: 'failed', phase: 'needs-attention' })
    expect(f.fx('snapshot')).toEqual([])
    expect(toRunSummary(f.state).findings).toEqual({ must: 1, should: 1 })
    f.user({ kind: 'skip', step: 'critic' })
    expect(f.step('critic')).toMatchObject({ status: 'skipped', reason: 'user' })
    f.snapshot('post-review', 'tree-changed')
    expect(f.card('gate:beforeFix').view.payload).toMatchObject({ selected: ['r1', 'r2'] })
  })

  it('any paused → paused; Resume reruns the reviewer fresh, then the join', () => {
    const f = new Flow().toReviewRunning()
    f.report('review', 'none')
    f.send({ t: 'relaunch' })
    expect(f.step('critic')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    f.snapshot('interrupted')
    expect(f.state.status).toBe('paused')
    f.user({ kind: 'resume' })
    f.passPreflight('critic')
    expect(f.fx('spawn')).toEqual([expect.objectContaining({ step: 'critic', launch: { fresh: {} } })])
    f.report('critic', 'none')
    f.snapshot('post-review', 'tree-changed')
    expect(f.state.outcome).toBe('clean')
  })

  it('skip rule: NO FINDINGS ×2 → Fix skipped "no findings" → completed(clean); lock released', () => {
    const f = new Flow().toJoin(['none', []], ['ok', []])
    expect(f.state).toMatchObject({ status: 'completed', phase: 'done', outcome: 'clean', lock: 'none' })
    expect(f.step('fix')).toMatchObject({ status: 'skipped', reason: 'no findings' })
    expect(f.step('verify:2')).toMatchObject({ status: 'skipped', reason: 'verify off' })
    expect(f.step('finalize')).toMatchObject({ status: 'skipped', reason: 'in place' })
    expect(f.fx('unlock')).toHaveLength(1)
  })

  it.each([
    ['untagged', 'untagged' as const],
    ['unstructured', 'unstructured' as const],
    ['a parser failure', 'failed' as const],
  ])('skip rule fails on %s output (never counts as zero)', (_name, status) => {
    const f = new Flow().toJoin(['none', []], [status, status === 'failed' ? [] : [should('c1')]])
    expect(f.state.outcome).toBeUndefined()
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['gate:beforeFix'])
  })

  it('Fix disabled → completed(findings-open), Fix skipped "disabled"', () => {
    const f = new Flow({ fix: false }).toJoin(['ok', [must('r1')]])
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'findings-open' })
    expect(f.step('fix')).toMatchObject({ status: 'skipped', reason: 'disabled' })
    expect(toRunSummary(f.state).findings).toEqual({ must: 1, should: 0 })
  })

  it('beforeFix ∧ ¬auto → gate:beforeFix: findings numbered must first (F1…), findings-review, notify gate', () => {
    const f = new Flow().toJoin(['ok', [should('r1'), must('r2')]], ['ok', [must('c1')]])
    const gate = f.card('gate:beforeFix')
    expect(gate.step).toBe('fix')
    expect(gate.view).toMatchObject({
      blocking: true,
      defaultChoice: 'continue',
      title: '3 findings before Fix: 2 must, 1 should',
      body: '- [must] F1 (review) must r2\n- [must] F2 (critic) must c1\n- [should] F3 (review) should r1',
      choices: [
        { id: 'continue', label: 'Continue with 3 findings', primary: true, input: 'findings' },
        { id: 'skip-fix', label: 'Skip Fix' },
        { id: 'cancel', label: 'Cancel run', danger: true },
      ],
    })
    expect(gate.view.payload).toMatchObject({ step: 'fix', selected: ['r2', 'c1', 'r1'] })
    expect(f.state).toMatchObject({ status: 'waiting', phase: 'findings-review' })
    expect(f.log).toContainEqual({ t: 'notify', kind: 'gate', cardId: gate.view.id })
    expect(f.log).toContainEqual(expect.objectContaining({ t: 'writeFindings', version: 1 }))
    expect(f.state.findings?.list.map((x) => [x.n, x.id])).toEqual([
      [1, 'r2'],
      [2, 'c1'],
      [3, 'r1'],
    ])
  })

  it('no gate (beforeFix off) → straight to the pre-Fix boundary with every finding selected', () => {
    const f = new Flow({ beforeFix: false }).toJoin(['ok', [must('r1')]], ['ok', [should('c1')]])
    expect(f.state.cards).toEqual([])
    expect(f.state.findings?.selected).toEqual(['r1', 'c1'])
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-fix', step: 'fix' })])
    expect(f.state).toMatchObject({ status: 'running', phase: 'fixing' })
  })
})

describe('R9 beforeFix card', () => {
  const atGate = (): Flow =>
    new Flow().toJoin(['ok', [must('r1'), should('r2')]], ['unstructured', [should('c1')]])

  it('Continue with N: the selected ids (list order) go to Fix; findings.json rewritten', () => {
    const f = atGate()
    f.choose('gate:beforeFix', 'continue', ['c1', 'r1'])
    expect(f.state.findings?.selected).toEqual(['r1', 'c1'])
    expect(selectedFindings(f.state).map((x) => `F${x.n} ${x.id}`)).toEqual(['F1 r1', 'F3 c1'])
    expect(f.fx('writeFindings')).toEqual([
      {
        t: 'writeFindings',
        version: 2,
        doc: {
          schemaVersion: 1,
          runId: f.state.runId,
          round: 1,
          sources: {
            review: { status: 'ok', count: 2, rawFile: 'review.md' },
            critic: { status: 'unstructured', count: 1, rawFile: 'critic.md' },
          },
          findings: f.state.findings?.list,
          selected: { r1: true, r2: false, c1: true },
        },
      },
    ])
    expect(f.bodies('output')).toEqual([{ t: 'output', file: 'findings', version: 2 }])
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-fix' })])
  })

  it('Continue without input takes the default selection (all)', () => {
    const f = atGate()
    f.choose('gate:beforeFix', 'continue')
    expect(f.state.findings?.selected).toEqual(['r1', 'r2', 'c1'])
  })

  it('Continue with 0 → completed(findings-open); Fix skipped "no findings selected"', () => {
    const f = atGate()
    f.choose('gate:beforeFix', 'continue', [])
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'findings-open' })
    expect(f.step('fix')).toMatchObject({ status: 'skipped', reason: 'no findings selected' })
  })

  it('Skip Fix → completed(findings-open), Fix skipped(user)', () => {
    const f = atGate()
    f.choose('gate:beforeFix', 'skip-fix')
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'findings-open' })
    expect(f.step('fix')).toMatchObject({ status: 'skipped', reason: 'user' })
  })

  it('Cancel → cancelled (stopped snapshot, then the lock)', () => {
    const f = atGate()
    f.choose('gate:beforeFix', 'cancel')
    expect(f.state.status).toBe('cancelled')
    expect(f.step('fix')).toMatchObject({ status: 'cancelled' })
    f.snapshot('stopped')
    expect(f.state.lock).toBe('none')
  })

  it('validation: an unknown id or text input is rejected and the gate stays open', () => {
    const f = atGate()
    f.choose('gate:beforeFix', 'continue', ['nope'])
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'VALIDATION' })])
    f.choose('gate:beforeFix', 'continue', 'r1')
    expect(f.fx('result')).toEqual([
      { t: 'result', code: 'VALIDATION', message: 'This choice takes finding ids.' },
    ])
    expect(f.card('gate:beforeFix')).toBeDefined()
    expect(f.state.flow.fix).toBe('gate')
  })
})

describe('R10 pre-Fix boundary', () => {
  it('reconcile(pre-fix) → F0 → decideSession → Fix P1 resuming Implement’s session (priorUsage = its totals)', () => {
    const f = new Flow().toJoin(['ok', [must('r1')]])
    f.choose('gate:beforeFix', 'continue')
    expect(f.state).toMatchObject({ phase: 'fixing' })
    expect(f.step('fix').status).toBe('running')
    f.reconcile('pre-fix')
    expect(f.fx('snapshot')).toEqual([expect.objectContaining({ label: 'fix-start', step: 'fix' })])
    f.snapshot('fix-start', 'tree-changed')
    expect(f.fx('preflight')).toEqual([expect.objectContaining({ mode: 'passBoundary', step: 'fix' })])
    f.passPreflight('fix')
    const [sp] = f.fx('spawn')
    expect(sp).toMatchObject({ step: 'fix', attempt: 1, mode: 'autoedit', vendor: 'claude' })
    expect(sp?.launch).toEqual({
      resume: { sessionId: 'impl-session', priorUsage: IMPL_TOTALS },
      session: { reuse: true, sessionId: 'impl-session' },
      notes: [],
    })
    expect(f.step('fix').sessionNote).toBe('reused the Implement session')
    expect(f.fx('liveCount')).toEqual([{ t: 'liveCount', on: true }])
  })

  it.each([
    ['Fix vendor differs', { fixVendor: 'codex' }, 'vendor-differs', 'fresh session: Fix vendor differs'],
    ['reuseSession off', { reuseSession: false }, 'override-fresh', 'fresh session: set to start fresh'],
  ])('%s → fresh with its FreshReason and session line', (_n, o, reason, note) => {
    const f = new Flow(o).toJoin(['ok', [must('r1')]])
    f.choose('gate:beforeFix', 'continue')
    f.toFixSpawned()
    expect(f.fx('spawn')[0]?.launch).toEqual({
      fresh: { reason },
      session: { reuse: false, reason },
      notes: [],
    })
    expect(f.step('fix').sessionNote).toBe(note)
  })

  it('Implement without a session → fresh (no-session)', () => {
    const f = new Flow()
    f.toPlanGate()
    f.approve()
    f.reconcile()
    f.snapshot('S0', 'tree-base')
    f.passPreflight('implement')
    f.ev('implement', { type: 'done', result: 'ok' })
    f.exit('implement')
    f.reconcile('end-of-pass')
    f.snapshot('S1', 'tree-changed')
    f.reconcile('pre-review')
    f.passPreflight('review')
    f.passPreflight('critic')
    f.report('review', 'ok', [must('r1')])
    f.report('critic', 'none')
    f.snapshot('post-review', 'tree-changed')
    f.choose('gate:beforeFix', 'continue')
    f.toFixSpawned()
    expect(f.fx('spawn')[0]?.launch.fresh).toEqual({ reason: 'no-session' })
  })

  it('info verdicts at pre-fix become the Fix prompt’s notes (and run notes)', () => {
    const f = new Flow().toJoin(['ok', [must('r1')]])
    f.choose('gate:beforeFix', 'continue')
    f.reconcile('pre-fix', ['User edited outside the run: README.md'])
    f.snapshot('fix-start', 'tree-changed')
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch.notes).toEqual(['User edited outside the run: README.md'])
    expect(f.state.notes).toContain('User edited outside the run: README.md')
    expect(f.state.findings?.notes).toEqual(['User edited outside the run: README.md'])
  })

  it('a relaunch before Fix spawned → paused; Resume redoes R10 (reconcile, decideSession)', () => {
    const f = new Flow().toJoin(['ok', [must('r1')]])
    f.choose('gate:beforeFix', 'continue')
    f.reconcile('pre-fix')
    f.send({ t: 'relaunch' })
    expect(f.step('fix')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    f.user({ kind: 'resume' })
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-fix' })])
    f.reconcile('pre-fix')
    f.snapshot('fix-start')
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch.session).toEqual({ reuse: true, sessionId: 'impl-session' })
  })
})

describe('R11 Fix done', () => {
  const fixRunning = (): Flow => {
    const f = new Flow().toJoin(['ok', [must('r1')]])
    f.choose('gate:beforeFix', 'continue')
    f.toFixSpawned('tree-changed')
    return f
  }

  it('S2 (fixing until it lands) → verify:2 row skipped → completed(fixed); lock released', () => {
    const f = fixRunning()
    f.ev('fix', { type: 'done', result: 'F1 fixed', usage: { input: 50, output: 20, costUsd: 0.02 } })
    expect(f.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S2', step: 'fix' })])
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'end-of-pass', step: 'fix' })])
    f.exit('fix')
    f.reconcile('end-of-pass')
    expect(f.state).toMatchObject({ status: 'running', phase: 'fixing' })
    expect(f.state.boundary).toEqual({ name: 'post-fix', step: 'fix' })
    f.snapshot('S2', 'tree-fixed')
    expect(f.state).toMatchObject({ status: 'completed', phase: 'done', outcome: 'fixed', lock: 'none' })
    expect(f.step('verify:2')).toMatchObject({ status: 'skipped', reason: 'verify off' })
    expect(f.step('finalize')).toMatchObject({ status: 'skipped', reason: 'in place' })
    expect(f.state.notes).not.toContain('Fix made no changes.')
    expect(f.bodies('run-status').at(-1)).toEqual({
      t: 'run-status',
      status: 'completed',
      phase: 'done',
      outcome: 'fixed',
    })
  })

  it('verify on → verify:2 runs after S2; a passing round → still fixed', () => {
    const f = new Flow({ verify: true }).toS1()
    // verify:1: a trusted command that passes, then R7's post-verify-1 snapshot.
    f.send({
      t: 'verify-check-result',
      req: f.req((r) => r.kind === 'verify-check'),
      commands: [{ name: 'test', argv: ['npm', 'test'], cwdRel: '.', body: 'vitest', trust: 'trusted' }],
    })
    const pass = {
      name: 'test',
      argv: ['npm', 'test'],
      status: 'pass' as const,
      exitCode: 0,
      durationMs: 900,
      excerpt: '',
      logPath: '',
    }
    f.send({ t: 'verify-result', req: f.req((r) => r.kind === 'verify'), results: [pass], findings: [] })
    f.snapshot('post-verify-1', 'tree-changed')
    f.reconcile('pre-review')
    for (const k of f.reviewers) f.passPreflight(k)
    f.report('review', 'ok', [must('r1')])
    f.report('critic', 'none')
    f.snapshot('post-review', 'tree-changed')
    f.choose('gate:beforeFix', 'continue')
    f.toFixSpawned()
    f.ev('fix', { type: 'done', result: 'ok' })
    f.exit('fix')
    f.reconcile('end-of-pass')
    f.snapshot('S2', 'tree-fixed')
    expect(f.step('verify:2')).toMatchObject({ status: 'running', attempt: 1 })
    expect(f.state).toMatchObject({ status: 'running', phase: 'final-verify' })
    f.send({
      t: 'verify-check-result',
      req: f.req((r) => r.kind === 'verify-check'),
      commands: [{ name: 'test', argv: ['npm', 'test'], cwdRel: '.', body: 'vitest', trust: 'trusted' }],
    })
    f.send({ t: 'verify-result', req: f.req((r) => r.kind === 'verify'), results: [pass], findings: [] })
    expect(f.step('verify:2').status).toBe('done')
    expect(f.state.outcome).toBe('fixed')
  })

  it('tree(F0) = tree(S2) → a "Fix made no changes" note; still fixed', () => {
    const f = fixRunning()
    f.ev('fix', { type: 'done', result: 'F1 disputed: not a bug' })
    f.exit('fix')
    f.reconcile('end-of-pass')
    f.snapshot('S2', 'tree-changed')
    expect(f.state.outcome).toBe('fixed')
    expect(f.state.notes).toContain('Fix made no changes.')
  })

  it('Fix failed → Continue without Fix → completed(findings-open)', () => {
    const f = fixRunning()
    f.ev('fix', { type: 'error', message: 'Not logged in', raw: '', fatal: true, category: 'auth_required' })
    f.exit('fix', { code: 1 })
    expect(f.state).toMatchObject({ status: 'failed' })
    f.user({ kind: 'skip', step: 'fix' })
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'findings-open' })
  })

  it('Fix retried after a failure with changes resumes its session, carrying the notes', () => {
    const f = fixRunning()
    f.ev('fix', { type: 'session', id: 'impl-session' })
    f.ev('fix', { type: 'error', message: 'overloaded', raw: '', fatal: true, category: 'network' })
    f.exit('fix', { code: 1 })
    f.snapshot('pre-retry', 'tree-partial')
    f.fire('launch|fix')
    f.passPreflight('fix')
    const launch = f.fx('spawn')[0]?.launch
    expect(launch?.resume?.sessionId).toBe('impl-session')
    expect(launch?.continuation).toMatch(/^Previous attempt failed/)
    expect(launch?.notes).toEqual([])
  })
})

/** Auto run (no gates) up to Review ∥ Critic spawned. */
function autoReviewRunning(): Flow {
  const f = new Flow({ auto: true })
  f.toPlanRunning()
  f.ev('plan', { type: 'done', result: 'plan' })
  f.exit('plan')
  f.reconcile()
  f.snapshot('S0', 'tree-base')
  f.passPreflight('implement')
  f.ev('implement', { type: 'session', id: 'impl-session' })
  f.ev('implement', { type: 'done', result: 'ok' })
  f.exit('implement')
  f.reconcile('end-of-pass')
  f.snapshot('S1', 'tree-changed')
  f.reconcile('pre-review')
  f.passPreflight('review')
  f.passPreflight('critic')
  return f
}

describe('skip rule edges', () => {
  it('a reviewer the user continued without still counts (every enabled reviewer): never clean', () => {
    const f = new Flow().toReviewRunning()
    f.ev('review', { type: 'error', message: 'boom', raw: '', fatal: true, category: 'auth_required' })
    f.report('critic', 'none')
    expect(f.state.status).toBe('failed')
    f.user({ kind: 'skip', step: 'review' })
    expect(fixSkipRuleHolds(f.state)).toBe(false)
    f.snapshot('post-review', 'tree-changed')
    expect(f.state.outcome).toBeUndefined()
    expect(f.card('gate:beforeFix').view.title).toBe('No findings could be read')
    expect(f.state.notes).toContain(
      'Review did not review the change (you continued without it), so the run is not reported clean.',
    )
    f.choose('gate:beforeFix', 'continue')
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'findings-open' })
    expect(f.fx('spawn')).toEqual([])
  })

  it('Auto: both reviewers failed and skipped → findings-open with a note, never "Clean: no findings"', () => {
    const f = autoReviewRunning()
    for (const k of ['review', 'critic'] as const) {
      f.ev(k, { type: 'error', message: 'boom', raw: '', fatal: true, category: 'auth_required' })
    }
    expect(f.state.status).toBe('failed')
    f.user({ kind: 'skip', step: 'review' })
    f.user({ kind: 'skip', step: 'critic' })
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'findings-open' })
    expect(f.step('fix')).toMatchObject({ status: 'skipped', reason: 'no findings' })
    expect(f.state.notes).toEqual(
      expect.arrayContaining([
        'Review did not review the change (you continued without it), so the run is not reported clean.',
        'Critic did not review the change (you continued without it), so the run is not reported clean.',
      ]),
    )
  })

  it('a reviewer disabled in config does not count: the other’s NO FINDINGS → clean', () => {
    const f = new Flow({ review: false }).toJoin(undefined, ['none', []])
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'clean' })
  })

  it('Auto with nothing readable (parser failure, no findings) → Fix skipped "no findings", findings-open', () => {
    const f = new Flow({ auto: true })
    f.toPlanRunning()
    f.ev('plan', { type: 'done', result: 'plan' })
    f.exit('plan')
    f.reconcile()
    f.snapshot('S0', 'tree-base')
    f.passPreflight('implement')
    f.ev('implement', { type: 'done', result: 'ok' })
    f.exit('implement')
    f.reconcile('end-of-pass')
    f.snapshot('S1', 'tree-changed')
    f.reconcile('pre-review')
    f.passPreflight('review')
    f.passPreflight('critic')
    f.report('review', 'failed')
    f.report('critic', 'none')
    f.snapshot('post-review', 'tree-changed')
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'findings-open' })
    expect(f.step('fix')).toMatchObject({ status: 'skipped', reason: 'no findings' })
    expect(f.state.notes).toContain("Review's output could not be read as findings.")
  })
})

describe('attention', () => {
  it('the gate and the emptyFindings card each need the user (blocking cards)', () => {
    const g = new Flow().toJoin(['ok', [must('r1')]])
    expect(runAttention(g.state).map((i) => i.id)).toEqual([`card:${g.card('gate:beforeFix').view.id}`])
    const e = new Flow().toReviewRunning()
    e.report('review', 'empty')
    e.passPreflight('review')
    e.report('review', 'empty')
    expect(runAttention(e.state).map((i) => i.id)).toEqual([`card:${e.card('emptyFindings').view.id}`])
  })
})

describe('phases, summary, recovery', () => {
  it('walks implementing → reviewing → findings-review → fixing → done', () => {
    const f = new Flow()
    const phases: string[] = []
    const seen = (): void => {
      if (phases.at(-1) !== f.state.phase) phases.push(f.state.phase)
    }
    f.toImplementRunning()
    seen()
    f.ev('implement', { type: 'done', result: 'ok' })
    f.exit('implement')
    seen()
    f.reconcile('end-of-pass')
    f.snapshot('S1', 'tree-changed')
    seen()
    f.reconcile('pre-review')
    seen()
    f.passPreflight('review')
    f.passPreflight('critic')
    f.report('review', 'ok', [must('r1')])
    seen()
    f.report('critic', 'none')
    seen()
    f.snapshot('post-review', 'tree-changed')
    seen()
    f.choose('gate:beforeFix', 'continue')
    seen()
    f.toFixSpawned()
    f.ev('fix', { type: 'done', result: 'ok' })
    f.exit('fix')
    f.reconcile('end-of-pass')
    seen()
    f.snapshot('S2', 'tree-fixed')
    seen()
    expect(phases).toEqual(['implementing', 'reviewing', 'findings-review', 'fixing', 'done'])
  })

  it('RunSummary: per-step rows for the whole sequence and the finding counts', () => {
    const f = new Flow({ beforeFix: false }).toJoin(['ok', [must('r1'), should('r2')]], ['none', []])
    f.toFixSpawned()
    f.ev('fix', { type: 'done', result: 'ok', usage: { input: 1, output: 1, costUsd: 0.5 } })
    f.exit('fix')
    f.reconcile('end-of-pass')
    f.snapshot('S2', 'tree-fixed')
    const sum = toRunSummary(f.state)
    expect(sum.findings).toEqual({ must: 1, should: 1 })
    expect(sum.steps.map((x) => [x.key, x.status])).toEqual([
      ['preflight', 'done'],
      ['plan', 'done'],
      ['implement', 'done'],
      ['review', 'done'],
      ['critic', 'done'],
      ['fix', 'done'],
    ])
    expect(sum.outcome).toBe('fixed')
  })

  it('relaunch while a reviewer waits only for its parse → the parse is asked again; nothing pauses', () => {
    const f = new Flow().toReviewRunning()
    f.report('critic', 'none')
    f.reviewerDone('review')
    f.send({ t: 'relaunch' })
    expect(f.fx('parseFindings')).toEqual([expect.objectContaining({ step: 'review', attempt: 1 })])
    expect(f.step('review').status).toBe('running')
    f.parsed('review', 'none')
    f.snapshot('post-review', 'tree-changed')
    expect(f.state.outcome).toBe('clean')
  })

  it('relaunch during reconcile(pre-review) / the post-review snapshot re-issues them (never auto-resume)', () => {
    const a = new Flow().toS1()
    a.send({ t: 'relaunch' })
    expect(a.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-review' })])
    expect(a.state.flow.hold).toBe('interrupted')
    a.reconcile('pre-review')
    // Review ∥ Critic wait for the user: paused(interrupted), nothing launched.
    expect(a.fx('preflight')).toEqual([])
    for (const k of ['review', 'critic'] as const) {
      expect(a.step(k)).toMatchObject({ status: 'paused', pause: 'interrupted', attempt: 1, spawnNo: 0 })
    }
    expect(a.state).toMatchObject({ status: 'paused', phase: 'needs-attention' })
    a.user({ kind: 'resume' })
    expect(a.state.flow.hold).toBeUndefined()
    a.passPreflight('review')
    expect(a.fx('spawn')).toEqual([])
    a.passPreflight('critic')
    expect(spawnSteps(a)).toEqual(['review', 'critic'])

    const b = new Flow().toReviewRunning()
    b.report('review', 'none')
    b.report('critic', 'none')
    b.send({ t: 'relaunch' })
    expect(b.fx('snapshot').map((e) => e.label)).toContain('post-review')
    b.snapshot('post-review', 'tree-changed')
    // Nothing to launch: the join completes the run (and drops the hold).
    expect(b.state.outcome).toBe('clean')
    expect(b.state.flow.hold).toBeUndefined()
  })

  it('relaunch while S1 is outstanding: S1 → reconcile(pre-review) → Review ∥ Critic paused, not spawned', () => {
    const f = new Flow().toImplementDone()
    f.send({ t: 'relaunch' })
    expect(f.fx('snapshot').map((e) => e.label)).toContain('S1')
    f.snapshot('S1', 'tree-changed')
    f.reconcile('pre-review')
    expect(f.fx('preflight')).toEqual([])
    expect(f.step('review')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    expect(f.step('critic')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    expect(f.log.filter((e) => e.t === 'spawn').map((e) => (e.t === 'spawn' ? e.step : ''))).toEqual([
      'plan',
      'implement',
    ])
  })

  it('relaunch while S1 is outstanding and nothing changed → completed(no-changes), nothing paused', () => {
    const f = new Flow().toImplementDone()
    f.send({ t: 'relaunch' })
    f.snapshot('S1', 'tree-base')
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'no-changes' })
    expect(f.state.flow.hold).toBeUndefined()
  })

  it('Auto: relaunch during the post-review snapshot → Fix paused(interrupted); Resume redoes R10', () => {
    const f = autoReviewRunning()
    f.report('review', 'ok', [must('r1')])
    f.report('critic', 'none')
    f.send({ t: 'relaunch' })
    f.snapshot('post-review', 'tree-changed')
    expect(f.fx('reconcile')).toEqual([])
    expect(f.step('fix')).toMatchObject({ status: 'paused', pause: 'interrupted', attempt: 1, spawnNo: 0 })
    expect(f.state).toMatchObject({ status: 'paused', phase: 'needs-attention' })
    f.user({ kind: 'resume' })
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-fix', step: 'fix' })])
    f.toFixSpawned()
    expect(f.fx('spawn')).toEqual([expect.objectContaining({ step: 'fix', attempt: 1 })])
    expect(f.fx('spawn')[0]?.launch.session).toEqual({ reuse: true, sessionId: 'impl-session' })
  })

  it('relaunch while a reviewer waits for its parse: the join does not start Fix until Resume', () => {
    const f = new Flow({ beforeFix: false }).toReviewRunning()
    f.report('critic', 'none')
    f.reviewerDone('review', '- [must] `a.ts:1` — bug')
    f.send({ t: 'relaunch' })
    f.parsed('review', 'ok', [must('r1')])
    f.snapshot('post-review', 'tree-changed')
    expect(f.fx('reconcile')).toEqual([])
    expect(f.step('fix')).toMatchObject({ status: 'paused', pause: 'interrupted' })
  })

  it('relaunch while a reviewer waits for its parse, and the output was empty: the retry waits paused', () => {
    const f = new Flow().toReviewRunning()
    f.report('critic', 'none')
    f.reviewerDone('review', '')
    f.send({ t: 'relaunch' })
    f.parsed('review', 'empty')
    expect(f.step('review')).toMatchObject({
      status: 'paused',
      pause: 'interrupted',
      attempt: 2,
      autoRetryUsed: true,
    })
    expect(f.fx('preflight')).toEqual([])
    f.user({ kind: 'resume' })
    f.passPreflight('review')
    expect(f.fx('spawn')).toEqual([
      expect.objectContaining({ step: 'review', attempt: 2, launch: { fresh: {} } }),
    ])
  })

  it('a gate opened under the hold: the user’s choice continues the run (Fix launches)', () => {
    const f = new Flow().toReviewRunning()
    f.report('review', 'ok', [must('r1')])
    f.report('critic', 'none')
    f.send({ t: 'relaunch' })
    f.snapshot('post-review', 'tree-changed')
    expect(f.card('gate:beforeFix')).toBeDefined()
    f.choose('gate:beforeFix', 'continue')
    expect(f.state.flow.hold).toBeUndefined()
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-fix' })])
    expect(f.step('fix').status).toBe('running')
  })

  it('quit at the pre-review boundary: the reconcile answering in the quitting process pauses the reviewers', () => {
    const f = new Flow().toS1()
    f.send({ t: 'quit' })
    expect(f.state.flow.hold).toBe('interrupted-by-quit')
    f.reconcile('pre-review')
    expect(f.fx('preflight')).toEqual([])
    expect(f.step('review')).toMatchObject({ status: 'paused', pause: 'interrupted-by-quit' })
    expect(f.step('critic')).toMatchObject({ status: 'paused', pause: 'interrupted-by-quit' })
  })

  it('quit while a reviewer waits only for its parse does not pause it', () => {
    const f = new Flow().toReviewRunning()
    f.reviewerDone('review')
    f.send({ t: 'quit' })
    expect(f.step('review').status).toBe('running')
    expect(f.step('critic')).toMatchObject({ status: 'paused', pause: 'interrupted-by-quit' })
  })

  it('effect order at the join: snapshot first, then (on its result) findings.json and the gate', () => {
    const f = new Flow().toReviewRunning()
    f.report('review', 'ok', [must('r1')])
    f.report('critic', 'none')
    f.snapshot('post-review', 'tree-changed')
    expect(effectTypes(f.effects)).toEqual(
      expect.arrayContaining(['writeFindings', 'emit:output', 'emit:card', 'notify']),
    )
    const types = effectTypes(f.effects)
    expect(types.indexOf('writeFindings')).toBeLessThan(types.indexOf('emit:card'))
  })
})

describe('spend across attempts', () => {
  it('an empty-output retry: both attempts count toward the run total; the step usage is the last one', () => {
    const f = new Flow().toReviewRunning()
    f.ev('review', { type: 'done', result: '', usage: { input: 10, output: 5, costUsd: 0.01 } })
    f.exit('review')
    f.parsed('review', 'empty')
    f.passPreflight('review')
    f.ev('review', { type: 'done', result: 'NO FINDINGS', usage: { input: 20, output: 7, costUsd: 0.02 } })
    const st = f.step('review')
    expect(st.usage).toEqual({ input: 20, output: 7, costUsd: 0.02 })
    expect(st.spent).toMatchObject({ tokens: 42, usd: 0.03, bases: ['vendor'], spawnNo: 2 })
    const progress = toRunSummary(f.state).progress
    // Implement 1500 tok / $0.12 + Review 42 tok / $0.03.
    expect(progress).toMatchObject({ tokens: 1542, costUsd: 0.15 })
  })

  it('a failed attempt’s usage (meta `usage` before the error) counts once; `usage` stays unset', () => {
    const f = new Flow().toReviewRunning()
    const spawnNo = f.spawnNo('review')
    f.signal('review', { type: 'meta', key: 'usage', value: { input: 100, output: 50, costUsd: 0.04 } })
    f.signal('review', { type: 'meta', key: 'usage', value: { input: 100, output: 50, costUsd: 0.04 } })
    f.ev('review', {
      type: 'error',
      message: 'Not logged in',
      raw: '',
      fatal: true,
      category: 'auth_required',
    })
    const st = f.step('review')
    expect(st.status).toBe('failed')
    expect(st.usage).toBeUndefined()
    expect(st.spent).toMatchObject({ tokens: 150, usd: 0.04, spawnNo })
    expect(toRunSummary(f.state).progress.costUsd).toBe(0.16)
    // A malformed value is ignored.
    f.signal('review', { type: 'meta', key: 'usage', value: { input: 'x' } })
    expect(f.step('review').spent?.tokens).toBe(150)
  })
})

describe('skip rule and merge helpers', () => {
  const fnd = (id: string, severity: 'must' | 'should', source: 'review' | 'critic'): Finding => ({
    id,
    n: 0,
    severity,
    source,
    title: id,
    body: '',
    flags: [],
    round: 1,
  })

  it('joinFindings: must first, review before critic, numbered, ids unique', () => {
    const merged = joinFindings(
      {
        review: {
          status: 'ok',
          attempt: 1,
          findings: [fnd('a', 'should', 'review'), fnd('x', 'must', 'review')],
        },
        critic: { status: 'ok', attempt: 1, findings: [fnd('x', 'must', 'critic')] },
      },
      ['review', 'critic'],
    )
    expect(merged.map((f) => [f.n, f.id, f.source])).toEqual([
      [1, 'x', 'review'],
      [2, 'x-2', 'critic'],
      [3, 'a', 'review'],
    ])
  })

  it('fixSkipRuleHolds: a done reviewer without a parse, or with findings, blocks it; skipped ones do not count', () => {
    const f = new Flow().toReviewRunning()
    f.report('review', 'none')
    expect(fixSkipRuleHolds(f.state)).toBe(false) // critic still running
    f.reviewerDone('critic')
    expect(fixSkipRuleHolds(f.state)).toBe(false) // critic unparsed
    f.parsed('critic', 'ok', [])
    expect(fixSkipRuleHolds(f.state)).toBe(true)
  })

  it('every spawn of the sequence is typed (no stray effects)', () => {
    const f = new Flow({ beforeFix: false }).toJoin(['ok', [must('r1')]])
    f.toFixSpawned()
    const spawns = f.log.filter((e): e is EffectOf<'spawn'> => e.t === 'spawn').map((e) => e.step)
    expect(spawns).toEqual(['plan', 'implement', 'review', 'critic', 'fix'])
  })
})
