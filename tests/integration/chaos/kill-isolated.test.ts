// Chaos (kill at each effect boundary; an isolated run's Prepare, Apply, Undo and Discard; state-machine row R12,
// "Crash relaunch"; "kill during apply -> idempotent Finish"): the child Dim Factory
// runs an isolated run and is killed at each boundary of its prepare and finalize: the worktree, the apply preview, the
// apply (its lease, its journal steps, its result), the Undo of a completed run's apply and the deferred Discard. The
// relaunch is checked as helpers.ts verifyRelaunch says; an apply cut short opens interruptedApply, whose Finish
// applies the run once, and a third launch changes nothing (the finalize journal is idempotent). Fixed here, each with
// its case as the proof: a completed run's Undo cut short stayed "undoing" for good, since boot recovery never looked
// at a run the index called completed; a Discard that finished just before the kill came back "kept" (the deletion
// was run again and refused).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { journalFile } from '../../../src/core/git/finalize.ts'
import {
  Chaos,
  ISO_APPLY_RUN,
  ISO_DISCARD_RUN,
  ISO_SPEC,
  folderTemps,
  folderVersion,
  runDoc,
  settled,
  value,
  verifyRelaunch,
} from './helpers.ts'
import type { ChaosWorld, KillExpect } from './helpers.ts'

const chaos = new Chaos()
afterEach(async () => chaos.dispose())

const V010 = 'export const version = "0.1.0"\n'

/** The finalize journal's finished applies (git/finalize.ts journal). */
function journalApplies(w: ChaosWorld, runId: string): { token: string; state: string }[] {
  const file = journalFile(w.home, runId)
  if (!existsSync(file)) return []
  const j = JSON.parse(readFileSync(file, 'utf8')) as { ops?: { token: string; state: string }[] }
  return (j.ops ?? []).map((o) => ({ token: o.token, state: o.state }))
}

const PREPARE: [string, string, KillExpect][] = [
  ['the worktree stage starting', 'effect:prepare#1', { paused: ['prepare'] }],
  ['the worktree made, not yet recorded', 'event:prepare-result#1', { paused: ['prepare'] }],
  ['the apply preview', 'effect:finalizePreview#1', { status: 'waiting', cards: ['finalize'] }],
  [
    'the finalize card opened, its index line not yet written',
    'effect:notify#1',
    { status: 'waiting', cards: ['finalize'] },
  ],
]

const APPLY_CUT: [string, string][] = [
  ['the apply starting', 'effect:apply#1'],
  ['the apply journaled', 'apply:started#1'],
  ['the pre-apply snapshot taken', 'apply:snapshot#1'],
  ['the apply planned', 'apply:planned#1'],
  ['the deletions done', 'apply:deleted#1'],
  ["a file's temp copy written, not yet renamed into place", 'apply:temp#1'],
  ['the first file written', 'apply:file#1'],
  ['every file written', 'apply:written#1'],
  ['the apply finished, its result not yet reduced', 'event:apply-result#1'],
]

