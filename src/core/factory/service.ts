// The factory service: the task queues (one per folder), their budgets and stop rules, the schedule and the daily
// report, over the same runs.start the composer uses. It never starts anything on its own but for:
//  - a queue you started (or the schedule started, or resumed at launch only with "resume automatically" on), which
//    takes its next task when the one before has ended (or, with isolated copies, while fewer than the limit work);
//  - the schedule's window opening while Dim Factory runs (the schedule is yours: you turned it on).
// Runs a queue starts are ordinary runs: preflight, trust grants, blocking cards, the folder lock and Auto's rules all
// apply. A run that needs you holds its task (or, with "skip blocked tasks", is left waiting and the queue goes on).
// A limit reached pauses the queue with its reason and stops the run that reached it; nothing is skipped silently.
// Interrupted runs never resume on their own; a queue that was running when Dim Factory closed comes back paused.
// Writes go to DIM_FACTORY_HOME (queue/, reports/); the work is serialized on one chain, so the queue files and the
// runs it starts never race.
import type { FactorySettings, ResolvedConfig, RunOverrides } from '../../shared/config-schema.ts'
import { FACTORY_DEFAULTS } from '../../shared/config-schema.ts'
import type {
  DailyReportView,
  FactoryNotice,
  FolderQueueView,
  QueueImportResult,
  QueueEasyRun,
  QueueRematch,
  QueuePause,
  QueueTask,
  QueueView,
  ScheduleView,
  TodaySpend,
} from '../../shared/factory.ts'
import {
  QUEUE_IMPORT_MAX,
  QUEUE_TASKS_MAX,
  QUEUE_TASK_TEXT_MAX,
  countTasks,
  queueResultOf,
} from '../../shared/factory.ts'
import type { FailureCategory } from '../../shared/failure.ts'
import type { RunStartRequest, RunStarted } from '../../shared/ipc.ts'
import type { RunSummary } from '../../shared/run.ts'
import { newRequestId } from '../../shared/ids.ts'
import type { EventBus } from '../bus/bus.ts'
import { DimFactoryError, errorMessage } from '../errors.ts'
import type { Logger } from '../log.ts'
import type { Clock, TimerHandle } from '../supervisor/effects.ts'
import { beforeStart, duringRun, timeLimitAt } from './budget.ts'
import type { LimitHit } from './budget.ts'
import { emptyQueue, nextTask, reduceQueue, taskOfRun } from './model.ts'
import type { FolderQueueDoc, NewTask, QueueEvent, StopCause } from './model.ts'
import { buildReport, failureTitle, runsOfDay, spendOf } from './report.ts'
import { localDate, nextScheduleEvent, scheduleWindow } from './schedule.ts'
import {
  loadQueues,
  readFactoryState,
  readLedger,
  reportFile,
  saveQueue,
  writeFactoryState,
  writeLedger,
} from './store.ts'
import type { DayLedger, FactoryStateDoc } from './store.ts'
import { writeFileAtomic } from '../store/atomic.ts'

/** What the service needs from the core (app-core.ts wires it). */
export interface FactoryDeps {
  home: string
  clock: Clock
  log: Logger
  bus: EventBus
  /** The factory settings now (the user file's `factory` over the defaults). */
  settings(): FactorySettings
  /** The folder's resolved config with the recipe (null when it does not resolve: the run's preflight says why). */
  folderConfig(folder: string, recipe?: string): Promise<ResolvedConfig | null>
  startRun(req: RunStartRequest): Promise<RunStarted>
  /** Stop a run (as the user's Stop does). */
  stopRun(runId: string): Promise<void>
  summaries(): RunSummary[]
  summary(runId: string): RunSummary | undefined
  /** A task's estimated cost (p50, USD) as runs.start would run it; null when it cannot be priced. */
  estimate(req: RunStartRequest): Promise<number | null>
  /**
   * Start a queued rematch (matches.rematch): the run the queue follows is the challenger's build. Absent: a rematch
   * item cannot be started here, and says so.
   */
  startRematch?(r: QueueRematch): Promise<RunStarted & { matchId: string }>
  /** What a rematch of a run is expected to cost (what the run itself cost); null when it was not priced. */
  estimateRematch?(runId: string): Promise<number | null>
  /**
   * After a task's run completed: commit it on its run branch or isolated copy's branch when the project opted in
   * (`git.commit`), then leave the run branch for the branch it came from. Null when there is nothing to do.
   * Throws (UI copy) when it could not.
   */
  commitTask?(runId: string): Promise<{ branch: string; commit?: string } | null>
  /** Called once per run that ends while this process runs (project memory's proposal), before the queue goes on. */
  afterRun?(summary: RunSummary): Promise<void>
  /** Run the schedule and raise launch notices (the app; a CLI process never does). */
  schedule: boolean
  /** A read-only core: the queues are read, never written, and nothing starts. */
  readOnly?: boolean
}

const TERMINAL = new Set(['completed', 'cancelled'])

const uniqueId = (): string => `t${newRequestId('x').slice(2, 14)}`

/** "Run #12 needs you: …" for a run that waits on the user, is paused or failed (UI copy). */
export function needsYouText(s: RunSummary): string {
  const run = `Run #${s.displayNo}`
  switch (s.status) {
    case 'waiting':
      return `${run} waits for you (a question or a card). Answer it to go on.`
    case 'paused':
      return `${run} is paused. Resume or stop it to go on.`
    case 'failed': {
      const t = failureTitle(s)
      return t !== undefined
        ? `${run} failed at ${t}. Retry it, or stop it.`
        : `${run} failed. Retry it, or stop it.`
    }
    case 'queued':
    case 'running':
    case 'completed':
    case 'cancelled':
      return `${run} needs you.`
  }
}

