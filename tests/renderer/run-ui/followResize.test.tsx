// useFollowBottom (components/run/follow.tsx): a region that follows new output keeps following when it changes size.
// A scroll event the browser fires because the region got shorter or taller is not the user scrolling away, so
// "Jump to latest" must not appear (found as an intermittent ui-layout.spec.ts failure: the live stream's region was resized
// after its output ended and showed the button). A real scroll up by the user still unpins it. The resize handling
// must cost nothing per event while a stream fills the region (performance.spec.ts), so it only notes the time and re-pins per frame.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JumpToLatest, RESIZE_SCROLL_MS, useFollowBottom } from '@renderer/components/run/follow.tsx'

function Region({ version }: { version: number }): React.JSX.Element {
  const { ref, innerRef, onScroll, atBottom, jumpToLatest } = useFollowBottom<HTMLDivElement>(version)
  return (
    <div>
      <div ref={ref} data-testid="region" onScroll={onScroll}>
        <div ref={innerRef}>rows</div>
      </div>
      {!atBottom && <JumpToLatest testId="jump" onClick={jumpToLatest} />}
    </div>
  )
}

/** A ResizeObserver stand-in the test fires by hand (happy-dom lays nothing out). */
const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = []
class FakeResizeObserver {
  readonly #entry: { cb: ResizeObserverCallback; targets: Element[] }
  constructor(cb: ResizeObserverCallback) {
    this.#entry = { cb, targets: [] }
    observers.push(this.#entry)
  }
  observe(t: Element): void {
    this.#entry.targets.push(t)
  }
  unobserve(): void {}
  disconnect(): void {
    this.#entry.targets.length = 0
  }
}

function resize(target: Element): void {
  for (const o of observers)
    if (o.targets.includes(target))
      o.cb([{ target } as unknown as ResizeObserverEntry], o as unknown as ResizeObserver)
}

/** Give happy-dom's element the box a browser would lay out. */
function box(el: HTMLElement, b: { client: number; scroll: number; top: number }): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: b.client })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: b.scroll })
  el.scrollTop = b.top
}

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useFollowBottom through a resize', () => {
  it('a scroll event caused by the region changing height keeps it following', () => {
    render(<Region version={1} />)
    const region = screen.getByTestId('region')
    box(region, { client: 300, scroll: 1000, top: 700 })
    fireEvent.scroll(region)
    expect(screen.queryByTestId('jump')).toBeNull()
    // The region shrinks: the browser leaves scrollTop where it was (no longer at the bottom) and fires a scroll.
    box(region, { client: 300, scroll: 1000, top: 100 })
    act(() => resize(region))
    fireEvent.scroll(region)
    expect(screen.queryByTestId('jump')).toBeNull()
  })

  it('a scroll up by the user, away from any resize, unpins it and offers Jump to latest', () => {
    const now = vi.spyOn(performance, 'now')
    render(<Region version={1} />)
    const region = screen.getByTestId('region')
    box(region, { client: 300, scroll: 1000, top: 700 })
    act(() => resize(region))
    now.mockReturnValue(performance.timeOrigin + 1e9) // long after that resize
    box(region, { client: 300, scroll: 1000, top: 200 })
    fireEvent.scroll(region)
    expect(screen.getByTestId('jump')).toBeTruthy()
    act(() => screen.getByTestId('jump').click())
    expect(screen.queryByTestId('jump')).toBeNull()
    now.mockRestore()
  })

  it('treats only a scroll within the resize window as the layout', () => {
    expect(RESIZE_SCROLL_MS).toBeLessThanOrEqual(250)
  })
})
