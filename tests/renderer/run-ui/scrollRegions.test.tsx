// The UI standards: one scroll region per screen, and nothing moves on its own, in
// the Run view, its cards and the attention panel. The view scrolls in the shell's page scroller (<main>) with its
// header, tabs and timeline sticky at the top and the SummaryBar at the bottom; only the whitelisted inner regions
// (the stream, the log rows, an ask's command, a snag's raw error, a card's text box) scroll inside it. A new ask or
// gate takes focus without scrolling and is announced; a jump pill shows while it is out of view and scrolls only when
// clicked. A stream follows new output only while the user is at its bottom. The plan and the findings read in the
// page flow with their actions sticky at the bottom of the reading area.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { Finding } from '@shared/findings.ts'
import type { AskView, CardView as CardData, RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { StreamPane } from '@renderer/components/run/StreamPane.tsx'
import { MainScrollContext } from '@renderer/components/shell/mainScroll.ts'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { resetCoreClock } from '@renderer/lib/coreClock.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import type { RunTab } from '@renderer/lib/router.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { RunPage } from '@renderer/pages/run/RunPage.tsx'
import { applySnapshot } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, runEvent, text } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, settle, snapWith } from '../run/helpers.tsx'

// ---- an IntersectionObserver the test drives (happy-dom's never reports) ----------------------------------------

type Where = 'in' | 'above' | 'below'

class FakeIO {
  static all: FakeIO[] = []
  readonly targets = new Set<Element>()
  readonly callback: IntersectionObserverCallback
  readonly options: IntersectionObserverInit
  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.callback = callback
    this.options = options
    FakeIO.all.push(this)
  }
  observe(el: Element): void {
    this.targets.add(el)
  }
  unobserve(el: Element): void {
    this.targets.delete(el)
  }
  disconnect(): void {
    this.targets.clear()
    FakeIO.all = FakeIO.all.filter((o) => o !== this)
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

/** Every observer watching `el` reports it in the view, scrolled past (above) or not reached yet (below). */
function report(el: Element, where: Where): void {
  const rootTop = 120
  const rect =
    where === 'above' ? { top: 0, bottom: 60 } : where === 'below' ? { top: 900, bottom: 1200 } : null
  for (const io of [...FakeIO.all]) {
    if (!io.targets.has(el)) continue
    const entry = {
      target: el,
      isIntersecting: where === 'in',
      intersectionRatio: where === 'in' ? 1 : 0,
      rootBounds: { top: rootTop, bottom: 800 },
      boundingClientRect: rect ?? { top: 200, bottom: 400 },
    } as unknown as IntersectionObserverEntry
    act(() => io.callback([entry], io as unknown as IntersectionObserver))
  }
}

// ---- the shell's page scroller, as Shell provides it ---------------------------------------------------------------

function InMain({ children }: { children: ReactNode }): React.JSX.Element {
  const [main, setMain] = useState<HTMLElement | null>(null)
  return (
    <main ref={setMain} data-testid="main">
      <MainScrollContext value={main}>{children}</MainScrollContext>
    </main>
  )
}

function inMain(ui: ReactNode): React.JSX.Element {
  return (
    <TooltipProvider>
      <InMain>{ui}</InMain>
      <Toaster />
    </TooltipProvider>
  )
}

/** The inner regions the standard allows (besides <main>, the page). */
const ALLOWED = new Set(['stream', 'log', 'ask-detail', 'snag-output', 'card-input'])
const SCROLLS = /(^|\s)overflow(-[xy])?-(auto|scroll)(\s|$)/

/** Elements under `root` styled to scroll, with the region each names (null: none, a stray scroller). */
function scrollers(root: Element): { testId: string | null; region: string | null }[] {
  return [...root.querySelectorAll<HTMLElement>('*')]
    .filter((el) => SCROLLS.test(el.getAttribute('class') ?? ''))
    .map((el) => ({ testId: el.dataset['testid'] ?? null, region: el.dataset['scrollRegion'] ?? null }))
}

const tokens = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/)

