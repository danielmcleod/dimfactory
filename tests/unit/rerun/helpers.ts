// Re-run from Fix sources built through the reducer (sessions, Re-run from Fix,
// R14): a run at its beforeFix gate, completed (fixed), cancelled at the gate, failed at Fix, paused at Fix, each with
// Implement's session, S0..S1 and findings. Everything goes through `reduce` (tests/unit/supervisor/helpers*.ts).
import { expect } from 'vitest'
import type { RunInit, RunState } from '@core/supervisor/types.ts'
import { Flow, must, should } from '../supervisor/helpers.review.ts'
import type { ReviewOptions } from '../supervisor/helpers.review.ts'
import { T0, failure } from '../supervisor/helpers.ts'

export { Flow, must, should, T0 }

export const FOLDER = 'C:\\tmp\\ts-small'

/** Review: F r1 [must], r2 [should], r3 [should]; Critic: none. The gate is open. */
export function atGate(o: ReviewOptions = {}): Flow {
  const f = new Flow(o)
  f.toJoin(['ok', [must('r1'), should('r2'), should('r3')]], ['none', []])
  f.card('gate:beforeFix')
  return f
}

/** Gate continued with `ids` (all when absent): reconcile(pre-fix), F0 and Fix spawned. */
export function fixRunning(o: ReviewOptions = {}, ids?: string[]): Flow {
  const f = atGate(o)
  f.choose('gate:beforeFix', 'continue', ids)
  f.toFixSpawned()
  return f
}

/** Fix done, S2 taken: completed (fixed). */
export function completedFixed(o: ReviewOptions = {}, ids?: string[]): Flow {
  const f = fixRunning(o, ids)
  f.ev('fix', { type: 'done', result: 'F1 fixed', usage: { input: 5, output: 5, costUsd: 0.01 } })
  f.exit('fix')
  f.reconcile('end-of-pass')
  f.snapshot('S2', 'tree-fixed')
  expect(f.state.status).toBe('completed')
  expect(f.state.outcome).toBe('fixed')
  return f
}

/** Cancel at the gate; the `stopped` snapshot lands and the lock is released. */
export function cancelledAtGate(o: ReviewOptions = {}): Flow {
  const f = atGate(o)
  f.choose('gate:beforeFix', 'cancel')
  if (f.findReq((r) => r.kind === 'snapshot' && r.label === 'stopped') !== undefined) {
    f.snapshot('stopped', 'tree-changed')
  }
  expect(f.state.status).toBe('cancelled')
  return f
}

/** Fix fails (auth expired, no automatic retry); its `stopped` snapshot lands. The run holds its lock. */
export function failedAtFix(o: ReviewOptions = {}): Flow {
  const f = fixRunning(o)
  f.exit('fix', { code: 1, failure: failure('auth_expired') })
  if (f.findReq((r) => r.kind === 'snapshot' && r.label === 'stopped') !== undefined) {
    f.snapshot('stopped', 'tree-partial')
  }
  expect(f.state.status).toBe('failed')
  expect(f.state.lock).toBe('held')
  return f
}

/** Dim Factory quits while Fix runs (P26): paused(interrupted-by-quit) once its `interrupted` snapshot lands. */
export function pausedAtFix(o: ReviewOptions = {}): Flow {
  const f = fixRunning(o)
  f.send({ t: 'quit' })
  f.exit('fix', { code: null })
  if (f.findReq((r) => r.kind === 'snapshot' && r.label === 'interrupted') !== undefined) {
    f.snapshot('interrupted', 'tree-partial')
  }
  expect(f.state.status).toBe('paused')
  expect(f.state.lock).toBe('held')
  return f
}

/** The RunInit app-core makes for a re-run of `source` (a new id, number and time; the source's config). */
export function rerunInit(source: RunState, o: Partial<RunInit> = {}): RunInit {
  return {
    runId: '20261009T120000Z-rrrr',
    displayNo: source.displayNo + 1,
    folder: source.folder,
    folderKey: source.folderKey,
    task: source.task,
    title: source.title,
    profile: source.profile,
    createdAt: T0 + 3_600_000,
    config: structuredClone(source.config),
    ...o,
  }
}
