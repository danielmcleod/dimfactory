// Auto runs ("auto sets Implement and Fix to full and turns the gates off", R4/R8 "∧ ¬auto", the Auto badges,
// auto.spec.ts): an Auto run started from runs.start completes without any gate card, its summary and the host's
// notification facts carry auto:true, and Implement runs in full mode (`bypassPermissions`).
import { afterEach, describe, expect, it } from 'vitest'
import { passArgvs } from '../run/scenario.ts'
import { bodies, settled, start, teardown, versionWrite } from './helpers.ts'

afterEach(teardown)

describe('Auto run (core + fake Claude)', () => {
  it('no gate card, full-mode Implement, summary auto:true', async () => {
    const t = await start(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
      },
      // Gates stay on in the request: Auto turns them off.
      { overrides: { auto: true, gates: { afterPlan: true, beforeFix: true } }, fullMode: true },
    )
    expect(t.c.state.config.auto).toBe(true)
    expect(t.c.state.config.gates).toEqual({ afterPlan: false, beforeFix: false })
    expect(t.c.state.config.passes.implement.mode).toBe('full')
    expect(t.c.state.config.passes.fix.mode).toBe('full')

    const end = await t.c.waitFor(settled, 150_000)
    expect(end.status).toBe('completed')
    expect(end.outcome).toBe('clean')
    expect(end.steps.implement.mode).toBe('full')
    const own = t.events.filter((e) => e.runId === t.runId)
    expect(bodies(own, 'card')).toEqual([])
    expect(t.notes.filter((n) => n.kind === 'gate' || n.kind === 'card')).toEqual([])

    const summary = t.core.summary(t.runId)
    expect(summary?.auto).toBe(true)
    const listed = await t.core.invoke('runs.list', {})
    expect(listed.ok && listed.value.items.find((s) => s.runId === t.runId)?.auto).toBe(true)
    const done = t.notes.find((n) => n.kind === 'completed')
    expect(done?.run?.auto).toBe(true)
    expect(done?.completed?.outcome).toBe('clean')

    const implement = passArgvs(t.sc.entries()).find((a) => a.some((x) => x.startsWith('--session-id=')))
    expect(implement).toContain('bypassPermissions')
    expect(implement).not.toContain('acceptEdits')
  }, 200_000)
})