let mock: MockDimFactory
let log: RunEnvelope[]
let current: RunSnapshot
let release: (() => void) | null = null
let focus: MockInstance<HTMLElement['focus']>
let intoView: MockInstance<Element['scrollIntoView']>
let scrollTo: MockInstance<Element['scrollTo']>

const ask: AskView = {
  runId: RUN,
  step: 'implement',
  attempt: 1,
  requestId: 'req-1',
  vendor: 'claude',
  kind: 'shell',
  detail: 'npm test',
  expiresAt: Date.now() + 600_000,
  allowSession: true,
  queue: { index: 1, total: 1 },
}

const PLAN = Array.from({ length: 60 }, (_, i) => `${i + 1}. Step ${i + 1} of the plan`).join('\n')
const planGate: CardData = {
  id: 'gate:afterPlan-1',
  kind: 'gate:afterPlan',
  title: 'Review the plan',
  body: PLAN,
  payload: { plan: PLAN },
  blocking: true,
  choices: [
    { id: 'approve', label: 'Approve', primary: true, input: 'plan' },
    { id: 'cancel', label: 'Cancel run', danger: true },
  ],
}

function finding(n: number, severity: 'must' | 'should'): Finding {
  return { id: `f${n}`, n, severity, source: 'review', title: `Finding ${n}`, body: '', flags: [], round: 1 }
}
const findings = Array.from({ length: 30 }, (_, i) => finding(i + 1, i < 10 ? 'must' : 'should'))
const beforeFix: CardData = {
  id: 'gate:beforeFix-2',
  kind: 'gate:beforeFix',
  title: '30 findings before Fix',
  body: '',
  payload: { step: 'fix', findings, selected: findings.map((f) => f.id), notes: [] },
  blocking: true,
  choices: [
    { id: 'continue', label: 'Continue with 30 findings', primary: true, input: 'findings' },
    { id: 'skip-fix', label: 'Skip Fix' },
  ],
}

/** Implement running (with an ask when given); the plan gate open instead when `gate`. */
function snap(seq: number, o: { asks?: AskView[]; gate?: boolean } = {}): RunSnapshot {
  const asks = o.asks ?? []
  return snapWith({
    summary: {
      status: o.gate === true || asks.length > 0 ? 'waiting' : 'running',
      phase: o.gate === true ? 'plan-review' : 'implementing',
    },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1, vendor: 'claude' },
      implement:
        o.gate === true
          ? { status: 'queued' }
          : { status: asks.length > 0 ? 'waiting' : 'running', attempt: 1, vendor: 'claude' },
    },
    lastSeq: seq,
    extra: { asks, cards: o.gate === true ? [planGate] : [] },
  })
}

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  resetCoreClock()
  setMacForTests(false)
  window.location.hash = ''
  FakeIO.all = []
  vi.stubGlobal('IntersectionObserver', FakeIO)
  focus = vi.spyOn(HTMLElement.prototype, 'focus')
  intoView = vi.spyOn(Element.prototype, 'scrollIntoView')
  scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
  log = [env(RUN, 1, text('implement', 'Working on it\n'))]
  current = snap(1)
  mock = installMockDimFactory({
    handlers: {
      'runs.get': () => current,
      'runs.events': eventsHandler(() => log),
      'asks.answer': () => undefined,
      'cards.resolve': () => undefined,
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'none')
      },
    },
  })
})

