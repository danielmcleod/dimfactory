// Boot recovery at the run-level boundaries ("Crash relaunch … Never auto-resume"): a run that
// died with S1, the pre-review reconcile or the post-review snapshot outstanding has that git work re-issued, but
// the pass it leads to is paused(interrupted) and reported, never spawned, until the user resumes.
import { describe, expect, it } from 'vitest'
import type { AgentStep } from '@shared/run.ts'
import { silentLogger } from '@core/log.ts'
import type { RunController, RunDoc } from '@core/supervisor/controller.ts'
import { reduce } from '@core/supervisor/machine.ts'
import { recoverRuns } from '@core/supervisor/recovery.ts'
import type { EngineEventBody, RunState } from '@core/supervisor/types.ts'
import { Flow, must } from './helpers.review.ts'

/**
 * A controller stand-in around the real reducer. `settle` answers whatever git and preflight work is outstanding
 * (snapshots, reconciles, pass-boundary preflights), as the real effects would, and records every spawn.
 */
function controllerFor(doc: RunDoc): { c: RunController; spawned: AgentStep[]; state: () => RunState } {
  let state = doc.state
  let at = 3_000_000
  const spawned: AgentStep[] = []
  const send = (body: EngineEventBody): void => {
    at += 1
    const r = reduce(state, { ...body, at })
    state = r.state
    for (const e of r.effects) if (e.t === 'spawn') spawned.push(e.step)
  }
  const settle = (): Promise<void> => {
    for (let guard = 0; guard < 20; guard++) {
      const next = Object.entries(state.requests)[0]
      if (next === undefined) break
      const [req, r] = next
      if (r.kind === 'snapshot')
        send({ t: 'snapshot-done', req, commit: `c-${r.label}`, tree: 'tree-changed' })
      else if (r.kind === 'reconcile') send({ t: 'reconcile-result', req, result: { verdict: 'clean' } })
      else if (r.kind === 'preflight')
        send({
          t: 'preflight-result',
          req,
          report: { mode: r.mode, ok: true, blocking: [], warnings: [], info: [] },
        })
      else break
    }
    return Promise.resolve()
  }
  const c = {
    get state() {
      return state
    },
    enqueue: (body: EngineEventBody) => {
      send(body)
      return Promise.resolve([])
    },
    settle,
  }
  return { c: c as unknown as RunController, spawned, state: () => state }
}

async function recover(f: Flow): Promise<{
  report: Awaited<ReturnType<typeof recoverRuns>>
  spawned: AgentStep[]
  state: () => RunState
}> {
  const doc: RunDoc = {
    runId: f.state.runId,
    state: structuredClone(f.state),
    lastSeq: 99,
    scope: { folder: 'f', scopeRoot: 'f', lockKey: 'f', folderKey: 'k', isRepo: false },
    createdBy: 'cli',
  }
  let ctl: ReturnType<typeof controllerFor> | undefined
  const report = await recoverRuns({
    candidates: () => Promise.resolve([doc.runId]),
    readDoc: () => Promise.resolve(doc),
    readLog: () => Promise.resolve({ envelopes: [], lastSeq: 99 }),
    attach: (_id, d) => {
      ctl = controllerFor(d)
      return Promise.resolve(ctl.c)
    },
    restoreHolder: () => undefined,
    log: silentLogger,
  })
  if (ctl === undefined) throw new Error('the run was not relaunched')
  return { report, spawned: ctl.spawned, state: ctl.state }
}

describe('recoverRuns at the review sequence boundaries', () => {
  it('S1 outstanding: S1 and reconcile(pre-review) run again; Review ∥ Critic are paused and reported', async () => {
    const r = await recover(new Flow().toImplementDone())
    expect(r.spawned).toEqual([])
    expect(r.state()).toMatchObject({ status: 'paused', phase: 'needs-attention' })
    expect(r.report.paused).toEqual([
      expect.objectContaining({ steps: expect.arrayContaining(['review', 'critic']) as unknown }),
    ])
  })

  it('reconcile(pre-review) outstanding: nothing spawns; the run reads paused (resume has work to do)', async () => {
    const r = await recover(new Flow().toS1())
    expect(r.spawned).toEqual([])
    expect(r.state().steps.review).toMatchObject({ status: 'paused', pause: 'interrupted' })
    expect(r.report.paused[0]?.steps).toEqual(expect.arrayContaining(['review', 'critic']))
  })

  it('post-review snapshot outstanding with findings (no gate): Fix is paused, not spawned', async () => {
    const f = new Flow({ beforeFix: false }).toReviewRunning()
    f.report('review', 'ok', [must('r1')])
    f.report('critic', 'none')
    const r = await recover(f)
    expect(r.spawned).toEqual([])
    expect(r.state().steps.fix).toMatchObject({ status: 'paused', pause: 'interrupted' })
    expect(r.report.paused[0]?.steps).toEqual(['fix'])
  })
})
