// The factory's commands: queue.* (task queues per folder, imports, start and pause, the launch notice, the daily
// report) and memory.* (project memory and its proposed updates). The GitHub import runs `gh` only from
// queue.importGithub, the user's click; queue.githubCheck reads `gh --version` and `gh auth status` only.
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { GithubCheckView } from '../shared/factory.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'
import type { GhCommand } from './deploy/pr.ts'
import type { FactoryService } from './factory/service.ts'
import type { MemoryService } from './factory/memory-service.ts'
import { githubCheck, issueTask, listIssues, readTodo, todoLabel, todoPath } from './factory/imports.ts'

/** What the factory commands need beyond the handler context (app-core.ts). */
export interface FactoryHost {
  service: FactoryService
  memory: MemoryService
  /** How to start gh (null: not installed). */
  gh(): Promise<GhCommand | null>
  env: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
}

const abs = (f: string): string => (isAbsolute(f) ? resolve(f) : resolve(f))

/** The folder exists (a queue is for a folder you can run in). */
async function folderOf(f: string): Promise<string> {
  const folder = abs(f)
  const st = await stat(folder).catch(() => null)
  if (st === null || !st.isDirectory())
    throw new DimFactoryError('VALIDATION', `There is no folder at ${folder}.`)
  return folder
}

function writable(ctx: HandlerContext): void {
  if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
}

export function factoryHandlers(ctx: HandlerContext, host: FactoryHost | undefined): HandlerMap {
  if (host === undefined) return {}
  const q = host.service
  const ghOpts = (cwd: string): Parameters<typeof githubCheck>[1] => ({
    cwd,
    env: host.env,
    ...(host.platform !== undefined ? { platform: host.platform } : {}),
  })
  return {
    'queue.get': () => q.viewWithEstimates(),
    'queue.add': async (req) => {
      writable(ctx)
      return q.add(
        await folderOf(req.folder),
        req.tasks.map((t) => ({ task: t.task, ...(t.recipe !== undefined ? { recipe: t.recipe } : {}) })),
      )
    },
    'queue.remove': (req) => {
      writable(ctx)
      return q.remove(abs(req.folder), req.id)
    },
    'queue.move': (req) => {
      writable(ctx)
      return q.move(abs(req.folder), req.id, req.to)
    },
    'queue.retry': (req) => {
      writable(ctx)
      return q.retry(abs(req.folder), req.id)
    },
    'queue.clear': (req) => {
      writable(ctx)
      return q.clearFinished(abs(req.folder))
    },
    'queue.importTodo': async (req) => {
      writable(ctx)
      const folder = await folderOf(req.folder)
      const path = todoPath(folder, req.file)
      const items = await readTodo(path)
      const label = todoLabel(folder, path)
      return q.importTasks(
        folder,
        label,
        items.map((i) => ({ task: i.text, source: { kind: 'todo', file: label, line: i.line } })),
      )
    },
    'queue.githubCheck': async (req): Promise<GithubCheckView> => {
      const folder = await folderOf(req.folder)
      return { gh: await githubCheck(await host.gh(), ghOpts(folder)) }
    },
    'queue.importGithub': async (req) => {
      writable(ctx)
      const folder = await folderOf(req.folder)
      const { issues } = await listIssues(await host.gh(), ghOpts(folder))
      return q.importTasks(
        folder,
        `the open GitHub issues of ${basename(folder)}`,
        issues.map((i) => ({
          task: issueTask(i),
          source: { kind: 'github', number: i.number, ...(i.url !== undefined ? { url: i.url } : {}) },
        })),
      )
    },
    'queue.start': (req) => {
      writable(ctx)
      return q.start(req.folders?.map(abs), req.noticeId !== undefined ? { noticeId: req.noticeId } : {})
    },
    'queue.pause': (req) => {
      writable(ctx)
      return q.pause(req.folders?.map(abs))
    },
    'queue.dismissNotice': (req) => {
      writable(ctx)
      return q.dismissNotice(req.id)
    },
    'queue.report': (req) => {
      writable(ctx)
      return q.report(req.date)
    },
    'memory.get': async (req) => host.memory.view(await folderOf(req.folder)),
    'memory.apply': (req) => {
      writable(ctx)
      return host.memory.apply(abs(req.folder), req.id)
    },
    'memory.dismiss': (req) => {
      writable(ctx)
      return host.memory.dismiss(abs(req.folder), req.id)
    },
  }
}
