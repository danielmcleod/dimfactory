// Repo detection, lock/folder keys, size preflight, case-only renames and unreadable files against real git.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitError, configureGit, gitVersion, tryGit } from '../../../src/core/git/exec.ts'
import { detectRepo, probeCaseInsensitive, resolveScope } from '../../../src/core/git/repo.ts'
import { Shadow, forgetShadows, openShadow, shadowFor } from '../../../src/core/git/shadow.ts'
import {
  TEST_GIT,
  cleanupTemps,
  git,
  initRepo,
  isWin,
  shadowTreePaths,
  tempDir,
  testGitVersion,
  write,
} from './helpers.ts'

const version = await testGitVersion()
console.info(`[git-compat] scope suite: ${version.raw} (${TEST_GIT})`)

const RUN = '20261005T120000Z-5c0p'
const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const children: ChildProcess[] = []

afterEach(() => {
  for (const c of children.splice(0)) c.kill()
  cleanupTemps()
})

const caseInsensitiveTmp = await probeCaseInsensitive(tempDir('probe'))
cleanupTemps()

describe(`scope and keys (${version.raw})`, () => {
  it('reports a missing git binary as git_missing and a missing folder as folder_guard', async () => {
    const dir = tempDir('nogit')
    configureGit({ executable: join(dir, 'no-such-git') })
    try {
      await expect(detectRepo(dir)).rejects.toMatchObject({ kind: 'missing', category: 'git_missing' })
      await expect(gitVersion()).rejects.toBeInstanceOf(GitError)
    } finally {
      configureGit({ executable: TEST_GIT })
    }
    const gone = await tryGit(['status'], { cwd: join(dir, 'gone') })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.error).toMatchObject({ kind: 'cwd', category: 'folder_guard' })
    expect(await gitVersion()).toEqual(version)
  })

  it('detects the repo from a subfolder; scopeRoot is the toplevel; keys are stable', async () => {
    const dir = tempDir('scope')
    initRepo(dir)
    mkdirSync(join(dir, 'packages', 'app'), { recursive: true })
    const real = await realpath(dir)
    const sub = await resolveScope(join(dir, 'packages', 'app'))
    expect(sub.isRepo).toBe(true)
    expect(sub.scopeRoot).toBe(real)
    expect(sub.repo.gitDir).toBe(join(real, '.git'))
    expect(sub.repo.commonDir).toBe(join(real, '.git'))
    expect(sub.folderKey).toMatch(/^[0-9a-f]{16}$/)
    const top = await resolveScope(dir)
    expect(top.lockKey).toBe(sub.lockKey)
    expect(top.folderKey).toBe(sub.folderKey)
    if (top.caseInsensitive) {
      const variant = await resolveScope(dir.toUpperCase())
      expect(variant.lockKey).toBe(top.lockKey)
      expect(variant.folderKey).toBe(top.folderKey)
      expect(top.lockKey).toBe(top.lockKey.toLowerCase())
    }
    const inside = await detectRepo(join(dir, '.git'))
    expect(inside.isRepo).toBe(false)

    const plain = tempDir('plain-scope')
    const p = await resolveScope(plain)
    expect(p.isRepo).toBe(false)
    expect(p.scopeRoot).toBe(await realpath(plain))
  })

  it('size preflight: thresholds block, large files are auto-excluded and later re-measured', async () => {
    const dir = tempDir('size')
    for (let i = 0; i < 5; i++) write(dir, `f${i}.txt`, '0123456789')
    write(dir, 'big.bin', Buffer.alloc(600, 7))
    const shadow = await openShadow(dir, { home: home(), limits: { maxFiles: 3, largeFileBytes: 500 } })

    const byFiles = await shadow.sizePreflight()
    expect(byFiles).toMatchObject({ files: 5, bytes: 50, blocked: true, reason: 'files', partial: false })
    expect(byFiles.largeFiles).toEqual([{ path: 'big.bin', bytes: 600 }])
    expect(readFileSync(join(shadow.gitDir, 'info', 'exclude'), 'utf8')).toContain('\n/big.bin\n')

    const byBytes = await shadow.sizePreflight({ maxFiles: 100, maxBytes: 40 })
    expect(byBytes).toMatchObject({ blocked: true, reason: 'bytes' })
    const ok = await shadow.sizePreflight({ maxFiles: 100, maxBytes: 1000 })
    expect(ok.blocked).toBe(false)
    expect(ok.reason).toBeUndefined()

    const snap = await shadow.snapshot(RUN, 'run-start')
    expect(shadowTreePaths(shadow.gitDir, snap.commit)).not.toContain('big.bin')
    // Only files not yet in the shadow count on the next run.
    const after = await shadow.sizePreflight()
    expect(after.files).toBe(0)
    expect(after.blocked).toBe(false)

    // A reopened shadow (new process) still excludes the large file until it shrinks.
    const reopened = await openShadow(dir, { home: home(), limits: { largeFileBytes: 500 } })
    const again = await reopened.snapshot(RUN, 'S0')
    expect(shadowTreePaths(reopened.gitDir, again.commit)).not.toContain('big.bin')
    write(dir, 'big.bin', Buffer.alloc(100, 7))
    expect((await reopened.sizePreflight()).largeFiles).toEqual([])
    const shrunk = await reopened.snapshot(RUN, 'S1')
    expect(shadowTreePaths(reopened.gitDir, shrunk.commit)).toContain('big.bin')
  })

  it('shares one Shadow per folder; another instance keeps the large-file excludes', async () => {
    const dir = tempDir('shared')
    write(dir, 'big.bin', Buffer.alloc(600, 1))
    write(dir, 'a.txt', 'a\n')
    const scope = await resolveScope(dir)
    const a = await shadowFor(scope, { home: home(), limits: { largeFileBytes: 500 } })
    expect(await shadowFor(scope, { home: home() })).toBe(a)
    const other = await Shadow.open(scope, { home: home(), limits: { largeFileBytes: 500 } })
    await other.prepare()
    expect((await a.sizePreflight()).largeFiles.map((f) => f.path)).toEqual(['big.bin'])
    await other.prepare()
    const snap = await other.snapshot(RUN, 'S0')
    expect(shadowTreePaths(other.gitDir, snap.commit)).toEqual(['a.txt'])
    forgetShadows(scope.folderKey)
    expect(await shadowFor(scope, { home: home() })).not.toBe(a)
    forgetShadows()
  })

  it('excludes DIM_FACTORY_HOME when it lies inside the scope', async () => {
    const dir = tempDir('nested-home')
    write(dir, 'src/a.txt', 'a\n')
    const scope = await resolveScope(dir)
    const shadow = await Shadow.open(scope, { home: join(dir, '.dimfactory home') })
    const snap = await shadow.snapshot(RUN, 'run-start')
    expect(shadowTreePaths(shadow.gitDir, snap.commit)).toEqual(['src/a.txt'])
  })

  it.skipIf(!caseInsensitiveTmp)(
    'a case-only rename on a case-insensitive volume yields one rename',
    async () => {
      const dir = tempDir('case')
      initRepo(dir)
      write(dir, 'Readme.TXT', 'hello\n')
      write(dir, 'Src/a.ts', 'export const a = 1\n')
      const shadow = await openShadow(dir, { home: home() })
      expect(shadow.scope.caseInsensitive).toBe(true)
      const s0 = await shadow.snapshot(RUN, 'S0')
      renameSync(join(dir, 'Readme.TXT'), join(dir, 'readme.txt'))
      renameSync(join(dir, 'Src'), join(dir, 'src'))
      const s1 = await shadow.snapshot(RUN, 'S1')
      expect(s1.warnings.filter((w) => w.startsWith('case-only rename'))).toHaveLength(2)
      const changes = await shadow.changes(s0.commit, s1.commit)
      expect(changes.map((c) => `${c.status} ${c.oldPath ?? ''} -> ${c.path}`)).toEqual([
        'R Readme.TXT -> readme.txt',
        'R Src/a.ts -> src/a.ts',
      ])
      expect(shadowTreePaths(shadow.gitDir, s1.commit)).toEqual(['README.md', 'readme.txt', 'src/a.ts'])
      const s2 = await shadow.snapshot(RUN, 'S2')
      expect(s2.reused).toBe(true)
      expect(await shadow.liveChanged()).toEqual([])
      // the user's own index still has the old spelling (Dim Factory never touched it)
      expect(git(dir, ['ls-files']).trim()).toBe('README.md')
    },
  )

  it('records unreadable files and keeps snapshotting the rest', async () => {
    const posixRoot = !isWin && typeof process.getuid === 'function' && process.getuid() === 0
    if (posixRoot) return // root reads chmod 000 files
    const dir = tempDir('locked')
    write(dir, 'ok.txt', 'fine\n')
    const locked = write(dir, 'locked.txt', 'secret\n')
    const shadow = await openShadow(dir, { home: home() })
    if (isWin) {
      const holder = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$f=[System.IO.File]::Open('${locked.replace(/'/g, "''")}','Open','ReadWrite','None'); ` +
            `[Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 60`,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
      )
      children.push(holder)
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on('data', (d: Buffer) => {
          if (d.toString().includes('locked')) resolve()
        })
        holder.on('exit', (code) => reject(new Error(`lock holder exited ${code}`)))
      })
    } else {
      chmodSync(locked, 0o000)
    }
    try {
      const snap = await shadow.snapshot(RUN, 'S0')
      expect(snap.unreadable).toEqual(['locked.txt'])
      expect(shadowTreePaths(shadow.gitDir, snap.commit)).toEqual(['ok.txt'])
    } finally {
      for (const c of children.splice(0)) c.kill()
      if (!isWin) chmodSync(locked, 0o644)
    }
    await new Promise((r) => setTimeout(r, isWin ? 500 : 0))
    const later = await shadow.snapshot(RUN, 'S1')
    expect(later.unreadable).toEqual([])
    expect(shadowTreePaths(shadow.gitDir, later.commit)).toEqual(['locked.txt', 'ok.txt'])
  })
})