afterEach(() => {
  release?.()
  release = null
  resetStopWatches()
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  resetCoreClock()
  setMacForTests(null)
  resetBridgeForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

async function mount(tab: RunTab = 'flow'): Promise<RenderResult> {
  release = startBridge()
  const r = render(inMain(<RunPage runId={RUN} tab={tab} />))
  await act(async () => {
    await settle(10)
  })
  await waitFor(() => expect(screen.getByTestId('run-header')).toBeTruthy())
  return r
}

function apply(s: RunSnapshot): void {
  current = s
  act(() => {
    applySnapshot(s)
  })
}

/** Nothing has scrolled anything: no scrollIntoView, no scrollTo, and focus never without preventScroll. */
function expectNoScroll(): void {
  expect(intoView).not.toHaveBeenCalled()
  expect(scrollTo).not.toHaveBeenCalled()
  for (const [opts] of focus.mock.calls as [FocusOptions | undefined][])
    expect(opts?.preventScroll).toBe(true)
  expect(screen.getByTestId('main').scrollTop).toBe(0)
}

describe('the Run view scrolls in the page scroller', () => {
  it('sticks the header, tabs and timeline to its top and the SummaryBar to its bottom, with no scroller of its own', async () => {
    current = snapWith({
      summary: { status: 'waiting', phase: 'implementing' },
      steps: {
        preflight: { status: 'done', attempt: 1 },
        plan: { status: 'done', attempt: 1, vendor: 'claude' },
        implement: { status: 'waiting', attempt: 1, vendor: 'claude' },
        review: {
          status: 'failed',
          attempt: 1,
          vendor: 'claude',
          failure: {
            category: 'unknown',
            message: 'It broke',
            raw: 'Traceback\n'.repeat(80),
            classifiedBy: 'heuristic',
          },
        },
      },
      lastSeq: 1,
      extra: { asks: [{ ...ask, detail: 'echo hi\n'.repeat(60) }], cards: [planGate] },
    })
    const view = await mount()
    const runView = screen.getByTestId('run-view')
    expect(screen.queryByTestId('run-scroll')).toBeNull()
    expect(tokens(runView)).toContain('min-h-full')
    expect(tokens(runView)).not.toContain('h-full')

    const top = screen.getByTestId('run-sticky-top')
    expect(tokens(top)).toEqual(expect.arrayContaining(['sticky', 'top-0']))
    for (const id of ['run-header', 'phase-timeline', 'jump-pills']) {
      expect(top.contains(screen.getByTestId(id))).toBe(true)
    }
    expect(top.contains(screen.getByRole('tablist', { name: 'Run views' }))).toBe(true)
    const bottom = screen.getByTestId('summary-bar').parentElement as HTMLElement
    expect(tokens(bottom)).toEqual(expect.arrayContaining(['sticky', 'bottom-0']))
    // Marked as the page's sticky bars: focus on their own controls drops their scroll padding (Tab never scrolls).
    expect(top.getAttribute('data-sticky-bar')).toBe('top')
    expect(bottom.getAttribute('data-sticky-bar')).toBe('bottom')
    // The full timeline's unseen twin (what the full block would take at this width) takes no room: a clipped box of
    // no height, and nothing in it is found, focused or read.
    const ruler = top.querySelector('[data-timeline-ruler]') as HTMLElement
    expect(ruler.getAttribute('aria-hidden')).toBe('true')
    expect(tokens(ruler.parentElement as HTMLElement)).toEqual(
      expect.arrayContaining(['absolute', 'h-0', 'overflow-clip', 'pointer-events-none']),
    )
    expect(ruler.querySelectorAll('[data-testid], button')).toHaveLength(0)

    // Every scroller inside the view is a whitelisted inner region; the plan and the diff are not scrollers.
    const found = scrollers(runView)
    expect(found.length).toBeGreaterThan(0)
    for (const s of found) expect(ALLOWED.has(s.region ?? ''), JSON.stringify(s)).toBe(true)
    expect(found.map((s) => s.region)).toEqual(
      expect.arrayContaining(['stream', 'ask-detail', 'snag-output']),
    )
    for (const el of runView.querySelectorAll('[data-scroll-region]')) {
      expect(tokens(el)).toContain('scroll-region')
      // Capped at the reading area less a strip of page too: the wheel always finds page beside it.
      expect(el.className.toString()).toMatch(/max-h-\[min\(\d+rem,var\(--run-region-max,\d+vh\)\)\]/)
    }

    // The page scroller keeps jumps, keyboard focus and the text cursor clear of the sticky blocks while the view is
    // mounted (its `page-scroller` utility adds these up): the header, the SummaryBar and the plan gate's action row.
    const main = screen.getByTestId('main')
    expect(main.style.getPropertyValue('--page-pad-top')).toMatch(/^\d+px$/)
    expect(main.style.getPropertyValue('--page-pad-bottom')).toMatch(/^\d+px$/)
    expect(screen.getByTestId('plan-gate-actions').hasAttribute('data-sticky-actions')).toBe(true)
    expect(main.style.getPropertyValue('--page-pad-row')).toMatch(/^\d+px$/)
    // The inner regions are capped at the reading area between the sticky blocks.
    expect(runView.style.getPropertyValue('--run-region-max')).toMatch(/^\d+px$/)
    view.unmount()
    expect(main.style.getPropertyValue('--page-pad-top')).toBe('')
    expect(main.style.getPropertyValue('--page-pad-bottom')).toBe('')
    expect(main.style.getPropertyValue('--page-pad-row')).toBe('')
  })

  it('keeps a step it has shown in place when it turns out unused', async () => {
    await mount()
    // Queued, Critic is a node in the timeline only: the Flow gets a step's card once it begins, at the flow's end.
    expect(screen.getByTestId('timeline-node-critic')).toBeTruthy()
    expect(screen.queryByTestId('pass-card-critic')).toBeNull()
    apply({
      ...current,
      steps: { ...current.steps, critic: { ...current.steps.critic, status: 'skipped', reason: 'disabled' } },
      lastSeq: 5,
    })
    const critic = screen.getByTestId('pass-card-critic')
    expect(critic.dataset['status']).toBe('skipped')
    expect(screen.getByTestId('pass-reason-critic').textContent).toContain('Skipped')
    expect(screen.getByTestId('timeline-node-critic')).toBeTruthy()
  })
})

describe('a new ask or gate never scrolls the page', () => {
  it('an ask takes focus without scrolling; its pill shows while it is out of view and scrolls only on click', async () => {
    await mount()
    apply(snap(2, { asks: [ask] }))
    const panel = screen.getByTestId('ask-panel')
    expect(document.activeElement).toBe(panel)
    expect(screen.getByTestId('ask-announcer').textContent).toContain('Claude asks to run: npm test.')
    // Not known yet, then in view: no pill.
    expect(screen.queryByTestId('jump-ask')).toBeNull()
    report(panel, 'in')
    expect(screen.queryByTestId('jump-ask')).toBeNull()

    // The user scrolled down past it: the pill offers it, and nothing scrolls by itself.
    report(panel, 'above')
    const pill = screen.getByTestId('jump-ask')
    expect(pill.textContent).toBe('Claude needs approval')
    expect(pill.dataset['where']).toBe('above')
    expectNoScroll()
    // The observer watches the page scroller, less the sticky header and SummaryBar.
    const io = FakeIO.all.find((o) => o.targets.has(panel))
    expect(io?.options.root).toBe(screen.getByTestId('main'))

    ;(document.activeElement as HTMLElement).blur()
    fireEvent.click(pill)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo.mock.contexts[0]).toBe(screen.getByTestId('main'))
    expect(intoView).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(panel)
    report(panel, 'in')
    expect(screen.queryByTestId('jump-ask')).toBeNull()
  })

  it('a plan gate takes focus without scrolling, is announced, and its pill jumps to it on click', async () => {
    await mount()
    apply(snap(2, { gate: true }))
    const gate = screen.getByTestId('card-gate:afterPlan')
    expect(document.activeElement).toBe(gate)
    expect(screen.getByTestId('card-announcer').textContent).toBe('Plan ready for review.')
    expect(screen.getByTestId('card-announcer').getAttribute('aria-live')).toBe('assertive')
    report(gate, 'below')
    const pill = screen.getByTestId('jump-plan')
    expect(pill.textContent).toBe('Plan ready for review')
    expect(pill.dataset['where']).toBe('below')
    expectNoScroll()

    fireEvent.click(pill)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo.mock.contexts[0]).toBe(screen.getByTestId('main'))
    expect(document.activeElement).toBe(gate)
  })

  it('from another tab, the gate pill opens Flow and then brings the card into view', async () => {
    current = snap(1, { gate: true })
    const view = await mount('log')
    expect(screen.queryByTestId('card-gate:afterPlan')).toBeNull()
    const pill = screen.getByTestId('jump-plan')
    expect(pill.dataset['where']).toBe('away')
    expect(scrollTo).not.toHaveBeenCalled()

    fireEvent.click(pill)
    expect(window.location.hash).toBe(`#/runs/${RUN}`)
    // The route drives the tab: Flow renders, then the jump lands on the card.
    await act(async () => {
      view.rerender(inMain(<RunPage runId={RUN} tab="flow" />))
      await settle()
    })
    const gate = screen.getByTestId('card-gate:afterPlan')
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(gate)
    // The pill's observer follows the card once Flow has mounted it: in view, the pill goes.
    await waitFor(() => expect(FakeIO.all.some((o) => o.targets.has(gate))).toBe(true))
    report(gate, 'in')
    expect(screen.queryByTestId('jump-plan')).toBeNull()
  })
})

