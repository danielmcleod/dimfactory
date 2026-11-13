// Easy mode's "Work on something I already have": a folder the user picked, checked by the folder guard runs use (no
// drive or volume root, not the home folder or a folder holding it, no system folder, nothing inside Dim Factory's own
// data folder or a .git folder), and how a run works there:
//   - a git repository with commits: in an isolated copy (a worktree), so the folder is untouched until the user keeps
//     the changes at the end (or throws them away). The copy starts from the last commit, so the files git has not
//     saved yet are counted: the user then saves them first (one commit) or has the run work in the folder itself;
//   - a git repository with no commit yet: in place (the shadow snapshots make Undo everything work);
//   - no repository: in place once the user turns on undo for the folder (git init, no commit; the shadow snapshots
//     then work as for any repository).
// Read only: nothing here changes the folder. The project permission is never given to such a folder (service.ts).
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { EasyFolderFacts, EasyFolderMode } from '../../shared/easy.ts'
import { readHead } from '../git/branch.ts'
import { isGitError } from '../git/exec.ts'
import { detectRepo } from '../git/repo.ts'
import type { RepoInfo } from '../git/repo.ts'
import { isGuarded } from '../preflight/guard.ts'
import { uncommittedCount } from './save-first.ts'
import type { GuardOptions, GuardResult } from '../preflight/guard.ts'

export const FOLDER_PICK = 'Pick a folder.'
export const FOLDER_MISSING = 'This folder is not there any more. Pick another one.'
export const FOLDER_IS_FILE = 'That is a file, not a folder. Pick a folder.'
export const FOLDER_ROOT = 'This is a whole drive. Pick a project folder inside it.'
export const FOLDER_HOME =
  'This is your home folder, or a folder that holds it. Pick a project folder inside it.'
export const FOLDER_OWN = 'This folder belongs to Dim Factory itself. Pick a folder of your own.'
export const FOLDER_SYSTEM = 'This is a system folder. Pick a project folder of your own.'
export const FOLDER_UNTRUSTED =
  'Git does not trust this folder because it belongs to another user account. Pick another one.'
export const GIT_MISSING = 'Git was not found. Install git, then try again.'

export interface ExistingDeps {
  /** DIM_FACTORY_HOME (the guard refuses it and everything inside it). */
  home: string
  env?: Readonly<Record<string, string | undefined>>
  /** Test seams. */
  guard?: (folder: string, o: GuardOptions) => Promise<GuardResult>
  detect?: (folder: string) => Promise<RepoInfo>
  /** The repository's HEAD commit (null: no commit yet). */
  head?: (toplevel: string) => Promise<string | null>
  /** How many files have changes no commit holds (save-first.ts). */
  uncommitted?: (toplevel: string) => Promise<number>
}

/** The guard's refusal in Easy's words. */
export function guardProblem(g: GuardResult): string {
  if (g.reason === 'root') return FOLDER_ROOT
  if (g.reason === 'home') return FOLDER_HOME
  if (g.reason === 'dimFactoryHome') return FOLDER_OWN
  return FOLDER_SYSTEM
}

const nameOf = (abs: string): string => path.basename(abs) || abs

/**
 * A folder as Easy would work on it (`made` is the service's: whether Easy made it). Never throws for a folder it may
 * not use: `problem` says why, in plain words.
 */
export async function inspectExisting(folder: string, d: ExistingDeps): Promise<EasyFolderFacts> {
  const trimmed = typeof folder === 'string' ? folder.trim() : ''
  if (trimmed === '' || !path.isAbsolute(trimmed))
    return { folder: trimmed, name: trimmed, problem: FOLDER_PICK }
  const abs = path.resolve(trimmed)
  const base = { folder: abs, name: nameOf(abs) }
  const st = await stat(abs).catch(() => null)
  if (st === null) return { ...base, problem: FOLDER_MISSING }
  if (!st.isDirectory()) return { ...base, problem: FOLDER_IS_FILE }
  const g = await (d.guard ?? isGuarded)(abs, {
    owner: 'run',
    dimFactoryHome: d.home,
    ...(d.env !== undefined ? { env: d.env } : {}),
  })
  if (g.guarded) return { ...base, problem: guardProblem(g) }
  let repo: RepoInfo
  try {
    repo = await (d.detect ?? detectRepo)(abs)
  } catch (err) {
    if (isGitError(err) && err.kind === 'missing') return { ...base, problem: GIT_MISSING }
    return { ...base, problem: `Git could not read this folder: ${(err as Error).message}` }
  }
  if (repo.dubiousOwnership) return { ...base, problem: FOLDER_UNTRUSTED }
  if (!repo.isRepo || repo.toplevel === undefined) return { ...base, mode: 'needsUndo' }
  let head: string | null
  try {
    head = await (d.head ?? (async (top: string) => (await readHead(top)).commit))(repo.toplevel)
  } catch (err) {
    return { ...base, problem: `Git could not read this folder: ${(err as Error).message}` }
  }
  const mode: EasyFolderMode = head !== null ? 'isolated' : 'inPlace'
  if (mode !== 'isolated') return { ...base, mode }
  // The copy starts from the last commit: changes git has not saved yet would not be in it (the screen says so).
  const top = repo.toplevel
  const uncommitted = await (d.uncommitted ?? uncommittedCount)(top).catch(() => 0)
  return { ...base, mode, ...(uncommitted > 0 ? { uncommitted } : {}) }
}
