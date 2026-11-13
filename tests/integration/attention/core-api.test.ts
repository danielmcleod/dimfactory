// Core host API edges (the E2E-only e2e.clock, power events): the clock moves only under DIM_FACTORY_E2E=1,
// a bad amount is a VALIDATION error, power events with nothing loaded are no-ops, and answering an ask nobody
// raised is the stale "already answered/expired" CONFLICT.
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { STALE_ASK_MESSAGE, createCore, isStaleAsk } from '../../../src/core/app-core.ts'
import { cleanup, hermeticEnv, makeHome, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

async function boot(env: Record<string, string>): Promise<Core> {
  const sc = await makeScenario({})
  const { home } = await makeHome(sc)
  dirs.push(home, sc.dir)
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv(env) })
  cores.push(core)
  return core
}

describe('core API', () => {
  it('advanceClock is UNSUPPORTED outside E2E; the clock has no advance', async () => {
    const core = await boot({})
    expect(core.clock.advance).toBeUndefined()
    const r = await core.advanceClock(1000)
    expect(r.ok === false && r.error.code).toBe('UNSUPPORTED')
  }, 60_000)

  it('under DIM_FACTORY_E2E=1 it moves core time; a negative or non-finite amount is a VALIDATION error', async () => {
    const core = await boot({ DIM_FACTORY_E2E: '1' })
    const before = core.clock.now()
    const r = await core.advanceClock(600_000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.now).toBeGreaterThanOrEqual(before + 600_000)
    expect(core.clock.now()).toBeGreaterThanOrEqual(r.value.now)
    expect((await core.advanceClock(-1)).ok === false).toBe(true)
    const bad = await core.advanceClock(Number.NaN)
    expect(bad.ok === false && bad.error.code).toBe('VALIDATION')
  }, 60_000)

  it('power with nothing loaded resolves; an unknown ask is stale', async () => {
    const core = await boot({ DIM_FACTORY_E2E: '1' })
    await expect(core.power('suspend')).resolves.toBeUndefined()
    await expect(core.power('resume')).resolves.toBeUndefined()
    expect(core.askPending('nope', 'q1')).toBe(false)
    const r = await core.answerAsk({ runId: 'nope', requestId: 'q1', decision: 'deny' })
    expect(r).toEqual({
      ok: false,
      error: { code: 'CONFLICT', message: STALE_ASK_MESSAGE, details: { stale: true } },
    })
    expect(isStaleAsk(r)).toBe(true)
    expect(isStaleAsk({ ok: false, error: { code: 'CONFLICT', message: 'busy' } })).toBe(false)
    expect(isStaleAsk({ ok: true, value: undefined })).toBe(false)
  }, 60_000)
})
