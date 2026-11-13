// Crash recovery when run.json is behind events.jsonl (a kill -9 between the log write and the run.json write):
// projectFromLog must rebuild the reducer state the bodies imply so the relaunched run can continue, and
// needsRelaunch must sweep any process run.json recorded alive. Every case replays the real reducer.
import { describe, expect, it } from 'vitest'
import type { RunEnvelope } from '@shared/run.ts'
import { deriveStatus } from '@core/supervisor/derive.ts'
import type { RunController, RunDoc } from '@core/supervisor/controller.ts'
import { isFinishedState, needsRelaunch, projectFromLog, recoverRuns } from '@core/supervisor/recovery.ts'
import { silentLogger } from '@core/log.ts'
import type { Effect, RunState } from '@core/supervisor/types.ts'
import { Harness, PLAN_TEXT, blockedReport } from './helpers.ts'

/** The bodies a reduction appended to events.jsonl (what survives when run.json did not). */
function logged(effects: readonly Effect[], runId: string, from = 100, ts = 2_000_000): RunEnvelope[] {
  return effects
    .filter((e): e is Extract<Effect, { t: 'emit' }> => e.t === 'emit')
    .map((e, i) => ({ runId, seq: from + i, ts, body: e.body }))
}

/** Run `act` on the harness; return run.json as it was before (the last forced write) and the log since. */
function crashAfter(h: Harness, act: () => void): { runJson: RunState; log: RunEnvelope[] } {
  const runJson = structuredClone(h.state)
  const log: RunEnvelope[] = []
  const before = h.log.length
  act()
  log.push(...logged(h.log.slice(before), h.state.runId))
  return { runJson, log }
}

