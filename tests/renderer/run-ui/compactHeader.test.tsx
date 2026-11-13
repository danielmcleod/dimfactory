// The Run view's compact sticky block (UI standards): where the full
// header, tabs and timeline would leave the reading area under 55% of the page's height (a small window, or page
// zoom), the block is one header row, the tabs and a one-line step strip. The form is decided before the paint from
// measurements, with hysteresis, keeping the reading position; the strip never wraps or scrolls, the oldest settled
// steps giving way behind a "+N" chip; the compact header keeps every control and name the full one has.
import '../helpers/rtl.ts'
import { act, render, screen, within } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPACT_BELOW,
  NORMAL_FROM,
  fullBlockHeight,
  nextHeaderForm,
  useHeaderForm,
} from '@renderer/components/run/headerForm.ts'
import { PhaseStrip } from '@renderer/components/run/PhaseTimeline.tsx'
import { RunHeader } from '@renderer/components/run/RunHeader.tsx'
import { fitStrip } from '@renderer/components/run/stripFit.ts'
import { MainScrollContext } from '@renderer/components/shell/mainScroll.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { renderUi, snapWith } from '../run/helpers.tsx'

afterEach(() => {
  resetTicker()
})

describe('nextHeaderForm', () => {
  const at = (reading: number): { main: number; full: number; bottom: number } => ({
    main: 1000,
    bottom: 40,
    full: 1000 - 40 - reading * 1000,
  })

  it('turns compact when the full block leaves the reading area under 55% of main', () => {
    expect(COMPACT_BELOW).toBe(0.55)
    expect(nextHeaderForm('full', at(0.56))).toBe('full')
    expect(nextHeaderForm('full', at(0.54))).toBe('compact')
  })

  it('comes back only once the full block would leave 60% (between the two, each form stays)', () => {
    expect(NORMAL_FROM).toBe(0.6)
    expect(nextHeaderForm('compact', at(0.57))).toBe('compact')
    expect(nextHeaderForm('full', at(0.57))).toBe('full')
    expect(nextHeaderForm('compact', at(0.6))).toBe('full')
  })

  it('keeps the form it has while nothing is measured', () => {
    expect(nextHeaderForm('compact', { main: 0, full: 300, bottom: 40 })).toBe('compact')
    expect(nextHeaderForm('full', { main: 600, full: null, bottom: 40 })).toBe('full')
  })
})

describe('fitStrip', () => {
  const room = { available: 300, gap: 10, more: 30 }
  const item = (width: number, settled = false): { width: number; settled: boolean } => ({ width, settled })

  it('shows everything that fits', () => {
    expect(fitStrip([item(90), item(90), item(100)], room)).toEqual({ before: 0, after: 0 })
  })

  it('lets the oldest settled items give way first, as few as fit', () => {
    // 4 × 90 + 3 gaps = 390; without the first: 280 + a "+N" chip (30 + gap) = 320; without two: 180 + 40 = 220.
    expect(fitStrip([item(90, true), item(90, true), item(90), item(90)], room)).toEqual({
      before: 2,
      after: 0,
    })
  })

  it('never hides the step the run is at; steps not begun give way from the end', () => {
    const items = [item(90, true), item(120), item(90), item(90), item(90)]
    expect(fitStrip(items, room)).toEqual({ before: 1, after: 2 })
    // Even on a line too short for anything, the first item left shows.
    expect(fitStrip([item(200, true), item(400), item(90)], { ...room, available: 100 })).toEqual({
      before: 1,
      after: 1,
    })
  })
})

