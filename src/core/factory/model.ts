// One folder's queue as a pure reducer: reduceQueue(doc, event) → { doc, pause? }. No I/O, no clock (times come in
// the events). The service (service.ts) persists the doc, starts the runs nextTask names and feeds back what the runs
// do. The rules:
//  - Tasks run in order. Without isolated copies one task works at a time (a task whose run needs you holds its
//    place); with them, several may (the service caps how many over every folder).
//  - A run that needs you (waiting, paused, a failed pass) makes its task `waiting` and the queue waits for it, or,
//    with "skip blocked tasks", `blocked` and the queue goes on. Nothing is skipped silently: the task says why.
//  - A run's end is the task's: done, failed (completed with failures) or stopped. Failures in a row count toward the
//    stop rule; a done task resets the count. A stopped run pauses the queue (a limit's reason, or yours).
//  - The queue ends `idle` once nothing is pending or working.
import type { RunOutcome, RunStatus } from '../../shared/run.ts'
import type { FailureCategory } from '../../shared/failure.ts'
import type {
  QueuePause,
  QueueState,
  QueueEasyRun,
  QueueRematch,
  QueueStopCategory,
  QueueTask,
  QueueTaskSource,
} from '../../shared/factory.ts'
import { QUEUE_TASKS_MAX, failedOutcomeText, queueResultOf, taskTitle } from '../../shared/factory.ts'
import { afterTask } from './budget.ts'

/** A folder's queue as it is persisted (`<home>/queue/<key>.json`). */
export interface FolderQueueDoc {
  schemaVersion: 1
  folder: string
  tasks: QueueTask[]
  state: QueueState
  pause?: QueuePause
  consecutiveFailures: number
  /** The schedule started it (its window's end pauses it). */
  scheduled?: boolean
}

export function emptyQueue(folder: string): FolderQueueDoc {
  return { schemaVersion: 1, folder, tasks: [], state: 'idle', consecutiveFailures: 0 }
}

export interface NewTask {
  id: string
  task: string
  recipe?: string
  /** Easy mode queued it: its overrides layer and brief (QueueEasyRun). */
  easy?: QueueEasyRun
  /** The queue replays a run instead of starting a task (QueueRematch). */
  rematch?: QueueRematch
  source: QueueTaskSource
}

/** Why the service stopped a run (a limit), so its end reads as that and not as yours. */
export interface StopCause {
  pause: QueuePause
  category: QueueStopCategory
}

export type QueueEvent =
  | { t: 'add'; tasks: NewTask[]; at: number }
  | { t: 'remove'; id: string }
  | { t: 'move'; id: string; to: number }
  | { t: 'retry'; id: string }
  | { t: 'clear-finished' }
  | { t: 'start'; at: number; scheduled?: boolean }
  | { t: 'pause'; pause: QueuePause }
  | { t: 'resume'; at: number }
  | { t: 'task-started'; id: string; runId: string; displayNo: number; at: number; matchId?: string }
  | { t: 'task-not-started'; id: string; reason: string; at: number }
  | {
      t: 'run-update'
      runId: string
      status: RunStatus
      outcome?: RunOutcome
      costUsd: number | null
      /** Why the run needs you or failed (UI copy), from its summary. */
      reason?: string
      category?: FailureCategory
      at: number
      skipBlocked: boolean
      stopAfterFailures: number | null
      /** The service stopped this run for a limit. */
      stoppedBy?: StopCause
    }
  | { t: 'committed'; id: string; branch: string; commit?: string }

export interface QueueResult {
  doc: FolderQueueDoc
  /** The queue paused in this event (the service raises a notice and records it in the day's report). */
  paused?: QueuePause
  /** The queue ran out of tasks in this event. */
  finished?: boolean
  /** A task ended in this event: its id and result. */
  ended?: { id: string; result: 'done' | 'failed' | 'stopped' }
}

const working = (t: QueueTask): boolean => t.status === 'running' || t.status === 'waiting'

