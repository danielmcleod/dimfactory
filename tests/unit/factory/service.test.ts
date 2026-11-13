// The factory service (factory/service.ts) on fake deps: no vendor runs, a fake bus, a manual clock and a temp home.
// Runs are summaries the test publishes; startRun and stopRun are recorded.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventBus, GlobalEvent } from '@core/bus/bus.ts'
import { DimFactoryError } from '@core/errors.ts'
import { silentLogger } from '@core/log.ts'
import { FactoryService } from '@core/factory/service.ts'
import type { FactoryDeps } from '@core/factory/service.ts'
import { emptyQueue, reduceQueue } from '@core/factory/model.ts'
import { saveQueue } from '@core/factory/store.ts'
import type { Clock, TimerHandle } from '@core/supervisor/effects.ts'
import { FACTORY_DEFAULTS } from '@shared/config-schema.ts'
import type { FactorySettings, ResolvedConfig } from '@shared/config-schema.ts'
import type { RunStartRequest } from '@shared/ipc.ts'
import type { RunStatus, RunSummary } from '@shared/run.ts'

const dirs: string[] = []
const services: FactoryService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A clock the test moves; timers fire when it passes their time. */
function manualClock(start: number): Clock & { advance(ms: number): number } {
  let now = start
  let seq = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  return {
    now: () => now,
    setTimer: (fn, at) => {
      const id = ++seq
      timers.set(id, { fn, at })
      return id as unknown as TimerHandle
    },
    clearTimer: (h) => {
      timers.delete(h as unknown as number)
    },
    scale: 1,
    advance: (ms) => {
      now += ms
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue
        timers.delete(id)
        t.fn()
      }
      return now
    },
  }
}

function fakeBus(): EventBus & { events: GlobalEvent[] } {
  const sinks = new Set<{ global?: (e: GlobalEvent) => void }>()
  const events: GlobalEvent[] = []
  return {
    events,
    attach: (s: { global?: (e: GlobalEvent) => void }) => {
      sinks.add(s)
      return () => sinks.delete(s)
    },
    global: (e: GlobalEvent) => {
      events.push(e)
      for (const s of sinks) s.global?.(e)
    },
  } as unknown as EventBus & { events: GlobalEvent[] }
}

interface Config {
  commit?: boolean
  rounds?: number
  maxCostUsd?: number | null
}

const at = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime()

function world(o: {
  settings?: Partial<FactorySettings>
  config?: Config
  estimate?: number | null
  now?: number
  schedule?: boolean
  home?: string
  refuse?: string
}) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'dimf-factory-'))
  if (o.home === undefined) dirs.push(home)
  const clock = manualClock(o.now ?? at(24, 12))
  const bus = fakeBus()
  const runs = new Map<string, RunSummary>()
  const starts: RunStartRequest[] = []
  const stops: string[] = []
  let n = 0
  const summary = (runId: string, status: RunStatus, extra: Partial<RunSummary> = {}): RunSummary => {
    const prev = runs.get(runId)
    const s: RunSummary = {
      ...(prev ?? {
        runId,
        displayNo: 0,
        folder: '/f',
        folderKey: 'k',
        title: 't',
        phase: 'planning',
        profile: 'balanced',
        auto: false,
        isolation: 'inPlace',
        pinned: false,
        createdAt: clock.now(),
        progress: { tokens: 0, costUsd: 0, filesChanged: 0 },
        findings: { must: 0, should: 0 },
        steps: [],
      }),
      status,
      ...extra,
    }
    runs.set(runId, s)
    return s
  }
  const settings: FactorySettings = {
    ...structuredClone(FACTORY_DEFAULTS),
    ...o.settings,
    schedule: { ...structuredClone(FACTORY_DEFAULTS.schedule), ...o.settings?.schedule },
  }
  const c = o.config ?? {}
  const deps: FactoryDeps = {
    home,
    clock,
    log: silentLogger,
    bus,
    settings: () => settings,
    folderConfig: () =>
      Promise.resolve({
        git: { commit: c.commit ?? false, pullRequest: false, remote: 'origin' },
        isolation: { mode: 'inPlace', branch: 'none' },
        passes: { fix: { rounds: c.rounds ?? 1, maxCostUsd: c.maxCostUsd ?? null } },
      } as unknown as ResolvedConfig),
    startRun: (req) => {
      if (o.refuse !== undefined) return Promise.reject(new DimFactoryError('PREFLIGHT_BLOCKED', o.refuse))
      n++
      starts.push(req)
      const runId = `r${n}`
      summary(runId, 'running', { displayNo: n, folder: req.folder })
      return Promise.resolve({ runId, displayNo: n })
    },
    stopRun: (runId) => {
      stops.push(runId)
      return Promise.resolve()
    },
    summaries: () => [...runs.values()],
    summary: (id) => runs.get(id),
    estimate: () => Promise.resolve(o.estimate ?? null),
    schedule: o.schedule ?? false,
  }
  const service = new FactoryService(deps)
  services.push(service)
  /** Publish a run's new summary and wait for the service to take it. */
  const publish = async (
    runId: string,
    status: RunStatus,
    extra: Partial<RunSummary> = {},
  ): Promise<void> => {
    bus.global({ kind: 'run-summary', summary: summary(runId, status, extra) })
    await service.settled()
  }
  return { home, clock, bus, runs, starts, stops, service, publish, settings, summary }
}

