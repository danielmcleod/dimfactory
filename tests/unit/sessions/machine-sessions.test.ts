// Session reuse through the reducer (sessions, R10, P16/P19/P20, resume_failed):
//   - decideSession runs right before Fix P1, after F0 and the pass-boundary preflight; the controller's
//     `session-check` (canResume, Fix's folder, the vendor's capabilities) sent before that answer decides it
//   - every runtime FreshReason reaches the launch and the Fix card's session line
//   - a resume rejected at startup restarts Fix fresh ("fresh session: resuming failed"): same attempt, no budget;
//     the fallback failing the same way spends the budget, so it cannot loop
//   - P19/P20: Resume of a paused Fix uses canResume (resume + continuation, or fresh with the reason)
//   - usage: the resumed Fix gets Implement's totals as priorUsage; its own usage is what the adapter reports
import { describe, expect, it } from 'vitest'
import type { Usage } from '@shared/events.ts'
import { fixReusesSession, promptDiffRange } from '@core/supervisor/effects.ts'
import { timerId } from '@core/supervisor/timers.ts'
import type { SessionCheck } from '@core/supervisor/types.ts'
import { Flow, IMPL_TOTALS, must } from '../supervisor/helpers.review.ts'
import type { ReviewOptions } from '../supervisor/helpers.review.ts'

const REPO = 'C:\\work\\repo'

/** Flow whose Implement process reports the folder it runs in (the controller's `spawned` event). */
class CwdFlow extends Flow {
  implCwd = REPO

  override toImplementRunning(): this {
    this.toPlanGate()
    this.approve()
    this.reconcile()
    this.snapshot('S0', 'tree-base')
    this.passPreflight('implement')
    this.send({
      t: 'spawned',
      step: 'implement',
      spawnNo: this.spawnNo('implement'),
      pid: 4242,
      cwd: this.implCwd,
      sessionId: 'impl-session',
    })
    return this
  }
}

/** Gate before Fix continued; reconcile(pre-fix) and F0 answered: Fix waits on its pass-boundary preflight. */
function atFixPreflight(o: ReviewOptions = {}, f: Flow = new CwdFlow(o)): Flow {
  f.toJoin(['ok', [must('r1')]])
  f.choose('gate:beforeFix', 'continue')
  f.reconcile('pre-fix')
  f.snapshot('fix-start', 'tree-changed')
  expect(f.fx('preflight')).toEqual([expect.objectContaining({ mode: 'passBoundary', step: 'fix' })])
  return f
}

function check(o: Partial<SessionCheck> = {}): SessionCheck {
  return { sessionId: 'impl-session', ok: true, cwd: REPO, ...o }
}

