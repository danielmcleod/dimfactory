// Review fixes through a real core, the git shadow and the fake Claude (revert to S0; state-machine row P21), the
// reviewers' probes as tests:
//   - Revert all → Undo → Revert all again, with a file the user made after the run: the run's change is reverted
//     again and the user's file stays
//   - reconcile-restore.spec.ts with Fix writing the restored file: the restore's Undo is no longer offered after the run, and pressing an
//     older Undo is refused (CONFLICT) with Fix's bytes kept
//   - revert-then-fresh with a file the user made while the pass sat failed: only the failed attempt's file goes
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import { REVIEW_WITH_FINDINGS } from '../run/scenario.ts'
import {
  World,
  allowAsks,
  choose,
  readText,
  settled,
  snapshotOf,
  value,
  versionWrite,
  waitCard,
} from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

describe('review fixes (core + git + fake Claude)', () => {
  it('Revert all → Undo → Revert all: the run’s change again, the user’s later file kept', async () => {
    const b = await w.boot({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'data/crlf.txt', content: 'changed by the run\n' },
        },
      ],
    })
    const f = b.folder
    const original = 'line one\r\nline two\r\n'
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
    const done = await c.waitFor(settled, 120_000)
    await c.settle(15_000)
    expect(done.status).toBe('completed')
    // The user's own file, after the run.
    writeFileSync(join(f, 'mine.txt'), 'my notes\n')

    const first = value(await b.core.invoke('diff.revert', { runId: t.runId, paths: 'all' }))
    expect(first).toMatchObject({ restored: ['data/crlf.txt'], deleted: [], skipped: [] })
    expect(readText(f, 'data/crlf.txt')).toBe(original)
    value(await b.core.invoke('diff.undoRevert', { runId: t.runId, undoToken: first.undoToken }))
    expect(readText(f, 'data/crlf.txt')).toBe('changed by the run\n')

    const again = value(await b.core.invoke('diff.revert', { runId: t.runId, paths: 'all' }))
    expect(again).toMatchObject({ restored: ['data/crlf.txt'], deleted: [], skipped: [] })
    expect(readText(f, 'data/crlf.txt')).toBe(original)
    expect(readText(f, 'mine.txt')).toBe('my notes\n')
    // Clicked once more: nothing left to revert, still not the user's file.
    const third = value(await b.core.invoke('diff.revert', { runId: t.runId, paths: 'all' }))
    expect(third).toMatchObject({ restored: [], deleted: [] })
    expect(existsSync(join(f, 'mine.txt'))).toBe(true)
  }, 240_000)

  it('with Fix writing the restored file: no Undo after the run; an older Undo is refused, Fix’s bytes kept', async () => {
    const fixVersion = 'export const version = "0.1.1 fixed by Fix"\n'
    const t = await w.start(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
        review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
        resume: [{ recording: 'C08b-resume-fix', write: { path: 'src/version.ts', content: fixVersion } }],
      },
      { overrides: { gates: { afterPlan: false, beforeFix: true } } },
    )
    allowAsks(t)
    const gate = await waitCard(t.c, 'gate:beforeFix')
    writeFileSync(join(t.folder, 'src/version.ts'), 'export const version = "edited by hand"\r\n')
    await choose(t, gate, 'continue')
    const card = await waitCard(t.c, 'reconcile')
    await choose(t, card, 'restore-run-version')
    // The restore's token, as its toast offered it while Fix ran.
    const during = await t.c.waitFor((s) => (s.git?.reverts ?? []).some((r) => r.why === 'restore'), 60_000)
    const token = during.git?.reverts?.find((r) => r.why === 'restore')?.token ?? ''
    expect(token).not.toBe('')

    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.outcome).toBe('fixed')
    expect(readText(t.folder, 'src/version.ts')).toBe(fixVersion)
    // Fix rewrote the restored file: "After the run" no longer offers the restore's Undo.
    expect((await snapshotOf(t)).revertUndo).toBeUndefined()
    const undo = await t.core.invoke('diff.undoRevert', { runId: t.runId, undoToken: token })
    expect(undo.ok ? null : undo.error.code).toBe('CONFLICT')
    expect(undo.ok ? '' : undo.error.message).toContain('src/version.ts')
    expect(readText(t.folder, 'src/version.ts')).toBe(fixVersion)
  }, 240_000)

  it('revert-then-fresh: the failed attempt’s file goes, a file made while the pass sat failed stays', async () => {
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
    // The attempt's end is recorded before the user does anything.
    await t.c.waitFor((s) => s.steps.implement.attemptEnd !== undefined, 60_000)
    writeFileSync(join(t.folder, 'MY-NOTES.md'), 'notes made while Implement sat failed\n')
    value(
      await t.core.invoke('runs.retryPass', {
        runId: t.runId,
        pass: 'implement',
        strategy: 'revert-then-fresh',
      }),
    )
    // Ends however it ends (a failed run, or Implement failing again: a refused revert, a second failed attempt), so
    // the assertion below says why instead of a bare timeout; on a timeout the run's state says where it stood.
    const firstFailure = JSON.stringify(failed.steps.implement.failure)
    const ended = (s: RunState): boolean =>
      settled(s) ||
      (s.steps.implement.status === 'failed' &&
        (s.steps.implement.spawnNo > failed.steps.implement.spawnNo ||
          JSON.stringify(s.steps.implement.failure) !== firstFailure))
    const done = await t.c.waitFor(ended, 120_000).catch(async (err: unknown) => {
      const s = await snapshotOf(t)
      const where = { status: s.summary.status, implement: s.steps.implement, cards: s.cards, notes: s.notes }
      throw new Error(`${String(err)}; the run: ${JSON.stringify(where)}`)
    })
    await t.c.settle(15_000)
    const why = [...done.notes, JSON.stringify(done.steps.implement.failure ?? null)].join(' | ')
    expect(done.status, why).toBe('completed')
    expect(existsSync(join(t.folder, 'src/partial.ts'))).toBe(false)
    expect(readFileSync(join(t.folder, 'MY-NOTES.md'), 'utf8')).toBe(
      'notes made while Implement sat failed\n',
    )
    expect(done.notes).toContain("Reverted Implement's partial changes (1 file) before the fresh retry.")
  }, 240_000)
})