const tasks = (...names: string[]): { task: string }[] => names.map((task) => ({ task }))

describe('starting tasks', () => {
  it('adding starts nothing; start runs the first task only; its end starts the next', async () => {
    const w = world({})
    await w.service.init()
    await w.service.add('/a', tasks('one', 'two'))
    expect(w.starts).toEqual([])
    const v = await w.service.start()
    expect(w.starts.map((r) => r.task)).toEqual(['one'])
    expect(v.folders[0]?.tasks.map((t) => t.status)).toEqual(['running', 'pending'])
    await w.publish('r1', 'completed', { outcome: 'clean' })
    expect(w.starts.map((r) => r.task)).toEqual(['one', 'two'])
    await w.publish('r2', 'completed', { outcome: 'fixed' })
    const end = w.service.view().folders[0]
    expect(end?.state).toBe('idle')
    expect(end?.tasks.map((t) => [t.status, t.outcome])).toEqual([
      ['done', 'clean'],
      ['done', 'fixed'],
    ])
    // The queue view goes out as an event.
    await Promise.resolve()
    expect(w.bus.events.some((e) => e.kind === 'queue')).toBe(true)
  })

  it('maxParallel caps the runs over every folder; isolated copies let one folder run several', async () => {
    const w = world({ settings: { maxParallel: 1 } })
    await w.service.init()
    await w.service.add('/a', tasks('a1'))
    await w.service.add('/b', tasks('b1'))
    await w.service.start()
    expect(w.starts.map((r) => r.task)).toEqual(['a1'])
    await w.publish('r1', 'completed', { outcome: 'clean' })
    expect(w.starts.map((r) => r.task)).toEqual(['a1', 'b1'])

    const iso = world({ settings: { isolate: true, maxParallel: 2 } })
    await iso.service.init()
    await iso.service.add('/a', tasks('x', 'y', 'z'))
    await iso.service.start()
    expect(iso.starts.map((r) => [r.task, r.overrides])).toEqual([
      ['x', { isolation: { mode: 'worktree' } }],
      ['y', { isolation: { mode: 'worktree' } }],
    ])
  })

  it("runs with the factory's overrides: Auto, fix rounds and the Fix budget capped, a run branch for commits", async () => {
    const w = world({
      settings: { auto: true, maxFixRounds: 2, maxCostPerRunUsd: 5 },
      config: { rounds: 3, maxCostUsd: null, commit: true },
    })
    await w.service.init()
    await w.service.add('/a', tasks('one'))
    await w.service.start()
    expect(w.starts[0]?.overrides).toEqual({
      auto: true,
      isolation: { branch: 'runBranch' },
      passes: { fix: { rounds: 2, maxCostUsd: 5 } },
    })
    // Nothing to cap: no overrides at all.
    const plain = world({})
    await plain.service.init()
    await plain.service.add('/a', tasks('one'))
    await plain.service.start()
    expect(plain.starts[0]?.overrides).toBeUndefined()
  })

  it('a task that cannot start fails and pauses its queue (preflight)', async () => {
    const w = world({ refuse: 'Codex is not signed in' })
    await w.service.init()
    await w.service.add('/a', tasks('one', 'two'))
    await w.service.start()
    const q = w.service.view().folders[0]
    expect(q?.tasks.map((t) => t.status)).toEqual(['failed', 'pending'])
    expect(q?.tasks[0]?.reason).toBe('Codex is not signed in.')
    expect(q?.pause).toMatchObject({
      reason: 'preflight',
      text: '"one" could not start: Codex is not signed in. Fix it, then resume the queue (or retry the task).',
    })
  })
})

