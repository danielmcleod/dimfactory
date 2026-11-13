// A queued run's published summary names its blocker (the folder-lock scheduler; the Active run card's "Queued ·
// blocked by run #12"): the renderer's cards read `blockedBy` from the `run-summary` events, and
// the scheduler (not the run's own state) decides it. Three runs in one folder, run #1 waiting at its plan gate:
// the last summary pushed for #2 and #3 names #1; once #1 is stopped and #2 holds the folder, #3's latest summary
// names #2, although #3 itself did not change.
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { RunSummary } from '../../../src/shared/run.ts'
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

async function until(what: string, pred: () => boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const PLAN = { recording: 'C06-plan-native-host' }

describe('queued runs publish their blocker', () => {
  it('names the run each queued run waits for, and follows the folder when it changes hands', async () => {
    const sc = await makeScenario({ plan: [PLAN, PLAN, PLAN] })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const pushed = new Map<string, RunSummary>()
    core.bus.attach({
      name: 't',
      global: (ev) => {
        if (ev.kind === 'run-summary') pushed.set(ev.summary.runId, ev.summary)
      },
    })
    const start = async (task: string) =>
      value(await core.invoke('runs.start', { folder, task, overrides: { profile: 'claude-only' } })).runId

    const first = await start('add a --version flag')
    await until('run #1 at its plan gate', () => pushed.get(first)?.status === 'waiting')
    const second = await start('add a --help flag')
    const third = await start('add a --quiet flag')

    await until('#2 and #3 queued behind #1', () =>
      [second, third].every(
        (id) => pushed.get(id)?.status === 'queued' && pushed.get(id)?.blockedBy === first,
      ),
    )
    // runs.get agrees with what was pushed.
    expect(value(await core.invoke('runs.get', { runId: third })).summary.blockedBy).toBe(first)

    // #1 stops: #2 takes the folder (its plan gate), #3 now waits for #2 without changing itself.
    value(await core.invoke('runs.stop', { runId: first }))
    await until('#2 holds the folder', () => pushed.get(second)?.status === 'waiting', 90_000)
    expect(pushed.get(second)?.blockedBy).toBeUndefined()
    await until('#3 names #2', () => pushed.get(third)?.blockedBy === second)
    expect(pushed.get(third)?.status).toBe('queued')

    value(await core.invoke('runs.stop', { runId: third }))
    value(await core.invoke('runs.stop', { runId: second }))
  }, 180_000)
})
