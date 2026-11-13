// lib/ticker.ts: one shared 1 s interval for every timer, running only while something listens.
import './helpers/rtl.ts'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TICK_MS, getNow, resetTicker, subscribeNow, useNow } from '@renderer/lib/ticker.ts'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(1_000_000)
  resetTicker()
})

afterEach(() => {
  resetTicker()
  vi.useRealTimers()
})

describe('ticker', () => {
  it('shares one interval between subscribers and stops with the last one', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeNow(a)
    const offB = subscribeNow(b)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(TICK_MS * 3)
    expect(a).toHaveBeenCalledTimes(3)
    expect(b).toHaveBeenCalledTimes(3)
    expect(getNow()).toBe(1_000_000 + TICK_MS * 3)
    offA()
    expect(vi.getTimerCount()).toBe(1)
    offB()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('useNow re-renders once a second; useNow(false) never does', () => {
    let live = 0
    let still = 0
    const l = renderHook(() => {
      live++
      return useNow()
    })
    const s = renderHook(() => {
      still++
      return useNow(false)
    })
    const [l0, s0] = [live, still]
    for (let i = 0; i < 2; i++) {
      act(() => {
        vi.advanceTimersByTime(TICK_MS)
      })
    }
    expect(live - l0).toBe(2)
    expect(still - s0).toBe(0)
    expect(l.result.current).toBe(1_000_000 + TICK_MS * 2)
    expect(s.result.current).toBe(1_000_000)
  })
})
