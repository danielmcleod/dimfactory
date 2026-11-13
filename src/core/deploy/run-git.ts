// Commit and pull request for a finished run (opt-in per project: `git.commit`, `git.pullRequest`). Where the commit
// goes is the branch the run worked on: its run branch in the folder (isolation.branch runBranch), or its isolated
// copy's branch. A run that worked on the user's own branch is never committed. One commit and one pull request per
// run, recorded in runs/<id>/git.json. The plumbing that keeps the user's index safe is git/commit.ts; the push and
// `gh pr create` happen only from prCreate, whose request must repeat the repository and branch the confirmation card
// showed (a create for anything else is refused).
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CommitPreview,
  CommitResult,
  PrCreateRequest,
  PrPreview,
  PrResult,
} from '../../shared/deploy.ts'
import type { RunSummary } from '../../shared/run.ts'
import { DimFactoryError, errorMessage } from '../errors.ts'
import { readHead } from '../git/branch.ts'
import { commitRunChanges } from '../git/commit.ts'
import type { HomePaths } from '../home.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import type { RunDoc } from '../supervisor/controller.ts'
import { workFolderOf } from '../supervisor/controller.ts'
import { commitMessage, commitSubject, prBody } from './commit-message.ts'
import type { RunFacts } from './commit-message.ts'
import { shellOf } from './commands.ts'
import {
  createPr,
  ghStatus,
  githubRepoOf,
  plainBranch,
  prCommands,
  remoteDefaultBranch,
  remoteUrl,
} from './pr.ts'
import type { GhCommand } from './pr.ts'

/** runs/<id>/git.json: what this run committed and opened. */
export interface RunGitRecord {
  commit?: { sha: string; branch: string; at: number; paths: number }
  pr?: { url: string; at: number }
}

export interface GitSettingsNow {
  commit: boolean
  pullRequest: boolean
  remote: string
}

export interface RunGitDeps {
  paths: HomePaths
  readDoc(runId: string): Promise<RunDoc | null>
  summarize(doc: RunDoc): RunSummary
  /** Why the run's folder is busy now (another run works there), as UI copy; undefined when it is free. */
  busy(doc: RunDoc): string | undefined
  /** The project's git settings now (the resolved config for the run's folder). */
  settings(folder: string): Promise<GitSettingsNow>
  /**
   * The run's changed paths (relative to the repository root, from its run base to its last result snapshot), and
   * those of them the folder changed since that snapshot. Null when the snapshots are gone.
   */
  changes(doc: RunDoc): Promise<{ paths: string[]; since: string[] } | null>
  /** An empty hooks folder (no hook of the user's runs). */
  hooksPath: string
  /** How to start gh (null: not installed). */
  gh(): Promise<GhCommand | null>
  platform?: NodeJS.Platform
  now(): number
  env?: Readonly<Record<string, string | undefined>>
}

const gitFile = (paths: HomePaths, runId: string): string => join(paths.run(runId).dir, 'git.json')
const prBodyFile = (paths: HomePaths, runId: string): string => join(paths.run(runId).dir, 'pr-body.md')

export async function readRunGit(paths: HomePaths, runId: string): Promise<RunGitRecord> {
  try {
    const v: unknown = JSON.parse(await readFile(gitFile(paths, runId), 'utf8'))
    if (v === null || typeof v !== 'object') return {}
    const o = v as Record<string, unknown>
    const out: RunGitRecord = {}
    const c = o['commit'] as RunGitRecord['commit'] | undefined
    if (c !== undefined && typeof c.sha === 'string' && typeof c.branch === 'string') out.commit = c
    const p = o['pr'] as RunGitRecord['pr'] | undefined
    if (p !== undefined && typeof p.url === 'string') out.pr = p
    return out
  } catch {
    return {}
  }
}

async function writeRunGit(paths: HomePaths, runId: string, rec: RunGitRecord): Promise<void> {
  await writeFileAtomic(gitFile(paths, runId), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 })
}

interface Where {
  where: 'run-branch' | 'worktree'
  branch: string
  /** A folder in the working tree the commit is made in. */
  folder: string
  /** The branch a pull request goes into, when known (the run branch's previous branch). */
  base: string | null
}

/** Where a commit of this run would go, or why it cannot go anywhere (UI copy). */
export function commitWhere(doc: RunDoc): Where | { blocked: string } {
  const s = doc.state
  const wt = s.isolation?.worktree
  if (wt !== undefined) {
    const fin = s.isolation?.finalize?.state
    if (fin === 'discarded' || fin === 'discarding' || !existsSync(wt.path))
      return { blocked: "The run's isolated copy was discarded, so there is no branch to commit on." }
    return {
      where: 'worktree',
      branch: wt.branch,
      folder: workFolderOf(doc.scope.folder, s.isolation),
      base: null,
    }
  }
  const b = s.branch
  if (b !== undefined) {
    const prev = b.previous.startsWith('refs/heads/') ? b.previous.slice('refs/heads/'.length) : null
    return { where: 'run-branch', branch: b.name, folder: doc.scope.folder, base: prev }
  }
  return {
    blocked:
      'This run worked on your own branch. Dim Factory commits only a run that used a run branch or an isolated copy (Settings, Isolation), so it never commits on a branch you work on.',
  }
}

