// Deny grace + P9 / P9u / P9a / P9b: the supervisor holds a Deny for graceMs before adapter.answer —
// 3000 ms from the app, 0 from notifications and the CLI.
import { describe, expect, it } from 'vitest'
import { runAttention } from '@core/supervisor/attention.ts'
import { toAskViews } from '@core/supervisor/derive.ts'
import { timerId } from '@core/supervisor/timers.ts'
import { Harness, makeConfig } from './helpers.ts'

function waitingOnAsk(denyPauses = false): Harness {
  const h = new Harness(makeConfig({ denyPauses })).toImplementRunning()
  h.ask('implement', 'q1')
  return h
}

describe('deny grace', () => {
  it('app: the answer is held for 3 s and sent when the grace ends', () => {
    const h = waitingOnAsk()
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    expect(h.fx('answer')).toHaveLength(0)
    const until = h.now + 3000
    expect(h.state.timers[timerId.deny('implement', 'q1')]).toBe(until)
    h.fire('deny|implement')
    expect(h.now).toBe(until)
    expect(h.fx('answer')).toEqual([expect.objectContaining({ decision: 'deny' })])
  })

  it('notification and CLI: grace 0 answers at once', () => {
    for (const via of ['notification', 'cli'] as const) {
      const h = waitingOnAsk()
      h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via })
      expect(h.fx('answer')).toEqual([expect.objectContaining({ requestId: 'q1', decision: 'deny' })])
      expect(h.bodies('ask-resolved')).toEqual([
        expect.objectContaining({ via, decision: 'deny', by: 'user' }),
      ])
      expect(h.state.timers[timerId.deny('implement', 'q1')]).toBeUndefined()
      expect(h.step('implement').status).toBe('running')
    }
  })

  it('an explicit graceMs from the command wins', () => {
    const h = waitingOnAsk()
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'notification', graceMs: 1500 })
    expect(h.state.timers[timerId.deny('implement', 'q1')]).toBe(h.now + 1500)
    const a = waitingOnAsk()
    a.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app', graceMs: 0 })
    expect(a.fx('answer')).toHaveLength(1)
  })

  it('grace 0 under denyPauses pauses immediately with cancel(denied)', () => {
    const h = waitingOnAsk(true)
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'cli' })
    expect(h.fx('answer')).toEqual([expect.objectContaining({ decision: 'cancel', why: 'denied' })])
    expect(h.step('implement')).toMatchObject({ status: 'paused', pause: 'denied' })
  })

  it('Allow during the grace replaces the pending deny', () => {
    const h = waitingOnAsk()
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    h.tick(1000).user({ kind: 'answer', requestId: 'q1', decision: 'allow', via: 'app' })
    expect(h.fx('answer')).toEqual([expect.objectContaining({ decision: 'allow' })])
    expect(h.state.timers[timerId.deny('implement', 'q1')]).toBeUndefined()
    expect(h.step('implement').status).toBe('running')
  })

  it('undo after the grace is over has nothing to undo', () => {
    const h = waitingOnAsk()
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    h.fire('deny|implement')
    h.user({ kind: 'undo-deny', requestId: 'q1' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })])
  })

  it('timers stay suspended during the grace; the ask timer is paused and comes back on undo', () => {
    const h = waitingOnAsk()
    const expires = h.step('implement').asks[0]?.expiresAt as number
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    expect(h.state.timers[timerId.stall('implement')]).toBeUndefined()
    expect(h.state.timers[timerId.hard('implement')]).toBeUndefined()
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBeUndefined()
    h.tick(2000).user({ kind: 'undo-deny', requestId: 'q1' })
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBe(expires)
    // If the question expires after the undo, P10 applies as usual.
    h.fire(timerId.ask('implement', 'q1'))
    expect(h.step('implement')).toMatchObject({ status: 'paused', pause: 'ask-timeout' })
  })

  it('Stop during the grace cancels the ask instead of denying it', () => {
    const h = waitingOnAsk()
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    h.user({ kind: 'stop' })
    expect(h.fx('answer')).toEqual([expect.objectContaining({ requestId: 'q1', decision: 'cancel' })])
    expect(h.state.timers[timerId.deny('implement', 'q1')]).toBeUndefined()
  })

  it('a pending deny is not counted as needing the user (AskView carries pendingDenyUntil)', () => {
    const h = waitingOnAsk()
    expect(runAttention(h.state).map((i) => i.kind)).toEqual(['ask'])
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    expect(toAskViews(h.state)[0]?.pendingDenyUntil).toBe(h.now + 3000)
    expect(runAttention(h.state)).toEqual([])
  })
})