export class FactoryService {
  readonly #d: FactoryDeps
  readonly #docs = new Map<string, FolderQueueDoc>()
  #state: FactoryStateDoc = {}
  #chain: Promise<void> = Promise.resolve()
  #ended = new Set<string>()
  /** Runs a limit stopped, with why (their end reads as that). */
  readonly #stopCauses = new Map<string, StopCause>()
  /** A queue run's time limit timer. */
  readonly #timeTimers = new Map<string, TimerHandle>()
  #scheduleTimer: TimerHandle | undefined
  #suspended = false
  #onBattery = false
  /** A due schedule window waits for power or for the machine to wake. */
  #waiting: ScheduleView['waiting']
  readonly #estimates = new Map<string, number | undefined>()
  #reportTimer: ReturnType<typeof setTimeout> | undefined
  #emitQueued = false
  #closed = false
  #detach: (() => void) | undefined

  constructor(d: FactoryDeps) {
    this.#d = d
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------

  /**
   * Load the queues; a queue that was running when Dim Factory closed comes back paused; tasks follow their runs as
   * they are now; then the schedule (a due window at launch raises a notice, and continues only with "resume
   * automatically" on).
   */
  async init(): Promise<void> {
    const loaded = await loadQueues(this.#d.home)
    for (const p of loaded.problems) this.#d.log.warn('a queue file could not be read; left as it is', { p })
    this.#state = await readFactoryState(this.#d.home)
    const now = this.#d.clock.now()
    for (const s of this.#d.summaries()) if (TERMINAL.has(s.status)) this.#ended.add(s.runId)
    for (const raw of loaded.docs) {
      let doc = raw
      if (doc.state === 'running') {
        doc = reduceQueue(doc, {
          t: 'pause',
          pause: {
            reason: 'relaunch',
            text: 'Dim Factory was closed while this queue ran. Resume it to go on with the next task.',
            at: now,
          },
        }).doc
      }
      this.#docs.set(this.#key(doc.folder), doc)
      // Tasks follow their runs as they are now (a run that ended, one left paused by the close).
      for (const t of doc.tasks) {
        if (
          t.runId === undefined ||
          (t.status !== 'running' && t.status !== 'waiting' && t.status !== 'blocked')
        )
          continue
        const s = this.#d.summary(t.runId)
        if (s !== undefined) this.#applyRun(doc.folder, s, now)
        if ((s === undefined || !TERMINAL.has(s.status)) && t.startedAt !== undefined)
          this.#armTimeLimit(t.runId, t.startedAt)
      }
      const now2 = this.#docs.get(this.#key(doc.folder)) ?? doc
      if (this.#d.readOnly !== true && JSON.stringify(now2) !== JSON.stringify(raw)) await this.#save(now2)
    }
    if (this.#d.readOnly === true) return
    this.#detach = this.#d.bus.attach({
      name: 'factory',
      global: (ev) => {
        if (ev.kind === 'run-summary')
          void this.#enqueue(() => this.#onSummary(ev.summary)).catch(() => undefined)
        else if (ev.kind === 'config-changed' && ev.scope === 'user')
          void this.#enqueue(() => this.#onSettings()).catch(() => undefined)
      },
    })
    if (this.#d.schedule) {
      await this.#launchSchedule(now)
      this.#armSchedule()
    }
    this.#emit()
  }

  close(): void {
    this.#closed = true
    this.#detach?.()
    if (this.#scheduleTimer !== undefined) this.#d.clock.clearTimer(this.#scheduleTimer)
    for (const t of this.#timeTimers.values()) this.#d.clock.clearTimer(t)
    this.#timeTimers.clear()
    if (this.#reportTimer !== undefined) clearTimeout(this.#reportTimer)
  }

  /** Every write and start in order; an error is logged and the chain goes on. */
  #enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(fn)
    this.#chain = run.catch((err: unknown) => this.#d.log.warn('factory work failed', { err }))
    return run
  }

  /** Resolves once the work queued so far is done (tests, the CLI). */
  settled(): Promise<void> {
    return this.#chain
  }

  // ---- power ------------------------------------------------------------------------------------------------------

  /** Sleep: no task starts while the machine sleeps; at wake the schedule is looked at again. */
  power(state: 'suspend' | 'resume'): Promise<void> {
    return this.#enqueue(async () => {
      this.#suspended = state === 'suspend'
      if (!this.#suspended) {
        await this.#scheduleTick()
        await this.#pump()
      }
      this.#emit()
    })
  }

  /** On battery: a due schedule waits for power unless `schedule.onBattery` (a queue you start yourself runs). */
  setOnBattery(onBattery: boolean): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#onBattery === onBattery) return
      this.#onBattery = onBattery
      if (!onBattery) await this.#scheduleTick()
      this.#emit()
    })
  }

  // ---- reads ------------------------------------------------------------------------------------------------------

