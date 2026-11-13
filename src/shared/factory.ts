// The local factory: a task queue per folder (run one after another, or side by side in isolated copies), budgets and
// stop rules, the schedule, the daily report, project memory and quality gates. Types, limits and pure helpers that
// core, the CLI and the renderer share. Core decides everything here; the renderer only formats it.
import type { BriefInput } from './brief.ts'
import type { RunOverrides } from './config-schema.ts'
import type { GhStatus } from './deploy.ts'
import type { FailureCategory } from './failure.ts'
import type { RunOutcome, RunStatus } from './run.ts'

// ---- limits ---------------------------------------------------------------------------------------------------------

/** The most tasks one folder's queue holds. */
export const QUEUE_TASKS_MAX = 200
/** The longest task text a queue keeps (characters); a longer one is refused, never cut. */
export const QUEUE_TASK_TEXT_MAX = 20_000
/** A task's title: the first line, at most this long. */
export const QUEUE_TITLE_MAX = 80
/** The most tasks one import adds (a longer TODO file or issue list stops there and says so). */
export const QUEUE_IMPORT_MAX = 50
/** The most issues `gh issue list` is asked for. */
export const GITHUB_ISSUES_LIMIT = 50
/** A task id: `t` and 12 lowercase hex characters. */
export const QUEUE_TASK_ID = /^t[0-9a-f]{12}$/
/** `HH:MM` on a 24-hour clock. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
/** Project memory: the default and largest share of the file fed to each pass (bytes of UTF-8). */
export const MEMORY_DEFAULT_MAX_BYTES = 16_000
export const MEMORY_MAX_BYTES = 64_000
export const MEMORY_MIN_BYTES = 1_024
/** How many run notes the memory file keeps (older ones are dropped by the next proposal). */
export const MEMORY_RUN_NOTES_MAX = 20

// ---- queue ----------------------------------------------------------------------------------------------------------

/**
 * Why a queue stopped a task's run (the factory's own failure categories, beside the vendor failure categories a run's
 * passes fail with): it reached the cost limit per run or per day, or ran past the time limit per run.
 */
export const QUEUE_STOP_CATEGORIES = ['budget_exceeded', 'time_limit'] as const
export type QueueStopCategory = (typeof QUEUE_STOP_CATEGORIES)[number]

export const QUEUE_STOP_CATEGORY_LABEL: Readonly<Record<QueueStopCategory, string>> = {
  budget_exceeded: 'Budget reached',
  time_limit: 'Time limit reached',
}

/** A task's failure category: its run's (a vendor failure), or the queue's own when a limit stopped it. */
export type QueueTaskCategory = FailureCategory | QueueStopCategory

/**
 * A queued task's state. `pending`: waits its turn · `running`: its run works · `waiting`: its run needs you (a card,
 * an ask, a failed pass) and the queue waits for it · `blocked`: its run needs you and the queue went on without it
 * (only when "skip blocked tasks" is on) · `done`: its run completed and counts as done · `failed`: its run completed
 * with failures (or could not start) · `stopped`: its run was stopped (by you, or by a budget or time limit).
 */
export const QUEUE_TASK_STATUSES = [
  'pending',
  'running',
  'waiting',
  'blocked',
  'done',
  'failed',
  'stopped',
] as const
export type QueueTaskStatus = (typeof QUEUE_TASK_STATUSES)[number]

/** Statuses a task never leaves on its own (Retry puts a failed or stopped task back to pending). */
export const QUEUE_FINISHED_STATUSES = [
  'done',
  'failed',
  'stopped',
] as const satisfies readonly QueueTaskStatus[]

export const QUEUE_TASK_STATUS_LABEL: Readonly<Record<QueueTaskStatus, string>> = {
  pending: 'Pending',
  running: 'Running',
  waiting: 'Needs you',
  blocked: 'Blocked, skipped for now',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
}

/** Where a task came from. */
export type QueueTaskSource =
  | { kind: 'manual' }
  | { kind: 'todo'; file: string; line: number }
  | { kind: 'github'; number: number; url?: string }

/**
 * A task Easy mode queued (its overnight list): the run's overrides layer and brief travel with the task. Such a task
 * runs with them as they are (never in Auto, never in an isolated copy), only one Easy task works at a time, and the
 * factory's own limits still apply when the user set them.
 */
export interface QueueEasyRun {
  overrides: RunOverrides
  brief?: BriefInput
}

/**
 * A rematch the queue starts instead of a task: a run that ended, replayed against another builder from where it
 * began. It is started as any rematch is, so it is never applied and never committed; the day's budget, the schedule
 * and the stop rules count it as they count a task's run (the challenger's build is its run).
 */
export interface QueueRematch {
  /** The run that is replayed. */
  runId: string
  displayNo: number
  challenger: { vendor: string; model?: string | null; effort?: string }
  /** Hide the builders' names on its Match page until a result is picked. */
  blind?: boolean
  /** The match it made, once started. */
  matchId?: string
}

