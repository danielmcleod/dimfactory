// Chaos (kill at each effect boundary; state-machine rows P7, P8, P18, R13, "Crash relaunch"): the child
// Dim Factory is killed while Implement asks the user (C04a asks twice) at each boundary of an ask and its answer, and
// at each boundary of a Stop given while the ask waits (the ask's cancel, the interrupt, the `stopped` snapshot, the
// folder lock), then relaunched on the same home and checked as helpers.ts verifyRelaunch says. An ask the dead
// instance raised is never left waiting and never answered by the relaunch; a Stop it recorded is finished (the run
// ends cancelled and gives its folder lock back) and nothing runs again.
import { afterEach, describe, expect, it } from 'vitest'
import { passArgvs } from '../run/scenario.ts'
import {
  ANSWER_RUN,
  ASK_SPEC,
  Chaos,
  STOP_RUN,
  folderVersion,
  logEnvelopes,
  runDoc,
  settled,
  value,
  verifyRelaunch,
  version,
} from './helpers.ts'
import type { KillExpect } from './helpers.ts'

const chaos = new Chaos()
afterEach(async () => chaos.dispose())

const PAUSED: KillExpect = { paused: ['implement'] }
const CANCELLED: KillExpect = { status: 'cancelled' }

describe('chaos: kill while a pass asks the user, and during a Stop, then relaunch', () => {
  for (const [what, point, allowed] of [
    ['the first ask arrived, not yet reduced', 'event:adapter:ask#1', 0],
    ['the first ask waiting, its notice not yet sent', 'effect:notify#1', 0],
    ['Allow recorded, not yet sent to Claude', 'command:answer#1', 1],
    ['Allow being sent', 'effect:answer#1', 1],
    ['the second ask arrived, not yet reduced', 'event:adapter:ask#2', 1],
    ["the second ask's Allow recorded, not yet sent", 'command:answer#2', 2],
  ] as const) {
    it(`${what} (${point}): Implement paused, no ask left waiting or answered by the relaunch`, async () => {
      const w = await chaos.world(ASK_SPEC)
      const k = await chaos.child(w, ANSWER_RUN, { kill: point })
      const before = runDoc(w.home, k.runId ?? '').state.steps.implement.asks.map((a) => a.requestId)
      const r = await verifyRelaunch(chaos, w, k, point, PAUSED)
      expect(r.snap.asks).toEqual([])
      // An ask still waiting in the dead instance's run.json was settled by the relaunch as stopped (once), never
      // allowed and never timed out; an Allow the user gave stays the user's.
      const resolved = logEnvelopes(w.home, r.runId)
        .map((e) => e.body)
        .filter((b): b is Extract<typeof b, { t: 'ask-resolved' }> => b.t === 'ask-resolved')
      for (const id of before)
        expect(resolved.filter((b) => b.requestId === id)).toEqual([expect.objectContaining({ by: 'stop' })])
      expect(resolved.filter((b) => b.by !== 'stop' && b.by !== 'user')).toEqual([])
      expect(resolved.filter((b) => b.by === 'user').map((b) => b.decision)).toEqual(
        Array.from({ length: allowed }, () => 'allow'),
      )
      expect(folderVersion(w.folder)).toBeNull()
    }, 180_000)
  }

  it('Resume after a kill with the Allow recorded but not sent: Implement resumes its session and the run ends', async () => {
    const w = await chaos.world(ASK_SPEC)
    const point = 'command:answer#1'
    const k = await chaos.child(w, ANSWER_RUN, { kill: point })
    const { core, runId } = await verifyRelaunch(chaos, w, k, point, PAUSED)
    const sid = runDoc(w.home, runId).state.steps.implement.sessionId
    expect(sid).toBeDefined()
    value(await core.invoke('runs.resume', { runId }))
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    expect(await c.waitFor(settled, 180_000)).toMatchObject({ status: 'completed', outcome: 'clean' })
    expect(passArgvs(w.sc.entries()).filter((a) => a.includes(`--resume=${sid}`))).toHaveLength(1)
    expect(folderVersion(w.folder)).toBe(version('0.1.0').content)
  }, 300_000)

  for (const [what, point] of [
    ['Stop recorded, nothing done yet', 'command:stop#1'],
    ['Stop cancelling the waiting ask', 'effect:answer#1'],
    ['Stop interrupting Implement', 'effect:interrupt#1'],
    ["Implement's interrupted end arrived, not yet reduced", 'event:adapter:error#1'],
    ['the stopped snapshot', 'effect:snapshot#4'],
    ['the run cancelled, its folder lock not yet released', 'effect:unlock#1'],
  ] as const) {
    it(`${what} (${point}): the relaunch finishes the Stop, the run ends cancelled and frees the folder`, async () => {
      const w = await chaos.world(ASK_SPEC)
      const k = await chaos.child(w, STOP_RUN, { kill: point })
      const r = await verifyRelaunch(chaos, w, k, point, CANCELLED)
      expect(r.snap.asks).toEqual([])
      expect(r.snap.summary.lock).toBeUndefined()
      expect(r.core.scheduler.holders()).toEqual([])
      // Stop keeps what the run changed (R13): here nothing reached the folder.
      expect(folderVersion(w.folder)).toBeNull()
    }, 180_000)
  }
})
