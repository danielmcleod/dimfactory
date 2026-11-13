// state/toasts.ts + components/ui/Toaster.tsx: stacking, auto-dismiss, pause on hover, actions (command or callback)
// and the disabled action with its reason; the stack as a corner overlay where no toast moves on its own.
import './helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  nextSlots,
  placeFresh,
  TOAST_GAP_PX,
  Toaster,
  useToastClearance,
} from '@renderer/components/ui/Toaster.tsx'
import type { ToastSlot } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { resetStore, useStore } from '@renderer/state/store.ts'
import {
  TOAST_MAX,
  clearToasts,
  dismissToast,
  pauseToasts,
  resumeToasts,
  toast,
} from '@renderer/state/toasts.ts'
import type { ToastItem } from '@renderer/state/toasts.ts'
import { installMockDimFactory, mockError } from './helpers/mockDimFactory.ts'
import type { MockDimFactory } from './helpers/mockDimFactory.ts'

const messages = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

let mock: MockDimFactory

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  resetStore()
  clearToasts()
  mock = installMockDimFactory()
})

afterEach(() => {
  clearToasts()
  mock.uninstall()
  vi.useRealTimers()
})

describe('toast store', () => {
  it('auto-dismisses by level and keeps sticky toasts', () => {
    toast({ level: 'info', message: 'saved' })
    toast({ level: 'error', message: 'failed' })
    toast({ level: 'warn', message: 'sticky', durationMs: null })
    vi.advanceTimersByTime(5001)
    expect(messages()).toEqual(['failed', 'sticky'])
    vi.advanceTimersByTime(5000)
    expect(messages()).toEqual(['sticky'])
    vi.advanceTimersByTime(60_000)
    expect(messages()).toEqual(['sticky'])
  })

  it(`stacks at most ${TOAST_MAX}, dropping the oldest, and replaces by id`, () => {
    // Three (UI standard "nothing moves on its own": the stack stays a corner overlay).
    expect(TOAST_MAX).toBe(3)
    for (let i = 1; i <= TOAST_MAX + 2; i++) toast({ level: 'info', message: `m${i}` })
    expect(messages()).toEqual(['m3', 'm4', 'm5'])
    toast({ id: 'deny', level: 'info', message: 'Denied · Undo' })
    toast({ id: 'deny', level: 'info', message: 'Denied' })
    expect(messages().filter((m) => m.startsWith('Denied'))).toEqual(['Denied'])
  })

  it('pauses every timer and resumes with the time that was left', () => {
    toast({ level: 'info', message: 'a', durationMs: 3000 })
    vi.advanceTimersByTime(2000)
    pauseToasts()
    vi.advanceTimersByTime(10_000)
    expect(messages()).toEqual(['a'])
    resumeToasts()
    vi.advanceTimersByTime(999)
    expect(messages()).toEqual(['a'])
    vi.advanceTimersByTime(2)
    expect(messages()).toEqual([])
  })

  it('gives action toasts at least 8 s', () => {
    toast({
      level: 'info',
      message: 'Run stopped · changes kept',
      action: { label: 'Revert all', onClick: () => {} },
    })
    vi.advanceTimersByTime(7999)
    expect(messages()).toHaveLength(1)
    vi.advanceTimersByTime(2)
    expect(messages()).toHaveLength(0)
  })
})

