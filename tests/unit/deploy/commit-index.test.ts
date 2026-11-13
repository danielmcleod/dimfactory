// "Commit to run branch" and the user's index (real git, temp repositories): only the run's paths go into the commit,
// built in a temporary index; the user's unrelated staged changes stay staged and out of the commit; a run path the
// user staged with other content refuses (nothing written); the branch moves only from the commit HEAD was at; the
// real index ends with the run's paths matching the new commit and nothing else touched; ignored files stay out.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commitRunChanges, safeCommitPath, stagedPaths } from '@core/git/commit.ts'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** User-side git with a fixed identity and no inherited GIT_* (and HOME as given). */
function git(cwd: string, args: string[], o: { home?: string; input?: string } = {}): string {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  if (o.home !== undefined) {
    env['HOME'] = o.home
    env['USERPROFILE'] = o.home
    env['XDG_CONFIG_HOME'] = o.home
  }
  const r = spawnSync('git', args, { cwd, env, input: o.input, windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

function write(dir: string, rel: string, text: string): void {
  const p = join(dir, ...rel.split('/'))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

/** A repo on `main` with two files committed, then switched to the run branch `dim/run`. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dimf-commit-'))
  temps.push(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Test User'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  write(dir, 'src/app.js', 'export const v = 1\n')
  write(dir, 'README.md', 'readme\n')
  write(dir, 'old.txt', 'old\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  git(dir, ['checkout', '-q', '-b', 'dim/run'])
  return dir
}

const head = (dir: string): string => git(dir, ['rev-parse', 'HEAD']).trim()
const filesIn = (dir: string, rev: string): string[] =>
  git(dir, ['ls-tree', '-r', '--name-only', rev])
    .trim()
    .split('\n')
    .filter((x) => x !== '')
const blob = (dir: string, rev: string, path: string): string => git(dir, ['show', `${rev}:${path}`])
const indexBlob = (dir: string, path: string): string => git(dir, ['show', `:${path}`])

describe('commitRunChanges: the user index stays safe', () => {
  it("commits only the run's paths; the user's unrelated staged change stays staged and out of the commit", async () => {
    const dir = repo()
    const before = head(dir)
    // The run's work: an edit, a new file and a deletion.
    write(dir, 'src/app.js', 'export const v = 2\n')
    write(dir, 'Dockerfile', 'FROM node:20\n')
    rmSync(join(dir, 'old.txt'))
    // The user's own staged change to another file, and an unstaged edit too.
    write(dir, 'README.md', 'my staged readme\n')
    git(dir, ['add', 'README.md'])
    write(dir, 'notes.txt', 'mine, not staged\n')

    const r = await commitRunChanges({
      folder: dir,
      branch: 'dim/run',
      paths: ['src/app.js', 'Dockerfile', 'old.txt'],
      message: 'Run commit\n\nbody',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.paths).toEqual(['Dockerfile', 'old.txt', 'src/app.js'])
    expect(r.notes.join(' ')).toMatch(/other staged changes \(1 file\) were left staged/)
    // The branch moved by exactly one commit, whose parent is where HEAD was.
    expect(head(dir)).toBe(r.sha)
    expect(git(dir, ['rev-parse', `${r.sha}^`]).trim()).toBe(before)
    expect(git(dir, ['log', '-1', '--format=%s', r.sha]).trim()).toBe('Run commit')
    // The commit holds the run's paths only: README is the base's, notes.txt is not in it, old.txt is gone.
    expect(blob(dir, r.sha, 'src/app.js')).toBe('export const v = 2\n')
    expect(blob(dir, r.sha, 'Dockerfile')).toBe('FROM node:20\n')
    expect(blob(dir, r.sha, 'README.md')).toBe('readme\n')
    expect(filesIn(dir, r.sha)).not.toContain('notes.txt')
    expect(filesIn(dir, r.sha)).not.toContain('old.txt')
    // The user's index: README still staged with their content; the run's paths match the commit (nothing staged).
    expect(indexBlob(dir, 'README.md')).toBe('my staged readme\n')
    expect(await stagedPaths(dir)).toEqual(['README.md'])
    // The working tree is untouched.
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine, not staged\n')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('my staged readme\n')
  })

  it('refuses when the user staged other content for a run path, and writes nothing', async () => {
    const dir = repo()
    const before = head(dir)
    write(dir, 'src/app.js', 'export const v = 2\n')
    git(dir, ['add', 'src/app.js'])
    // A later edit the user did not stage: the staged content differs from the file now.
    write(dir, 'src/app.js', 'export const v = 3\n')
    const indexBefore = indexBlob(dir, 'src/app.js')
    const r = await commitRunChanges({ folder: dir, branch: 'dim/run', paths: ['src/app.js'], message: 'x' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/staged content differs/)
    expect(r.staged).toEqual(['src/app.js'])
    expect(r.commands[0]).toBe('git restore --staged -- src/app.js')
    expect(head(dir)).toBe(before)
    expect(indexBlob(dir, 'src/app.js')).toBe(indexBefore)
  })

  it('a run path the user staged with the same content as the file is fine', async () => {
    const dir = repo()
    write(dir, 'src/app.js', 'export const v = 2\n')
    git(dir, ['add', 'src/app.js'])
    const r = await commitRunChanges({ folder: dir, branch: 'dim/run', paths: ['src/app.js'], message: 'x' })
    expect(r.ok).toBe(true)
    expect(await stagedPaths(dir)).toEqual([])
  })

  it('refuses when HEAD is not on the run branch (it never commits on a branch you work on)', async () => {
    const dir = repo()
    git(dir, ['checkout', '-q', 'main'])
    write(dir, 'src/app.js', 'export const v = 2\n')
    const before = head(dir)
    const r = await commitRunChanges({ folder: dir, branch: 'dim/run', paths: ['src/app.js'], message: 'x' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/HEAD is not on dim\/run/)
    expect(head(dir)).toBe(before)
  })

  it('leaves out files git ignores, and says so', async () => {
    const dir = repo()
    write(dir, '.gitignore', '.env\n')
    git(dir, ['add', '.gitignore'])
    git(dir, ['commit', '-q', '-m', 'ignore'])
    write(dir, '.env', 'SECRET=1\n')
    write(dir, 'src/app.js', 'export const v = 2\n')
    const r = await commitRunChanges({
      folder: dir,
      branch: 'dim/run',
      paths: ['.env', 'src/app.js'],
      message: 'x',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.paths).toEqual(['src/app.js'])
    expect(filesIn(dir, r.sha)).not.toContain('.env')
    expect(r.notes.join(' ')).toMatch(/ignored by git/)
  })

  it('refuses when there is nothing to commit, or the paths are unsafe', async () => {
    const dir = repo()
    let r = await commitRunChanges({ folder: dir, branch: 'dim/run', paths: ['src/app.js'], message: 'x' })
    expect(r.ok === false && r.reason).toMatch(/nothing to commit/)
    r = await commitRunChanges({ folder: dir, branch: 'dim/run', paths: ['../outside.txt'], message: 'x' })
    expect(r.ok === false && r.reason).toMatch(/will not commit the path/)
    r = await commitRunChanges({ folder: dir, branch: 'dim/run', paths: [], message: 'x' })
    expect(r.ok === false && r.reason).toMatch(/changed no files/)
    expect(safeCommitPath('.git/config')).toBe(false)
    expect(safeCommitPath('a/./b')).toBe(false)
    expect(safeCommitPath('C:/x')).toBe(false)
    expect(safeCommitPath('src/a.ts')).toBe(true)
  })

  it('refuses with the commands to set them when git has no name or email, and writes nothing', async () => {
    const dir = repo()
    const home = mkdtempSync(join(tmpdir(), 'dimf-home-'))
    temps.push(home)
    git(dir, ['config', '--unset', 'user.name'])
    git(dir, ['config', '--unset', 'user.email'])
    git(dir, ['config', 'user.useConfigOnly', 'true'])
    write(dir, 'src/app.js', 'export const v = 2\n')
    const before = head(dir)
    const saved = {
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      XDG: process.env['XDG_CONFIG_HOME'],
    }
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
    process.env['XDG_CONFIG_HOME'] = home
    try {
      const r = await commitRunChanges({
        folder: dir,
        branch: 'dim/run',
        paths: ['src/app.js'],
        message: 'x',
      })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toMatch(/name and email/)
      expect(r.commands).toEqual([
        'git config user.name "Your Name"',
        'git config user.email "you@example.com"',
      ])
    } finally {
      for (const [k, v] of [
        ['HOME', saved.HOME],
        ['USERPROFILE', saved.USERPROFILE],
        ['XDG_CONFIG_HOME', saved.XDG],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect(head(dir)).toBe(before)
  })
})