describe('the stream follows only at its bottom', () => {
  function sized(el: HTMLElement, height: () => number, client = 200): void {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: height })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => client })
  }
  function add(seq: number): void {
    act(() => {
      streamBuffer.applyAll([env(RUN, seq, text('implement', `\nline ${seq} ${'x'.repeat(40)}`))])
      streamBuffer.flush()
    })
  }

  it('follows new output at its bottom; scrolled up it stays put, and Jump to latest follows again', () => {
    render(inMain(<StreamPane runId={RUN} step="implement" live />))
    add(1)
    const pane = screen.getByTestId('stream-implement')
    expect(pane.dataset['scrollRegion']).toBe('stream')
    expect(tokens(pane)).toEqual(expect.arrayContaining(['overflow-y-auto', 'scroll-region']))
    let height = 1000
    sized(pane, () => height)
    add(2)
    expect(pane.scrollTop).toBe(1000)
    expect(screen.queryByTestId('stream-jump-implement')).toBeNull()

    // The user scrolls up to read: new output no longer moves the pane.
    pane.scrollTop = 300
    fireEvent.scroll(pane)
    const jump = screen.getByTestId('stream-jump-implement')
    expect(jump.textContent).toBe('Jump to latest')
    height = 1400
    add(3)
    expect(pane.scrollTop).toBe(300)
    expect(intoView).not.toHaveBeenCalled()
    expect(screen.getByTestId('main').scrollTop).toBe(0)

    // Jump to latest: the bottom again, following from there, focus kept in the pane.
    fireEvent.click(jump)
    expect(pane.scrollTop).toBe(1400)
    expect(screen.queryByTestId('stream-jump-implement')).toBeNull()
    expect(document.activeElement).toBe(pane)
    height = 1600
    add(4)
    expect(pane.scrollTop).toBe(1600)
  })

  it('a live pane has its full height from the start and keeps it when the step finishes', () => {
    const view = render(inMain(<StreamPane runId={RUN} step="implement" live />))
    const pane = screen.getByTestId('stream-implement')
    expect(tokens(pane)).toContain('h-[min(28rem,var(--run-region-max,50vh))]')
    view.rerender(inMain(<StreamPane runId={RUN} step="implement" live={false} />))
    expect(tokens(pane)).toContain('h-[min(28rem,var(--run-region-max,50vh))]')
    // A pane opened over finished output is only as tall as its output, up to the same maximum.
    view.unmount()
    render(inMain(<StreamPane runId={RUN} step="implement" />))
    expect(tokens(screen.getByTestId('stream-implement'))).toContain(
      'max-h-[min(28rem,var(--run-region-max,50vh))]',
    )
  })

  it('the Log tab rows are an inner region under a fixed filter row, following only at their bottom', async () => {
    await mount('log')
    const rows = await waitFor(() => {
      const el = screen.getByTestId('log-rows')
      expect(el.querySelectorAll('[data-seq]')).toHaveLength(1)
      return el
    })
    expect(rows.dataset['scrollRegion']).toBe('log')
    expect(tokens(rows)).toEqual(expect.arrayContaining(['overflow-y-auto', 'scroll-region']))
    // At most 40rem and the reading area less a strip of page (RunPage sets --run-region-max).
    expect(tokens(rows)).toContain('max-h-[min(40rem,var(--run-region-max,60vh))]')
    expect(rows.contains(screen.getByTestId('log-step-filter'))).toBe(false)
    let height = 900
    sized(rows, () => height)
    rows.scrollTop = 100
    fireEvent.scroll(rows)
    expect(screen.getByTestId('log-jump')).toBeTruthy()
    height = 1100
    await act(async () => {
      log.push(env(RUN, 2, text('implement', 'more\n')))
      mock.push(runEvent(log[1] as RunEnvelope))
      await settle()
    })
    await waitFor(() => expect(rows.querySelectorAll('[data-seq]')).toHaveLength(2))
    expect(rows.scrollTop).toBe(100)
    fireEvent.click(screen.getByTestId('log-jump'))
    expect(rows.scrollTop).toBe(1100)
    expect(screen.queryByTestId('log-jump')).toBeNull()
  })
})

