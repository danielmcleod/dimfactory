// Shared fixtures for the history unit tests (runs history, storage): RunSummary rows,
// run folders written as run.json (a finished run made with initRunState), and a fake History host.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_TIMEOUTS } from '../../../src/shared/config-schema.ts'
import type { RunSummary, RunStatus } from '../../../src/shared/run.ts'
import type { HomePaths } from '../../../src/core/home.ts'
import { RunStore } from '../../../src/core/store/run-store.ts'
import type { RunDoc } from '../../../src/core/supervisor/controller.ts'
import { derivePhase, deriveStatus, toRunSummary } from '../../../src/core/supervisor/derive.ts'
import { initRunState } from '../../../src/core/supervisor/machine.ts'
import type { RunConfig, RunState } from '../../../src/core/supervisor/types.ts'

export const DAY = 86_400_000

export function summary(n: number, over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: `run-${n}`,
    displayNo: n,
    folder: 'C:\\repo',
    folderKey: '0123456789abcdef',
    title: `task ${n}`,
    status: 'completed',
    phase: 'done',
    profile: 'balanced',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt: 1_000 + n,
    progress: { tokens: 0, costUsd: null, filesChanged: 0 },
    findings: { must: 0, should: 0 },
    steps: [],
    ...over,
  }
}

export function runConfig(isolation: RunConfig['isolation'] = 'inPlace'): RunConfig {
  return {
    auto: false,
    gates: { afterPlan: true, beforeFix: false },
    denyPauses: false,
    timeouts: { ...DEFAULT_TIMEOUTS },
    selfHeal: true,
    isolation,
    branch: 'none',
    verify: { enabled: false, runAfter: ['implement', 'fix'], baseline: false },
    passes: {
      plan: { enabled: true, vendor: 'claude', model: 'opus', mode: 'readonly' },
      implement: { enabled: true, vendor: 'claude', model: null, mode: 'autoedit' },
      review: { enabled: false, vendor: 'claude', model: 'sonnet', mode: 'readonly' },
      critic: { enabled: false, vendor: 'claude', model: 'opus', mode: 'readonly' },
      security: { enabled: false, vendor: 'claude', model: 'opus', mode: 'readonly' },
      fix: { enabled: false, vendor: 'claude', model: null, mode: 'autoedit' },
    },
    planMode: 'native',
  }
}

export interface SeedRun {
  runId: string
  displayNo: number
  createdAt: number
  folder?: string
  folderKey?: string
  status?: RunStatus
  isolation?: RunConfig['isolation']
  /** S0 / S1 trees (a run that changed something has different ones). */
  trees?: { s0: string; s1: string }
}

/** A finished (or other status) run's state as initRunState makes it, with the fields a status needs. */
export function seedState(r: SeedRun): RunState {
  const s = initRunState({
    runId: r.runId,
    displayNo: r.displayNo,
    folder: r.folder ?? 'C:\\repo',
    folderKey: r.folderKey ?? '0123456789abcdef',
    task: `task ${r.displayNo}`,
    profile: 'claude-only',
    createdAt: r.createdAt,
    config: runConfig(r.isolation),
  })
  s.started = true
  const status = r.status ?? 'completed'
  if (status === 'completed') {
    s.endedAt = r.createdAt + 60_000
    s.outcome = 'clean'
  } else if (status === 'cancelled') {
    s.endedAt = r.createdAt + 60_000
    s.stop = { at: r.createdAt + 30_000, by: 'stop', snapshot: 'done' }
  } else if (status === 'paused') {
    s.steps.implement.status = 'paused'
  } else if (status === 'running') {
    s.steps.implement.status = 'running'
  } else if (status === 'failed') {
    s.steps.implement.status = 'failed'
  }
  // The reducer keeps these in step with the derivations; a seeded run sets them itself.
  s.status = deriveStatus(s)
  s.phase = derivePhase(s, s.status)
  // A failed run's lock is the test's to give (lockOf): R2b's failed preflight lets the folder go.
  if (s.status === 'paused' || s.status === 'running') s.lock = 'held'
  if (r.trees !== undefined) {
    s.snapshots.S0 = { label: 'S0', commit: 'a'.repeat(40), tree: r.trees.s0, at: r.createdAt + 1 }
    s.snapshots.S1 = { label: 'S1', commit: 'b'.repeat(40), tree: r.trees.s1, at: r.createdAt + 2 }
  }
  return s
}

/** Write `runs/<id>/run.json` for a seeded run; returns its doc. */
export async function writeRun(paths: HomePaths, r: SeedRun): Promise<RunDoc> {
  const state = seedState(r)
  const doc: RunDoc = {
    runId: r.runId,
    state,
    lastSeq: 0,
    scope: {
      folder: state.folder,
      scopeRoot: state.folder,
      lockKey: state.folder.toLowerCase(),
      folderKey: state.folderKey,
      isRepo: true,
    },
    createdBy: 'app',
  }
  await RunStore.create(paths, r.runId, doc)
  return doc
}

export const summaryOf = (doc: RunDoc): RunSummary => toRunSummary(doc.state)

/** A raw log file `runs/<id>/raw/<name>` last written `ageMs` ago. */
export function rawLog(paths: HomePaths, runId: string, name: string, ageMs: number, bytes = 10): string {
  const dir = paths.run(runId).rawDir
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, 'x'.repeat(bytes))
  const t = (Date.now() - ageMs) / 1000
  utimesSync(file, t, t)
  return file
}

/** Manual timers for the undo window and the scheduler. */
export class ManualTimers {
  readonly pending = new Map<number, { fn: () => void; ms: number }>()
  #next = 1
  set = (fn: () => void, ms: number): unknown => {
    const id = this.#next++
    this.pending.set(id, { fn, ms })
    return id
  }
  clear = (h: unknown): void => {
    this.pending.delete(h as number)
  }
  /** Fire every pending timer (in order) and return their delays. */
  fireAll(): number[] {
    const due = [...this.pending]
    this.pending.clear()
    for (const [, t] of due) t.fn()
    return due.map(([, t]) => t.ms)
  }
}
