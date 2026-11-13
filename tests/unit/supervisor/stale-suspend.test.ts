// Review fix (timers across sleep; P7, P10, P24): `suspendedAt` read back from run.json is a
// sleep the earlier process never saw end. withoutStaleSuspend (src/core/supervisor/recovery.ts) drops it when a
// controller loads the run. A gate-waiting run, which recovery does not relaunch, then arms its Implement and ask
// timers as usual, and P10 fires. Kept, the mark held them all.
import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUTS } from '@shared/config-schema.ts'
import { needsRelaunch, withoutStaleSuspend } from '@core/supervisor/recovery.ts'
import { timerId } from '@core/supervisor/timers.ts'
import type { RunState } from '@core/supervisor/types.ts'
import { Harness } from './helpers.ts'

/** At the plan gate, asleep, written to run.json and read back by the next process; and the time then. */
function persistedAsleepAtGate(): { state: RunState; at: number } {
  const h = new Harness().toPlanGate()
  h.tick(1000).send({ t: 'power', state: 'suspend' })
  expect(h.state.suspendedAt).toBeDefined()
  return { state: JSON.parse(JSON.stringify(h.state)) as RunState, at: h.now }
}

/** A fresh harness over `state` a minute after `at`: approved at the gate, Implement running. */
function approveAndAsk(state: RunState, at: number): Harness {
  const h = new Harness()
  h.state = state
  h.now = at + 60_000
  h.approve()
  h.reconcile()
  h.snapshot('S0', 'tree-base')
  h.passPreflight('implement')
  h.ev('implement', { type: 'session', id: 'impl-session' })
  return h
}

describe('withoutStaleSuspend', () => {
  it('drops the mark and leaves the rest of the state as it was', () => {
    const persisted = persistedAsleepAtGate().state
    // Nothing was live: recovery would not relaunch it (the relaunch clears the mark itself).
    expect(needsRelaunch(persisted)).toBe(false)
    const loaded = withoutStaleSuspend(persisted)
    expect(loaded.suspendedAt).toBeUndefined()
    const { suspendedAt: _dropped, ...rest } = persisted
    expect(loaded).toEqual(rest)
    // The persisted state is not changed in place.
    expect(persisted.suspendedAt).toBeDefined()
  })

  it('returns an awake state as it is', () => {
    const awake = new Harness().toPlanGate().state
    expect(withoutStaleSuspend(awake)).toBe(awake)
  })

  it('a loaded gate-waiting run arms its stall, hard and ask timers, and the ask times out', () => {
    const { state, at } = persistedAsleepAtGate()
    const h = approveAndAsk(withoutStaleSuspend(state), at)
    expect(h.state.timers[timerId.stall('implement')]).toBeDefined()
    expect(h.state.timers[timerId.hard('implement')]).toBeDefined()
    h.tick(1000).ask('implement', 'q1', { expiresIn: DEFAULT_TIMEOUTS.askMs })
    const expires = h.step('implement').asks[0]?.expiresAt as number
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBe(expires)
    h.fire('ask|implement')
    expect(h.step('implement').status).toBe('paused')
    expect(h.step('implement').pause).toBe('ask-timeout')
    expect(h.fx('answer')).toEqual([expect.objectContaining({ decision: 'cancel' })])
  })

  it('kept, the mark holds those timers (what the fix prevents)', () => {
    const { state, at } = persistedAsleepAtGate()
    const h = approveAndAsk(state, at)
    expect(h.state.timers[timerId.stall('implement')]).toBeUndefined()
    h.tick(1000).ask('implement', 'q1', { expiresIn: DEFAULT_TIMEOUTS.askMs })
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBeUndefined()
  })
})