describe('cards read in the page flow, their actions stay in reach', () => {
  it('the plan gate shows the whole plan in flow, Approve, Cancel and Edit in one sticky row, the checkbox after it', () => {
    render(inMain(<CardView runId={RUN} card={planGate} folder="C:\\repo" />))
    const card = screen.getByTestId('card-gate:afterPlan')
    const preview = screen.getByTestId('plan-preview')
    expect(preview.textContent).toContain('Step 60 of the plan')
    expect(scrollers(card)).toEqual([])
    expect(tokens(preview).some((t) => t.startsWith('max-h') || t.startsWith('overflow'))).toBe(false)

    const actions = screen.getByTestId('plan-gate-actions')
    expect(tokens(actions)).toEqual(
      expect.arrayContaining(['sticky', 'bottom-[var(--run-sticky-bottom,0px)]']),
    )
    for (const id of ['card-choice-approve', 'card-choice-cancel', 'plan-edit']) {
      expect(actions.contains(screen.getByTestId(id)), id).toBe(true)
    }
    // The plan sits above the row, not inside it. "Don't stop after plan" (a setting for later runs) follows the row
    // in the card's flow: in a short window only the buttons stick, so the row keeps to one line of the reading area.
    expect(actions.contains(preview)).toBe(false)
    const skip = screen.getByTestId('plan-gate-skip')
    expect(actions.contains(skip)).toBe(false)
    expect(actions.nextElementSibling?.contains(skip)).toBe(true)
    expect(actions.parentElement?.lastElementChild?.contains(skip)).toBe(true)
    // The toast stack keeps above where the row sticks, so a toast never covers its buttons.
    expect(document.documentElement.style.getPropertyValue('--toast-clearance')).toMatch(/^\d+px$/)

    // Editing: the editor is as tall as the plan (no scroller, no resize handle); the edit links join the row.
    fireEvent.click(screen.getByTestId('plan-edit'))
    const editor = screen.getByTestId('plan-editor')
    expect(tokens(editor)).toEqual(expect.arrayContaining(['[field-sizing:content]', 'resize-none']))
    expect(tokens(editor).some((t) => t.startsWith('max-h'))).toBe(false)
    expect(editor.hasAttribute('data-scroll-region')).toBe(false)
    fireEvent.change(editor, { target: { value: `${PLAN}\n61. One more` } })
    expect(actions.contains(screen.getByTestId('plan-view-changes'))).toBe(true)
    expect(actions.contains(screen.getByTestId('plan-edit-counts'))).toBe(true)
    fireEvent.click(screen.getByTestId('plan-view-changes'))
    expect(scrollers(card)).toEqual([])
  })

  it('the gate before Fix lists its findings in flow; "Fix will receive" and the choices stay in reach', () => {
    render(inMain(<CardView runId={RUN} card={beforeFix} folder="C:\\repo" />))
    const card = screen.getByTestId('card-gate:beforeFix')
    expect(scrollers(card)).toEqual([])
    expect(
      screen.getByRole('list', { name: 'Findings' }).querySelectorAll('li[data-testid^="finding-"]'),
    ).toHaveLength(30)
    const actions = screen.getByTestId('before-fix-actions')
    expect(tokens(actions)).toContain('sticky')
    expect(actions.contains(screen.getByTestId('fix-receives'))).toBe(true)
    expect(actions.contains(screen.getByTestId('card-choice-continue'))).toBe(true)
    expect(actions.contains(screen.getByTestId('card-choice-skip-fix'))).toBe(true)
  })

  it('a card that opens takes focus without scrolling the page', () => {
    render(inMain(<CardView runId={RUN} card={planGate} folder="C:\\repo" autoFocus />))
    expect(document.activeElement).toBe(screen.getByTestId('card-gate:afterPlan'))
    expectNoScroll()
  })
})

