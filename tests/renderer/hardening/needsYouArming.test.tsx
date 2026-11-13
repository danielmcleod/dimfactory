// A double click on the Dashboard (an ask that moved up from the queue is inert for 500 ms): on the
// Dashboard's needs-you strip, an ask that moves up the list (the one before it was answered) takes clicks only after
// ASK_ARM_MS, so the second click of a double click on Allow never answers the ask that has just taken the row's place.
// An ask shown where nothing moved is answerable at once, as before.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AttentionItem } from '@shared/estimates.ts'
import { ASK_ARM_MS } from '@renderer/components/attention/AskCard.tsx'
import { NeedsYouStrip } from '@renderer/pages/dashboard/NeedsYouStrip.tsx'
import { setAttention } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

let mock: MockDimFactory
const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()

beforeEach(() => {
  mock = setUp({ handlers: { 'asks.answer': () => undefined } })
})
afterEach(() => tearDown(mock))

function ask(n: number): AttentionItem {
  return {
    id: `ask:q${n}`,
    runId: `r${n}`,
    displayNo: n,
    title: `Run ${n}`,
    folder: 'C:\\work\\repo',
    since: NOW - 60_000 + n,
    kind: 'ask',
    ask: {
      runId: `r${n}`,
      step: 'implement',
      attempt: 1,
      requestId: `q${n}`,
      vendor: 'claude',
      kind: 'shell',
      detail: `npm run task-${n}`,
      expiresAt: NOW + 240_000,
      allowSession: true,
      queue: { index: 1, total: 1 },
    },
  }
}

const row = (n: number): HTMLElement => screen.getByTestId(`needs-you-ask:q${n}`)
const allowOf = (n: number): HTMLButtonElement =>
  within(row(n)).getByRole<HTMLButtonElement>('button', { name: 'Allow' })
const denyOf = (n: number): HTMLButtonElement =>
  within(row(n)).getByRole<HTMLButtonElement>('button', { name: 'Deny' })
const answered = (): [string, string][] => mock.callsOf('asks.answer').map((r) => [r.requestId, r.decision])

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

function mount(items: AttentionItem[]): void {
  setAttention(items.length, items)
  render(
    <Providers>
      <NeedsYouStrip />
    </Providers>,
  )
}

describe('the needs-you strip arms an ask that moved up', () => {
  it('a double click on Allow answers the first ask only; the next one takes clicks after ASK_ARM_MS', async () => {
    mount([ask(1), ask(2)])
    // Nothing moved: the first ask is answerable at once, as before.
    expect(allowOf(1).disabled).toBe(false)
    await click(allowOf(1))
    // Core took it; the second ask moves into the row the user is clicking.
    act(() => setAttention(1, [ask(2)]))
    expect(row(2).dataset['moved']).toBe('true')
    expect(allowOf(2).disabled).toBe(true)
    expect(denyOf(2).disabled).toBe(true)
    await click(allowOf(2))
    await click(denyOf(2))
    expect(answered()).toEqual([['q1', 'allow']])
    await settle(ASK_ARM_MS)
    expect(allowOf(2).disabled).toBe(false)
    await click(allowOf(2))
    expect(answered()).toEqual([
      ['q1', 'allow'],
      ['q2', 'allow'],
    ])
  })

  it('in the open list, the row that moves up into the answered row is armed again; rows that did not move are not', async () => {
    mount([ask(1), ask(2), ask(3)])
    await click(screen.getByTestId('needs-you-more'))
    await click(allowOf(2))
    act(() => setAttention(2, [ask(1), ask(3)]))
    // Ask 3 moved into ask 2's row: inert. Ask 1 stayed where it was: live.
    expect(allowOf(3).disabled).toBe(true)
    expect(allowOf(1).disabled).toBe(false)
    await click(allowOf(3))
    expect(answered()).toEqual([['q2', 'allow']])
    await settle(ASK_ARM_MS)
    expect(allowOf(3).disabled).toBe(false)
  })

  it('a fresh ask that arrives in the empty slot is answerable at once', async () => {
    mount([])
    act(() => setAttention(1, [ask(4)]))
    expect(row(4).dataset['moved']).toBeUndefined()
    expect(allowOf(4).disabled).toBe(false)
    await click(allowOf(4))
    expect(answered()).toEqual([['q4', 'allow']])
  })
})
