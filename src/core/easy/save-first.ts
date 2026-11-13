// A folder the user already has, before a run works on a copy of it: how many files have changes git has not saved
// yet (the copy is made from the last commit, so it would not have them), and "Save them first": one commit of
// everything, so the copy starts from the folder as it is. The commit runs only when the user picks it; hooks never
// run (core.hooksPath points at Dim Factory's empty hooks folder), and a repository with no name and email set gets
// Dim Factory's for this one commit.
import { runGit } from '../git/exec.ts'
import type { GitResult, GitRunOptions } from '../git/exec.ts'

export const SAVE_FIRST_MESSAGE = 'Saved my changes before a change in Dim Factory'
const SAVE_TIMEOUT_MS = 60_000
/** The name and email of the save commit when the repository has none set. */
const FALLBACK_IDENTITY = ['-c', 'user.name=Dim Factory', '-c', 'user.email=dim-factory@localhost']

type Git = (args: readonly string[], o: GitRunOptions) => Promise<GitResult>

/** A path inside a git config value: forward slashes on Windows. */
const configPath = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p)

/** `git status --porcelain=v1 -z` entries: one per changed or new file (a rename's second path is skipped). */
export function countStatus(z: string): number {
  const parts = z.split('\0').filter((p) => p !== '')
  let n = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? ''
    n++
    // A rename or copy carries its old path as the next entry.
    if (/^[RC]/.test(p)) i++
  }
  return n
}

/** How many files in the repository have changes no commit holds (new files included; ignored files are not). */
export async function uncommittedCount(toplevel: string, git: Git = runGit): Promise<number> {
  const r = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: toplevel,
    noOptionalLocks: true,
    timeoutMs: SAVE_TIMEOUT_MS,
  })
  return countStatus(r.stdout)
}

/** Commit everything in the repository (new files included), so a copy made from the last commit has it all. */
export async function saveFirst(toplevel: string, o: { emptyHooksDir: string; git?: Git }): Promise<void> {
  const git = o.git ?? runGit
  const hooks = ['-c', `core.hooksPath=${configPath(o.emptyHooksDir)}`]
  await git([...hooks, 'add', '-A'], { cwd: toplevel, timeoutMs: SAVE_TIMEOUT_MS, category: 'git_state' })
  const commit = (extra: readonly string[]): Promise<GitResult> =>
    git([...hooks, ...extra, 'commit', '-q', '--no-verify', '-m', SAVE_FIRST_MESSAGE], {
      cwd: toplevel,
      timeoutMs: SAVE_TIMEOUT_MS,
      category: 'git_state',
      okCodes: [0, 1, 128],
    })
  const r = await commit([])
  if (r.code === 0 || /nothing to commit|nothing added/i.test(r.stdout + r.stderr)) return
  // No name or email set for git: the commit is made with Dim Factory's, for this one commit only.
  if (/tell me who you are|empty ident|unable to auto-detect email/i.test(r.stderr)) {
    const again = await commit(FALLBACK_IDENTITY)
    if (again.code === 0) return
    throw new Error(again.stderr.trim() || 'git could not save the changes.')
  }
  throw new Error(r.stderr.trim() || 'git could not save the changes.')
}
