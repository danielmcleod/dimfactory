// Timers against the fake Claude under DIM_FACTORY_E2E=1 (Sleep, the E2E clock; state-machine rows P10, P12, P13;
// "Deny grace"; a stale notification activation shows already answered/expired):
//   - an ask pending → suspend → the clock moves past askMs → resume: not paused, expiresAt extended, ask-extended
//     emitted, attention agrees; answered from a notification (`via:'notification'`); a second answer is stale
//   - moving the clock past askMs pauses the step (P10) and the vendor gets the cancel
//   - moving it past stallMs opens the stall card (P12); Keep waiting re-arms both timers (P13)
import { afterEach, describe, expect, it } from 'vitest'
import { isStaleAsk } from '../../../src/core/app-core.ts'
import { timerId } from '../../../src/core/supervisor/timers.ts'
import { stdinByScript } from '../run/scenario.ts'
import { bodies, implementAsk, settled, start, teardown, versionWrite } from './helpers.ts'

afterEach(teardown)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('sleep and the E2E clock (core + fake Claude)', () => {
  it('an ask survives a sleep longer than askMs; answered from a notification; a second answer is stale', async () => {
    const t = await start({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04a-ask-allow', write: versionWrite }],
    })
    const askMs = t.c.state.config.timeouts.askMs
    const { requestId, expiresAt } = await implementAsk(t.c)
    expect(t.core.askPending(t.runId, requestId)).toBe(true)

    await t.core.power('suspend')
    expect(t.c.state.suspendedAt).toBeDefined()
    expect(t.c.state.timers[timerId.ask('implement', requestId)]).toBeUndefined()
    const moved = await t.core.advanceClock(askMs + 60_000)
    expect(moved.ok).toBe(true)
    expect(t.c.state.steps.implement.status).toBe('waiting')
    await t.core.power('resume')

    const st = t.c.state.steps.implement
    expect(st.status).toBe('waiting')
    expect(st.pause).toBeUndefined()
    const ask = st.asks.find((a) => a.requestId === requestId)
    expect(ask?.expiresAt).toBeGreaterThanOrEqual(expiresAt + askMs + 60_000)
    const extended = ask?.expiresAt as number
    expect(t.c.state.timers[timerId.ask('implement', requestId)]).toBe(extended)
    expect(bodies(t.events, 'ask-extended')).toEqual([
      { t: 'ask-extended', step: 'implement', requestId, expiresAt: extended },
    ])
    // The Dashboard, tray and toasts count down from the same expiry, pushed again as `attention`.
    const item = t.core.attention().items.find((i) => i.kind === 'ask')
    expect(item?.kind === 'ask' && item.ask.expiresAt).toBe(extended)
    const pushed = t.globals.filter((g) => g.kind === 'attention').at(-1)
    const pushedAsk = pushed?.kind === 'attention' ? pushed.items.find((i) => i.kind === 'ask') : undefined
    expect(pushedAsk?.kind === 'ask' && pushedAsk.ask.expiresAt).toBe(extended)
    // Short of the new expiry nothing times out.
    await t.core.advanceClock(askMs / 2)
    expect(t.c.state.steps.implement.status).toBe('waiting')

    const r = await t.core.answerAsk({ runId: t.runId, requestId, decision: 'allow' })
    expect(r).toEqual({ ok: true, value: undefined })
    expect(bodies(t.events, 'ask-resolved')).toContainEqual({
      t: 'ask-resolved',
      step: 'implement',
      requestId,
      by: 'user',
      via: 'notification',
      decision: 'allow',
    })
    expect(t.core.askPending(t.runId, requestId)).toBe(false)
    const again = await t.core.answerAsk({ runId: t.runId, requestId, decision: 'deny' })
    expect(isStaleAsk(again)).toBe(true)
    expect(again.ok === false && again.error.message).toMatch(/already answered or has expired/)
    // An unknown run answers the same way (nothing to answer there).
    expect(isStaleAsk(await t.core.answerAsk({ runId: 'nope', requestId, decision: 'allow' }))).toBe(true)

    // C04a's second ask, answered in the app.
    const second = await t.c.waitFor(
      (s) => s.steps.implement.asks.some((a) => a.requestId !== requestId) || settled(s),
      60_000,
    )
    const q2 = second.steps.implement.asks[0]?.requestId as string
    const a2 = await t.core.invoke('asks.answer', { runId: t.runId, requestId: q2, decision: 'allow' })
    expect(a2.ok).toBe(true)
    const end = await t.c.waitFor(settled, 120_000)
    expect(end.status).toBe('completed')
    const stdin = stdinByScript(t.sc.entries()).get('implement-1.script.jsonl') ?? []
    expect(stdin.filter((l) => l.includes('"behavior":"allow"'))).toHaveLength(2)
    const done = t.notes.find((n) => n.kind === 'completed')
    expect(done?.completed?.outcome).toBe(end.outcome)
    expect(done?.completed?.durationMs).toBe((end.endedAt as number) - end.createdAt)
  }, 180_000)

  it('moving the clock past askMs pauses the step and the vendor gets deny + interrupt', async () => {
    const t = await start({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04d-ask-cancel' }],
    })
    const askMs = t.c.state.config.timeouts.askMs
    const { requestId } = await implementAsk(t.c)
    const moved = await t.core.advanceClock(askMs + 1000)
    expect(moved.ok && moved.value.now).toBeGreaterThan(0)
    const st = t.c.state.steps.implement
    expect(st.status).toBe('paused')
    expect(st.pause).toBe('ask-timeout')
    expect(bodies(t.events, 'ask-resolved')).toContainEqual(
      expect.objectContaining({ requestId, by: 'timeout', decision: 'cancel' }),
    )
    expect(t.core.attention().items).toContainEqual(
      expect.objectContaining({ kind: 'paused', step: 'implement', pause: 'ask-timeout' }),
    )
    expect(isStaleAsk(await t.core.answerAsk({ runId: t.runId, requestId, decision: 'allow' }))).toBe(true)
    await t.c.waitFor((s) => s.steps.implement.proc?.live !== true, 60_000)
    const stdin = stdinByScript(t.sc.entries()).get('implement-1.script.jsonl') ?? []
    expect(stdin.some((l) => l.includes('"behavior":"deny"') && l.includes('"interrupt":true'))).toBe(true)
  }, 120_000)

  it('moving the clock past stallMs opens the stall card; Keep waiting re-arms the timers', async () => {
    const t = await start({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite, delayMs: 30_000 }],
    })
    const { stallMs, hardKillMs } = t.c.state.config.timeouts
    await t.c.waitFor((s) => s.steps.implement.status === 'running', 60_000)
    // Once the fake read the user message it stays silent (the delay): no output can move lastEventAt anymore.
    for (let i = 0; i < 200; i++) {
      const lines = stdinByScript(t.sc.entries()).get('implement-1.script.jsonl') ?? []
      if (lines.some((l) => l.includes('"type":"user"'))) break
      await sleep(100)
    }
    await sleep(300)
    await t.core.advanceClock(stallMs + 1000)
    const stalled = t.c.state
    expect(stalled.steps.implement.status).toBe('stalled')
    expect(stalled.cards.map((c) => c.view.kind)).toEqual(['stall'])
    expect(t.core.attention().items).toContainEqual(
      expect.objectContaining({ kind: 'stalled', step: 'implement' }),
    )

    const kw = await t.core.invoke('runs.keepWaiting', { runId: t.runId, pass: 'implement' })
    expect(kw.ok).toBe(true)
    const s = t.c.state
    const st = s.steps.implement
    expect(st.status).toBe('running')
    expect(s.cards).toEqual([])
    expect(st.keepWaitingAt).toBeDefined()
    const kept = st.keepWaitingAt as number
    expect(s.timers[timerId.stall('implement')]).toBe(kept + stallMs)
    expect(s.timers[timerId.hard('implement')]).toBe(kept + hardKillMs)
    expect(bodies(t.events, 'card')).toContainEqual(
      expect.objectContaining({ state: 'resolved', choiceId: 'keep-waiting' }),
    )

    const stop = await t.core.invoke('runs.stop', { runId: t.runId })
    expect(stop.ok).toBe(true)
    const end = await t.c.waitFor(
      (x) => x.status === 'cancelled' && x.steps.implement.proc?.live !== true,
      60_000,
    )
    expect(end.status).toBe('cancelled')
  }, 150_000)
})