describe('limits', () => {
  it('a run past the cost per run is stopped, and its end pauses the queue (run-budget)', async () => {
    const w = world({ settings: { maxCostPerRunUsd: 1 } })
    await w.service.init()
    await w.service.add('/a', tasks('one', 'two'))
    await w.service.start()
    await w.publish('r1', 'running', { progress: { tokens: 1, costUsd: 1.5, filesChanged: 0 } })
    expect(w.stops).toEqual(['r1'])
    await w.publish('r1', 'cancelled')
    const q = w.service.view().folders[0]
    expect(q?.state).toBe('paused')
    expect(q?.pause?.reason).toBe('run-budget')
    expect(q?.tasks.map((t) => [t.status, t.category])).toEqual([
      ['stopped', 'budget_exceeded'],
      ['pending', undefined],
    ])
    expect(w.starts).toHaveLength(1)
    // A toast says why.
    expect(
      w.bus.events.some((e) => e.kind === 'toast' && e.message.startsWith('Queue paused: Run #1 cost $1.50')),
    ).toBe(true)
  })

  it('a spent daily budget (other runs count too) pauses every running queue before a task starts', async () => {
    const w = world({ settings: { maxCostPerDayUsd: 2 } })
    w.summary('other', 'completed', {
      outcome: 'clean',
      progress: { tokens: 1, costUsd: 2.5, filesChanged: 0 },
    })
    await w.service.init()
    await w.service.add('/a', tasks('one'))
    await w.service.add('/b', tasks('two'))
    await w.service.start()
    expect(w.starts).toEqual([])
    const v = w.service.view()
    expect(v.folders.map((f) => [f.state, f.pause?.reason])).toEqual([
      ['paused', 'day-budget'],
      ['paused', 'day-budget'],
    ])
    expect(v.today).toMatchObject({ spentUsd: 2.5, runs: 1, done: 1 })
  })

  it('an estimate that would pass the daily budget also waits', async () => {
    const w = world({ settings: { maxCostPerDayUsd: 2 }, estimate: 3 })
    await w.service.init()
    await w.service.add('/a', tasks('one'))
    await w.service.start()
    expect(w.starts).toEqual([])
    expect(w.service.view().folders[0]?.pause?.text).toContain('The next task is estimated at $3.00')
  })

  it('the time limit stops a run when the clock passes it', async () => {
    const w = world({ settings: { maxMinutesPerRun: 30 } })
    await w.service.init()
    await w.service.add('/a', tasks('one'))
    await w.service.start()
    w.clock.advance(29 * 60_000)
    await w.service.settled()
    expect(w.stops).toEqual([])
    w.clock.advance(2 * 60_000)
    await w.service.settled()
    expect(w.stops).toEqual(['r1'])
    await w.publish('r1', 'cancelled')
    expect(w.service.view().folders[0]?.tasks[0]).toMatchObject({ status: 'stopped', category: 'time_limit' })
  })

  it('withinBudget answers for the fallback', async () => {
    const w = world({ settings: { maxCostPerRunUsd: 1 } })
    await w.service.init()
    w.summary('x', 'running', { progress: { tokens: 1, costUsd: 0.5, filesChanged: 0 } })
    expect(w.service.withinBudget('x')).toBe(true)
    w.summary('x', 'running', { progress: { tokens: 1, costUsd: 1.5, filesChanged: 0 } })
    expect(w.service.withinBudget('x')).toBe(false)
    expect(w.service.withinBudget('unknown')).toBe(true)
  })
})

