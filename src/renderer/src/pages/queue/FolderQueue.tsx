// One folder's queue on the Queue page: its state (with a pause's reason, which always says what to do next), its
// counts, [Start] / [Resume] / [Pause] (one button whose label changes, so it keeps its width), the tasks in order and
// the folder's project memory. Every row keeps its place: a task's status, reason and run update in place, a task
// added later goes last, and each row's buttons are always there (disabled when they do not apply).
import { ArrowDown, ArrowUp, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { FolderQueueView, QueueTask, QueueView } from '@shared/factory.ts'
import type { Result } from '@shared/ipc.ts'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { href } from '../../lib/router.ts'
import { setQueueView } from '../../state/queue.ts'
import { toast } from '../../state/toasts.ts'
import { MemoryPanel } from './MemoryPanel.tsx'
import {
  PAUSE_LABEL,
  REMOVE_LABEL,
  RESUME_LABEL,
  RETRY_LABEL,
  START_LABEL,
  countsText,
  folderName,
  queueStateText,
  startLabel,
  taskFacts,
  taskStatusText,
} from './text.ts'

/** Take core's answer to a queue command as the view (a refusal is a toast with core's words). */
async function act(p: Promise<Result<QueueView>>): Promise<void> {
  const r = await p
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return
  }
  setQueueView(r.value)
}

const STATUS_TONE: Readonly<Record<QueueTask['status'], string>> = {
  pending: 'text-muted-foreground',
  running: 'text-st-running',
  waiting: 'text-st-waiting',
  blocked: 'text-st-waiting',
  done: 'text-st-completed',
  failed: 'text-st-failed',
  stopped: 'text-st-paused',
}

function TaskRow({
  folder,
  task: t,
  index,
  last,
}: {
  folder: string
  task: QueueTask
  index: number
  last: boolean
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const working = t.status === 'running' || t.status === 'waiting'
  const retryable = t.status === 'failed' || t.status === 'stopped' || t.status === 'blocked'
  const run = (key: string, fn: () => Promise<void>): void => {
    setBusy(key)
    void fn().finally(() => setBusy(null))
  }
  const facts = taskFacts(t)
  return (
    <li
      data-testid={`queue-task-${t.id}`}
      data-status={t.status}
      className="flex flex-col gap-1 border-b py-2 last:border-b-0"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <span className="w-6 shrink-0 pt-0.5 text-right text-xs text-muted-foreground tabular-nums">
          {index + 1}.
        </span>
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
          <p className="min-w-0 text-sm break-words">
            <span
              data-testid="queue-task-status"
              className={cn('mr-2 inline-block w-40 text-xs font-medium', STATUS_TONE[t.status])}
            >
              {taskStatusText(t)}
            </span>
            <span data-testid="queue-task-title">{t.title}</span>
          </p>
          <p className="min-h-4 text-xs text-muted-foreground" data-testid="queue-task-facts">
            {t.runId !== undefined && (
              <a
                href={href({ name: 'run', runId: t.runId })}
                data-testid="queue-task-run"
                className="mr-2 underline underline-offset-2"
              >
                Run #{t.displayNo ?? ''}
              </a>
            )}
            {t.rematch?.matchId !== undefined && (
              <a
                href={href({ name: 'match', matchId: t.rematch.matchId })}
                data-testid="queue-task-match"
                className="mr-2 underline underline-offset-2"
              >
                Compare
              </a>
            )}
            {facts}
          </p>
          {t.reason !== undefined && (
            <p className="text-xs break-words" data-testid="queue-task-reason">
              {t.reason}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Move "${t.title}" up`}
            data-testid="queue-task-up"
            disabled={index === 0 || busy !== null}
            onClick={() => run('up', () => act(invoke('queue.move', { folder, id: t.id, to: index - 1 })))}
            icon={<ArrowUp aria-hidden />}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Move "${t.title}" down`}
            data-testid="queue-task-down"
            disabled={last || busy !== null}
            onClick={() => run('down', () => act(invoke('queue.move', { folder, id: t.id, to: index + 1 })))}
            icon={<ArrowDown aria-hidden />}
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="queue-task-retry"
            icon={<RotateCcw aria-hidden />}
            disabled={!retryable || (busy !== null && busy !== 'retry')}
            loading={busy === 'retry'}
            onClick={() => run('retry', () => act(invoke('queue.retry', { folder, id: t.id })))}
          >
            {RETRY_LABEL}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="queue-task-remove"
            icon={<Trash2 aria-hidden />}
            disabled={working || (busy !== null && busy !== 'remove')}
            loading={busy === 'remove'}
            onClick={() => run('remove', () => act(invoke('queue.remove', { folder, id: t.id })))}
          >
            {REMOVE_LABEL}
          </Button>
        </div>
      </div>
    </li>
  )
}

export function FolderQueue({ q }: { q: FolderQueueView }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const label = startLabel(q)
  const toggle = (): void => {
    setBusy(true)
    const p =
      q.state === 'running'
        ? act(invoke('queue.pause', { folders: [q.folder] }))
        : act(invoke('queue.start', { folders: [q.folder] }))
    void p.finally(() => setBusy(false))
  }
  const canStart = q.state === 'running' || q.tasks.length > 0
  return (
    <section
      aria-label={`Queue for ${folderName(q.folder)}`}
      data-testid="queue-folder"
      data-folder={q.folder}
      data-state={q.state}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="truncate text-sm font-semibold" title={q.folder}>
            {folderName(q.folder)}
          </h2>
          <p className="truncate font-mono text-xs text-muted-foreground">{q.folder}</p>
        </div>
        <span data-testid="queue-state" className="w-48 shrink-0 text-xs font-medium">
          {queueStateText(q)}
        </span>
        <Button
          size="sm"
          variant={q.state === 'running' ? 'outline' : 'default'}
          data-testid="queue-toggle"
          labels={[START_LABEL, RESUME_LABEL, PAUSE_LABEL]}
          icon={q.state === 'running' ? <Pause aria-hidden /> : <Play aria-hidden />}
          loading={busy}
          disabled={!canStart}
          onClick={toggle}
        >
          {label}
        </Button>
      </div>
      <p className="min-h-4 text-xs text-muted-foreground" data-testid="queue-counts">
        {countsText(q)}
      </p>
      <p role="status" className="min-h-4 text-sm" data-testid="queue-pause">
        {q.state === 'paused' && q.pause !== undefined ? q.pause.text : ''}
      </p>
      {q.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks. Add one above.</p>
      ) : (
        <ol className="flex flex-col" data-testid="queue-tasks">
          {q.tasks.map((t, i) => (
            <TaskRow key={t.id} folder={q.folder} task={t} index={i} last={i === q.tasks.length - 1} />
          ))}
        </ol>
      )}
      <div className="flex flex-col gap-1 border-t pt-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase">Project memory</h3>
        <MemoryPanel folder={q.folder} testId="queue-memory" />
      </div>
    </section>
  )
}