describe('chaos: kill an isolated run at its prepare and finalize boundaries, then relaunch', () => {
  for (const [what, point, want] of PREPARE) {
    it(`${what} (${point})`, async () => {
      const w = await chaos.world(ISO_SPEC)
      const k = await chaos.child(w, ISO_APPLY_RUN, { kill: point })
      await verifyRelaunch(chaos, w, k, point, want)
      // Nothing reached the folder before an Apply.
      expect(folderVersion(w.folder)).toBeNull()
    }, 180_000)
  }

  for (const [what, point] of [
    ['Apply chosen, nothing run yet', 'command:card#1'],
    ["Apply chosen, the folder's lease asked for", 'effect:lease#1'],
  ] as const) {
    it(`${what} (${point}): the user's Apply goes on after the relaunch`, async () => {
      const w = await chaos.world(ISO_SPEC)
      const k = await chaos.child(w, ISO_APPLY_RUN, { kill: point })
      const r = await verifyRelaunch(chaos, w, k, point, { status: 'completed', outcome: 'clean' })
      expect(folderVersion(w.folder)).toBe(V010)
      expect(journalApplies(w, r.runId)).toEqual([expect.objectContaining({ state: 'applied' })])
      expect(r.core.scheduler.holders()).toEqual([])
    }, 180_000)
  }

  for (const [what, point] of APPLY_CUT) {
    it(`${what} (${point}): interruptedApply, Finish applies once, a third launch changes nothing`, async () => {
      const w = await chaos.world(ISO_SPEC)
      const k = await chaos.child(w, ISO_APPLY_RUN, { kill: point })
      const { core, runId, snap } = await verifyRelaunch(chaos, w, k, point, {
        status: 'waiting',
        cards: ['interruptedApply'],
        outcome: 'clean',
      })
      const card = snap.cards.find((c) => c.kind === 'interruptedApply')
      // The relaunch itself writes nothing into the user's folder; a temp copy a cut write left waits for Finish.
      expect(folderTemps(w.folder)).toEqual(
        point === 'apply:temp#1' ? [expect.stringMatching(/^src\/version\.ts\./)] : [],
      )
      value(await core.invoke('cards.resolve', { runId, cardId: card?.id ?? '', choiceId: 'finish-apply' }))
      const c = core.controller(runId)
      if (c === undefined) throw new Error('no controller')
      const end = await c.waitFor(settled, 120_000)
      await c.settle(15_000)
      expect(end).toMatchObject({ status: 'completed', outcome: 'clean' })
      expect(end.isolation?.finalize?.state).toBe('applied')
      expect(end.isolation?.finalize?.applies).toHaveLength(1)
      expect(folderVersion(w.folder)).toBe(V010)
      // Finish leaves no temp copy of a cut write behind in the folder (finalize.ts removeLeftoverTemps).
      expect(folderTemps(w.folder)).toEqual([])
      const applied = journalApplies(w, runId)
      expect(applied.filter((o) => o.state === 'applied')).toHaveLength(1)
      await chaos.stop(core)
      // A third launch: nothing to recover, nothing applied again.
      const third = await chaos.relaunch(w)
      expect(third.core.recovery.paused).toEqual([])
      const snap3 = value(await third.core.invoke('runs.get', { runId }))
      expect(snap3.summary).toMatchObject({
        status: 'completed',
        worktree: { state: 'applied', notApplied: false },
      })
      expect(journalApplies(w, runId)).toEqual(applied)
      expect(folderVersion(w.folder)).toBe(V010)
    }, 240_000)
  }

  it('the apply done, the lease not yet given back (effect:unlease#1)', async () => {
    const w = await chaos.world(ISO_SPEC)
    const point = 'effect:unlease#1'
    const k = await chaos.child(w, ISO_APPLY_RUN, { kill: point })
    const r = await verifyRelaunch(chaos, w, k, point, { status: 'completed', outcome: 'clean' })
    expect(r.snap.summary.worktree).toEqual({ state: 'applied', notApplied: false })
    expect(r.core.scheduler.holders()).toEqual([])
    expect(folderVersion(w.folder)).toBe(V010)
  }, 180_000)

  for (const [what, point, undone] of [
    ['the Undo asked for, nothing run yet', 'command:undo-apply#1', true],
    ['the Undo starting', 'effect:undoApply#1', false],
    ['the Undo done, its result not yet reduced', 'event:undo-apply-result#1', false],
  ] as const) {
    it(`${what} (${point}) on a completed run: recovered, and Undo finishes`, async () => {
      const w = await chaos.world(ISO_SPEC)
      const k = await chaos.child(w, ISO_APPLY_RUN, { kill: point })
      const { core, runId, snap } = await verifyRelaunch(chaos, w, k, point, {
        status: 'completed',
        outcome: 'clean',
      })
      if (undone) {
        // The user's Undo was recorded before the kill: the relaunch finished it (the finalize journal).
        expect(snap.summary.worktree).toEqual({ state: 'kept', notApplied: true })
        expect(folderVersion(w.folder)).toBeNull()
        return
      }
      // Cut short: the run reads applied again with a note, never "undoing" for good; Undo again finishes it.
      expect(snap.summary.worktree).toEqual({ state: 'applied', notApplied: false })
      expect(snap.notes).toContain(
        'Dim Factory closed while it was undoing an apply. Undo again to finish it.',
      )
      const token = runDoc(w.home, runId).state.isolation?.finalize?.applies?.at(-1)?.token ?? ''
      value(await core.invoke('worktree.undoApply', { runId, undoToken: token }))
      const after = value(await core.invoke('runs.get', { runId }))
      expect(after.summary.worktree).toEqual({ state: 'kept', notApplied: true })
      expect(folderVersion(w.folder)).toBeNull()
    }, 180_000)
  }

  for (const [what, point, want] of [
    ['Discard chosen (its 10 s not yet over)', 'command:card#1', 'deferred'],
    ['the Discard timer due, not yet reduced', 'event:timer#1', 'deferred'],
    ['the deletion starting', 'effect:removeWorktree#1', 'removed'],
    ['the deletion recorded in the journal', 'finalize:discard-recorded#1', 'removed'],
    ['the copy deleted, the result not yet reduced', 'event:remove-result#1', 'removed'],
  ] as const) {
    it(`${what} (${point}): the copy is deleted once and the run ends discarded`, async () => {
      const w = await chaos.world(ISO_SPEC)
      const k = await chaos.child(w, ISO_DISCARD_RUN, { kill: point })
      const { core, runId, snap } = await verifyRelaunch(
        chaos,
        w,
        k,
        point,
        want === 'deferred'
          ? { status: 'running', outcome: 'clean' }
          : { status: 'completed', outcome: 'clean' },
      )
      if (want === 'deferred') {
        // The Discard's 10 s start again (it can still be undone); then the copy goes.
        expect(snap.summary.worktree).toEqual({ state: 'discarding', notApplied: false })
        value(await core.advanceClock(15_000))
        const c = core.controller(runId)
        if (c === undefined) throw new Error('no controller')
        await c.waitFor(settled, 60_000)
        await c.settle(15_000)
      }
      const end = value(await core.invoke('runs.get', { runId }))
      expect(end.summary).toMatchObject({
        status: 'completed',
        worktree: { state: 'discarded', notApplied: false },
      })
      expect(end.notes).not.toContain(expect.stringMatching(/could not delete the isolated copy/))
      expect(existsSync(join(w.home, 'worktrees', runId))).toBe(false)
      expect(folderVersion(w.folder)).toBeNull()
    }, 180_000)
  }
})
