// Git surfaces under the UI standards: a reconcile or planMutated card arriving mid-run
// takes focus without scrolling, is announced, and offers a jump pill while out of view (only a click scrolls); the
// step chip core sets on Implement shows in its header from the start; Revert all and the branch actions keep their
// label and width while busy (the spinner takes the icon slot); and none of the new text has an em dash.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { RevertResult } from '@shared/ipc.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { resetBranchOutcomesForTests } from '@renderer/components/run/branch.ts'
import { jumpTargets } from '@renderer/components/run/JumpPills.tsx'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { resetRevertForTests } from '@renderer/components/run/revert.ts'
import { RunEndPanel } from '@renderer/components/run/RunEndPanel.tsx'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { MainScrollContext } from '@renderer/components/shell/mainScroll.ts'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { RUN_BRANCH_HINT } from '@renderer/pages/dashboard/composer/IsolationControls.tsx'
import { RunPage } from '@renderer/pages/run/RunPage.tsx'
import { applySnapshot } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { deferred, installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from '../run/helpers.tsx'
import { blockCard, overlapCard, planMutatedCard, RUN_BRANCH } from './fixtures.ts'

const EM_DASH = '\u2014'

// ---- an IntersectionObserver the test drives (happy-dom's never reports) ----------------------------------------

class FakeIO {
  static all: FakeIO[] = []
  readonly targets = new Set<Element>()
  readonly callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
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

/** Every observer watching `el` reports it below the reading area (not reached yet). */
function reportBelow(el: Element): void {
  for (const io of [...FakeIO.all]) {
    if (!io.targets.has(el)) continue
    const entry = {
      target: el,
      isIntersecting: false,
      intersectionRatio: 0,
      rootBounds: { top: 120, bottom: 800 },
      boundingClientRect: { top: 900, bottom: 1200 },
    } as unknown as IntersectionObserverEntry
    act(() => io.callback([entry], io as unknown as IntersectionObserver))
  }
}

function InMain({ children }: { children: ReactNode }): React.JSX.Element {
  const [main, setMain] = useState<HTMLElement | null>(null)
  return (
    <main ref={setMain} data-testid="main">
      <MainScrollContext value={main}>{children}</MainScrollContext>
    </main>
  )
}

let mock: MockDimFactory
let current: RunSnapshot
let release: (() => void) | null = null
let focus: MockInstance<HTMLElement['focus']>
let intoView: MockInstance<Element['scrollIntoView']>
let scrollTo: MockInstance<Element['scrollTo']>

const implementing = (lastSeq = 1, over: Partial<RunSnapshot> = {}): RunSnapshot => ({
  ...snapWith({
    summary: { status: 'running', phase: 'implementing' },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1, vendor: 'claude' },
      implement: {
        status: 'running',
        attempt: 1,
        vendor: 'claude',
        chip: '3 files changed during planning',
      },
    },
    lastSeq,
  }),
  ...over,
})

