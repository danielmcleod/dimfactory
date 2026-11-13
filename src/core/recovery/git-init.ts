// `git.init` (non-git folders work; "Initialize git" is an optional banner action, as in the quick composer's
// "Dim Factory tracks changes itself [Initialize git]"). Only an existing folder that is in no repository and
// that the folder guard allows (a home folder, a drive root or Dim Factory's own data are refused, as for runs). Runs
// `git init` through core/git (sanitized env; core.hooksPath pointed at Dim Factory's empty hooks folder for this one
// call) and nothing else: no commit, no config written, no files added.
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DimFactoryError } from '../errors.ts'
import { detectRepo } from '../git/repo.ts'
import type { RepoInfo } from '../git/repo.ts'
import { isGitError, runGit } from '../git/exec.ts'
import type { GitRunOptions, GitResult } from '../git/exec.ts'
import { isGuarded } from '../preflight/guard.ts'
import type { GuardOptions, GuardResult } from '../preflight/guard.ts'

export interface GitInitDeps {
  /** DIM_FACTORY_HOME (the guard refuses it and everything inside it). */
  dimFactoryHome: string
  /** `<home>/empty-hooks`. */
  emptyHooksDir: string
  env?: Readonly<Record<string, string | undefined>>
  /** Test seams. */
  guard?: (folder: string, o: GuardOptions) => Promise<GuardResult>
  detect?: (folder: string) => Promise<RepoInfo>
  git?: (args: readonly string[], o: GitRunOptions) => Promise<GitResult>
}

/** `git init` budget (one local process; generous for a slow machine). */
export const GIT_INIT_TIMEOUT_MS = 30_000

/** A path inside a git config value: forward slashes on Windows (as the shadow writes core.hooksPath). */
const configPath = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p)

const gitFailure = (err: unknown): DimFactoryError =>
  isGitError(err)
    ? new DimFactoryError(err.resultCode, err.message)
    : new DimFactoryError('GIT', err instanceof Error ? err.message : String(err))

/** Initialize a repository in `folder`; throws DimFactoryError with a plain reason when it may not. */
export async function initRepository(folder: string, d: GitInitDeps): Promise<void> {
  const abs = resolve(folder)
  const st = await stat(abs).catch(() => null)
  if (st === null) throw new DimFactoryError('NOT_FOUND', `${abs} does not exist.`)
  if (!st.isDirectory()) throw new DimFactoryError('VALIDATION', `${abs} is not a folder.`)
  const g = await (d.guard ?? isGuarded)(abs, {
    owner: 'run',
    dimFactoryHome: d.dimFactoryHome,
    ...(d.env !== undefined ? { env: d.env } : {}),
  })
  if (g.guarded)
    throw new DimFactoryError('FORBIDDEN', `Dim Factory does not initialize git here: ${g.detail}`)
  let repo: RepoInfo
  try {
    repo = await (d.detect ?? detectRepo)(abs)
  } catch (err) {
    throw gitFailure(err)
  }
  if (repo.isRepo) {
    throw new DimFactoryError(
      'CONFLICT',
      `${abs} is already inside the git repository at ${repo.toplevel ?? abs}; nothing to initialize.`,
    )
  }
  if (repo.error !== undefined) {
    throw new DimFactoryError('GIT', `git could not read ${abs}: ${repo.error}`)
  }
  try {
    await (d.git ?? runGit)(['-c', `core.hooksPath=${configPath(d.emptyHooksDir)}`, 'init', '-q'], {
      cwd: repo.realFolder,
      timeoutMs: GIT_INIT_TIMEOUT_MS,
      category: 'git_state',
    })
  } catch (err) {
    throw gitFailure(err)
  }
}
