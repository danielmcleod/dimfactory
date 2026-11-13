// Isolated runs through a real core (state-machine rows R2/R5/R12; isolated.spec.ts):
// the fake Claude for the passes, a temp git repository, the real worktree, a node-script install and node-script
// verify commands.
//   - R2: prepare steps 1 and 2 first; Plan runs in the worktree while the install runs (Plan ∥ deps)
//   - depsConsent [Install] writes the deps grant (SOURCE folder) and installs, its output streamed (runs.output)
//   - Implement, Review, Critic and Fix run with cwd = the worktree; the folder is untouched until Apply
//   - failing verify → [must] → Fix → verify passes → finalize card → Apply to folder → Undo restores (isolated.spec.ts)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTrustFile } from '../../../../src/core/config/trust.ts'
import { samePath } from '../../../../src/core/real-path.ts'
import type { FakeLogEntry } from '../../../fake-cli/harness.ts'
import { CHECK, IsolatedWorld, hasCard, isoOverrides, settled, value, version } from './helpers.ts'

const world = new IsolatedWorld()
afterEach(async () => world.dispose())

const starts = (entries: FakeLogEntry[]): { cwd: string; argv: string[] }[] =>
  entries
    .filter((e) => e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes('-p'))
    .map((e) => ({ cwd: String(e['cwd']), argv: e['argv'] as string[] }))
    // The launch probe's handshake runs in the home's probe folder, not in a run.
    .filter((r) => !/probe-cwd[\\/]?$/.test(r.cwd))

/** The same folder however spelled: the fake's getcwd() is the real path (macOS /private/var for /var). */
const same = (a: string, b: string): boolean => b !== '' && samePath(a, b)

describe('isolated run (core + fake Claude + real worktree, install and verify)', () => {
  it('deps consent → failing verify → [must] → Fix → verify passes → Apply to folder → Undo restores', async () => {
    const w = await world.setup({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
      resume: [{ recording: 'C08b-resume-fix', write: version('1.0.0'), text: 'F1 fixed' }],
    })
    await world.trustVerify(w, ['node', 'check.mjs'])
    const t = await world.start(w, isoOverrides({ commands: [CHECK] }))

    // Step 3: no deps grant yet → depsConsent (install: ask). Plan already runs in the worktree meanwhile.
    const consent = await t.c.waitFor(hasCard('depsConsent'), 120_000)
    const wt = consent.isolation?.worktree
    expect(wt?.path).toBe(join(t.home, 'worktrees', t.runId))
    expect(existsSync(join(wt?.path ?? '', 'check.mjs'))).toBe(true)
    expect(consent.steps.prepare.status).toBe('waiting')
    await world.choose(t, 'depsConsent', 'install')

    const fin = await t.c.waitFor(hasCard('finalize'), 180_000)
    expect(fin.outcome).toBe('fixed')
    expect(fin.status).toBe('waiting')
    expect(fin.phase).toBe('ready-to-apply')
    // The folder is untouched until Apply; the worktree has the run's result and the installed dependencies.
    expect(existsSync(join(t.folder, 'src', 'version.ts'))).toBe(false)
    expect(readFileSync(join(wt?.path ?? '', 'src', 'version.ts'), 'utf8')).toContain('1.0.0')
    expect(existsSync(join(wt?.path ?? '', '.deps', 'installed.txt'))).toBe(true)
    expect(existsSync(join(t.folder, '.deps'))).toBe(false)
    // Every pass ran with cwd = the worktree (Plan included: it started after step 1).
    const runs = starts(t.sc.entries())
    expect(runs.length).toBeGreaterThanOrEqual(4)
    for (const r of runs) expect(same(r.cwd, wt?.path ?? ''), `${r.argv.join(' ')} in ${r.cwd}`).toBe(true)
    // The deps grant was written for the SOURCE folder (a worktree has another folder key).
    const trust = await readTrustFile({ home: t.home })
    const grants = Object.values(trust.file.folders).flatMap((f) => Object.values(f.grants.commands ?? {}))
    expect(grants.some((g) => g.kind === 'deps' && g.argv.join(' ') === 'node install.mjs')).toBe(true)
    // The install's output reached the PrepareCard (runs.output `prepare`).
    const out = value(await t.core.invoke('runs.output', { runId: t.runId, file: 'prepare' }))
    expect(out.text).toContain('installed 3 packages')
    const snap0 = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(snap0.steps.prepare.prepare?.steps.map((r) => [r.id, r.status])).toEqual([
      ['worktree', 'done'],
      ['copy', 'skipped'],
      ['deps', 'done'],
      ['baseline', 'skipped'],
      ['ready', 'done'],
    ])
    expect(snap0.summary.worktree).toEqual({ state: 'pending', notApplied: true })

    // [Apply to folder]: the run's file is written into the folder; the run completes `fixed`.
    await world.choose(t, 'finalize', 'apply')
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done).toMatchObject({ status: 'completed', outcome: 'fixed' })
    expect(readFileSync(join(t.folder, 'src', 'version.ts'), 'utf8')).toContain('1.0.0')
    const snap = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(snap.steps.finalize).toMatchObject({ status: 'done', reason: 'applied' })
    const view = snap.steps.finalize.finalize
    expect(view).toMatchObject({ state: 'applied', applied: 1 })
    expect(snap.summary.worktree).toEqual({ state: 'applied', notApplied: false })
    // The folder's lock was leased for the apply and given back; the run's own (worktree) lock released.
    expect(t.core.scheduler.holders()).toEqual([])

    // Undo: the applied file goes back to the pre-apply snapshot (it did not exist).
    value(await t.core.invoke('worktree.undoApply', { runId: t.runId, undoToken: view?.undoToken ?? '' }))
    expect(existsSync(join(t.folder, 'src', 'version.ts'))).toBe(false)
    const after = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(after.summary.worktree).toEqual({ state: 'kept', notApplied: true })
  }, 300_000)
})
