// Coverage: repository detection when git refuses or answers oddly ("dubious ownership":
// CVE-2022-24765, a folder another account owns, which branch prep and isolated runs block on with the
// `safe.directory` command). git's answer is scripted (tryGit); the folders and their `.git` entries are real.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitExec from '../../../src/core/git/exec.ts'
import { GitError, tryGit } from '../../../src/core/git/exec.ts'
import type { GitResult } from '../../../src/core/git/exec.ts'
import { detectRepo, stripLongPathPrefix } from '../../../src/core/git/repo.ts'

vi.mock('../../../src/core/git/exec.ts', async (importOriginal) => {
  const real = await importOriginal<typeof GitExec>()
  return { ...real, tryGit: vi.fn() }
})

const ARGS = ['--no-optional-locks', 'rev-parse', '--is-inside-work-tree']
const DUBIOUS = [
  "fatal: detected dubious ownership in repository at 'C:/Users/other/repo'",
  "'C:/Users/other/repo' is owned by:",
  'To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/Users/other/repo',
].join('\n')

const exitFailure = (stderr: string): Awaited<ReturnType<typeof tryGit>> => ({
  ok: false,
  error: new GitError('exit', 'git rev-parse failed (exit 128)', {
    args: ARGS,
    exitCode: 128,
    stderr,
    category: 'git_state',
  }),
})

const answer = (stdout: string): Awaited<ReturnType<typeof tryGit>> => {
  const result: GitResult = { args: ARGS, code: 0, stdout, stderr: '', ms: 1, truncated: false }
  return { ok: true, result }
}

async function tree(): Promise<string> {
  return stripLongPathPrefix(await realpath(await mkdtemp(join(tmpdir(), 'repo-detect-'))))
}

/** Some machines keep a repository above the temp folder (a versioned home): the "no .git above" case skips there. */
function dotGitAbove(dir: string): boolean {
  for (let cur = dir; ; cur = dirname(cur)) {
    if (existsSync(join(cur, '.git'))) return true
    if (dirname(cur) === cur) return false
  }
}

beforeEach(() => {
  vi.mocked(tryGit).mockReset()
})

describe('detectRepo: git refuses the repository (dubious ownership)', () => {
  it('walks up to the nearest .git folder: a repo, with its git dir, flagged dubious', async () => {
    const top = await tree()
    await mkdir(join(top, '.git'))
    const deep = join(top, 'src', 'deep')
    await mkdir(deep, { recursive: true })
    vi.mocked(tryGit).mockResolvedValueOnce(exitFailure(DUBIOUS))
    const info = await detectRepo(deep)
    expect(info).toEqual({
      folder: deep,
      realFolder: deep,
      isRepo: true,
      dubiousOwnership: true,
      toplevel: top,
      gitDir: join(top, '.git'),
      commonDir: join(top, '.git'),
    })
    // One read-only call, without taking the user's index.lock.
    expect(vi.mocked(tryGit)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tryGit).mock.calls[0]?.[1]).toMatchObject({ cwd: deep, noOptionalLocks: true })
  })

  it('a .git file (a linked worktree or submodule): the top level is known, the git dir is not', async () => {
    const top = await tree()
    await writeFile(join(top, '.git'), 'gitdir: ../elsewhere/.git/worktrees/wt\n')
    vi.mocked(tryGit).mockResolvedValueOnce(exitFailure(DUBIOUS))
    const info = await detectRepo(top)
    expect(info).toMatchObject({ isRepo: true, dubiousOwnership: true, toplevel: top })
    expect(info.gitDir).toBeUndefined()
    expect(info.commonDir).toBeUndefined()
  })

  it('no .git above the folder: not a repo, still flagged, with git’s first line', async (ctx) => {
    const top = await tree()
    if (dotGitAbove(top)) ctx.skip()
    vi.mocked(tryGit).mockResolvedValueOnce(exitFailure(`\n  ${DUBIOUS}`))
    const info = await detectRepo(top)
    expect(info).toEqual({
      folder: top,
      realFolder: top,
      isRepo: false,
      dubiousOwnership: true,
      error: "fatal: detected dubious ownership in repository at 'C:/Users/other/repo'",
    })
  })
})

describe('detectRepo: other answers', () => {
  it('"not a git repository" is a plain folder, with no error', async () => {
    const top = await tree()
    vi.mocked(tryGit).mockResolvedValueOnce(
      exitFailure('fatal: not a git repository (or any of the parent directories): .git'),
    )
    expect(await detectRepo(top)).toEqual({
      folder: top,
      realFolder: top,
      isRepo: false,
      dubiousOwnership: false,
    })
  })

  it('any other refusal is not a repo, carrying git’s first line', async () => {
    const top = await tree()
    vi.mocked(tryGit).mockResolvedValueOnce(
      exitFailure('fatal: unsafe repository config\nhint: something else\n'),
    )
    expect(await detectRepo(top)).toMatchObject({
      isRepo: false,
      dubiousOwnership: false,
      error: 'fatal: unsafe repository config',
    })
  })

  it('git itself missing (or a timeout) is thrown, never read as "not a repo"', async () => {
    const top = await tree()
    const missing = new GitError('missing', 'git was not found (git): spawn git ENOENT', {
      args: ARGS,
      category: 'git_missing',
    })
    vi.mocked(tryGit).mockResolvedValueOnce({ ok: false, error: missing })
    await expect(detectRepo(top)).rejects.toBe(missing)
    const timeout = new GitError('timeout', 'git rev-parse timed out after 15000 ms', {
      args: ARGS,
      category: 'git_state',
    })
    vi.mocked(tryGit).mockResolvedValueOnce({ ok: false, error: timeout })
    await expect(detectRepo(top)).rejects.toMatchObject({ kind: 'timeout', resultCode: 'TIMEOUT' })
  })

  it('inside the .git folder ("false"): not a work tree', async () => {
    const top = await tree()
    vi.mocked(tryGit).mockResolvedValueOnce(answer('false\n'))
    expect(await detectRepo(top)).toEqual({
      folder: top,
      realFolder: top,
      isRepo: false,
      dubiousOwnership: false,
    })
  })

  it('a work tree without a top level is reported, not guessed', async () => {
    const top = await tree()
    vi.mocked(tryGit).mockResolvedValueOnce(answer('true\n\n'))
    expect(await detectRepo(top)).toMatchObject({
      isRepo: false,
      error: 'git reported no work tree top level',
    })
  })

  it('relative git dirs are made absolute against the folder; CRLF output is read the same', async () => {
    const top = await tree()
    const sub = join(top, 'sub')
    await mkdir(sub)
    vi.mocked(tryGit).mockResolvedValueOnce(answer(`true\r\n${top}\r\n../.git\r\n../.git\r\n`))
    expect(await detectRepo(sub)).toEqual({
      folder: sub,
      realFolder: sub,
      isRepo: true,
      dubiousOwnership: false,
      toplevel: top,
      gitDir: join(top, '.git'),
      commonDir: join(top, '.git'),
    })
  })

  it('a folder that does not exist throws ENOENT before git runs', async () => {
    const top = await tree()
    await expect(detectRepo(join(top, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(vi.mocked(tryGit)).not.toHaveBeenCalled()
  })
})
