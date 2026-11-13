// Re-run from Fix availability and how its Fix would start (sessions: available when the run
// has a diff and at least one finding, whatever its status: completed, cancelled, failed or paused; the tooltip says
// whether Fix starts fresh and why), as RunSnapshot.rerunFromFix carries it (supervisor/rerun.ts through derive.ts).
import { describe, expect, it } from 'vitest'
import { toRunSnapshot, toRunSummary } from '@core/supervisor/derive.ts'
import {
  RERUN_TEXT,
  carriedFindings,
  defaultFindingIds,
  rerunBase,
  rerunBlocked,
  rerunFromFixUnavailable,
  rerunFromFixView,
} from '@core/supervisor/rerun.ts'
import type { RunState } from '@core/supervisor/types.ts'
import {
  FOLDER,
  Flow,
  atGate,
  cancelledAtGate,
  completedFixed,
  failedAtFix,
  must,
  pausedAtFix,
  should,
} from './helpers.ts'

const EM_DASH = '\u2014'

/** The Implement session ran in the run's folder (what the controller's `spawned` event records). */
function withSessionCwd(s: RunState, cwd = FOLDER): RunState {
  const sid = s.steps.implement.sessionId ?? ''
  s.sessions[sid] = { ...(s.sessions[sid] ?? { vendor: 'claude', step: 'implement' }), cwd }
  return s
}

describe('availability matrix (a diff and at least one finding, whatever the status)', () => {
  it.each([
    ['completed (fixed)', () => completedFixed()],
    ['cancelled at the beforeFix gate', () => cancelledAtGate()],
    ['failed at Fix (holding the lock)', () => failedAtFix()],
    ['paused at Fix (holding the lock)', () => pausedAtFix()],
  ] as const)('%s → available', (_name, make) => {
    const s = make().state
    expect(rerunBlocked(s)).toBeUndefined()
    expect(rerunFromFixUnavailable(s)).toBeUndefined()
    const v = rerunFromFixView(withSessionCwd(s))
    expect(v).toMatchObject({ available: true, fresh: false })
    expect(v.unavailable).toBeUndefined()
    expect(v.findingIds).toEqual(expect.arrayContaining(['r1']))
  })

  it('a run that is still going (queued, running, waiting at its gate) → not offered, with why', () => {
    const queued = new Flow()
    expect(queued.state.status).toBe('queued')
    expect(rerunFromFixUnavailable(queued.state)).toBe(RERUN_TEXT.notOver)
    const running = new Flow().toImplementRunning()
    expect(running.state.status).toBe('running')
    expect(rerunFromFixView(running.state)).toEqual({
      available: false,
      fresh: true,
      unavailable: RERUN_TEXT.notOver,
    })
    const gate = atGate()
    expect(gate.state.status).toBe('waiting')
    expect(rerunFromFixUnavailable(gate.state)).toBe(RERUN_TEXT.notOver)
    // Re-run with same config has the same rule (R14).
    expect(rerunBlocked(gate.state)).toBe(RERUN_TEXT.notOver)
  })

  it('no findings (both reviewers clean) → not offered', () => {
    const f = new Flow({ beforeFix: false })
    f.toJoin()
    expect(f.state.outcome).toBe('clean')
    expect(rerunFromFixUnavailable(f.state)).toBe(RERUN_TEXT.noFindings)
  })

  it('Implement made no changes, or never finished → not offered', () => {
    const f = new Flow()
    f.toImplementDone()
    f.snapshot('S1', 'tree-base')
    expect(f.state.outcome).toBe('no-changes')
    expect(rerunFromFixUnavailable(f.state)).toBe(RERUN_TEXT.noChanges)
    const stopped = new Flow().toImplementRunning()
    stopped.user({ kind: 'stop' })
    expect(stopped.state.status).toBe('cancelled')
    expect(rerunFromFixUnavailable(stopped.state)).toBe(RERUN_TEXT.noImplement)
  })

  it('an isolated run, or Fix turned off → not offered, with why', () => {
    const iso = completedFixed().state
    iso.config.isolation = 'worktree'
    expect(rerunFromFixUnavailable(iso)).toBe(RERUN_TEXT.isolated)
    const off = cancelledAtGate().state
    off.config.passes.fix.enabled = false
    expect(rerunFromFixUnavailable(off)).toBe(RERUN_TEXT.fixOff)
  })

  it('a reviewer failed before the join: the done reviewer’s findings count (merged as R8 would)', () => {
    const f = new Flow()
    f.toReviewRunning()
    f.report('review', 'ok', [should('s1'), must('m1')])
    f.exit('critic', { code: 1, failure: { ...failureOf('auth_expired') } })
    expect(f.state.status).toBe('failed')
    expect(f.state.findings?.list).toEqual([])
    const list = carriedFindings(f.state)
    expect(list.map((x) => [x.id, x.severity, x.n])).toEqual([
      ['m1', 'must', 1],
      ['s1', 'should', 2],
    ])
    expect(rerunFromFixUnavailable(f.state)).toBeUndefined()
    // The run never reached its gate: Fix gets every finding by default.
    expect(defaultFindingIds(f.state)).toEqual(['m1', 's1'])
    // No findings.json was written (only the join writes it), so the snapshot carries the picker's list.
    expect(f.state.outputs.findings).toBeUndefined()
    const view = toRunSnapshot(f.state, 0).rerunFromFix
    expect(view.findings?.map((x) => [x.id, x.severity, x.n])).toEqual([
      ['m1', 'must', 1],
      ['s1', 'should', 2],
    ])
    expect(toRunSummary(f.state).rerunFromFix).not.toHaveProperty('findings')
  })

  it('stopped while Critic runs after Review reported, the snapshot offers Review’s findings', () => {
    const f = new Flow()
    f.toReviewRunning()
    f.report('review', 'ok', [must('m1'), should('s1')])
    f.user({ kind: 'stop' })
    if (f.state.steps.critic.status === 'running') f.exit('critic', { code: 1 })
    if (f.findReq((r) => r.kind === 'snapshot' && r.label === 'stopped') !== undefined) {
      f.snapshot('stopped', 'tree-changed')
    }
    expect(f.state.status).toBe('cancelled')
    expect(f.state.steps.critic.status).toBe('cancelled')
    const view = toRunSnapshot(f.state, 0).rerunFromFix
    expect(view).toMatchObject({ available: true, findingIds: ['m1', 's1'] })
    expect(view.findings?.map((x) => x.id)).toEqual(['m1', 's1'])
    // Not offered: no findings list either.
    const live = new Flow()
    live.toReviewRunning()
    expect(toRunSnapshot(live.state, 0).rerunFromFix).not.toHaveProperty('findings')
  })

  it('every reason is UI copy without an em dash', () => {
    for (const t of Object.values(RERUN_TEXT)) expect(t).not.toContain(EM_DASH)
  })
})

