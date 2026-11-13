// `dimf queue …`: the factory's task queues from the command line (the same queue.* commands as the app).
//   dimf queue [list] [--folder <dir>] [--json]       every queue (read-only: works while the app is open)
//   dimf queue add <folder> <task> [--recipe <id>]     queue a task
//   dimf queue remove|retry <folder> <task-id>
//   dimf queue move <folder> <task-id> <position>      position 1 is the top
//   dimf queue import-todo <folder> [--file <f>]       the open `- [ ]` items of TODO.md (or <f>)
//   dimf queue import-gh <folder>                      the folder's open GitHub issues (gh issue list)
//   dimf queue run [<folder>…]                         start the queues and follow them until they stop
//   dimf queue pause [<folder>…]
//   dimf queue report [--date YYYY-MM-DD] [--json]     the daily report (also written to <home>/reports/)
// Every command but list takes the home lock (exit 6 while the app is open). `run` exits 0 when every task it saw
// is done, 1 when one failed, 5 when a queue paused or a task needs you (its reason is printed), 130 on Ctrl+C (the
// queues pause; runs working stop as at quit, paused, and never resume on their own).
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { FolderQueueView, QueueTask, QueueView } from '../../shared/factory.ts'
import { QUEUE_STOP_CATEGORY_LABEL, QUEUE_TASK_STATUS_LABEL } from '../../shared/factory.ts'
import type { Result } from '../../shared/ipc.ts'
import { UsageError } from '../args.ts'
import type { CliIo } from '../io.ts'
import { EXIT, cliName, usage, withReadOnlyCore, withWritableCore } from '../session.ts'

export const QUEUE_USAGE =
  'dimf queue [list|add|remove|move|retry|import-todo|import-gh|run|pause|report] … [--home dir]'

const usd = (v: number | null | undefined): string =>
  v === null || v === undefined ? 'no price' : v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`

function taskLine(t: QueueTask, i: number): string {
  const run = t.displayNo !== undefined ? ` · run #${t.displayNo}` : ''
  const cost = t.costUsd !== undefined ? ` · ${usd(t.costUsd)}` : ''
  const cat =
    t.category === 'budget_exceeded' || t.category === 'time_limit'
      ? ` · ${QUEUE_STOP_CATEGORY_LABEL[t.category]}`
      : ''
  const recipe = t.recipe !== undefined ? ` · recipe ${t.recipe}` : ''
  const head = `  ${String(i + 1).padStart(2)}. [${QUEUE_TASK_STATUS_LABEL[t.status]}] ${t.title}${recipe}${run}${cost}${cat}  (${t.id})`
  return t.reason !== undefined ? `${head}\n      ${t.reason}` : head
}

const STATE_WORDS = { idle: 'Not running', running: 'Running', paused: 'Paused' } as const

/** A queue as lines: its folder and state (with a pause's reason), then its tasks. */
export function queueLines(f: FolderQueueView): string[] {
  const out = [`${f.folder}  ${STATE_WORDS[f.state]}${f.scheduled === true ? ' (by the schedule)' : ''}`]
  if (f.pause !== undefined && f.state === 'paused') out.push(`  ${f.pause.text}`)
  if (f.tasks.length === 0) out.push('  No tasks.')
  f.tasks.forEach((t, i) => out.push(taskLine(t, i)))
  if (f.estimateUsd !== undefined && f.counts.pending > 0)
    out.push(`  Pending tasks: about ${usd(f.estimateUsd)} (estimate).`)
  return out
}

export function viewLines(v: QueueView, folder?: string): string[] {
  const folders = folder === undefined ? v.folders : v.folders.filter((f) => samePath(f.folder, folder))
  const out: string[] = []
  if (v.notice !== undefined) out.push(`Notice: ${v.notice.text}`, '')
  if (folders.length === 0) out.push(folder === undefined ? 'No queues yet.' : `No queue for ${folder}.`)
  for (const f of folders) out.push(...queueLines(f), '')
  const l = v.limits
  out.push(
    `Today: ${usd(v.today.spentUsd)} spent over ${v.today.runs} ${v.today.runs === 1 ? 'run' : 'runs'}` +
      (l.maxCostPerDayUsd !== null ? ` (budget ${usd(l.maxCostPerDayUsd)})` : ' (no daily budget)') +
      '.',
  )
  return out
}

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

function check<T>(io: CliIo, r: Result<T>, what: string): T | number {
  if (r.ok) return r.value
  io.err(`dimf queue ${what}: ${r.error.message}`)
  return r.error.code === 'VALIDATION' || r.error.code === 'NOT_FOUND' ? EXIT.usage : EXIT.failed
}

