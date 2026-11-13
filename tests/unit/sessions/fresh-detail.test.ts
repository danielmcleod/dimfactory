// Review fix (sessions, R10, resume_failed; the PassCard session line's Why?): core says
// the fact behind a fresh start that its FreshReason alone does not carry (shared FreshDetail), so the card's
// "Why?" never guesses:
//   - cannot-resume decided by rule 4 (the vendor's capabilities say resume 'none') → `vendor-cannot-resume`;
//     canResume's cannot-resume (the session is gone) has none
//   - resume-failed: the free fallback (same attempt, no budget) has none; a fresh start that began a new attempt
//     (the fallback rejected again spends the retry; Retry after the snag) → `new-attempt`
// The launch plan and the decision stay as they were; the detail rides on the step, its view and its step-status.
import { describe, expect, it } from 'vitest'
import type { RunEnvelope } from '@shared/run.ts'
import { toStepView } from '@core/supervisor/derive.ts'
import { projectFromLog } from '@core/supervisor/recovery.ts'
import type { Effect, SessionCheck } from '@core/supervisor/types.ts'
import { Flow, must } from '../supervisor/helpers.review.ts'
import type { ReviewOptions } from '../supervisor/helpers.review.ts'

const REPO = 'C:\\work\\repo'
const C08C = 'No conversation found with session ID: impl-session'

/** Flow whose Implement process reports the folder it runs in (the controller's `spawned` event). */
class CwdFlow extends Flow {
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
      cwd: REPO,
      sessionId: 'impl-session',
    })
    return this
  }
}

/** Gate before Fix continued; reconcile(pre-fix) and F0 answered: Fix waits on its pass-boundary preflight. */
function atFixPreflight(o: ReviewOptions = {}): Flow {
  const f = new CwdFlow(o)
  f.toJoin(['ok', [must('r1')]])
  f.choose('gate:beforeFix', 'continue')
  f.reconcile('pre-fix')
  f.snapshot('fix-start', 'tree-changed')
  return f
}

function check(o: Partial<SessionCheck> = {}): SessionCheck {
  return { sessionId: 'impl-session', ok: true, cwd: REPO, ...o }
}

const lastFixStatus = (f: Flow) =>
  f
    .bodies('step-status')
    .filter((b) => b.step === 'fix')
    .at(-1)

describe('cannot-resume: which rule decided it', () => {
  it('rule 4 (resume none) → vendor-cannot-resume on the step, its view and its step-status; the launch is unchanged', () => {
    const f = atFixPreflight()
    f.send({
      t: 'session-check',
      step: 'fix',
      check: check({ capabilities: { resume: 'none', resumeModelSwitch: true } }),
    })
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch).toEqual({
      fresh: { reason: 'cannot-resume' },
      session: { reuse: false, reason: 'cannot-resume' },
      notes: [],
    })
    expect(f.step('fix')).toMatchObject({
      sessionNote: 'fresh session: the session cannot be resumed',
      freshDetail: 'vendor-cannot-resume',
    })
    expect(toStepView(f.step('fix')).freshDetail).toBe('vendor-cannot-resume')
    expect(lastFixStatus(f)).toMatchObject({
      status: 'running',
      sessionNote: 'fresh session: the session cannot be resumed',
      freshDetail: 'vendor-cannot-resume',
    })
  })

  it('rule 4 comes before canResume: resume none and a missing session still say the vendor', () => {
    const f = atFixPreflight()
    f.send({
      t: 'session-check',
      step: 'fix',
      check: check({
        ok: false,
        reason: 'cannot-resume',
        capabilities: { resume: 'none', resumeModelSwitch: true },
      }),
    })
    f.passPreflight('fix')
    expect(f.step('fix').freshDetail).toBe('vendor-cannot-resume')
  })

  it('canResume found no session (rule 5) → no detail: the usual cannot-resume', () => {
    const f = atFixPreflight()
    f.send({
      t: 'session-check',
      step: 'fix',
      check: check({
        ok: false,
        reason: 'cannot-resume',
        capabilities: { resume: 'id', resumeModelSwitch: true },
      }),
    })
    f.passPreflight('fix')
    expect(f.step('fix').sessionNote).toBe('fresh session: the session cannot be resumed')
    expect(f.step('fix').freshDetail).toBeUndefined()
    expect(toStepView(f.step('fix')).freshDetail).toBeUndefined()
    expect(lastFixStatus(f)).not.toHaveProperty('freshDetail')
  })

  it('a check for another session does not count: no rule 4, the session is reused', () => {
    const f = atFixPreflight()
    f.send({
      t: 'session-check',
      step: 'fix',
      check: check({ sessionId: 'someone-else', capabilities: { resume: 'none', resumeModelSwitch: true } }),
    })
    f.passPreflight('fix')
    expect(f.step('fix')).toMatchObject({ sessionNote: 'reused the Implement session' })
    expect(f.step('fix').freshDetail).toBeUndefined()
  })
})

