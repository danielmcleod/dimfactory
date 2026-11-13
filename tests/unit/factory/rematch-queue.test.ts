// The factory's queue with rematches in it (factory/service.ts): a rematch item is started as a rematch (never through
// runs.start), the run the queue follows is the challenger's build, the day's budget counts what the replayed run cost
// before it starts, the item remembers its match, nothing of it is committed, and it survives a restart.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventBus, GlobalEvent } from '@core/bus/bus.ts'
import { silentLogger } from '@core/log.ts'
import { FactoryService } from '@core/factory/service.ts'
import type { FactoryDeps } from '@core/factory/service.ts'
import { loadQueues } from '@core/factory/store.ts'
import type { Clock, TimerHandle } from '@core/supervisor/effects.ts'
import { FACTORY_DEFAULTS } from '@shared/config-schema.ts'
import type { FactorySettings, ResolvedConfig } from '@shared/config-schema.ts'
import type { QueueRematch } from '@shared/factory.ts'
import type { RunStartRequest } from '@shared/ipc.ts'
import type { RunStatus, RunSummary } from '@shared/run.ts'

const dirs: string[] = []
const services: FactoryService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const clock: Clock = {
  now: () => new Date(2026, 10, 11, 12).getTime(),
  setTimer: () => 0 as unknown as TimerHandle,
  clearTimer: () => undefined,
  scale: 1,
}

function fakeBus(): EventBus {
  const sinks = new Set<{ global?: (e: GlobalEvent) => void }>()
  return {
    attach: (s: { global?: (e: GlobalEvent) => void }) => {
      sinks.add(s)
      return () => sinks.delete(s)
    },
    global: (e: GlobalEvent) => {
      for (const s of sinks) s.global?.(e)
    },
  } as unknown as EventBus
}

const summary = (runId: string, folder: string, status: RunStatus): RunSummary => ({
  runId,
  displayNo: Number(runId.replace(/\D/g, '')) || 1,
  folder,
  folderKey: folder,
  title: 't',
  status,
  phase: 'planning',
  profile: 'claude-only',
  auto: false,
  isolation: 'worktree',
  pinned: false,
  createdAt: clock.now(),
  progress: { tokens: 0, costUsd: 0, filesChanged: 0 },
  findings: { must: 0, should: 0 },
  steps: [],
})

function world(
  o: { settings?: Partial<FactorySettings>; estimate?: number | null; refuse?: string; home?: string } = {},
) {
  const h = o.home ?? mkdtempSync(join(tmpdir(), 'dimf-rematchq-'))
  if (o.home === undefined) dirs.push(h)
  const bus = fakeBus()
  const runs = new Map<string, RunSummary>()
  const starts: RunStartRequest[] = []
  const rematches: QueueRematch[] = []
  const commits: string[] = []
  const s: FactorySettings = { ...structuredClone(FACTORY_DEFAULTS), ...o.settings }
  const deps: FactoryDeps = {
    home: h,
    clock,
    log: silentLogger,
    bus,
    settings: () => s,
    folderConfig: () =>
      Promise.resolve({
        git: { commit: true, pullRequest: false, remote: 'origin' },
        isolation: { mode: 'inPlace', branch: 'none' },
        passes: { fix: { rounds: 3, maxCostUsd: null } },
      } as unknown as ResolvedConfig),
    startRun: (req) => {
      starts.push(req)
      const runId = `r${starts.length}`
      runs.set(runId, summary(runId, req.folder, 'running'))
      return Promise.resolve({ runId, displayNo: starts.length })
    },
    startRematch: (r) => {
      if (o.refuse !== undefined) return Promise.reject(new Error(o.refuse))
      rematches.push(r)
      const runId = `b${rematches.length}`
      runs.set(runId, summary(runId, 'C:\\work\\repo', 'running'))
      return Promise.resolve({
        runId,
        displayNo: 40 + rematches.length,
        matchId: `match-${rematches.length}`,
      })
    },
    estimateRematch: () => Promise.resolve(o.estimate ?? null),
    stopRun: () => Promise.resolve(),
    summaries: () => [...runs.values()],
    summary: (id) => runs.get(id),
    estimate: () => Promise.resolve(null),
    commitTask: (runId) => {
      commits.push(runId)
      return Promise.resolve(null)
    },
    schedule: false,
  }
  const service = new FactoryService(deps)
  services.push(service)
  const publish = async (runId: string, status: RunStatus): Promise<void> => {
    const prev = runs.get(runId)
    if (prev === undefined) throw new Error(runId)
    const next = { ...prev, status, ...(status === 'completed' ? { outcome: 'clean' as const } : {}) }
    runs.set(runId, next)
    bus.global({ kind: 'run-summary', summary: next })
    await service.settled()
  }
  return { home: h, service, starts, rematches, commits, publish }
}

