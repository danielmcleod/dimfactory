// lib/coreClock.ts (timers, "E2E: DIM_FACTORY_E2E_TIME_SCALE"): countdowns follow core's clock — the
// identity by default, a scale from app.info or e2e.state, re-anchored only when core disagrees by more than the
// tolerance (heartbeats), jumping forward when a live envelope is stamped later than predicted (suspend/resume,
// e2e.clock), and re-read from e2e.state under E2E. The bridge feeds it at arrival.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo, E2EState, Result } from '@shared/ipc.ts'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import {
  DRIFT_TOLERANCE_MS,
  configureCoreClock,
  coreNow,
  coreRemainingMs,
  coreTimeScale,
  observeCoreEvents,
  observeCoreLowerBound,
  observeCoreTime,
  resetCoreClock,
} from '@renderer/lib/coreClock.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { env, runEvent, text } from '../helpers/fixtures.ts'
import { defaultAppInfo, deferred, installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

const T0 = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(T0)
  resetCoreClock()
})

afterEach(() => {
  resetCoreClock()
  vi.useRealTimers()
})

type E2EReading = Pick<E2EState, 'now' | 'timeScale'>
const ok = (v: E2EReading): Result<E2EReading> => ({ ok: true, value: v })
const info = (over: Partial<AppInfo> & { timeScale?: number } = {}): AppInfo => ({
  ...defaultAppInfo(),
  ...over,
})

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('core clock', () => {
  it('is the local clock until core says otherwise', () => {
    expect(coreNow()).toBe(T0)
    expect(coreTimeScale()).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(coreNow()).toBe(T0 + 5000)
    expect(coreRemainingMs(T0 + 60_000)).toBe(55_000)
    expect(coreRemainingMs(T0)).toBe(0)
  })

  it('keeps its anchor for heartbeats within the tolerance, re-anchors beyond it', () => {
    observeCoreTime(T0 - 30) // 30 ms of IPC latency: no change
    expect(coreNow()).toBe(T0)
    observeCoreTime(T0 + DRIFT_TOLERANCE_MS + 1000) // core is 1.25 s ahead
    expect(coreNow()).toBe(T0 + DRIFT_TOLERANCE_MS + 1000)
    vi.advanceTimersByTime(2000)
    expect(coreNow()).toBe(T0 + DRIFT_TOLERANCE_MS + 3000)
    observeCoreTime(T0 - 10_000) // core's clock went back (wall-clock change)
    expect(coreNow()).toBe(T0 - 10_000)
  })

  it('runs scale× faster with an app.info time scale, continuously across the change', () => {
    vi.advanceTimersByTime(1000)
    configureCoreClock(info({ timeScale: 100 }))
    expect(coreTimeScale()).toBe(100)
    expect(coreNow()).toBe(T0 + 1000)
    vi.advanceTimersByTime(1000)
    expect(coreNow()).toBe(T0 + 1000 + 100_000)
    // A 10-minute ask made now expires after 6 real seconds.
    const expiresAt = coreNow() + 600_000
    vi.advanceTimersByTime(3000)
    expect(coreRemainingMs(expiresAt)).toBe(300_000)
    vi.advanceTimersByTime(3000)
    expect(coreRemainingMs(expiresAt)).toBe(0)
  })

  it('scales the drift tolerance with the time scale', () => {
    configureCoreClock(info({ timeScale: 100 }))
    observeCoreTime(T0 + 20_000) // 200 real ms at scale 100: inside the tolerance
    expect(coreNow()).toBe(T0)
    observeCoreTime(T0 + 60_000) // 600 real ms: re-anchored
    expect(coreNow()).toBe(T0 + 60_000)
  })

  it('moves forward to a live envelope stamped later than predicted, never back', () => {
    expect(observeCoreLowerBound(T0 - 60_000)).toBe(false)
    expect(coreNow()).toBe(T0)
    expect(observeCoreLowerBound(T0 + 100)).toBe(false)
    expect(observeCoreLowerBound(T0 + 3_600_000)).toBe(true) // a resume after an hour asleep
    expect(coreNow()).toBe(T0 + 3_600_000)
  })

  it('under E2E reads core now and scale from e2e.state, anchored when the request was sent', async () => {
    const reply = deferred<Result<E2EReading>>()
    const source = vi.fn(() => reply.promise)
    configureCoreClock(info({ e2e: true }), source)
    expect(source).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(40)
    reply.resolve(ok({ now: T0 + 5_000_000, timeScale: 100 }))
    await flush()
    expect(coreTimeScale()).toBe(100)
    // Anchored at T0 (the request was sent): now (T0 + 40) is 40 ms × 100 later, never behind core.
    expect(coreNow()).toBe(T0 + 5_000_000 + 4000)
  })

  it('under E2E re-reads e2e.state on a heartbeat (whatever its stamp) and on a forward jump', async () => {
    let core = T0 + 1_000_000
    const source = vi.fn(() => Promise.resolve(ok({ now: core, timeScale: 50 })))
    configureCoreClock(info({ e2e: true }), source)
    await flush()
    expect(coreNow()).toBe(core)
    // A wall-clock heartbeat does not pull the clock back; it asks e2e.state again.
    observeCoreEvents([{ kind: 'heartbeat', at: T0 }])
    expect(coreNow()).toBe(core)
    await flush()
    expect(source).toHaveBeenCalledTimes(2)
    // e2e.clock advanced core by an hour: the next live envelope shows it, and e2e.state confirms it.
    core += 3_600_000
    observeCoreEvents([runEvent(env('r1', 1, text('plan', 'x'), core))])
    expect(coreNow()).toBe(core)
    await flush()
    expect(source).toHaveBeenCalledTimes(3)
    expect(coreNow()).toBe(core)
  })

  it('ignores a reading that answers after a reset, and a failed one', async () => {
    const reply = deferred<Result<E2EReading>>()
    configureCoreClock(info({ e2e: true }), () => reply.promise)
    resetCoreClock()
    reply.resolve(ok({ now: T0 + 9_999_999, timeScale: 10 }))
    await flush()
    expect(coreNow()).toBe(T0)
    expect(coreTimeScale()).toBe(1)
    configureCoreClock(info({ e2e: true }), () =>
      Promise.resolve({ ok: false, error: { code: 'UNSUPPORTED', message: 'no' } }),
    )
    await flush()
    expect(coreNow()).toBe(T0)
  })

  it('outside E2E ignores the e2e source and uses heartbeats', () => {
    const source = vi.fn(() => Promise.resolve(ok({ now: 1, timeScale: 1 })))
    configureCoreClock(info({ e2e: false }), source)
    expect(source).not.toHaveBeenCalled()
    observeCoreEvents([{ kind: 'heartbeat', at: T0 + 10_000 }])
    expect(coreNow()).toBe(T0 + 10_000)
  })
})

