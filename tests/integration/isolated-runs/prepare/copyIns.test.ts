// Copy-ins against a real repository (Prepare step 2: ignored or untracked files only). The tracked
// list comes from `git ls-files -z -s` (--no-optional-locks; DIM_FACTORY_TEST_GIT selects 2.17.1 in CI): an ignored
// `.env` and an untracked note are copied, a tracked file (also one that is tracked but ignored) is refused, a
// submodule-style gitlink's files are left alone, and a folder below the repository's root reads its own paths.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyIns, gitTrackedFiles } from '../../../../src/core/prepare/copyIns.ts'
import { cleanupTemps, git, initRepo, tempDir, write } from '../../git/helpers.ts'

afterEach(() => cleanupTemps())

describe('copyIns with git', () => {
  it('copies ignored and untracked files; tracked ones (even ignored-but-tracked) stay the committed version', async () => {
    const repo = tempDir('copy-repo')
    initRepo(repo)
    write(repo, '.gitignore', '.env\n*.local.json\n')
    write(repo, 'config/app.local.json', '{"tracked":"but ignored"}\n')
    write(repo, 'src/a.ts', 'export {}\n')
    git(repo, ['add', '.gitignore', 'src/a.ts'])
    git(repo, ['add', '-f', 'config/app.local.json'])
    git(repo, ['commit', '-q', '-m', 'files'])
    write(repo, '.env', 'SECRET=1\n')
    write(repo, 'config/dev.local.json', '{}\n')
    write(repo, 'notes.md', 'untracked\n')
    write(repo, 'src/a.ts', 'export const changed = 1\n')

    const t = await gitTrackedFiles(repo)
    expect([...(t?.files ?? [])].sort()).toEqual([
      '.gitignore',
      'README.md',
      'config/app.local.json',
      'src/a.ts',
    ])

    const wt = tempDir('copy-wt')
    const r = await copyIns(repo, wt, ['.env', 'config/*.json', 'notes.md', 'src/**'])
    expect(r.copied.sort()).toEqual(['.env', 'config/dev.local.json', 'notes.md'])
    expect(r.skipped.map((s) => s.path).sort()).toEqual(['config/app.local.json', 'src/a.ts'])
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(existsSync(join(wt, 'src', 'a.ts'))).toBe(false)
  })

  it('a folder below the root: its own relative paths; a gitlink’s files are left alone', async () => {
    const repo = tempDir('copy-sub')
    initRepo(repo)
    write(repo, 'app/package.json', '{}\n')
    git(repo, ['add', 'app/package.json'])
    const sha = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${sha},app/vendor/lib`])
    git(repo, ['commit', '-q', '-m', 'app'])
    write(repo, 'app/.env', 'x\n')
    write(repo, 'app/vendor/lib/inner.txt', 'submodule file\n')

    const app = join(repo, 'app')
    const t = await gitTrackedFiles(app)
    expect([...(t?.files ?? [])].sort()).toEqual(['package.json', 'vendor/lib'])
    expect(t?.gitlinks).toEqual(['vendor/lib'])
    const wt = tempDir('copy-sub-wt')
    const r = await copyIns(app, wt, ['.env', 'package.json', 'vendor/**'])
    expect(r.copied).toEqual(['.env'])
    expect(r.skipped).toEqual([
      { path: 'package.json', reason: 'It is tracked by git: the run uses the committed version' },
      { path: 'vendor/lib/inner.txt', reason: 'It is inside a nested repository' },
    ])
  })

  it('not a repository: the tracked files cannot be listed, so nothing is copied', async () => {
    const plain = tempDir('copy-plain')
    write(plain, '.env', 'x\n')
    const wt = tempDir('copy-plain-wt')
    const r = await copyIns(plain, wt, ['.env'])
    expect(r.copied).toEqual([])
    expect(r.refused[0]?.reason).toMatch(/could not list the tracked files/)
  })
})
