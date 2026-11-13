// Review fixes in git/finalize.ts against real git (Apply: snapshot P first, Undo = restore(applied, P); shadow
// GC). Apply never writes or deletes a folder file
// P does not hold (a file the folder's own ignore rules leave out is added to P; one P still cannot hold is left alone);
// [Finish apply] never writes a [Take run's] over a later edit; an Undo a crash stopped part way can be asked again; an
// apply whose snapshots are gone leaves no op behind. Each case fails on the code before its fix. Honors
// DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NOT_SAVED_REASON,
  applyRun,
  clearDiscardTimers,
  discardRun,
  fileJournal,
  finishApply,
  journalFile,
  undoApply,
} from '../../../../src/core/git/finalize.ts'
import type { ApplyOptions, FinalizeTarget } from '../../../../src/core/git/finalize.ts'
import { dropWorktreeShadow, isolatedCopyRun } from '../../../../src/core/git/worktree.ts'
import { isDimFactoryError } from '../../../../src/core/errors.ts'
import { TEST_GIT, cleanupTemps, testGitVersion, tempDir, write } from '../../git/helpers.ts'
import { isolated, textOf } from './fixture.ts'

const version = await testGitVersion()
console.info(`[git-compat] finalize review suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => {
  clearDiscardTimers()
  cleanupTemps()
})

const exists = (root: string, rel: string): boolean => existsSync(join(root, rel))

class Crash extends Error {}

async function crashAt(target: FinalizeTarget, step: string, opts: ApplyOptions = {}): Promise<void> {
  await expect(
    applyRun(target, {
      ...opts,
      onStep: (s) => {
        if (s === step) throw new Crash(`crash at ${s}`)
      },
    }),
  ).rejects.toBeInstanceOf(Crash)
}

describe(`files the folder's own ignore rules leave out (finding 1, ${version.raw})`, () => {
  it("[Take run's] over a file an uncommitted .gitignore line ignores: P holds it, so Undo puts it back", async () => {
    const f = await isolated({ 'a.txt': 'a1\n', '.gitignore': 'node_modules/\n' })
    // The user's own ignore line (not committed) and their file.
    write(f.repo, '.gitignore', 'node_modules/\nlocal.json\n')
    write(f.repo, 'local.json', 'MINE precious\n')
    // The run makes local.json in its copy (not ignored there).
    write(f.wt.path, 'local.json', 'RUN version\n')
    const target = await f.finish()
    const first = await applyRun(target)
    expect(first.conflicts).toEqual(['local.json'])
    const taken = await applyRun(target, {
      paths: ['local.json'],
      resolutions: { 'local.json': 'theirs' },
    })
    expect(taken.written).toEqual(['local.json'])
    expect(textOf(f.repo, 'local.json')).toBe('RUN version\n')
    const undo = await undoApply(target, taken.undoToken)
    expect(undo.restored).toEqual(['local.json'])
    expect(textOf(f.repo, 'local.json')).toBe('MINE precious\n')
  })

  it('a run that un-ignores a file and writes it, in one apply: Undo restores both, the user file included', async () => {
    const f = await isolated({ 'a.txt': 'a1\n', '.gitignore': 'local.json\n' })
    write(f.repo, 'local.json', 'MINE precious\n')
    write(f.wt.path, '.gitignore', '# nothing ignored\n')
    write(f.wt.path, 'local.json', 'RUN version\n')
    const target = await f.finish()
    const r = await applyRun(target, { resolutions: { 'local.json': 'theirs' } })
    expect(r.written.sort()).toEqual(['.gitignore', 'local.json'])
    const undo = await undoApply(target, r.undoToken)
    expect(undo.deleted).toEqual([])
    expect(textOf(f.repo, '.gitignore')).toBe('local.json\n')
    expect(textOf(f.repo, 'local.json')).toBe('MINE precious\n')
  })

  it('a file the run adds where the folder ignores that name: Undo removes it again', async () => {
    const f = await isolated({ 'a.txt': 'a1\n' })
    write(f.repo, '.git/info/exclude', 'gen.txt\n')
    write(f.wt.path, 'gen.txt', 'generated\n')
    const target = await f.finish()
    const r = await applyRun(target)
    expect(r.written).toEqual(['gen.txt'])
    const undo = await undoApply(target, r.undoToken)
    expect(undo.deleted).toEqual(['gen.txt'])
    expect(exists(f.repo, 'gen.txt')).toBe(false)
  })

  it("a file P cannot hold (over 100 MB) is left alone with the reason, even on [Take run's]", async () => {
    const f = await isolated({ 'a.txt': 'a1\n' })
    write(f.repo, '.git/info/exclude', 'big.bin\n')
    const size = 100 * 1024 * 1024 + 1
    writeFileSync(join(f.repo, 'big.bin'), Buffer.alloc(size, 7))
    write(f.wt.path, 'big.bin', 'small\n')
    write(f.wt.path, 'a.txt', 'a2\n')
    const target = await f.finish()
    const r = await applyRun(target, { resolutions: { 'big.bin': 'theirs' } })
    expect(r.written).toEqual(['a.txt'])
    expect(r.skipped).toEqual([{ path: 'big.bin', reason: NOT_SAVED_REASON }])
    expect(statSync(join(f.repo, 'big.bin')).size).toBe(size)
  }, 180_000)
})

