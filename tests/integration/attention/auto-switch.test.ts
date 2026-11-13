// Switching a running run to Auto (runs.switchToAuto) with the real controller and the fake Claude: the ask waiting
// on the user is approved by Auto, so is every later ask of the same Implement process (launched before the switch,
// so still in its earlier mode), the run finishes without another question, and the run's config, its recorded
// patch and its summary say Auto. A second switch is refused.
import { afterEach, describe, expect, it } from 'vitest'
import { bodies, implementAsk, settled, start, teardown, versionWrite } from './helpers.ts'

afterEach(teardown)

describe('Switch to Auto (core + fake Claude)', () => {
  it('approves the waiting ask and the later ones, records the patch, and the run ends in Auto', async () => {
    const t = await start(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C04a-ask-allow', write: versionWrite }],
      },
      { overrides: { gates: { afterPlan: false, beforeFix: true } } },
    )
    expect(t.c.state.config.auto).toBe(false)
    const { requestId } = await implementAsk(t.c)
    expect(t.c.state.steps.implement.mode).toBe('autoedit')

    const r = await t.core.invoke('runs.switchToAuto', { runId: t.runId })
    expect(r).toEqual({ ok: true, value: undefined })
    expect(t.c.state.config.auto).toBe(true)
    expect(t.c.state.config.gates).toEqual({ afterPlan: false, beforeFix: false })
    expect(t.c.state.config.passes.implement.mode).toBe('full')
    expect(t.c.state.configPatches).toEqual([
      expect.objectContaining({ label: 'Switch to Auto', source: 'auto' }),
    ])
    expect(bodies(t.events, 'ask-resolved')).toContainEqual(
      expect.objectContaining({ requestId, by: 'auto', decision: 'allow' }),
    )

    const again = await t.core.invoke('runs.switchToAuto', { runId: t.runId })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('CONFLICT')

    const end = await t.c.waitFor(settled, 150_000)
    expect(end.status).toBe('completed')
    // No ask of this run was left for the user after the switch.
    const own = t.events.filter((e) => e.runId === t.runId)
    const resolved = bodies(own, 'ask-resolved')
    expect(resolved.filter((b) => b.by === 'user')).toEqual([])
    expect(end.steps.implement.autoAnswered?.approved ?? 0).toBeGreaterThanOrEqual(1)
    expect(t.core.summary(t.runId)?.auto).toBe(true)
  }, 200_000)
})