/** The facts a commit message and a pull request describe. */
export function runFacts(doc: RunDoc, summary: RunSummary, files: number): RunFacts {
  const s = doc.state
  const d = s.deploy
  return {
    displayNo: s.displayNo,
    title: s.title,
    task: s.task,
    ...(s.outcome !== undefined ? { outcome: s.outcome } : {}),
    findings: summary.findings,
    steps: summary.steps,
    files,
    ...(d?.written !== undefined && d.written.length > 0
      ? {
          deploy: {
            ...(d.plan?.target !== undefined && d.plan.target !== null
              ? { target: d.plan.target.label }
              : {}),
            written: d.written,
          },
        }
      : {}),
    ...((): Pick<RunFacts, 'verify'> => {
      const v = s.steps['verify:2'].verify ?? s.steps['verify:1'].verify
      return v !== undefined ? { verify: v.commands.map((c) => ({ name: c.name, status: c.status })) } : {}
    })(),
  }
}

async function loadDoc(deps: RunGitDeps, runId: string): Promise<RunDoc> {
  const doc = await deps.readDoc(runId)
  if (doc === null) throw new DimFactoryError('NOT_FOUND', `Run ${runId} not found.`)
  return doc
}

/** git.commitPreview. */
export async function commitPreview(deps: RunGitDeps, runId: string): Promise<CommitPreview> {
  const doc = await loadDoc(deps, runId)
  const settings = await deps.settings(doc.scope.folder)
  const rec = await readRunGit(deps.paths, runId)
  const summary = deps.summarize(doc)
  const base: CommitPreview = {
    runId,
    enabled: settings.commit,
    where: null,
    branch: null,
    paths: [],
    message: '',
    ...(rec.commit !== undefined
      ? { committed: { sha: rec.commit.sha, branch: rec.commit.branch, at: rec.commit.at } }
      : {}),
  }
  if (!settings.commit)
    return {
      ...base,
      blocked: "Commit is off for this project. Turn it on in Settings (Deploy), in the project's settings.",
    }
  const w = commitWhere(doc)
  if ('blocked' in w) return { ...base, blocked: w.blocked }
  const at = { ...base, where: w.where, branch: w.branch }
  if (summary.status !== 'completed') return { ...at, blocked: 'The run has not finished.' }
  if (rec.commit !== undefined)
    return { ...at, blocked: `This run's changes were committed already (${rec.commit.sha.slice(0, 7)}).` }
  const busy = deps.busy(doc)
  if (busy !== undefined) return { ...at, blocked: busy }
  const ch = await deps.changes(doc)
  if (ch === null)
    return {
      ...at,
      blocked: "This run's snapshots were cleared, so Dim Factory cannot tell which files are its own.",
    }
  const message = commitMessage(runFacts(doc, summary, ch.paths.length))
  if (ch.paths.length === 0) return { ...at, message, blocked: 'The run changed no files.' }
  const out: CommitPreview = { ...at, paths: ch.paths, message }
  if (ch.since.length > 0) {
    out.blocked = `${ch.since.length === 1 ? 'A file' : `${ch.since.length} files`} the run changed ${ch.since.length === 1 ? 'was' : 'were'} edited after it ended (${ch.since.slice(0, 5).join(', ')}${ch.since.length > 5 ? ', ...' : ''}). Commit them yourself, so the commit holds what you meant.`
  }
  return out
}

/** git.commit: the preview's checks again, then the commit (git/commit.ts). */
export async function commitRun(deps: RunGitDeps, runId: string, message?: string): Promise<CommitResult> {
  const p = await commitPreview(deps, runId)
  if (p.blocked !== undefined) throw new DimFactoryError(p.enabled ? 'CONFLICT' : 'FORBIDDEN', p.blocked)
  const doc = await loadDoc(deps, runId)
  const w = commitWhere(doc)
  if ('blocked' in w) throw new DimFactoryError('CONFLICT', w.blocked)
  const text = message !== undefined && message.trim() !== '' ? message : p.message
  let r
  try {
    r = await commitRunChanges({
      folder: w.folder,
      branch: w.branch,
      paths: p.paths,
      message: text,
      hooksPath: deps.hooksPath,
    })
  } catch (err) {
    throw new DimFactoryError('GIT', `git could not make the commit: ${errorMessage(err)}`)
  }
  if (!r.ok) throw new DimFactoryError('CONFLICT', r.reason, { details: { commands: r.commands } })
  const rec = await readRunGit(deps.paths, runId)
  rec.commit = { sha: r.sha, branch: r.branch, at: deps.now(), paths: r.paths.length }
  await writeRunGit(deps.paths, runId, rec)
  return { sha: r.sha, branch: r.branch, paths: r.paths, notes: r.notes }
}

