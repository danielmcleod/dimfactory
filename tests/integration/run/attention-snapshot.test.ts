// Core.attention() (src/core/app-core.ts; the `attention` AppEvent): the aggregate the `attention`
// event carries, readable at any time. The event is sent on change only, so a host that attaches late (main attaches
// after createCore ran recovery) or a renderer that reloads starts from this.
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { GlobalEvent } from '../../../src/core/bus/bus.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from './scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('core.attention()', () => {
  it('equals the attention event at every point, also for a host that attached after the change', async () => {
    const sc = await makeScenario({ plan: { recording: 'C06-plan-native-host' } })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)

    const first = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(first)
    expect(first.attention()).toEqual({ needsYou: 0, items: [] })
    const events: Extract<GlobalEvent, { kind: 'attention' }>[] = []
    first.bus.attach({ name: 't', global: (ev) => void (ev.kind === 'attention' && events.push(ev)) })

    // Defaults: the gate after Plan is on, so the run waits for the plan's review.
    const r = await first.invoke('runs.start', { folder, task: 'add a --version flag' })
    if (!r.ok) throw new Error(r.error.message)
    const runId = r.value.runId
    await until(
      () => first.controller(runId)?.state.cards.some((c) => c.view.kind === 'gate:afterPlan') === true,
    )
    await until(() => events.at(-1)?.needsYou === 1)

    const now = first.attention()
    expect(now.needsYou).toBe(1)
    expect(now.items).toEqual([expect.objectContaining({ runId, kind: 'card', cardKind: 'gate:afterPlan' })])
    expect(events.at(-1)).toEqual({ kind: 'attention', needsYou: now.needsYou, items: now.items })

    // A host attaching now (main attaches after createCore; a reloaded renderer) hears nothing until something
    // changes; core.attention() has the state meanwhile.
    const late: unknown[] = []
    first.bus.attach({ name: 'late', global: (ev) => void (ev.kind === 'attention' && late.push(ev)) })
    await new Promise((r) => setTimeout(r, 300))
    expect(late).toEqual([])
    expect(first.attention()).toEqual(now)

    // Cancelling at the gate clears it: the event and the snapshot agree again.
    const card = first.controller(runId)?.state.cards.find((c) => c.view.kind === 'gate:afterPlan')
    if (card === undefined) throw new Error('no gate card')
    const resolved = await first.invoke('cards.resolve', { runId, cardId: card.view.id, choiceId: 'cancel' })
    if (!resolved.ok) throw new Error(resolved.error.message)
    await until(() => events.at(-1)?.needsYou === 0)
    expect(first.attention()).toEqual({ needsYou: 0, items: [] })
    expect(late.at(-1)).toEqual({ kind: 'attention', needsYou: 0, items: [] })
  })
})
