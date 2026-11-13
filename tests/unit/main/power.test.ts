// Sleep / wake routing (src/main/power.ts; "powerMonitor drives the timers", IPC e2e.power): the OS and
// the E2E command take the same path to core.power, in order; a repeated state is dropped; failures never throw.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { PowerRouter, installPowerMonitor } from '../../../src/main/power.ts'
import type { PowerState } from '../../../src/main/power.ts'

function setup(apply?: (s: PowerState) => Promise<void>) {
  const applied: PowerState[] = []
  const logged: string[] = []
  const router = new PowerRouter({
    apply:
      apply ??
      ((s) => {
        applied.push(s)
        return Promise.resolve()
      }),
    log: { info: (m) => logged.push(m), warn: (m) => logged.push(m) },
  })
  return { router, applied, logged }
}

describe('PowerRouter', () => {
  it('forwards suspend then resume from either source', async () => {
    const t = setup()
    expect(await t.router.handle('suspend', 'os')).toBe(true)
    expect(t.router.state).toBe('suspend')
    expect(await t.router.handle('resume', 'e2e')).toBe(true)
    expect(t.applied).toEqual(['suspend', 'resume'])
  })

  it('drops a repeated state (a wake reported twice, a resume without a sleep)', async () => {
    const t = setup()
    expect(await t.router.handle('resume', 'os')).toBe(false)
    await t.router.handle('suspend', 'os')
    expect(await t.router.handle('suspend', 'e2e')).toBe(false)
    expect(t.applied).toEqual(['suspend'])
    expect(t.logged).toContain('power event repeated; ignored')
  })

  it('applies in arrival order even when the core is slow', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const t = setup(async (s) => {
      order.push(`start ${s}`)
      if (s === 'suspend') await gate
      order.push(`end ${s}`)
    })
    const a = t.router.handle('suspend', 'os')
    const b = t.router.handle('resume', 'os')
    await Promise.resolve()
    release()
    await Promise.all([a, b])
    expect(order).toEqual(['start suspend', 'end suspend', 'start resume', 'end resume'])
  })

  it('logs a failing core call and keeps going', async () => {
    const t = setup(() => Promise.reject(new Error('busy')))
    expect(await t.router.handle('suspend', 'os')).toBe(true)
    expect(t.logged).toContain('power event failed')
    expect(await t.router.handle('resume', 'os')).toBe(true)
  })
})

describe('installPowerMonitor', () => {
  it('routes powerMonitor suspend / resume', async () => {
    const t = setup()
    const pm = new EventEmitter()
    installPowerMonitor(pm, t.router)
    pm.emit('suspend')
    pm.emit('resume')
    pm.emit('shutdown')
    await new Promise((r) => setTimeout(r, 0))
    expect(t.applied).toEqual(['suspend', 'resume'])
  })
})