describe('the controller’s session-check feeds decideSession', () => {
  it('the decision waits for the pass-boundary preflight, so a check sent before its answer is used', () => {
    const f = atFixPreflight()
    expect(f.state.steps.fix.launch?.plan).toBeUndefined()
    f.send({ t: 'session-check', step: 'fix', check: check({ ok: false, reason: 'cannot-resume' }) })
    expect(f.effects.filter((e) => e.t !== 'persist')).toEqual([])
    expect(f.state.steps.fix.launch?.sessionCheck).toMatchObject({ ok: false })
    f.passPreflight('fix')
    const [sp] = f.fx('spawn')
    expect(sp?.launch).toEqual({
      fresh: { reason: 'cannot-resume' },
      session: { reuse: false, reason: 'cannot-resume' },
      notes: [],
    })
    expect(f.step('fix').sessionNote).toBe('fresh session: the session cannot be resumed')
    expect(f.bodies('step-status').at(-1)).toMatchObject({
      step: 'fix',
      status: 'running',
      sessionNote: 'fresh session: the session cannot be resumed',
    })
    // A fresh Fix renders its own prompt with the S0..F0 diff (no resume).
    expect(sp && fixReusesSession(sp)).toBe(false)
    expect(sp && promptDiffRange(f.state, sp)?.label).toBe('S0..F0')
  })

  it('canResume ok, same folder, a model switch the vendor supports → reuse with Implement’s totals', () => {
    const f = new CwdFlow()
    f.state.config.passes.fix.model = 'opus'
    atFixPreflight({}, f)
    f.send({
      t: 'session-check',
      step: 'fix',
      check: check({ capabilities: { resume: 'id', resumeModelSwitch: true } }),
    })
    f.passPreflight('fix')
    const [sp] = f.fx('spawn')
    expect(sp).toMatchObject({ step: 'fix', attempt: 1, model: 'opus' })
    expect(sp?.launch).toEqual({
      resume: { sessionId: 'impl-session', priorUsage: IMPL_TOTALS },
      session: { reuse: true, sessionId: 'impl-session' },
      notes: [],
    })
    expect(sp && fixReusesSession(sp)).toBe(true)
    expect(f.step('fix').sessionNote).toBe('reused the Implement session')
  })

  it.each([
    [
      'the vendor cannot resume',
      check({ capabilities: { resume: 'none', resumeModelSwitch: true } }),
      null,
      'cannot-resume',
      'fresh session: the session cannot be resumed',
    ],
    [
      'the adapter’s own reason',
      check({ ok: false, reason: 'resume-failed' }),
      null,
      'resume-failed',
      'fresh session: resuming failed',
    ],
    [
      'Fix runs in another folder',
      check({ cwd: 'C:\\work\\wt-7' }),
      null,
      'cwd-changed',
      'fresh session: the folder changed',
    ],
    [
      'the model differs and the vendor cannot switch',
      check({ capabilities: { resume: 'id', resumeModelSwitch: false } }),
      'opus',
      'model-differs',
      'fresh session: the model differs',
    ],
  ] as const)('%s → fresh (%s)', (_n, c, fixModel, reason, note) => {
    const f = new CwdFlow()
    if (fixModel !== null) f.state.config.passes.fix.model = fixModel
    atFixPreflight({}, f)
    f.send({ t: 'session-check', step: 'fix', check: c })
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch).toEqual({
      fresh: { reason },
      session: { reuse: false, reason },
      notes: [],
    })
    expect(f.step('fix').sessionNote).toBe(note)
  })

  it('"Fresh, different vendor" (reuseSession off on another vendor) → override-other-vendor', () => {
    const f = atFixPreflight({ reuseSession: false, fixVendor: 'codex' })
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]).toMatchObject({
      vendor: 'codex',
      launch: {
        fresh: { reason: 'override-other-vendor' },
        session: { reuse: false, reason: 'override-other-vendor' },
      },
    })
    expect(f.step('fix').sessionNote).toBe('fresh session: set to a different vendor')
  })

  it('a check for another session, or one sent while Fix is not deciding, is ignored', () => {
    const early = new CwdFlow().toJoin(['ok', [must('r1')]])
    early.send({ t: 'session-check', step: 'fix', check: check({ ok: false }) })
    expect(early.state.steps.fix.launch).toBeUndefined()

    const f = atFixPreflight()
    f.send({ t: 'session-check', step: 'fix', check: check({ sessionId: 'someone-else', ok: false }) })
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch.session).toEqual({ reuse: true, sessionId: 'impl-session' })
  })

  it('no check at all (the reducer alone): canResume counts as ok — the v0 answer', () => {
    const f = atFixPreflight()
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch.session).toEqual({ reuse: true, sessionId: 'impl-session' })
  })

  it('the session keeps the folder it was started in, across exits and Fix continuing it', () => {
    const f = atFixPreflight()
    expect(f.state.sessions['impl-session']).toMatchObject({
      step: 'implement',
      cwd: REPO,
      lastTotals: IMPL_TOTALS,
    })
    f.send({ t: 'session-check', step: 'fix', check: check() })
    f.passPreflight('fix')
    f.send({
      t: 'spawned',
      step: 'fix',
      spawnNo: f.spawnNo('fix'),
      cwd: 'C:\\elsewhere',
      sessionId: 'impl-session',
    })
    expect(f.step('fix').sessionId).toBe('impl-session')
    expect(f.state.sessions['impl-session']?.cwd).toBe(REPO)
  })
})

