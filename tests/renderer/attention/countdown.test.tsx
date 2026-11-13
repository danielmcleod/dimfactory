// Countdowns on core's clock (timers, "E2E: DIM_FACTORY_E2E_TIME_SCALE", "One shared 1 s ticker"):
// CountdownRing (asks on the Run view and the Dashboard) counts down to core's deadline at core's rate, so a 10-minute
// ask under time scale 100 runs out after 6 real seconds, and jumps when core's clock does.
import '../helpers/rtl.ts'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '@shared/ipc.ts'
import { CountdownRing } from '@renderer/components/ui/CountdownRing.tsx'
import { configureCoreClock, observeCoreLowerBound, resetCoreClock } from '@renderer/lib/coreClock.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { defaultAppInfo } from '../helpers/mockDimFactory.ts'

const T0 = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(T0)
  resetTicker()
  resetCoreClock()
})

afterEach(() => {
  resetTicker()
  resetCoreClock()
  vi.useRealTimers()
})

const remaining = (): number => Number(screen.getByRole('timer').getAttribute('data-remaining-ms'))

describe('CountdownRing on core’s clock', () => {
  it('counts down 100× faster under time scale 100', () => {
    configureCoreClock({ ...defaultAppInfo(), timeScale: 100 } as AppInfo)
    render(<CountdownRing expiresAt={T0 + 600_000} totalMs={600_000} showLabel />)
    expect(remaining()).toBe(600_000)
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('10m 0s left')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(remaining()).toBe(500_000)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(remaining()).toBe(0)
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Time is up')
  })

  it('counts at the wall clock’s rate outside E2E', () => {
    render(<CountdownRing expiresAt={T0 + 600_000} totalMs={600_000} />)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(remaining()).toBe(597_000)
  })

  it('follows a jump of core’s clock (resume after sleep, e2e.clock)', () => {
    render(<CountdownRing expiresAt={T0 + 600_000} totalMs={600_000} />)
    act(() => {
      observeCoreLowerBound(T0 + 240_000)
      vi.advanceTimersByTime(1000)
    })
    expect(remaining()).toBe(359_000)
  })

  it('takes a fixed core time from its caller', () => {
    configureCoreClock({ ...defaultAppInfo(), timeScale: 100 } as AppInfo)
    render(<CountdownRing expiresAt={T0 + 600_000} totalMs={600_000} now={T0 + 60_000} />)
    expect(remaining()).toBe(540_000)
  })
})
