// Queue (`#/queue`): the factory. From the top: what the queues run under (the limits, today's spending, the schedule;
// Settings, Factory changes them), adding tasks to a folder's queue (typed, from a markdown TODO file, or from the
// folder's open GitHub issues: the GitHub CLI runs only on the clicks here, its check first, never blocking, with
// fixes to copy), the daily report on demand, and each folder's queue (FolderQueue.tsx), last, so a queue that core
// lists after the first paint moves nothing above it. Every other section is there from the first paint and fills
// in place.
import { CircleDot, FileText, FolderOpen, ListPlus, ScrollText, Search } from 'lucide-react'
import { useState } from 'react'
import type { DailyReportView, GithubCheckView, QueueImportResult } from '@shared/factory.ts'
import { CopyCommands } from '../../components/recovery/CopyCommands.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { Textarea } from '../../components/ui/Textarea.tsx'
import { invoke } from '../../ipc/client.ts'
import { formatUsd } from '../../lib/format.ts'
import { href } from '../../lib/router.ts'
import { setQueueView, useQueueStore, useQueueView } from '../../state/queue.ts'
import { toast } from '../../state/toasts.ts'
import { FolderQueue } from './FolderQueue.tsx'
import {
  ADD_LABEL,
  GH_CHECK_LABEL,
  GH_IMPORT_LABEL,
  IMPORT_TODO_LABEL,
  NO_RECIPE,
  QUEUE_PAGE_INTRO,
  QUEUE_PAGE_TITLE,
  REPORT_LABEL,
  limitsLines,
  scheduleText,
  todayText,
} from './text.ts'

export function importText(r: QueueImportResult): string {
  return (
    `Added ${r.added} ${r.added === 1 ? 'task' : 'tasks'} from ${r.from}` +
    (r.skipped > 0 ? `; ${r.skipped} already in the queue` : '') +
    (r.overLimit > 0 ? `; ${r.overLimit} left out because the queue or the import is full` : '') +
    '.'
  )
}

