// Re-run from Fix through the reducer (sessions, Re-run from Fix, R10/R14): the new
// run carries Plan, Implement, Review and Critic (skipped "carried from run #N"), their snapshots, findings and
// sessions; it starts at the pre-Fix boundary, reconciles the folder against the source's last result snapshot,
// takes F0 and resumes Implement's session when decideSession allows, else starts fresh with the reason.
import { describe, expect, it } from 'vitest'
import { fixReusesSession, promptDiffRange } from '@core/supervisor/effects.ts'
import { DEFAULT_CONTEXT } from '@core/supervisor/machine.ts'
import { carriedReason, notFinishedReason, rerunBase } from '@core/supervisor/rerun.ts'
import { initRerunFromFix } from '@core/supervisor/rerun-state.ts'
import { fixSessionInputs, sessionCandidate } from '@core/supervisor/sessions.ts'
import type { RunState, SessionCheck } from '@core/supervisor/types.ts'
import { IMPL_TOTALS } from '../supervisor/helpers.review.ts'
import { Harness, okReport } from '../supervisor/helpers.ts'
import { FOLDER, cancelledAtGate, completedFixed, failedAtFix, pausedAtFix, rerunInit } from './helpers.ts'

/** A harness around the Re-run from Fix of `source` with Fix getting `ids`. */
function rerunOf(source: RunState, ids: string[] = ['r1', 'r2', 'r3']): Harness {
  const h = new Harness(source.config, DEFAULT_CONTEXT)
  h.state = initRerunFromFix(source, rerunInit(source), ids)
  h.now = source.createdAt + 3_600_000
  return h
}

const check = (o: Partial<SessionCheck> = {}): SessionCheck => ({
  sessionId: 'impl-session',
  ok: true,
  cwd: FOLDER,
  ...o,
})

/** created → lock → authoritative preflight: the run goes straight to R10 (reconcile(pre-fix)). */
function toPreFix(h: Harness): void {
  h.create()
  h.lock()
  h.preflight(okReport())
}

describe('the carried state (supervisor/rerun-state.ts)', () => {
  it('Plan, Implement, Review and Critic are skipped "carried from run #N" with what Fix needs of them', () => {
    const src = completedFixed().state
    const s = initRerunFromFix(src, rerunInit(src), ['r1'])
    const reason = carriedReason(src.displayNo)
    expect(reason).toBe('carried from run #7')
    for (const k of ['plan', 'implement', 'review', 'critic'] as const) {
      expect(s.steps[k]).toMatchObject({ status: 'skipped', reason, attempt: 0 })
    }
    expect(s.steps.implement).toMatchObject({
      vendor: 'claude',
      sessionId: 'impl-session',
      startSnap: src.steps.implement.startSnap,
      endSnap: src.steps.implement.endSnap,
      endSnapStatus: 'done',
    })
    // verify:1 was off in the source: its own reason stays.
    expect(s.steps['verify:1']).toMatchObject({ status: 'skipped', reason: 'verify off' })
    for (const k of ['preflight', 'prepare', 'fix', 'verify:2'] as const)
      expect(s.steps[k].status).toBe('queued')
    expect(s.plan).toMatchObject({ decided: true, text: src.plan.text })
    expect(s.sessions).toEqual(src.sessions)
    expect(s.sessions['impl-session']?.lastTotals).toEqual(IMPL_TOTALS)
    expect(s.findings?.list.map((f) => f.id)).toEqual(['r1', 'r2', 'r3'])
    expect(s.findings?.selected).toEqual(['r1'])
    expect(s.snapshots.S0).toEqual(src.snapshots.S0)
    expect(s.snapshots.S1).toEqual(src.snapshots.S1)
    expect(s.snapshots['post-review']).toEqual(src.snapshots['post-review'])
    // Never the source's Fix: its F0 and S2 are not the new run's.
    expect(s.snapshots['fix-start']).toBeUndefined()
    expect(s.snapshots.S2).toBeUndefined()
    expect(s.rerunOf).toEqual({ runId: src.runId, displayNo: 7, from: 'fix', base: rerunBase(src) })
    expect(s.rerunOf?.base?.label).toBe('S2')
    expect(s.flow).toMatchObject({ runStart: 'done', review: 'joined' })
    expect(s.notes).toEqual([
      'Re-run from Fix of run #7: Plan, Implement, Review and Critic are carried from it.',
    ])
    expect(s.started).toBe(false)
  })

  it('a pass that had not finished in the source says so', () => {
    const f = completedFixed()
    const src = f.state
    src.steps.critic = { ...src.steps.critic, status: 'failed' }
    const s = initRerunFromFix(src, rerunInit(src), ['r1'])
    expect(s.steps.critic).toMatchObject({ status: 'skipped', reason: notFinishedReason(7) })
  })

  it('Implement counts as done for decideSession (its session is the candidate)', () => {
    const src = cancelledAtGate().state
    const s = initRerunFromFix(src, rerunInit(src), ['r1'])
    expect(fixSessionInputs(s).implement.status).toBe('done')
    expect(sessionCandidate(fixSessionInputs(s))).toEqual({ reuse: true, sessionId: 'impl-session' })
  })
})

