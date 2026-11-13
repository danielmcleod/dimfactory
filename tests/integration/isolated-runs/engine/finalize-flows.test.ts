// Finalize and prepare flows through a real core (an isolated run's Prepare, Finalize, Apply, Cleanup; verify:0;
// state-machine rows R2/R5/R12/R13, "Crash relaunch"): the fake Claude, a temp git repository,
// the real worktree, install, baseline and finalize modules.
//   - Plan ∥ deps: Plan finishes while the install still runs; Implement (R5) waits for prepare
//   - Keep for later → "Isolated: not applied"; then Discard: deferred 10 s, then the worktree and its branch are gone
//   - autoApply ∧ Auto ∧ no conflicts: applied without the card
//   - a file changed in the folder too: finalizeConflicts → [Take run's]
//   - Stop during the install kills its process tree; the worktree is kept, never deleted
//   - verify:0 baseline: a check already failing before the run is a [should], never verify-failed
//   - Dim Factory closing while the apply writes → relaunch → interruptedApply → [Finish apply]
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { matchFullMode } from '../../attention/helpers.ts'
import { git } from '../../run/scenario.ts'
import { ISO_API } from '../../../../src/core/supervisor/isolation.ts'
import type { IsolationApi } from '../../../../src/core/supervisor/isolation.ts'
import { controllableClock } from '../../../../src/core/supervisor/effects.ts'
import type { FindingsFile } from '../../../../src/shared/findings.ts'
import {
  CHECK,
  IsolatedWorld,
  LINT,
  hasCard,
  isoOverrides,
  openCard,
  settled,
  value,
  version,
} from './helpers.ts'

const world = new IsolatedWorld()
afterEach(async () => world.dispose())

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 100))
  }
}

const IMPLEMENT = { recording: 'C08a-session-id-implement', write: version('1.0.0') }

describe('prepare order and Stop', () => {
  it('Plan finishes while the install runs; Implement waits for prepare', async () => {
    const w = await world.setup(
      { plan: { recording: 'C06-plan-native-host' }, implement: [IMPLEMENT] },
      { committed: { 'sleep.txt': '6000' } },
    )
    const t = await world.start(w, isoOverrides())
    await world.choose(t, 'depsConsent', 'install')
    await t.c.waitFor(hasCard('finalize'), 180_000)
    const seq = (pred: (b: (typeof t.events)[number]['body']) => boolean): number =>
      t.events.find((e) => e.runId === t.runId && pred(e.body))?.seq ?? -1
    const planDone = seq((b) => b.t === 'step-status' && b.step === 'plan' && b.status === 'done')
    const prepDone = seq((b) => b.t === 'step-status' && b.step === 'prepare' && b.status === 'done')
    const implStart = seq((b) => b.t === 'step-status' && b.step === 'implement' && b.status === 'running')
    expect(planDone).toBeGreaterThan(0)
    expect(planDone).toBeLessThan(prepDone)
    expect(prepDone).toBeLessThan(implStart)
  }, 300_000)

  it('Stop during the install kills its process tree; the run is cancelled and its worktree kept', async () => {
    const w = await world.setup(
      { plan: { recording: 'C06-plan-native-host' }, implement: [IMPLEMENT] },
      { committed: { 'sleep.txt': '120000' } },
    )
    const t = await world.start(w, isoOverrides())
    await world.choose(t, 'depsConsent', 'install')
    const wt = join(t.home, 'worktrees', t.runId)
    const pidFile = join(wt, '.deps', 'pid.txt')
    await until(() => existsSync(pidFile))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(pid)).toBe(true)
    value(await t.core.invoke('runs.stop', { runId: t.runId }))
    const done = await t.c.waitFor(settled, 60_000)
    await t.c.settle(15_000)
    expect(done.status).toBe('cancelled')
    await until(() => !alive(pid), 30_000)
    // Never deleted on its own: the worktree stays, and the Dashboard says it is not applied.
    expect(existsSync(wt)).toBe(true)
    const snap = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(snap.summary.worktree).toEqual({ state: 'kept', notApplied: true })
    expect(snap.steps.prepare.status).toBe('cancelled')
  }, 300_000)
})

