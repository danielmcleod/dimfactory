// Queue imports: the open items of a markdown TODO file, and a repository's open GitHub issues through the GitHub CLI.
// The gh import runs only when you click it: `gh --version` and `gh auth status` first (the check is never blocking,
// its fixes are copyable), then `gh issue list --json` in the folder (argv, no shell, no prompt, a time limit).
// Dim Factory never signs in to GitHub and never stores a token.
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { GITHUB_ISSUES_LIMIT, QUEUE_TASK_TEXT_MAX, parseTodo } from '../../shared/factory.ts'
import type { TodoItem } from '../../shared/factory.ts'
import type { GhStatus } from '../../shared/deploy.ts'
import { DimFactoryError } from '../errors.ts'
import { shellOf } from '../deploy/commands.ts'
import { ghStatus, runGh } from '../deploy/pr.ts'
import type { GhCommand } from '../deploy/pr.ts'

/** The TODO file a folder's import reads when none is named. */
export const DEFAULT_TODO_FILE = 'TODO.md'
/** A TODO file larger than this is refused (it is not a task list). */
export const TODO_FILE_MAX_BYTES = 1024 * 1024

/** The TODO file to read: `file` (relative to the folder, or absolute) or the folder's TODO.md. */
export function todoPath(folder: string, file: string | undefined): string {
  const f = file === undefined || file.trim() === '' ? DEFAULT_TODO_FILE : file.trim()
  return isAbsolute(f) ? resolve(f) : resolve(folder, f)
}

/** The open checkbox items of a TODO file. NOT_FOUND without the file, VALIDATION for a file too large. */
export async function readTodo(path: string): Promise<TodoItem[]> {
  const st = await stat(path).catch(() => null)
  if (st === null || !st.isFile()) throw new DimFactoryError('NOT_FOUND', `There is no file at ${path}.`)
  if (st.size > TODO_FILE_MAX_BYTES)
    throw new DimFactoryError('VALIDATION', `${path} is larger than 1 MB; pick a TODO list.`)
  return parseTodo(await readFile(path, 'utf8'))
}

/** How the TODO file is named in a task's source: relative to the folder when it is inside it. */
export function todoLabel(folder: string, path: string): string {
  const rel = relative(folder, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : path
}

// ---- GitHub issues --------------------------------------------------------------------------------------------------

export interface GithubIssue {
  number: number
  title: string
  body: string
  url?: string
}

/** The gh check for an import (installed, signed in; copyable fixes otherwise). */
export function githubCheck(
  gh: GhCommand | null,
  o: { cwd: string; env?: Readonly<Record<string, string | undefined>>; platform?: NodeJS.Platform },
): Promise<GhStatus> {
  const platform = o.platform ?? process.platform
  return ghStatus(gh, {
    cwd: o.cwd,
    shell: shellOf(platform),
    platform,
    ...(o.env !== undefined ? { env: o.env } : {}),
  })
}

/** An issue as a task: its title, its body, and where it came from. */
export function issueTask(i: GithubIssue): string {
  const head = `${i.title.trim()}\n\nGitHub issue #${i.number}${i.url !== undefined ? ` (${i.url})` : ''}.`
  const body = i.body.replace(/\r\n?/g, '\n').trim()
  const room = QUEUE_TASK_TEXT_MAX - head.length - 4
  const kept =
    body.length > room ? `${body.slice(0, Math.max(0, room - 40))}\n(The issue's text was cut here.)` : body
  return kept === '' ? head : `${head}\n\n${kept}`
}

/** Parse `gh issue list --json number,title,body,url` output (anything else is refused, never guessed at). */
export function parseIssues(stdout: string): GithubIssue[] {
  let v: unknown
  try {
    v = JSON.parse(stdout)
  } catch {
    throw new DimFactoryError('VALIDATION', 'gh did not answer with a list of issues.')
  }
  if (!Array.isArray(v)) throw new DimFactoryError('VALIDATION', 'gh did not answer with a list of issues.')
  const out: GithubIssue[] = []
  for (const x of v as unknown[]) {
    if (x === null || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const n = o['number']
    const title = o['title']
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n <= 0 ||
      typeof title !== 'string' ||
      title.trim() === ''
    )
      continue
    const body = typeof o['body'] === 'string' ? o['body'] : ''
    const url = typeof o['url'] === 'string' && /^https:\/\/\S+$/.test(o['url']) ? o['url'] : undefined
    out.push({ number: n, title, body, ...(url !== undefined ? { url } : {}) })
  }
  return out
}

/** The folder's open issues (`gh issue list`), oldest first. CONFLICT when gh is not ready, with its check's words. */
export async function listIssues(
  gh: GhCommand | null,
  o: { cwd: string; env?: Readonly<Record<string, string | undefined>>; platform?: NodeJS.Platform },
): Promise<{ issues: GithubIssue[]; gh: GhStatus }> {
  const status = await githubCheck(gh, o)
  if (gh === null || !status.installed || !status.authenticated) {
    throw new DimFactoryError('CONFLICT', status.problem ?? 'The GitHub CLI is not ready.', {
      details: { gh: status },
    })
  }
  const r = await runGh(
    gh,
    [
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      String(GITHUB_ISSUES_LIMIT),
      '--json',
      'number,title,body,url',
    ],
    { cwd: o.cwd, ...(o.env !== undefined ? { env: o.env } : {}) },
  )
  if (r.missing) throw new DimFactoryError('CONFLICT', 'The GitHub CLI (gh) is not installed.')
  if (r.code !== 0) {
    const why = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(0, 2).join(' ')
    throw new DimFactoryError('SPAWN', `gh could not list the issues${why !== '' ? `: ${why}` : '.'}`)
  }
  return { issues: parseIssues(r.stdout).sort((a, b) => a.number - b.number), gh: status }
}