describe(`[Finish apply] and a [Take run's] (finding 3, ${version.raw})`, () => {
  it('a file the user edits between the crash and Finish is asked about again, never overwritten', async () => {
    const f = await isolated({ 'x.txt': 'base\n' })
    write(f.wt.path, 'x.txt', 'run\n')
    const target = await f.finish()
    write(f.repo, 'x.txt', 'user v1\n')
    await crashAt(target, 'planned', { paths: ['x.txt'], resolutions: { 'x.txt': 'theirs' } })
    write(f.repo, 'x.txt', 'user v3 (edited after the crash)\n')
    const r = await finishApply(target)
    expect(r?.resumed).toBe(true)
    expect(r?.written).toEqual([])
    expect(r?.conflicts).toEqual(['x.txt'])
    expect(textOf(f.repo, 'x.txt')).toBe('user v3 (edited after the crash)\n')
  })

  it('unchanged since the choice: Finish writes the run’s version and Undo brings the user’s back', async () => {
    const f = await isolated({ 'x.txt': 'base\n' })
    write(f.wt.path, 'x.txt', 'run\n')
    const target = await f.finish()
    write(f.repo, 'x.txt', 'user v1\n')
    await crashAt(target, 'planned', { paths: ['x.txt'], resolutions: { 'x.txt': 'theirs' } })
    const r = await finishApply(target)
    expect(r?.written).toEqual(['x.txt'])
    expect(textOf(f.repo, 'x.txt')).toBe('run\n')
    await undoApply(target, r?.undoToken ?? '')
    expect(textOf(f.repo, 'x.txt')).toBe('user v1\n')
  })
})

describe(`an Undo a crash stopped part way (finding 4, ${version.raw})`, () => {
  it('can be asked again: the files it already restored count as done', async () => {
    const f = await isolated({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' })
    write(f.wt.path, 'a.txt', 'a2\n')
    write(f.wt.path, 'b.txt', 'b2\n')
    rmSync(join(f.wt.path, 'c.txt'))
    const target = await f.finish()
    const r = await applyRun(target)
    expect(r.applied.sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])
    // The first undo restored a.txt and c.txt, then Dim Factory closed.
    write(f.repo, 'a.txt', 'a1\n')
    write(f.repo, 'c.txt', 'c1\n')
    const undo = await undoApply(target, r.undoToken)
    expect(undo.restored).toEqual(['b.txt'])
    expect(textOf(f.repo, 'a.txt')).toBe('a1\n')
    expect(textOf(f.repo, 'b.txt')).toBe('b1\n')
    expect(textOf(f.repo, 'c.txt')).toBe('c1\n')
  })

  it('still refuses a file changed to something else since the apply', async () => {
    const f = await isolated({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' })
    write(f.wt.path, 'a.txt', 'a2\n')
    write(f.wt.path, 'b.txt', 'b2\n')
    const target = await f.finish()
    const r = await applyRun(target)
    write(f.repo, 'a.txt', 'a1\n')
    write(f.repo, 'b.txt', 'mine now\n')
    const err = await undoApply(target, r.undoToken).catch((e: unknown) => e)
    expect(isDimFactoryError(err) && err.code).toBe('CONFLICT')
    expect(textOf(f.repo, 'b.txt')).toBe('mine now\n')
  })
})

describe(`a worktree shadow cleared from under a kept run (finding 5 and 18, ${version.raw})`, () => {
  it('Apply refuses before journaling anything, so Discard still works', async () => {
    const f = await isolated({ 'a.txt': 'a1\n' })
    write(f.wt.path, 'a.txt', 'a2\n')
    const target = await f.finish()
    await dropWorktreeShadow(f.home, f.wt.folderKey)
    const err = await applyRun(target).catch((e: unknown) => e)
    expect(isDimFactoryError(err) && err.code).toBe('NOT_FOUND')
    expect((await fileJournal(journalFile(target.home, target.runId)).read()).ops).toEqual([])
    expect(textOf(f.repo, 'a.txt')).toBe('a1\n')
    const d = await discardRun(target, { delayMs: 60_000 })
    expect(d.undoToken).toMatch(/^discard-/)
  })

  it('isolatedCopyRun names the run whose copy a folder is, while that copy exists', async () => {
    const f = await isolated({ 'a.txt': 'a1\n' })
    expect(await isolatedCopyRun(f.home, f.wt.path)).toBe(f.runId)
    expect(await isolatedCopyRun(f.home, join(f.wt.path, 'sub'))).toBe(f.runId)
    expect(await isolatedCopyRun(f.home, f.repo)).toBeUndefined()
    expect(await isolatedCopyRun(tempDir('other-home'), f.wt.path)).toBeUndefined()
  })
})