describe('finalize', () => {
  it('Keep for later, then Discard: deferred 10 s; then the worktree, its branch and its shadow are gone', async () => {
    const clock = controllableClock()
    const w = await world.setup({ plan: { recording: 'C06-plan-native-host' }, implement: [IMPLEMENT] })
    const t = await world.start(w, isoOverrides({ install: 'never' }), { clock })
    await world.choose(t, 'finalize', 'keep')
    const kept = await t.c.waitFor(settled, 60_000)
    expect(kept).toMatchObject({ status: 'completed', outcome: 'clean' })
    const branch = kept.isolation?.worktree?.branch ?? ''
    const wt = kept.isolation?.worktree?.path ?? ''
    expect(existsSync(wt)).toBe(true)
    expect(git(t.folder, 'branch', '--list', branch)).toContain(branch)
    expect(value(await t.core.invoke('runs.get', { runId: t.runId })).summary.worktree).toEqual({
      state: 'kept',
      notApplied: true,
    })
    // Discard: answered at once with its undo token; nothing is deleted before its 10 s.
    const d = value(await t.core.invoke('worktree.discard', { runId: t.runId }))
    expect(d.deleteAt).toBeGreaterThan(clock.now() + 9_000)
    expect(d.deleteAt).toBeLessThanOrEqual(clock.now() + 10_000)
    clock.advance(5_000)
    await t.c.settle(5_000)
    expect(existsSync(wt)).toBe(true)
    clock.advance(6_000)
    await t.c.waitFor((s) => s.isolation?.finalize?.state === 'discarded', 60_000)
    await t.c.settle(15_000)
    expect(existsSync(wt)).toBe(false)
    expect(git(t.folder, 'branch', '--list', branch).trim()).toBe('')
    const snap = value(await t.core.invoke('runs.get', { runId: t.runId }))
    // The run completed (kept), so its step stays as it completed; the discard is in finalize's view.
    expect(snap.steps.finalize).toMatchObject({ status: 'skipped', reason: 'kept' })
    expect(snap.steps.finalize.finalize).toMatchObject({ state: 'discarded' })
    expect(snap.summary).toMatchObject({ status: 'completed' })
    expect(snap.summary.worktree).toEqual({ state: 'discarded', notApplied: false })
  }, 300_000)

  it('autoApply ∧ Auto ∧ no conflicts: applied without the card', async () => {
    const w = await world.setup({ plan: { recording: 'C06-plan-native-host' }, implement: [IMPLEMENT] })
    // Auto runs Implement in full mode.
    matchFullMode(w.sc)
    const t = await world.start(w, isoOverrides({ auto: true, autoApply: true, install: 'never' }))
    const done = await t.c.waitFor(settled, 180_000)
    await t.c.settle(15_000)
    expect(done).toMatchObject({ status: 'completed', outcome: 'clean' })
    expect(t.events.some((e) => e.body.t === 'card' && e.body.card.kind === 'finalize')).toBe(false)
    expect(readFileSync(join(t.folder, 'src', 'version.ts'), 'utf8')).toContain('1.0.0')
    expect(done.notes).toContain('Auto applied the run to your folder (autoApply, and no file conflicts).')
  }, 300_000)

  it("a file changed in the folder too: finalizeConflicts; [Take run's] writes the run's version", async () => {
    const w = await world.setup(
      { plan: { recording: 'C06-plan-native-host' }, implement: [IMPLEMENT] },
      { extra: { 'src/version.ts': 'export const version = "mine"\n' } },
    )
    const t = await world.start(w, isoOverrides({ install: 'never' }))
    const fin = await t.c.waitFor(hasCard('finalize'), 180_000)
    // By design: the worktree starts from HEAD; the uncommitted file is not in it.
    expect(fin.notes).toContain(
      '1 uncommitted change not included: the isolated run starts from the last commit.',
    )
    expect(openCard(fin, 'finalize')?.payload).toMatchObject({ conflicts: [{ path: 'src/version.ts' }] })
    await world.choose(t, 'finalize', 'apply')
    const conflicts = await t.c.waitFor(hasCard('finalizeConflicts'), 60_000)
    expect(conflicts.status).toBe('waiting')
    // Never overwritten without [Take run's].
    expect(readFileSync(join(t.folder, 'src', 'version.ts'), 'utf8')).toContain('mine')
    await world.choose(t, 'finalizeConflicts', 'take-theirs', ['src/version.ts'])
    const done = await t.c.waitFor(settled, 60_000)
    await t.c.settle(15_000)
    expect(done.status).toBe('completed')
    expect(readFileSync(join(t.folder, 'src', 'version.ts'), 'utf8')).toContain('1.0.0')
  }, 300_000)

  it('verify:0: a check failing before the run is a [should] and never makes the run fail', async () => {
    const w = await world.setup({ plan: { recording: 'C06-plan-native-host' }, implement: [IMPLEMENT] })
    await world.trustVerify(w, ['node', 'lint.mjs'])
    await world.trustVerify(w, ['node', 'check.mjs'])
    const t = await world.start(
      w,
      isoOverrides({ commands: [CHECK, LINT], baseline: true, install: 'never' }),
    )
    const fin = await t.c.waitFor(hasCard('finalize'), 180_000)
    expect(fin.isolation?.baseline).toEqual({ check: 'fail', lint: 'fail' })
    const baseline: unknown = JSON.parse(
      readFileSync(join(t.home, 'runs', t.runId, 'verify', 'baseline.json'), 'utf8'),
    )
    expect(baseline).toEqual({ check: 'fail', lint: 'fail' })
    // verify:1: check now passes, lint still fails (pre-existing): a [should], so the run is clean.
    expect(fin.steps['verify:1'].verify?.commands.map((c) => [c.name, c.status])).toEqual([
      ['check', 'pass'],
      ['lint', 'fail'],
    ])
    expect(fin.outcome).toBe('clean')
    const ff = JSON.parse(
      readFileSync(join(t.home, 'runs', t.runId, 'findings.json'), 'utf8'),
    ) as FindingsFile
    expect(ff.findings).toEqual([
      expect.objectContaining({ severity: 'should', source: 'verify', flags: ['preexisting'] }),
    ])
  }, 300_000)
})

