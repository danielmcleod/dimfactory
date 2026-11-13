// Soak (user profiles): a run started with a profile the user's
// dimfactory.json defines passes its own preflight. The run's authoritative preflight (the controller's `preflight`
// step) used to check the profile name against the built-in names only, so every run of a user or project profile
// stopped at a "Unknown profile" card that Re-check could never clear (the soak's Gemini profile found it).
import { afterEach, describe, expect, it } from 'vitest'
import { codexHangs } from '../../unit/balanced/engine/helpers.ts'
import { ScriptedCodex, World, settled, value } from '../balanced/engine/helpers.ts'

const w = new World()
afterEach(() => w.dispose())

/** claude-only under another name, as a user would save it from Settings → Profiles. */
const MINE = {
  plan: { vendor: 'claude', model: 'opus' },
  implement: { vendor: 'claude', model: null },
  review: { vendor: 'claude', model: 'sonnet' },
  critic: { vendor: 'claude', model: 'opus' },
  fix: { inherit: 'implement', reuseSession: true },
}

describe('a run of a user-defined profile (soak)', () => {
  it('passes its preflight and completes', async () => {
    const t = await w.boot(
      {
        plan: [{ recording: 'C06-plan-native-host' }],
        implement: [
          { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: 'x\n' } },
        ],
      },
      new ScriptedCodex(codexHangs),
      { user: { profiles: { mine: MINE } } },
    )
    const run = await w.start(t, { profile: 'mine', gates: { afterPlan: false } })
    const s = await run.c.waitFor(
      (st) => settled(st) || st.cards.some((c) => c.view.kind === 'preflight'),
      120_000,
    )
    const snap = value(await t.core.invoke('runs.get', { runId: run.runId }))
    expect(snap.cards.filter((c) => c.kind === 'preflight').map((c) => c.title)).toEqual([])
    expect(s.status).toBe('completed')
    expect(snap.summary.profile).toBe('mine')
    expect(snap.steps.preflight.status).toBe('done')
    expect(snap.steps.implement.status).toBe('done')
  }, 180_000)
})
