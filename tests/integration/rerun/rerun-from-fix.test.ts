// Re-run from Fix through a real core and the fake Claude (state-machine rows R10/R13/R14, history.spec.ts "re-run from Fix
// (the fake sees --resume=<id>), including from a failed run"):
//   - from a failed run holding its folder: the source is closed (outcome failed, its `stopped` snapshot) as the
//     re-run queues; the re-run carries Plan, Implement, Review and Critic and its Fix resumes Implement's session
//   - from a run paused by a quit, after a relaunch, with another run queued behind it: the re-run takes the folder
//     first (R14 "atomically"); the queued run still waits
//   - a fresh Fix (the run's Fix row says Fresh) with one chosen finding: its prompt has that finding and S0..F0
//   - the folder changed where the run did: the reconcile card holds Fix; Include my edits tells Fix
//   - snapshots cleared: refused, nothing created
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FindingsFile } from '../../../src/shared/findings.ts'
import { SHADOW_REF_PREFIX } from '../../../src/core/git/shadow.ts'
import { Bench, RESUMED_FIX, SOURCE, fixWrite, passes, readJson, runDirs, settled, value } from './helpers.ts'

const b = new Bench()
afterEach(() => b.dispose())

const GATE_BEFORE_FIX = { gates: { afterPlan: false, beforeFix: true } }

/** A shadow git command (read only) against the folder's shadow repository. */
function shadowGit(gitDir: string, ...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', windowsHide: true })
  return { status: r.status, stdout: r.stdout }
}