function failureOf(category: 'auth_expired') {
  return { category, message: category, raw: '', classifiedBy: 'structured' as const }
}

describe('default findings: every must, plus the shoulds selected at the gate', () => {
  it('the gate deselected r3: Fix gets r1 (must) and r2', () => {
    const s = completedFixed({}, ['r1', 'r2']).state
    expect(s.findings?.selected).toEqual(['r1', 'r2'])
    expect(defaultFindingIds(s)).toEqual(['r1', 'r2'])
  })

  it('a must the gate deselected is chosen again', () => {
    const s = completedFixed({}, ['r2']).state
    expect(defaultFindingIds(s)).toEqual(['r1', 'r2'])
  })

  it('the gate never answered (cancelled at it): every must and every selected should', () => {
    const s = cancelledAtGate().state
    expect(defaultFindingIds(s)).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('fresh or not, and why (the tooltip), from the run’s config and Implement’s session', () => {
  it('reuse: same vendor, Implement’s session, same folder', () => {
    expect(rerunFromFixView(withSessionCwd(completedFixed().state))).toEqual({
      available: true,
      fresh: false,
      findingIds: ['r1', 'r2', 'r3'],
    })
  })

  it('Fix on another vendor → fresh (vendor-differs)', () => {
    const s = withSessionCwd(cancelledAtGate({ fixVendor: 'codex' }).state)
    expect(rerunFromFixView(s)).toMatchObject({ available: true, fresh: true, reason: 'vendor-differs' })
  })

  it('Implement reported no session → fresh (no-session)', () => {
    const f = new Flow()
    f.toImplementRunning({ session: false })
    f.ev('implement', { type: 'done', result: 'ok', usage: { input: 1, output: 1 } })
    f.exit('implement')
    f.reconcile('end-of-pass')
    f.snapshot('S1', 'tree-changed')
    f.reconcile('pre-review')
    for (const k of f.reviewers) f.passPreflight(k)
    f.report('review', 'ok', [must('r1')])
    f.report('critic', 'none')
    f.snapshot('post-review', 'tree-changed')
    f.choose('gate:beforeFix', 'cancel')
    f.snapshot('stopped', 'tree-changed')
    expect(rerunFromFixView(f.state)).toMatchObject({ available: true, fresh: true, reason: 'no-session' })
  })

  it('the session ran in another folder → fresh (cwd-changed)', () => {
    const s = withSessionCwd(cancelledAtGate().state, 'C:\\tmp\\elsewhere')
    expect(rerunFromFixView(s)).toMatchObject({ available: true, fresh: true, reason: 'cwd-changed' })
  })

  it('Fix’s model differs and the vendor cannot switch models on resume → fresh (model-differs)', () => {
    const s = withSessionCwd(cancelledAtGate().state)
    s.config.passes.fix.model = 'opus'
    // Unknown capabilities never fail the rule.
    expect(rerunFromFixView(s)).toMatchObject({ fresh: false })
    expect(rerunFromFixView(s, { capabilities: { resume: 'id', resumeModelSwitch: false } })).toMatchObject({
      available: true,
      fresh: true,
      reason: 'model-differs',
    })
    expect(rerunFromFixView(s, { capabilities: { resume: 'id', resumeModelSwitch: true } })).toMatchObject({
      available: true,
      fresh: false,
    })
  })

  it('the vendor cannot resume at all → fresh (cannot-resume)', () => {
    const s = withSessionCwd(cancelledAtGate().state)
    expect(rerunFromFixView(s, { capabilities: { resume: 'none', resumeModelSwitch: true } })).toMatchObject({
      fresh: true,
      reason: 'cannot-resume',
    })
  })

  it('the Fix row set to Fresh → fresh (override-fresh)', () => {
    const s = withSessionCwd(cancelledAtGate({ reuseSession: false }).state)
    expect(rerunFromFixView(s)).toMatchObject({ available: true, fresh: true, reason: 'override-fresh' })
  })

  it('RunSnapshot.rerunFromFix is the view (derive.ts), with the Fix vendor’s capabilities from core', () => {
    const s = withSessionCwd(cancelledAtGate().state)
    s.config.passes.fix.model = 'opus'
    const snap = toRunSnapshot(s, 0, undefined, {
      fixCapabilities: { resume: 'id', resumeModelSwitch: false },
    })
    expect(snap.rerunFromFix).toMatchObject({ available: true, fresh: true, reason: 'model-differs' })
    expect(toRunSnapshot(atGate().state, 0).rerunFromFix).toEqual({
      available: false,
      fresh: true,
      unavailable: RERUN_TEXT.notOver,
    })
  })

  it('RunSummary.rerunFromFix carries the same facts (the Runs history row and its tooltip)', () => {
    const s = withSessionCwd(cancelledAtGate().state)
    // The snapshot also carries the picker's findings; a summary (an index line) never does.
    const { findings, ...facts } = toRunSnapshot(s, 0).rerunFromFix
    expect(findings?.map((f) => f.id)).toEqual(['r1', 'r2', 'r3'])
    expect(toRunSummary(s).rerunFromFix).toEqual(facts)
    expect(toRunSummary(s).rerunFromFix).not.toHaveProperty('findings')
    expect(toRunSummary(s).rerunFromFix).toEqual({
      available: true,
      fresh: false,
      findingIds: ['r1', 'r2', 'r3'],
    })
    const caps = { resume: 'none' as const, resumeModelSwitch: true }
    expect(toRunSummary(s, undefined, { fixCapabilities: caps }).rerunFromFix).toMatchObject({
      fresh: true,
      reason: 'cannot-resume',
    })
  })
})

describe('the base: the source’s last result snapshot', () => {
  it.each([
    ['completed', () => completedFixed(), 'S2'],
    ['cancelled at the gate', () => cancelledAtGate(), 'stopped'],
    ['failed at Fix', () => failedAtFix(), 'stopped'],
    ['paused at Fix', () => pausedAtFix(), 'interrupted'],
  ] as const)('%s → %s', (_n, make, label) => {
    expect(rerunBase(make().state)?.label).toBe(label)
  })
})
