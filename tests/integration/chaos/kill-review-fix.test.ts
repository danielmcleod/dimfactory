// Chaos (kill at each effect boundary; "Crash relaunch", state-machine rows P24, R7, R8, R10, R11; the
// revert write-ahead): the child Dim Factory is killed at each effect boundary from the end of verify:1 to the run's end
// (Review ∥ Critic, the findings parse, F0, Fix, S2, verify:2, the completion's index line and the folder lock), and
// during a diff.revert of the finished run, then relaunched on the same home and checked as helpers.ts verifyRelaunch
// says. Fixed here, each with its case as the proof: a completed run's index line lost to the kill stayed "running"
// for good; a revert killed part way stayed pending for good, with no Undo offered.
import { afterEach, describe, expect, it } from 'vitest'
import { NO_FINDINGS_REVIEW } from '../run/scenario.ts'
import type { ScenarioSpec } from '../run/scenario.ts'
import { Chaos, FULL_RUN, FULL_SPEC, folderVersion, indexEntries, value, verifyRelaunch } from './helpers.ts'
import type { KillExpect } from './helpers.ts'

const chaos = new Chaos()
afterEach(async () => chaos.dispose())

const DONE: KillExpect = { status: 'completed', outcome: 'fixed' }

/** Review ∥ Critic in a known order: Critic answers 3 s after its prompt, so Review's findings are parsed first. */
const SPEC: ScenarioSpec = { ...FULL_SPEC, critic: [{ ...NO_FINDINGS_REVIEW, delayMs: 3000 }] }

const CASES: [string, string, KillExpect][] = [
  ['the post-verify-1 snapshot (R7)', 'effect:snapshot#5', { paused: ['review', 'critic'] }],
  ['the pre-review reconcile', 'effect:reconcile#3', { paused: ['review', 'critic'] }],
  ["Review's spawn", 'effect:spawn#3', { paused: ['review', 'critic'] }],
  ["Critic's process up and recorded", 'spawn:recorded#4', { paused: ['review', 'critic'] }],
  ["Review's findings parse", 'effect:parseFindings#1', { paused: ['critic'] }],
  ["Critic's findings parsed, not yet reduced", 'event:findings-result#2', { paused: ['fix'] }],
  ['the post-review snapshot (R8)', 'effect:snapshot#6', { paused: ['fix'] }],
  ['the F0 snapshot (R10)', 'effect:snapshot#7', { paused: ['fix'] }],
  ["Fix's session check", 'event:session-check#1', { paused: ['fix'] }],
  ["Fix's spawn", 'effect:spawn#5', { paused: ['fix'] }],
  ["Fix's process up and recorded", 'spawn:recorded#5', { paused: ['fix'] }],
  ["Fix's answer arrived, not yet reduced", 'event:adapter:done#5', { paused: ['fix'] }],
  ['the S2 snapshot', 'effect:snapshot#8', { paused: ['verify:2'] }],
  ['verify:2 starting', 'effect:verify#2', { paused: ['verify:2'] }],
  ['verify:2 done, its result not yet reduced', 'event:verify-result#2', { paused: ['verify:2'] }],
  ['the completion recorded, its notice not yet sent', 'effect:notify#2', DONE],
  ['the completion recorded, the folder lock not yet released', 'effect:unlock#1', DONE],
  ['the completion recorded, its index line not yet written', 'effect:index#10', DONE],
  ['the completion indexed', 'index:appended:completed#1', DONE],
  ['the revert asked for, nothing done yet', 'command:revert#1', DONE],
  ['the revert starting', 'effect:revert#1', DONE],
]

describe('chaos: kill from verify:1 to the run end and during a revert, then relaunch', () => {
  for (const [what, point, want] of CASES) {
    it(`${what} (${point})`, async () => {
      const w = await chaos.world(SPEC, { trustCheck: true })
      const k = await chaos.child(w, FULL_RUN, { kill: point })
      const r = await verifyRelaunch(chaos, w, k, point, want)
      if (want.status === 'completed') {
        // The run's result is in the folder; nothing undone and nothing to undo.
        expect(folderVersion(w.folder)).toContain('1.0.0')
        expect(r.snap.revertUndo).toBeUndefined()
        expect(indexEntries(w.home).get(r.runId)).toMatchObject({ status: 'completed', outcome: 'fixed' })
      }
    }, 180_000)
  }

  for (const [what, point, reverted] of [
    ['the revert recorded (its undo point taken), nothing written yet', 'revert:planned#1', false],
    ['the revert written, its result not yet reduced', 'event:revert-result#1', true],
  ] as const) {
    it(`${what} (${point}): the relaunch offers its Undo, which puts the run's result back`, async () => {
      const w = await chaos.world(SPEC, { trustCheck: true })
      const k = await chaos.child(w, FULL_RUN, { kill: point })
      const { core, runId, snap } = await verifyRelaunch(chaos, w, k, point, DONE)
      expect(folderVersion(w.folder) === null).toBe(reverted)
      // The revert write-ahead: the interrupted revert keeps its Undo (also on a finished run), and says so.
      expect(snap.revertUndo).toMatchObject({ label: "the run's changes", files: 1 })
      expect(snap.notes.at(-1)).toBe(
        'Revert was interrupted when Dim Factory closed, so 1 file may be only partly reverted. Undo puts back what it changed.',
      )
      value(await core.invoke('diff.undoRevert', { runId, undoToken: snap.revertUndo?.undoToken ?? '' }))
      expect(folderVersion(w.folder)).toContain('1.0.0')
      const after = value(await core.invoke('runs.get', { runId }))
      expect(after.revertUndo).toBeUndefined()
      expect(after.summary).toMatchObject({ status: 'completed', outcome: 'fixed' })
    }, 180_000)
  }
})
