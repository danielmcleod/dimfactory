// Apply's journal, Undo and Discard against real git ("kill during apply -> idempotent Finish"): a crash at each
// step, then Finish; Undo to P and its refusal; Discard deferred 10 s
// and undoable, then the worktree, its branch and its shadow removed. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRun,
  clearDiscardTimers,
  completeDiscard,
  discardRun,
  fileJournal,
  finishApply,
  interruptedOp,
  journalFile,
  resumeDiscard,
  summarizeJournal,
  undoApply,
  undoDiscard,
} from '../../../../src/core/git/finalize.ts'
import type { ApplyStep, DiscardTimers, FinalizeTarget } from '../../../../src/core/git/finalize.ts'
import { homePaths } from '../../../../src/core/home.ts'
import { isDimFactoryError } from '../../../../src/core/errors.ts'
import { TEST_GIT, cleanupTemps, git, testGitVersion, write } from '../../git/helpers.ts'
import { isolated, textOf } from './fixture.ts'
import type { Isolated } from './fixture.ts'

const version = await testGitVersion()
console.info(`[git-compat] apply journal suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => {
  clearDiscardTimers()
  cleanupTemps()
})

const exists = (root: string, rel: string): boolean => existsSync(join(root, rel))

/** A run that writes a.txt, deletes b.txt, adds n.txt; the user's c.txt is untouched by it. */
async function standard(): Promise<{ f: Isolated; target: FinalizeTarget }> {
  const f = await isolated({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' })
  write(f.wt.path, 'a.txt', 'a2\n')
  rmSync(join(f.wt.path, 'b.txt'))
  write(f.wt.path, 'n.txt', 'n\n')
  return { f, target: await f.finish() }
}

const expectApplied = (repo: string): void => {
  expect(textOf(repo, 'a.txt')).toBe('a2\n')
  expect(exists(repo, 'b.txt')).toBe(false)
  expect(textOf(repo, 'n.txt')).toBe('n\n')
  expect(textOf(repo, 'c.txt')).toBe('c1\n')
}

const expectOriginal = (repo: string): void => {
  expect(textOf(repo, 'a.txt')).toBe('a1\n')
  expect(textOf(repo, 'b.txt')).toBe('b1\n')
  expect(exists(repo, 'n.txt')).toBe(false)
  expect(textOf(repo, 'c.txt')).toBe('c1\n')
}

class Crash extends Error {}

async function crashAt(target: FinalizeTarget, step: ApplyStep): Promise<void> {
  await expect(
    applyRun(target, {
      onStep: (s) => {
        if (s === step) throw new Crash(`crash at ${s}`)
      },
    }),
  ).rejects.toBeInstanceOf(Crash)
}

describe(`[Finish apply] after a crash at each step (${version.raw})`, () => {
  for (const step of ['started', 'snapshot', 'planned', 'deleted', 'written'] as const) {
    it(`a crash after "${step}" leaves an interrupted apply that Finish completes once, idempotently`, async () => {
      const { f, target } = await standard()
      await crashAt(target, step)
      const io = fileJournal(journalFile(target.home, target.runId))
      const j = await io.read()
      const open = interruptedOp(j)
      expect(open).toBeDefined()
      expect(summarizeJournal(j).state).toBe('interrupted')
      const p = open?.preApply?.commit
      // A new Apply, Undo or Discard cannot jump the interrupted one.
      await expect(discardRun(target)).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(undoApply(target, open?.token ?? '')).rejects.toMatchObject({ code: 'CONFLICT' })

      const r = await finishApply(target)
      expect(r).not.toBeNull()
      expect(r?.resumed).toBe(true)
      expect(r?.undoToken).toBe(open?.token)
      // The snapshot taken before the crash is the one kept (taken now only when the crash came before it).
      if (p !== undefined) expect(r?.preApply).toBe(p)
      expect(r?.applied.sort()).toEqual(['a.txt', 'b.txt', 'n.txt'])
      expect(r?.conflicts).toEqual([])
      expectApplied(f.repo)
      // Nothing left to finish; applying again changes nothing.
      expect(await finishApply(target)).toBeNull()
      const again = await applyRun(target)
      expect(again.applied).toEqual([])
      expect(again.unchanged.sort()).toEqual(['a.txt', 'b.txt', 'n.txt'])
      expectApplied(f.repo)
      // Undo of the finished apply restores the folder from before it.
      await undoApply(target, r?.undoToken ?? '')
      expectOriginal(f.repo)
    })
  }

  it('a crash part way through the writes: Finish counts the files already written as applied', async () => {
    const { f, target } = await standard()
    await crashAt(target, 'deleted')
    // The crash came after a.txt was written.
    write(f.repo, 'a.txt', 'a2\n')
    const r = await applyRun(target)
    expect(r.resumed).toBe(true)
    expect(r.written.sort()).toEqual(['a.txt', 'n.txt'])
    expect(r.deleted).toEqual(['b.txt'])
    expectApplied(f.repo)
    await undoApply(target, r.undoToken)
    expectOriginal(f.repo)
  })

  it('a file the user changed between the crash and Finish becomes a conflict, never overwritten', async () => {
    const { f, target } = await standard()
    await crashAt(target, 'planned')
    write(f.repo, 'a.txt', 'a-user\n')
    const r = await finishApply(target)
    expect(r?.conflicts).toEqual(['a.txt'])
    expect(textOf(f.repo, 'a.txt')).toBe('a-user\n')
    expect(textOf(f.repo, 'n.txt')).toBe('n\n')
  })
})

describe(`Undo (${version.raw})`, () => {
  it('restores the applied files to the pre-apply snapshot, only once', async () => {
    const { f, target } = await standard()
    // The user's own edit before the apply is part of P and stays.
    write(f.repo, 'c.txt', 'c-user\n')
    const r = await applyRun(target)
    expect(textOf(f.repo, 'a.txt')).toBe('a2\n')
    expect(textOf(f.repo, 'n.txt')).toBe('n\n')
    const u = await undoApply(target, r.undoToken)
    expect(u.restored.sort()).toEqual(['a.txt', 'b.txt'])
    expect(u.deleted).toEqual(['n.txt'])
    expect(textOf(f.repo, 'a.txt')).toBe('a1\n')
    expect(textOf(f.repo, 'b.txt')).toBe('b1\n')
    expect(exists(f.repo, 'n.txt')).toBe(false)
    expect(textOf(f.repo, 'c.txt')).toBe('c-user\n')
    await expect(undoApply(target, r.undoToken)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(undoApply(target, 'apply-nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // Re-apply after the undo works (the worktree is kept until it is discarded).
    const again = await applyRun(target)
    expect(again.applied.sort()).toEqual(['a.txt', 'b.txt', 'n.txt'])
  })

  it('refuses (nothing written) when an applied file changed since the apply, naming it', async () => {
    const { f, target } = await standard()
    const r = await applyRun(target)
    write(f.repo, 'n.txt', 'n-user\n')
    let caught: unknown
    try {
      await undoApply(target, r.undoToken)
    } catch (err) {
      caught = err
    }
    expect(isDimFactoryError(caught)).toBe(true)
    expect(caught).toMatchObject({ code: 'CONFLICT', details: { paths: ['n.txt'] } })
    // Nothing was undone.
    expect(textOf(f.repo, 'a.txt')).toBe('a2\n')
    expect(exists(f.repo, 'b.txt')).toBe(false)
    expect(textOf(f.repo, 'n.txt')).toBe('n-user\n')
    // A deleted file that came back counts too.
    write(f.repo, 'n.txt', 'n\n')
    write(f.repo, 'b.txt', 'b-user\n')
    await expect(undoApply(target, r.undoToken)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { paths: ['b.txt'] },
    })
  })
})

/** Timers a test fires by hand. */
function manualTimers(): DiscardTimers & { fire(): void; pending(): number } {
  const queue = new Map<number, () => void>()
  let n = 0
  return {
    set: (fn) => {
      n++
      queue.set(n, fn)
      return n
    },
    clear: (h) => {
      queue.delete(h as number)
    },
    fire: () => {
      const fns = [...queue.values()]
      queue.clear()
      for (const fn of fns) fn()
    },
    pending: () => queue.size,
  }
}

describe(`Discard (${version.raw})`, () => {
  it('is deferred 10 s and undoable; then removes the worktree, its branch and its shadow, never the folder', async () => {
    const { f, target } = await standard()
    const timers = manualTimers()
    let now = 1_000_000
    const t = { ...target, now: () => now }
    const d = await discardRun(t, { timers })
    expect(d.deleteAt).toBe(now + 10_000)
    expect(timers.pending()).toBe(1)
    expect(summarizeJournal(await fileJournal(journalFile(t.home, t.runId)).read()).state).toBe(
      'discard-pending',
    )
    // Apply is refused while the discard is pending.
    await expect(applyRun(t)).rejects.toMatchObject({ code: 'CONFLICT' })
    await undoDiscard(t, d.undoToken)
    expect(timers.pending()).toBe(0)
    expect(existsSync(f.wt.path)).toBe(true)

    now += 60_000
    const settled = new Promise<unknown>((res) => {
      void discardRun(t, { timers, onSettled: (r, err) => res(err ?? r) })
    })
    // A second Discard while pending answers the same token.
    const d2 = await discardRun(t, { timers })
    timers.fire()
    const removal = (await settled) as { removed: boolean; branchDeleted: boolean; shadowDropped: boolean }
    expect(removal).toMatchObject({ removed: true, branchDeleted: true, shadowDropped: true })
    expect(existsSync(f.wt.path)).toBe(false)
    expect(git(f.repo, ['branch', '--list', f.wt.branch]).trim()).toBe('')
    expect(existsSync(join(homePaths(f.home).shadowDir, f.wt.folderKey))).toBe(false)
    // The folder is as it was.
    expectOriginal(f.repo)
    await expect(undoDiscard(t, d2.undoToken)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(applyRun(t)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(summarizeJournal(await fileJournal(journalFile(t.home, t.runId)).read()).state).toBe('discarded')
  })

  it('a relaunch past the deletion time completes it; before it, arms it again for the time left', async () => {
    const { f, target } = await standard()
    const timers = manualTimers()
    let now = 5_000_000
    const t = { ...target, now: () => now }
    await discardRun(t, { timers })
    clearDiscardTimers()
    // Relaunch 3 s later: armed again.
    now += 3_000
    const timers2 = manualTimers()
    expect(await resumeDiscard(t, { timers: timers2 })).toBe('armed')
    expect(timers2.pending()).toBe(1)
    clearDiscardTimers()
    // Relaunch after the time: carried out at once.
    now += 30_000
    expect(await resumeDiscard(t)).toBe('removed')
    expect(existsSync(f.wt.path)).toBe(false)
    expect(await completeDiscard(t)).toBeNull()
  })
})
