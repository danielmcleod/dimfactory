// Chaos (kill at each effect boundary; "Crash relaunch", state-machine rows P24, R1, R2, R4): the child
// Dim Factory is killed at each effect boundary from the run's start to the plan gate's answer, then relaunched on the
// same home. run.json, events.jsonl and runs/index.jsonl stay consistent and parseable, live steps come back
// paused(interrupted), a gate stays open, a queued run stays queued, nothing starts on its own and no process of the
// dead instance survives (helpers.ts verifyRelaunch). Points are `<point>#<n>` as src/core/chaos.ts counts them.
import { afterEach, describe, expect, it } from 'vitest'
import { Chaos, FULL_RUN, FULL_SPEC, folderVersion, settled, value, verifyRelaunch } from './helpers.ts'
import type { KillExpect } from './helpers.ts'

const chaos = new Chaos()
afterEach(async () => chaos.dispose())

const CASES: [string, string, KillExpect][] = [
  ['the lock request (R1: created, not yet queued)', 'effect:lock#1', { status: 'queued' }],
  ['the authoritative preflight (R2)', 'effect:preflight#1', { paused: ['preflight'] }],
  ['the run-start snapshot', 'effect:snapshot#1', { paused: ['plan'] }],
  ['the run-start snapshot taken, not yet recorded', 'event:snapshot-done#1', { paused: ['plan'] }],
  ["Plan's spawn", 'effect:spawn#1', { paused: ['plan'] }],
  ["Plan's process up, not yet in procs.json", 'spawn:spawned#1', { paused: ['plan'] }],
  ["Plan's process up and recorded", 'spawn:recorded#1', { paused: ['plan'] }],
  ["Plan's answer arrived, not yet reduced", 'event:adapter:done#1', { paused: ['plan'] }],
  ['the plan-end snapshot (R4 guard)', 'effect:snapshot#2', { status: 'waiting', cards: ['gate:afterPlan'] }],
  [
    'the gate opened, its index line not yet written',
    'effect:notify#1',
    { status: 'waiting', cards: ['gate:afterPlan'] },
  ],
  ["the gate's Approve recorded, its effects not yet run", 'command:card#1', { paused: ['implement'] }],
]

describe('chaos: kill from the run start to the plan gate, then relaunch', () => {
  for (const [what, point, want] of CASES) {
    it(`${what} (${point})`, async () => {
      const w = await chaos.world(FULL_SPEC, { trustCheck: true })
      const k = await chaos.child(w, FULL_RUN, { kill: point })
      const r = await verifyRelaunch(chaos, w, k, point, want)
      // The folder was not touched by a pass that never ran.
      expect(folderVersion(w.folder)).toBeNull()
      expect(r.snap.summary.outcome).toBeUndefined()
    }, 180_000)
  }

  it('Resume after a kill with Plan running finishes the run (no auto-resume until then)', async () => {
    const w = await chaos.world(
      { ...FULL_SPEC, plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }] },
      { trustCheck: true },
    )
    const point = 'spawn:recorded#1'
    const k = await chaos.child(w, FULL_RUN, { kill: point })
    const { core, runId } = await verifyRelaunch(chaos, w, k, point, { paused: ['plan'] })
    value(await core.invoke('runs.resume', { runId }))
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const gate = await c.waitFor(
      (s) => s.cards.some((x) => x.view.kind === 'gate:afterPlan') || settled(s),
      120_000,
    )
    const card = gate.cards.find((x) => x.view.kind === 'gate:afterPlan')?.view
    value(await core.invoke('cards.resolve', { runId, cardId: card?.id ?? '', choiceId: 'approve' }))
    const end = await c.waitFor(settled, 180_000)
    expect(end).toMatchObject({ status: 'completed', outcome: 'fixed' })
    expect(folderVersion(w.folder)).toContain('1.0.0')
  }, 300_000)
})
