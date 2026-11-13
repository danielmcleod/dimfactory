// "Commit to run branch" (opt-in per project): commit a finished run's changes on the branch the run worked on: its
// run branch in the folder, or its isolated copy's branch. Only the run's own paths go in, and the user's index is
// never used to build the commit:
//   1. Under the repository's common-dir mutex: HEAD must be on the expected branch, with no merge or rebase going on.
//   2. The user's staged changes are read (`diff --cached`, no optional locks). Staged paths outside the run's are
//      left alone and named; a run path staged with content other than the working tree's (a partial staging, an
//      edit staged and then changed) makes the commit refuse, with the commands to settle it.
//   3. The tree is built in a TEMPORARY index (GIT_INDEX_FILE in a temp folder): read-tree HEAD, then update-index
//      --add --remove for the run's paths only; write-tree; commit-tree -p HEAD (the message on stdin; no hooks).
//   4. update-ref moves the branch with HEAD's old commit as the expected value (refused if HEAD moved meanwhile).
//   5. The real index gets the run's paths only (update-index from the working tree, which the commit was made from),
//      so `git status` reads clean for them; nothing else in the index changes. If that last write fails, the commit
//      stands and the copyable `git reset -q -- <paths>` settles the index.
// Never pushes and never runs the user's hooks.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GitError, chunkPaths, isGitError, runGit, splitNul, tryGit } from './exec.ts'
import type { GitRunOptions } from './exec.ts'
import { readHead, readRepoState } from './branch.ts'
import { withCommonDirLock } from './mutex.ts'
import { detectRepo } from './repo.ts'

/** The most paths one commit takes (a run that changed more is committed by hand). */
export const COMMIT_PATHS_MAX = 5000

export interface CommitTarget {
  /** A folder inside the repository working tree the commit is made in (the folder, or the isolated copy). */
  folder: string
  /** The branch HEAD must be on (short name, without refs/heads/). */
  branch: string
  /** The run's paths, relative to the repository root, `/` separators. */
  paths: readonly string[]
  message: string
  /** An empty hooks folder (`core.hooksPath`), so no hook of the user's runs. */
  hooksPath?: string
}

export type CommitOutcome =
  | { ok: true; sha: string; branch: string; paths: string[]; notes: string[] }
  | { ok: false; reason: string; commands: string[]; staged?: string[] }

/** A path a commit may take: relative, inside the repository, never in .git. */
export function safeCommitPath(p: string): boolean {
  if (p === '' || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\'))
    return false
  const parts = p.split('/')
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return false
  return parts[0]?.toLowerCase() !== '.git'
}

/** Shell-quote one path for a copyable git command (POSIX single quotes; PowerShell accepts the same form). */
function quotePath(p: string): string {
  return /^[A-Za-z0-9._/@+-]+$/.test(p) ? p : `'${p.replace(/'/g, "''")}'`
}

const readOpts = (cwd: string, extra: Partial<GitRunOptions> = {}): GitRunOptions => ({
  cwd,
  noOptionalLocks: true,
  timeoutMs: 30_000,
  category: 'git_state',
  ...extra,
})

/** Paths staged in the user's index (index differs from HEAD), repository-relative. */
export async function stagedPaths(root: string): Promise<string[]> {
  const r = await runGit(
    ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD', '--'],
    readOpts(root),
  )
  return splitNul(r.stdout)
}

/** Of `paths`, those whose index entry differs from the working tree (`git diff --name-only`, index vs files). */
async function unstagedOf(root: string, paths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const chunk of chunkPaths(paths)) {
    const r = await runGit(
      ['diff', '--name-only', '--no-renames', '-z', '--', ...chunk],
      readOpts(root, { literalPathspecs: true }),
    )
    for (const p of splitNul(r.stdout)) out.add(p)
  }
  return out
}

/** Of `paths`, the untracked ones the repository ignores (they never go into a commit Dim Factory makes). */
async function ignoredOf(root: string, paths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const chunk of chunkPaths(paths)) {
    const r = await runGit(
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...chunk],
      readOpts(root, { literalPathspecs: true }),
    )
    for (const p of splitNul(r.stdout)) out.add(p)
  }
  return out
}

/** The user has no name or email set for commits. */
export function isIdentityError(stderr: string): boolean {
  return /Please tell me who you are|empty ident|unable to auto-detect email|no email was given/i.test(stderr)
}

const identityCommands = [
  'git config user.name "Your Name"',
  'git config user.email "you@example.com"',
] as const

