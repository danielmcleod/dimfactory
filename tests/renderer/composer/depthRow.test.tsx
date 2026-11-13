// Adaptive depth in the composer: the depth row (Auto, Quick, Thorough) with core's decision on one line, the checks
// asked with the decided depth (so the pass rows and the estimate show the run's passes), a forced choice sent as the
// run's `depth` override, and runs.start getting the user's own overrides (core decides again). Plus the Run view's
// header fact and the end panel's wrong-findings line.
import '../helpers/rtl.ts'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DepthDecision } from '@shared/depth.ts'
import { DEPTH_SUMMARY, depthLine } from '@shared/depth.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { depthRowText } from '@renderer/pages/dashboard/composer/DepthRow.tsx'
import { withDecidedDepth } from '@renderer/pages/dashboard/composer/useDepth.ts'
import { depthFact, depthTitle } from '@renderer/components/run/depth.ts'
import { wrongFindingsText } from '@renderer/components/run/RunEndPanel.tsx'
import { easyDepthText } from '@renderer/pages/easy/EasyDepth.tsx'
import {
  whatHappensFor,
  QUICK_HAPPENS_TEXT,
  whatHappensText,
  changeEstimateText,
} from '@renderer/pages/easy/text.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from './fixtures.tsx'

const QUICK: DepthDecision = {
  depth: 'direct',
  source: 'auto',
  reason: 'A small or medium change to an existing project.',
  signals: ['small-change'],
}
const THOROUGH: DepthDecision = {
  depth: 'full',
  source: 'auto',
  reason: 'It touches sign-in, so it gets a plan and two reviewers.',
  signals: ['risky'],
}

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'depth.decide': (req: { task: string }) => (/sign-in/.test(req.task) ? THOROUGH : QUICK),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

const lineText = (): string | null => screen.getByTestId('composer-depth-line').textContent

describe('the composer depth row', () => {
  it("shows core's decision and asks the checks with the decided depth", async () => {
    await mountComposer()
    fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Fix the typo' } })
    await settle(500)
    expect(lineText()).toBe(depthLine(QUICK))
    expect(screen.getByTestId('composer-depth-line').getAttribute('data-depth')).toBe('direct')
    expect(mock.callsOf('depth.decide').at(-1)).toEqual({ folder: FOLDER, task: 'Fix the typo' })
    await settle(400)
    // The checks see the Quick shape (core resolves `depth: direct`); runs.start will get the user's own overrides.
    expect(mock.callsOf('preflight.run').at(-1)).toEqual({ folder: FOLDER, overrides: { depth: 'direct' } })
    expect(mock.callsOf('config.resolve').at(-1)).toMatchObject({ overrides: { depth: 'direct' } })
  })

  it('a risky task reads Thorough with its reason, and the checks are asked without a depth', async () => {
    await mountComposer()
    fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add sign-in' } })
    await settle(900)
    expect(lineText()).toBe(depthLine(THOROUGH))
    expect(lineText()).toContain(DEPTH_SUMMARY.full)
    expect(mock.callsOf('preflight.run').at(-1)).toEqual({ folder: FOLDER })
  })

  it('forcing Thorough sends the run override; Auto takes it back', async () => {
    await mountComposer()
    const choice = screen.getByTestId('composer-depth-choice')
    const full = choice.querySelector('[data-value="full"]') as HTMLElement
    fireEvent.click(full)
    await settle(900)
    expect(full.getAttribute('aria-checked')).toBe('true')
    expect(mock.callsOf('depth.decide').at(-1)).toMatchObject({ overrides: { depth: 'full' } })
    fireEvent.click(choice.querySelector('[data-value="auto"]') as HTMLElement)
    await settle(900)
    expect(mock.callsOf('depth.decide').at(-1)).not.toHaveProperty('overrides')
  })

  it('keeps one height and the choice keeps its widths: the decision arriving moves nothing', async () => {
    await mountComposer()
    const row = screen.getByTestId('composer-depth')
    expect(row.className).toContain('h-7')
    expect(screen.getByTestId('composer-depth-line').className).toContain('truncate')
  })
})

