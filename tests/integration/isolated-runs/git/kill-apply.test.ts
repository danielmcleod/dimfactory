// "Kill during apply -> idempotent Finish": an apply in a child process is
// killed hard part way; [Finish apply] in another process completes it once, with the same snapshot P and Undo token.
// Honors DIM_FACTORY_TEST_GIT.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRun,
  fileJournal,
  finishApply,
  interruptedOp,
  journalFile,
  undoApply,
} from '../../../../src/core/git/finalize.ts'
import type { FinalizeTarget } from '../../../../src/core/git/finalize.ts'
import { TEST_GIT, cleanupTemps, testGitVersion, write } from '../../git/helpers.ts'
import { isolated, textOf } from './fixture.ts'

const version = await testGitVersion()
console.info(`[git-compat] kill-during-apply suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => cleanupTemps())

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'apply-child.mjs')

/** Run the apply in a child process, kill it hard once it reports reaching `step`. */
async function applyAndKill(target: FinalizeTarget, step: string): Promise<void> {
  const child = spawn(process.execPath, [CHILD, JSON.stringify(target), step], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, DIM_FACTORY_TEST_GIT: TEST_GIT },
  })
  let out = ''
  let err = ''
  child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
  const exited = new Promise<void>((res) => child.on('exit', () => res()))
  await new Promise<void>((res, rej) => {
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
      if (out.includes(`STOPPED ${step}`)) res()
    })
    child.on('exit', (code) =>
      rej(new Error(`the apply child exited (${code}) before ${step}: ${out} ${err}`)),
    )
  })
  child.kill('SIGKILL')
  await exited
}

describe(`kill during apply (${version.raw})`, () => {
  for (const step of ['snapshot', 'planned', 'deleted'] as const) {
    it(`killed after "${step}": Finish completes the apply once, with its snapshot and token`, async () => {
      const f = await isolated({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' })
      write(f.wt.path, 'a.txt', 'a2\n')
      rmSync(join(f.wt.path, 'b.txt'))
      write(f.wt.path, 'n.txt', 'n\n')
      const target = await f.finish()
      await applyAndKill(target, step)

      const open = interruptedOp(await fileJournal(journalFile(target.home, target.runId)).read())
      expect(open?.preApply?.commit).toBeDefined()
      const r = await finishApply(target)
      expect(r?.resumed).toBe(true)
      expect(r?.undoToken).toBe(open?.token)
      expect(r?.preApply).toBe(open?.preApply?.commit)
      expect(r?.applied.sort()).toEqual(['a.txt', 'b.txt', 'n.txt'])
      expect(textOf(f.repo, 'a.txt')).toBe('a2\n')
      expect(existsSync(join(f.repo, 'b.txt'))).toBe(false)
      expect(textOf(f.repo, 'n.txt')).toBe('n\n')
      expect(textOf(f.repo, 'c.txt')).toBe('c1\n')
      // Idempotent: nothing left to finish, and a new apply changes nothing.
      expect(await finishApply(target)).toBeNull()
      expect((await applyRun(target)).applied).toEqual([])
      // Undo goes back to the folder from before the killed apply.
      await undoApply(target, r?.undoToken ?? '')
      expect(textOf(f.repo, 'a.txt')).toBe('a1\n')
      expect(textOf(f.repo, 'b.txt')).toBe('b1\n')
      expect(existsSync(join(f.repo, 'n.txt'))).toBe(false)
    })
  }

  // Review finding 7: killed between a file's temp write and its rename, the temp file is left in the folder.
  it('killed with a file in its temp file: Finish removes the temp file and completes the apply', async () => {
    const f = await isolated({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' })
    write(f.wt.path, 'a.txt', 'a2\n')
    rmSync(join(f.wt.path, 'b.txt'))
    write(f.wt.path, 'n.txt', 'n\n')
    const target = await f.finish()
    await applyAndKill(target, 'temp')
    const temps = (): string[] => readdirSync(f.repo).filter((n) => /\.\d+\.[0-9a-f]{8}\.tmp$/.test(n))
    expect(temps()).toHaveLength(1)
    const r = await finishApply(target)
    expect(r?.resumed).toBe(true)
    expect(r?.applied.sort()).toEqual(['a.txt', 'b.txt', 'n.txt'])
    expect(temps()).toEqual([])
    expect(textOf(f.repo, 'a.txt')).toBe('a2\n')
    expect(textOf(f.repo, 'n.txt')).toBe('n\n')
    // Undo goes back to the folder from before, with no temp file in it either.
    await undoApply(target, r?.undoToken ?? '')
    expect(temps()).toEqual([])
    expect(textOf(f.repo, 'a.txt')).toBe('a1\n')
    expect(textOf(f.repo, 'b.txt')).toBe('b1\n')
    expect(existsSync(join(f.repo, 'n.txt'))).toBe(false)
  })
})