describe('useHeaderForm', () => {
  /** A ResizeObserver whose callbacks the test calls (happy-dom never lays out). */
  const observers: (() => void)[] = []
  class FakeObserver {
    readonly #cb: () => void
    constructor(cb: () => void) {
      this.#cb = cb
      observers.push(() => this.#cb())
    }
    observe(): void {}
    disconnect(): void {}
  }

  function size(el: HTMLElement, height: number): void {
    el.getBoundingClientRect = () =>
      ({ height, width: 600, top: 0, left: 0, right: 600, bottom: height }) as DOMRect
  }

  it('turns compact before the first paint, keeps the reading position, and does not take turns', async () => {
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver
    const main = document.createElement('main')
    let mainHeight = 566
    Object.defineProperty(main, 'clientHeight', { get: () => mainHeight })
    document.body.append(main)
    main.scrollTop = 0
    const seen: string[] = []
    function View(): React.JSX.Element {
      const top = useRef<HTMLDivElement>(null)
      const bottom = useRef<HTMLDivElement>(null)
      const form = useHeaderForm(top, bottom)
      seen.push(form)
      return (
        <div>
          <div
            ref={(el) => {
              top.current = el
              if (el !== null) size(el, form === 'full' ? 244 : 109)
            }}
            data-testid="top"
            data-form={form}
          />
          <div
            ref={(el) => {
              bottom.current = el
              if (el !== null) size(el, 44)
            }}
          />
        </div>
      )
    }
    try {
      render(
        <MainScrollContext value={main}>
          <View />
        </MainScrollContext>,
      )
      // 566 − 244 − 44 = 278 px of 566 (49%): compact, already in the first committed render.
      expect(screen.getByTestId('top').dataset['form']).toBe('compact')
      // A taller window, still under 60% for the full block: compact stays.
      mainHeight = 700 // (700 − 288) / 700 = 59%
      act(() => observers.forEach((o) => o()))
      expect(screen.getByTestId('top').dataset['form']).toBe('compact')
      // Room enough: the full block comes back, and the page keeps its offset.
      main.scrollTop = 120
      mainHeight = 900
      act(() => observers.forEach((o) => o()))
      expect(screen.getByTestId('top').dataset['form']).toBe('full')
      expect(main.scrollTop).toBe(120)
      // The browser's scroll anchoring is off until the page next scrolls (an anchor from before the switch would
      // scroll the page on its own); a scroll event already on its way does not count.
      expect(main.style.overflowAnchor).toBe('none')
      main.dispatchEvent(new Event('scroll'))
      expect(main.style.overflowAnchor).toBe('none')
      await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
      main.dispatchEvent(new Event('scroll'))
      expect(main.style.overflowAnchor).toBe('')
      // Measured again with nothing changed: no switch back and forth.
      const before = seen.length
      act(() => observers.forEach((o) => o()))
      expect(seen.slice(before).every((f) => f === 'full')).toBe(true)
    } finally {
      globalThis.ResizeObserver = original
      main.remove()
      observers.length = 0
    }
  })

  it('keeps a page read to its end at its end when the block changes form', () => {
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver
    const main = document.createElement('main')
    let mainHeight = 566
    let form = 'full'
    // The block, 1000 px of content and the 44 px bar.
    const scrollHeight = (): number => (form === 'full' ? 244 : 109) + 1000 + 44
    Object.defineProperty(main, 'clientHeight', { get: () => mainHeight })
    Object.defineProperty(main, 'scrollHeight', { get: scrollHeight })
    document.body.append(main)
    function View(): React.JSX.Element {
      const top = useRef<HTMLDivElement>(null)
      const bottom = useRef<HTMLDivElement>(null)
      form = useHeaderForm(top, bottom)
      return (
        <div>
          <div
            ref={(el) => {
              top.current = el
              if (el !== null) size(el, form === 'full' ? 244 : 109)
            }}
            data-testid="top"
            data-form={form}
          />
          <div
            ref={(el) => {
              bottom.current = el
              if (el !== null) size(el, 44)
            }}
          />
        </div>
      )
    }
    try {
      render(
        <MainScrollContext value={main}>
          <View />
        </MainScrollContext>,
      )
      expect(form).toBe('compact')
      // Read to the end; the window grows, and the browser holds the page at its (compact) end: 1153 − 900.
      mainHeight = 900
      main.scrollTop = 253
      act(() => observers.forEach((o) => o()))
      expect(form).toBe('full')
      // Still at its end once the full block is back: 1288 − 900.
      expect(main.scrollTop).toBe(388)
    } finally {
      globalThis.ResizeObserver = original
      main.remove()
      observers.length = 0
    }
  })

  it('decides on the full block at the page width now, not a height measured at another width', () => {
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver
    const main = document.createElement('main')
    // 1280 × 900 at 150%: main 577 px, the full timeline (the ruler) wraps to two rows.
    let mainHeight = 577
    let timeline = 90
    Object.defineProperty(main, 'clientHeight', { get: () => mainHeight })
    document.body.append(main)
    let form = 'full'
    function View(): React.JSX.Element {
      const top = useRef<HTMLDivElement>(null)
      const bottom = useRef<HTMLDivElement>(null)
      const ruler = useRef<HTMLDivElement>(null)
      form = useHeaderForm(top, bottom, ruler)
      return (
        <div>
          <div
            ref={(el) => {
              top.current = el
              // The full block: 156 px of header, tabs and padding, plus the timeline as it lays out now.
              if (el !== null) size(el, form === 'full' ? 156 + timeline : 109)
            }}
          />
          <div
            ref={(el) => {
              bottom.current = el
              if (el !== null) size(el, 44)
            }}
          />
          <div
            ref={(el) => {
              ruler.current = el
              if (el !== null) el.getBoundingClientRect = () => ({ height: timeline, width: 600 }) as DOMRect
            }}
          />
        </div>
      )
    }
    try {
      render(
        <MainScrollContext value={main}>
          <View />
        </MainScrollContext>,
      )
      // (577 − 246 − 44) / 577 = 50%: compact.
      expect(form).toBe('compact')
      // Back to 125%: main 692 px, the timeline one row again (42 px). The full block would take 198 px, leaving 65%
      // to read; the height last measured (246 px, two rows at 150%) would leave 58%, under the 60% it needs.
      mainHeight = 692
      timeline = 42
      act(() => observers.forEach((o) => o()))
      expect(form).toBe('full')
    } finally {
      globalThis.ResizeObserver = original
      main.remove()
      observers.length = 0
    }
  })
})

describe('fullBlockHeight', () => {
  it('is the block while it shows; else its rest plus the timeline at the width now; else the last full height', () => {
    expect(fullBlockHeight('full', { block: 198, timeline: 42, rest: 156, lastFull: 198 })).toBe(198)
    expect(fullBlockHeight('compact', { block: 109, timeline: 90, rest: 156, lastFull: 198 })).toBe(246)
    expect(fullBlockHeight('compact', { block: 109, timeline: 42, rest: 156, lastFull: 246 })).toBe(198)
    expect(fullBlockHeight('compact', { block: 109, timeline: null, rest: null, lastFull: 246 })).toBe(246)
    expect(fullBlockHeight('compact', { block: 109, timeline: null, rest: null, lastFull: null })).toBeNull()
  })
})

describe('the compact header', () => {
  const running = snapWith({
    summary: {
      status: 'running',
      phase: 'implementing',
      title: 'Add a --version flag',
      folder: 'C:\\work\\api',
    },
  })

  it('is one row with the title cut and whole in its tooltip, status, phase, cost and time', () => {
    renderUi(<RunHeader snap={running} onStop={() => undefined} stopping={false} compact />)
    const header = screen.getByTestId('run-header')
    expect(header.dataset['form']).toBe('compact')
    expect(header.className).toContain('h-10')
    expect(header.className).toContain('whitespace-nowrap')
    const title = within(header).getByRole('heading', { level: 1 })
    expect(title.className).toContain('truncate')
    expect(title.getAttribute('title')).toContain('Add a --version flag')
    expect(title.getAttribute('title')).toContain('C:\\work\\api')
    for (const id of ['run-status', 'run-phase', 'run-cost', 'run-elapsed'])
      expect(within(header).getByTestId(id)).toBeTruthy()
    // The time keeps the room of its usual widths: ticking moves nothing.
    expect(
      [...screen.getByTestId('run-elapsed').querySelectorAll('[data-label]')].map((n) =>
        n.getAttribute('data-label'),
      ),
    ).toEqual(['00:00 · ETA ~00 min'])
  })

  it('has Stop and Re-run as icon buttons named by their labels; stopping keeps Stop’s shape', () => {
    const { unmount } = renderUi(
      <RunHeader snap={running} onStop={() => undefined} stopping={false} compact />,
    )
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop.dataset['testid']).toBe('stop-run')
    expect(stop.getAttribute('aria-keyshortcuts')).toBe('Control+Period')
    expect(stop.textContent).toBe('')
    const glyphs = stop.querySelectorAll('svg').length
    // A filled square, the media "stop": an outline square in an outlined button would read as a checkbox.
    expect(stop.querySelector('svg[data-icon="stop"]')?.getAttribute('class')).toContain('fill-current')
    expect(screen.getByRole('button', { name: 'Re-run' }).dataset['testid']).toBe('rerun-menu')
    unmount()
    renderUi(<RunHeader snap={running} onStop={() => undefined} stopping compact />)
    const busy = screen.getByRole('button', { name: 'Stop' })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(busy.querySelector('[data-spinner]')).not.toBeNull()
    expect(busy.querySelectorAll('svg').length).toBe(glyphs)
  })

  it("keeps Stop's room once the run has ended", () => {
    const ended = snapWith({ summary: { status: 'completed', phase: 'done', endedAt: Date.now() } })
    renderUi(<RunHeader snap={ended} onStop={() => undefined} stopping={false} compact />)
    expect(screen.queryByTestId('stop-run')).toBeNull()
    expect(screen.getByTestId('stop-run-room').className).toContain('invisible')
  })
})