/** Commit the run's paths on `branch` (see the header). Git failures that are not refusals throw GitError. */
export async function commitRunChanges(t: CommitTarget): Promise<CommitOutcome> {
  const repo = await detectRepo(t.folder)
  if (!repo.isRepo || repo.toplevel === undefined)
    return { ok: false, reason: 'The folder is not in a git repository.', commands: [] }
  if (repo.dubiousOwnership)
    return { ok: false, reason: 'git refuses this repository (it belongs to another user).', commands: [] }
  const root = repo.toplevel
  const commonDir = repo.commonDir ?? path.join(root, '.git')
  const paths = [...new Set(t.paths)].sort()
  if (paths.length === 0)
    return { ok: false, reason: 'The run changed no files, so there is nothing to commit.', commands: [] }
  if (paths.length > COMMIT_PATHS_MAX)
    return {
      ok: false,
      reason: `The run changed more than ${COMMIT_PATHS_MAX} files; commit them yourself.`,
      commands: [],
    }
  const bad = paths.find((p) => !safeCommitPath(p))
  if (bad !== undefined)
    return { ok: false, reason: `Dim Factory will not commit the path ${bad}.`, commands: [] }
  const hooks = t.hooksPath !== undefined ? ['-c', `core.hooksPath=${t.hooksPath.replace(/\\/g, '/')}`] : []
  const ref = `refs/heads/${t.branch}`
  // Files the repository ignores stay out (build output, a local .env): the commit holds what git would track.
  const ignored = await ignoredOf(root, paths)
  const kept = paths.filter((p) => !ignored.has(p))
  if (kept.length === 0)
    return {
      ok: false,
      reason: 'Every file the run changed is ignored by git, so there is nothing to commit.',
      commands: [],
    }
  const stdinPaths = `${kept.join('\0')}\0`
  return withCommonDirLock(
    commonDir,
    async (): Promise<CommitOutcome> => {
      const head = await readHead(root)
      if (head.ref !== ref) {
        return {
          ok: false,
          reason: `HEAD is not on ${t.branch} any more, so Dim Factory does not commit there.`,
          commands: [`git checkout ${quotePath(t.branch)}`],
        }
      }
      const parent = head.commit
      if (parent === null) return { ok: false, reason: `${t.branch} has no commit yet.`, commands: [] }
      const state = await readRepoState(repo)
      if (state.operation !== null)
        return {
          ok: false,
          reason: `A git ${state.operation} is in progress. Finish or abort it first.`,
          commands: [],
        }
      if (state.unmergedPaths.length > 0)
        return { ok: false, reason: 'The repository has unmerged paths. Resolve them first.', commands: [] }
      // The user's staging: unrelated paths are left alone; a run path staged with other content refuses.
      const staged = await stagedPaths(root)
      const runSet = new Set(kept)
      const overlap = staged.filter((p) => runSet.has(p))
      const differing = [...(await unstagedOf(root, overlap))].sort()
      if (differing.length > 0) {
        return {
          ok: false,
          reason: `You staged changes to ${differing.length === 1 ? 'a file' : `${differing.length} files`} this run changed, and the staged content differs from the file now. Dim Factory will not decide between them: commit or unstage your staged change first.`,
          commands: [`git restore --staged -- ${differing.map(quotePath).join(' ')}`],
          staged: differing,
        }
      }
      const untouched = staged.filter((p) => !runSet.has(p))
      const tmp = await mkdtemp(path.join(tmpdir(), 'dimf-commit-'))
      const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
      try {
        await runGit(['read-tree', parent], { cwd: root, env, timeoutMs: 60_000, category: 'git_state' })
        await runGit(['update-index', '--add', '--remove', '-z', '--stdin'], {
          cwd: root,
          env,
          stdin: stdinPaths,
          timeoutMs: 120_000,
          category: 'git_state',
        })
        const tree = (await runGit(['write-tree'], { cwd: root, env, category: 'git_state' })).stdout.trim()
        const headTree = (await runGit(['rev-parse', `${parent}^{tree}`], readOpts(root))).stdout.trim()
        if (tree === headTree)
          return {
            ok: false,
            reason: `${t.branch} already holds the run's changes: there is nothing to commit.`,
            commands: [],
          }
        const made = await tryGit([...hooks, 'commit-tree', tree, '-p', parent, '-F', '-'], {
          cwd: root,
          stdin: t.message.endsWith('\n') ? t.message : `${t.message}\n`,
          timeoutMs: 60_000,
          category: 'git_state',
        })
        if (!made.ok) {
          if (isIdentityError(made.error.stderr))
            return {
              ok: false,
              reason: 'git does not know your name and email for commits yet. Set them, then try again.',
              commands: [...identityCommands],
            }
          throw made.error
        }
        const sha = made.result.stdout.trim()
        if (!/^[0-9a-f]{40,64}$/.test(sha))
          throw new GitError('exit', `git commit-tree answered ${sha}`, { args: [], category: 'git_state' })
        try {
          await runGit(
            [...hooks, 'update-ref', '-m', `dim-factory: commit the run's changes`, ref, sha, parent],
            { cwd: root, timeoutMs: 30_000, category: 'git_state' },
          )
        } catch (err) {
          if (isGitError(err) && /but expected|cannot lock ref/i.test(err.stderr))
            return {
              ok: false,
              reason: `${t.branch} moved while Dim Factory was committing. Nothing was committed; try again.`,
              commands: [],
            }
          throw err
        }
        const notes: string[] = []
        if (ignored.size > 0)
          notes.push(
            `${ignored.size === 1 ? 'One file' : `${ignored.size} files`} the run changed ${ignored.size === 1 ? 'is' : 'are'} ignored by git and left out of the commit.`,
          )
        if (untouched.length > 0)
          notes.push(
            `Your other staged changes (${untouched.length === 1 ? '1 file' : `${untouched.length} files`}) were left staged and are not in the commit.`,
          )
        // The real index: the run's paths only, from the files the commit was made from.
        const synced = await tryGit(['update-index', '--add', '--remove', '-z', '--stdin'], {
          cwd: root,
          stdin: stdinPaths,
          timeoutMs: 120_000,
          category: 'git_state',
        })
        if (!synced.ok)
          notes.push(
            `The commit is made, but git could not update its index for these files (${synced.error.message}). Run: git reset -q -- ${kept.slice(0, 20).map(quotePath).join(' ')}`,
          )
        return { ok: true, sha, branch: t.branch, paths: kept, notes }
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      }
    },
    { attempts: 1 },
  )
}
