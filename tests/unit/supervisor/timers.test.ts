// Timers: formulas, suspension while asks are pending, power suspend/resume shifting.
import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUTS } from '@shared/config-schema.ts'
import {
  defaultDenyGraceMs,
  formatIdle,
  hardDeadline,
  idleBase,
  inactivityTimersWanted,
  parseTimerId,
  stallDeadline,
  timerId,
} from '@core/supervisor/timers.ts'
import type { StepState } from '@core/supervisor/types.ts'
import { Harness, T0 } from './helpers.ts'

const t = DEFAULT_TIMEOUTS

function step(o: Partial<StepState> = {}): StepState {
  return {
    key: 'implement',
    status: 'running',
    attempt: 1,
    spawnNo: 1,
    activeMs: 0,
    inFlightTools: [],
    asks: [],
    snagOpen: false,
    autoRetryUsed: false,
    meta: {},
    proc: { spawnNo: 1, live: true, spawnedAt: T0, terminal: false },
    lastEventAt: T0,
    ...o,
  }
}

describe('formulas', () => {
  it('stallAt = lastEventAt + stallMs; hardAt = lastEventAt + hardKillMs', () => {
    expect(stallDeadline(step(), t)).toBe(T0 + t.stallMs)
    expect(hardDeadline(step(), t)).toBe(T0 + t.hardKillMs)
  })

  it('an in-flight tool uses toolStallMs for the stall and adds it to the hard deadline', () => {
    const s = step({ inFlightTools: ['t1'] })
    expect(stallDeadline(s, t)).toBe(T0 + t.toolStallMs)
    expect(hardDeadline(s, t)).toBe(T0 + t.hardKillMs + t.toolStallMs)
  })

  it('keepWaitingAt re-bases both deadlines when it is later than the last event', () => {
    const s = step({ keepWaitingAt: T0 + 60_000 })
    expect(idleBase(s)).toBe(T0 + 60_000)
    expect(stallDeadline(s, t)).toBe(T0 + 60_000 + t.stallMs)
    expect(hardDeadline(s, t)).toBe(T0 + 60_000 + t.hardKillMs)
    expect(idleBase(step({ keepWaitingAt: T0 - 1 }))).toBe(T0)
  })

  it('no deadline before the first spawn', () => {
    const s = step()
    delete s.lastEventAt
    expect(stallDeadline(s, t)).toBeUndefined()
    expect(hardDeadline(s, t)).toBeUndefined()
  })
})

describe('suspension', () => {
  it('running arms both, stalled only the hard timer', () => {
    expect(inactivityTimersWanted(step(), false)).toEqual({ stall: true, hard: true })
    expect(inactivityTimersWanted(step({ status: 'stalled' }), false)).toEqual({ stall: false, hard: true })
  })

  it('nothing is armed while an ask is pending, a deny grace is open, the machine sleeps, or after done', () => {
    const ask = {
      requestId: 'q',
      kind: 'shell' as const,
      detail: 'x',
      expiresAt: T0 + 1,
      allowSession: true,
      raisedAt: T0,
    }
    const none = { stall: false, hard: false }
    expect(inactivityTimersWanted(step({ status: 'waiting', asks: [ask] }), false)).toEqual(none)
    expect(
      inactivityTimersWanted(
        step({ status: 'waiting', asks: [{ ...ask, pendingDeny: { until: T0 + 3000, via: 'app' } }] }),
        false,
      ),
    ).toEqual(none)
    expect(inactivityTimersWanted(step(), true)).toEqual(none)
    expect(
      inactivityTimersWanted(
        step({ proc: { spawnNo: 1, live: true, spawnedAt: T0, terminal: true } }),
        false,
      ),
    ).toEqual(none)
  })

  it('the reducer clears stall/hard while asks are pending and ignores stale timer events', () => {
    const h = new Harness().toImplementRunning()
    const stallDue = h.state.timers[timerId.stall('implement')] as number
    h.ask('implement', 'q1')
    expect(h.state.timers[timerId.stall('implement')]).toBeUndefined()
    // A timer that was cleared but fired anyway (race) is stale.
    h.send({ t: 'timer', id: timerId.stall('implement'), due: stallDue }, stallDue)
    expect(h.step('implement').status).toBe('waiting')
    expect(h.state.cards).toHaveLength(0)
  })

  it('a timer event whose due no longer matches is ignored', () => {
    const h = new Harness().toImplementRunning()
    const due = h.state.timers[timerId.hard('implement')] as number
    h.send({ t: 'timer', id: timerId.hard('implement'), due: due - 1 }, due)
    expect(h.step('implement').status).toBe('running')
    expect(h.effects.filter((e) => e.t !== 'persist')).toEqual([])
  })
})