describe('the step strip', () => {
  const snap = snapWith({
    summary: { status: 'running', phase: 'implementing' },
    steps: {
      preflight: { status: 'done', attempt: 1, activeMs: 1000 },
      plan: { status: 'done', attempt: 1, activeMs: 65_000 },
      implement: { status: 'running', attempt: 1, activeMs: 1000, eta: { p50: 360_000, p80: 480_000 } },
    },
  })

  it('is one line of chips that never wraps or scrolls, the current step highlighted', () => {
    renderUi(<PhaseStrip snap={snap} />)
    const strip = screen.getByTestId('phase-timeline')
    expect(strip.dataset['form']).toBe('compact')
    expect(strip.className).toContain('overflow-clip')
    const line = strip.querySelector('ol')
    expect(line?.className).not.toContain('flex-wrap')
    expect(line?.className).not.toMatch(/overflow-(x-)?(auto|scroll)/)
    const implement = screen.getByTestId('timeline-node-implement')
    expect(implement.dataset['status']).toBe('running')
    expect(implement.getAttribute('aria-current')).toBe('step')
    expect(implement.className).toContain('bg-accent')
    // The status words and time are for screen readers and the tooltip; the chip shows the icon and the step.
    expect(implement.textContent).toMatch(/^Implement: Running, \d+:\d\d \/ ~6 min$/)
    const plan = screen.getByTestId('timeline-node-plan')
    expect(plan.getAttribute('aria-current')).toBeNull()
    expect(plan.textContent).toBe('Plan: Done, 1m 5s')
    // A chip's box is the same whatever its status (no weight change): only colours differ.
    const box = (el: HTMLElement): string[] =>
      el.className.split(' ').filter((c) => /^(h-|px-|gap-|text-xs|font-|border$|rounded)/.test(c))
    expect(box(plan)).toEqual(box(implement))
    expect(screen.getByTestId('timeline-gate-afterPlan')).toBeTruthy()
  })

  it('measures its items in an unseen ruler that nothing can find, focus or read', () => {
    renderUi(<PhaseStrip snap={snap} />)
    const ruler = screen.getByTestId('phase-timeline').querySelector('[aria-hidden][class*="invisible"]')
    expect(ruler).not.toBeNull()
    expect(ruler?.querySelectorAll('[data-testid]')).toHaveLength(0)
    expect(ruler?.querySelectorAll('button')).toHaveLength(0)
    expect(screen.getAllByTestId(/^timeline-node-/).length).toBeGreaterThan(3)
  })
})