describe('the bridge feeds the clock', () => {
  let mock: MockDimFactory

  afterEach(() => {
    resetBridgeForTests()
    cancelRefetches()
    mock.uninstall()
  })

  it('configures it from app.info, reads e2e.state under E2E, and observes pushes at arrival', async () => {
    resetStore()
    let core = T0 + 42_000_000
    mock = installMockDimFactory({
      handlers: {
        'app.info': () => defaultAppInfo({ e2e: true }),
        'e2e.state': () =>
          ({
            now: core,
            timeScale: 100,
            activeRuns: 0,
            procs: [],
            windowFocused: true,
          }) as unknown as E2EState,
      },
    })
    startBridge()
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.callsOf('e2e.state')).toHaveLength(1)
    expect(coreTimeScale()).toBe(100)
    expect(coreNow()).toBe(core)
    core += 500_000
    mock.push({ kind: 'heartbeat', at: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.callsOf('e2e.state')).toHaveLength(2)
    expect(coreNow()).toBe(core)
  })

  it('goes back to the identity clock when the bridge stops', async () => {
    resetStore()
    mock = installMockDimFactory()
    startBridge()
    await vi.advanceTimersByTimeAsync(0)
    mock.push({ kind: 'heartbeat', at: T0 + 30_000 })
    expect(coreNow()).toBe(T0 + 30_000)
    resetBridgeForTests()
    expect(coreNow()).toBe(T0)
  })
})
