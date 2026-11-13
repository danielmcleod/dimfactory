// Context health's reactions in the app: the restartFresh and loop cards (core's choices, sent as they are), the
// "Lower Extensions for this pass" suggestion as a link to Settings (never a change made for the user), and Easy
// mode's plain words for a loop stop and for a pass that summarised its notes.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContextHealthReport } from '@shared/context.ts'
import type { CardView as CardData } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { ContextHealthSection } from '@renderer/components/run/ContextHealthSection.tsx'
import { cardStep } from '@renderer/components/run/steps.ts'
import { easyHealthText } from '@renderer/components/run/text.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { CARD_TITLE, LOOP_STOPPED_TEXT } from '@renderer/pages/easy/text.ts'
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
  mock = installMockDimFactory({
    handlers: { 'cards.resolve': () => undefined, 'runs.get': () => snapWith() },
  })
})

afterEach(() => {
  mock.uninstall()
  clearToasts()
  resetBridgeForTests()
})

/** Core's restartFresh card (supervisor/cards.ts restartFreshCard), as the renderer receives it. */
function restartFreshCard(id: string, step: 'implement' | 'fix', n: number): CardData {
  const label = step === 'fix' ? 'Fix' : 'Implement'
  const times = n === 2 ? 'twice' : `${n} times`
  return {
    id,
    kind: 'restartFresh',
    title: 'Restart this pass fresh with a summary',
    body: `The AI ran low on memory and summarised its notes ${times} in ${label}; results may be less reliable. Restart ${label} in a fresh session with a short summary of the plan, the criteria and the files changed so far, or keep going.`,
    payload: { step, compactions: n },
    blocking: false,
    choices: [
      { id: 'restart-fresh', label: 'Restart fresh with a summary', primary: true },
      { id: 'keep-going', label: 'Keep going' },
    ],
  }
}

/** Core's loop card (supervisor/cards.ts loopCard). */
function loopCard(
  id: string,
  step: 'implement',
  o: { tool: string; count: number; stopAt: number },
): CardData {
  return {
    id,
    kind: 'loop',
    title: 'The AI keeps repeating the same step',
    body: `Implement ran the same ${o.tool} call ${o.count} times. It may be stuck. Stop it, or keep going (Dim Factory stops it at ${o.stopAt}).`,
    payload: { step, tool: o.tool, count: o.count, stopAt: o.stopAt },
    blocking: false,
    choices: [
      { id: 'stop', label: 'Stop', danger: true },
      { id: 'keep-going', label: 'Keep going', primary: true },
    ],
  }
}

function show(card: CardData): void {
  renderUi(<CardView runId={RUN} card={card} folder="C:\\work\\repo" />)
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

describe('the restartFresh card', () => {
  it('says why in plain words and sends Restart fresh with a summary', async () => {
    show(restartFreshCard('restartFresh-1', 'implement', 3))
    const card = screen.getByTestId('card-restartFresh')
    expect(card.textContent).toContain('Restart this pass fresh with a summary')
    expect(card.textContent).toContain(
      'The AI ran low on memory and summarised its notes 3 times in Implement; results may be less reliable.',
    )
    expect(card.textContent).not.toContain('\u2014')
    expect(cardStep(restartFreshCard('x', 'fix', 3))).toBe('fix')
    await click(screen.getByTestId('card-choice-restart-fresh'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'restartFresh-1', choiceId: 'restart-fresh' },
    ])
  })

  it('Keep going is its other choice', async () => {
    show(restartFreshCard('restartFresh-1', 'fix', 2))
    expect(screen.getByTestId('card-restartFresh').textContent).toContain('summarised its notes twice in Fix')
    await click(screen.getByTestId('card-choice-keep-going'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'restartFresh-1', choiceId: 'keep-going' },
    ])
  })
})

describe('the loop card', () => {
  it('shows the count and the hard stop, and sends Stop', async () => {
    show(loopCard('loop-1', 'implement', { tool: 'Bash', count: 8, stopAt: 12 }))
    const card = screen.getByTestId('card-loop')
    expect(card.textContent).toContain('The AI keeps repeating the same step')
    expect(card.textContent).toContain('Implement ran the same Bash call 8 times.')
    expect(card.textContent).toContain('Dim Factory stops it at 12')
    await click(screen.getByTestId('card-choice-stop'))
    expect(mock.callsOf('cards.resolve')).toEqual([{ runId: RUN, cardId: 'loop-1', choiceId: 'stop' }])
  })
})

describe('Lower Extensions for this pass', () => {
  it('is a link to Settings › Extensions, never a button that changes anything', () => {
    const report: ContextHealthReport = {
      version: 1,
      passes: [],
      items: [{ id: 'D1', step: 'implement', strong: true, suggestion: 'lower-extensions', tokens: 42_000 }],
    }
    render(<ContextHealthSection report={report} />)
    const link = screen.getByTestId('context-lower-extensions')
    expect(link.tagName).toBe('A')
    expect(link.textContent).toBe('Lower Extensions for this pass.')
    expect(link.getAttribute('href')).toBe('#/settings/extensions')
    expect(screen.queryAllByRole('button')).toEqual([])
  })
})

describe('Easy mode words', () => {
  it('a loop stop and the reaction cards read plainly', () => {
    expect(LOOP_STOPPED_TEXT).toMatch(/^The AI kept repeating the same step, so we stopped it\./)
    expect(CARD_TITLE.restartFresh).toBe('It ran low on memory')
    expect(CARD_TITLE.loop).toBe('It keeps repeating the same step')
  })

  it('a pass that summarised its notes twice or more', () => {
    const d7 = (count: number): string =>
      easyHealthText({ id: 'D7', step: 'implement', strong: count >= 3, suggestion: 'split-task', count })
    expect(d7(2)).toBe(
      'The AI ran low on memory and summarised its notes twice; results may be less reliable.',
    )
    expect(d7(3)).toBe(
      'The AI ran low on memory and summarised its notes 3 times; results may be less reliable.',
    )
  })
})