/** A run that ended after Implement changed files. */
const endedSnap = (status: 'completed' | 'cancelled'): RunSnapshot =>
  snapWith({
    summary: {
      status,
      phase: 'done',
      outcome: status === 'completed' ? 'clean' : 'failed',
      progress: { tokens: 1, costUsd: null, filesChanged: 2 },
    },
    steps: { implement: { status: status === 'completed' ? 'done' : 'cancelled', attempt: 1 } },
  })

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  resetRecoveryForTests()
  resetLaterChoicesForTests()
  resetRevertForTests()
  resetBranchOutcomesForTests()
  setMacForTests(false)
  window.location.hash = ''
  FakeIO.all = []
  vi.stubGlobal('IntersectionObserver', FakeIO)
  focus = vi.spyOn(HTMLElement.prototype, 'focus')
  intoView = vi.spyOn(Element.prototype, 'scrollIntoView')
  scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
  current = implementing()
  mock = installMockDimFactory({
    handlers: {
      'runs.get': () => current,
      'runs.events': eventsHandler(() => []),
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
  setMacForTests(null)
  resetBridgeForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

async function mount(): Promise<void> {
  release = startBridge()
  render(
    <TooltipProvider>
      <InMain>
        <RunPage runId={RUN} tab="flow" />
      </InMain>
      <Toaster />
    </TooltipProvider>,
  )
  await act(async () => {
    await settle(10)
  })
  await waitFor(() => expect(screen.getByTestId('run-header')).toBeTruthy())
}

function apply(s: RunSnapshot): void {
  current = s
  act(() => {
    applySnapshot(s)
  })
}

function expectNoScroll(): void {
  expect(intoView).not.toHaveBeenCalled()
  expect(scrollTo).not.toHaveBeenCalled()
  for (const [opts] of focus.mock.calls as [FocusOptions | undefined][])
    expect(opts?.preventScroll).toBe(true)
}

/** Every text and text attribute under `root` (what a user reads or hears). */
function allText(root: Element): string {
  const parts = [root.textContent ?? '']
  for (const el of root.querySelectorAll('*'))
    for (const a of ['title', 'aria-label', 'data-label', 'placeholder']) {
      const v = el.getAttribute(a)
      if (v !== null) parts.push(v)
    }
  return parts.join('\n')
}

describe('a reconcile card arriving mid-run', () => {
  it('takes focus without scrolling, is announced, and its pill jumps on click only', async () => {
    await mount()
    ;(document.activeElement as HTMLElement | null)?.blur()
    const card = overlapCard()
    apply(implementing(2, { cards: [card] }))
    const el = screen.getByTestId('card-reconcile')
    expect(document.activeElement).toBe(el)
    expect(screen.getByTestId('card-announcer').textContent).toBe(`${card.title}.`)
    expect(jumpTargets(current).map((t) => [t.kind, t.label])).toEqual([['card', card.title]])
    reportBelow(el)
    const pill = screen.getByTestId('jump-card')
    expect(pill.textContent).toBe(card.title)
    expectNoScroll()
    fireEvent.click(pill)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo.mock.contexts[0]).toBe(screen.getByTestId('main'))
  })

  it('a planMutated card takes focus and is announced the same way', async () => {
    await mount()
    ;(document.activeElement as HTMLElement | null)?.blur()
    apply(implementing(2, { cards: [planMutatedCard()] }))
    expect(document.activeElement).toBe(screen.getByTestId('card-planMutated'))
    expect(screen.getByTestId('card-announcer').textContent).toBe('Plan changed files.')
    expectNoScroll()
  })

  it("shows Implement's chip in its header from the start", async () => {
    await mount()
    const chip = screen.getByTestId('step-chip-implement')
    expect(chip.textContent).toBe('3 files changed during planning')
    expect(screen.getByTestId('pass-card-implement').querySelector('header')?.contains(chip)).toBe(true)
  })
})

describe('controls keep their label and width while busy', () => {
  it('Revert all: same label, spinner in the icon slot, aria-busy', async () => {
    const hold = deferred<RevertResult>()
    mock.on('diff.revert', () => hold.promise)
    const ended = {
      ...endedSnap('completed'),
      branch: RUN_BRANCH,
    }
    renderUi(<RunEndPanel snap={ended} />)
    const before = screen.getByTestId('revert-all')
    const icon = before.querySelector('svg')
    await act(async () => {
      fireEvent.click(before)
      await settle()
    })
    const busy = screen.getByTestId('revert-all')
    expect(busy).toBe(before)
    expect(busy.textContent).toBe('Revert all')
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(busy.querySelectorAll('svg')).toHaveLength(1)
    expect(busy.querySelector('[data-spinner]')).not.toBeNull()
    expect(icon).not.toBeNull()
    // The branch buttons wait (disabled), each keeping its label.
    expect(screen.getByTestId('branch-return').textContent).toBe('Return to main')
    await act(async () => {
      hold.resolve({ undoToken: 'u', restored: ['a'], deleted: [], skipped: [] })
      await settle()
    })
    expect(screen.getByTestId('revert-all').getAttribute('aria-busy')).toBeNull()
  })

  it('Return to main: same label while core answers, then the outcome beside, not in, the button', async () => {
    const hold = deferred<{ done: boolean; commands: string[] }>()
    mock.on('runs.branch', () => hold.promise)
    const ended = {
      ...endedSnap('completed'),
      branch: RUN_BRANCH,
    }
    renderUi(<RunEndPanel snap={ended} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('branch-return'))
      await settle()
    })
    const busy = screen.getByTestId('branch-return')
    expect(busy.textContent).toBe('Return to main')
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId<HTMLButtonElement>('branch-delete').disabled).toBe(true)
    await act(async () => {
      hold.resolve({ done: true, commands: [] })
      await settle()
    })
    expect(screen.getByTestId('branch-return').textContent).toBe('Return to main')
    expect(screen.getByTestId('branch-return-done').textContent).toBe('Back on main.')
  })
})

describe('no em dashes', () => {
  it('in the new cards, the end-of-run panel, its answers and the toasts', async () => {
    mock.on('runs.branch', () => ({
      done: false,
      reason: 'dim/20261008-add-version-flag has commits the run did not make, so Dim Factory keeps it.',
      commands: ['git branch -d dim/20261008-add-version-flag'],
    }))
    mock.on('diff.revert', () => ({
      undoToken: 'u',
      restored: ['a'],
      deleted: [],
      skipped: [{ path: 'vendor/lib', reason: 'gitlink' }],
    }))
    const many = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`)
    const ui = renderUi(
      <>
        <CardView
          runId={RUN}
          card={overlapCard({ external: many, overlapping: many.slice(0, 2) })}
          folder="C:\\r"
        />
        <CardView runId={RUN} card={blockCard()} folder="C:\\r" />
        <CardView runId={RUN} card={blockCard({ action: true })} folder="C:\\r" />
        <CardView runId={RUN} card={planMutatedCard()} folder="C:\\r" />
        <RunEndPanel
          snap={{
            ...endedSnap('cancelled'),
            branch: RUN_BRANCH,
          }}
        />
      </>,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('branch-delete'))
      await settle()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('revert-all'))
      await settle()
    })
    expect(allText(ui.container)).not.toContain(EM_DASH)
    for (const t of useStore.getState().toasts.items) expect(t.message).not.toContain(EM_DASH)
    expect(RUN_BRANCH_HINT).not.toContain(EM_DASH)
  })
})