describe('a pass card never changes under the user', () => {
  const running = snapWith({
    steps: {
      implement: {
        status: 'running',
        attempt: 1,
        vendor: 'claude',
        activeMs: 5000,
        usage: { input: 12_300, output: 4100 },
        cost: { usd: 0.42, basis: 'catalog', apiEquivalent: false },
      },
    },
  })
  const done: RunSnapshot = {
    ...running,
    steps: { ...running.steps, implement: { ...running.steps.implement, status: 'done' } },
  }

  it('keeps time, tokens and cost on a line of their own, out of the wrapping header', () => {
    render(inMain(<PassCard runId={RUN} snap={running} view={running.steps.implement} />))
    const metrics = screen.getByTestId('pass-metrics-implement')
    expect(metrics.textContent).toContain('12.3k in · 4.1k out')
    expect(metrics.textContent).toContain('$0.42 est.')
    expect(metrics.contains(screen.getByTestId('pass-time-implement'))).toBe(true)
    expect(metrics.closest('header')).toBeNull()
    expect(tokens(metrics)).toEqual(expect.arrayContaining(['h-4', 'whitespace-nowrap']))
  })

  it('a pass that finishes while the view is open stays open, in view or not; one already done starts collapsed', () => {
    for (const where of ['in', 'above', 'below'] as const) {
      const view = render(inMain(<PassCard runId={RUN} snap={running} view={running.steps.implement} />))
      report(screen.getByTestId('pass-card-implement'), where)
      view.rerender(inMain(<PassCard runId={RUN} snap={done} view={done.steps.implement} />))
      // Collapsing on its own would move the page (in view) or the page scroller under the user (above it).
      expect(screen.getByTestId('stream-implement')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Implement' }).getAttribute('aria-expanded')).toBe('true')
      view.unmount()
    }

    // The view opening on a finished pass: collapsed (a PassCard collapses once its pass is done).
    render(inMain(<PassCard runId={RUN} snap={done} view={done.steps.implement} />))
    expect(screen.queryByTestId('stream-implement')).toBeNull()
    expect(screen.getByRole('button', { name: 'Implement' }).getAttribute('aria-expanded')).toBe('false')
  })
})

// ---- what arrives mid-run lands at the end ------------------------------------------------------------------------

/** `a` comes before `b` in the document. */
function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/** Implement done, Review and Critic running, with core's notes. */
function reviewing(seq: number, notes: string[] = []): RunSnapshot {
  return snapWith({
    summary: { status: 'running', phase: 'reviewing' },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1, vendor: 'claude' },
      implement: { status: 'done', attempt: 1, vendor: 'claude' },
      review: { status: 'running', attempt: 1, vendor: 'claude' },
      critic: { status: 'running', attempt: 1, vendor: 'claude' },
    },
    lastSeq: seq,
    extra: { notes },
  })
}