describe('depth words', () => {
  it('the row says what happens before a folder or a decision', () => {
    expect(depthRowText(null, false)).toMatch(/once you choose a folder/)
    expect(depthRowText(null, true)).toMatch(/Choosing Quick or Thorough/)
    expect(depthRowText(QUICK, true)).toBe(
      'Quick: one strong session plus checks. A small or medium change to an existing project.',
    )
  })

  it('the decided depth goes to the checks only when the user left it to Auto', () => {
    const o = {}
    expect(withDecidedDepth(o, QUICK)).toEqual({ depth: 'direct' })
    expect(withDecidedDepth(o, THOROUGH)).toBe(o)
    expect(withDecidedDepth(o, null)).toBe(o)
    const forced = { depth: 'full' as const }
    expect(withDecidedDepth(forced, QUICK)).toBe(forced)
    expect(withDecidedDepth(o, { ...QUICK, source: 'chosen' })).toBe(o)
  })

  it("the Run view's header fact and tooltip, escalation included", () => {
    expect(depthFact({ depth: 'direct', source: 'auto', reason: 'r' })).toBe('Quick')
    expect(depthFact({ depth: 'full', source: 'auto', reason: 'r' })).toBe('Thorough')
    expect(depthFact({ depth: 'full', source: 'profile', reason: 'r' })).toBe("Profile's own passes")
    const esc = { depth: 'direct' as const, source: 'auto' as const, reason: 'Small.', escalated: 'test' }
    expect(depthFact(esc)).toBe('Quick, then thorough checks')
    expect(depthTitle(esc)).toBe(
      'Quick: one strong session plus checks. Small. A check failed (test), so a second reviewer joined and Fix repeats until the checks pass.',
    )
  })

  it("the end panel's wrong-findings line", () => {
    expect(wrongFindingsText({ disputed: 2, wrong: 1 })).toBe(
      'Findings that turned out wrong: 1 (Fix disputed 2 findings and the checks after Fix passed).',
    )
    expect(wrongFindingsText({ disputed: 1, wrong: 0 })).toBe(
      'Findings that turned out wrong: none confirmed (Fix disputed one finding; no check after Fix confirmed it).',
    )
  })

  it("Easy's words: the depth line, what happens for Quick, and no lighter-model claim for a Quick change", () => {
    expect(easyDepthText(QUICK)).toBe(depthLine(QUICK))
    expect(easyDepthText(undefined, 'Type it first.')).toBe('Type it first.')
    expect(whatHappensFor(true, 'direct')).toBe(QUICK_HAPPENS_TEXT)
    expect(whatHappensFor(true, 'full')).toBe(whatHappensText(true))
    const est = { p50: 120_000, p80: 240_000 }
    expect(changeEstimateText(est, null, true, false)).toMatch(/lighter model/)
    expect(changeEstimateText(est, null, true, false, true)).not.toMatch(/lighter model/)
  })

  it('every depth string is free of em dashes', () => {
    for (const s of [
      depthRowText(null, false),
      depthRowText(null, true),
      depthLine(QUICK),
      depthLine(THOROUGH),
      QUICK_HAPPENS_TEXT,
      depthTitle({ depth: 'direct', source: 'auto', reason: 'r', escalated: 'x' }),
    ])
      expect(s).not.toMatch(/—/)
  })
})

describe('the header shows the depth', () => {
  it('renders the fact with its data attributes', async () => {
    const { RunHeader } = await import('@renderer/components/run/RunHeader.tsx')
    const { renderUi, snapWith } = await import('../run/helpers.tsx')
    const snap = snapWith({})
    snap.depth = { depth: 'direct', source: 'auto', reason: 'Small.' }
    renderUi(<RunHeader snap={snap} onStop={() => {}} stopping={false} />)
    const fact = screen.getByTestId('run-depth')
    expect(fact.textContent).toBe('Quick')
    expect(fact.getAttribute('data-depth')).toBe('direct')
    expect(fact.getAttribute('title')).toBe('Quick: one strong session plus checks. Small.')
  })
})
