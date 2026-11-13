// Integration (the Sleep timer, "One shared 1 s ticker"; "a countdown never shows more time than core gives"):
// CountdownRing draws at core's time of the render, not of the last tick, so a deadline
// that moves between ticks (an ask extended after a sleep, suspend.spec.ts) is never shown with more time left than core
// gives. Before, it was measured against the last tick's time and read up to 1 s high until the next tick.
import '../helpers/rtl.ts'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CountdownRing } from '@renderer/components/ui/CountdownRing.tsx'
import { observeCoreLowerBound, resetCoreClock } from '@renderer/lib/coreClock.ts'
import { TICK_MS, resetTicker } from '@renderer/lib/ticker.ts'

const T0 = 1_800_000_000_000
const ASK_MS = 600_000

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

describe('CountdownRing redrawn between ticks', () => {
  it('a deadline moved between ticks is measured at the render, not at the last tick', () => {
    const { rerender } = render(<CountdownRing expiresAt={T0 + ASK_MS} totalMs={ASK_MS} />)
    expect(remaining()).toBe(ASK_MS)
    // 600 ms later (no tick yet) the deadline moves 300 ms out: core gives 599 700 ms.
    act(() => {
      vi.advanceTimersByTime(600)
    })
    rerender(<CountdownRing expiresAt={T0 + ASK_MS + 300} totalMs={ASK_MS} />)
    expect(remaining()).toBe(ASK_MS + 300 - 600)
    expect(remaining()).toBeLessThanOrEqual(ASK_MS)
  })

  it('an ask extended after a sleep (core’s clock jumped) never reads above its full length', () => {
    // Raised at T0; 400 ms later the machine sleeps 11 minutes; core moves the expiry by the time asleep.
    const asleep = ASK_MS + 60_000
    const { rerender } = render(<CountdownRing expiresAt={T0 + ASK_MS} totalMs={ASK_MS} />)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    const resumedAt = T0 + 400 + asleep
    act(() => {
      observeCoreLowerBound(resumedAt)
      vi.advanceTimersByTime(300)
    })
    rerender(<CountdownRing expiresAt={T0 + ASK_MS + asleep} totalMs={ASK_MS} />)
    // Core gives 600 000 − 400 (before the sleep) − 300 (since the resume).
    expect(remaining()).toBe(ASK_MS - 400 - 300)
    expect(remaining()).toBeLessThanOrEqual(ASK_MS)
  })

  it('still counts down with the shared ticker', () => {
    render(<CountdownRing expiresAt={T0 + ASK_MS} totalMs={ASK_MS} />)
    act(() => {
      vi.advanceTimersByTime(3 * TICK_MS)
    })
    expect(remaining()).toBe(ASK_MS - 3 * TICK_MS)
  })
})
