// Timers across sleep (P7/P10/P12/P13/P14 and the `power` event): a stall, hard or ask
// timer never fires because the machine slept. Suspend holds them; resume shifts lastEventAt, keepWaitingAt and each
// ask's expiresAt by the time asleep, emits ask-extended and re-arms. Table rows, one case per row.
import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUTS } from '@shared/config-schema.ts'
import { activeMsAt } from '@core/supervisor/derive.ts'
import { timerId } from '@core/supervisor/timers.ts'
import { Harness } from './helpers.ts'

const t = DEFAULT_TIMEOUTS
const HOUR = 3_600_000

/** Implement running with one pending ask raised now (expires after askMs). */
function waitingOnAsk(): Harness {
  const h = new Harness().toImplementRunning()
  h.tick(1000).ask('implement', 'q1', { expiresIn: t.askMs })
  return h
}

describe('power rows', () => {
  it('ask pending → suspend → asleep past askMs → resume: still waiting, expiresAt extended, ask-extended, timer re-armed', () => {
    const h = waitingOnAsk()
    const expires = h.step('implement').asks[0]?.expiresAt as number
    const oldDue = h.state.timers[timerId.ask('implement', 'q1')] as number
    expect(oldDue).toBe(expires)
    h.tick(5000).send({ t: 'power', state: 'suspend' })
    const suspendedAt = h.now
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBeUndefined()
    // The old ask timer firing while asleep (it was cleared) is stale: no P10.
    h.send({ t: 'timer', id: timerId.ask('implement', 'q1'), due: oldDue }, oldDue + 1000)
    expect(h.step('implement').status).toBe('waiting')
    expect(h.fx('answer')).toEqual([])
    const resumedAt = oldDue + 1000 + HOUR
    h.send({ t: 'power', state: 'resume' }, resumedAt)
    expect(h.state.suspendedAt).toBeUndefined()
    const shifted = h.step('implement').asks[0]?.expiresAt as number
    expect(shifted).toBe(expires + (resumedAt - suspendedAt))
    expect(shifted).toBeGreaterThan(h.now)
    expect(h.bodies('ask-extended')).toEqual([
      { t: 'ask-extended', step: 'implement', requestId: 'q1', expiresAt: shifted },
    ])
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBe(shifted)
    expect(h.step('implement').status).toBe('waiting')
    expect(h.step('implement').pause).toBeUndefined()
  })

  it('the shift equals the time asleep', () => {
    const h = waitingOnAsk()
    const expires = h.step('implement').asks[0]?.expiresAt as number
    h.tick(5000).send({ t: 'power', state: 'suspend' })
    const at = h.now
    h.send({ t: 'power', state: 'resume' }, at + t.askMs + 60_000)
    expect(h.step('implement').asks[0]?.expiresAt).toBe(expires + t.askMs + 60_000)
  })

  it('P10 still fires at the shifted expiry: paused(ask-timeout) with the cancel sent', () => {
    const h = waitingOnAsk()
    h.tick(5000).send({ t: 'power', state: 'suspend' })
    h.tick(HOUR).send({ t: 'power', state: 'resume' })
    h.fire('ask|implement')
    expect(h.step('implement').status).toBe('paused')
    expect(h.step('implement').pause).toBe('ask-timeout')
    expect(h.fx('answer')).toEqual([
      expect.objectContaining({ requestId: 'q1', decision: 'cancel', why: 'ask-timeout' }),
    ])
    expect(h.bodies('ask-resolved')).toEqual([expect.objectContaining({ requestId: 'q1', by: 'timeout' })])
  })

  it('an ask timer armed while asleep never fires P10 (guard); resume arms it again', () => {
    const h = waitingOnAsk()
    h.tick(5000).send({ t: 'power', state: 'suspend' })
    // A timer the reducer did not clear (defensive: e.g. a state written by an older build).
    const id = timerId.ask('implement', 'q1')
    h.state = { ...h.state, timers: { ...h.state.timers, [id]: h.now + 1 } }
    h.send({ t: 'timer', id, due: h.now + 1 }, h.now + t.askMs * 2)
    expect(h.step('implement').status).toBe('waiting')
    expect(h.fx('answer')).toEqual([])
    h.tick(1000).send({ t: 'power', state: 'resume' })
    expect(h.state.timers[id]).toBe(h.step('implement').asks[0]?.expiresAt)
  })

  it('an ask raised after the suspend (before the resume was seen) is extended only by the time since it was raised', () => {
    const h = new Harness().toImplementRunning()
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    h.tick(HOUR).ask('implement', 'late', { expiresIn: t.askMs })
    const raised = h.now
    expect(h.state.timers[timerId.ask('implement', 'late')]).toBeUndefined()
    h.tick(2000).send({ t: 'power', state: 'resume' })
    expect(h.step('implement').asks[0]?.expiresAt).toBe(raised + t.askMs + 2000)
  })

  it('P12 is not fired by sleep: running → suspend → asleep past stallMs → resume: running, stall timer shifted', () => {
    const h = new Harness().toImplementRunning()
    h.tick(1000).ev('implement', { type: 'text', delta: 'working' })
    const last = h.now
    h.tick(10_000).send({ t: 'power', state: 'suspend' })
    expect(h.state.timers[timerId.stall('implement')]).toBeUndefined()
    expect(h.state.timers[timerId.hard('implement')]).toBeUndefined()
    h.send({ t: 'power', state: 'resume' }, h.now + t.stallMs * 3)
    const d = t.stallMs * 3
    expect(h.step('implement').status).toBe('running')
    expect(h.state.cards).toEqual([])
    expect(h.step('implement').lastEventAt).toBe(last + d)
    expect(h.state.timers[timerId.stall('implement')]).toBe(last + d + t.stallMs)
    expect(h.state.timers[timerId.hard('implement')]).toBe(last + d + t.hardKillMs)
    // The shifted deadline still opens the stall card (P12) once it is really due.
    h.fire('stall|implement')
    expect(h.step('implement').status).toBe('stalled')
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['stall'])
  })

  it('P14 is not fired by sleep: a stalled step keeps its hard deadline relative to its last output', () => {
    const h = new Harness().toImplementRunning()
    h.fire('stall|implement')
    expect(h.step('implement').status).toBe('stalled')
    const hardDue = h.state.timers[timerId.hard('implement')] as number
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    const at = h.now
    h.send({ t: 'power', state: 'resume' }, at + t.hardKillMs * 2)
    expect(h.step('implement').status).toBe('stalled')
    expect(h.state.timers[timerId.hard('implement')]).toBe(hardDue + t.hardKillMs * 2)
    expect(h.step('implement').failure).toBeUndefined()
  })

  it('P13 after a resume: Keep waiting re-arms both timers from now', () => {
    const h = new Harness().toImplementRunning()
    h.fire('stall|implement')
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    h.tick(HOUR).send({ t: 'power', state: 'resume' })
    h.tick(500).user({ kind: 'keep-waiting', step: 'implement' })
    expect(h.step('implement').status).toBe('running')
    expect(h.step('implement').keepWaitingAt).toBe(h.now)
    expect(h.state.timers[timerId.stall('implement')]).toBe(h.now + t.stallMs)
    expect(h.state.timers[timerId.hard('implement')]).toBe(h.now + t.hardKillMs)
  })

  it('a vendor line seen after the suspend is not moved past now (lastEventAt and keepWaitingAt are clamped)', () => {
    const h = new Harness().toImplementRunning()
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    h.tick(HOUR).ev('implement', { type: 'text', delta: 'woke up' })
    h.user({ kind: 'keep-waiting', step: 'implement' })
    h.tick(100).send({ t: 'power', state: 'resume' })
    expect(h.step('implement').lastEventAt).toBe(h.now)
    expect(h.step('implement').keepWaitingAt).toBe(h.now)
    expect(h.state.timers[timerId.stall('implement')]).toBe(h.now + t.stallMs)
  })

  it('a deny in its undo grace: ask-extended is emitted but the ask timer stays off; the grace still answers', () => {
    const h = waitingOnAsk()
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    h.tick(HOUR).send({ t: 'power', state: 'resume' })
    expect(h.bodies('ask-extended')).toHaveLength(1)
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBeUndefined()
    h.fire('deny|implement')
    expect(h.fx('answer')).toEqual([expect.objectContaining({ requestId: 'q1', decision: 'deny' })])
    expect(h.step('implement').status).toBe('running')
  })

  it('sleep is not active time', () => {
    const h = new Harness().toImplementRunning()
    const st0 = h.step('implement')
    const before = activeMsAt(st0, h.now)
    h.tick(10_000).send({ t: 'power', state: 'suspend' })
    h.tick(HOUR).send({ t: 'power', state: 'resume' })
    expect(activeMsAt(h.step('implement'), h.now)).toBe(before + 10_000)
  })

  it('a second suspend and a resume without a suspend change nothing', () => {
    const h = new Harness().toImplementRunning()
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    const at = h.state.suspendedAt
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    expect(h.state.suspendedAt).toBe(at)
    h.tick(1000).send({ t: 'power', state: 'resume' })
    const timers = { ...h.state.timers }
    const r = h.tick(1000).send({ t: 'power', state: 'resume' })
    expect(h.state.timers).toEqual(timers)
    expect(r.effects.filter((e) => e.t !== 'persist')).toEqual([])
  })

  it('run.json round-trips after suspend and resume', () => {
    const h = waitingOnAsk()
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    expect(JSON.parse(JSON.stringify(h.state))).toStrictEqual(h.state)
    h.tick(HOUR).send({ t: 'power', state: 'resume' })
    expect(JSON.parse(JSON.stringify(h.state))).toStrictEqual(h.state)
  })
})