describe('what arrives mid-run lands after everything on the page', () => {
  it('a queued step is a timeline node only; its card lands at the end of the flow when it begins', async () => {
    await mount()
    expect(screen.getByTestId('timeline-node-review')).toBeTruthy()
    expect(screen.queryByTestId('pass-card-review')).toBeNull()
    expect(screen.queryByTestId('pass-card-fix')).toBeNull()
    const implement = screen.getByTestId('pass-card-implement')

    apply(reviewing(3))
    const review = screen.getByTestId('pass-card-review')
    expect(before(implement, review)).toBe(true)
    expect(before(screen.getByTestId('pass-card-critic'), review)).toBe(false)
    // Implement finished while the view was open: it stays as it was (open), so nothing above Review moved.
    expect(screen.getByRole('button', { name: 'Implement' }).getAttribute('aria-expanded')).toBe('true')
    expectNoScroll()
  })

  it("core's notes land where they arrive: after what was there, before what comes later", async () => {
    await mount()
    apply({ ...snap(2), notes: ['The run-start snapshot failed: disk full'] })
    const first = screen.getByText('The run-start snapshot failed: disk full')
    expect(before(screen.getByTestId('pass-card-implement'), first)).toBe(true)

    apply(reviewing(3, ['The run-start snapshot failed: disk full']))
    const review = screen.getByTestId('pass-card-review')
    // The note stays where it was; Review lands after it.
    expect(before(screen.getByText('The run-start snapshot failed: disk full'), review)).toBe(true)

    apply(reviewing(4, ['The run-start snapshot failed: disk full', 'Auto: "Stall" → Keep waiting']))
    expect(before(review, screen.getByText('Auto: "Stall" → Keep waiting'))).toBe(true)
    expect(screen.getAllByTestId('run-notes')).toHaveLength(2)
  })

  it("an ask follows the tab's content, so it never pushes what the user reads", async () => {
    await mount()
    apply(snap(2, { asks: [ask] }))
    expect(before(screen.getByTestId('flow-tab'), screen.getByTestId('ask-panel'))).toBe(true)
    expectNoScroll()
  })

  it("the session line core decides after the step began comes after the step's output", () => {
    const s = snapWith({
      summary: { status: 'running', phase: 'fixing' },
      steps: {
        fix: { status: 'running', attempt: 1, vendor: 'claude', sessionNote: 'reused the Implement session' },
      },
      lastSeq: 1,
    })
    render(inMain(<PassCard runId={RUN} snap={s} view={s.steps.fix} />))
    expect(before(screen.getByTestId('stream-fix'), screen.getByTestId('session-line-fix'))).toBe(true)
  })

  it('the run ending moves nothing in its header: Stop leaves its room, the outcome takes the phase box', async () => {
    await mount()
    const status = screen.getByTestId('run-status')
    // The status keeps its widest label's width.
    expect(status.querySelector('[data-stable-label]')).toBeTruthy()
    expect(screen.getByTestId('stop-run')).toBeTruthy()
    apply(
      snapWith({
        summary: { status: 'completed', phase: 'done', outcome: 'clean', endedAt: Date.now() },
        steps: {
          preflight: { status: 'done', attempt: 1 },
          plan: { status: 'done', attempt: 1, vendor: 'claude' },
          implement: { status: 'done', attempt: 1, vendor: 'claude' },
        },
        lastSeq: 9,
      }),
    )
    expect(screen.queryByTestId('stop-run')).toBeNull()
    const room = screen.getByTestId('stop-run-room')
    expect(tokens(room)).toContain('invisible')
    expect(room.getAttribute('aria-hidden')).toBe('true')
    const outcome = screen.getByTestId('run-outcome')
    expect(outcome.textContent).toBe('Clean: no findings')
    const phase = screen.getByTestId('run-phase')
    expect(tokens(phase)).toContain('invisible')
    expect(outcome.parentElement).toBe(phase.parentElement)
    expect(tokens(outcome)).toEqual(expect.arrayContaining(['absolute', 'truncate']))
    // The time comes last on the line: its ETA coming and going moves nothing.
    expect(before(screen.getByTestId('run-cost'), screen.getByTestId('run-elapsed'))).toBe(true)
  })
})
