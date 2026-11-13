// recovery.execute on a run's snag with the real core and the fake Claude (recovery actions, the executors, "a
// runtime failure scoped to a vendor"): Plan fails logged out (the recorded C09b) → the snag's
// login command is copied (never run) → the vendor's probe is stale, so the next authoritative preflight probes it
// again → Retry (recovery.execute{plan:retry}) re-runs Plan through runs.retryPass → the snag is resolved, so its
// actions are stale (NOT_FOUND) → Close run works through the same command path on a new snag.
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { RecoveryAction } from '../../../src/shared/failure.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

describe('recovery.execute on a run', () => {
  it('copy login, Retry through the run commands, then stale; Close run on the next snag', async () => {
    const sc = await makeScenario({
      plan: [{ recording: 'C09b-logged-out' }, { recording: 'C09b-logged-out' }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const snags: Extract<RunEnvelope['body'], { t: 'snag' }>[] = []
    core.bus.attach({ name: 't', run: (e) => void (e.body.t === 'snag' && snags.push(e.body)) })

    const { runId } = value(
      await core.invoke('runs.start', {
        folder,
        task: 'add a --version flag',
        overrides: { profile: 'claude-only' },
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const failedPlan = (s: RunState): boolean => s.steps.plan.status === 'failed' && s.steps.plan.snagOpen
    await c.waitFor(failedPlan, 60_000)
    expect(c.state.failure).toEqual({ step: 'plan', category: 'auth_required' })
    expect(snags).toHaveLength(1)
    const ids = (snags[0]?.actions ?? []).map((a: RecoveryAction) => a.id)
    expect(ids).toEqual(expect.arrayContaining(['plan:login', 'plan:retry', 'run:close']))
    // A vendor-scoped runtime failure: the launch probe is no longer trusted.
    expect(core.preflight.cache.isStale('claude')).toBe(true)

    const copied = value(await core.invoke('recovery.execute', { actionId: 'plan:login', runId }))
    expect(copied).toMatchObject({ kind: 'shell_copy', copied: 'claude auth login' })
    expect(c.state.steps.plan.status).toBe('failed') // copying changes nothing in the run

    const retried = value(await core.invoke('recovery.execute', { actionId: 'plan:retry', runId }))
    expect(retried).toEqual({ kind: 'retry', message: 'Retrying Plan.' })
    // The snag that offered Retry is resolved: its actions are stale now.
    expect(c.state.steps.plan.snagOpen).toBe(false)
    const stale = await core.invoke('recovery.execute', { actionId: 'plan:retry', runId })
    expect(stale).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'This fix is no longer available; re-check.' },
    })

    // The retry fails the same way (second C09b): a new snag, whose Close run closes the run.
    await c.waitFor((s) => failedPlan(s) && s.steps.plan.attempt >= 2, 60_000)
    expect(snags).toHaveLength(2)
    const closed = value(await core.invoke('recovery.execute', { actionId: 'run:close', runId }))
    expect(closed).toEqual({ kind: 'close_run', message: 'Run closed.' })
    const done = await c.waitFor((s) => s.status === 'failed' || s.status === 'cancelled', 30_000)
    expect(done.stop).toBeDefined()
    expect(done.failure).toEqual({ step: 'plan', category: 'auth_required' })
  }, 180_000)
})
