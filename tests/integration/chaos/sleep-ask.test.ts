// Chaos: sleep during an ask (Sleep timers; powerMonitor drives the timers; state-machine rows P7, P10): the
// machine sleeps while a pass waits on the user, through core.power and the run's own timers
// on the E2E clock (DIM_FACTORY_E2E=1; advanceClock is the time asleep). Every wake extends a pending ask by the time
// asleep (`ask-extended`) and arms its timer again; no ask times out while the machine sleeps or before its extended
// expiry, and then it does, at that expiry. An ask raised while asleep waits for the wake. A Dim Factory killed while
// the machine sleeps comes back with no stale sleep and nothing armed ("Crash relaunch").
import { afterEach, describe, expect, it } from 'vitest'
import { timerId } from '../../../src/core/supervisor/timers.ts'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { Chaos, FULL_SPEC, logEnvelopes, runDoc, settled, value, verifyRelaunch, version } from './helpers.ts'
import type { ChaosWorld } from './helpers.ts'
import type { Core } from '../../../src/core/app-core.ts'

const chaos = new Chaos()
afterEach(async () => chaos.dispose())

const OVERRIDES = {
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  verify: { enabled: false },
}

/** C04a asks twice (Bash, then Write); Implement answers the first one's way and writes the version file. */
const ASKS = (o: { delayMs?: number } = {}) => ({
  ...FULL_SPEC,
  implement: [{ recording: 'C04a-ask-allow', write: version('0.1.0'), ...o }],
})

const extended = (events: RunEnvelope[], requestId: string): number[] =>
  events
    .map((e) => e.body)
    .filter((b): b is Extract<RunEnvelope['body'], { t: 'ask-extended' }> => b.t === 'ask-extended')
    .filter((b) => b.requestId === requestId)
    .map((b) => b.expiresAt)

async function start(
  w: ChaosWorld,
): Promise<{ core: Core; c: RunController; runId: string; events: RunEnvelope[] }> {
  const { core, events } = await chaos.relaunch(w)
  const { runId } = value(
    await core.invoke('runs.start', { folder: w.folder, task: 'add a --version flag', overrides: OVERRIDES }),
  )
  const c = core.controller(runId)
  if (c === undefined) throw new Error('no controller')
  return { core, c, runId, events }
}

const firstAsk = (s: RunState) => s.steps.implement.asks[0]

