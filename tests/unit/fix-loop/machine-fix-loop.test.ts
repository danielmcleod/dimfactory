// Fix until green in the state machine (the reducer only; the drivers play the controller). Each round is Fix →
// S2 → verify:2 → the re-check (on Review's config without the security advisor), then the stop rules:
//   - green (no [must] open, verify passes) → completed(fixed)
//   - the round cap → completed(fix-stopped), "Completed with failures"
//   - the budget (cost, working time): the next round is expected to cost what the last did
//   - no progress: a round that changed nothing, or did not reduce what is open
// Otherwise the post-round snapshot, then the next round: a new attempt of Fix (its own start snapshot, R10's
// reconcile, decideSession against the previous round's session) on what is still open, then verify:2 and the
// re-check again. Rounds are recorded (RunSnapshot.fixLoop) and the run's summary says why it stopped.
import { describe, expect, it } from 'vitest'
import type { AgentStep } from '@shared/run.ts'
import type { NormalizedEvent } from '@shared/events.ts'
import { toRunSnapshot, toRunSummary } from '@core/supervisor/derive.ts'
import { buildPrompt, promptDiffRange } from '@core/supervisor/effects.ts'
import { FIX_STOP_TEXT } from '@core/supervisor/machine.ts'
import { SESSION_NOTE } from '@core/supervisor/sessions.ts'
import {
  availableSegments,
  missingSegmentText,
  segmentEnds,
  segmentRound,
} from '@core/supervisor/diff-segments.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import type { FindingInput, Reduction, RunConfig } from '@core/supervisor/types.ts'
import { VFlow, verifyFlowConfig, result, trusted, verifyMust } from '../verify/machine-helpers.ts'
import type { VerifyOptions } from '../verify/machine-helpers.ts'
import { must } from '../supervisor/helpers.review.ts'
import { makeRun, okReport } from '../supervisor/helpers.ts'
import { initRerunFromFix } from '@core/supervisor/rerun-state.ts'
import { rerunInit } from '../rerun/helpers.ts'

interface LoopOptions extends VerifyOptions {
  rounds?: number
  recheck?: boolean
  maxUsd?: number
  maxMinutes?: number
  security?: boolean
}

function loopConfig(o: LoopOptions): RunConfig {
  const c = verifyFlowConfig({ beforeFix: false, critic: false, ...o })
  if (o.rounds !== 1)
    c.fixLoop = {
      rounds: o.rounds ?? 3,
      recheck: o.recheck ?? true,
      ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
      ...(o.maxMinutes !== undefined ? { maxMinutes: o.maxMinutes } : {}),
    }
  if (o.security === true) c.passes.security = { ...c.passes.security, enabled: true, model: 'haiku' }
  return c
}

class LFlow extends VFlow {
  constructor(o: LoopOptions = {}) {
    super({ beforeFix: false, critic: false, ...o })
    this.state = makeRun(loopConfig(o))
  }

  agentSpawnNo(step: AgentStep): number {
    return this.state.steps[step].proc?.spawnNo ?? 0
  }

  agentEv(step: AgentStep, ev: NormalizedEvent): Reduction {
    return this.send({ t: 'adapter', step, spawnNo: this.agentSpawnNo(step), ev })
  }

  agentExit(step: AgentStep): Reduction {
    return this.send({
      t: 'exit',
      step,
      spawnNo: this.agentSpawnNo(step),
      code: 0,
      signal: null,
      ranMs: 4000,
    })
  }

