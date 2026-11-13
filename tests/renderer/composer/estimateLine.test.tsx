// The composer's estimate line (the estimate display, the first-run script): core's RunEstimate as
// `≈ 9–14 min · ~$0.40–0.85 est. · from 12 runs`, priors ("typical (no history yet)"), a null cost explained
// ("no price (CLI default model unknown)", no price), "+ your review time" while a gate is on, and the per-step table on hover
// or focus. Plus the pure formatters.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import {
  estimateCostText,
  estimateLineParts,
  estimateRows,
  formatApproxDuration,
  formatUsdRange,
  passEstimateText,
  pFixText,
} from '@renderer/pages/dashboard/composer/model.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, mountComposer, probe, report, runEstimate, stepEstimate } from './fixtures.tsx'

let mock: MockDimFactory
const MIN = 60_000

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

const line = () => screen.getByTestId('estimate-line').textContent

describe('estimate line in the composer', () => {
  it('formats history: ≈ range · cost range est. · from N runs, + your review time while a gate is on', async () => {
    await mountComposer()
    await settle(300)
    expect(mock.callsOf('estimates.get')).toEqual([{ folder: FOLDER }])
    expect(line()).toBe('≈ 9–14 min · ~$0.40–0.85 est. · from 12 runs · + your review time')
    // Auto turns the gates off (core's resolve): no review time.
    fireEvent.click(screen.getByTestId('composer-auto'))
    await settle(300)
    expect(line()).toBe('≈ 9–14 min · ~$0.40–0.85 est. · from 12 runs')
    expect(mock.callsOf('estimates.get').at(-1)).toEqual({ folder: FOLDER, overrides: { auto: true } })
  })

  it('formats priors (no history yet) without a cost', async () => {
    mock.on('estimates.get', () =>
      runEstimate({
        durationMs: { p50: 6 * MIN, p80: 6 * MIN },
        costUsd: null,
        samples: 0,
        basis: 'typical (no history yet)',
      }),
    )
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.gates.afterPlan = false) }))
    await mountComposer()
    await settle(300)
    expect(line()).toBe('≈ 6 min · cost unknown · typical (no history yet)')
  })

  it('explains a null cost: tokens only and "no price (CLI default model unknown)"', async () => {
    mock.on('estimates.get', () =>
      runEstimate({
        costUsd: null,
        tokens: { p50: 120_000, p80: 180_000 },
        missingPricing: ['codex/default'],
        basis: 'from 7 runs',
      }),
    )
    await mountComposer()
    await settle(300)
    expect(line()).toBe(
      '≈ 9–14 min · ~120.0k–180.0k tokens · no price (CLI default model unknown) · from 7 runs · + your review time',
    )
  })

  it('shows the per-step table on hover and on keyboard focus; Escape hides it', async () => {
    await mountComposer()
    await settle(300)
    expect(screen.queryByTestId('estimate-table')).toBeNull()
    const trigger = screen.getByTestId('estimate-line')
    fireEvent.mouseEnter(trigger.parentElement as HTMLElement)
    const table = screen.getByTestId('estimate-table')
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => Array.from(r.children).map((c) => c.textContent))
    expect(rows).toEqual([
      ['Plan', '1–2 min', '$0.05–0.08', 'from 12 runs (claude · opus)'],
      ['Implement', '5–8 min', '$0.20–0.40', 'from 12 runs (claude · opus)'],
      ['Review', '~2 min', '$0.05–0.10', 'from 12 runs (claude · opus)'],
      ['Critic', '2–3 min', '$0.06–0.12', 'from 12 runs (claude · opus)'],
      ['Fix', '3–4 min', '$0.10–0.20', 'from 12 runs (claude · opus)'],
    ])
    expect(table.textContent).toContain('Fix counted at 60% · typical')
    fireEvent.mouseLeave(trigger.parentElement as HTMLElement)
    expect(screen.queryByTestId('estimate-table')).toBeNull()
    act(() => trigger.focus())
    expect(screen.getByTestId('estimate-table')).toBeTruthy()
    expect(trigger.getAttribute('aria-describedby')).toBe(screen.getByTestId('estimate-table').id)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByTestId('estimate-table')).toBeNull()
  })

  it('is a button that spans its row: a new estimate changes only the text, cut with an ellipsis when too long', async () => {
    await mountComposer()
    await settle(300)
    const trigger = screen.getByTestId('estimate-line')
    // The box is the row's width whatever it says (UI standard: a button never changes size when its text changes).
    expect(trigger.className.split(' ')).toEqual(expect.arrayContaining(['w-full', 'min-w-0']))
    expect(trigger.parentElement?.className).not.toContain('self-start')
    const text = trigger.querySelector('span')
    expect(text?.className.split(' ')).toEqual(expect.arrayContaining(['truncate', 'min-w-0']))
    // The accessible name is the whole line, cut or not.
    expect(trigger.textContent).toBe('≈ 9–14 min · ~$0.40–0.85 est. · from 12 runs · + your review time')
    // Not cut: the table alone.
    fireEvent.mouseEnter(trigger.parentElement as HTMLElement)
    expect(screen.queryByTestId('estimate-full')).toBeNull()
    fireEvent.mouseLeave(trigger.parentElement as HTMLElement)
  })

  it('repeats a line cut by the ellipsis in full above the table', async () => {
    await mountComposer()
    await settle(300)
    const trigger = screen.getByTestId('estimate-line')
    const text = trigger.querySelector('span') as HTMLElement
    // jsdom lays nothing out: make the text wider than its box.
    Object.defineProperty(text, 'scrollWidth', { configurable: true, value: 600 })
    Object.defineProperty(text, 'clientWidth', { configurable: true, value: 300 })
    act(() => trigger.focus())
    expect(screen.getByTestId('estimate-full').textContent).toBe(
      '≈ 9–14 min · ~$0.40–0.85 est. · from 12 runs · + your review time',
    )
    expect(screen.getByTestId('estimate-table')).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByTestId('estimate-table')).toBeNull()
  })

  it('hides the line when this core has no estimates', async () => {
    mock.on('estimates.get', () => {
      throw mockError('UNSUPPORTED', 'estimates.get is not available in this build.')
    })
    await mountComposer()
    await settle(300)
    expect(screen.queryByTestId('estimate-line')).toBeNull()
    expect(screen.getByTestId('preflight-strip')).toBeTruthy()
  })
})

