// `project.create` (New project, `dimf new`): check the folder, create it (missing parents too) or take an existing
// empty one, `git init` it through core/git (no shell, no commit: a commit would need the user's git identity), and
// answer the template's Brief, task and recipe for the run that builds the scaffold. Dim Factory never runs a create
// command and needs no network; the template's official command is only shown, for the user to run if they prefer.
//
// Folder rules: an absolute path that is new or an empty folder (OS clutter such as .DS_Store does not count). Refused:
// a non-empty folder, a drive or volume root, the home folder itself (or a folder holding it), system folders,
// anything inside DIM_FACTORY_HOME (the folder guard, as for runs), and a folder inside another git repository's work
// tree: the outer repository would list the new project as an embedded repository and its runs would snapshot the
// whole outer tree, so the project gets a folder of its own instead. Everything is checked before anything is created.
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { BriefInput } from '../../shared/brief.ts'
import type { ProjectCreated, Template } from '../../shared/templates.ts'
import { projectTask, templateBrief } from '../../shared/templates.ts'
import { DimFactoryError } from '../errors.ts'
import { isGitError } from '../git/exec.ts'
import { detectRepo } from '../git/repo.ts'
import type { RepoInfo } from '../git/repo.ts'
import { isGuarded } from '../preflight/guard.ts'
import type { GuardOptions, GuardResult } from '../preflight/guard.ts'
import { initRepository } from '../recovery/git-init.ts'
import type { GitInitDeps } from '../recovery/git-init.ts'

/** Files an otherwise empty folder may hold (the OS writes them on its own). */
export const IGNORABLE_ENTRIES: readonly string[] = ['.DS_Store', 'Thumbs.db', 'desktop.ini']

export const PICK_EMPTY = 'Pick an empty or new folder.'

/** What is at the chosen path. */
export type FolderState = { kind: 'missing' } | { kind: 'file' } | { kind: 'dir'; entries: readonly string[] }

/** The parts of a folder refusal the UI shows: one sentence of what is wrong, and what to do. */
export function folderProblem(
  folder: string,
  state: FolderState,
  guard: GuardResult,
  repoTop: string | null,
): string | null {
  if (guard.guarded) {
    switch (guard.reason) {
      case 'root':
        return `${folder} is a drive or volume root. Pick an empty or new folder inside it.`
      case 'home':
        return `${folder} is your home folder (or holds it). Pick an empty or new folder inside it.`
      case 'dimFactoryHome':
        return `${folder} is inside Dim Factory's own data folder. Pick a folder somewhere else.`
      case 'system':
      case 'gitDir':
      case undefined:
        return `${guard.detail} ${PICK_EMPTY}`
    }
  }
  if (state.kind === 'file') return `${folder} is a file. ${PICK_EMPTY}`
  if (state.kind === 'dir' && state.entries.some((e) => !IGNORABLE_ENTRIES.includes(e))) {
    return `${folder} is not empty. ${PICK_EMPTY}`
  }
  if (repoTop !== null) {
    return (
      `${folder} is inside the git repository at ${repoTop}. Pick a folder outside it, so the new project gets ` +
      'a repository of its own.'
    )
  }
  return null
}

async function folderState(abs: string): Promise<FolderState> {
  const st = await stat(abs).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (st === null) return { kind: 'missing' }
  if (!st.isDirectory()) return { kind: 'file' }
  return { kind: 'dir', entries: await readdir(abs) }
}

/** The nearest folder at or above `abs` that exists (null: none, e.g. a drive that is not there). */
async function nearestExisting(abs: string): Promise<string | null> {
  let cur = abs
  for (;;) {
    const st = await stat(cur).catch(() => null)
    if (st !== null) return st.isDirectory() ? cur : null
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

const gitMissing = (): DimFactoryError =>
  new DimFactoryError('GIT', 'Git was not found. Install git, then try again.', {
    details: { category: 'git_missing' },
  })

export interface CreateProjectDeps {
  /** DIM_FACTORY_HOME. */
  home: string
  /** `<home>/empty-hooks`. */
  emptyHooksDir: string
  env?: Readonly<Record<string, string | undefined>>
  /** Test seams. */
  guard?: (folder: string, o: GuardOptions) => Promise<GuardResult>
  detect?: (folder: string) => Promise<RepoInfo>
  init?: (folder: string, d: GitInitDeps) => Promise<void>
}

/**
 * Check `folder` for a new project, create it when it is missing and `git init` it. Throws VALIDATION with UI copy
 * for a folder it may not use (nothing is created then), GIT (`git_missing`) when git is not installed.
 */
export async function prepareProjectFolder(folder: string, d: CreateProjectDeps): Promise<string> {
  const trimmed = folder.trim()
  if (trimmed === '' || !path.isAbsolute(trimmed)) {
    throw new DimFactoryError('VALIDATION', 'Enter the full path of the new project folder.')
  }
  const abs = path.resolve(trimmed)
  const guard = await (d.guard ?? isGuarded)(abs, {
    owner: 'run',
    dimFactoryHome: d.home,
    ...(d.env !== undefined ? { env: d.env } : {}),
  })
  let state: FolderState
  try {
    state = await folderState(abs)
  } catch (err) {
    throw new DimFactoryError('VALIDATION', `${abs} cannot be read: ${(err as Error).message}`)
  }
  let repoTop: string | null = null
  if (!guard.guarded && state.kind !== 'file') {
    const probe = state.kind === 'dir' ? abs : await nearestExisting(path.dirname(abs))
    if (probe === null) {
      throw new DimFactoryError(
        'VALIDATION',
        `${abs} cannot be created here: its drive or volume is not there.`,
      )
    }
    let repo: RepoInfo
    try {
      repo = await (d.detect ?? detectRepo)(probe)
    } catch (err) {
      if (isGitError(err) && err.kind === 'missing') throw gitMissing()
      throw new DimFactoryError('GIT', `git could not read ${probe}: ${(err as Error).message}`)
    }
    if (repo.isRepo) repoTop = repo.toplevel ?? probe
  }
  const problem = folderProblem(abs, state, guard, repoTop)
  if (problem !== null) throw new DimFactoryError('VALIDATION', problem)

  let created: string | undefined
  if (state.kind === 'missing') {
    try {
      created = await mkdir(abs, { recursive: true })
    } catch (err) {
      throw new DimFactoryError('VALIDATION', `${abs} could not be created: ${(err as Error).message}`)
    }
  }
  try {
    await (d.init ?? initRepository)(abs, {
      dimFactoryHome: d.home,
      emptyHooksDir: d.emptyHooksDir,
      ...(d.env !== undefined ? { env: d.env } : {}),
    })
  } catch (err) {
    // A folder this call created goes again, so a failed create leaves nothing behind.
    if (created !== undefined) await rm(created, { recursive: true, force: true }).catch(() => undefined)
    if (err instanceof DimFactoryError && /spawn git ENOENT|git.*not found/i.test(err.message))
      throw gitMissing()
    throw err
  }
  return abs
}

/** What `project.create` answers for a template and the prepared folder. */
export function projectCreated(folder: string, t: Template, goal?: string): ProjectCreated {
  const brief: BriefInput = templateBrief(t)
  return {
    folder,
    template: { id: t.id, label: t.label },
    brief,
    task: projectTask(t, goal),
    recipe: t.recipe,
    ...(t.create !== undefined ? { create: t.create } : {}),
  }
}
