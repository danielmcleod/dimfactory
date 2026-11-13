// Model wording, item 2, through a real core and the fake Claude: a Claude pass that names no model (claude-only's
// Implement) records the model Claude's init names as the model it ran (StepView.modelUsed), so its card names it
// instead of saying Claude did not report it; a pass that names its model (Plan: opus) records nothing more.
import { afterEach, describe, expect, it } from 'vitest'
import { codexHangs } from '../../unit/balanced/engine/helpers.ts'
import { ScriptedCodex, World, settled, value } from '../balanced/engine/helpers.ts'

const w = new World()
afterEach(() => w.dispose())

describe("Claude's init names the model a pass with no model ran (model wording 2)", () => {
  it('claude-only: Implement (no model) records the init model; Plan (opus) records none', async () => {
    const spec = {
      plan: [{ recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: 'x\n' } },
      ],
    }
    const t = await w.boot(spec, new ScriptedCodex(codexHangs))
    const run = await w.start(t, { profile: 'claude-only', gates: { afterPlan: false } })
    const s = await run.c.waitFor(settled, 120_000)
    expect(s.steps.implement.status).toBe('done')
    const snap = value(await t.core.invoke('runs.get', { runId: run.runId }))
    expect(snap.steps.implement).toMatchObject({
      vendor: 'claude',
      model: null,
      modelUsed: 'claude-sonnet-5-5',
    })
    expect(snap.steps.implement.modelReplaced).toBeUndefined()
    expect(snap.steps.plan.model).toBe('opus')
    expect(snap.steps.plan.modelUsed).toBeUndefined()
    // run.json keeps it with the step (the pass is priced at it, as for Codex's word).
    expect(s.steps.implement.modelUsed).toBe('claude-sonnet-5-5')
  }, 180_000)
})
