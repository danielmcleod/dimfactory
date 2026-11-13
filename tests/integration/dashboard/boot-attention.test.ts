// Attention at boot (src/core/app-core.ts `dormant`; attention survives a relaunch): a run left
// waiting at the plan gate by a clean shutdown is still in needs-you after the next launch, without being loaded
// (nothing spawned, no controller), and dashboard.get carries the same attention. Its views keep the ETA frozen at
// run start (estimate.json) and the adapter's mode copy; opening the gate on the new core hands it to a controller.
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { readRunEstimate } from '../../../src/core/estimates/estimate.ts'
import { homePaths } from '../../../src/core/home.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

async function until(pred: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 100))
  }
}

const S = 1000

describe('attention at boot', () => {
  it('a run waiting at the plan gate survives a clean restart in needs-you and on the dashboard', async () => {
    const sc = await makeScenario({ plan: { recording: 'C06-plan-native-host' } })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)

    const first = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(first)
    const r = await first.invoke('runs.start', { folder, task: 'add a --version flag' })
    if (!r.ok) throw new Error(r.error.message)
    const runId = r.value.runId
    // The live ETA is there from the start.
    expect(first.summary(runId)?.progress.etaMs).toBeGreaterThan(0)
    await until(
      () => first.controller(runId)?.state.cards.some((c) => c.view.kind === 'gate:afterPlan') === true,
    )
    const atGate = first.attention()
    expect(atGate.needsYou).toBe(1)

    // The estimate frozen at run start: a fresh home has no history, so the priors. resolved.json stays as it was written.
    const paths = homePaths(home)
    const estimate = await readRunEstimate(paths.run(runId).dir)
    expect(estimate?.total.basis).toBe('typical (no history yet)')
    const resolved = JSON.parse(readFileSync(paths.run(runId).resolvedJson, 'utf8')) as { estimate: unknown }
    expect(resolved.estimate).toBeNull()
    // At the gate the rest of the run remains: Implement + max(Review, Critic) + 0.6 × Fix, user time excluded.
    // Priors at p50 (0.6 × the table): 216 + 54 + 0.6 × 108.
    expect(first.summary(runId)?.progress.etaMs).toBe(334.8 * S)

    await first.shutdown()
    cores.splice(cores.indexOf(first), 1)

    const second = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(second)
    // Not loaded: no controller, nothing spawned for it; still in needs-you.
    expect(second.controller(runId)).toBeUndefined()
    expect(second.recovery.holders).toContain(runId)
    const now = second.attention()
    expect(now.needsYou).toBe(1)
    expect(now.items).toEqual([
      expect.objectContaining({
        id: atGate.items[0]?.id,
        runId,
        kind: 'card',
        cardKind: 'gate:afterPlan',
        blocking: true,
      }),
    ])
    const dash = await second.invoke('dashboard.get')
    if (!dash.ok) throw new Error(dash.error.message)
    expect(dash.value.attention).toEqual(now)
    expect(dash.value.active.map((s) => s.runId)).toEqual([runId])
    expect(dash.value.active[0]?.status).toBe('waiting')

    // Its run view: StepView.eta from estimate.json, the mode copy from the adapter's support().
    const snap = await second.invoke('runs.get', { runId })
    if (!snap.ok) throw new Error(snap.error.message)
    expect(snap.value.steps.plan.eta).toEqual(estimate?.steps.plan?.durationMs)
    // The prior: p80 360 s (the table), p50 0.6 × that.
    expect(snap.value.steps.implement.eta).toEqual({ p50: 216 * S, p80: 360 * S })
    const claude = second.adapters.get('claude')
    const plan = snap.value.steps.plan
    expect(plan.modeCopy).toEqual(
      claude?.support({
        pass: 'plan',
        mode: 'readonly',
        planNative: plan.planMode === 'native',
        trustFolder: false,
      }),
    )
    expect(snap.value.steps.implement.modeCopy).toEqual(
      claude?.support({ pass: 'implement', mode: 'autoedit', planNative: false, trustFolder: false }),
    )
    expect(snap.value.steps.preflight.modeCopy).toBeUndefined()
    expect(existsSync(paths.run(runId).dir)).toBe(true)

    // Opening the gate on the new core loads the run; cancelling there clears needs-you.
    const card = snap.value.cards.find((c) => c.kind === 'gate:afterPlan')
    if (card === undefined) throw new Error('no gate card')
    const resolvedCard = await second.invoke('cards.resolve', { runId, cardId: card.id, choiceId: 'cancel' })
    if (!resolvedCard.ok) throw new Error(resolvedCard.error.message)
    expect(second.controller(runId)).toBeDefined()
    await until(() => second.attention().needsYou === 0)
    const after = await second.invoke('dashboard.get')
    expect(after.ok && after.value.attention).toEqual({ needsYou: 0, items: [] })
  }, 120_000)
})
