// Quit while a run's end is still being handled: the queue's after-run work (the project memory note, which reads the
// folder's repository with git) is queued when the run's summary is published. core.shutdown() waits for it, so no git
// is left running in the user's folder once the quit returns (on Windows its working directory keeps the folder from
// being deleted: a test's cleanup, or the user, met EPERM) and nothing it writes lands after the index closed.
import { afterEach, describe, expect, it } from 'vitest'
import { makeSummary } from '../../renderer/helpers/fixtures.ts'
import { World, tasksSpec, version } from './helpers.ts'

const world = new World()
afterEach(async () => world.dispose())

describe('core shutdown and the queue', () => {
  it("waits for a run end's queued work before it returns", async () => {
    const w = await world.setup(tasksSpec([version('1.0.0')]))
    const { core } = await world.boot(w)
    const factory = core.factory
    if (factory === undefined) throw new Error('no factory')
    // A run in the folder has just completed (as the index publishes it); its after-run work is queued now.
    core.bus.global({
      kind: 'run-summary',
      summary: makeSummary({
        runId: '20261027T000000Z-ab12',
        folder: w.folder,
        status: 'completed',
        phase: 'done',
        outcome: 'clean',
        endedAt: Date.now(),
      }),
    })
    let drained = false
    void factory.settled().then(() => {
      drained = true
    })
    await world.stop(core)
    expect(drained).toBe(true)
  }, 60_000)
})