  #key(folder: string): string {
    return process.platform === 'win32' ? folder.toLowerCase() : folder
  }

  #limits(): FactorySettings {
    try {
      return this.#d.settings()
    } catch {
      return structuredClone(FACTORY_DEFAULTS)
    }
  }

  #today(now = this.#d.clock.now()): TodaySpend {
    const date = localDate(now)
    const day = runsOfDay(this.#d.summaries(), date)
    const spend = spendOf(day)
    let done = 0
    let failed = 0
    for (const s of day) {
      const r = s.status === 'failed' ? 'failed' : queueResultOf(s.status, s.outcome)
      if (r === 'done') done++
      else if (r === 'failed' || r === 'stopped') failed++
    }
    return { date, spentUsd: spend.usd, runs: day.length, priced: day.length - spend.unpriced, done, failed }
  }

  #scheduleView(now = this.#d.clock.now()): ScheduleView {
    const s = this.#limits().schedule
    const w = scheduleWindow(s, now)
    return {
      ...s,
      days: [...s.days],
      open: w.open,
      ...(w.nextStart !== undefined ? { nextStart: w.nextStart } : {}),
      ...(w.closesAt !== undefined ? { closesAt: w.closesAt } : {}),
      ...(this.#waiting !== undefined && w.open ? { waiting: this.#waiting } : {}),
    }
  }

  #folderView(doc: FolderQueueDoc): FolderQueueView {
    const est = this.#estimates.get(this.#key(doc.folder))
    return {
      folder: doc.folder,
      state: doc.state,
      ...(doc.pause !== undefined ? { pause: { ...doc.pause } } : {}),
      tasks: doc.tasks.map((t) => ({ ...t })),
      counts: countTasks(doc.tasks),
      consecutiveFailures: doc.consecutiveFailures,
      ...(doc.scheduled === true ? { scheduled: true } : {}),
      ...(est !== undefined ? { estimateUsd: est } : {}),
    }
  }

  view(): QueueView {
    const l = this.#limits()
    const folders = [...this.#docs.values()].map((d) => this.#folderView(d))
    let running = 0
    for (const f of folders) running += f.counts.running
    return {
      folders,
      limits: {
        auto: l.auto,
        maxCostPerRunUsd: l.maxCostPerRunUsd,
        maxCostPerDayUsd: l.maxCostPerDayUsd,
        maxMinutesPerRun: l.maxMinutesPerRun,
        maxFixRounds: l.maxFixRounds,
        stopAfterFailures: l.stopAfterFailures,
        skipBlocked: l.skipBlocked,
        isolate: l.isolate,
        maxParallel: l.maxParallel,
      },
      schedule: this.#scheduleView(),
      today: this.#today(),
      running,
      ...(this.#state.notice !== undefined ? { notice: { ...this.#state.notice } } : {}),
    }
  }

  /** queue.get: the view, with each folder's pending tasks priced (estimates read now). */
  async viewWithEstimates(): Promise<QueueView> {
    await this.#enqueue(async () => {
      for (const doc of this.#docs.values()) await this.#estimateFolder(doc)
    })
    return this.view()
  }

  async #estimateFolder(doc: FolderQueueDoc): Promise<void> {
    const pending = doc.tasks.filter((t) => t.status === 'pending')
    let total = 0
    for (const t of pending) {
      const usd = await this.#d
        .estimate({
          folder: doc.folder,
          task: t.task,
          ...(t.recipe !== undefined ? { recipe: t.recipe } : {}),
        })
        .catch(() => null)
      if (usd === null) {
        this.#estimates.set(this.#key(doc.folder), undefined)
        return
      }
      total += usd
    }
    this.#estimates.set(this.#key(doc.folder), Math.round(total * 1e6) / 1e6)
  }

  #emit(): void {
    if (this.#emitQueued || this.#closed) return
    this.#emitQueued = true
    queueMicrotask(() => {
      this.#emitQueued = false
      if (this.#closed) return
      this.#d.bus.global({ kind: 'queue', view: this.view() })
    })
  }

  // ---- edits ------------------------------------------------------------------------------------------------------

  #doc(folder: string): FolderQueueDoc {
    return this.#docs.get(this.#key(folder)) ?? emptyQueue(folder)
  }

  async #save(doc: FolderQueueDoc): Promise<void> {
    this.#docs.set(this.#key(doc.folder), doc)
    await saveQueue(this.#d.home, doc)
  }

  /** Apply an event to a folder's queue, save it, record a pause, and say what happened. */
  async #apply(folder: string, ev: QueueEvent): Promise<ReturnType<typeof reduceQueue>> {
    const r = reduceQueue(this.#doc(folder), ev)
    if (r.doc !== this.#docs.get(this.#key(folder))) await this.#save(r.doc)
    if (r.paused !== undefined) await this.#onPaused(folder, r.paused)
    if (r.finished === true) this.#d.log.info('queue finished', { folder })
    this.#emit()
    return r
  }

  async #onPaused(folder: string, p: QueuePause): Promise<void> {
    this.#d.log.info('queue paused', { folder, reason: p.reason })
    await this.#ledger((l) => l.pauses.push({ at: p.at, folder, text: p.text }))
    this.#d.bus.global({ kind: 'toast', level: 'warn', message: `Queue paused: ${p.text}` })
  }

  async #ledger(fn: (l: DayLedger) => void): Promise<void> {
    const date = localDate(this.#d.clock.now())
    const l = await readLedger(this.#d.home, date)
    fn(l)
    await writeLedger(this.#d.home, l).catch((err: unknown) =>
      this.#d.log.warn('ledger write failed', { err }),
    )
    this.#reportSoon()
  }

  /** Add tasks. `easy`: Easy mode queued it (its overrides layer and brief travel with it; never over IPC's queue.add). */
  add(
    folder: string,
    tasks: { task: string; recipe?: string; easy?: QueueEasyRun; rematch?: QueueRematch }[],
  ): Promise<QueueView> {
    return this.#edit(folder, async () => {
      const list = tasks.map((t) => {
        const text = t.task.replace(/\r\n?/g, '\n').trim()
        if (text === '') throw new DimFactoryError('VALIDATION', 'A task needs some text.')
        if (text.length > QUEUE_TASK_TEXT_MAX)
          throw new DimFactoryError('VALIDATION', `A task may be at most ${QUEUE_TASK_TEXT_MAX} characters.`)
        return { text, recipe: t.recipe, easy: t.easy, rematch: t.rematch }
      })
      const doc = this.#doc(folder)
      if (doc.tasks.length + list.length > QUEUE_TASKS_MAX)
        throw new DimFactoryError('VALIDATION', `A queue holds at most ${QUEUE_TASKS_MAX} tasks.`)
      const news: NewTask[] = list.map((t) => ({
        id: uniqueId(),
        task: t.text,
        ...(t.recipe !== undefined ? { recipe: t.recipe } : {}),
        ...(t.easy !== undefined ? { easy: t.easy } : {}),
        ...(t.rematch !== undefined ? { rematch: t.rematch } : {}),
        source: { kind: 'manual' },
      }))
      await this.#apply(folder, { t: 'add', tasks: news, at: this.#d.clock.now() })
      await this.#pump()
    })
  }

  /** Add imported tasks, leaving out what the queue already has (same text, or the same issue). */
  importTasks(folder: string, from: string, tasks: Omit<NewTask, 'id'>[]): Promise<QueueImportResult> {
    let result: QueueImportResult = { added: 0, skipped: 0, overLimit: 0, from }
    return this.#edit(folder, async () => {
      const doc = this.#doc(folder)
      const texts = new Set(doc.tasks.map((t) => t.task))
      const issues = new Set(doc.tasks.flatMap((t) => (t.source.kind === 'github' ? [t.source.number] : [])))
      const fresh = tasks.filter((t) => {
        if (t.source.kind === 'github') return !issues.has(t.source.number)
        return !texts.has(t.task)
      })
      const room = Math.max(0, Math.min(QUEUE_IMPORT_MAX, QUEUE_TASKS_MAX - doc.tasks.length))
      const take = fresh.slice(0, room)
      result = {
        added: take.length,
        skipped: tasks.length - fresh.length,
        overLimit: fresh.length - take.length,
        from,
      }
      if (take.length > 0) {
        await this.#apply(folder, {
          t: 'add',
          tasks: take.map((t) => ({ ...t, id: uniqueId() })),
          at: this.#d.clock.now(),
        })
        await this.#pump()
      }
    }).then(() => result)
  }

  remove(folder: string, id: string): Promise<QueueView> {
    return this.#edit(folder, async () => {
      const t = this.#doc(folder).tasks.find((x) => x.id === id)
      if (t === undefined) throw new DimFactoryError('NOT_FOUND', 'That task is not in the queue.')
      if (t.status === 'running' || t.status === 'waiting')
        throw new DimFactoryError(
          'CONFLICT',
          `Its run (#${t.displayNo ?? ''}) is working. Stop the run first.`,
        )
      await this.#apply(folder, { t: 'remove', id })
    })
  }

  move(folder: string, id: string, to: number): Promise<QueueView> {
    return this.#edit(folder, async () => {
      if (!this.#doc(folder).tasks.some((x) => x.id === id))
        throw new DimFactoryError('NOT_FOUND', 'That task is not in the queue.')
      await this.#apply(folder, { t: 'move', id, to })
    })
  }

  retry(folder: string, id: string): Promise<QueueView> {
    return this.#edit(folder, async () => {
      const t = this.#doc(folder).tasks.find((x) => x.id === id)
      if (t === undefined) throw new DimFactoryError('NOT_FOUND', 'That task is not in the queue.')
      if (t.status !== 'failed' && t.status !== 'stopped' && t.status !== 'blocked')
        throw new DimFactoryError('CONFLICT', 'Only a failed, stopped or blocked task can be retried.')
      await this.#apply(folder, { t: 'retry', id })
      await this.#pump()
    })
  }

  clearFinished(folder: string): Promise<QueueView> {
    return this.#edit(folder, async () => {
      await this.#apply(folder, { t: 'clear-finished' })
    })
  }

  #edit(folder: string, fn: () => Promise<void>): Promise<QueueView> {
    return this.#enqueue(fn).then(() => {
      this.#estimates.delete(this.#key(folder))
      return this.view()
    })
  }

  /**
   * Start (or resume) the queues of `folders` (every queue with something pending when absent). `noticeId`: the
   * launch notice this answers (it is dismissed).
   */
  start(folders?: string[], o: { noticeId?: string; scheduled?: boolean } = {}): Promise<QueueView> {
    return this.#enqueue(async () => {
      const targets =
        folders ??
        [...this.#docs.values()]
          .filter((d) => d.tasks.some((t) => t.status === 'pending') && d.state !== 'running')
          .map((d) => d.folder)
      const now = this.#d.clock.now()
      for (const f of targets) {
        if (this.#doc(f).tasks.length === 0)
          throw new DimFactoryError('VALIDATION', 'This queue has no tasks.')
        await this.#apply(f, { t: 'start', at: now, ...(o.scheduled === true ? { scheduled: true } : {}) })
      }
      if (o.noticeId !== undefined && this.#state.notice?.id === o.noticeId) {
        delete this.#state.notice
        await writeFactoryState(this.#d.home, this.#state)
      }
      await this.#pump()
    }).then(() => this.view())
  }

  /** Pause the queues of `folders` (every running one when absent). Runs already working go on. */
  pause(folders?: string[]): Promise<QueueView> {
    return this.#enqueue(async () => {
      const targets =
        folders ?? [...this.#docs.values()].filter((d) => d.state === 'running').map((d) => d.folder)
      const now = this.#d.clock.now()
      for (const f of targets) {
        await this.#apply(f, {
          t: 'pause',
          pause: {
            reason: 'user',
            text: 'You paused the queue. Tasks already running go on; resume it to start the next.',
            at: now,
          },
        })
      }
    }).then(() => this.view())
  }

  dismissNotice(id: string): Promise<QueueView> {
    return this.#enqueue(async () => {
      if (this.#state.notice?.id !== id) return
      delete this.#state.notice
      await writeFactoryState(this.#d.home, this.#state)
      this.#emit()
    }).then(() => this.view())
  }

  // ---- the daily report -------------------------------------------------------------------------------------------

  /** The day's report (default today), written to reports/<date>.md now. */
  async report(date?: string): Promise<DailyReportView> {
    const d = date ?? localDate(this.#d.clock.now())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d))
      throw new DimFactoryError('VALIDATION', 'A date looks like 2026-10-24.')
    const file = reportFile(this.#d.home, d)
    const view = buildReport({
      date: d,
      summaries: this.#d.summaries(),
      ledger: await readLedger(this.#d.home, d),
      file,
    })
    await writeFileAtomic(file, view.markdown, { mode: 0o600 })
    return view
  }

  #reportSoon(): void {
    if (this.#reportTimer !== undefined || this.#closed) return
    this.#reportTimer = setTimeout(() => {
      this.#reportTimer = undefined
      void this.report().catch((err: unknown) => this.#d.log.warn('daily report write failed', { err }))
    }, 1000)
    this.#reportTimer.unref()
  }

  /** A vendor fallback, for the day's report. */
  recordFallback(f: DailyReportView['fallbacks'][number]): Promise<void> {
    return this.#enqueue(() => this.#ledger((l) => l.fallbacks.push(f)))
  }

  /** Whether a run may still spend (its own cost and today's under the limits): the fallback asks before it switches. */
  withinBudget(runId: string): boolean {
    const s = this.#d.summary(runId)
    if (s === undefined) return true
    const hit = duringRun(this.#limits(), {
      runCostUsd: s.progress.costUsd,
      daySpentUsd: this.#today().spentUsd,
      startedAt: s.createdAt,
      now: this.#d.clock.now(),
      displayNo: s.displayNo,
    })
    return hit === undefined
  }

  /** The queue this run belongs to, if any. */
  isQueueRun(runId: string): boolean {
    for (const d of this.#docs.values()) if (taskOfRun(d, runId) !== undefined) return true
    return false
  }

  // ---- runs -------------------------------------------------------------------------------------------------------

  #folderOfRun(runId: string): string | undefined {
    for (const d of this.#docs.values()) if (taskOfRun(d, runId) !== undefined) return d.folder
    return undefined
  }

  async #onSummary(s: RunSummary): Promise<void> {
    const endedNow = TERMINAL.has(s.status) && !this.#ended.has(s.runId)
    if (endedNow) {
      this.#ended.add(s.runId)
      const t = this.#timeTimers.get(s.runId)
      if (t !== undefined) this.#d.clock.clearTimer(t)
      this.#timeTimers.delete(s.runId)
      await this.#d.afterRun?.(s).catch((err: unknown) => this.#d.log.warn('after-run work failed', { err }))
      this.#reportSoon()
    }
    const folder = this.#folderOfRun(s.runId)
    if (folder === undefined) {
      // A run outside the queues still spends today's budget.
      if (!TERMINAL.has(s.status)) await this.#checkDayBudget()
      return
    }
    if (!TERMINAL.has(s.status)) {
      const hit = this.#limitHit(s)
      if (hit !== undefined) await this.#stopForLimit(s, hit)
    }
    const r = this.#applyRun(folder, s, this.#d.clock.now())
    if (r !== undefined) await this.#after(folder, r)
    await this.#pump()
  }

  /** Feed a run's summary to its task; undefined when nothing changed. */
  #applyRun(folder: string, s: RunSummary, at: number): ReturnType<typeof reduceQueue> | undefined {
    const doc = this.#doc(folder)
    const l = this.#limits()
    const stoppedBy = this.#stopCauses.get(s.runId)
    const reason = TERMINAL.has(s.status) ? undefined : needsYouText(s)
    const category: FailureCategory | undefined = s.failure?.category
    const r = reduceQueue(doc, {
      t: 'run-update',
      runId: s.runId,
      status: s.status,
      ...(s.outcome !== undefined ? { outcome: s.outcome } : {}),
      costUsd: s.progress.costUsd,
      ...(reason !== undefined ? { reason } : {}),
      ...(category !== undefined ? { category } : {}),
      at,
      skipBlocked: l.skipBlocked,
      stopAfterFailures: l.stopAfterFailures,
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    })
    if (r.doc === doc) return undefined
    this.#docs.set(this.#key(folder), r.doc)
    return r
  }

  /** Save what a run update changed, record a pause, and commit a completed task's work when the project opted in. */
  async #after(folder: string, r: ReturnType<typeof reduceQueue>): Promise<void> {
    await saveQueue(this.#d.home, r.doc)
    if (r.paused !== undefined) await this.#onPaused(folder, r.paused)
    this.#emit()
    const ended = r.ended
    if (ended === undefined) return
    const t = r.doc.tasks.find((x) => x.id === ended.id)
    // A rematch's build is never applied, so there is nothing of it to commit.
    if (t?.runId === undefined || t.rematch !== undefined || this.#d.commitTask === undefined) return
    if (this.#d.summary(t.runId)?.status !== 'completed') return
    try {
      const c = await this.#d.commitTask(t.runId)
      if (c !== null)
        await this.#apply(folder, {
          t: 'committed',
          id: t.id,
          branch: c.branch,
          ...(c.commit !== undefined ? { commit: c.commit } : {}),
        })
    } catch (err) {
      await this.#apply(folder, {
        t: 'pause',
        pause: {
          reason: 'git',
          text: `The changes of run #${t.displayNo ?? ''} could not be committed to their branch: ${errorMessage(err)} Commit or move them yourself, then resume the queue.`,
          at: this.#d.clock.now(),
          taskId: t.id,
        },
      })
    }
  }

  #limitHit(s: RunSummary): LimitHit | undefined {
    const task = this.#taskOf(s.runId)
    return duringRun(this.#limits(), {
      runCostUsd: s.progress.costUsd,
      daySpentUsd: this.#today().spentUsd,
      startedAt: task?.startedAt ?? s.createdAt,
      now: this.#d.clock.now(),
      displayNo: s.displayNo,
    })
  }

  #taskOf(runId: string): QueueTask | undefined {
    for (const d of this.#docs.values()) {
      const t = taskOfRun(d, runId)
      if (t !== undefined) return t
    }
    return undefined
  }

  async #stopForLimit(s: RunSummary, hit: LimitHit): Promise<void> {
    if (this.#stopCauses.has(s.runId)) return
    const at = this.#d.clock.now()
    this.#stopCauses.set(s.runId, {
      pause: { reason: hit.reason, text: hit.text, at },
      category: hit.category ?? 'budget_exceeded',
    })
    this.#d.log.info('a queue run reached a limit; stopping it', { runId: s.runId, reason: hit.reason })
    await this.#d.stopRun(s.runId).catch((err: unknown) => this.#d.log.warn('stop failed', { err }))
    // Today's budget is every queue's: the others pause too.
    if (hit.reason === 'day-budget') await this.#pauseAllFor(hit, at)
  }

  async #pauseAllFor(hit: LimitHit, at: number): Promise<void> {
    for (const d of [...this.#docs.values()]) {
      if (d.state !== 'running') continue
      await this.#apply(d.folder, { t: 'pause', pause: { reason: hit.reason, text: hit.text, at } })
    }
  }

  /** Runs outside the queues spend today's budget too: once it is spent, running queue runs stop. */
  async #checkDayBudget(): Promise<void> {
    const cap = this.#limits().maxCostPerDayUsd
    if (cap === null) return
    for (const d of this.#docs.values())
      for (const t of d.tasks) {
        if (t.runId === undefined || (t.status !== 'running' && t.status !== 'waiting')) continue
        const s = this.#d.summary(t.runId)
        if (s === undefined || TERMINAL.has(s.status)) continue
        const hit = this.#limitHit(s)
        if (hit !== undefined) await this.#stopForLimit(s, hit)
      }
  }

  #armTimeLimit(runId: string, startedAt: number): void {
    const at = timeLimitAt(this.#limits(), startedAt)
    const prev = this.#timeTimers.get(runId)
    if (prev !== undefined) this.#d.clock.clearTimer(prev)
    this.#timeTimers.delete(runId)
    if (at === undefined) return
    const timer = this.#d.clock.setTimer(() => {
      this.#timeTimers.delete(runId)
      void this.#enqueue(async () => {
        const s = this.#d.summary(runId)
        if (s === undefined || TERMINAL.has(s.status)) return
        const hit = this.#limitHit(s)
        if (hit !== undefined) await this.#stopForLimit(s, hit)
      })
    }, at)
    ;(timer as { unref?: () => void }).unref?.()
    this.#timeTimers.set(runId, timer)
  }

  async #onSettings(): Promise<void> {
    // New limits apply at once (a time limit to the runs working now), and the schedule is looked at again.
    for (const d of this.#docs.values())
      for (const t of d.tasks)
        if (
          t.runId !== undefined &&
          t.startedAt !== undefined &&
          (t.status === 'running' || t.status === 'waiting')
        )
          this.#armTimeLimit(t.runId, t.startedAt)
    if (this.#d.schedule) this.#armSchedule()
    this.#emit()
    await this.#pump()
  }

  // ---- starting tasks ---------------------------------------------------------------------------------------------

  /** Start every task that may start now, within the limits. */
  async #pump(): Promise<void> {
    if (this.#suspended || this.#closed) return
    const l = this.#limits()
    let working = 0
    // Easy's overnight list makes one project after another: one Easy task works at a time, over every folder.
    let easyWorking = 0
    for (const d of this.#docs.values())
      for (const t of d.tasks)
        if (t.status === 'running' || t.status === 'waiting') {
          working++
          if (t.easy !== undefined) easyWorking++
        }
    for (const doc of [...this.#docs.values()]) {
      for (;;) {
        if (working >= l.maxParallel) return
        const cur = this.#doc(doc.folder)
        const next = nextTask(cur, { isolate: l.isolate })
        if (next === undefined) break
        if (next.easy !== undefined && easyWorking > 0) break
        // A rematch is started as a rematch (its settings are the replayed run's own); a task as runs.start would.
        const rematch = next.rematch
        let est: number | null = null
        let start: () => Promise<RunStarted & { matchId?: string }>
        if (rematch !== undefined) {
          if (l.maxCostPerDayUsd !== null) {
            est = (await this.#d.estimateRematch?.(rematch.runId).catch(() => null)) ?? null
          }
          start = () =>
            this.#d.startRematch?.(rematch) ??
            Promise.reject(new Error('A rematch cannot be started from here'))
        } else {
          const req: RunStartRequest = {
            folder: cur.folder,
            task: next.task,
            ...(next.recipe !== undefined ? { recipe: next.recipe } : {}),
            ...(next.easy?.brief !== undefined ? { brief: structuredClone(next.easy.brief) } : {}),
          }
          const overrides =
            next.easy !== undefined
              ? await this.#easyOverridesFor(cur.folder, next, next.easy, l)
              : await this.#overridesFor(cur.folder, next, l)
          if (overrides !== undefined) req.overrides = overrides
          if (l.maxCostPerDayUsd !== null) est = await this.#d.estimate(req).catch(() => null)
          start = () => this.#d.startRun(req)
        }
        const hit = beforeStart(l, { daySpentUsd: this.#today().spentUsd, estimateUsd: est })
        if (hit !== undefined) {
          await this.#pauseAllFor(hit, this.#d.clock.now())
          return
        }
        let started: RunStarted & { matchId?: string }
        try {
          started = await start()
        } catch (err) {
          await this.#apply(cur.folder, {
            t: 'task-not-started',
            id: next.id,
            reason: errorMessage(err)
              .replace(/\s*$/, '')
              .replace(/([^.!?])$/, '$1.'),
            at: this.#d.clock.now(),
          })
          break
        }
        const at = this.#d.clock.now()
        await this.#apply(cur.folder, {
          t: 'task-started',
          id: next.id,
          runId: started.runId,
          displayNo: started.displayNo,
          at,
          ...(started.matchId !== undefined ? { matchId: started.matchId } : {}),
        })
        await this.#ledger((x) => {
          if (!x.queueRuns.includes(started.runId)) x.queueRuns.push(started.runId)
        })
        this.#armTimeLimit(started.runId, at)
        working++
        if (next.easy !== undefined) easyWorking++
        // The run may have moved on before the task knew its id.
        const s = this.#d.summary(started.runId)
        if (s !== undefined) {
          const r = this.#applyRun(cur.folder, s, at)
          if (r !== undefined) await this.#after(cur.folder, r)
        }
      }
    }
  }

  /**
   * The run overrides an Easy task runs with: its own layer as Easy made it (never Auto, never an isolated copy or a run
   * branch: a new Easy folder has no commit yet), with Fix rounds and the Fix budget never above the factory's limits
   * when the user set them.
   */
  async #easyOverridesFor(
    folder: string,
    t: QueueTask,
    easy: QueueEasyRun,
    l: FactorySettings,
  ): Promise<RunOverrides> {
    const o: RunOverrides = structuredClone(easy.overrides)
    o.auto = false
    if (l.maxFixRounds === null && l.maxCostPerRunUsd === null) return o
    const cfg = await this.#d.folderConfig(folder, t.recipe).catch(() => null)
    if (cfg === null) return o
    const own = o.passes?.fix ?? {}
    const fix: NonNullable<NonNullable<RunOverrides['passes']>['fix']> = { ...own }
    const base = own.rounds ?? cfg.passes.fix.rounds
    const rounds = l.maxFixRounds !== null ? Math.min(base, l.maxFixRounds) : base
    if (rounds !== base) fix.rounds = rounds
    if (rounds > 1 && l.maxCostPerRunUsd !== null) {
      const cur = own.maxCostUsd ?? cfg.passes.fix.maxCostUsd
      fix.maxCostUsd = cur === null ? l.maxCostPerRunUsd : Math.min(cur, l.maxCostPerRunUsd)
    }
    if (Object.keys(fix).length > 0) o.passes = { ...o.passes, fix }
    return o
  }

  /**
   * The run overrides a queued task runs with: Auto when the factory runs tasks in Auto, an isolated copy when it
   * isolates them, else a run branch when the project opted into commits (so each task's work lands on its own
   * branch), and Fix rounds and the Fix budget never above the factory's limits (never above the run's own either).
   */
  async #overridesFor(folder: string, t: QueueTask, l: FactorySettings): Promise<RunOverrides | undefined> {
    const cfg = await this.#d.folderConfig(folder, t.recipe).catch(() => null)
    const o: RunOverrides = {}
    if (l.auto) o.auto = true
    if (l.isolate) o.isolation = { mode: 'worktree' }
    else if (
      cfg !== null &&
      cfg.git.commit &&
      cfg.isolation.mode === 'inPlace' &&
      cfg.isolation.branch === 'none'
    )
      o.isolation = { branch: 'runBranch' }
    if (cfg !== null) {
      const fix: NonNullable<NonNullable<RunOverrides['passes']>['fix']> = {}
      const rounds =
        l.maxFixRounds !== null ? Math.min(cfg.passes.fix.rounds, l.maxFixRounds) : cfg.passes.fix.rounds
      if (rounds !== cfg.passes.fix.rounds) fix.rounds = rounds
      if (rounds > 1 && l.maxCostPerRunUsd !== null) {
        const own = cfg.passes.fix.maxCostUsd
        const cap = own === null ? l.maxCostPerRunUsd : Math.min(own, l.maxCostPerRunUsd)
        if (cap !== own) fix.maxCostUsd = cap
      }
      if (Object.keys(fix).length > 0) o.passes = { fix }
    }
    return Object.keys(o).length > 0 ? o : undefined
  }

  // ---- the schedule -----------------------------------------------------------------------------------------------

  #armSchedule(): void {
    if (this.#scheduleTimer !== undefined) this.#d.clock.clearTimer(this.#scheduleTimer)
    this.#scheduleTimer = undefined
    if (this.#closed) return
    const at = nextScheduleEvent(this.#limits().schedule, this.#d.clock.now())
    if (at === undefined) return
    // One second past the boundary, so the window reads open (or closed) when the timer fires.
    const timer = this.#d.clock.setTimer(() => {
      this.#scheduleTimer = undefined
      void this.#enqueue(async () => {
        await this.#scheduleTick()
        this.#armSchedule()
      })
    }, at + 1000)
    ;(timer as { unref?: () => void }).unref?.()
    this.#scheduleTimer = timer
  }

  /** The folders a schedule window starts: those with something pending, not held by a reason only you can clear. */
  #scheduledFolders(): string[] {
    const resumable = new Set(['window-ended', 'relaunch'])
    return [...this.#docs.values()]
      .filter((d) => d.tasks.some((t) => t.status === 'pending'))
      .filter((d) => d.state !== 'paused' || (d.pause !== undefined && resumable.has(d.pause.reason)))
      .map((d) => d.folder)
  }

  /** The schedule while Dim Factory runs: a window that opens starts the queues; one that closes pauses them. */
  async #scheduleTick(): Promise<void> {
    if (!this.#d.schedule) return
    const now = this.#d.clock.now()
    const l = this.#limits()
    const w = scheduleWindow(l.schedule, now)
    if (!w.open) {
      this.#waiting = undefined
      for (const d of [...this.#docs.values()]) {
        if (d.scheduled !== true || d.state !== 'running') continue
        await this.#apply(d.folder, {
          t: 'pause',
          pause: {
            reason: 'window-ended',
            text: 'The schedule window closed. Tasks already running go on; the queue goes on in the next window, or resume it now.',
            at: now,
          },
        })
      }
      return
    }
    if (w.openedAt === undefined || this.#state.handledWindow === w.openedAt) return
    if (this.#suspended) {
      this.#waiting = 'sleep'
      return
    }
    if (this.#onBattery && !l.schedule.onBattery) {
      this.#waiting = 'battery'
      this.#emit()
      return
    }
    this.#waiting = undefined
    this.#state.handledWindow = w.openedAt
    await writeFactoryState(this.#d.home, this.#state)
    const folders = this.#scheduledFolders()
    for (const f of folders) await this.#apply(f, { t: 'start', at: now, scheduled: true })
    if (folders.length > 0) this.#d.log.info('the schedule started the queues', { folders: folders.length })
    await this.#pump()
  }

  /**
   * At launch: a window that is open now and was not handled yet (Dim Factory was closed when it opened, or the
   * computer was off). With "resume automatically" the queues go on (interrupted runs still wait for you); without
   * it, a notice asks.
   */
  async #launchSchedule(now: number): Promise<void> {
    const l = this.#limits()
    const w = scheduleWindow(l.schedule, now)
    if (!w.open || w.openedAt === undefined || this.#state.handledWindow === w.openedAt) return
    const folders = this.#scheduledFolders()
    if (folders.length === 0) return
    this.#state.handledWindow = w.openedAt
    const since = new Date(w.openedAt)
    const hhmm = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`
    const n = folders.length
    const queues = n === 1 ? 'the queue' : `${n} queues`
    let notice: FactoryNotice
    if (l.schedule.resumeAutomatically) {
      for (const f of folders) await this.#apply(f, { t: 'start', at: now, scheduled: true })
      notice = {
        id: `n${now.toString(36)}`,
        kind: 'resumed',
        at: now,
        text: `The schedule was due at ${hhmm}, so ${queues} went on by itself ("resume automatically" is on). Runs that were interrupted still wait for you.`,
        folders,
      }
    } else {
      notice = {
        id: `n${now.toString(36)}`,
        kind: 'schedule-due',
        at: now,
        text: `The schedule was due at ${hhmm} while Dim Factory was closed. Start ${queues} now? Nothing runs until you do.`,
        folders,
      }
    }
    this.#state.notice = notice
    await writeFactoryState(this.#d.home, this.#state)
    this.#d.log.info('a due schedule at launch', { kind: notice.kind, folders: n })
    if (notice.kind === 'resumed') await this.#pump()
  }
}
