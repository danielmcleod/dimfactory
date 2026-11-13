// Timeout, deny-pause and stall flows (a timed-out ask offers [Allow & resume] [Resume (keep denied)]
// [Stop run]; the stall card, "No output for 5m", offers [Keep waiting] [Stop]; state-machine rows P9b/P10/P12/P13/P19): each
// button sends the command core expects, and the text says what was asked and what Resume does.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CardView as CardData, RunEventBody } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { PausedNotice } from '@renderer/components/run/PausedNotice.tsx'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, ev } from '../helpers/fixtures.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory
let seq = 0

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  seq = 0
  mock = installMockDimFactory({
    handlers: {
      'runs.resume': () => undefined,
      'runs.stop': () => undefined,
      'cards.resolve': () => undefined,
      'runs.get': () => snapWith(),
    },
  })
})

afterEach(() => {
  resetStopWatches()
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  resetBridgeForTests()
})

function feed(body: RunEventBody): void {
  streamBuffer.apply(env(RUN, ++seq, body))
  streamBuffer.flush()
}

function askedAndResolved(detail: string, resolved: Extract<RunEventBody, { t: 'ask-resolved' }>): void {
  feed(
    ev('implement', {
      type: 'ask',
      requestId: resolved.requestId,
      kind: 'shell',
      detail,
      expiresAt: 1,
      allowSession: true,
    }),
  )
  feed(resolved)
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

function paused(pause: 'ask-timeout' | 'denied' | 'interrupted'): void {
  const snap = snapWith({
    steps: { implement: { status: 'paused', pause, attempt: 1, vendor: 'claude' } },
  })
  renderUi(<PausedNotice runId={RUN} view={snap.steps.implement} />)
}

describe('ask timeout', () => {
  it('[Allow & resume] → runs.resume{allowTimedOutAsk}, [Resume (keep denied)] → runs.resume, [Stop run] → runs.stop', async () => {
    askedAndResolved('npm publish', {
      t: 'ask-resolved',
      step: 'implement',
      requestId: 'r1',
      by: 'timeout',
      decision: 'cancel',
    })
    paused('ask-timeout')
    expect(screen.getByTestId('paused-why-implement').textContent).toBe(
      "Nobody answered Implement's question in time (npm publish), so it paused. Allow it and continue, or continue with it denied.",
    )
    expect(screen.getByTestId('timeout-allow-resume').textContent).toBe('Allow & resume')
    await click(screen.getByTestId('timeout-allow-resume'))
    await click(screen.getByTestId('timeout-resume-denied'))
    expect(mock.callsOf('runs.resume')).toEqual([{ runId: RUN, allowTimedOutAsk: true }, { runId: RUN }])
    await click(screen.getByTestId('timeout-stop'))
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: RUN }])
  })

  it('quotes a long command only in part (the stream has all of it)', () => {
    const long = `node -e "${'x'.repeat(200)}"`
    askedAndResolved(long, { t: 'ask-resolved', step: 'implement', requestId: 'r3', by: 'timeout' })
    paused('ask-timeout')
    const why = screen.getByTestId('paused-why-implement').textContent ?? ''
    expect(why).toContain(`(${long.slice(0, 80)}…)`)
    expect(why).not.toContain(long)
  })

  it('still explains itself before the stream is loaded', () => {
    paused('ask-timeout')
    expect(screen.getByTestId('paused-why-implement').textContent).toContain(
      "Nobody answered Implement's question in time, so it paused.",
    )
  })
})

describe('deny that pauses (ask.denyPauses)', () => {
  it('says what was denied and what Resume tells the vendor', async () => {
    askedAndResolved('rm -rf build', {
      t: 'ask-resolved',
      step: 'implement',
      requestId: 'r2',
      by: 'user',
      via: 'app',
      decision: 'cancel',
    })
    paused('denied')
    expect(screen.getByTestId('paused-why-implement').textContent).toBe(
      'Implement paused because you denied rm -rf build. Resume continues without it: Claude is told you denied it and not to retry it.',
    )
    expect(screen.queryByTestId('timeout-allow-resume')).toBeNull()
    await click(screen.getByTestId('resume'))
    expect(mock.callsOf('runs.resume')).toEqual([{ runId: RUN }])
    await click(screen.getByTestId('paused-stop'))
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: RUN }])
  })
})

describe('stall card', () => {
  const card: CardData = {
    id: 'stall-1',
    kind: 'stall',
    title: 'No output for 5m',
    body: 'Implement has produced no output for 5m. It may still be working.',
    payload: { step: 'implement', idleMs: 300_000 },
    blocking: false,
    choices: [
      { id: 'keep-waiting', label: 'Keep waiting', primary: true },
      { id: 'stop', label: 'Stop run', danger: true },
    ],
  }

  it('shows core’s silence and sends its two choices', async () => {
    renderUi(<CardView runId={RUN} card={card} folder="C:\\work\\repo" />)
    const section = screen.getByTestId('card-stall')
    expect(section.textContent).toContain('No output for 5m')
    expect(screen.getByTestId('stall-body').dataset['idleMs']).toBe('300000')
    expect(screen.getByTestId('stall-keep-waiting').textContent).toBe('Keep waiting')
    expect(screen.getByTestId('stall-stop').textContent).toBe('Stop run')
    await click(screen.getByTestId('stall-keep-waiting'))
    await click(screen.getByTestId('stall-stop'))
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'stall-1', choiceId: 'keep-waiting' },
      { runId: RUN, cardId: 'stall-1', choiceId: 'stop' },
    ])
  })

  it('keeps both buttons when core sent no choices', () => {
    renderUi(<CardView runId={RUN} card={{ ...card, choices: [] }} folder="C:\\work\\repo" />)
    expect(screen.getByTestId('stall-keep-waiting').textContent).toBe('Keep waiting')
    expect(screen.getByTestId('stall-stop').textContent).toBe('Stop run')
  })
})