describe('Toaster', () => {
  const view = (): ReturnType<typeof render> =>
    render(
      <TooltipProvider>
        <Toaster />
      </TooltipProvider>,
    )

  it('runs a command action once and closes', async () => {
    view()
    act(() => {
      toast({
        level: 'info',
        message: 'Denied · Undo (3 s)',
        action: { label: 'Undo', call: { cmd: 'asks.undo', req: { runId: 'r1', requestId: 'q1' } } },
      })
    })
    mock.on('asks.undo', () => undefined)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('asks.undo')).toEqual([{ runId: 'r1', requestId: 'q1' }])
    expect(messages()).toEqual([])
  })

  it("turns a failed command into an error toast with core's message", async () => {
    view()
    mock.on('diff.undoRevert', () => {
      throw mockError('CONFLICT', 'The folder changed since the revert.')
    })
    act(() => {
      toast({
        level: 'info',
        message: 'Reverted 3 files',
        action: { label: 'Undo', call: { cmd: 'diff.undoRevert', req: { runId: 'r1', undoToken: 't' } } },
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(messages()).toEqual(['The folder changed since the revert.'])
    expect(screen.getByRole('alert').textContent).toContain('The folder changed')
  })

  it('shows a disabled action with its reason and a dismiss button', () => {
    view()
    act(() => {
      toast({
        level: 'warn',
        message: 'Run stopped · changes kept',
        action: { label: 'Revert all', onClick: () => {}, disabledReason: 'Available in a later version' },
      })
    })
    const btn = screen.getByRole('button', { name: 'Revert all' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText('Available in a later version')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(messages()).toEqual([])
  })

  it('pauses on hover', () => {
    view()
    act(() => {
      toast({ level: 'info', message: 'hover me', durationMs: 1000 })
    })
    fireEvent.pointerEnter(screen.getByRole('status').parentElement!)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(messages()).toEqual(['hover me'])
    fireEvent.pointerLeave(screen.getByRole('status').parentElement!)
    act(() => {
      vi.advanceTimersByTime(1001)
    })
    expect(messages()).toEqual([])
    act(() => dismissToast('none'))
  })
})

// UI standard "One scroll region per screen, and nothing moves on its own": the stack is a corner overlay of at most
// TOAST_MAX toasts, and no toast moves because another one came or went.
describe('Toaster: a stack where nothing moves', () => {
  const view = (): ReturnType<typeof render> =>
    render(
      <TooltipProvider>
        <Toaster />
      </TooltipProvider>,
    )
  const shown = (): string[] =>
    [...document.querySelectorAll('[aria-label="Notifications"] li')].map((li) =>
      li.hasAttribute('data-toast-gap') ? 'gap' : (li.getAttribute('data-toast-id') ?? ''),
    )

  it('is a fixed overlay in the bottom right corner, clear of a bottom bar, anchored at the bottom', () => {
    view()
    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(region.className).toEqual(expect.stringContaining('fixed'))
    expect(region.className).toEqual(expect.stringContaining('right-4'))
    expect(region.className).toEqual(
      expect.stringContaining('bottom-[calc(var(--toast-clearance,0px)+1rem)]'),
    )
    // The box spans the window's right edge whatever it holds: adding or removing a toast never moves its edges.
    expect(region.className).toEqual(expect.stringContaining('top-4'))
    // Oldest first in the DOM, drawn bottom up: a new toast goes on top, where nothing else has to move.
    expect(region.querySelector('ol')?.className).toEqual(expect.stringContaining('flex-col-reverse'))
    expect(region.querySelector('ol')?.className).toEqual(expect.stringContaining('h-full'))
  })

  it('adds a new toast on top and keeps the others in their slots', () => {
    view()
    act(() => {
      toast({ id: 'a', level: 'info', message: 'first' })
      toast({ id: 'b', level: 'info', message: 'second' })
    })
    expect(shown()).toEqual(['a', 'b'])
    // Replaced by id: the same slot, not a new one on top.
    act(() => {
      toast({ id: 'a', level: 'info', message: 'first, updated' })
    })
    expect(shown()).toEqual(['a', 'b'])
    expect(screen.getByText('first, updated')).toBeTruthy()
  })

  it('leaves an invisible, inert gap where a toast went below a newer one; gaps with nothing above them close', () => {
    view()
    act(() => {
      toast({ id: 'a', level: 'info', message: 'A', durationMs: null })
      toast({ id: 'b', level: 'info', message: 'B', durationMs: null })
      toast({ id: 'c', level: 'info', message: 'C', durationMs: null })
    })
    act(() => dismissToast('a'))
    expect(shown()).toEqual(['gap', 'b', 'c'])
    const gap = document.querySelector<HTMLElement>('[data-toast-gap]')
    expect(gap?.getAttribute('aria-hidden')).toBe('true')
    expect(gap?.hasAttribute('inert')).toBe(true)
    expect(gap?.hasAttribute('role')).toBe(false)
    expect(gap?.textContent).toBe('')
    expect(gap?.style.height).toMatch(/px$/)
    // The top one goes: nothing above it, so it leaves no gap.
    act(() => dismissToast('c'))
    expect(shown()).toEqual(['gap', 'b'])
    // The last one goes: the gaps under it close with it.
    act(() => dismissToast('b'))
    expect(shown()).toEqual([])
  })

  const item = (id: string): ToastItem => ({ id, level: 'info', message: id, durationMs: null, createdAt: 0 })
  const label = (slots: readonly ToastSlot[]): string[] =>
    slots.map((x) => (x.live ? (x.hold !== undefined ? `${x.id}@${x.hold}` : x.id) : `gap@${x.hold ?? 0}`))

  it('puts a new toast into the lowest gap it fits, at its bottom, and on top when none fits', () => {
    const h: Record<string, number> = { a: 50, b: 50, c: 50, d: 40, e: 120, f: 30, g: 75 }
    const heightOf = (id: string): number => h[id] ?? 0
    const step = (prev: readonly ToastSlot[], ids: string[]): readonly ToastSlot[] =>
      placeFresh(nextSlots(prev, ids.map(item), heightOf), heightOf)
    let slots = step([], ['a', 'b', 'c'])
    expect(label(slots)).toEqual(['a', 'b', 'c'])
    // a and b go below c: one gap with their room and the space between them.
    slots = step(slots, ['c'])
    expect(label(slots)).toEqual([`gap@${50 + TOAST_GAP_PX + 50}`, 'c'])
    // d (40) fits: it rests at the gap's bottom, and what is left stays a gap above it.
    slots = step(slots, ['c', 'd'])
    expect(label(slots)).toEqual(['d', `gap@${108 - 40 - TOAST_GAP_PX}`, 'c'])
    // e (120) fits no gap: on top.
    slots = step(slots, ['c', 'd', 'e'])
    expect(label(slots)).toEqual(['d', 'gap@60', 'c', 'e'])
    // c goes and its room joins the gap below it; f (30) fits there, at the bottom.
    slots = step(slots, ['d', 'e', 'f'])
    expect(label(slots)).toEqual(['d', 'f', `gap@${60 + TOAST_GAP_PX + 50 - 30 - TOAST_GAP_PX}`, 'e'])
    // g (75) fits what is left (80) with too little over for a gap: it takes the gap's whole room.
    slots = step(slots, ['d', 'e', 'f', 'g'])
    expect(label(slots)).toEqual(['d', 'f', 'g@80', 'e'])
  })

  /** Each toast's offset from the stack's bottom (px), from the slots as drawn: a gap's room, a slot's height. */
  function offsets(heightOf: (id: string) => number): Map<string, number> {
    const out = new Map<string, number>()
    let y = 0
    for (const li of document.querySelectorAll<HTMLElement>('[aria-label="Notifications"] li')) {
      const id = li.getAttribute('data-toast-id')
      const room =
        id === null
          ? Number.parseFloat(li.style.height)
          : Math.max(Number.parseFloat(li.style.minHeight || '0'), heightOf(id))
      if (id !== null) out.set(id, y)
      y += room + TOAST_GAP_PX
    }
    return out
  }

  it(`never moves a toast on screen through a burst: at most ${TOAST_MAX} shown, the rest reuse the room`, () => {
    // Toasts of three heights (happy-dom lays nothing out).
    const heightOf = (id: string): number => 40 + 20 * (Number(id.slice(1)) % 3)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.dataset['toastCard']
      const height = id !== undefined ? heightOf(id) : 0
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height } as DOMRect
    })
    view()
    const seen = new Map<string, number>()
    const moved: string[] = []
    let top = 0
    const check = (): void => {
      for (const [id, y] of offsets(heightOf)) {
        const before = seen.get(id)
        if (before !== undefined && before !== y) moved.push(`${id}: ${before} → ${y}`)
        seen.set(id, y)
        top = Math.max(top, y + heightOf(id))
      }
    }
    // 14 failures arriving 1 to 4 s apart, each shown 10 s: older ones expire and get pushed out in between.
    for (let i = 1; i <= 14; i++) {
      act(() => {
        toast({ id: `t${i}`, level: 'error', message: `Failed ${i}` })
      })
      check()
      act(() => {
        vi.advanceTimersByTime(i % 4 === 0 ? 4000 : 1000)
      })
      check()
    }
    expect(moved).toEqual([])
    expect(useStore.getState().toasts.items.length).toBeLessThanOrEqual(TOAST_MAX)
    // The room is reused: the stack never climbs past twice what the toasts shown at once take.
    expect(top).toBeLessThanOrEqual(2 * TOAST_MAX * (80 + TOAST_GAP_PX))
    expect(seen.size).toBe(14)
  })

  it('keeps the stack above a bottom bar while the bar is mounted (useToastClearance)', () => {
    function Bar(): React.JSX.Element {
      const ref = useRef<HTMLDivElement>(null)
      useToastClearance(ref)
      return <div ref={ref}>bar</div>
    }
    const { unmount } = render(<Bar />)
    expect(document.documentElement.style.getPropertyValue('--toast-clearance')).toMatch(/^\d+px$/)
    unmount()
    expect(document.documentElement.style.getPropertyValue('--toast-clearance')).toBe('')
  })

  /** A bar asking for `px` of clearance (its own measure, as a sticky row passes one). */
  function Clear({ px }: { px: number }): React.JSX.Element {
    const ref = useRef<HTMLDivElement>(null)
    useToastClearance(ref, () => px)
    return <div ref={ref} />
  }
  const held = (): string =>
    screen.getByRole('region', { name: 'Notifications' }).style.getPropertyValue('--toast-clearance')

  it('clears the highest of several bars (the summary bar, a sticky action row above it)', () => {
    const bars = render(
      <>
        <Clear px={44} />
        <Clear px={100} />
      </>,
    )
    expect(document.documentElement.style.getPropertyValue('--toast-clearance')).toBe('100px')
    bars.rerender(<Clear px={44} />)
    expect(document.documentElement.style.getPropertyValue('--toast-clearance')).toBe('44px')
    bars.unmount()
    expect(document.documentElement.style.getPropertyValue('--toast-clearance')).toBe('')
  })

  it('never moves a toast on screen when a bar comes or goes: the stack holds its place until it is empty', () => {
    view()
    const bar = render(<Clear px={44} />)
    expect(held()).toBe('44px')
    act(() => {
      toast({ id: 'a', level: 'info', message: 'Plan ready', durationMs: null })
    })
    // A sticky action row arrives under the toast: the toast stays where it is.
    const row = render(<Clear px={120} />)
    expect(held()).toBe('44px')
    act(() => dismissToast('a'))
    // Empty, the stack takes the clearance the bars want now: the next toast clears the row.
    expect(held()).toBe('120px')
    row.unmount()
    bar.unmount()
    expect(held()).toBe('0px')
  })
})
