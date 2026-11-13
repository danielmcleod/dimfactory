// AppEvent `probe` (vendor health): every stored probe result is pushed, so the Dashboard's
// vendor rows and the sidebar dots update without the page asking again. Found in a live done-check, where
// the first-launch probe finished but the Dashboard kept saying "Not checked yet".
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { GlobalEvent } from '../../../src/core/bus/bus.ts'
import { cleanup, hermeticEnv, makeHome, makeScenario } from './scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

describe('probe events', () => {
  it('vendors.probe and the first-launch probe both reach bus sinks as {kind:"probe"}', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const events: Extract<GlobalEvent, { kind: 'probe' }>[] = []
    core.bus.attach({ name: 't', global: (ev) => void (ev.kind === 'probe' && events.push(ev)) })

    await core.firstLaunch()
    expect(events.map((e) => e.vendor)).toContain('claude')
    const fromLaunch = events.find((e) => e.vendor === 'claude')
    expect(fromLaunch?.view.health).not.toBe('checking')
    expect(fromLaunch?.view.probe?.vendor).toBe('claude')

    events.length = 0
    const r = await core.invoke('vendors.probe', { vendor: 'claude', force: true })
    if (!r.ok) throw new Error(r.error.message)
    expect(events).toHaveLength(1)
    expect(events[0]?.view).toEqual(r.value[0])
  })
})