export interface QueueTask {
  id: string
  task: string
  title: string
  /** The queue replays a run (see QueueRematch); `task` is then the run's title. */
  rematch?: QueueRematch
  /** A recipe id (recipes.list): the run takes its switches and brief defaults. */
  recipe?: string
  /** Easy mode queued it (see QueueEasyRun). */
  easy?: QueueEasyRun
  source: QueueTaskSource
  addedAt: number
  status: QueueTaskStatus
  /** The run this task made (its latest, after a Retry). */
  runId?: string
  displayNo?: number
  startedAt?: number
  endedAt?: number
  /** The run's outcome once it completed. */
  outcome?: RunOutcome
  /** What the run spent (USD; null: not priced). */
  costUsd?: number | null
  /** Why the task waits, was skipped for now, failed or was stopped (UI copy). */
  reason?: string
  /** The failure's category: the run's, or `budget_exceeded` / `time_limit` when a limit stopped it. */
  category?: QueueTaskCategory
  /** The branch the task's changes are on (a run branch or an isolated copy's) and the commit the queue made there. */
  branch?: string
  commit?: string
}

/**
 * Why a queue is paused. `user`: you paused it · `run-budget` / `day-budget` / `run-time`: a limit was reached ·
 * `failures`: too many tasks in a row failed · `blocked`: a task needs you (skip blocked tasks is off) · `window-ended`:
 * the schedule's window closed · `relaunch`: Dim Factory was closed while it ran · `preflight`: a task could not start ·
 * `stopped-run`: you stopped a task's run · `git`: committing a task's changes or leaving its branch failed.
 */
export const QUEUE_PAUSE_REASONS = [
  'user',
  'run-budget',
  'day-budget',
  'run-time',
  'failures',
  'blocked',
  'window-ended',
  'relaunch',
  'preflight',
  'stopped-run',
  'git',
] as const
export type QueuePauseReason = (typeof QUEUE_PAUSE_REASONS)[number]

export interface QueuePause {
  reason: QueuePauseReason
  /** The reason as the user reads it (always says what to do next). */
  text: string
  at: number
  taskId?: string
}

/** `idle`: not started · `running`: takes the next task when it can · `paused`: waits for you (see `pause`). */
export const QUEUE_STATES = ['idle', 'running', 'paused'] as const
export type QueueState = (typeof QUEUE_STATES)[number]

export interface QueueCounts {
  pending: number
  running: number
  waiting: number
  done: number
  failed: number
  stopped: number
}

export interface FolderQueueView {
  folder: string
  state: QueueState
  pause?: QueuePause
  tasks: QueueTask[]
  counts: QueueCounts
  /** Failed tasks in a row (a done task resets it). */
  consecutiveFailures: number
  /** The schedule started this queue (its window's end pauses it). */
  scheduled?: boolean
  /** The pending tasks' estimated cost (p50, USD) when every one could be priced; absent otherwise. */
  estimateUsd?: number
}

/** The factory settings as they apply now (user `factory`). */
export interface FactoryLimitsView {
  auto: boolean
  maxCostPerRunUsd: number | null
  maxCostPerDayUsd: number | null
  maxMinutesPerRun: number | null
  maxFixRounds: number | null
  stopAfterFailures: number | null
  skipBlocked: boolean
  isolate: boolean
  maxParallel: number
}

export interface ScheduleSettings {
  enabled: boolean
  /** `HH:MM`, local time. */
  start: string
  /** `HH:MM`, local time (before `start`: the next day); null: no end (the queue runs until it is empty). */
  end: string | null
  /** Days the window opens on (0 Sunday … 6 Saturday). */
  days: number[]
  /** At launch, a due schedule continues on its own (default off: Dim Factory asks). */
  resumeAutomatically: boolean
  /** Start a scheduled queue while the computer runs on battery (default off: it waits for power). */
  onBattery: boolean
}

export interface ScheduleView extends ScheduleSettings {
  /** The window is open now. */
  open: boolean
  /** When the window opens next (epoch ms; absent: never, or it is open with no end). */
  nextStart?: number
  /** When the open window closes (absent: not open, or no end). */
  closesAt?: number
  /** Why a due schedule does not start now. */
  waiting?: 'battery' | 'sleep'
}

/** A notice the queue raises at launch (a due schedule) that stays until you act on it or dismiss it. */
export interface FactoryNotice {
  id: string
  kind: 'schedule-due' | 'resumed'
  at: number
  text: string
  folders: string[]
}

export interface TodaySpend {
  /** Local date, `YYYY-MM-DD`. */
  date: string
  spentUsd: number
  /** Runs started today; how many have a price. */
  runs: number
  priced: number
  done: number
  failed: number
}

export interface QueueView {
  folders: FolderQueueView[]
  limits: FactoryLimitsView
  schedule: ScheduleView
  today: TodaySpend
  /** Queue runs working now, over every folder. */
  running: number
  notice?: FactoryNotice
}

/** What a run's end means for its task: done, failed (completed with failures) or stopped; undefined: not over. */
export function queueResultOf(
  status: RunStatus,
  outcome?: RunOutcome,
): 'done' | 'failed' | 'stopped' | undefined {
  if (status === 'cancelled') return 'stopped'
  if (status !== 'completed') return undefined
  return outcome === 'fixed' || outcome === 'clean' || outcome === 'findings-open' ? 'done' : 'failed'
}

