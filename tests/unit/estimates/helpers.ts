// RunSummary builders for the estimates and dashboard tests (src/core/estimates, src/core/dashboard).
import type { Usage } from '@shared/events.ts'
import type { RunSummary, RunSummaryStep, StepKey } from '@shared/run.ts'

export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)
export const MIN = 60_000

let seq = 0

/** A finished (completed, no outcome) run with the given step rows; ids, numbers and times advance per call. */
export function run(steps: RunSummaryStep[], over: Partial<RunSummary> = {}): RunSummary {
  seq++
  return {
    runId: `run-${String(seq).padStart(5, '0')}`,
    displayNo: seq,
    folder: 'C:\\work\\app',
    folderKey: 'folder-a',
    title: `run ${seq}`,
    status: 'completed',
    phase: 'done',
    profile: 'claude-only',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt: T0 + seq * MIN,
    endedAt: T0 + seq * MIN + 10 * MIN,
    progress: { tokens: 0, costUsd: null, filesChanged: 0 },
    findings: { must: 0, should: 0 },
    steps,
    ...over,
  }
}

export const usage = (input: number, output: number, extra: Partial<Usage> = {}): Usage => ({
  input,
  output,
  ...extra,
})

/** A step row (status done unless given). */
export function step(key: StepKey, activeMs: number, over: Partial<RunSummaryStep> = {}): RunSummaryStep {
  return { key, status: 'done', activeMs, ...over }
}

/** A Claude pass row: vendor claude, the given model and mode. */
export function claude(
  key: StepKey,
  activeMs: number,
  model: string | null,
  mode: RunSummaryStep['mode'],
  over: Partial<RunSummaryStep> = {},
): RunSummaryStep {
  return step(key, activeMs, { vendor: 'claude', model, ...(mode !== undefined ? { mode } : {}), ...over })
}
