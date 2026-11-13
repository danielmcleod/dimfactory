// components/run/SummaryBar: the bar's strings — `Plan ✓ approved (edited)` · `3 must · 5 should` ·
// `7 files +120 −34` · tokens · `$0.62 est.` — and Open diff.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { SummaryBar, planShortText, planText } from '@renderer/components/run/SummaryBar.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, runEvent } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from './helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  clearToasts()
  clearOutputCache()
  log = []
  mock = installMockDimFactory({
    handlers: {
      'runs.events': eventsHandler(() => log),
      'runs.output': (req) => {
        if (req.file === 'plan') return { text: 'new plan\n', mtime: 1, version: 2 }
        if (req.file === 'plan.original') return { text: 'old plan\n', mtime: 1, version: 1 }
        throw mockError('NOT_FOUND', 'none')
      },
    },
  })
})

afterEach(() => {
  mock.uninstall()
  clearToasts()
  resetBridgeForTests()
})

const finished = snapWith({
  summary: {
    status: 'completed',
    phase: 'done',
    outcome: 'fixed',
    findings: { must: 3, should: 5 },
    progress: { tokens: 123_400, costUsd: 0.62, filesChanged: 7 },
    steps: [{ key: 'implement', status: 'done', activeMs: 1, costBasis: 'catalog' }],
  },
  steps: {
    plan: { status: 'done', attempt: 1 },
    review: { status: 'done', attempt: 1 },
    critic: { status: 'done', attempt: 1 },
  },
})

describe('SummaryBar', () => {
  it('words the run summary exactly', async () => {
    log = [env(RUN, 4, { t: 'diff-stats', files: 7, added: 120, deleted: 34, live: false })]
    let opened = 0
    renderUi(<SummaryBar snap={finished} onOpenDiff={() => opened++} />)
    await waitFor(() =>
      expect(screen.getByTestId('summary-plan').textContent).toBe('Plan ✓ approved (edited)'),
    )
    expect(screen.getByTestId('summary-findings').textContent).toBe('3 must · 5 should')
    await waitFor(() => expect(screen.getByTestId('summary-files').textContent).toBe('7 files +120 −34'))
    expect(screen.getByTestId('summary-tokens').textContent).toBe('123.4k tokens')
    expect(screen.getByTestId('summary-cost').textContent).toBe('$0.62 est.')
    fireEvent.click(screen.getByTestId('open-diff'))
    expect(opened).toBe(1)
    expect(screen.getByTestId('open-diff').getAttribute('aria-keyshortcuts')).toBe('Control+Shift+D')
  })

  it('updates the file line from live diff-stats events', async () => {
    const snap = snapWith({
      summary: { progress: { tokens: 0, costUsd: null, filesChanged: 2 } },
      steps: { implement: { status: 'running', attempt: 1 } },
    })
    renderUi(<SummaryBar snap={snap} onOpenDiff={() => undefined} />)
    await waitFor(() => expect(screen.getByTestId('summary-files').textContent).toBe('2 files'))
    expect(screen.queryByTestId('summary-findings')).toBeNull()
    // Running, and no step has reported usage yet: no figure YET (not "no price known").
    expect(screen.getByTestId('summary-cost').textContent).toBe('No cost yet')
    await act(async () => {
      mock.push(runEvent(env(RUN, 9, { t: 'diff-stats', files: 2, added: 10, deleted: 1, live: true })))
      await settle()
    })
    expect(screen.getByTestId('summary-files').textContent).toBe('2 files +10 −1')
  })

  it('says where the plan stands', () => {
    expect(planText(snapWith(), false)).toBe('Plan · queued')
    expect(planText(snapWith({ steps: { plan: { status: 'running', attempt: 1 } } }), false)).toBe(
      'Plan · running',
    )
    const gate = snapWith({
      steps: { plan: { status: 'done', attempt: 1 } },
      extra: {
        cards: [
          {
            id: 'g',
            kind: 'gate:afterPlan',
            title: 'Review the plan',
            body: '',
            payload: {},
            blocking: true,
            choices: [],
          },
        ],
      },
    })
    expect(planText(gate, false)).toBe('Plan ready for review')
    const done = snapWith({ steps: { plan: { status: 'done', attempt: 1 } } })
    // "approved" only from core's gate card; no gate (Auto, gates.afterPlan off) or not known yet: "Plan done".
    expect(planText(done, false, 'approved')).toBe('Plan ✓ approved')
    expect(planText(done, false, 'none')).toBe('Plan done')
    expect(planText(done, false)).toBe('Plan done')
    expect(planText(done, false, 'cancelled')).toBe('Plan not approved')
    expect(planText(done, true)).toBe('Plan ✓ approved (edited)')
    expect(planText(snapWith({ steps: { plan: { status: 'skipped', reason: 'disabled' } } }), false)).toBe(
      'Plan skipped · turned off',
    )
  })

  // Control standards: one line at any size; where the bar is narrow (a small window, a large zoom) things
  // give way whole, by the bar's own width (a size container), before any text is cut.
  it('lets the key hint, then the tokens, then the plan words give way whole where the bar is narrow', async () => {
    log = [env(RUN, 4, { t: 'diff-stats', files: 7, added: 120, deleted: 34, live: false })]
    renderUi(<SummaryBar snap={finished} onOpenDiff={() => undefined} />)
    await waitFor(() =>
      expect(screen.getByTestId('summary-plan').textContent).toBe('Plan ✓ approved (edited)'),
    )
    const bar = screen.getByTestId('summary-bar')
    const classes = (el: Element | null | undefined): string[] => el?.getAttribute('class')?.split(' ') ?? []
    expect(classes(bar)).toContain('@container')
    // Open diff: the key hint goes under 48 rem; the shortcut stays in aria-keyshortcuts and the tooltip.
    const open = screen.getByTestId('open-diff')
    expect(classes(open.querySelector('kbd'))).toContain('@max-[48rem]:hidden')
    expect(open.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+D')
    expect(open.hasAttribute('data-tooltip')).toBe(true)
    // The tokens go whole (with their separator) under 42 rem.
    expect(classes(screen.getByTestId('summary-tokens').parentElement)).toContain('@max-[42rem]:hidden')
    // Under 36 rem the plan reads "Plan ✓"; the rest is still read out, and whole in the title.
    expect(classes(screen.getByTestId('summary-plan'))).toContain('@max-[36rem]:hidden')
    const short = screen.getByTestId('summary-plan-short')
    expect(classes(short)).toEqual(expect.arrayContaining(['hidden', '@max-[36rem]:inline']))
    expect(short.textContent).toBe('Plan ✓ approved (edited)')
    expect(short.firstChild?.textContent).toBe('Plan ✓')
    expect(classes(short.querySelector('span'))).toContain('sr-only')
    expect(short.getAttribute('title')).toBe('Plan ✓ approved (edited)')
    // The cost never gives way.
    expect(classes(screen.getByTestId('summary-cost').parentElement)).toContain('shrink-0')
  })

  it('shortens only the plan words that can go', () => {
    expect(planShortText('Plan ✓ approved (edited)')).toBe('Plan ✓')
    expect(planShortText('Plan ✓ approved')).toBe('Plan ✓')
    expect(planShortText('Plan skipped · turned off')).toBe('Plan skipped')
    expect(planShortText('Plan skipped')).toBeNull()
    expect(planShortText('Plan ready for review')).toBeNull()
  })
})