/** Why a completed run counts as failed, as UI copy (undefined for a done outcome). */
export function failedOutcomeText(outcome: RunOutcome | undefined): string | undefined {
  switch (outcome) {
    case 'verify-failed':
      return 'Completed with failures: a check still fails.'
    case 'security-open':
      return 'Completed with failures: security findings are still open.'
    case 'fix-stopped':
      return 'Completed with failures: Fix until green stopped before the run was green.'
    case 'gates-failed':
      return "Completed with failures: the project's quality gates did not pass."
    case 'no-changes':
      return 'The run made no changes.'
    case 'failed':
      return 'The run failed.'
    case 'fixed':
    case 'clean':
    case 'findings-open':
    case undefined:
      return undefined
  }
}

export function emptyCounts(): QueueCounts {
  return { pending: 0, running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 }
}

/** The counts of a task list (`blocked` counts as waiting). */
export function countTasks(tasks: readonly Pick<QueueTask, 'status'>[]): QueueCounts {
  const c = emptyCounts()
  for (const t of tasks) {
    if (t.status === 'blocked') c.waiting++
    else c[t.status]++
  }
  return c
}

/** A task's title: its first non-empty line, at most QUEUE_TITLE_MAX characters. */
export function taskTitle(task: string): string {
  const first = task
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  const t = first ?? ''
  return t.length > QUEUE_TITLE_MAX ? `${t.slice(0, QUEUE_TITLE_MAX - 3)}...` : t
}

// ---- imports --------------------------------------------------------------------------------------------------------

/** One open item of a markdown TODO file (`- [ ] text`), with its 1-based line. */
export interface TodoItem {
  line: number
  text: string
}

const TODO_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+?)\s*$/

/**
 * The open checkbox items of a markdown TODO file: `- [ ] text`, `* [ ]`, `+ [ ]` or `1. [ ]`, at any indent. Ticked
 * items (`[x]`) and lines inside fenced code blocks are left out.
 */
export function parseTodo(text: string): TodoItem[] {
  const out: TodoItem[] = []
  let fence: string | null = null
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  lines.forEach((raw, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(raw)
    if (f !== null) {
      const mark = f[1] ?? ''
      if (fence === null) fence = mark[0] ?? null
      else if (mark[0] === fence) fence = null
      return
    }
    if (fence !== null) return
    const m = TODO_LINE.exec(raw)
    const t = m?.[1]?.trim()
    if (t !== undefined && t !== '') out.push({ line: i + 1, text: t })
  })
  return out
}

/** What an import added, what it left out because the queue already has it, and what did not fit. */
export interface QueueImportResult {
  added: number
  skipped: number
  /** Items left out because the queue (or the import) was full. */
  overLimit: number
  /** Where the items came from (the TODO file, or the repository gh listed). */
  from: string
}

/** The gh check before an import from GitHub (never blocking: the fixes are copyable). */
export interface GithubCheckView {
  gh: GhStatus
}

// ---- daily report ---------------------------------------------------------------------------------------------------

export interface DailyReportRun {
  runId: string
  displayNo: number
  folder: string
  title: string
  status: RunStatus
  outcome?: RunOutcome
  costUsd: number | null
  createdAt: number
  endedAt?: number
  /** Started by a queue. */
  queued: boolean
  /** Why it failed or was stopped (UI copy). */
  failure?: string
}

export interface DailyReportPause {
  at: number
  folder: string
  text: string
}

export interface DailyReportFallback {
  at: number
  runId: string
  displayNo: number
  step: string
  from: string
  to: string
  why: string
}

export interface DailyReportView {
  date: string
  runs: DailyReportRun[]
  spentUsd: number
  /** Runs without a price (their cost is not in `spentUsd`). */
  unpriced: number
  outcomes: { done: number; failed: number; stopped: number; working: number }
  pauses: DailyReportPause[]
  fallbacks: DailyReportFallback[]
  /** The markdown file (`<home>/reports/<date>.md`) and its text. */
  file: string
  markdown: string
}

// ---- project memory ----------------------------------------------------------------------------------------------

export interface MemoryProposalView {
  id: string
  runId: string
  displayNo: number
  title: string
  createdAt: number
  /** The file's sha256 the proposal was made against (null: the file did not exist). */
  baseSha256: string | null
  /** A unified diff of the change (the file did not exist: every line added). */
  diff: string
  added: number
  removed: number
}

export interface MemoryView {
  folder: string
  /** The memory file's path (`<project root>/DIM_FACTORY.md`). */
  file: string
  exists: boolean
  bytes: number
  /** The file is larger than `maxBytes`: passes get its first `maxBytes` only. */
  capped: boolean
  maxBytes: number
  enabled: boolean
  propose: boolean
  /** Auto runs write the proposal without asking (the project's opt-in). */
  autoApply: boolean
  pending: MemoryProposalView[]
}

// ---- quality gates ---------------------------------------------------------------------------------------------------

/** A run's quality gates as they ended (RunSummary.gates). */
export interface QualityGatesView {
  passed: string[]
  failed: { name: string; reason: string }[]
}