const FOLDER = 'C:\\work\\repo'
const item = (n: number): { task: string; rematch: QueueRematch } => ({
  task: `Add a flag ${n}`,
  rematch: { runId: `src-${n}`, displayNo: n, challenger: { vendor: 'codex', model: 'gpt-x' }, blind: true },
})

describe('rematches in the queue', () => {
  it('starts a rematch as a rematch, one after another, and remembers each one’s match', async () => {
    const w = world()
    await w.service.init()
    await w.service.add(FOLDER, [item(1), item(2)])
    await w.service.start([FOLDER])
    await w.service.settled()
    // Never through runs.start: the settings are the replayed run's own.
    expect(w.starts).toEqual([])
    expect(w.rematches).toEqual([item(1).rematch])
    let tasks = w.service.view().folders[0]?.tasks ?? []
    expect(tasks[0]).toMatchObject({
      status: 'running',
      runId: 'b1',
      displayNo: 41,
      title: 'Add a flag 1',
      rematch: { runId: 'src-1', matchId: 'match-1', blind: true },
    })
    expect(tasks[1]).toMatchObject({ status: 'pending' })
    expect(tasks[1]?.rematch?.matchId).toBeUndefined()

    // The challenger's build ends: the next rematch starts, and nothing is committed (a rematch is never applied).
    await w.publish('b1', 'completed')
    expect(w.rematches).toHaveLength(2)
    expect(w.commits).toEqual([])
    tasks = w.service.view().folders[0]?.tasks ?? []
    expect(tasks.map((t) => t.status)).toEqual(['done', 'running'])
    expect(tasks[1]?.rematch?.matchId).toBe('match-2')
  })

  it('the day’s budget counts what the replayed run cost before a rematch starts', async () => {
    const w = world({ settings: { maxCostPerDayUsd: 5 }, estimate: 6 })
    await w.service.init()
    await w.service.add(FOLDER, [item(1)])
    await w.service.start([FOLDER])
    await w.service.settled()
    expect(w.rematches).toEqual([])
    const folder = w.service.view().folders[0]
    expect(folder?.state).toBe('paused')
    expect(folder?.tasks[0]?.status).toBe('pending')
    // Within the budget it starts.
    const ok = world({ settings: { maxCostPerDayUsd: 5 }, estimate: 2 })
    await ok.service.init()
    await ok.service.add(FOLDER, [item(1)])
    await ok.service.start([FOLDER])
    await ok.service.settled()
    expect(ok.rematches).toHaveLength(1)
  })

  it('a rematch that cannot start fails its item with the reason, as a task does', async () => {
    const w = world({
      refuse: 'Run #1’s starting snapshot was cleared, so there is nothing to replay it from',
    })
    await w.service.init()
    await w.service.add(FOLDER, [item(1)])
    await w.service.start([FOLDER])
    await w.service.settled()
    const t = w.service.view().folders[0]?.tasks[0]
    expect(t?.status).toBe('failed')
    expect(t?.reason).toBe('Run #1’s starting snapshot was cleared, so there is nothing to replay it from.')
  })

  it('tasks and rematches share a queue, and a rematch item survives a restart', async () => {
    const w = world()
    await w.service.init()
    await w.service.add(FOLDER, [{ task: 'An ordinary task' }, item(3)])
    const saved = await loadQueues(w.home)
    expect(saved.problems).toEqual([])
    expect(saved.docs.find((d) => d.folder === FOLDER)?.tasks[1]?.rematch).toEqual(item(3).rematch)
    w.service.close()
    const again = world({ home: w.home })
    await again.service.init()
    await again.service.start([FOLDER])
    await again.service.settled()
    expect(again.starts.map((r) => r.task)).toEqual(['An ordinary task'])
    await again.publish('r1', 'completed')
    expect(again.rematches).toEqual([item(3).rematch])
    // The ordinary task's run is committed as before; the rematch's is not.
    await again.publish('b1', 'completed')
    expect(again.commits).toEqual(['r1'])
  })
})
