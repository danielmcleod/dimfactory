// Timers after a sleep that never woke (state-machine rows P7, P10, P12): a run whose run.json still
// says the machine sleeps (Dim Factory ended during a suspend, say the battery ran out in S3) comes back awake on the
// next core. Waiting at the plan gate, it is not relaunched. Once the gate is approved there, Implement gets its
// stall and hard timers, its ask gets a timeout, and that timeout pauses the step (P10). With the stale mark kept,
// none of these timers were armed.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { homePaths } from '../../../src/core/home.ts'
import { timerId } from '../../../src/core/supervisor/timers.ts'
import { hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import { implementAsk, teardown, track } from './helpers.ts'

const cores: Core[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  await teardown()
})

async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('a sleep recorded by an earlier process', () => {
  it('is dropped when the run loads: the gate-waiting run gets working timers again', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04d-ask-cancel' }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    track(home)
    track(sc.dir)
    track(folder)
    const env = hermeticEnv({ DIM_FACTORY_E2E: '1' })

    // ---- the first process: at the plan gate when the machine goes to sleep, and never sees the resume ----
    const first = await createCore({ home, host: { kind: 'app' }, env })
    cores.push(first)
    const r = await first.invoke('runs.start', { folder, task: 'add a --version flag' })
    if (!r.ok) throw new Error(r.error.message)
    const runId = r.value.runId
    await until(
      () => first.controller(runId)?.state.cards.some((c) => c.view.kind === 'gate:afterPlan') === true,
    )
    await first.power('suspend')
    expect(first.controller(runId)?.state.suspendedAt).toBeDefined()
    await first.shutdown()
    cores.splice(cores.indexOf(first), 1)
    const onDisk = JSON.parse(readFileSync(homePaths(home).run(runId).runJson, 'utf8')) as {
      state: { suspendedAt?: number }
    }
    expect(onDisk.state.suspendedAt).toBeDefined()

    // ---- the next process: the run is not relaunched (nothing was live), only its lock is restored ----
    const second = await createCore({ home, host: { kind: 'app' }, env })
    cores.push(second)
    expect(second.recovery.holders).toContain(runId)
    expect(second.recovery.paused).toEqual([])
    const snap = await second.invoke('runs.get', { runId })
    if (!snap.ok) throw new Error(snap.error.message)
    const gate = snap.value.cards.find((c) => c.kind === 'gate:afterPlan')
    if (gate?.defaultChoice === undefined) throw new Error('no plan gate')
    const approved = await second.invoke('cards.resolve', {
      runId,
      cardId: gate.id,
      choiceId: gate.defaultChoice,
    })
    if (!approved.ok) throw new Error(approved.error.message)
    const c = second.controller(runId)
    if (c === undefined) throw new Error('no controller')
    expect(c.state.suspendedAt).toBeUndefined()

    // ---- Implement runs with its inactivity timers armed (P1), and its ask with a timeout (P7) ----
    const running = await c.waitFor(
      (s) => s.steps.implement.status === 'running' && s.steps.implement.proc?.live === true,
      60_000,
    )
    expect(running.timers[timerId.stall('implement')]).toBeDefined()
    expect(running.timers[timerId.hard('implement')]).toBeDefined()
    const { requestId, expiresAt } = await implementAsk(c)
    expect(c.state.timers[timerId.ask('implement', requestId)]).toBe(expiresAt)

    // ---- nobody answers: the timeout pauses the step (P10) ----
    const moved = await second.advanceClock(c.state.config.timeouts.askMs + 1_000)
    expect(moved.ok).toBe(true)
    expect(c.state.steps.implement.status).toBe('paused')
    expect(c.state.steps.implement.pause).toBe('ask-timeout')
    await c.waitFor((s) => s.steps.implement.proc?.live !== true, 60_000)
  }, 180_000)
})
