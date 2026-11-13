// Shadow regressions found in review, against real git (honors DIM_FACTORY_TEST_GIT):
//   - no user hook ever runs (core.hooksPath → <home>/empty-hooks; existing shadows are reconfigured)
//   - the size preflight never strips info/exclude; read-only cores measure without writing anything
//   - a shadow git call killed by its own timeout leaves no lock behind
//   - nested repositories: their working state is fingerprinted (it is not in the tree)
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureGit, runGit } from '../../../src/core/git/exec.ts'
import { resolveScope } from '../../../src/core/git/repo.ts'
import {
  Shadow,
  gitConfigPath,
  nestedReposKey,
  openShadow,
  sizePreflightReadOnly,
} from '../../../src/core/git/shadow.ts'
import {
  TEST_GIT,
  cleanupTemps,
  git,
  gitBuf,
  initRepo,
  listTree,
  mtimeMs,
  shadowGit,
  shadowTreePaths,
  tempDir,
  testGitVersion,
  write,
} from './helpers.ts'

const version = await testGitVersion()
const RUN = '20261005T120000Z-abcd'

afterEach(() => {
  configureGit({ executable: TEST_GIT, baseEnv: undefined })
  cleanupTemps()
})

/** Can this git run shell hooks and aliases (MinGit has no sh)? */
function gitHasShell(): boolean {
  try {
    gitBuf(tempDir('sh-probe'), ['-c', 'alias.probe=!true', 'probe'])
    return true
  } catch {
    return false
  }
}

const atLeast = (minor: number): boolean =>
  version.major > 2 || (version.major === 2 && version.minor >= minor)

/** `git config --local --get` in a shadow ('' when unset). */
function shadowConfigValue(gitDir: string, key: string): string {
  try {
    return shadowGit(gitDir, ['config', '--local', '--get', key]).trim()
  } catch {
    return ''
  }
}

