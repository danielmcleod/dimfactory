// Reverts through a real core, the git shadow and the fake Claude (revert to S0, the plan-end guard;
// state-machine rows R2, R4, P21):
//   - diff.revert refused (FOLDER_BUSY) while Implement runs; after the run: revert all → the folder's bytes as at S0
//     (CRLF kept); diff.undoRevert → the run's bytes again; a second undo is refused
//   - Plan wrote a file → planMutated → Revert Plan's changes → the file is gone → the run goes on; undo brings it back
//     (deterministic: Plan spawns only after run-start, R2)
//   - P21 revert-then-fresh: Implement failed after writing → Retry → the partial file reverted → a fresh Implement
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { passArgvs } from '../run/scenario.ts'
import {
  World,
  allowAsks,
  choose,
  gitOut,
  settled,
  snapshotOf,
  value,
  versionWrite,
  waitCard,
} from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const bytes = (folder: string, rel: string): Buffer => readFileSync(join(folder, rel))

describe('reverts (core + git + fake Claude)', () => {
  it('diff.revert: refused while Implement runs; revert all is byte-exact (CRLF); undo is byte-exact', async () => {
    const b = await w.boot({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'data/crlf.txt', content: 'changed by the run\n' },
          delayMs: 4000,
        },
      ],
    })
    const f = b.folder
    // A committed README the run never touches, and an untracked CRLF file the run rewrites (the shadow keeps the
    // folder's bytes whatever autocrlf says).
    writeFileSync(join(f, 'README.md'), 'readme\n')
    gitOut(f, 'add', 'README.md')
    gitOut(f, 'commit', '-q', '-m', 'readme')
    const original = Buffer.from('line one\r\nline two\r\nété\r\n', 'utf8')
    mkdirSync(join(f, 'data'), { recursive: true })
    writeFileSync(join(f, 'data/crlf.txt'), original)

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
    await c.waitFor((s) => s.steps.implement.proc?.live === true, 90_000)
    const busy = await b.core.invoke('diff.revert', { runId: t.runId, paths: 'all' })
    expect(busy.ok ? null : busy.error).toMatchObject({ code: 'FOLDER_BUSY' })

    const done = await c.waitFor(settled, 120_000)
    await c.settle(15_000)
    expect(done.status).toBe('completed')
    expect(bytes(f, 'data/crlf.txt').toString('utf8')).toBe('changed by the run\n')

    const r = value(await b.core.invoke('diff.revert', { runId: t.runId, paths: 'all' }))
    expect(r).toMatchObject({ restored: ['data/crlf.txt'], deleted: [], skipped: [] })
    expect(bytes(f, 'data/crlf.txt').equals(original)).toBe(true)
    // README.md was never the run's: untouched.
    expect(bytes(f, 'README.md').toString('utf8')).toBe('readme\n')

    value(await b.core.invoke('diff.undoRevert', { runId: t.runId, undoToken: r.undoToken }))
    expect(bytes(f, 'data/crlf.txt').toString('utf8')).toBe('changed by the run\n')
    const twice = await b.core.invoke('diff.undoRevert', { runId: t.runId, undoToken: r.undoToken })
    expect(twice.ok ? null : twice.error.code).toBe('CONFLICT')
    const snaps = JSON.parse(readFileSync(join(t.home, 'runs', t.runId, 'snapshots.json'), 'utf8')) as {
      snapshots: { label: string }[]
    }
    expect(snaps.snapshots.filter((s) => s.label === 'pre-revert')).toHaveLength(2)
  }, 240_000)

  it('planMutated: Plan wrote a file → Revert Plan’s changes → gone → the run goes on; undo brings it back', async () => {
    const planBytes = 'Plan should not have written this.\r\n'
    const t = await w.start({
      plan: { recording: 'C06-plan-native-host', write: { path: 'PLAN-NOTES.md', content: planBytes } },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
    })
    allowAsks(t)
    const card = await waitCard(t.c, 'planMutated')
    // R2: Plan spawned only once run-start was taken, so its write can never be folded into run-start (the guard
    // always sees it, however slow the snapshot is).
    const runStart = t.c.state.snapshots['run-start']
    expect(runStart).toBeDefined()
    expect(t.c.state.steps.plan.proc?.spawnedAt).toBeGreaterThanOrEqual(runStart?.at ?? Infinity)
    expect(card).toMatchObject({ title: 'Plan changed files', payload: { paths: ['PLAN-NOTES.md'] } })
    expect(card.defaultChoice).toBeUndefined()
    // Implement waits for the answer.
    expect(t.c.state.plan.decided).toBe(false)
    expect(t.c.state.steps.implement.status).toBe('queued')
    await choose(t, card, 'revert-plan')
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.status).toBe('completed')
    expect(existsSync(join(t.folder, 'PLAN-NOTES.md'))).toBe(false)
    // The pre-implement reconcile did not count Plan's reverted file as "changed during planning".
    expect(done.steps.implement.chip).toBeUndefined()
    const snap = await snapshotOf(t)
    expect(snap.revertUndo).toMatchObject({ label: "Plan's changes", files: 1 })
    value(
      await t.core.invoke('diff.undoRevert', { runId: t.runId, undoToken: snap.revertUndo?.undoToken ?? '' }),
    )
    expect(readFileSync(join(t.folder, 'PLAN-NOTES.md'), 'utf8')).toBe(planBytes)
  }, 240_000)

  it('P21 revert-then-fresh: the failed attempt’s file is reverted, then Implement starts fresh', async () => {
    const t = await w.start({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        { recording: 'C09b-logged-out', write: { path: 'src/partial.ts', content: 'half done\n' } },
        { recording: 'C08a-session-id-implement', write: versionWrite },
      ],
    })
    allowAsks(t)
    const failed = await t.c.waitFor((s) => s.steps.implement.status === 'failed' || settled(s), 90_000)
    expect(failed.steps.implement.status).toBe('failed')
    expect(existsSync(join(t.folder, 'src/partial.ts'))).toBe(true)
    value(
      await t.core.invoke('runs.retryPass', {
        runId: t.runId,
        pass: 'implement',
        strategy: 'revert-then-fresh',
      }),
    )
    const done = await t.c.waitFor((s) => s.status === 'completed' || s.status === 'cancelled', 120_000)
    await t.c.settle(15_000)
    expect(done.status, done.notes.join(' | ')).toBe('completed')
    expect(existsSync(join(t.folder, 'src/partial.ts'))).toBe(false)
    expect(readFileSync(join(t.folder, 'src/version.ts'), 'utf8')).toBe(versionWrite.content)
    expect(done.steps.implement.attempt).toBe(2)
    expect(done.notes).toContain("Reverted Implement's partial changes (1 file) before the fresh retry.")
    // The second Implement started fresh (its own session id, no --resume).
    const implement = passArgvs(t.sc.entries()).filter((a) => a.includes('acceptEdits'))
    expect(implement).toHaveLength(2)
    expect(implement[1]?.some((x) => x.startsWith('--resume'))).toBe(false)
    expect((await snapshotOf(t)).revertUndo).toMatchObject({ label: "Implement's partial changes", files: 1 })
  }, 240_000)
})