/** git.prPreview: the remote, repository, branch, text, copyable commands and the gh check. */
export async function prPreview(deps: RunGitDeps, runId: string): Promise<PrPreview> {
  const doc = await loadDoc(deps, runId)
  const settings = await deps.settings(doc.scope.folder)
  const rec = await readRunGit(deps.paths, runId)
  const summary = deps.summarize(doc)
  const platform = deps.platform ?? process.platform
  const shell = shellOf(platform)
  const w = commitWhere(doc)
  const branch = 'blocked' in w ? null : w.branch
  const folder = 'blocked' in w ? doc.scope.folder : w.folder
  const facts = runFacts(doc, summary, rec.commit?.paths ?? summary.progress.filesChanged)
  const title = commitSubject(doc.state.title, doc.state.displayNo)
  const body = prBody(facts)
  const url = await remoteUrl(folder, settings.remote).catch(() => null)
  const repo = url !== null ? githubRepoOf(url) : null
  let base = 'blocked' in w ? null : w.base
  if (base === null) {
    // An isolated copy's branch starts from the folder's branch; else the remote's default branch.
    const head = await readHead(doc.scope.folder).catch(() => null)
    const own = head?.ref?.startsWith('refs/heads/') === true ? head.ref.slice('refs/heads/'.length) : null
    base =
      (own !== null && own !== branch ? own : null) ??
      (await remoteDefaultBranch(folder, settings.remote).catch(() => null))
  }
  const bodyFile = prBodyFile(deps.paths, runId)
  await writeFileAtomic(bodyFile, body, { mode: 0o600 })
  const gh = await ghStatus(await deps.gh(), {
    cwd: folder,
    shell,
    platform,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  })
  const out: PrPreview = {
    runId,
    enabled: settings.pullRequest,
    remote: url !== null ? settings.remote : null,
    remoteUrl: url,
    repo,
    branch,
    base,
    title,
    body,
    commands:
      branch !== null && plainBranch(branch)
        ? prCommands({ remote: settings.remote, branch, base, title, bodyFile, shell })
        : [],
    gh,
    ...(rec.pr !== undefined ? { opened: { url: rec.pr.url, at: rec.pr.at } } : {}),
  }
  const blocked = ((): string | undefined => {
    if (!settings.pullRequest)
      return "Pull requests are off for this project. Turn them on in Settings (Deploy), in the project's settings."
    if ('blocked' in w) return w.blocked
    if (summary.status !== 'completed') return 'The run has not finished.'
    if (rec.pr !== undefined) return 'This run opened its pull request already.'
    if (rec.commit === undefined) return "Commit the run's changes first (Commit to run branch)."
    if (branch === null || !plainBranch(branch))
      return 'The branch name cannot be pushed safely from Dim Factory.'
    if (url === null)
      return `There is no remote named ${settings.remote}. Add one (git remote add ${settings.remote} <url>), or name another remote in Settings.`
    if (repo === null)
      return `The remote ${settings.remote} is not on GitHub, so gh cannot open the pull request. Push the branch and open it on your host.`
    if (!gh.installed || !gh.authenticated) return gh.problem ?? 'The GitHub CLI is not ready.'
    return deps.busy(doc)
  })()
  if (blocked !== undefined) out.blocked = blocked
  return out
}

/**
 * git.prCreate: only with a confirmation that names exactly the remote, repository and branch the preview shows now;
 * then push and `gh pr create` (argv, no shell). Never pushes otherwise.
 */
export async function prCreate(deps: RunGitDeps, req: PrCreateRequest): Promise<PrResult> {
  const p = await prPreview(deps, req.runId)
  if (p.blocked !== undefined) throw new DimFactoryError(p.enabled ? 'CONFLICT' : 'FORBIDDEN', p.blocked)
  if (p.remote !== req.confirm.remote || p.repo !== req.confirm.repo || p.branch !== req.confirm.branch) {
    throw new DimFactoryError(
      'CONFLICT',
      'The repository or branch changed since you confirmed. Check the pull request card again; nothing was pushed.',
    )
  }
  const doc = await loadDoc(deps, req.runId)
  const w = commitWhere(doc)
  if ('blocked' in w) throw new DimFactoryError('CONFLICT', w.blocked)
  const gh = await deps.gh()
  if (gh === null) throw new DimFactoryError('CONFLICT', 'The GitHub CLI (gh) is not installed.')
  let made: { url: string; notes: string[] }
  try {
    made = await createPr({
      root: w.folder,
      remote: req.confirm.remote,
      branch: req.confirm.branch,
      base: p.base,
      title: p.title,
      bodyFile: prBodyFile(deps.paths, req.runId),
      gh,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
    })
  } catch (err) {
    throw new DimFactoryError('GIT', errorMessage(err))
  }
  const rec = await readRunGit(deps.paths, req.runId)
  rec.pr = { url: made.url, at: deps.now() }
  await writeRunGit(deps.paths, req.runId, rec)
  return { url: made.url, pushed: true, notes: made.notes }
}