describe('projectFromLog + relaunch', () => {
  it('a passed preflight lost from run.json: in place ⇒ prepared, so Implement still starts after the gate', () => {
    const h = new Harness()
    h.create()
    h.lock()
    const { runJson, log } = crashAfter(h, () => h.preflight())
    const s = projectFromLog(runJson, log)
    expect(s.steps.preflight.status).toBe('done')
    expect(s.flow.prepared).toBe('all')
    expect(needsRelaunch(s)).toBe(true)
    h.state = s
    h.send({ t: 'relaunch' })
    expect(h.step('plan')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    // run-start was never requested as far as run.json knows: the next advance takes it.
    expect(h.fx('snapshot').map((x) => x.label)).toContain('run-start')
    h.user({ kind: 'resume' })
    h.passPreflight('plan')
    // R2: the resumed Plan spawns once run-start has answered.
    expect(h.fx('spawn')).toHaveLength(0)
    h.snapshot('run-start', 'tree-base')
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'plan' })])
    h.ev('plan', { type: 'done', result: PLAN_TEXT })
    h.exit('plan')
    h.approve()
    expect(h.step('implement').status).toBe('running')
    expect(h.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-implement' })])
  })

  it('Implement’s done lost from run.json: its process is swept and S1 is taken again, so the run completes', () => {
    const h = new Harness().toImplementRunning()
    const { runJson, log } = crashAfter(h, () =>
      h.ev('implement', { type: 'done', result: 'ok', usage: { input: 1, output: 1 } }),
    )
    const s = projectFromLog(runJson, log)
    expect(s.steps.implement).toMatchObject({ status: 'done', endSnapStatus: 'requested' })
    expect(s.steps.implement.proc?.live).toBe(true)
    expect(needsRelaunch(s)).toBe(true)
    h.state = s
    h.send({ t: 'relaunch' })
    expect(h.fx('sweep')).toHaveLength(1)
    expect(h.fx('snapshot').map((x) => x.label)).toEqual(['S1', 'interrupted'])
    h.snapshot('S1', 'tree-new')
    expect(h.state).toMatchObject({ status: 'completed', outcome: 'clean' })
  })

  it('a completion lost from run.json (written while S1 was pending) projects to a finished run', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', { type: 'done', result: 'ok' })
    h.reconcile('end-of-pass')
    expect(h.state.boundary).toBeDefined()
    const { runJson, log } = crashAfter(h, () => h.snapshot('S1', 'tree-new'))
    const s = projectFromLog(runJson, log)
    expect(s.boundary).toBeUndefined()
    expect(s.outcome).toBe('clean')
    expect(isFinishedState(s)).toBe(true)
  })

  it('needsRelaunch sweeps a process recorded alive even when its step is terminal', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', { type: 'done', result: 'ok' })
    h.reconcile('end-of-pass')
    h.snapshot('S1', 'tree-new')
    expect(h.state.status).toBe('completed')
    expect(h.step('implement').proc?.live).toBe(true)
    expect(needsRelaunch(h.state)).toBe(true)
  })

  it('an approved (edited) plan lost from run.json: decided, with the text and original from disk', () => {
    const h = new Harness().toPlanGate()
    const edited = `${PLAN_TEXT}\n2. Add a test`
    const { runJson, log } = crashAfter(h, () => h.approve(edited))
    const s = projectFromLog(runJson, log, { planText: edited, planOriginal: PLAN_TEXT })
    expect(s.cards).toEqual([])
    expect(s.plan).toMatchObject({ decided: true, edited: true, text: edited, original: PLAN_TEXT })
    // Without the gate (Auto): decided as soon as the plan is done.
    const a = new Harness()
    a.state.config.auto = true
    a.state.config.gates.afterPlan = false
    a.toPlanRunning()
    const lost = crashAfter(a, () => a.ev('plan', { type: 'done', result: PLAN_TEXT }))
    const p = projectFromLog(lost.runJson, lost.log, { planText: PLAN_TEXT })
    expect(p.plan).toMatchObject({ decided: true, text: PLAN_TEXT })
    // Proceed without a plan / insufficient context.
    const i = new Harness().toPlanRunning()
    const ins = crashAfter(i, () =>
      i.ev('plan', { type: 'done', result: 'INSUFFICIENT_CONTEXT: which file?' }),
    )
    const q = projectFromLog(ins.runJson, ins.log, { planText: 'INSUFFICIENT_CONTEXT: which file?' })
    expect(q.plan).toMatchObject({ decided: false, text: null })
  })

  it('a Stop lost from run.json: cancelled, and the relaunch takes the stopped snapshot before unlocking', () => {
    const h = new Harness().toPlanGate()
    const { runJson, log } = crashAfter(h, () => h.user({ kind: 'stop' }))
    const s = projectFromLog(runJson, log)
    expect(s.stop).toMatchObject({ by: 'stop', snapshot: 'todo' })
    expect(deriveStatus(s)).toBe('cancelled')
    expect(needsRelaunch(s)).toBe(true)
    h.state = s
    h.send({ t: 'relaunch' })
    expect(h.fx('snapshot').map((x) => x.label)).toEqual(['stopped'])
    h.snapshot('stopped')
    expect(h.fx('unlock')).toHaveLength(1)
  })

  it('R2b lost from run.json: the folder lock is not restored while preflight is failed', () => {
    const h = new Harness()
    h.create()
    h.lock()
    const { runJson, log } = crashAfter(h, () => h.preflight(blockedReport({ category: 'git_missing' })))
    expect(runJson.lock).toBe('held')
    const s = projectFromLog(runJson, log)
    expect(s.lock).toBe('none')
    expect(s.steps.preflight.status).toBe('failed')
    // Recheck lost too: queued for the lock again (re-queued by the relaunch).
    h.state = s
    const card = h.state.cards[0]?.view.id ?? ''
    const recheck = crashAfter(h, () => h.user({ kind: 'card', cardId: card, choiceId: 'recheck' }))
    const q = projectFromLog(s, recheck.log)
    expect(q.lock).toBe('requested')
    expect(q.steps.preflight.status).toBe('queued')
  })

  it('an ask lost from run.json is resolved by the relaunch', () => {
    const h = new Harness().toImplementRunning()
    const { runJson, log } = crashAfter(h, () => h.ask('implement', 'q1'))
    const s = projectFromLog(runJson, log)
    expect(s.steps.implement.asks.map((a) => a.requestId)).toEqual(['q1'])
    h.state = s
    h.send({ t: 'relaunch' })
    expect(h.bodies('ask-resolved')).toEqual([expect.objectContaining({ requestId: 'q1', by: 'stop' })])
  })
})

describe('recoverRuns', () => {
  it('reads plan.md for a projected plan output and relaunches the run with it', async () => {
    const h = new Harness().toPlanGate()
    const edited = `${PLAN_TEXT}\n2. Add a test`
    const { runJson, log } = crashAfter(h, () => h.approve(edited))
    const doc: RunDoc = {
      runId: h.state.runId,
      state: runJson,
      lastSeq: 99,
      scope: { folder: 'f', scopeRoot: 'f', lockKey: 'f', folderKey: 'k', isRepo: false },
      createdBy: 'cli',
    }
    const reads: string[] = []
    let attached: RunDoc | undefined
    const report = await recoverRuns({
      candidates: () => Promise.resolve([doc.runId]),
      readDoc: () => Promise.resolve(doc),
      readLog: () => Promise.resolve({ envelopes: log, lastSeq: 100 + log.length }),
      readText: (_id, file) => {
        reads.push(file)
        return Promise.resolve(file === 'plan' ? edited : PLAN_TEXT)
      },
      attach: (_id, d) => {
        attached = d
        const c = { state: d.state, enqueue: () => Promise.resolve([]), settle: () => Promise.resolve() }
        return Promise.resolve(c as unknown as RunController)
      },
      restoreHolder: () => undefined,
      log: silentLogger,
    })
    expect(report.projected).toEqual([doc.runId])
    expect(reads.sort()).toEqual(['plan', 'plan.original'])
    // Implement's launch had started (R5): live work → relaunched with the edited plan.
    expect(attached?.state.plan).toMatchObject({ decided: true, text: edited })
    expect(attached?.lastSeq).toBe(100 + log.length)
  })
})