describe('power suspend / resume', () => {
  it('suspend clears stall, hard and ask timers; resume shifts deadlines and emits ask-extended', () => {
    const h = new Harness().toImplementRunning()
    h.tick(1000).ev('implement', { type: 'text', delta: 'x' })
    const last = h.now
    h.user({ kind: 'keep-waiting', step: 'implement' })
    const kept = h.now
    h.ask('implement', 'q1', { expiresIn: 600_000 })
    const expires = h.step('implement').asks[0]?.expiresAt as number
    h.tick(10_000).send({ t: 'power', state: 'suspend' })
    expect(h.state.suspendedAt).toBe(h.now)
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBeUndefined()
    const lastEventAt = h.step('implement').lastEventAt as number
    h.tick(3_600_000).send({ t: 'power', state: 'resume' })
    const d = 3_600_000
    expect(h.step('implement').lastEventAt).toBe(lastEventAt + d)
    expect(h.step('implement').keepWaitingAt).toBe(kept + d)
    expect(h.step('implement').asks[0]?.expiresAt).toBe(expires + d)
    expect(h.bodies('ask-extended')).toEqual([
      { t: 'ask-extended', step: 'implement', requestId: 'q1', expiresAt: expires + d },
    ])
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBe(expires + d)
    // Still suspended by the pending ask.
    expect(h.state.timers[timerId.stall('implement')]).toBeUndefined()
    expect(last).toBeLessThanOrEqual(kept)
  })

  it('after resume without asks the stall/hard timers are re-armed at the shifted deadlines', () => {
    const h = new Harness().toImplementRunning()
    const spawnAt = h.step('implement').lastEventAt as number
    h.tick(100_000).send({ t: 'power', state: 'suspend' })
    expect(h.state.timers[timerId.stall('implement')]).toBeUndefined()
    expect(h.state.timers[timerId.hard('implement')]).toBeUndefined()
    // Timers that fire during sleep are stale.
    h.tick(400_000).send({ t: 'timer', id: timerId.stall('implement'), due: spawnAt + t.stallMs })
    expect(h.step('implement').status).toBe('running')
    h.tick(1000).send({ t: 'power', state: 'resume' })
    const shift = 401_000
    expect(h.state.timers[timerId.stall('implement')]).toBe(spawnAt + shift + t.stallMs)
    expect(h.state.timers[timerId.hard('implement')]).toBe(spawnAt + shift + t.hardKillMs)
  })
})

describe('helpers', () => {
  it('timer ids round-trip, including request ids with separators', () => {
    expect(parseTimerId(timerId.ask('implement', 'a|b'))).toEqual({
      kind: 'ask',
      step: 'implement',
      arg: 'a|b',
    })
    expect(parseTimerId(timerId.kill('fix', 3))).toEqual({ kind: 'kill', step: 'fix', arg: '3' })
    expect(parseTimerId(timerId.stall('plan'))).toEqual({ kind: 'stall', step: 'plan' })
    expect(parseTimerId('nope|plan')).toBeNull()
  })

  it('deny grace defaults: 3000 ms from the app, 0 from notifications and the CLI', () => {
    expect(defaultDenyGraceMs('app')).toBe(3000)
    expect(defaultDenyGraceMs('notification')).toBe(0)
    expect(defaultDenyGraceMs('cli')).toBe(0)
  })

  it('formats idle time', () => {
    expect(formatIdle(90_000)).toBe('90s')
    expect(formatIdle(300_000)).toBe('5m')
    expect(formatIdle(3_900_000)).toBe('1h 5m')
  })
})