describe(`shadow review fixes (${version.raw})`, () => {
  const sh = gitHasShell()

  it('never runs the user’s hooks: a global core.hooksPath is overridden by the shadow’s empty one', async () => {
    const dir = tempDir('hooks')
    initRepo(dir)
    write(dir, 'a.txt', 'a\n')
    const hooks = tempDir('user-hooks')
    const marker = join(hooks, 'ran.log')
    for (const name of ['post-index-change', 'reference-transaction', 'pre-commit', 'post-commit']) {
      chmodSync(write(hooks, name, `#!/bin/sh\necho ${name} >> "${gitConfigPath(marker)}"\n`), 0o755)
    }
    const fakeHome = tempDir('home')
    write(fakeHome, '.gitconfig', `[core]\n\thooksPath = ${gitConfigPath(hooks)}\n`)
    configureGit({ baseEnv: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome } })
    if (sh && atLeast(24)) {
      // The fake global hooks are live: an index write in the user's repo (through Dim Factory's own git env) fires
      // post-index-change. (A refresh alone may not write the index, so it would prove nothing.)
      await runGit(['add', 'a.txt'], { cwd: dir })
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)
    }
    const dimFactoryHome = tempDir('chome')
    const shadow = await Shadow.open(await resolveScope(dir), { home: dimFactoryHome })
    const empty = join(dimFactoryHome, 'empty-hooks')
    expect(shadowConfigValue(shadow.gitDir, 'core.hooksPath')).toBe(gitConfigPath(empty))
    expect(readdirSync(empty)).toEqual([])
    await shadow.snapshot(RUN, 'S0')
    write(dir, 'b.txt', 'b\n')
    await shadow.snapshot(RUN, 'S1')
    await shadow.liveChanged({ skipIfBusy: false })
    expect(existsSync(marker)).toBe(false)
  })

  it('an existing shadow without core.hooksPath is reconfigured on open', async () => {
    const dir = tempDir('hooks-upgrade')
    write(dir, 'a.txt', 'a\n')
    const dimFactoryHome = tempDir('chome-up')
    const first = await openShadow(dir, { home: dimFactoryHome })
    // As written by the previous configuration version.
    const metaFile = join(first.root, 'meta.json')
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>
    delete meta['hooksPath']
    writeFileSync(metaFile, JSON.stringify({ ...meta, configVersion: 1 }))
    const cfg = join(first.gitDir, 'config')
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/\n\thooksPath = [^\n]*/, ''))
    expect(shadowConfigValue(first.gitDir, 'core.hooksPath')).toBe('')
    const again = await openShadow(dir, { home: dimFactoryHome })
    expect(shadowConfigValue(again.gitDir, 'core.hooksPath')).toBe(
      gitConfigPath(join(dimFactoryHome, 'empty-hooks')),
    )
  })

  it('the size preflight never strips info/exclude; the read-only measurement writes nothing', async () => {
    const dir = tempDir('size-ro')
    for (let i = 0; i < 5; i++) write(dir, `f${i}.txt`, '0123456789')
    write(dir, 'big.bin', Buffer.alloc(600, 7))
    const scope = await resolveScope(dir)
    const limits = { largeFileBytes: 500 }
    const dimFactoryHome = tempDir('chome-size')
    // No shadow yet: measured against a throwaway repo; nothing is created under DIM_FACTORY_HOME.
    const fresh = await sizePreflightReadOnly(scope, { home: dimFactoryHome, limits })
    expect(fresh).toMatchObject({ files: 5, bytes: 50, largeFiles: [{ path: 'big.bin', bytes: 600 }] })
    expect(readdirSync(dimFactoryHome)).toEqual([])

    const shadow = await Shadow.open(scope, { home: dimFactoryHome, limits })
    await shadow.sizePreflight()
    const exclude = join(shadow.gitDir, 'info', 'exclude')
    const state = (): Record<string, unknown> => ({
      exclude: readFileSync(exclude, 'utf8'),
      meta: readFileSync(join(shadow.root, 'meta.json'), 'utf8'),
      index: existsSync(join(shadow.gitDir, 'index')),
      lock: existsSync(join(shadow.gitDir, 'index.lock')),
      files: listTree(shadow.root),
    })
    const before = state()
    expect(before['exclude']).toContain('\n/big.bin\n')
    const ro = await sizePreflightReadOnly(scope, { home: dimFactoryHome, limits })
    expect(ro).toMatchObject({ files: 5, bytes: 50, largeFiles: [{ path: 'big.bin', bytes: 600 }] })
    expect(state()).toEqual(before)

    // A listing that fails leaves the large-file excludes in place.
    configureGit({ executable: join(dir, 'no-such-git') })
    try {
      await expect(shadow.sizePreflight()).rejects.toMatchObject({ kind: 'missing' })
    } finally {
      configureGit({ executable: TEST_GIT })
    }
    expect(readFileSync(exclude, 'utf8')).toBe(before['exclude'])
    // An unchanged result does not rewrite info/exclude.
    const mtime = mtimeMs(exclude)
    await shadow.sizePreflight()
    expect(mtimeMs(exclude)).toBe(mtime)
  })

  it.skipIf(!sh)(
    'a shadow git call killed by its own timeout leaves no lock: the next snapshot works',
    async () => {
      const dir = tempDir('timeout')
      write(dir, 'a.txt', 'a\n')
      const shadow = await openShadow(dir, { home: tempDir('chome-timeout'), lockWaitMs: 0 })
      await shadow.snapshot(RUN, 'S0')
      // An fsmonitor hook that never answers keeps git inside the index lock until the timeout kills it.
      // Node waits, not `sleep`: MinGit ships no sleep, and the one PATH finds (another Git's MSYS runtime) exits at
      // once with "missing operand".
      const node = process.execPath.replace(/\\/g, '/')
      const hook = write(
        tempDir('fsmon'),
        'fsmonitor.sh',
        `#!/bin/sh\nexec '${node}' -e 'setTimeout(function () {}, 30000)'\n`,
      )
      chmodSync(hook, 0o755)
      for (const cmd of [
        ['add', '-A', '--ignore-errors'],
        ['update-index', '-q', '--refresh'],
      ]) {
        await expect(
          shadow.git(['-c', `core.fsmonitor=${gitConfigPath(hook)}`, ...cmd], {
            timeoutMs: 1500,
            okCodes: [0, 1],
          }),
        ).rejects.toMatchObject({ kind: 'timeout' })
        expect(existsSync(join(shadow.gitDir, 'index.lock'))).toBe(false)
      }
      write(dir, 'b.txt', 'b\n')
      const s1 = await shadow.snapshot(RUN, 'S1')
      expect(shadowTreePaths(shadow.gitDir, s1.commit)).toEqual(['a.txt', 'b.txt'])
    },
    60_000,
  )

  it('nested repositories: edits inside them change the snapshot fingerprint, not the tree', async () => {
    const dir = tempDir('nested')
    write(dir, 'top.txt', 'top\n')
    const app = join(dir, 'app')
    write(app, 'main.c', 'int main(){}\n')
    initRepo(app)
    git(app, ['add', 'main.c'])
    git(app, ['commit', '-q', '-m', 'app'])
    const shadow = await openShadow(dir, { home: tempDir('chome-nested') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    expect(s0.nested?.map((n) => n.path)).toEqual(['app'])
    write(app, 'main.c', 'int main(){ return 1; }\n')
    const s1 = await shadow.snapshot(RUN, 'S1')
    expect(s1.tree).toBe(s0.tree)
    expect(nestedReposKey(s1)).not.toBe(nestedReposKey(s0))
    // Nothing changed since: the same fingerprint.
    const s2 = await shadow.snapshot(RUN, 'S2')
    expect(nestedReposKey(s2)).toBe(nestedReposKey(s1))
    // A repository the agent just created (no commit yet) is reported too, not as unreadable files.
    const tool = join(dir, 'tool')
    write(tool, 'x.txt', 'x\n')
    git(tool, ['init', '-q'])
    const s3 = await shadow.snapshot(RUN, 'resume')
    expect(s3.nested?.map((n) => n.path)).toEqual(['app', 'tool'])
    expect(s3.unreadable).toEqual([])
    // Its files are not taken in as the folder's own (git 2.17 stages them; the shadow drops them).
    expect(s3.tree).toBe(s0.tree)
    // The user's nested repository was only read.
    expect(existsSync(join(app, '.git', 'index.lock'))).toBe(false)
    // A folder without nested repositories has no fingerprint.
    const plain = tempDir('plain-nested')
    write(plain, 'a.txt', 'a\n')
    const p = await (await openShadow(plain, { home: tempDir('chome-plain') })).snapshot(RUN, 'S0')
    expect(p.nested).toBeUndefined()
    expect(nestedReposKey(p)).toBeUndefined()
  })
})
