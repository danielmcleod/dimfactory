// "E2E: DIM_FACTORY_E2E_TIME_SCALE + e2e.clock compress time": the controllable E2E clock.
// `advance(ms)` adds an offset to now(); the timers then due fire in due order before it returns, the rest are
// re-armed against the moved clock. Only DIM_FACTORY_E2E=1 gets it.
import { describe, expect, it } from 'vitest'
import { clockFromEnv, controllableClock, scaledClock, systemClock } from '@core/supervisor/effects.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** How far ahead of Date.now() a real timer may fire. */
const EARLY_MS = 5

describe('controllableClock', () => {
  it('advance moves now() and fires the due timers in order of their due time', () => {
    const c = controllableClock(systemClock())
    const t0 = c.now()
    const fired: string[] = []
    c.setTimer(() => fired.push('b'), t0 + 20_000)
    c.setTimer(() => fired.push('a'), t0 + 10_000)
    c.setTimer(() => fired.push('a2'), t0 + 10_000)
    const late = c.setTimer(() => fired.push('late'), t0 + 3_600_000)
    const now = c.advance(30_000)
    expect(now).toBeGreaterThanOrEqual(t0 + 30_000)
    expect(c.now()).toBeGreaterThanOrEqual(now)
    expect(fired).toEqual(['a', 'a2', 'b'])
    c.clearTimer(late)
    c.advance(3_600_000)
    expect(fired).toEqual(['a', 'a2', 'b'])
  })

  it('a timer not yet due is re-armed against the moved clock and fires in real time', async () => {
    const c = controllableClock(systemClock())
    const t0 = c.now()
    let firedAt: number | undefined
    c.setTimer(() => (firedAt = c.now()), t0 + 60_000)
    c.advance(59_900)
    expect(firedAt).toBeUndefined()
    await sleep(400)
    // Node's timers run on their own clock and can fire a millisecond or so before Date.now() gets there.
    expect(firedAt).toBeGreaterThanOrEqual(t0 + 60_000 - EARLY_MS)
  })

  it('clearTimer works with the original handle after a re-arm; an unref’d timer stays unref’d', async () => {
    const c = controllableClock(systemClock())
    const t0 = c.now()
    let fired = false
    const h = c.setTimer(() => (fired = true), t0 + 50_000)
    h.unref()
    c.advance(49_950)
    c.clearTimer(h)
    await sleep(200)
    expect(fired).toBe(false)
  })

  it('a timer a fired callback sets for an earlier time still runs', async () => {
    const c = controllableClock(systemClock())
    const t0 = c.now()
    const fired: string[] = []
    c.setTimer(() => {
      fired.push('first')
      c.setTimer(() => fired.push('chained'), c.now())
    }, t0 + 1000)
    c.advance(2000)
    expect(fired).toEqual(['first'])
    await sleep(100)
    expect(fired).toEqual(['first', 'chained'])
  })

  it('advance(0) and invalid amounts fire only what is already due', () => {
    const c = controllableClock(systemClock())
    const fired: string[] = []
    c.setTimer(() => fired.push('x'), c.now() + 10_000)
    c.advance(0)
    c.advance(Number.NaN)
    c.advance(-5)
    expect(fired).toEqual([])
  })

  it('keeps the scale of a compressed base clock', () => {
    expect(controllableClock(scaledClock(50)).scale).toBe(50)
  })
})

describe('clockFromEnv', () => {
  it('only DIM_FACTORY_E2E=1 gets a clock that can be moved, with or without a time scale', () => {
    expect(clockFromEnv({}).advance).toBeUndefined()
    expect(clockFromEnv({ DIM_FACTORY_E2E_TIME_SCALE: '50' }).advance).toBeUndefined()
    const e2e = clockFromEnv({ DIM_FACTORY_E2E: '1' })
    expect(typeof e2e.advance).toBe('function')
    expect(e2e.scale).toBe(1)
    const scaled = clockFromEnv({ DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_TIME_SCALE: '50' })
    expect(typeof scaled.advance).toBe('function')
    expect(scaled.scale).toBe(50)
    const before = e2e.now()
    expect(e2e.advance?.(600_000)).toBeGreaterThanOrEqual(before + 600_000)
  })
})
