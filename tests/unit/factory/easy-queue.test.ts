// The factory's queue with Easy mode's overnight tasks (factory/service.ts): an Easy task runs with its own overrides
// layer and brief (never Auto, never an isolated copy or a run branch, whatever the factory's settings say), only one
// Easy task works at a time over every folder (one project after another), the factory's own limits still cap Fix when
// the user set them, and the task's Easy part survives a restart (the queue file).
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
import type { FactorySettings, ResolvedConfig, RunOverrides } from '@shared/config-schema.ts'
import type { QueueEasyRun } from '@shared/factory.ts'
import type { RunStartRequest } from '@shared/ipc.ts'
import type { RunStatus, RunSummary } from '@shared/run.ts'

const dirs: string[] = []
const services: FactoryService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const clock: Clock = {
  now: () => new Date(2026, 9, 25, 12).getTime(),
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

function world(settings: Partial<FactorySettings> = {}, home?: string) {
  const h = home ?? mkdtempSync(join(tmpdir(), 'dimf-easyq-'))
  if (home === undefined) dirs.push(h)
  const bus = fakeBus()
  const runs = new Map<string, RunSummary>()
  const starts: RunStartRequest[] = []
  const s: FactorySettings = { ...structuredClone(FACTORY_DEFAULTS), ...settings }
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
    stopRun: () => Promise.resolve(),
    summaries: () => [...runs.values()],
    summary: (id) => runs.get(id),
    estimate: () => Promise.resolve(null),
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
  return { home: h, service, starts, publish }
}

function summary(runId: string, folder: string, status: RunStatus): RunSummary {
  return {
    runId,
    displayNo: Number(runId.slice(1)),
    folder,
    folderKey: folder,
    title: 't',
    status,
    phase: 'planning',
    profile: 'claude-only',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt: 0,
    progress: { tokens: 0, costUsd: 0, filesChanged: 0 },
    findings: { must: 0, should: 0 },
    steps: [],
  }
}

const LAYER: RunOverrides = {
  profile: 'claude-only',
  auto: false,
  gates: { afterPlan: false, beforeFix: false },
  passes: { plan: { extensions: 'none', clarify: false, research: false } },
  limits: { maxCostUsd: null, maxMinutes: null },
}
const EASY: QueueEasyRun = { overrides: LAYER, brief: { category: 'design', fields: {} } }

describe("Easy's overnight tasks on the factory's queue", () => {
  it('run with their own layer and brief, never Auto or an isolated copy, one project after another', async () => {
    const w = world({ auto: true, isolate: true, maxParallel: 3 })
    await w.service.init()
    await w.service.add('/p/one', [{ task: 'one', recipe: 'easy-design', easy: EASY }])
    await w.service.add('/p/two', [{ task: 'two', recipe: 'easy-design', easy: EASY }])
    await w.service.add('/p/full', [{ task: 'full' }])
    await w.service.start()
    // One Easy project at a time; a Full task beside it still runs (the factory's own rules).
    expect(w.starts.map((r) => r.task).sort()).toEqual(['full', 'one'])
    const one = w.starts.find((r) => r.task === 'one')
    expect(one?.overrides).toEqual(LAYER)
    expect(one?.brief).toEqual({ category: 'design', fields: {} })
    expect(one?.recipe).toBe('easy-design')
    const full = w.starts.find((r) => r.task === 'full')
    expect(full?.overrides).toMatchObject({ auto: true, isolation: { mode: 'worktree' } })
    await w.publish('r1', 'completed')
    expect(w.starts.map((r) => r.task)).toContain('two')
    expect(w.starts.filter((r) => r.task === 'two')).toHaveLength(1)
  })

  it("the factory's limits still cap Fix when the user set them", async () => {
    const w = world({ maxFixRounds: 2, maxCostPerRunUsd: 5 })
    await w.service.init()
    await w.service.add('/p/one', [{ task: 'one', recipe: 'easy-design', easy: EASY }])
    await w.service.start()
    expect(w.starts[0]?.overrides).toEqual({
      ...LAYER,
      passes: { ...LAYER.passes, fix: { rounds: 2, maxCostUsd: 5 } },
    })
  })

  it('keeps the Easy part in the queue file', async () => {
    const w = world()
    await w.service.init()
    await w.service.add('/p/one', [{ task: 'one', recipe: 'easy-design', easy: EASY }])
    const loaded = await loadQueues(w.home)
    expect(loaded.problems).toEqual([])
    expect(loaded.docs[0]?.tasks[0]?.easy).toEqual(EASY)
  })
})
