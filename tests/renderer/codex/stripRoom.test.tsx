// Integration (UI standards: async content never shifts the page; reserve its
// space; codex-sandbox.spec.ts): a fix that works long after its click (the Codex sandbox setup takes seconds, then core
// probes again) drops its chip from the open details on core's schedule. The details keep the room they reached, saying
// nothing blocks the run now, until the user hides them (or checks again), so the page below never jumps up by itself.
// ui-layout.spec.ts's walk measures it in the app; here the room is held with a measured height.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKeptHeight } from '@renderer/lib/keptHeight.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { bumpConfigEpoch, upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  authBlocker,
  check,
  fakeResolve,
  mountComposer,
  probe,
  report,
  runEstimate,
} from '../composer/fixtures.tsx'

let mock: MockDimFactory
const ROOM_PX = 120

beforeEach(() => {
  resetRecoveryForTests()
  setLiveSupportForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report({ blocking: [authBlocker] }),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
  // happy-dom lays nothing out: the open details measure ROOM_PX tall.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const h = this.getAttribute('data-testid') === 'preflight-details-room' ? ROOM_PX : 0
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 0, height: h, toJSON: () => ({}) }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  tearDown(mock)
})

const room = (): HTMLElement | null => screen.queryByTestId('preflight-details-room')

