// Reconciliation through a real core, the git shadow and the fake Claude (state-machine rows R5, R10; reconcile-restore.spec.ts):
//   - reconcile-restore.spec.ts: an external write overlapping a run path between passes → reconcile card → Restore run's version →
//     absent from the Combined diff; the restore's undo brings the user's bytes back
//   - a non-overlapping edit and a revert at the gate before Fix become the Fix prompt's notes
//   - a merge in progress → block card at R5 with the copyable `git merge --abort` → abort → Recheck → the run goes on
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { REVIEW_WITH_FINDINGS } from '../run/scenario.ts'
import {
  World,
  allowAsks,
  choose,
  fixWrite,
  gitOut,
  readText,
  settled,
  snapshotOf,
  userMessage,
  value,
  versionWrite,
  waitCard,
} from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const WITH_FINDINGS = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
  resume: [{ recording: 'C08b-resume-fix', write: fixWrite }],
}
const GATED = { overrides: { gates: { afterPlan: false, beforeFix: true } } }

describe('reconcile (core + git + fake Claude)', () => {
  it('an overlapping external write → reconcile card → Restore run’s version → not in the Combined diff', async () => {
    const t = await w.start(WITH_FINDINGS, GATED)
    allowAsks(t)
    const gate = await waitCard(t.c, 'gate:beforeFix')
    // Between passes: the user edits a file the run created.
    const external = 'export const version = "edited by hand"\r\n'
    writeFileSync(join(t.folder, 'src/version.ts'), external)
    await choose(t, gate, 'continue')

    const card = await waitCard(t.c, 'reconcile')
    expect(card.title).toBe('1 file the run changed was edited outside it')
    expect(card.defaultChoice).toBe('include-my-edits')
    expect(card.payload).toMatchObject({
      boundary: 'pre-fix',
      step: 'fix',
      verdict: 'choice',
      paths: { external: ['src/version.ts'], overlapping: ['src/version.ts'] },
    })
    expect(card.choices.map((c) => c.id)).toEqual(['include-my-edits', 'restore-run-version', 'stop'])
    // Fix waits on the card.
    expect(t.c.state.steps.fix.spawnNo).toBe(0)
    await choose(t, card, 'restore-run-version')

    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.outcome).toBe('fixed')
    expect(readText(t.folder, 'src/version.ts')).toBe(versionWrite.content)
    expect(done.notes).toContain("Restored the run's version of src/version.ts.")
    const combined = readFileSync(join(t.home, 'runs', t.runId, 'diffs', 'S0..S2.patch'), 'utf8')
    expect(combined).toContain('src/version.ts')
    expect(combined).not.toContain('edited by hand')
    // The same through the IPC the Diff tab reads: the Combined segment's files and the file's patch.
    const files = value(await t.core.invoke('diff.files', { runId: t.runId, seg: 'combined' }))
    expect(files.available).toEqual(['implement', 'fix', 'combined'])
    expect(files.files.find((x) => x.path === 'src/version.ts')).toMatchObject({ status: 'A', binary: false })
    const patch = value(
      await t.core.invoke('diff.file', { runId: t.runId, seg: 'combined', path: 'src/version.ts' }),
    )
    expect(patch.truncated).toBe(false)
    expect(patch.patch).toContain('+export const version = "0.1.0"')
    expect(patch.patch).not.toContain('edited by hand')
    const missing = await t.core.invoke('diff.file', { runId: t.runId, seg: 'combined', path: 'nope.ts' })
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND')

    // The restore is undoable: the user's bytes come back exactly.
    const snap = await snapshotOf(t)
    expect(snap.revertUndo).toMatchObject({ label: 'your edits outside the run', files: 1 })
    value(
      await t.core.invoke('diff.undoRevert', { runId: t.runId, undoToken: snap.revertUndo?.undoToken ?? '' }),
    )
    expect(readFileSync(join(t.folder, 'src/version.ts'), 'utf8')).toBe(external)
    expect((await snapshotOf(t)).revertUndo).toBeUndefined()
  }, 240_000)

  it('a non-overlapping edit and a revert at the gate before Fix reach the Fix prompt as notes', async () => {
    const t = await w.start(WITH_FINDINGS, GATED)
    allowAsks(t)
    const gate = await waitCard(t.c, 'gate:beforeFix')
    // A file the run did not touch, edited by hand.
    writeFileSync(join(t.folder, 'src/cli.ts'), `${readText(t.folder, 'src/cli.ts')}// by hand\n`)
    // The user reverts the run's new file at the gate.
    const r = value(
      await t.core.invoke('diff.revert', { runId: t.runId, seg: 'implement', paths: ['src/version.ts'] }),
    )
    expect(r).toMatchObject({ restored: [], deleted: ['src/version.ts'], skipped: [] })
    expect(r.undoToken).not.toBe('')
    expect(() => readText(t.folder, 'src/version.ts')).toThrow()
    // The gate shows the note.
    const refreshed = await t.c.waitFor((s) =>
      (s.findings?.notes ?? []).includes('User reverted after review: src/version.ts'),
    )
    expect(refreshed.cards.find((c) => c.view.kind === 'gate:beforeFix')?.view.body).toContain(
      'Note: User reverted after review: src/version.ts',
    )
    await choose(t, gate, 'continue')

    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.outcome).toBe('fixed')
    expect(done.cards).toHaveLength(0)
    const fixPrompt = userMessage(t, 'resume-1.script.jsonl')
    expect(fixPrompt).toContain('User reverted after review: src/version.ts')
    expect(fixPrompt).toContain('User edited outside the run: src/cli.ts')
    // The reverted path is Dim Factory's own write, not an external edit.
    expect(fixPrompt).not.toContain('User edited outside the run: src/cli.ts, src/version.ts')
  }, 240_000)

  it('merge in progress → block card at R5 with the copyable abort → abort → Recheck → Implement runs', async () => {
    const b = await w.boot({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
    })
    const f = b.folder
    const main = gitOut(f, 'symbolic-ref', '--short', 'HEAD')
    gitOut(f, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(f, 'src/index.ts'), 'export const side = "other"\n')
    gitOut(f, 'commit', '-q', '-am', 'other')
    gitOut(f, 'checkout', '-q', main)
    writeFileSync(join(f, 'src/index.ts'), 'export const side = "main"\n')
    gitOut(f, 'commit', '-q', '-am', 'main')
    const merge = spawnSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'merge', 'other'],
      { cwd: f, encoding: 'utf8', windowsHide: true },
    )
    expect(merge.status).not.toBe(0)

    const started = value(
      await b.core.invoke('runs.start', {
        folder: f,
        task: 'add a --version flag',
        overrides: { gates: { afterPlan: false } },
      }),
    )
    const c = b.core.controller(started.runId)
    if (c === undefined) throw new Error('no controller')
    const t = { ...b, c, runId: started.runId }
    allowAsks(t)
    const card = await waitCard(c, 'reconcile')
    expect(card.defaultChoice).toBeUndefined()
    expect(card.title).toContain('A git merge is in progress')
    const payload = card.payload as {
      boundary: string
      reasons: { row: string; actions: { id: string; kind: string; command: string }[] }[]
    }
    expect(payload.boundary).toBe('pre-implement')
    expect(payload.reasons.map((r) => r.row)).toEqual(['operation', 'unmerged'])
    const abort = payload.reasons[0]?.actions[0]
    expect(abort).toMatchObject({ kind: 'shell_copy', command: 'git merge --abort' })
    // Nothing was snapshotted for Implement and nothing spawned.
    expect(c.state.steps.implement.startSnap).toBeUndefined()
    expect(c.state.steps.implement.spawnNo).toBe(0)
    // The copyable command goes through recovery.execute like any other.
    const copied = value(
      await b.core.invoke('recovery.execute', { actionId: abort?.id ?? '', runId: t.runId }),
    )
    expect(copied).toMatchObject({ kind: 'shell_copy', copied: 'git merge --abort' })

    gitOut(f, 'merge', '--abort')
    await choose(t, card, 'recheck')
    const done = await c.waitFor(settled, 120_000)
    await c.settle(15_000)
    expect(done.status).toBe('completed')
    expect(done.steps.implement.status).toBe('done')
    expect(readText(f, 'src/version.ts')).toBe(versionWrite.content)
  }, 240_000)
})