describe('Re-run from Fix (core + fake Claude)', () => {
  it('from a failed run: the source is closed as the re-run queues; Fix resumes Implement’s session (--resume=<id>)', async () => {
    const core = await b.setup({ ...SOURCE, resume: [{ recording: 'C09b-logged-out' }, RESUMED_FIX] })
    const src = await b.start(core, { gates: { afterPlan: false } })
    const failed = await src.waitFor(settled, 120_000)
    await src.settle(10_000)
    expect(failed.status, failed.notes.join(' | ')).toBe('failed')
    expect(failed.steps.fix.status).toBe('failed')
    expect(src.state.lock).toBe('held')
    const impl = failed.steps.implement.sessionId ?? ''
    expect(impl).not.toBe('')

    const snap = value(await core.invoke('runs.get', { runId: src.runId }))
    expect(snap.rerunFromFix).toMatchObject({ available: true, fresh: false })
    const ids = snap.rerunFromFix.findingIds ?? []
    expect(ids).toHaveLength(3)

    const r = value(await core.invoke('runs.rerun', { runId: src.runId, from: 'fix' }))
    // R13/R14: the source was closed in the same step (a failed run's Close: outcome failed, its failure kept).
    expect(src.state.status).toBe('cancelled')
    expect(src.state.outcome).toBe('failed')
    expect(src.state.failure?.step).toBe('fix')

    const c = b.controller(core, r.runId)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.outcome, done.notes.join(' | ')).toBe('fixed')
    // The source let the folder go after its `stopped` snapshot, to the re-run.
    expect(src.state.stop?.snapshot).toBe('done')
    expect(src.state.lock).toBe('none')

    // C08: the re-run's Fix continued Implement's session; nothing else ran again.
    const p = passes(b)
    expect(p.resumed).toHaveLength(2)
    expect(p.resumed[1]).toContain(`--resume=${impl}`)
    expect(p.resumed[1]?.some((x) => x.startsWith('--session-id'))).toBe(false)
    expect(p.all.filter((a) => a.includes('plan'))).toHaveLength(1)
    expect(p.all.filter((a) => a.includes('dontAsk'))).toHaveLength(2)
    expect(done.steps.fix).toMatchObject({
      status: 'done',
      attempt: 1,
      sessionNote: 'reused the Implement session',
    })
    for (const k of ['plan', 'implement', 'review', 'critic'] as const) {
      expect(done.steps[k]).toMatchObject({
        status: 'skipped',
        reason: `carried from run #${failed.displayNo}`,
      })
    }
    expect(done.rerunOf).toMatchObject({ runId: src.runId, displayNo: failed.displayNo, from: 'fix' })
    expect(readFileSync(join(b.folder, fixWrite.path), 'utf8')).toBe(fixWrite.content)

    // The carried artifacts and findings.json (the chosen findings, Fix's report added at S2).
    const run = core.paths.run(r.runId)
    for (const f of [run.planMd, run.reviewMd, run.criticMd, run.diffPatch('S0..S1')]) {
      expect(existsSync(f), f).toBe(true)
    }
    const findings = readJson(run.findingsJson) as unknown as FindingsFile
    expect(findings.runId).toBe(r.runId)
    expect(
      Object.entries(findings.selected)
        .filter(([, v]) => v)
        .map(([k]) => k),
    ).toEqual(ids)
    expect(value(await core.invoke('runs.output', { runId: r.runId, file: 'plan' })).text).toBe(
      readFileSync(core.paths.run(src.runId).planMd, 'utf8'),
    )
    const resolved = readJson(run.resolvedJson)
    expect(resolved['rerunOf']).toEqual({ runId: src.runId, displayNo: failed.displayNo, from: 'fix' })
    expect(core.summary(r.runId)?.rerunOf).toEqual({
      runId: src.runId,
      displayNo: failed.displayNo,
      from: 'fix',
    })

    // The re-run's own ref reaches every carried snapshot (retention of the source never takes them).
    const gitDir = core.paths.shadowRepo(failed.folderKey)
    const s0 = failed.snapshots.S0?.commit ?? ''
    expect(
      shadowGit(gitDir, 'merge-base', '--is-ancestor', s0, `${SHADOW_REF_PREFIX}${r.runId}`).status,
    ).toBe(0)
    // The Diff tab's Implement segment is the carried S0..S1; Combined runs to the re-run's S2.
    const implement = value(await core.invoke('diff.files', { runId: r.runId, seg: 'implement' }))
    expect(implement.files.map((f) => f.path)).toEqual(['src/version.ts'])
    const combined = value(await core.invoke('diff.files', { runId: r.runId, seg: 'combined' }))
    expect(combined.files.map((f) => f.path).sort()).toEqual(['src/version.test.ts', 'src/version.ts'])
  }, 300_000)

  it('from a run paused by a quit, after a relaunch: the re-run takes the folder ahead of a run queued behind it', async () => {
    const core = await b.setup({ ...SOURCE, resume: [{ ...RESUMED_FIX, delayMs: 120_000 }, RESUMED_FIX] })
    const src = await b.start(core, { gates: { afterPlan: false } })
    const runId = src.runId
    await src.waitFor((s) => s.steps.fix.proc?.live === true && s.steps.fix.status === 'running', 120_000)
    await new Promise((r) => setTimeout(r, 500))
    await core.shutdown()

    const core2 = await b.boot()
    expect(core2.recovery.holders).toContain(runId)
    const paused = value(await core2.invoke('runs.get', { runId }))
    expect(paused.summary).toMatchObject({ status: 'paused', lock: 'held' })
    expect(paused.rerunFromFix).toMatchObject({ available: true, fresh: false })

    // Another run in the folder queues behind the paused one.
    const third = value(
      await core2.invoke('runs.start', { folder: b.folder, task: 'another task', overrides: {} }),
    )
    const tc = b.controller(core2, third.runId)
    expect(tc.state.lock).toBe('requested')
    expect(core2.summary(third.runId)?.blockedBy).toBe(runId)

    const r = value(await core2.invoke('runs.rerun', { runId, from: 'fix' }))
    const c = b.controller(core2, r.runId)
    const source = core2.controller(runId)
    expect(source?.state.status).toBe('cancelled')
    await c.waitFor((s) => s.lock === 'held', 60_000)
    // R14 "atomically": the re-run got the folder; the run queued before it still waits.
    expect(tc.state.lock).toBe('requested')
    expect(core2.summary(third.runId)?.blockedBy).toBe(r.runId)
    value(await core2.invoke('runs.stop', { runId: third.runId }))
    expect(tc.state.status).toBe('cancelled')

    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.outcome, done.notes.join(' | ')).toBe('fixed')
    const impl = done.steps.implement.sessionId ?? ''
    expect(impl).not.toBe('')
    const p = passes(b)
    // The Fix the quit stopped, then the re-run's: both continue Implement's session.
    expect(p.resumed).toHaveLength(2)
    for (const a of p.resumed) expect(a).toContain(`--resume=${impl}`)
    // The source's last snapshot was where the quit left it (`interrupted`): that is what the re-run reconciled with.
    expect(done.rerunOf?.base?.label).toBe('interrupted')
  }, 300_000)

  it('a fresh Fix (the run’s Fix row says Fresh) with one chosen finding: the prompt has it and the S0..F0 diff', async () => {
    const core = await b.setup({ ...SOURCE, fix: [{ recording: 'C03-accept-edits', write: fixWrite }] })
    const src = await b.start(core, { ...GATE_BEFORE_FIX, passes: { fix: { reuseSession: false } } })
    const atGate = await src.waitFor((s) => s.cards.some((x) => x.view.kind === 'gate:beforeFix'), 120_000)
    const gate = atGate.cards.find((x) => x.view.kind === 'gate:beforeFix')
    value(
      await core.invoke('cards.resolve', {
        runId: src.runId,
        cardId: gate?.view.id ?? '',
        choiceId: 'cancel',
      }),
    )
    await src.waitFor((s) => s.status === 'cancelled' && s.lock === 'none', 60_000)

    const snap = value(await core.invoke('runs.get', { runId: src.runId }))
    expect(snap.rerunFromFix).toMatchObject({ available: true, fresh: true, reason: 'override-fresh' })
    const list = atGate.findings?.list ?? []
    expect(list.map((f) => f.severity)).toEqual(['must', 'must', 'should'])
    const [first, , last] = list
    const r = value(
      await core.invoke('runs.rerun', { runId: src.runId, from: 'fix', findingIds: [last?.id ?? ''] }),
    )
    const c = b.controller(core, r.runId)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.outcome, done.notes.join(' | ')).toBe('fixed')
    expect(done.findings?.selected).toEqual([last?.id])
    expect(done.steps.fix).toMatchObject({ status: 'done', sessionNote: 'fresh session: set to start fresh' })
    expect(passes(b).resumed).toEqual([])

    const prompt = readFileSync(core.paths.run(r.runId).prompt('fix', 1), 'utf8')
    expect(prompt).toContain(last?.title ?? 'missing')
    expect(prompt).not.toContain(first?.title ?? 'missing')
    // A fresh Fix gets S0..F0: Implement's change, carried from the source.
    expect(prompt).toContain('src/version.ts')

    // Snapshots cleared: Fix would have nothing to start from; refused, and no run folder is made.
    const before = runDirs(b.home)
    value(await core.invoke('storage.clearShadow', { folderKey: done.folderKey }))
    const again = await core.invoke('runs.rerun', { runId: r.runId, from: 'fix' })
    expect(again.ok).toBe(false)
    if (!again.ok) {
      expect(again.error.code).toBe('CONFLICT')
      expect(again.error.message).toContain('snapshots were cleared')
    }
    expect(runDirs(b.home)).toEqual(before)
  }, 300_000)

  it('the folder changed where the run did: the reconcile card holds Fix; Include my edits tells Fix about them', async () => {
    const core = await b.setup({ ...SOURCE, resume: [RESUMED_FIX] })
    const src = await b.start(core, GATE_BEFORE_FIX)
    const atGate = await src.waitFor((s) => s.cards.some((x) => x.view.kind === 'gate:beforeFix'), 120_000)
    const gate = atGate.cards.find((x) => x.view.kind === 'gate:beforeFix')
    value(
      await core.invoke('cards.resolve', {
        runId: src.runId,
        cardId: gate?.view.id ?? '',
        choiceId: 'cancel',
      }),
    )
    await src.waitFor((s) => s.status === 'cancelled' && s.lock === 'none', 60_000)
    // The user edits the file Implement wrote, after the run ended.
    writeFileSync(join(b.folder, 'src', 'version.ts'), 'export const version = "0.2.0"\n')

    const r = value(await core.invoke('runs.rerun', { runId: src.runId, from: 'fix' }))
    const c = b.controller(core, r.runId)
    const waiting = await c.waitFor(
      (s) => s.cards.some((x) => x.view.kind === 'reconcile') || settled(s),
      120_000,
    )
    const card = waiting.cards.find((x) => x.view.kind === 'reconcile')
    expect(card?.view.choices.map((x) => x.id)).toEqual(['include-my-edits', 'restore-run-version', 'stop'])
    expect(waiting.status).toBe('waiting')
    expect(waiting.steps.fix.proc).toBeUndefined()
    value(
      await core.invoke('cards.resolve', {
        runId: r.runId,
        cardId: card?.view.id ?? '',
        choiceId: 'include-my-edits',
      }),
    )
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.outcome, done.notes.join(' | ')).toBe('fixed')
    expect(done.findings?.notes).toContain('User edited outside the run: src/version.ts')
    const prompt = readFileSync(core.paths.run(r.runId).prompt('fix', 1), 'utf8')
    expect(prompt).toContain('User edited outside the run: src/version.ts')
    // The user's edit stayed.
    expect(readFileSync(join(b.folder, 'src', 'version.ts'), 'utf8')).toBe('export const version = "0.2.0"\n')
  }, 300_000)
})