  agentPreflight(step: AgentStep): Reduction {
    const req = this.req(
      (r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === step,
      `passBoundary ${step}`,
    )
    return this.send({ t: 'preflight-result', req, report: { ...okReport(), mode: 'passBoundary' } })
  }

  /**
   * Implement → verify:1 (`test` fails, a [must]) → Review reports `r1` (a [must]) → the join → Fix's R10 → Fix
   * spawned (round 1). F1 = r1 (review), F2 = the verify:1 failure.
   */
  toRound1(reviewFindings: FindingInput[] = [must('r1')]): this {
    this.toVerified(result('test', 'fail'), [verifyMust('test')])
    this.toJoinAfterVerify('ok', 'none', reviewFindings)
    this.toFixSpawned('tree-r0')
    this.ev('fix', { type: 'session', id: 'fix-session' })
    return this
  }

  /** The round's Fix done (spending `usd`, `ms` of work) → exit → end-of-pass → S2 with `tree`. */
  fixDone(tree: string, o: { usd?: number; ms?: number } = {}): this {
    if (o.ms !== undefined) this.tick(o.ms)
    this.ev('fix', {
      type: 'done',
      result: 'F1 fixed',
      usage: { input: 10, output: 10, costUsd: o.usd ?? 0.1 },
    })
    this.exit('fix')
    this.reconcile('end-of-pass')
    this.snapshot('S2', tree)
    return this
  }

  /** verify:2: the trusted `test` passes or fails (its [must]). */
  verify2(status: 'pass' | 'fail'): this {
    this.check([trusted('test')], 'verify:2')
    this.round([result('test', status)], status === 'fail' ? [verifyMust('test')] : [], 'verify:2')
    return this
  }

  /** The re-check answers `text`. */
  recheck(text: string, usd = 0.02): this {
    this.agentPreflight('recheck')
    this.agentEv('recheck', { type: 'done', result: text, usage: { input: 5, output: 5, costUsd: usd } })
    this.agentExit('recheck')
    return this
  }

  /** post-round → the next round's R10: reconcile(pre-fix) → its start snapshot → preflight → Fix spawned. */
  nextRound(startTree: string): this {
    this.snapshot('post-round', startTree)
    this.reconcile('pre-fix')
    this.snapshot('fix-start', startTree)
    this.passPreflight('fix')
    return this
  }
}

const spawns = (f: LFlow, step: AgentStep): number =>
  f.log.filter((e) => e.t === 'spawn' && e.step === step).length

describe('Fix until green: round 1', () => {
  it('starts the loop with the [must] findings Fix got; the re-check runs on Review config without the advisor', () => {
    const f = new LFlow().toRound1()
    expect(f.state.fixLoop).toMatchObject({ round: 1, before: 2 })
    expect(f.state.fixLoop?.rounds).toEqual([
      expect.objectContaining({ n: 1, status: 'running', spawnFrom: 0 }),
    ])
    expect(f.state.fixLoop?.firstStart?.label).toBe('fix-start')
    f.fixDone('tree-r1').verify2('fail')
    // The re-check gets every [must] Fix got but verify's (verify:2 decides those), on Review's model.
    expect(f.step('recheck').status).toBe('running')
    f.agentPreflight('recheck')
    expect(f.fx('spawn')).toEqual([
      expect.objectContaining({ step: 'recheck', vendor: 'claude', model: 'sonnet', mode: 'readonly' }),
    ])
    expect(f.state.security?.recheck?.checks).toEqual([1])
    expect(f.state.phase).toBe('rechecking')
  })

  it('green after round 1: verify passes and the re-check confirms the [must] → fixed', () => {
    const f = new LFlow().toRound1()
    f.fixDone('tree-r1').verify2('pass').recheck('F1 resolved')
    expect(f.state.outcome).toBe('fixed')
    expect(f.state.status).toBe('completed')
    expect(f.state.fixLoop?.stop).toEqual({ reason: 'green', text: FIX_STOP_TEXT.green(1) })
    expect(f.state.fixLoop?.rounds).toEqual([
      expect.objectContaining({ n: 1, status: 'done', changed: true, failing: [], resolved: [1], open: [] }),
    ])
    expect(spawns(f, 'fix')).toBe(1)
    expect(toRunSummary(f.state).fixLoop).toEqual({ rounds: 1, max: 3, stop: 'green' })
  })
})

describe('Fix until green: the next round', () => {
  it('not green after round 1: the post-round snapshot, then round 2 on what is still open', () => {
    const f = new LFlow().toRound1()
    f.fixDone('tree-r1').verify2('fail').recheck('F1 resolved')
    // Round 1: r1 resolved, `test` still fails (its verify:2 finding is listed as F3).
    expect(f.state.fixLoop?.rounds[0]).toMatchObject({
      resolved: [1],
      open: [3],
      failing: ['test'],
      count: 1,
    })
    expect(f.state.findings?.list.map((x) => [x.n, x.source, x.id])).toEqual([
      [1, 'review', 'r1'],
      [2, 'verify', 'v-test'],
      [3, 'verify', 'v-test-2'],
    ])
    expect(f.state.outcome).toBeUndefined()
    expect(f.state.boundary).toEqual({ name: 'post-round', step: 'fix' })
    expect(f.state.phase).toBe('fixing')
    f.snapshot('post-round', 'tree-r1')
    // Round 2: a new attempt of Fix from its own start snapshot (R10: reconcile first, against post-round).
    expect(f.state.fixLoop).toMatchObject({ round: 2, targets: [3] })
    expect(f.step('fix')).toMatchObject({ status: 'running', attempt: 2 })
    expect(f.step('fix').startSnap).toBeUndefined()
    expect(f.step('verify:2').status).toBe('queued')
    expect(f.step('recheck').status).toBe('queued')
    const rec = f.log.filter((e) => e.t === 'reconcile').at(-1)
    expect(rec).toMatchObject({ boundary: 'pre-fix', input: { last: 'c-post-round' } })
    f.reconcile('pre-fix')
    f.snapshot('fix-start', 'tree-r1')
    f.passPreflight('fix')
    // decideSession: the previous round's session stands in for Implement's.
    expect(f.fx('spawn')).toHaveLength(1)
    const spawn = f.fx('spawn')[0]
    if (spawn === undefined) throw new Error('no spawn')
    expect(spawn).toMatchObject({ step: 'fix', attempt: 2 })
    expect(spawn.launch.resume?.sessionId).toBe('fix-session')
    expect(spawn.launch.session).toEqual({ reuse: true, sessionId: 'fix-session' })
    expect(spawn.launch.notes?.[0]).toContain('Fix until green, round 2 of 3')
    expect(f.step('fix').sessionNote).toBe(SESSION_NOTE.reusedRound)
    // The Fix prompt lists only what is still open, with the last round's checks.
    const prompt = buildPrompt(f.state, resolveBuiltinConfig({ profile: 'claude-only' }), spawn)
    expect(prompt.text).toContain('F3')
    expect(prompt.text).not.toContain('must r1')
    expect(prompt.text).toContain('round 2 of 3')
    expect(prompt.text).toContain('npm run test')
    // The views: each round's step says which round it is.
    const snap = toRunSnapshot(f.state, 0, f.now)
    expect(snap.steps.fix.round).toEqual({ n: 2, of: 3 })
    expect(snap.steps['verify:2'].round).toEqual({ n: 2, of: 3 })
    expect(snap.fixLoop?.rounds.map((r) => [r.n, r.status])).toEqual([
      [1, 'done'],
      [2, 'running'],
    ])
  })

  it('round 1’s frozen views read as its live steps did when it ended, so its cards keep their size as round 2 begins', () => {
    // Between round 1's end and round 2's start (the post-round snapshot) the Run view shows round 1 in the live
    // steps; from round 2's start it shows round 1's frozen views. Any difference between the two (the mode copy was
    // one: a line on the Fix and Re-check cards) moves everything below on its own.
    const inputs = {
      modeCopy: {
        fix: { status: 'supported' as const, copy: 'Edits files in the folder.' },
        'verify:2': { status: 'supported' as const, copy: 'Runs the trusted commands.' },
        recheck: { status: 'supported' as const, copy: 'Reads and read-only commands.' },
      },
    }
    const f = new LFlow().toRound1()
    f.fixDone('tree-r1').verify2('fail').recheck('F1 resolved')
    const gap = toRunSnapshot(f.state, 0, f.now, inputs)
    expect(gap.fixLoop?.rounds.map((r) => r.status)).toEqual(['done'])
    f.nextRound('tree-r1')
    const next = toRunSnapshot(f.state, 0, f.now, inputs)
    const views = next.fixLoop?.rounds[0]?.views
    expect(next.fixLoop?.rounds.map((r) => r.status)).toEqual(['done', 'running'])
    expect(views?.fix).toEqual(gap.steps.fix)
    expect(views?.verify).toEqual(gap.steps['verify:2'])
    expect(views?.recheck).toEqual(gap.steps.recheck)
  })

  it('green on round 2 → fixed; the verify finding is not listed twice; the Fix segment spans both rounds', () => {
    const f = new LFlow().toRound1()
    f.fixDone('tree-r1').verify2('fail').recheck('F1 resolved')
    f.nextRound('tree-r1')
    f.fixDone('tree-r2').verify2('pass')
    // Nothing for the re-check this round (only verify's finding was open): not needed.
    expect(f.step('recheck')).toMatchObject({ status: 'skipped', reason: 'not needed' })
    expect(f.state.outcome).toBe('fixed')
    expect(f.state.fixLoop?.stop?.reason).toBe('green')
    expect(f.state.fixLoop?.rounds.map((r) => [r.n, r.status, r.open])).toEqual([
      [1, 'done', [3]],
      [2, 'done', []],
    ])
    expect(f.state.findings?.list).toHaveLength(3)
    // Each round keeps its three steps as they ended (the Run view keeps round 1's cards as they were).
    const views = toRunSnapshot(f.state, 0).fixLoop?.rounds.map((r) => r.views)
    expect(views?.[0]?.fix).toMatchObject({ key: 'fix', attempt: 1, status: 'done', round: { n: 1, of: 3 } })
    expect(views?.[0]?.verify.verify?.commands).toEqual([
      expect.objectContaining({ name: 'test', status: 'fail' }),
    ])
    expect(views?.[0]?.recheck.recheck).toEqual({ status: 'resolved', resolved: [1], open: [] })
    expect(views?.[1]?.fix).toMatchObject({ attempt: 2, round: { n: 2, of: 3 } })
    expect(views?.[1]?.verify.verify?.commands).toEqual([
      expect.objectContaining({ name: 'test', status: 'pass' }),
    ])
    expect(segmentEnds(f.state, 'fix')).toMatchObject({
      from: { label: 'fix-start', commit: 'c-fix-start', tree: 'tree-r0' },
      to: { label: 'S2', tree: 'tree-r2' },
    })
    expect(spawns(f, 'fix')).toBe(2)
  })

  it('the Diff tab gets a segment per round once a second round runs: each its own Fix start to its end', () => {
    const f = new LFlow().toRound1()
    f.fixDone('tree-r1').verify2('fail')
    // One round so far (and Fix's own segment covers it): no per-round segments.
    expect(availableSegments(f.state).filter((s) => s.startsWith('fix-round'))).toEqual([])
    f.recheck('F1 resolved')
    expect(segmentEnds(f.state, 'fix-round-1')).toBeUndefined()
    f.nextRound('tree-r1')
    // Round 2 under way: round 1 is recorded; round 2's Fix has no end yet.
    expect(segmentEnds(f.state, 'fix-round-1')).toMatchObject({
      from: { label: 'fix-start', tree: 'tree-r0' },
      to: { label: 'S2', tree: 'tree-r1' },
    })
    expect(segmentEnds(f.state, 'fix-round-2')).toBeUndefined()
    expect(missingSegmentText('fix-round-2')).toBe(
      "Fix until green has not finished round 2's Fix, so its changes cannot be shown yet.",
    )
    f.fixDone('tree-r2').verify2('pass')
    expect(segmentEnds(f.state, 'fix-round-2')).toMatchObject({
      from: { label: 'fix-start', tree: 'tree-r1' },
      to: { label: 'S2', tree: 'tree-r2' },
    })
    // Round 1's segment kept its own ends after round 2 took new snapshots.
    expect(segmentEnds(f.state, 'fix-round-1')?.to.tree).toBe('tree-r1')
    expect(segmentEnds(f.state, 'fix-round-3')).toBeUndefined()
    expect(availableSegments(f.state)).toEqual(['implement', 'fix', 'fix-round-1', 'fix-round-2', 'combined'])
    expect(segmentRound('fix-round-2')).toBe(2)
    expect(segmentRound('fix')).toBeNull()
  })

  it('a command still failing in a later round keeps its finding (no duplicate rows)', () => {
    const f = new LFlow({ rounds: 3 }).toRound1([must('r1'), must('r2')])
    f.fixDone('tree-r1').verify2('fail').recheck('F1 resolved\nF2 open: still there')
    f.nextRound('tree-r1')
    f.fixDone('tree-r2').verify2('fail').recheck('F2 resolved')
    const n = f.state.findings?.list.filter((x) => x.source === 'verify').map((x) => x.n)
    expect(n).toEqual([3, 4])
    expect(f.state.fixLoop?.rounds[1]).toMatchObject({ open: [4], resolved: [2] })
  })

  it('reuseSession off: each round starts fresh ("set to start fresh"), as decideSession says', () => {
    const f = new LFlow({ reuseSession: false }).toRound1()
    f.fixDone('tree-r1').verify2('fail').recheck('F1 resolved')
    f.nextRound('tree-r1')
    const spawn = f.fx('spawn')[0]
    if (spawn === undefined) throw new Error('no spawn')
    expect(spawn.step).toBe('fix')
    expect(spawn.launch.fresh).toEqual({ reason: 'override-fresh' })
    // A fresh round's prompt reads the run's changes so far (S0..this round's start).
    expect(promptDiffRange(f.state, spawn)).toMatchObject({ label: 'S0..F0', to: { tree: 'tree-r1' } })
  })
})

describe('Fix until green: stop rules', () => {
  it('the round cap: still failing after the last round → fix-stopped, "Completed with failures"', () => {
    const f = new LFlow({ rounds: 2 }).toRound1()
    f.fixDone('tree-r1').verify2('fail').recheck('F1 resolved')
    f.nextRound('tree-r1')
    f.fixDone('tree-r2').verify2('fail')
    expect(f.state.outcome).toBe('fix-stopped')
    expect(f.state.status).toBe('completed')
    expect(f.state.fixLoop?.stop).toEqual({ reason: 'cap', text: FIX_STOP_TEXT.cap(2, 2) })
    expect(f.state.notes.at(-1)).toBe(`Completed with failures: ${FIX_STOP_TEXT.cap(2, 2)} test still fails.`)
    expect(toRunSummary(f.state).fixLoop).toEqual({ rounds: 2, max: 2, stop: 'cap' })
    expect(f.log).toContainEqual({ t: 'notify', kind: 'completed' })
  })

  it('no progress: a round that changed nothing stops (and skips its re-check)', () => {
    const f = new LFlow().toRound1()
    f.fixDone('tree-r0').verify2('fail')
    expect(f.step('recheck')).toMatchObject({ status: 'skipped', reason: 'no changes' })
    expect(f.state.outcome).toBe('fix-stopped')
    expect(f.state.fixLoop?.stop).toEqual({ reason: 'no-progress', text: FIX_STOP_TEXT.noChange(1) })
    expect(f.state.fixLoop?.rounds[0]).toMatchObject({ changed: false, open: [1, 3] })
    expect(spawns(f, 'recheck')).toBe(0)
  })

  it('no progress: what is open did not shrink', () => {
    const f = new LFlow().toRound1()
    f.fixDone('tree-r1').verify2('fail').recheck('F1 open: not fixed')
    expect(f.state.outcome).toBe('fix-stopped')
    expect(f.state.fixLoop?.stop).toEqual({ reason: 'no-progress', text: FIX_STOP_TEXT.noShrink(1, 2) })
  })

  it('the cost budget: another round like the last would go past it', () => {
    const f = new LFlow({ maxUsd: 0.6 }).toRound1()
    f.fixDone('tree-r1', { usd: 0.4 }).verify2('fail').recheck('F1 resolved', 0.05)
    expect(f.state.outcome).toBe('fix-stopped')
    expect(f.state.fixLoop?.stop?.reason).toBe('budget')
    expect(f.state.fixLoop?.stop?.text).toContain('$0.60 per run')
    expect(f.state.fixLoop?.rounds[0]?.usd).toBeCloseTo(0.45, 6)
  })

  it('a budget that still has room lets the next round run', () => {
    const f = new LFlow({ maxUsd: 5 }).toRound1()
    f.fixDone('tree-r1', { usd: 0.4 }).verify2('fail').recheck('F1 resolved', 0.05)
    expect(f.state.outcome).toBeUndefined()
    expect(f.state.fixLoop?.postRound).toBe('requested')
  })

  it('the time budget: working time so far plus the last round would pass it', () => {
    const f = new LFlow({ maxMinutes: 1 }).toRound1()
    f.fixDone('tree-r1', { ms: 40_000 }).verify2('fail').recheck('F1 resolved')
    expect(f.state.fixLoop?.stop?.reason).toBe('budget')
    expect(f.state.fixLoop?.stop?.text).toContain('1 min of working time per run')
  })

  it('a re-check that names none of its findings leaves them open (unclear); round 2 gets them again', () => {
    const f = new LFlow({ rounds: 2 }).toRound1([must('r1'), must('r2')])
    f.fixDone('tree-r1').verify2('pass').recheck('Looks good to me.')
    expect(f.state.security?.recheck?.status).toBe('unclear')
    expect(f.state.fixLoop?.rounds[0]).toMatchObject({ open: [1, 2], resolved: [], failing: [], count: 2 })
    // Verify went green (3 open before: r1, r2 and the failing test), so the round made progress.
    expect(f.state.outcome).toBeUndefined()
    f.nextRound('tree-r1')
    expect(f.state.fixLoop?.targets).toEqual([1, 2])
    f.fixDone('tree-r2').verify2('pass').recheck('F1 resolved\nF2 open: still there')
    expect(f.state.outcome).toBe('fix-stopped')
    expect(f.state.fixLoop?.stop?.reason).toBe('cap')
    expect(f.state.notes.at(-1)).toContain('F2 still open')
  })

  it('without the re-check (turned off), verify alone decides', () => {
    const f = new LFlow({ recheck: false }).toRound1()
    expect(f.step('recheck')).toMatchObject({ status: 'skipped', reason: 'not used' })
    f.fixDone('tree-r1').verify2('pass')
    expect(f.state.outcome).toBe('fixed')
  })
})

describe('Fix until green: Re-run from Fix', () => {
  it("a re-run of a looped run carries its findings and starts its own round 1 against Implement's session", () => {
    const src = new LFlow({ rounds: 2 }).toRound1()
    src.fixDone('tree-r1').verify2('fail').recheck('F1 resolved')
    src.nextRound('tree-r1')
    src.fixDone('tree-r2').verify2('fail')
    expect(src.state.outcome).toBe('fix-stopped')
    const s = initRerunFromFix(src.state, rerunInit(src.state), ['r1', 'v-test-2'])
    expect(s.fixLoop).toBeUndefined()
    expect(s.config.fixLoop).toEqual({ rounds: 2, recheck: true })
    // The list is the source's (no duplicate verify rows from its rounds); Fix gets the chosen ones.
    expect(s.findings?.list.map((x) => x.n)).toEqual([1, 2, 3])
    expect(s.findings?.selected).toEqual(['r1', 'v-test-2'])
    // Its Fix decides against the carried Implement session, as any Re-run from Fix does.
    const h = new LFlow({ rounds: 2 })
    h.state = s
    h.now = src.now + 60_000
    h.create()
    h.lock()
    h.preflight(okReport())
    h.reconcile('pre-fix')
    h.snapshot('fix-start', 'tree-r2')
    h.passPreflight('fix')
    const spawn = h.fx('spawn')[0]
    expect(spawn).toMatchObject({ step: 'fix', attempt: 1 })
    expect(spawn?.launch.session).toEqual({ reuse: true, sessionId: 'impl-session' })
    expect(h.state.fixLoop).toMatchObject({ round: 1, before: 2 })
  })
})

describe('Fix until green: around the rounds', () => {
  it('Stop during round 2 leaves the round stopped in the view, the run cancelled', () => {
    const f = new LFlow().toRound1()
    f.fixDone('tree-r1').verify2('fail').recheck('F1 resolved')
    f.nextRound('tree-r1')
    f.user({ kind: 'stop' })
    expect(f.state.status).toBe('cancelled')
    expect(toRunSnapshot(f.state, 0).fixLoop?.rounds.map((r) => r.status)).toEqual(['done', 'stopped'])
  })

  it('a relaunch during the post-round snapshot asks for it again and holds the next round for Resume', () => {
    const f = new LFlow().toRound1()
    f.fixDone('tree-r1').verify2('fail').recheck('F1 resolved')
    f.send({ t: 'relaunch' })
    expect(f.state.flow.hold).toBe('interrupted')
    f.snapshot('post-round', 'tree-r1')
    expect(f.step('fix')).toMatchObject({ status: 'paused', pause: 'interrupted', attempt: 2 })
    // Resume redoes R10 for the round (it has not spawned yet): reconcile, start snapshot, session decision.
    f.user({ kind: 'resume' })
    expect(f.findReq((r) => r.kind === 'reconcile' && r.boundary === 'pre-fix')).toBeDefined()
    f.reconcile('pre-fix')
    f.snapshot('fix-start', 'tree-r1')
    f.passPreflight('fix')
    expect(f.fx('spawn')).toEqual([expect.objectContaining({ step: 'fix', attempt: 2 })])
  })

  it('a single Fix (rounds 1) behaves as before: no loop state, outcome from verify', () => {
    const f = new LFlow({ rounds: 1 }).toRound1()
    expect(f.state.fixLoop).toBeUndefined()
    f.fixDone('tree-r1').verify2('fail')
    expect(f.state.outcome).toBe('verify-failed')
    expect(toRunSummary(f.state).fixLoop).toBeUndefined()
  })

  it('with the security advisor, the loop re-check runs on the Security pass config and checks every [must]', () => {
    const f = new LFlow({ security: true })
    f.toVerified(result('test', 'fail'), [verifyMust('test')])
    // The security advisor: its scan (nothing found), then Review ∥ Security.
    const scanCheck = f.req((r) => r.kind === 'scan-check', 'scan-check')
    f.send({ t: 'scan-check-result', req: scanCheck, audits: [], notes: [] })
    const scan = f.req((r) => r.kind === 'scan', 'scan')
    f.send({
      t: 'scan-result',
      req: scan,
      secrets: [],
      audits: [],
      advisories: [],
      existing: 0,
      notes: [],
      findings: [],
    })
    f.reconcile('pre-review')
    f.passPreflight('review')
    f.passPreflight('security')
    f.report('review', 'ok', [must('r1')])
    f.report('security', 'none')
    f.snapshot('post-review', 'tree-changed')
    f.toFixSpawned('tree-r0')
    f.fixDone('tree-r1').verify2('pass')
    f.agentPreflight('recheck')
    expect(f.fx('spawn')).toEqual([expect.objectContaining({ step: 'recheck', model: 'haiku' })])
    expect(f.state.security?.recheck?.checks).toEqual([1])
    expect(f.state.phase).toBe('security-recheck')
  })
})
