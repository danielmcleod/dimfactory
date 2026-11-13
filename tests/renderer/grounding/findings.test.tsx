// The grounding findings in the findings views: the gate before Fix shows a "Grounding N" filter (only when there is
// one) beside All / Must / Should, a Grounding source chip, a "Possible hallucination" chip and an "AI-judged" chip; a
// reviewer's `(grounding)` finding is under the filter too. Filtering changes only the background of a segment.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Finding } from '@shared/findings.ts'
import type { CardView as CardData } from '@shared/run.ts'
import {
  AI_JUDGED_LABEL,
  GROUNDING_SOURCE_LABEL,
  HALLUCINATION_LABEL,
  isGroundingFinding,
} from '@renderer/components/cards/BeforeFixBody.tsx'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  clearToasts()
  resetLaterChoicesForTests()
  setMacForTests(false)
  mock = installMockDimFactory({
    handlers: { 'cards.resolve': () => undefined, 'runs.get': () => snapWith() },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  setMacForTests(null)
  resetBridgeForTests()
})

const finding = (o: Partial<Finding> & Pick<Finding, 'id' | 'n'>): Finding => ({
  severity: 'must',
  source: 'review',
  title: `finding ${o.n}`,
  body: '',
  flags: [],
  round: 1,
  ...o,
})

function gate(findings: Finding[]): CardData {
  return {
    id: 'gate-1',
    kind: 'gate:beforeFix',
    title: 'Findings ready',
    body: '',
    payload: { findings, selected: findings.map((f) => f.id) },
    blocking: true,
    choices: [
      { id: 'continue', label: 'Continue', primary: true, input: 'findings' },
      { id: 'skip-fix', label: 'Skip Fix' },
    ],
  }
}

const ALL = [
  finding({
    id: 'g1',
    n: 1,
    source: 'grounding',
    title: 'The AI said it ran the tests, but none ran.',
  }),
  finding({
    id: 'g2',
    n: 2,
    source: 'grounding',
    severity: 'should',
    title: '`src/a.ts` imports `left-padx`, which the project does not have.',
    flags: ['possible-hallucination'],
  }),
  finding({ id: 'r1', n: 3, title: '`src/b.ts:3`: calls a made-up API', flags: ['grounding'] }),
  finding({ id: 'r2', n: 4, severity: 'should', title: 'naming' }),
  finding({
    id: 'j1',
    n: 5,
    source: 'grounding',
    severity: 'should',
    title: 'AI-judged: the build was never run',
    flags: ['ai-judged'],
  }),
]

describe('grounding findings at the gate before Fix', () => {
  it('chips: the Grounding source, a reviewer’s grounding mark, possible hallucination and AI-judged', () => {
    renderUi(<CardView runId={RUN} card={gate(ALL)} folder="C:\\work\\repo" />)
    expect(screen.getByTestId('finding-source-g1').textContent).toBe(GROUNDING_SOURCE_LABEL)
    expect(screen.getByTestId('finding-hallucination-g2').textContent).toBe(HALLUCINATION_LABEL)
    expect(screen.queryByTestId('finding-hallucination-g1')).toBeNull()
    expect(screen.getByTestId('finding-source-r1').textContent).toBe('from review')
    expect(screen.getByTestId('finding-grounding-r1').textContent).toBe(GROUNDING_SOURCE_LABEL)
    expect(screen.getByTestId('finding-judged-j1').textContent).toBe(AI_JUDGED_LABEL)
    for (const label of [GROUNDING_SOURCE_LABEL, HALLUCINATION_LABEL, AI_JUDGED_LABEL])
      expect(label).not.toContain('\u2014')
  })

  it('the Grounding filter shows the grounding findings and reviewers’ grounding marks; ticks stay', async () => {
    renderUi(<CardView runId={RUN} card={gate(ALL)} folder="C:\\work\\repo" />)
    const filter = screen.getByTestId('findings-filter-grounding')
    expect(filter.textContent).toBe('Grounding 4')
    expect(filter.getAttribute('aria-pressed')).toBe('false')
    const before = filter.className
    await act(async () => {
      fireEvent.click(filter)
      await settle()
    })
    expect(filter.getAttribute('aria-pressed')).toBe('true')
    // Selection is the background only: the same size classes, nothing bolder.
    expect(filter.className.replace('bg-secondary text-secondary-foreground', 'hover:bg-accent')).toBe(before)
    for (const id of ['g1', 'g2', 'r1', 'j1']) expect(screen.getByTestId(`finding-${id}`)).toBeTruthy()
    expect(screen.queryByTestId('finding-r2')).toBeNull()
    expect(screen.getByTestId('fix-receives').textContent).toBe('Fix will receive 2 must · 3 should')
  })

  it('no grounding finding: no Grounding filter', () => {
    renderUi(<CardView runId={RUN} card={gate([finding({ id: 'r2', n: 1 })])} folder="C:\\work\\repo" />)
    expect(screen.queryByTestId('findings-filter-grounding')).toBeNull()
    expect(screen.getByTestId('findings-filter-all')).toBeTruthy()
  })

  it('isGroundingFinding: the source, or a reviewer’s mark', () => {
    expect(ALL.filter(isGroundingFinding).map((f) => f.id)).toEqual(['g1', 'g2', 'r1', 'j1'])
  })
})