describe('C1 resume_failed: fresh, same attempt, no budget', () => {
  const C08C = 'No conversation found with session ID: impl-session'

  function reusingFix(): Flow {
    const f = atFixPreflight()
    f.send({ t: 'session-check', step: 'fix', check: check() })
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch.resume?.sessionId).toBe('impl-session')
    return f
  }

  function rejectResume(f: Flow): void {
    f.ev('fix', { type: 'error', message: C08C, raw: C08C, fatal: true, category: 'resume_failed' })
    f.exit('fix', { code: 1, ranMs: 1_700 })
  }

  it('the resumed Fix rejected at startup restarts fresh with "fresh session: resuming failed"', () => {
    const f = reusingFix()
    rejectResume(f)
    expect(f.step('fix')).toMatchObject({ status: 'running', attempt: 1, autoRetryUsed: false })
    expect(f.step('fix').reason).toBe('retrying after resume_failed')
    f.snapshot('pre-retry', 'tree-changed')
    f.passPreflight('fix')
    const [sp] = f.fx('spawn')
    expect(sp).toMatchObject({ step: 'fix', attempt: 1, spawnNo: 2 })
    expect(sp?.launch).toEqual({ fresh: { reason: 'resume-failed' }, notes: [] })
    expect(f.step('fix')).toMatchObject({
      attempt: 1,
      autoRetryUsed: false,
      sessionNote: 'fresh session: resuming failed',
    })
    // The fresh Fix gets the full prompt (task, plan, the S0..F0 diff) and no snag was raised.
    expect(sp && fixReusesSession(sp)).toBe(false)
    expect(sp && promptDiffRange(f.state, sp)?.label).toBe('S0..F0')
    expect(f.state.cards.filter((c) => c.step === 'fix')).toEqual([])
    // The budget is still there for a real failure.
    f.ev('fix', { type: 'error', message: 'overloaded', raw: '', fatal: true, category: 'vendor_internal' })
    expect(f.step('fix')).toMatchObject({ status: 'running', attempt: 2, autoRetryUsed: true })
  })

  it('the fallback failing with resume_failed again spends the budget; a third time fails the pass', () => {
    const f = reusingFix()
    rejectResume(f)
    f.snapshot('pre-retry', 'tree-changed')
    f.passPreflight('fix')
    rejectResume(f)
    expect(f.step('fix')).toMatchObject({ status: 'running', attempt: 2, autoRetryUsed: true })
    f.snapshot('pre-retry', 'tree-changed')
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch.fresh).toEqual({ reason: 'resume-failed' })
    rejectResume(f)
    expect(f.step('fix')).toMatchObject({ status: 'failed', reason: 'resume_failed', snagOpen: true })
  })
})

describe('Resume of a paused Fix uses canResume', () => {
  function pausedFix(): Flow {
    const f = atFixPreflight()
    f.passPreflight('fix')
    f.ev('fix', { type: 'session', id: 'impl-session' })
    f.ask('fix', 'q1')
    f.fire(timerId.ask('fix', 'q1'))
    f.exit('fix', { code: 1 })
    f.snapshot('paused')
    expect(f.step('fix')).toMatchObject({ status: 'paused', pause: 'ask-timeout' })
    return f
  }

  it('session ∧ canResume → resume with the continuation; "resumed the previous session"', () => {
    const f = pausedFix()
    f.user({ kind: 'resume', canResume: { fix: { ok: true } } })
    f.snapshot('resume')
    f.passPreflight('fix')
    const [sp] = f.fx('spawn')
    expect(sp?.launch).toMatchObject({ resume: { sessionId: 'impl-session' }, continuation: 'continue' })
    expect(sp?.attempt).toBe(1)
    expect(f.step('fix').sessionNote).toBe('resumed the previous session')
  })

  it('canResume refused → fresh with the adapter’s reason, shown on the card', () => {
    const f = pausedFix()
    f.user({ kind: 'resume', canResume: { fix: { ok: false, reason: 'cwd-changed' } } })
    expect(f.fx('snapshot').filter((s) => s.label === 'resume')).toEqual([])
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch).toEqual({ fresh: { reason: 'cwd-changed' }, notes: [] })
    expect(f.step('fix').sessionNote).toBe('fresh session: the folder changed')
  })
})

describe('usage on a resumed Fix (C08)', () => {
  it('priorUsage = Implement’s totals; the step’s usage is the adapter’s delta; the totals move on', () => {
    const f = atFixPreflight()
    f.send({ t: 'session-check', step: 'fix', check: check() })
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch.resume?.priorUsage).toEqual(IMPL_TOTALS)
    const delta: Usage = { input: 40, output: 25, cacheRead: 900, costUsd: 0.02 }
    const after: Usage = { input: 1240, output: 325, cacheRead: 5900, costUsd: 0.14 }
    f.ev('fix', { type: 'session', id: 'impl-session' })
    f.ev('fix', { type: 'done', result: 'F1 fixed', usage: delta })
    expect(f.step('fix').usage).toEqual(delta)
    expect(f.bodies('usage')).toEqual([expect.objectContaining({ step: 'fix', usage: delta })])
    f.exitWith('fix', after)
    expect(f.state.sessions['impl-session']).toMatchObject({ lastTotals: after, cwd: REPO })
  })
})
