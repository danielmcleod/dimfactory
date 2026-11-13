// The composer in the page's flow and its compact Run bar (UI standards: one
// scroll region per screen, and nothing moves on its own). The composer has no scroller of its own and never shrinks
// as the page scrolls; once its Run row is scrolled past (an IntersectionObserver rooted at <main>, mocked here), a
// bar hung from a zero-height sticky wrapper overlays the page's top with the task and the same Run control. Showing
// it moves no layout and no focus; only the user's click on the task scrolls the page back.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Shell } from '@renderer/components/shell/Shell.tsx'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { COMPACT_BAR_PX } from '@renderer/pages/dashboard/composer/CompactRunBar.tsx'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { QuickComposer } from '@renderer/pages/dashboard/QuickComposer.tsx'
import { LAST_FOLDER_KEY } from '@renderer/pages/dashboard/composer-model.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { authBlocker, fakeResolve, FOLDER, probe, report, runEstimate } from './fixtures.tsx'

// ---- a controllable IntersectionObserver ----------------------------------------------------------------------------

interface Observed {
  callback: IntersectionObserverCallback
  options: IntersectionObserverInit | undefined
  targets: Element[]
  observer: IntersectionObserver
}

let observers: Observed[] = []

class FakeIntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: readonly number[] = []
  private readonly entry: Observed
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.entry = { callback, options, targets: [], observer: this as unknown as IntersectionObserver }
    observers.push(this.entry)
  }
  observe(target: Element): void {
    this.entry.targets.push(target)
  }
  unobserve(target: Element): void {
    this.entry.targets = this.entry.targets.filter((t) => t !== target)
  }
  disconnect(): void {
    this.entry.targets = []
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

const rect = (top: number, bottom: number): DOMRectReadOnly =>
  ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top }) as DOMRectReadOnly

/** The observer watching the composer's Run row. */
function rowObserver(): Observed {
  const row = screen.getByTestId('composer-run-row')
  const o = observers.find((x) => x.targets.includes(row))
  if (o === undefined) throw new Error('nothing observes the Run row')
  return o
}

/** Where the Run row is now: in main's view, scrolled past it (above), or not reached (below). */
function rowIs(where: 'in' | 'above' | 'below'): void {
  const o = rowObserver()
  const target = o.targets[0] as Element
  const top = where === 'above' ? -60 : where === 'below' ? 900 : 200
  act(() => {
    o.callback(
      [
        {
          target,
          isIntersecting: where === 'in',
          intersectionRatio: where === 'in' ? 1 : 0,
          boundingClientRect: rect(top, top + 32),
          intersectionRect: rect(0, 0),
          rootBounds: rect(COMPACT_BAR_PX, 600),
          time: 0,
        },
      ],
      o.observer,
    )
  })
}

// ---- setup ----------------------------------------------------------------------------------------------------------

let mock: MockDimFactory