describe('R10 first: the new run starts at the pre-Fix boundary', () => {
  it('created: the carried steps reach the log and findings.json is written with the chosen findings', () => {
    const src = completedFixed().state
    const h = rerunOf(src, ['r1', 'r3'])
    h.create()
    const statuses = h.bodies('step-status').map((b) => [b.step, b.status, b.reason])
    expect(statuses).toEqual(
      expect.arrayContaining([
        ['plan', 'skipped', 'carried from run #7'],
        ['implement', 'skipped', 'carried from run #7'],
        ['review', 'skipped', 'carried from run #7'],
        ['critic', 'skipped', 'carried from run #7'],
      ]),
    )
    const [w] = h.fx('writeFindings')
    expect(w?.doc.runId).toBe(h.state.runId)
    expect(w?.doc.selected).toEqual({ r1: true, r2: false, r3: true })
    expect(h.state.outputs.findings).toBe(1)
    expect(h.fx('lock')).toHaveLength(1)
    expect(h.state.status).toBe('queued')
  })

  it('reconciles against the source’s last snapshot (S0..base are the run’s changes), then F0, then resumes Implement', () => {
    const src = completedFixed().state
    const base = rerunBase(src)
    const h = rerunOf(src)
    toPreFix(h)
    // No run-start, no Plan: straight to reconcile(pre-fix).
    expect(h.fx('snapshot')).toEqual([])
    const [rec] = h.fx('reconcile')
    expect(rec).toMatchObject({ boundary: 'pre-fix', step: 'fix' })
    expect(rec?.input.last).toBe(base?.commit)
    expect(rec?.input.runStart).toBe(src.snapshots.S0?.commit)
    expect(h.state.phase).toBe('fixing')
    h.reconcile('pre-fix')
    const [f0] = h.fx('snapshot')
    expect(f0).toMatchObject({ label: 'fix-start', step: 'fix' })
    h.snapshot('fix-start', 'tree-fixed')
    h.send({ t: 'session-check', step: 'fix', check: check() })
    h.passPreflight('fix')
    const [sp] = h.fx('spawn')
    expect(sp?.launch).toEqual({
      resume: { sessionId: 'impl-session', priorUsage: IMPL_TOTALS },
      session: { reuse: true, sessionId: 'impl-session' },
      notes: [],
    })
    expect(sp && fixReusesSession(sp)).toBe(true)
    expect(h.step('fix').sessionNote).toBe('reused the Implement session')
    // Fix finishes: S2, completed (fixed).
    h.ev('fix', { type: 'done', result: 'F1 fixed', usage: { input: 3, output: 3 } })
    h.exit('fix')
    h.reconcile('end-of-pass')
    h.snapshot('S2', 'tree-fixed-2')
    expect(h.state).toMatchObject({ status: 'completed', outcome: 'fixed' })
  })

  it('a fresh Fix (the session cannot be resumed) gets the S0..F0 diff from the carried S0', () => {
    const src = failedAtFix().state
    const h = rerunOf(src, ['r1'])
    toPreFix(h)
    h.reconcile('pre-fix')
    h.snapshot('fix-start', 'tree-now')
    h.send({ t: 'session-check', step: 'fix', check: check({ ok: false, reason: 'cannot-resume' }) })
    h.passPreflight('fix')
    const [sp] = h.fx('spawn')
    expect(sp?.launch).toMatchObject({ fresh: { reason: 'cannot-resume' } })
    expect(h.step('fix').sessionNote).toBe('fresh session: the session cannot be resumed')
    const range = sp !== undefined ? promptDiffRange(h.state, sp) : undefined
    expect(range?.label).toBe('S0..F0')
    expect(range?.from).toEqual(src.snapshots.S0)
    expect(range?.to?.label).toBe('fix-start')
  })

  it('Fix on another vendor starts fresh (vendor-differs) without asking the adapter', () => {
    const src = cancelledAtGate({ fixVendor: 'codex' }).state
    const h = rerunOf(src, ['r1'])
    toPreFix(h)
    h.reconcile('pre-fix')
    h.snapshot('fix-start', 'tree-now')
    h.passPreflight('fix')
    expect(h.fx('spawn')[0]?.launch).toMatchObject({ fresh: { reason: 'vendor-differs' } })
  })

  it('the folder changed where the run did too: the reconcile card holds Fix; Include my edits tells Fix', () => {
    const src = pausedAtFix().state
    const h = rerunOf(src, ['r1'])
    toPreFix(h)
    const req = h.req((r) => r.kind === 'reconcile' && r.boundary === 'pre-fix')
    h.send({
      t: 'reconcile-result',
      req,
      result: {
        verdict: 'choice',
        card: {
          verdict: 'choice',
          reasons: [
            {
              row: 'external-overlap',
              severity: 'choice',
              title: '1 file the run changed was edited outside it',
              detail: "src/version.ts. Include your edits, or restore the run's version (you can undo that).",
              actions: [],
            },
          ],
          external: ['src/version.ts'],
          overlapping: ['src/version.ts'],
          choices: [
            { id: 'include-my-edits', label: 'Include my edits', primary: true },
            { id: 'restore-run-version', label: "Restore run's version" },
            { id: 'stop', label: 'Stop' },
          ],
          defaultChoice: 'include-my-edits',
          notes: ['User edited outside the run: src/version.ts'],
        },
      },
    })
    const card = h.state.cards.find((c) => c.view.kind === 'reconcile')
    expect(card).toBeDefined()
    expect(h.state.status).toBe('waiting')
    expect(h.fx('snapshot')).toEqual([])
    h.user({ kind: 'card', cardId: card?.view.id ?? '', choiceId: 'include-my-edits' })
    expect(h.state.findings?.notes).toContain('User edited outside the run: src/version.ts')
    expect(h.fx('snapshot')[0]).toMatchObject({ label: 'fix-start' })
  })

  it('Stop before Fix spawns: cancelled, and its `stopped` snapshot is taken before the lock goes', () => {
    const src = cancelledAtGate().state
    const h = rerunOf(src, ['r1'])
    toPreFix(h)
    h.user({ kind: 'stop' })
    expect(h.state.status).toBe('cancelled')
    expect(h.fx('snapshot')[0]).toMatchObject({ label: 'stopped' })
    expect(h.fx('unlock')).toEqual([])
    // The reconcile in flight answers (and is dropped), then the `stopped` snapshot lets the folder go.
    h.reconcile('pre-fix')
    expect(h.fx('unlock')).toEqual([])
    h.snapshot('stopped', 'tree-now')
    expect(h.fx('unlock')).toHaveLength(1)
    expect(h.state.lock).toBe('none')
  })

  it('a re-run of a re-run carries from the first (its Implement segment and sessions), based on the second', () => {
    const src = cancelledAtGate().state
    const h = rerunOf(src, ['r1'])
    toPreFix(h)
    h.reconcile('pre-fix')
    h.snapshot('fix-start', 'tree-now')
    h.send({ t: 'session-check', step: 'fix', check: check() })
    h.passPreflight('fix')
    h.exit('fix', {
      code: 1,
      failure: { category: 'auth_expired', message: 'x', raw: '', classifiedBy: 'structured' },
    })
    h.snapshot('stopped', 'tree-partial-2')
    expect(h.state.status).toBe('failed')
    const second = h.state
    const again = initRerunFromFix(
      second,
      rerunInit(second, { runId: '20261009T130000Z-ssss', displayNo: 9 }),
      ['r1'],
    )
    expect(again.steps.implement).toMatchObject({ status: 'skipped', reason: 'carried from run #7' })
    expect(again.steps.implement.startSnap).toEqual(src.snapshots.S0)
    expect(again.rerunOf).toMatchObject({ runId: second.runId, displayNo: 8, from: 'fix' })
    expect(again.rerunOf?.base).toMatchObject({ label: 'stopped', tree: 'tree-partial-2' })
    expect(sessionCandidate(fixSessionInputs(again))).toEqual({ reuse: true, sessionId: 'impl-session' })
  })
})