describe('chaos: the machine sleeps while a pass waits on the user', () => {
  it('two sleeps longer than askMs: extended each time, armed again, never timed out early; then it times out', async () => {
    const w = await chaos.world(ASKS())
    const { core, c, runId, events } = await start(w)
    const askMs = c.state.config.timeouts.askMs
    const s0 = await c.waitFor((s) => firstAsk(s) !== undefined || settled(s), 120_000)
    const ask = firstAsk(s0)
    if (ask === undefined) throw new Error(`no ask: ${s0.status}`)
    const id = timerId.ask('implement', ask.requestId)
    let expiry = ask.expiresAt
    expect(c.state.timers[id]).toBe(expiry)

    for (const asleep of [askMs + 60_000, 2 * askMs]) {
      await core.power('suspend')
      expect(c.state.suspendedAt).toBeDefined()
      expect(c.state.timers[id]).toBeUndefined()
      // Asleep past the expiry: nothing times out.
      value(await core.advanceClock(asleep))
      expect(c.state.steps.implement).toMatchObject({ status: 'waiting' })
      expect(c.state.steps.implement.pause).toBeUndefined()
      await core.power('resume')
      expect(c.state.suspendedAt).toBeUndefined()
      const now = firstAsk(c.state)
      expect(now?.requestId).toBe(ask.requestId)
      expect(now?.expiresAt).toBeGreaterThanOrEqual(expiry + asleep)
      expect(now?.expiresAt).toBeLessThanOrEqual(expiry + asleep + 5_000)
      expiry = now?.expiresAt ?? 0
      expect(c.state.timers[id]).toBe(expiry)
    }
    expect(extended(events, ask.requestId)).toHaveLength(2)
    expect(extended(events, ask.requestId).at(-1)).toBe(expiry)
    // Awake again: one second short of the extended expiry it still waits; past it, P10 pauses the pass.
    value(await core.advanceClock(expiry - core.clock.now() - 1000))
    expect(c.state.steps.implement.status).toBe('waiting')
    value(await core.advanceClock(2000))
    const timedOut = await c.waitFor((s) => s.steps.implement.status === 'paused', 30_000)
    expect(timedOut.steps.implement.pause).toBe('ask-timeout')
    expect(
      events.map((e) => e.body).filter((b) => b.t === 'ask-resolved' && b.requestId === ask.requestId),
    ).toEqual([expect.objectContaining({ by: 'timeout', decision: 'cancel' })])
    await chaos.stop(core)
    expect(runDoc(w.home, runId).state.suspendedAt).toBeUndefined()
  }, 240_000)

  it('an ask raised while asleep: no timer until the wake, the sleep does not count, then it is answered', async () => {
    const w = await chaos.world(ASKS({ delayMs: 3000 }))
    const { core, c, events } = await start(w)
    const askMs = c.state.config.timeouts.askMs
    await c.waitFor((s) => s.steps.implement.proc?.live === true || settled(s), 120_000)
    await core.power('suspend')
    const s1 = await c.waitFor((s) => firstAsk(s) !== undefined || settled(s), 60_000)
    const ask = firstAsk(s1)
    if (ask === undefined) throw new Error(`no ask: ${s1.status}`)
    expect(ask.raisedAt).toBeGreaterThanOrEqual(s1.suspendedAt ?? Infinity)
    expect(s1.steps.implement.status).toBe('waiting')
    expect(s1.timers[timerId.ask('implement', ask.requestId)]).toBeUndefined()
    value(await core.advanceClock(3 * askMs))
    expect(c.state.steps.implement.status).toBe('waiting')
    await core.power('resume')
    const woke = core.clock.now()
    const after = firstAsk(c.state)
    // Extended by the time asleep since it was raised: askMs from the wake.
    expect(after?.expiresAt).toBeGreaterThanOrEqual(woke + askMs - 5_000)
    expect(after?.expiresAt).toBeLessThanOrEqual(woke + askMs + 5_000)
    expect(c.state.timers[timerId.ask('implement', ask.requestId)]).toBe(after?.expiresAt)
    expect(extended(events, ask.requestId)).toEqual([after?.expiresAt])
    // Answered from a notification after the wake; the second ask too; the run completes.
    value(await core.answerAsk({ runId: c.runId, requestId: ask.requestId, decision: 'allow' }))
    const s2 = await c.waitFor(
      (s) => s.steps.implement.asks.some((a) => a.requestId !== ask.requestId) || settled(s),
      60_000,
    )
    const second = s2.steps.implement.asks[0]
    if (second !== undefined)
      value(
        await core.invoke('asks.answer', { runId: c.runId, requestId: second.requestId, decision: 'allow' }),
      )
    expect(await c.waitFor(settled, 180_000)).toMatchObject({ status: 'completed' })
  }, 240_000)

  it('a silent pass through a long sleep: its stall and hard timers move by the time asleep, then fire', async () => {
    const w = await chaos.world({
      ...FULL_SPEC,
      implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0'), delayMs: 60_000 }],
    })
    const { core, c } = await start(w)
    const { stallMs, hardKillMs } = c.state.config.timeouts
    await c.waitFor((s) => s.steps.implement.proc?.live === true || settled(s), 120_000)
    // Once the fake has read its prompt it stays silent (the delay): nothing else moves lastEventAt.
    const quiet = Date.now() + 60_000
    while (!w.sc.entries().some((e) => e.kind === 'stdin' && String(e['line']).includes('"type":"user"'))) {
      if (Date.now() > quiet) throw new Error('Implement never read its prompt')
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 500))
    const last = c.state.steps.implement.lastEventAt ?? 0
    await core.power('suspend')
    expect(c.state.timers[timerId.stall('implement')]).toBeUndefined()
    expect(c.state.timers[timerId.hard('implement')]).toBeUndefined()
    const asleep = hardKillMs + stallMs
    value(await core.advanceClock(asleep))
    expect(c.state.steps.implement.status).toBe('running')
    await core.power('resume')
    const st = c.state.steps.implement
    expect(st.status).toBe('running')
    expect(st.lastEventAt).toBeGreaterThanOrEqual(last + asleep)
    expect(c.state.timers[timerId.stall('implement')]).toBe((st.lastEventAt ?? 0) + stallMs)
    expect(c.state.timers[timerId.hard('implement')]).toBe((st.lastEventAt ?? 0) + hardKillMs)
    // Not before the moved deadline; at it, the stall card (P12).
    value(await core.advanceClock(stallMs - 1000))
    expect(c.state.steps.implement.status).toBe('running')
    value(await core.advanceClock(2000))
    expect(c.state.steps.implement.status).toBe('stalled')
    value(await core.invoke('runs.stop', { runId: c.runId }))
    await c.waitFor((s) => s.status === 'cancelled' && s.steps.implement.proc?.live !== true, 60_000)
  }, 240_000)

  it('Dim Factory killed while the machine sleeps with an ask pending: no stale sleep, nothing armed or resumed', async () => {
    const w = await chaos.world(ASKS())
    const k = await chaos.child(
      w,
      {
        overrides: OVERRIDES,
        actions: [{ until: 'ask' }, { power: 'suspend' }, { sleep: 120_000 }],
      },
      { killWhen: (out) => /^ACT 1 power suspend$/m.test(out) },
    )
    // What the dead instance wrote: its ask pending (the sleep itself is not a transition; it may not have reached
    // run.json, and a relaunch drops one that did: withoutStaleSuspend).
    const before = runDoc(w.home, k.runId ?? '')
    expect(before.state.steps.implement.asks).toHaveLength(1)
    const requestId = before.state.steps.implement.asks[0]?.requestId
    const { runId, snap } = await verifyRelaunch(chaos, w, k, 'external', { paused: ['implement'] })
    expect(snap.asks).toEqual([])
    const doc = runDoc(w.home, runId)
    expect(doc.state.suspendedAt).toBeUndefined()
    expect(doc.state.timers).toEqual({})
    // The dead instance's ask was settled by the relaunch (stop), never by a timeout.
    expect(
      logEnvelopes(w.home, runId)
        .map((e) => e.body)
        .filter((b) => b.t === 'ask-resolved' && b.requestId === requestId),
    ).toEqual([expect.objectContaining({ by: 'stop' })])
  }, 240_000)
})