function Summary(): React.JSX.Element {
  const view = useQueueStore((s) => s.view)
  const error = useQueueStore((s) => s.error)
  return (
    <section
      aria-label="Limits and schedule"
      data-testid="queue-summary"
      className="flex flex-col gap-1 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Limits and schedule</h2>
        <a
          href={href({ name: 'settings', section: 'factory' })}
          data-testid="queue-settings-link"
          className="text-xs underline underline-offset-2"
        >
          Change in Settings, Factory
        </a>
      </div>
      {error !== null && view === null && (
        <p role="alert" className="text-sm text-destructive">
          The queues could not be read: {error}
        </p>
      )}
      <p data-testid="queue-today" className="min-h-5 text-sm">
        {view !== null ? todayText(view.today, view.limits) : ''}
      </p>
      <p data-testid="queue-schedule" className="min-h-4 text-xs text-muted-foreground">
        {view !== null ? scheduleText(view.schedule) : ''}
      </p>
      <ul data-testid="queue-limits" className="flex min-h-16 flex-col text-xs text-muted-foreground">
        {(view !== null ? limitsLines(view.limits) : []).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  )
}

function AddTasks({
  folder,
  setFolder,
}: {
  folder: string
  setFolder: (f: string) => void
}): React.JSX.Element {
  const [task, setTask] = useState('')
  const [recipe, setRecipe] = useState(NO_RECIPE)
  const [recipes, setRecipes] = useState<{ id: string; label: string }[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [todoFile, setTodoFile] = useState('')
  const [gh, setGh] = useState<GithubCheckView | null>(null)
  const f = folder.trim()

  const loadRecipes = async (): Promise<void> => {
    if (recipes.length > 0) return
    const r = await invoke('recipes.list', f !== '' ? { folder: f } : {})
    if (r.ok) setRecipes(r.value.recipes.map((v) => ({ id: v.recipe.id, label: v.recipe.label })))
  }
  const choose = async (): Promise<void> => {
    const r = await invoke('dialog.pickFolder', f !== '' ? { defaultPath: f } : {})
    if (r.ok && r.value !== null) setFolder(r.value)
  }
  const add = async (): Promise<void> => {
    setBusy('add')
    const r = await invoke('queue.add', {
      folder: f,
      tasks: [{ task: task.trim(), ...(recipe !== NO_RECIPE ? { recipe } : {}) }],
    })
    setBusy(null)
    if (!r.ok) {
      setNote(r.error.message)
      return
    }
    setQueueView(r.value)
    setTask('')
    setNote('Added to the queue.')
  }
  const importTodo = async (): Promise<void> => {
    setBusy('todo')
    const r = await invoke('queue.importTodo', {
      folder: f,
      ...(todoFile.trim() !== '' ? { file: todoFile.trim() } : {}),
    })
    setBusy(null)
    setNote(r.ok ? importText(r.value) : r.error.message)
  }
  const checkGh = async (): Promise<void> => {
    setBusy('gh-check')
    const r = await invoke('queue.githubCheck', { folder: f })
    setBusy(null)
    if (r.ok) setGh(r.value)
    else setNote(r.error.message)
  }
  const importGh = async (): Promise<void> => {
    setBusy('gh-import')
    const r = await invoke('queue.importGithub', { folder: f })
    setBusy(null)
    setNote(r.ok ? importText(r.value) : r.error.message)
  }
  const ready = gh !== null && gh.gh.installed && gh.gh.authenticated
  const commands = (gh?.gh.fixes ?? []).flatMap((x) => (x.command !== undefined ? [x.command] : []))
  return (
    <section
      aria-label="Add tasks"
      data-testid="queue-add"
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <h2 className="text-sm font-semibold">Add tasks</h2>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="queue-folder" className="sr-only">
          Folder
        </label>
        <Input
          id="queue-folder"
          data-testid="queue-folder-input"
          placeholder="Folder the tasks run in"
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value)
            setGh(null)
          }}
          className="min-w-48 flex-1 font-mono text-xs"
        />
        <Button
          variant="outline"
          icon={<FolderOpen aria-hidden />}
          data-testid="queue-folder-choose"
          onClick={() => void choose()}
        >
          Choose folder…
        </Button>
      </div>
      <label htmlFor="queue-task" className="sr-only">
        Task
      </label>
      <Textarea
        id="queue-task"
        data-testid="queue-task-input"
        data-scroll-region="task-input"
        placeholder="What should this task do?"
        rows={3}
        value={task}
        onChange={(e) => setTask(e.target.value)}
        className="max-h-40 resize-none text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="queue-recipe" className="text-xs text-muted-foreground">
          Recipe
        </label>
        <select
          id="queue-recipe"
          data-testid="queue-recipe"
          value={recipe}
          onFocus={() => void loadRecipes()}
          onChange={(e) => setRecipe(e.target.value)}
          className="h-8 w-48 rounded-md border bg-background px-2 text-xs"
        >
          <option value={NO_RECIPE}>None</option>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <Button
          data-testid="queue-add-button"
          icon={<ListPlus aria-hidden />}
          loading={busy === 'add'}
          disabled={f === '' || task.trim() === '' || (busy !== null && busy !== 'add')}
          onClick={() => void add()}
        >
          {ADD_LABEL}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-2">
        <label htmlFor="queue-todo-file" className="sr-only">
          TODO file
        </label>
        <Input
          id="queue-todo-file"
          data-testid="queue-todo-file"
          placeholder="TODO.md"
          value={todoFile}
          onChange={(e) => setTodoFile(e.target.value)}
          className="w-48 font-mono text-xs"
        />
        <Button
          variant="outline"
          data-testid="queue-import-todo"
          icon={<FileText aria-hidden />}
          loading={busy === 'todo'}
          disabled={f === '' || (busy !== null && busy !== 'todo')}
          onClick={() => void importTodo()}
        >
          {IMPORT_TODO_LABEL}
        </Button>
        <span className="text-xs text-muted-foreground">The open `- [ ]` items, in order.</span>
      </div>
      <div className="flex flex-col gap-2 border-t pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            data-testid="queue-gh-check"
            icon={<Search aria-hidden />}
            loading={busy === 'gh-check'}
            disabled={f === '' || (busy !== null && busy !== 'gh-check')}
            onClick={() => void checkGh()}
          >
            {GH_CHECK_LABEL}
          </Button>
          <Button
            variant="outline"
            data-testid="queue-gh-import"
            icon={<CircleDot aria-hidden />}
            loading={busy === 'gh-import'}
            disabled={!ready || f === '' || (busy !== null && busy !== 'gh-import')}
            onClick={() => void importGh()}
          >
            {GH_IMPORT_LABEL}
          </Button>
          <span className="text-xs text-muted-foreground">
            The folder&apos;s open issues, through the GitHub CLI. Nothing runs until you click.
          </span>
        </div>
        <p data-testid="queue-gh-status" className="min-h-4 text-xs">
          {gh === null
            ? ''
            : ready
              ? `The GitHub CLI${gh.gh.version !== undefined ? ` ${gh.gh.version}` : ''} is installed and signed in.`
              : (gh.gh.problem ?? 'The GitHub CLI is not ready.')}
        </p>
        {gh !== null && !ready && (
          <div className="flex flex-col gap-1">
            {gh.gh.fixes
              .filter((x) => x.command === undefined)
              .map((x) => (
                <p key={x.id} className="text-xs text-muted-foreground">
                  {x.label}
                </p>
              ))}
            <CopyCommands commands={commands} testId="queue-gh-fixes" />
          </div>
        )}
      </div>
      <p role="status" data-testid="queue-add-note" className="min-h-4 text-xs text-muted-foreground">
        {note}
      </p>
    </section>
  )
}