describe('crash relaunch while applying', () => {
  it('Dim Factory closes while the apply writes → relaunch → interruptedApply → [Finish apply] completes it', async () => {
    const w = await world.setup({ plan: { recording: 'C06-plan-native-host' }, implement: [IMPLEMENT] })
    // The apply stops after its plan is journaled (as a crash would), until the test lets it go.
    let release: (err: Error) => void = () => undefined
    const gate = new Promise<never>((_, reject) => (release = reject))
    gate.catch(() => undefined)
    let reached = false
    const crashing: IsolationApi = {
      ...ISO_API,
      applyRun: (target, opts) =>
        ISO_API.applyRun(target, {
          ...opts,
          onStep: async (step) => {
            if (step !== 'planned') return
            reached = true
            await gate
          },
        }),
    }
    const t = await world.start(w, isoOverrides({ install: 'never' }), { isolation: crashing })
    await world.choose(t, 'finalize', 'apply')
    await until(() => reached, 60_000)
    expect(t.c.state.isolation?.finalize?.state).toBe('applying')
    // Dim Factory goes away mid-apply: run.json says `applying`; the apply's own answer never reaches the run.
    await t.c.close()
    release(new Error('Dim Factory closed'))
    await world.stop(t.core)
    expect(existsSync(join(t.folder, 'src', 'version.ts'))).toBe(false)

    // Relaunch: recovery finds the apply in flight; interruptedApply, never resumed on its own.
    const { core } = await world.boot(w)
    const c = core.controller(t.runId)
    expect(c).toBeDefined()
    const s = await c!.waitFor(hasCard('interruptedApply'), 60_000)
    expect(s.isolation?.finalize?.state).toBe('interrupted')
    expect(existsSync(join(t.folder, 'src', 'version.ts'))).toBe(false)
    const card = openCard(s, 'interruptedApply')
    value(
      await core.invoke('cards.resolve', {
        runId: t.runId,
        cardId: card?.id ?? '',
        choiceId: 'finish-apply',
      }),
    )
    const done = await c!.waitFor(settled, 60_000)
    await c!.settle(15_000)
    expect(done).toMatchObject({ status: 'completed' })
    expect(done.steps.finalize).toMatchObject({ status: 'done', reason: 'applied' })
    expect(readFileSync(join(t.folder, 'src', 'version.ts'), 'utf8')).toContain('1.0.0')
    // Finish carried the journaled apply on (its own token), so its Undo works.
    const view = value(await core.invoke('runs.get', { runId: t.runId })).steps.finalize.finalize
    value(await core.invoke('worktree.undoApply', { runId: t.runId, undoToken: view?.undoToken ?? '' }))
    expect(existsSync(join(t.folder, 'src', 'version.ts'))).toBe(false)
  }, 300_000)
})
