// Model routing through a real core and the fake Claude: a routed step (Explain, on the Plan pass's vendor) runs the
// model its profile names for it, while Plan keeps its own; the Config view and the resolved config say where the
// model came from.
import { afterEach, describe, expect, it } from 'vitest'
import { World, tasksSpec, value, version } from './helpers.ts'

const world = new World()
afterEach(async () => {
  await world.dispose()
})

const SUMMARY =
  '## What was built\nA version flag.\n\n## How to run it\n1. Run it.\n\n## What to try next\n- More.\n\n## Known limits\n- None.'

describe('model routing', () => {
  it('Explain runs the model the profile routes it to; Plan keeps its own', async () => {
    const w = await world.setup(
      tasksSpec([version('1.0.0')], { explain: [{ recording: 'C02-review-shape', text: SUMMARY }] }),
      // The user's routing for the claude-only profile: Explain on haiku (Plan is opus there).
      { profiles: { 'claude-only': { routing: { explain: { model: 'haiku' } } } } },
    )
    const { core } = await world.boot(w)
    const resolved = value(await core.invoke('config.resolve', { folder: w.folder }))
    expect(resolved.config.routing).toEqual({ explain: { model: 'haiku' } })
    expect(resolved.provenance['/routing/explain/model']).toMatchObject({
      source: 'user',
      via: 'profile:claude-only',
    })
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: { passes: { plan: { explain: true } } },
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const done = await c.waitFor((s) => s.status === 'completed' || s.status === 'failed', 120_000)
    await c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    expect(done.steps.plan).toMatchObject({ vendor: 'claude', model: 'opus' })
    expect(done.steps.explain).toMatchObject({ status: 'done', vendor: 'claude', model: 'haiku' })
  }, 240_000)
})
