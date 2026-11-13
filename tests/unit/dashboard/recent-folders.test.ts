// folders.recent (src/core/dashboard/recent-folders.ts): distinct run folders, most recent run first, at most 20,
// with stat-only facts (exists, a `.git` entry in the folder or an ancestor, that ancestor as the scope root).
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { folderFacts, folderIdentity, recentFolders } from '@core/dashboard/recent-folders.ts'
import type { FolderFacts } from '@core/dashboard/recent-folders.ts'
import { MIN, T0, run } from '../estimates/helpers.ts'

const at = (folder: string, minutes: number) => run([], { folder, createdAt: T0 + minutes * MIN })
const facts = (): Promise<FolderFacts> => Promise.resolve({ exists: true, isGit: false, scopeRoot: null })

describe('recentFolders', () => {
  it('distinct folders, most recent run first, with the time of their latest run', async () => {
    const a = join(tmpdir(), 'a')
    const b = join(tmpdir(), 'b')
    const out = await recentFolders([at(a, 1), at(b, 2), at(a, 3), at(`${b}${sep}`, 0)], facts)
    expect(out.map((f) => [f.folder, f.lastRunAt])).toEqual([
      [a, T0 + 3 * MIN],
      [b, T0 + 2 * MIN],
    ])
    expect(out[0]).toEqual({
      folder: a,
      scopeRoot: null,
      lastRunAt: T0 + 3 * MIN,
      isGit: false,
      exists: true,
    })
  })

  it('at most 20', async () => {
    const many = Array.from({ length: 25 }, (_, i) => at(join(tmpdir(), `f${i}`), i))
    const out = await recentFolders(many, facts)
    expect(out).toHaveLength(20)
    expect(out[0]?.folder).toBe(join(tmpdir(), 'f24'))
  })

  it('folder identity folds case on Windows and macOS only, and ignores a trailing separator', () => {
    expect(folderIdentity('C:\\Work\\App\\', 'win32')).toBe(folderIdentity('c:\\work\\app', 'win32'))
    expect(folderIdentity('/srv/App', 'linux')).not.toBe(folderIdentity('/srv/app', 'linux'))
    expect(folderIdentity('/srv/app/', 'linux')).toBe(folderIdentity('/srv/app', 'linux'))
  })

  it('a lookup that throws reads as a missing folder', async () => {
    const out = await recentFolders([at(join(tmpdir(), 'x'), 1)], () => Promise.reject(new Error('EPERM')))
    expect(out[0]).toMatchObject({ exists: false, isGit: false, scopeRoot: null })
  })
})

describe('folderFacts', () => {
  it('a .git directory or file marks the work tree; its subfolders share the scope root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'facts-'))
    const repo = join(root, 'repo')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(join(repo, 'packages', 'web'), { recursive: true })
    expect(await folderFacts(repo)).toEqual({ exists: true, isGit: true, scopeRoot: repo })
    expect(await folderFacts(join(repo, 'packages', 'web'))).toEqual({
      exists: true,
      isGit: true,
      scopeRoot: repo,
    })
    const worktree = join(root, 'wt')
    await mkdir(worktree)
    await writeFile(join(worktree, '.git'), 'gitdir: ../repo/.git/worktrees/wt\n')
    expect(await folderFacts(worktree)).toEqual({ exists: true, isGit: true, scopeRoot: worktree })
  })

  it('a missing folder, and a plain folder outside any work tree under it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'facts-'))
    expect(await folderFacts(join(root, 'nope'))).toEqual({ exists: false, isGit: false, scopeRoot: null })
    const plain = join(root, 'plain')
    await mkdir(plain)
    const f = await folderFacts(plain)
    expect(f.exists).toBe(true)
    // Nothing under the temp root is a work tree; an ancestor above it may be one on a developer machine.
    if (f.isGit) {
      const scope = f.scopeRoot ?? ''
      expect(scope !== root && scope !== plain && root.startsWith(scope)).toBe(true)
    } else {
      expect(f.scopeRoot).toBeNull()
    }
  })
})