function Report(): React.JSX.Element {
  const [report, setReport] = useState<DailyReportView | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async (): Promise<void> => {
    setBusy(true)
    const r = await invoke('queue.report', {})
    setBusy(false)
    if (r.ok) setReport(r.value)
    else toast({ level: 'error', message: r.error.message })
  }
  return (
    <section
      aria-label="Daily report"
      data-testid="queue-report"
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Daily report</h2>
        <Button
          size="sm"
          variant="outline"
          data-testid="queue-report-load"
          icon={<ScrollText aria-hidden />}
          loading={busy}
          onClick={() => void load()}
        >
          {REPORT_LABEL}
        </Button>
      </div>
      {report === null ? (
        <p className="text-xs text-muted-foreground">
          Every run of the day, queued or not, with its outcome and cost, the failures, the queue pauses and
          the vendor fallbacks. It is also written to a markdown file in Dim Factory&apos;s home folder.
        </p>
      ) : (
        <div className="flex flex-col gap-2" data-testid="queue-report-body">
          <p className="text-sm">
            {report.date}: {report.runs.length} {report.runs.length === 1 ? 'run' : 'runs'},{' '}
            {formatUsd(report.spentUsd)} spent
            {report.unpriced > 0 ? ` (${report.unpriced} without a price)` : ''}. Done {report.outcomes.done},
            failed {report.outcomes.failed}, stopped {report.outcomes.stopped}, still working{' '}
            {report.outcomes.working}.
          </p>
          <ul className="flex flex-col text-xs" data-testid="queue-report-runs">
            {report.runs.map((r) => (
              <li key={r.runId}>
                <a href={href({ name: 'run', runId: r.runId })} className="underline underline-offset-2">
                  Run #{r.displayNo}
                </a>{' '}
                {r.title}: {r.failure ?? r.outcome ?? r.status},{' '}
                {r.costUsd === null ? 'no price' : formatUsd(r.costUsd)}
                {r.queued ? ' (queue)' : ''}
              </li>
            ))}
          </ul>
          {report.pauses.length > 0 && (
            <ul className="flex flex-col text-xs" data-testid="queue-report-pauses">
              {report.pauses.map((p, i) => (
                <li key={i}>Queue paused: {p.text}</li>
              ))}
            </ul>
          )}
          {report.fallbacks.length > 0 && (
            <ul className="flex flex-col text-xs" data-testid="queue-report-fallbacks">
              {report.fallbacks.map((x, i) => (
                <li key={i}>
                  Run #{x.displayNo}, {x.step}: {x.from} to {x.to} ({x.why})
                </li>
              ))}
            </ul>
          )}
          <p className="font-mono text-xs break-all text-muted-foreground" data-testid="queue-report-file">
            {report.file}
          </p>
        </div>
      )}
    </section>
  )
}

export function QueuePage(): React.JSX.Element {
  const view = useQueueView()
  const [folder, setFolder] = useState('')
  const folders = view?.folders ?? []
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-5" data-testid="queue-page">
      <h1 className="text-lg font-semibold">{QUEUE_PAGE_TITLE}</h1>
      <p className="text-sm text-muted-foreground">{QUEUE_PAGE_INTRO}</p>
      <Summary />
      <AddTasks folder={folder} setFolder={setFolder} />
      <Report />
      <div className="flex flex-col gap-3" data-testid="queue-folders">
        {view !== null && folders.length === 0 && (
          <p className="text-sm text-muted-foreground">No queues yet. Add a task to start one.</p>
        )}
        {folders.map((q) => (
          <FolderQueue key={q.folder} q={q} />
        ))}
      </div>
    </div>
  )
}