/** The task the queue starts next, or undefined (not running, a task holds its place, nothing pending). */
export function nextTask(doc: FolderQueueDoc, o: { isolate: boolean }): QueueTask | undefined {
  if (doc.state !== 'running') return undefined
  if (!o.isolate && doc.tasks.some(working)) return undefined
  return doc.tasks.find((t) => t.status === 'pending')
}

/** The task a run belongs to. */
export function taskOfRun(doc: FolderQueueDoc, runId: string): QueueTask | undefined {
  return doc.tasks.find((t) => t.runId === runId)
}

function pausedWith(doc: FolderQueueDoc, pause: QueuePause): QueuePause {
  doc.state = 'paused'
  doc.pause = pause
  delete doc.scheduled
  return pause
}

/** Nothing left to do: the queue goes idle (a pause stays, so its reason is still read). */
function settleIdle(doc: FolderQueueDoc): boolean {
  if (doc.state !== 'running') return false
  if (doc.tasks.some((t) => t.status === 'pending' || working(t))) return false
  doc.state = 'idle'
  delete doc.scheduled
  return true
}

export function reduceQueue(prev: FolderQueueDoc, ev: QueueEvent): QueueResult {
  const doc: FolderQueueDoc = structuredClone(prev)
  switch (ev.t) {
    case 'add': {
      const room = QUEUE_TASKS_MAX - doc.tasks.length
      for (const n of ev.tasks.slice(0, Math.max(0, room))) {
        doc.tasks.push({
          id: n.id,
          task: n.task,
          title: taskTitle(n.task),
          ...(n.recipe !== undefined ? { recipe: n.recipe } : {}),
          ...(n.easy !== undefined ? { easy: structuredClone(n.easy) } : {}),
          ...(n.rematch !== undefined ? { rematch: structuredClone(n.rematch) } : {}),
          source: n.source,
          addedAt: ev.at,
          status: 'pending',
        })
      }
      return { doc }
    }
    case 'remove': {
      const t = doc.tasks.find((x) => x.id === ev.id)
      // A task whose run works stays: stop the run first.
      if (t === undefined || working(t)) return { doc: prev }
      doc.tasks = doc.tasks.filter((x) => x.id !== ev.id)
      return { doc, finished: settleIdle(doc) }
    }
    case 'move': {
      const i = doc.tasks.findIndex((x) => x.id === ev.id)
      if (i < 0) return { doc: prev }
      const [t] = doc.tasks.splice(i, 1)
      const to = Math.max(0, Math.min(doc.tasks.length, ev.to))
      if (t !== undefined) doc.tasks.splice(to, 0, t)
      return { doc }
    }
    case 'retry': {
      const t = doc.tasks.find((x) => x.id === ev.id)
      if (t === undefined || (t.status !== 'failed' && t.status !== 'stopped' && t.status !== 'blocked'))
        return { doc: prev }
      // The task runs again as a new run; its last one stays in the history.
      t.status = 'pending'
      for (const k of [
        'runId',
        'displayNo',
        'startedAt',
        'endedAt',
        'outcome',
        'costUsd',
        'reason',
        'category',
      ] as const)
        delete t[k]
      return { doc }
    }
    case 'clear-finished': {
      doc.tasks = doc.tasks.filter((t) => t.status !== 'done')
      return { doc }
    }
    case 'start':
    case 'resume': {
      doc.state = 'running'
      delete doc.pause
      if (ev.t === 'start' && ev.scheduled === true) doc.scheduled = true
      // Resuming after the stop rule starts the count again.
      doc.consecutiveFailures = 0
      return { doc, finished: settleIdle(doc) }
    }
    case 'pause': {
      if (doc.state === 'idle' && ev.pause.reason !== 'user') return { doc: prev }
      return { doc, paused: pausedWith(doc, ev.pause) }
    }
    case 'task-started': {
      const t = doc.tasks.find((x) => x.id === ev.id)
      if (t === undefined) return { doc: prev }
      t.status = 'running'
      t.runId = ev.runId
      t.displayNo = ev.displayNo
      t.startedAt = ev.at
      if (t.rematch !== undefined && ev.matchId !== undefined) t.rematch.matchId = ev.matchId
      delete t.reason
      delete t.category
      return { doc }
    }
    case 'task-not-started': {
      const t = doc.tasks.find((x) => x.id === ev.id)
      if (t === undefined) return { doc: prev }
      t.status = 'failed'
      t.reason = ev.reason
      t.endedAt = ev.at
      doc.consecutiveFailures++
      // A task that cannot start (preflight, an unknown recipe) is about this computer or folder: the next would
      // likely not start either, so the queue waits for you.
      const paused = pausedWith(doc, {
        reason: 'preflight',
        text: `"${t.title}" could not start: ${ev.reason} Fix it, then resume the queue (or retry the task).`,
        at: ev.at,
        taskId: t.id,
      })
      return { doc, paused, ended: { id: t.id, result: 'failed' } }
    }
    case 'run-update':
      return runUpdate(doc, prev, ev)
    case 'committed': {
      const t = doc.tasks.find((x) => x.id === ev.id)
      if (t === undefined) return { doc: prev }
      t.branch = ev.branch
      if (ev.commit !== undefined) t.commit = ev.commit
      return { doc }
    }
  }
}