describe('sleep, relaunch and the schedule', () => {
  it('no task starts while the machine sleeps; the wake starts it', async () => {
    const w = world({})
    await w.service.init()
    await w.service.add('/a', tasks('one'))
    await w.service.power('suspend')
    await w.service.start()
    expect(w.starts).toEqual([])
    await w.service.power('resume')
    expect(w.starts.map((r) => r.task)).toEqual(['one'])
  })

  it('a queue that was running comes back paused (relaunch); its task follows its run as it is now', async () => {
    const w = world({})
    let doc = reduceQueue(emptyQueue('/a'), {
      t: 'add',
      at: 1,
      tasks: [{ id: 't000000000001', task: 'one', source: { kind: 'manual' } }],
    }).doc
    doc = reduceQueue(doc, { t: 'start', at: 2 }).doc
    doc = reduceQueue(doc, { t: 'task-started', id: 't000000000001', runId: 'old', displayNo: 4, at: 3 }).doc
    await saveQueue(w.home, doc)
    w.summary('old', 'paused', { displayNo: 4 })
    await w.service.init()
    const q = w.service.view().folders[0]
    expect(q?.state).toBe('paused')
    expect(q?.pause).toMatchObject({
      reason: 'relaunch',
      text: 'Dim Factory was closed while this queue ran. Resume it to go on with the next task.',
    })
    expect(q?.tasks[0]).toMatchObject({
      status: 'waiting',
      reason: 'Run #4 is paused. Resume or stop it to go on.',
    })
    expect(w.starts).toEqual([])
  })

  const SCHEDULE = { enabled: true, start: '22:00', end: '06:00', days: [0, 1, 2, 3, 4, 5, 6] }

  async function queued(home: string): Promise<void> {
    const doc = reduceQueue(emptyQueue('/a'), {
      t: 'add',
      at: 1,
      tasks: [{ id: 't000000000001', task: 'one', source: { kind: 'manual' } }],
    }).doc
    await saveQueue(home, doc)
  }

  it('a due window at launch raises a notice and starts nothing (resume automatically off)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dimf-factory-'))
    dirs.push(home)
    await queued(home)
    const w = world({
      home,
      now: at(24, 23),
      schedule: true,
      settings: { schedule: { ...SCHEDULE, resumeAutomatically: false, onBattery: false } },
    })
    await w.service.init()
    const v = w.service.view()
    expect(v.notice).toMatchObject({ kind: 'schedule-due', folders: ['/a'] })
    expect(v.notice?.text).toBe(
      'The schedule was due at 22:00 while Dim Factory was closed. Start the queue now? Nothing runs until you do.',
    )
    expect(w.starts).toEqual([])
    // Starting with the notice's id dismisses it.
    const after = await w.service.start(v.notice?.folders, { noticeId: v.notice?.id ?? '' })
    expect(after.notice).toBeUndefined()
    expect(w.starts).toHaveLength(1)
  })

  it('with resume automatically, the due window starts the queue at launch and says so', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dimf-factory-'))
    dirs.push(home)
    await queued(home)
    const w = world({
      home,
      now: at(24, 23),
      schedule: true,
      settings: { schedule: { ...SCHEDULE, resumeAutomatically: true, onBattery: false } },
    })
    await w.service.init()
    expect(w.service.view().notice?.kind).toBe('resumed')
    expect(w.starts).toHaveLength(1)
    expect(w.service.view().folders[0]?.scheduled).toBe(true)
  })

  it('while running: the window opens and starts the queue, its end pauses it, on battery it waits', async () => {
    const w = world({
      now: at(24, 21, 59),
      schedule: true,
      settings: { schedule: { ...SCHEDULE, end: '23:00', resumeAutomatically: false, onBattery: false } },
    })
    await w.service.init()
    await w.service.add('/a', tasks('one', 'two'))
    await w.service.setOnBattery(true)
    w.clock.advance(2 * 60_000)
    await w.service.settled()
    expect(w.starts).toEqual([])
    expect(w.service.view().schedule).toMatchObject({ open: true, waiting: 'battery' })
    await w.service.setOnBattery(false)
    expect(w.starts.map((r) => r.task)).toEqual(['one'])
    w.clock.advance(60 * 60_000)
    await w.service.settled()
    expect(w.service.view().folders[0]).toMatchObject({ state: 'paused', pause: { reason: 'window-ended' } })
    await w.publish('r1', 'completed', { outcome: 'clean' })
    // The running task finished; the next waits for the next window.
    expect(w.starts).toHaveLength(1)
  })
})

describe('the daily report', () => {
  it('lists the queue runs from the ledger and writes the markdown file', async () => {
    const w = world({})
    await w.service.init()
    await w.service.add('/a', tasks('one'))
    await w.service.start()
    await w.publish('r1', 'completed', { outcome: 'clean' })
    const r = await w.service.report()
    expect(r.runs.map((x) => [x.runId, x.queued])).toEqual([['r1', true]])
    expect(r.file).toBe(join(w.home, 'reports', `${r.date}.md`))
    await expect(w.service.report('yesterday')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