describe('estimate formatting', () => {
  it('formats ranges', () => {
    expect(formatApproxDuration({ p50: 9 * MIN, p80: 14 * MIN })).toBe('≈ 9–14 min')
    expect(formatApproxDuration({ p50: 6 * MIN, p80: 6 * MIN })).toBe('≈ 6 min')
    expect(formatUsdRange({ p50: 0.4, p80: 0.85 })).toBe('$0.40–0.85')
    expect(formatUsdRange({ p50: 0.3, p80: 0.3 })).toBe('$0.30')
    expect(formatUsdRange({ p50: 0.301, p80: 0.304 })).toBe('$0.30')
  })

  it('explains every kind of missing cost', () => {
    const base = runEstimate().total
    expect(estimateCostText(base)).toBe('~$0.40–0.85 est.')
    expect(estimateCostText({ ...base, costUsd: null, missingPricing: ['claude/default'] })).toBe(
      'no price (CLI default model unknown)',
    )
    expect(estimateCostText({ ...base, costUsd: null, missingPricing: ['codex/gpt-x'] })).toBe(
      'no price for codex/gpt-x',
    )
    expect(estimateCostText({ ...base, costUsd: null, missingPricing: [] })).toBe('cost unknown')
  })

  it('builds the first-run line from priors with a cost', () => {
    const est = runEstimate({
      durationMs: { p50: 6 * MIN, p80: 10 * MIN },
      costUsd: { p50: 0.3, p80: 0.3 },
      samples: 0,
      basis: 'typical (no history yet)',
    })
    expect(estimateLineParts(est.total, false).join(' · ')).toBe(
      '≈ 6–10 min · ~$0.30 est. · typical (no history yet)',
    )
    expect(estimateLineParts({ ...est.total, basis: '' }, false).at(-1)).toBe('typical (no history yet)')
  })

  it('formats pass rows and the table', () => {
    expect(passEstimateText(stepEstimate(2, 3, [0.08, 0.1]))).toBe('~2 min · ~$0.08')
    expect(passEstimateText(stepEstimate(2, 3, null))).toBe('~2 min')
    expect(passEstimateText(undefined)).toBeNull()
    const rows = estimateRows(
      runEstimate({}, { implement: stepEstimate(5, 8, null), 'verify:1': stepEstimate(1, 1, [0, 0]) }),
    )
    expect(rows.map((r) => [r.label, r.cost])).toEqual([
      ['Implement', 'No price'],
      ['Verify', '$0.00'],
    ])
    expect(pFixText({ value: 0.42, basis: 'folder' })).toBe("Fix counted at 42% · from this folder's runs")
  })
})
