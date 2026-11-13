// Builders for core views and run envelopes in renderer tests (shapes from src/shared/run.ts).
import type { NormalizedEvent } from '@shared/events.ts'
import type { AppEvent } from '@shared/ipc.ts'
import { STEP_KEYS } from '@shared/run.ts'
import type { RunEnvelope, RunEventBody, RunSnapshot, RunSummary, StepKey, StepView } from '@shared/run.ts'

export function makeSummary(over: Partial<RunSummary> & { runId: string }): RunSummary {
  return {
    displayNo: 1,
    folder: 'C:\\work\\repo',
    folderKey: '0123456789abcdef',
    title: 'Add a --version flag',
    status: 'running',
    phase: 'implementing',
    profile: 'claude-only',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt: 1_700_000_000_000,
    progress: { tokens: 0, costUsd: null, filesChanged: 0 },
    findings: { must: 0, should: 0 },
    steps: [],
    ...over,
  }
}

export function makeSnapshot(over: Partial<RunSummary> & { runId: string }, lastSeq = 0): RunSnapshot {
  // As core has them for a run without the security advisor (the default): its steps settled as not used.
  const unused: ReadonlySet<StepKey> = new Set<StepKey>(['scan', 'security', 'recheck'])
  const steps = Object.fromEntries(
    STEP_KEYS.map((k): [StepKey, StepView] => [
      k,
      unused.has(k)
        ? { key: k, status: 'skipped', reason: 'not used', attempt: 0, activeMs: 0 }
        : { key: k, status: 'queued', attempt: 0, activeMs: 0 },
    ]),
  ) as Record<StepKey, StepView>
  return {
    summary: makeSummary(over),
    steps,
    asks: [],
    cards: [],
    allowRules: [],
    notes: [],
    rerunFromFix: { available: false, fresh: false },
    lastSeq,
  }
}

export function env(
  runId: string,
  seq: number,
  body: RunEventBody,
  ts = 1_700_000_000_000 + seq,
): RunEnvelope {
  return { runId, seq, ts, body }
}

export function ev(step: StepKey, ev: NormalizedEvent, attempt = 1): RunEventBody {
  return { t: 'ev', step, attempt, ev }
}

export function text(step: StepKey, delta: string, attempt = 1): RunEventBody {
  return ev(step, { type: 'text', delta }, attempt)
}

export function runEvent(e: RunEnvelope): AppEvent {
  return { kind: 'run', env: e }
}

/** Envelopes 1..n of text deltas `chunk(i)` for one step: a fake events.jsonl. */
export function textLog(
  runId: string,
  step: StepKey,
  n: number,
  chunk = (i: number) => `line ${i}\n`,
): RunEnvelope[] {
  return Array.from({ length: n }, (_, i) => env(runId, i + 1, text(step, chunk(i + 1))))
}