beforeEach(() => {
  observers = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  resetRecoveryForTests()
  setLiveSupportForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => {
  tearDown(mock)
  vi.unstubAllGlobals()
})

async function mount(): Promise<void> {
  window.localStorage.setItem(LAST_FOLDER_KEY, FOLDER)
  render(
    <Providers>
      <Shell>
        <div className="flex min-h-full flex-col">
          <QuickComposer />
        </div>
      </Shell>
    </Providers>,
  )
  await settle(300)
}

async function typeTask(text = 'Add a --version flag'): Promise<void> {
  fireEvent.change(screen.getByTestId('composer-task'), { target: { value: text } })
  await settle()
}

const bar = (): HTMLElement => screen.getByTestId('compact-bar')
const classes = (el: Element): string[] => el.className.toString().split(/\s+/)

// ---- tests ----------------------------------------------------------------------------------------------------------

describe('the composer in the page', () => {
  it('has no scroller of its own, is not sticky and never compacts', async () => {
    await mount()
    const composer = screen.getByTestId('composer')
    expect(classes(composer)).not.toEqual(expect.arrayContaining(['sticky']))
    expect(composer.className).not.toMatch(/overflow|max-h-/)
    expect(composer.hasAttribute('data-compact')).toBe(false)
    rowIs('above')
    // Scrolled past, it is still all there: the strip, the estimate and the passes keep their places.
    expect(screen.getByTestId('preflight-strip')).toBeTruthy()
    expect(screen.getByTestId('estimate-line')).toBeTruthy()
    expect(screen.getByTestId('composer-passes-toggle')).toBeTruthy()
    expect(screen.getByTestId('composer-task').getAttribute('rows')).toBe('3')
  })

  it('lets the task box grow only with what is typed, to a fixed height, as an input region', async () => {
    await mount()
    const task = screen.getByTestId('composer-task')
    expect(task.getAttribute('data-scroll-region')).toBe('task-input')
    expect(classes(task)).toEqual(
      expect.arrayContaining([
        'field-sizing-content',
        'min-h-20',
        'max-h-60',
        'resize-none',
        'scroll-region',
      ]),
    )
    expect(classes(task)).not.toContain('resize-y')
  })
})

describe('the compact Run bar', () => {
  it("watches the Run row from <main>, under the bar's height, and shows only once that row is scrolled past", async () => {
    await mount()
    const o = rowObserver()
    expect(o.options?.root).toBe(screen.getByTestId('main'))
    expect(o.options?.rootMargin).toBe(`-${COMPACT_BAR_PX}px 0px 0px 0px`)
    expect(bar().hidden).toBe(true)
    expect(screen.queryByTestId('compact-run')).toBeNull()
    rowIs('below')
    expect(bar().hidden).toBe(true)
    rowIs('above')
    expect(bar().hidden).toBe(false)
    expect(bar().hasAttribute('inert')).toBe(false)
    expect(within(bar()).getByTestId('compact-folder').textContent).toBe('repo')
    expect(within(bar()).getByTestId('compact-run')).toBeTruthy()
    rowIs('in')
    expect(bar().hidden).toBe(true)
    expect(bar().hasAttribute('inert')).toBe(true)
    expect(screen.queryByTestId('compact-run')).toBeNull()
  })

  it('overlays the page: a zero-height sticky anchor and an absolute bar, so showing it moves nothing', async () => {
    await mount()
    const anchor = screen.getByTestId('compact-bar-anchor')
    expect(classes(anchor)).toEqual(expect.arrayContaining(['sticky', 'top-0', 'h-0']))
    expect(classes(bar())).toEqual(expect.arrayContaining(['absolute', 'inset-x-0', 'top-0']))
    expect(bar().style.height).toBe(`${COMPACT_BAR_PX}px`)
    // It comes before the composer in the page, inside the same column, so it sticks to main's top.
    expect(anchor.nextElementSibling).toBe(screen.getByTestId('composer'))
  })

  it("keeps keyboard focus and the text cursor out from under it: main's top scroll padding while it shows", async () => {
    await mount()
    const main = screen.getByTestId('main')
    const padTop = (): string => main.style.getPropertyValue('--page-pad-top')
    expect(padTop()).toBe('0px')
    rowIs('above')
    // Its height and a little room: Shift+Tab to a control under it brings that control below it.
    expect(Number.parseFloat(padTop())).toBeGreaterThan(COMPACT_BAR_PX)
    expect(main.style.getPropertyValue('--page-pad-bottom')).toBe('0px')
    // A sticky bar: focus on its own controls drops that padding (the `page-scroller` utility), so Tab through the
    // bar never scrolls the page.
    expect(bar().getAttribute('data-sticky-bar')).toBe('top')
    rowIs('in')
    expect(padTop()).toBe('0px')
  })

  it('moves no focus when it appears', async () => {
    await mount()
    const task = screen.getByTestId('composer-task')
    act(() => task.focus())
    rowIs('above')
    expect(document.activeElement).toBe(task)
  })

  it('shows the task on one line and the same Run: label, reserved widths, status and disabled reason', async () => {
    mock.on('preflight.run', () => report({ blocking: [authBlocker] }))
    await mount()
    rowIs('above')
    const b = bar()
    // No task yet: both Runs are disabled for the same reason, read from a focusable wrapper.
    expect(within(b).getByTestId('compact-task').textContent).toBe('Edit the task: Describe the task')
    expect(within(b).getByLabelText('Describe the task first')).toBeTruthy()
    expect(within(b).getByTestId<HTMLButtonElement>('compact-run').disabled).toBe(true)
    await typeTask('Add a --version flag\nand a test for it')
    expect(within(b).getByTestId('compact-task').textContent).toBe('Edit the task: Add a --version flag')
    const run = within(b).getByTestId('compact-run')
    expect([...run.querySelectorAll('[data-label]')].map((r) => r.getAttribute('data-label'))).toEqual([
      'Run',
      'Queue',
    ])
    expect(within(b).getByTestId('compact-run-status').textContent).toBe('Fix 1 issue to run')
    expect(screen.getByTestId('composer-run-status').textContent).toBe('Fix 1 issue to run')
    expect(run.getAttribute('aria-describedby')).toBe('compact-run-status')
    expect(within(b).getByLabelText('Fix 1 issue to run: Claude needs you to log in')).toBeTruthy()
  })

  it('starts the run from the bar', async () => {
    mock.on('runs.start', () => ({ runId: 'r9', displayNo: 9 }))
    await mount()
    await typeTask()
    rowIs('above')
    await act(async () => {
      fireEvent.click(within(bar()).getByTestId('compact-run'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toEqual([{ folder: FOLDER, task: 'Add a --version flag' }])
    expect(window.location.hash).toBe('#/runs/r9')
  })

  it("brings the composer back and puts the cursor in the task box on the user's click, and only then", async () => {
    await mount()
    await typeTask()
    const main = screen.getByTestId('main')
    const scrollTo = vi.fn()
    main.scrollTo = scrollTo as typeof main.scrollTo
    rowIs('above')
    expect(scrollTo).not.toHaveBeenCalled()
    fireEvent.click(within(bar()).getByTestId('compact-task'))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    expect(document.activeElement).toBe(screen.getByTestId('composer-task'))
  })

  it('hands focus to the task box, without scrolling, when it hides with focus inside', async () => {
    await mount()
    await typeTask()
    const main = screen.getByTestId('main')
    const scrollTo = vi.fn()
    main.scrollTo = scrollTo as typeof main.scrollTo
    rowIs('above')
    const run = within(bar()).getByTestId('compact-run')
    act(() => run.focus())
    expect(document.activeElement).toBe(run)
    rowIs('in')
    expect(document.activeElement).toBe(screen.getByTestId('composer-task'))
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