describe('resume-failed: the free fallback or a new attempt', () => {
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

  function respawn(f: Flow): void {
    f.snapshot('pre-retry', 'tree-changed')
    f.passPreflight('fix')
  }

  it('the free fallback (same attempt, budget unused) has no detail', () => {
    const f = reusingFix()
    rejectResume(f)
    respawn(f)
    expect(f.step('fix')).toMatchObject({
      attempt: 1,
      autoRetryUsed: false,
      sessionNote: 'fresh session: resuming failed',
    })
    expect(f.step('fix').freshDetail).toBeUndefined()
    expect(lastFixStatus(f)).not.toHaveProperty('freshDetail')
  })

  it('the fallback rejected again spends the retry: attempt 2 starts fresh with new-attempt', () => {
    const f = reusingFix()
    rejectResume(f)
    respawn(f)
    rejectResume(f)
    respawn(f)
    expect(f.fx('spawn')[0]?.launch.fresh).toEqual({ reason: 'resume-failed' })
    expect(f.step('fix')).toMatchObject({
      attempt: 2,
      autoRetryUsed: true,
      sessionNote: 'fresh session: resuming failed',
      freshDetail: 'new-attempt',
    })
    expect(toStepView(f.step('fix'))).toMatchObject({ attempt: 2, freshDetail: 'new-attempt' })
    expect(lastFixStatus(f)).toMatchObject({ attempt: 2, freshDetail: 'new-attempt' })
  })

  it('Retry after the snag is a new attempt too; a later fresh start for another reason drops the detail', () => {
    const f = reusingFix()
    rejectResume(f)
    respawn(f)
    rejectResume(f)
    respawn(f)
    rejectResume(f)
    expect(f.step('fix')).toMatchObject({ status: 'failed', reason: 'resume_failed', snagOpen: true })
    f.snapshot('stopped', 'tree-changed')
    f.user({ kind: 'retry', step: 'fix', strategy: 'fresh' })
    respawn(f)
    expect(f.fx('spawn')[0]).toMatchObject({ attempt: 3, launch: { fresh: { reason: 'resume-failed' } } })
    expect(f.step('fix')).toMatchObject({
      sessionNote: 'fresh session: resuming failed',
      freshDetail: 'new-attempt',
    })
    // An ordinary failure now: the retry is a plain fresh start (no reason), so no detail either.
    f.ev('fix', { type: 'error', message: 'overloaded', raw: '', fatal: true, category: 'vendor_internal' })
    f.exit('fix', { code: 1 })
    f.snapshot('stopped', 'tree-changed')
    f.user({ kind: 'retry', step: 'fix', strategy: 'fresh' })
    respawn(f)
    expect(f.fx('spawn')[0]?.launch.fresh).toEqual({})
    expect(f.step('fix').sessionNote).toBeUndefined()
    expect(f.step('fix').freshDetail).toBeUndefined()
  })

  it('the adapter’s own resume-failed at the first decision is not a new attempt: no detail', () => {
    const f = atFixPreflight()
    f.send({ t: 'session-check', step: 'fix', check: check({ ok: false, reason: 'resume-failed' }) })
    f.passPreflight('fix')
    expect(f.step('fix')).toMatchObject({ attempt: 1, sessionNote: 'fresh session: resuming failed' })
    expect(f.step('fix').freshDetail).toBeUndefined()
  })
})

describe('crash recovery', () => {
  function logged(effects: readonly Effect[], runId: string): RunEnvelope[] {
    return effects
      .filter((e): e is Extract<Effect, { t: 'emit' }> => e.t === 'emit')
      .map((e, i) => ({ runId, seq: 100 + i, ts: 2_000_000, body: e.body }))
  }

  it('projectFromLog keeps the detail a step-status carried, and a later note without one clears it', () => {
    const f = atFixPreflight()
    f.send({
      t: 'session-check',
      step: 'fix',
      check: check({ capabilities: { resume: 'none', resumeModelSwitch: true } }),
    })
    const runJson = structuredClone(f.state)
    const before = f.log.length
    f.passPreflight('fix')
    const s = projectFromLog(runJson, logged(f.log.slice(before), f.state.runId))
    expect(s.steps.fix).toMatchObject({
      sessionNote: 'fresh session: the session cannot be resumed',
      freshDetail: 'vendor-cannot-resume',
    })
    const later = projectFromLog(s, [
      {
        runId: f.state.runId,
        seq: 200,
        ts: 2_000_100,
        body: {
          t: 'step-status',
          step: 'fix',
          attempt: 1,
          status: 'running',
          sessionNote: 'the CLI ignored --resume and started a fresh session',
        },
      },
    ])
    expect(later.steps.fix.freshDetail).toBeUndefined()
  })
})