describe('the open preflight details keep their room', () => {
  it('when core drops every chip on its own, until the user hides the details', async () => {
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    expect(screen.getByTestId('preflight-chip-vendor.claude.auth')).toBeTruthy()
    expect(room()?.style.minHeight).toBe(`${ROOM_PX}px`)

    // Core checks again on its own (config-changed) and nothing blocks any more: the room stays, and says so.
    mock.on('preflight.run', () => report())
    act(() => bumpConfigEpoch())
    await settle(300)
    expect(screen.queryByTestId('preflight-chip-vendor.claude.auth')).toBeNull()
    expect(room()?.style.minHeight).toBe(`${ROOM_PX}px`)
    expect(screen.getByTestId('preflight-details-clear').textContent).toBe('Nothing blocks the run now.')
    const toggle = screen.getByTestId('preflight-details')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    // The user hides the details: the room goes, and with nothing to show there is no toggle either.
    fireEvent.click(toggle)
    await settle()
    expect(room()).toBeNull()
    expect(screen.queryByTestId('preflight-details')).toBeNull()
  })

  it('a chip the user opens or closes is measured again: closing it gives its room back', async () => {
    // The details are 60 px tall with the chip closed and 120 px with it open.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const open = this.querySelector('[aria-expanded="true"][aria-label^="Hide details:"]') !== null
      const h = this.getAttribute('data-testid') === 'preflight-details-room' ? (open ? 120 : 60) : 0
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 0, height: h, toJSON: () => ({}) }
    })
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    expect(room()?.style.minHeight).toBe('60px')
    const chip = screen.getByTestId('preflight-chip-vendor.claude.auth')
    fireEvent.click(chip.querySelector('button[aria-expanded]') as HTMLElement)
    await settle()
    expect(room()?.style.minHeight).toBe('120px')
    fireEvent.click(chip.querySelector('button[aria-expanded]') as HTMLElement)
    await settle()
    expect(room()?.style.minHeight).toBe('60px')
  })

  it('a chip core drops above others leaves its place, so the chips below it never move up by themselves', async () => {
    // Each chip measures 40 px, except the blocker (a fix control in it: 90 px).
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.getAttribute('data-testid') ?? ''
      const h = id === 'preflight-details-room' ? 200 : id === 'preflight-chip-vendor.claude.auth' ? 90 : 40
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 0, height: h, toJSON: () => ({}) }
    })
    const warnA = check('pass.implement.mode', { status: 'warn', title: 'Implement runs read-only' })
    const warnB = check('pass.fix.mode', { status: 'warn', title: 'Fix runs read-only' })
    const warnC = check('pass.review.relay', { status: 'warn', title: 'Review has no relay' })
    mock.on('preflight.run', () => report({ blocking: [authBlocker], warnings: [warnA, warnB] }))
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    const order = (): string[] =>
      Array.from(screen.getByTestId('preflight-chips').children).map(
        (e) => `${e.getAttribute('data-testid') ?? ''}@${e.getAttribute('data-slot') ?? ''}`,
      )
    expect(order()).toEqual([
      'preflight-chip-vendor.claude.auth@0',
      'preflight-chip-pass.implement.mode@1',
      'preflight-chip-pass.fix.mode@2',
    ])

    // Core checks again on its own and the blocker is gone: its place stays, as tall as the chip was.
    mock.on('preflight.run', () => report({ warnings: [warnA, warnB] }))
    act(() => bumpConfigEpoch())
    await settle(300)
    expect(order()).toEqual([
      'preflight-cleared-vendor.claude.auth@0',
      'preflight-chip-pass.implement.mode@1',
      'preflight-chip-pass.fix.mode@2',
    ])
    const cleared = screen.getByTestId('preflight-cleared-vendor.claude.auth')
    expect(cleared.textContent).toBe('Cleared: Claude needs you to log in')
    expect(cleared.style.minHeight).toBe('90px')
    expect(cleared.getAttribute('data-severity')).toBeNull()
    expect(screen.getByTestId('preflight-strip').querySelectorAll('[data-severity="blocking"]')).toHaveLength(
      0,
    )

    // A check reported later takes a free place.
    mock.on('preflight.run', () => report({ warnings: [warnA, warnB, warnC] }))
    act(() => bumpConfigEpoch())
    await settle(300)
    expect(order()).toEqual([
      'preflight-chip-pass.review.relay@0',
      'preflight-chip-pass.implement.mode@1',
      'preflight-chip-pass.fix.mode@2',
    ])
    expect(screen.getByTestId('preflight-chip-pass.review.relay').style.minHeight).toBe('90px')

    // One more with no free place waits rather than push the page down: the summary row counts it, the toggle says so.
    const warnD = check('pass.plan.relay', { status: 'warn', title: 'Plan has no relay' })
    mock.on('preflight.run', () => report({ warnings: [warnA, warnB, warnC, warnD] }))
    act(() => bumpConfigEpoch())
    await settle(300)
    expect(order()).toHaveLength(3)
    expect(screen.queryByTestId('preflight-chip-pass.plan.relay')).toBeNull()
    expect(room()?.getAttribute('data-waiting')).toBe('1')
    expect(screen.getByTestId('preflight-summary-text').textContent).toContain('4 warnings')
    expect(screen.getByTestId('preflight-details').getAttribute('title')).toBe(
      '1 more check reported since the details opened: hide and show them to see it',
    )

    // The user hides and opens the details again: the chips are laid out afresh, in core's order.
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    expect(order()).toEqual([
      'preflight-chip-pass.implement.mode@0',
      'preflight-chip-pass.fix.mode@1',
      'preflight-chip-pass.review.relay@2',
      'preflight-chip-pass.plan.relay@3',
    ])
    expect(room()?.getAttribute('data-waiting')).toBeNull()
  })

  it('"Check again" is the user asking: the room is not kept for its answer', async () => {
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    mock.on('preflight.run', () => report())
    await act(async () => {
      fireEvent.click(screen.getByTestId('preflight-recheck'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(screen.queryByTestId('preflight-chip-vendor.claude.auth')).toBeNull()
    expect(screen.queryByTestId('preflight-details-clear')).toBeNull()
  })
})

// The setup card's vendor rows hold the same rule (rail/SetupCard.tsx uses useKeptHeight): a row that says less once
// its vendor is ready keeps its tallest height while it lives.
function Rows({ lines }: { lines: number }): React.JSX.Element {
  const [ref, style] = useKeptHeight<HTMLUListElement>()
  return (
    <ul ref={ref} style={style} data-testid="kept" data-lines={lines}>
      {Array.from({ length: lines }, (_, i) => (
        <li key={i}>line {i}</li>
      ))}
    </ul>
  )
}

describe('useKeptHeight', () => {
  it('keeps the tallest height an element reached', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const h = Number(this.getAttribute('data-lines') ?? 0) * 20
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 0, height: h, toJSON: () => ({}) }
    })
    const view = render(<Rows lines={2} />)
    expect(screen.getByTestId('kept').style.minHeight).toBe('40px')
    // A remount measures again (the ResizeObserver happy-dom lacks would on a real resize).
    view.unmount()
    const again = render(<Rows lines={5} />)
    expect(screen.getByTestId('kept').style.minHeight).toBe('100px')
    again.rerender(<Rows lines={1} />)
    expect(screen.getByTestId('kept').style.minHeight).toBe('100px')
  })
})
