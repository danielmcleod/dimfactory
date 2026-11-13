// The Queue page's words: labels, the limits and schedule lines, and how a task and a queue read. Core decides every
// figure and state; these only word them (no em dashes).
import type {
  FactoryLimitsView,
  FolderQueueView,
  QueueTask,
  ScheduleView,
  TodaySpend,
} from '@shared/factory.ts'
import { QUEUE_STOP_CATEGORY_LABEL, QUEUE_TASK_STATUS_LABEL } from '@shared/factory.ts'
import { formatUsd, vendorName } from '../../lib/format.ts'

export const QUEUE_PAGE_TITLE = 'Queue'
export const QUEUE_PAGE_INTRO =
  'Tasks for a folder that run one after another (or side by side in isolated copies), each as an ordinary run with the same checks, trust and cards. A queue runs only when you start it, or when its schedule opens while Dim Factory is open. A limit reached pauses it and says why; nothing is skipped silently.'

export const ADD_LABEL = 'Add to queue'
export const START_LABEL = 'Start'
export const RESUME_LABEL = 'Resume'
export const PAUSE_LABEL = 'Pause'
export const RETRY_LABEL = 'Retry'
export const REMOVE_LABEL = 'Remove'
export const IMPORT_TODO_LABEL = 'Import TODO'
export const GH_CHECK_LABEL = 'Check GitHub CLI'
export const GH_IMPORT_LABEL = 'Import issues'
export const REPORT_LABEL = "Show today's report"
export const APPROVE_LABEL = 'Approve'
export const DISMISS_LABEL = 'Dismiss'
export const NO_RECIPE = 'none'

const STATE_TEXT = { idle: 'Not running', running: 'Running', paused: 'Paused' } as const

export function queueStateText(f: Pick<FolderQueueView, 'state' | 'scheduled'>): string {
  return f.state === 'running' && f.scheduled === true ? 'Running (by the schedule)' : STATE_TEXT[f.state]
}

/** The start button's label for a queue: Start, Resume (paused) or Pause (running). */
export function startLabel(f: Pick<FolderQueueView, 'state'>): string {
  return f.state === 'running' ? PAUSE_LABEL : f.state === 'paused' ? RESUME_LABEL : START_LABEL
}

export function taskStatusText(t: Pick<QueueTask, 'status'>): string {
  return QUEUE_TASK_STATUS_LABEL[t.status]
}

/** `Run #12 · $0.40 · Budget reached · branch dim/…` (what core recorded about the task's run). */
export function taskFacts(t: QueueTask): string {
  const out: string[] = []
  if (t.rematch !== undefined) {
    const c = t.rematch.challenger
    const who = typeof c.model === 'string' ? `${vendorName(c.vendor)} (${c.model})` : vendorName(c.vendor)
    out.push(`Rematch of run #${t.rematch.displayNo} against ${who}`)
  }
  if (t.costUsd !== undefined) out.push(t.costUsd === null ? 'No price' : formatUsd(t.costUsd))
  if (t.category === 'budget_exceeded' || t.category === 'time_limit')
    out.push(QUEUE_STOP_CATEGORY_LABEL[t.category])
  if (t.recipe !== undefined) out.push(`Recipe ${t.recipe}`)
  if (t.branch !== undefined)
    out.push(`Branch ${t.branch}${t.commit !== undefined ? ` (${t.commit.slice(0, 7)})` : ''}`)
  if (t.source.kind === 'github') out.push(`Issue #${t.source.number}`)
  if (t.source.kind === 'todo') out.push(`${t.source.file}:${t.source.line}`)
  return out.join(' · ')
}

const limit = (v: number | null, f: (n: number) => string, none: string): string => (v === null ? none : f(v))

/** The limits as lines (each says "no limit" when there is none). */
export function limitsLines(l: FactoryLimitsView): string[] {
  return [
    `Per run: ${limit(l.maxCostPerRunUsd, formatUsd, 'no cost limit')}, ${limit(l.maxMinutesPerRun, (m) => `${m} min`, 'no time limit')}.`,
    `Per day: ${limit(l.maxCostPerDayUsd, formatUsd, 'no budget')}.`,
    `Stop after ${limit(l.stopAfterFailures, (n) => `${n} failed ${n === 1 ? 'task' : 'tasks'} in a row`, 'no number of failures')}; Fix rounds ${limit(l.maxFixRounds, (n) => `at most ${n}`, 'as the run sets them')}.`,
    `${l.auto ? 'Tasks run in Auto' : 'Tasks run as your settings say (not in Auto)'}; ${l.isolate ? 'each in an isolated copy' : 'in the folder itself'}; at most ${l.maxParallel} at once. ${l.skipBlocked ? 'A task that needs you is left waiting and the queue goes on.' : 'A task that needs you holds the queue until you answer it.'}`,
  ]
}

export function todayText(t: TodaySpend, l: FactoryLimitsView): string {
  const runs = t.runs === 1 ? '1 run' : `${t.runs} runs`
  const budget = l.maxCostPerDayUsd !== null ? ` of ${formatUsd(l.maxCostPerDayUsd)}` : ''
  const unpriced = t.runs - t.priced
  return `Today: ${formatUsd(t.spentUsd)}${budget} spent over ${runs}${unpriced > 0 ? ` (${unpriced} without a price)` : ''}. ${t.done} done, ${t.failed} failed or stopped.`
}

const clock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function scheduleText(s: ScheduleView): string {
  if (!s.enabled) return 'No schedule: queues run when you start them.'
  const days = s.days.length === 7 ? 'every day' : s.days.map((d) => DAY_NAMES[d] ?? String(d)).join(', ')
  const window = `${s.start} to ${s.end ?? 'when the queue is empty'}, ${days}`
  if (s.open) {
    const wait =
      s.waiting === 'battery'
        ? ' Waiting for power: the computer is on battery.'
        : s.waiting === 'sleep'
          ? ' Waiting for the computer to wake.'
          : ''
    return `Schedule ${window}: open now${s.closesAt !== undefined ? ` until ${clock(s.closesAt)}` : ''}.${wait}`
  }
  return `Schedule ${window}.${s.nextStart !== undefined ? ` Opens next at ${clock(s.nextStart)}.` : ''}`
}

/** A folder's counts in a line. */
export function countsText(f: FolderQueueView): string {
  const c = f.counts
  const parts = [`${c.pending} pending`]
  if (c.running > 0) parts.push(`${c.running} running`)
  if (c.waiting > 0) parts.push(`${c.waiting} need you`)
  parts.push(`${c.done} done`)
  if (c.failed + c.stopped > 0) parts.push(`${c.failed + c.stopped} failed or stopped`)
  const est =
    f.estimateUsd !== undefined && c.pending > 0 ? ` · pending about ${formatUsd(f.estimateUsd)}` : ''
  return `${parts.join(', ')}${est}`
}

/** The last part of a folder path, for headings. */
export function folderName(f: string): string {
  const parts = f.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? f
}