export async function queueCommand(args: readonly string[], io: CliIo): Promise<number> {
  const sub = args[0] !== undefined && !args[0].startsWith('-') ? args[0] : 'list'
  const rest = args[0] === sub ? args.slice(1) : args
  let v: Record<string, string | boolean | undefined>
  let pos: string[]
  try {
    const parsed = parseArgs({
      args: [...rest],
      options: {
        folder: { type: 'string' },
        recipe: { type: 'string' },
        file: { type: 'string' },
        date: { type: 'string' },
        json: { type: 'boolean', default: false },
        home: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    v = parsed.values
    pos = parsed.positionals
    const need = (n: number, what: string): void => {
      if (pos.length < n) throw new UsageError(`${sub} needs ${what}`)
    }
    if (['add'].includes(sub)) need(2, '<folder> <task>')
    if (['remove', 'retry'].includes(sub)) need(2, '<folder> <task-id>')
    if (sub === 'move') need(3, '<folder> <task-id> <position>')
    if (['import-todo', 'import-gh'].includes(sub)) need(1, '<folder>')
    if (
      ![
        'list',
        'add',
        'remove',
        'move',
        'retry',
        'import-todo',
        'import-gh',
        'run',
        'pause',
        'report',
      ].includes(sub)
    )
      throw new UsageError(`unknown subcommand "${sub}"`)
  } catch (err) {
    return usage(io, 'queue', QUEUE_USAGE, err)
  }
  const home = typeof v['home'] === 'string' ? v['home'] : undefined
  const json = v['json'] === true
  const abs = (p: string): string => resolve(io.cwd, p)

  if (sub === 'list') {
    const folder = typeof v['folder'] === 'string' ? abs(v['folder']) : undefined
    return withReadOnlyCore(
      io,
      home,
      async (core) => {
        const r = check(io, await core.invoke('queue.get'), 'list')
        if (typeof r === 'number') return r
        if (json) io.out(JSON.stringify(r, null, 2))
        else for (const l of viewLines(r, folder)) io.out(l)
        return EXIT.completed
      },
      { configBanner: false },
    )
  }

  return withWritableCore(
    io,
    home,
    async (core) => {
      const show = (r: QueueView | number, folder?: string): number => {
        if (typeof r === 'number') return r
        if (json) io.out(JSON.stringify(r, null, 2))
        else for (const l of viewLines(r, folder)) io.out(l)
        return EXIT.completed
      }
      const folder = pos[0] !== undefined ? abs(pos[0]) : undefined
      switch (sub) {
        case 'add': {
          const recipe = typeof v['recipe'] === 'string' ? v['recipe'] : undefined
          const r = check(
            io,
            await core.invoke('queue.add', {
              folder: folder ?? '',
              tasks: [{ task: pos.slice(1).join(' '), ...(recipe !== undefined ? { recipe } : {}) }],
            }),
            'add',
          )
          return show(r, folder)
        }
        case 'remove':
        case 'retry': {
          const r = check(
            io,
            await core.invoke(sub === 'remove' ? 'queue.remove' : 'queue.retry', {
              folder: folder ?? '',
              id: pos[1] ?? '',
            }),
            sub,
          )
          return show(r, folder)
        }
        case 'move': {
          const to = Number(pos[2])
          if (!Number.isInteger(to) || to < 1)
            return usage(io, 'queue', QUEUE_USAGE, new UsageError('position is 1 or more'))
          return show(
            check(
              io,
              await core.invoke('queue.move', { folder: folder ?? '', id: pos[1] ?? '', to: to - 1 }),
              'move',
            ),
            folder,
          )
        }
        case 'import-todo':
        case 'import-gh': {
          if (sub === 'import-gh') {
            const c = check(io, await core.invoke('queue.githubCheck', { folder: folder ?? '' }), sub)
            if (typeof c === 'number') return c
            if (!c.gh.installed || !c.gh.authenticated) {
              io.err(c.gh.problem ?? 'The GitHub CLI is not ready.')
              for (const f of c.gh.fixes)
                io.err(`  ${f.label}${f.command !== undefined ? `: ${f.command}` : ''}`)
              return EXIT.failed
            }
          }
          const file = typeof v['file'] === 'string' ? v['file'] : undefined
          const r = check(
            io,
            sub === 'import-todo'
              ? await core.invoke('queue.importTodo', {
                  folder: folder ?? '',
                  ...(file !== undefined ? { file } : {}),
                })
              : await core.invoke('queue.importGithub', { folder: folder ?? '' }),
            sub,
          )
          if (typeof r === 'number') return r
          io.out(
            `Added ${r.added} ${r.added === 1 ? 'task' : 'tasks'} from ${r.from}` +
              (r.skipped > 0 ? `; ${r.skipped} already queued` : '') +
              (r.overLimit > 0 ? `; ${r.overLimit} left out (the queue or the import is full)` : '') +
              '.',
          )
          return EXIT.completed
        }
        case 'pause':
          return show(
            check(
              io,
              await core.invoke('queue.pause', pos.length > 0 ? { folders: pos.map(abs) } : {}),
              'pause',
            ),
          )
        case 'report': {
          const date = typeof v['date'] === 'string' ? v['date'] : undefined
          const r = check(io, await core.invoke('queue.report', date !== undefined ? { date } : {}), 'report')
          if (typeof r === 'number') return r
          if (json) io.out(JSON.stringify(r, null, 2))
          else {
            for (const l of r.markdown.replace(/\n$/, '').split('\n')) io.out(l)
            io.out('')
            io.out(`Written to ${r.file}`)
          }
          return EXIT.completed
        }
        case 'run':
          return runQueues(io, core, pos.map(abs))
        default:
          return EXIT.usage
      }
    },
    { configBanner: sub === 'run' },
  )
}

type CliCore = Parameters<Parameters<typeof withWritableCore>[2]>[0]

/** Start the queues and print each task as it moves, until every one has stopped (or Ctrl+C). */
async function runQueues(io: CliIo, core: CliCore, folders: string[]): Promise<number> {
  const seen = new Map<string, string>()
  const pausesSeen = new Set<string>()
  let failed = false
  let resolveDone: (code: number) => void = () => undefined
  const done = new Promise<number>((r) => (resolveDone = r))
  const mine = (v: QueueView): FolderQueueView[] =>
    folders.length === 0 ? v.folders : v.folders.filter((f) => folders.some((x) => samePath(x, f.folder)))
  let started = false
  const look = (v: QueueView): void => {
    for (const f of mine(v)) {
      for (const t of f.tasks) {
        const key = `${t.status}|${t.runId ?? ''}`
        if (seen.get(t.id) === key) continue
        const first = !seen.has(t.id)
        seen.set(t.id, key)
        if (first && t.status === 'pending') continue
        if (t.status === 'failed' || t.status === 'stopped') failed = true
        io.out(taskLine(t, f.tasks.indexOf(t)).replace(/^ {2}/, ''))
      }
      if (f.state === 'paused' && f.pause !== undefined && !pausesSeen.has(`${f.folder}|${f.pause.at}`)) {
        pausesSeen.add(`${f.folder}|${f.pause.at}`)
        io.out(`Queue paused (${f.folder}): ${f.pause.text}`)
      }
    }
    if (!started) return
    const list = mine(v)
    const busy = list.some(
      (f) => f.state === 'running' && f.tasks.some((t) => t.status === 'pending' || t.status === 'running'),
    )
    const waiting = list.some((f) => f.tasks.some((t) => t.status === 'waiting'))
    if (busy && !waiting) return
    if (list.some((f) => f.state === 'paused') || waiting) {
      if (waiting)
        io.out(
          `A task needs you. Answer it in the app, or with ${cliName(io)} resume <run>, then run the queue again.`,
        )
      resolveDone(EXIT.paused)
    } else resolveDone(failed ? EXIT.failed : EXIT.completed)
  }
  const detach = core.bus.attach({
    name: 'cli-queue',
    global: (ev) => {
      if (ev.kind === 'queue') look(ev.view)
    },
  })
  const offInt = io.onInterrupt(() => {
    io.err('Stopping: the queues pause; runs working now stop as at quit and wait for you.')
    void core
      .invoke('queue.pause', folders.length > 0 ? { folders } : {})
      .finally(() => resolveDone(EXIT.hardInterrupt))
  })
  try {
    const r = await core.invoke('queue.start', folders.length > 0 ? { folders } : {})
    if (!r.ok) {
      io.err(`dimf queue run: ${r.error.message}`)
      return r.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
    }
    if (mine(r.value).length === 0) {
      io.out('No queue has tasks to run.')
      return EXIT.completed
    }
    started = true
    look(r.value)
    return await done
  } finally {
    offInt()
    detach()
    await core.factory?.settled().catch(() => undefined)
  }
}