function runUpdate(
  doc: FolderQueueDoc,
  prev: FolderQueueDoc,
  ev: Extract<QueueEvent, { t: 'run-update' }>,
): QueueResult {
  const t = taskOfRun(doc, ev.runId)
  if (t === undefined || (t.status !== 'running' && t.status !== 'waiting' && t.status !== 'blocked'))
    return { doc: prev }
  t.costUsd = ev.costUsd
  const result = queueResultOf(ev.status, ev.outcome)
  if (result === undefined) {
    if (ev.status === 'queued' || ev.status === 'running') {
      // The run works again (you answered it): a skipped-for-now task stays out of the queue's way.
      if (t.status === 'waiting') t.status = 'running'
      if (t.status === 'running') delete t.reason
      return { doc }
    }
    // Waiting, paused or failed: the run needs you.
    if (t.status === 'running') t.status = ev.skipBlocked ? 'blocked' : 'waiting'
    t.reason = ev.reason ?? `Run #${t.displayNo ?? ''} needs you.`
    if (ev.category !== undefined) t.category = ev.category
    return { doc }
  }
  t.status = result
  t.endedAt = ev.at
  if (ev.outcome !== undefined) t.outcome = ev.outcome
  let paused: QueuePause | undefined
  if (result === 'done') {
    delete t.reason
    delete t.category
    doc.consecutiveFailures = 0
  } else if (result === 'failed') {
    t.reason = failedOutcomeText(ev.outcome) ?? ev.reason ?? 'The run failed.'
    if (ev.category !== undefined) t.category = ev.category
    doc.consecutiveFailures++
    const hit = afterTask(ev.stopAfterFailures, doc.consecutiveFailures)
    if (hit !== undefined && doc.state === 'running')
      paused = pausedWith(doc, { reason: hit.reason, text: hit.text, at: ev.at, taskId: t.id })
  } else {
    // Stopped: by a limit (its reason), or by you.
    if (ev.stoppedBy !== undefined) {
      t.reason = ev.stoppedBy.pause.text
      t.category = ev.stoppedBy.category
      if (doc.state !== 'idle') paused = pausedWith(doc, { ...ev.stoppedBy.pause, taskId: t.id })
    } else {
      t.reason = `You stopped run #${t.displayNo ?? ''}.`
      t.category = 'user_cancelled'
      if (doc.state === 'running')
        paused = pausedWith(doc, {
          reason: 'stopped-run',
          text: `You stopped run #${t.displayNo ?? ''}, so the queue paused. Resume it to go on with the next task.`,
          at: ev.at,
          taskId: t.id,
        })
    }
  }
  const finished = paused === undefined ? settleIdle(doc) : false
  return {
    doc,
    ...(paused !== undefined ? { paused } : {}),
    ...(finished ? { finished } : {}),
    ended: { id: t.id, result },
  }
}
