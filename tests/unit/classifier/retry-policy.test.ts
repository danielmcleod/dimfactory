// retryPolicy per failure category (its "Auto-retry" column): auto, delay, budget and strategy, then end to end
// from a classified failure (recorded Claude fixtures; Codex/Gemini SYNTHESIZED where no recording exists).
import { describe, expect, it } from 'vitest'
import {
  CATEGORY_INFO,
  CRASH_MIN_RUN_MS,
  RATE_LIMIT_AUTO_MAX_MS,
  retryPolicy,
} from '@core/heal/categories.ts'
import type { RetryDecision } from '@core/heal/categories.ts'
import { classify } from '@core/heal/classify.ts'
import type { Failure, FailureCategory } from '@shared/failure.ts'
import { FAILURE_CATEGORIES } from '@shared/failure.ts'
import { rateLimit } from '../heal/claude-frames.ts'
import { NOW, claude, codex, codexTurnFailed, app, gemini, gemini429, recorded } from './inputs.ts'

const NO: RetryDecision = { auto: false, delayMs: 0, consumesBudget: true }
const after = (delayMs: number): RetryDecision => ({ auto: true, delayMs, consumesBudget: true })

type Row =
  | { kind: 'fixed'; decision: RetryDecision; c1: string }
  | {
      kind: 'conditional'
      c1: string
      yes: [Partial<Failure>, { ranMs?: number }, RetryDecision]
      no: [Partial<Failure>, { ranMs?: number }]
    }

const failure = (
  o: Partial<Failure> = {},
): Pick<Failure, 'message' | 'raw' | 'resetsAt' | 'retryAfterMs'> => ({
  message: o.message ?? '',
  raw: o.raw ?? '',
  ...(o.resetsAt !== undefined ? { resetsAt: o.resetsAt } : {}),
  ...(o.retryAfterMs !== undefined ? { retryAfterMs: o.retryAfterMs } : {}),
})

const fixed = (decision: RetryDecision, c1 = 'no'): Row => ({ kind: 'fixed', decision, c1 })

/** The failure table's "Auto-retry" column, word for word in `c1`. */
const C1_RETRY: Record<FailureCategory, Row> = {
  cli_missing: fixed(NO),
  cli_version: fixed(NO),
  flag_drift: fixed(NO),
  auth_required: fixed(NO),
  auth_expired: fixed(NO),
  rate_limited: {
    kind: 'conditional',
    c1: 'if retry-after ≤ 120 s',
    yes: [{ retryAfterMs: 120_000 }, {}, after(120_000)],
    no: [{ retryAfterMs: 120_001 }, {}],
  },
  quota_exceeded: fixed(NO),
  billing: fixed(NO),
  model_unavailable: fixed(NO),
  network: fixed(after(5_000), 'after 5 s'),
  sandbox_unavailable: fixed(NO),
  trust_required: fixed(NO),
  capability_missing: fixed(NO),
  resume_failed: fixed(
    { auto: true, delayMs: 0, strategy: 'fresh', consumesBudget: false },
    'yes, fresh (no budget)',
  ),
  stream_malformed: fixed(after(0), 'yes'),
  config_invalid: fixed(NO),
  git_missing: fixed(NO),
  git_state: {
    kind: 'conditional',
    c1: 'lock: recheck once after 2 s',
    yes: [{ raw: "fatal: Unable to create 'C:/r/.git/index.lock': File exists." }, {}, after(2_000)],
    no: [{ message: "fatal: detected dubious ownership in repository at 'C:/r'" }, {}],
  },
  folder_guard: fixed(NO),
  snapshot_failed: fixed(after(2_000), 'once after 2 s'),
  worktree_failed: fixed(NO),
  deps_missing: fixed(NO),
  local_server: fixed(NO),
  verify_failed: fixed(NO, 'n/a'),
  verify_untrusted: fixed(NO),
  timeout_stall: fixed(NO, '(none: stall card)'),
  timeout_hard: fixed(NO),
  ask_timeout: fixed(NO),
  permission_denied: fixed(NO),
  turn_limit: fixed(NO),
  context_exceeded: fixed(NO),
  runaway_loop: fixed(NO),
  content_policy: fixed(NO),
  vendor_internal: fixed(after(15_000), 'after 15 s'),
  process_crash: {
    kind: 'conditional',
    c1: 'if it ran > 3 s',
    yes: [{}, { ranMs: CRASH_MIN_RUN_MS + 1 }, after(0)],
    no: [{}, { ranMs: CRASH_MIN_RUN_MS }],
  },
  disk_full: fixed(NO),
  user_cancelled: fixed(NO, '(none: no snag card)'),
  unknown: fixed(NO),
}

describe('retryPolicy: one row per failure category', () => {
  it.each([...FAILURE_CATEGORIES])('%s', (category) => {
    const row = C1_RETRY[category]
    if (row.kind === 'fixed') {
      // Fixed rows ignore every context: a short retry-after, a long run, a lock text.
      for (const [f, ctx] of [
        [failure(), {}],
        [failure({ retryAfterMs: 1, raw: 'index.lock: File exists' }), { ranMs: 60_000 }],
      ] as const) {
        expect(retryPolicy(category, f, { ...ctx, now: NOW }), row.c1).toEqual(row.decision)
      }
      expect(CATEGORY_INFO[category].retry.auto).toBe(row.decision.auto)
    } else {
      const [yf, yctx, yes] = row.yes
      const [nf, nctx] = row.no
      expect(retryPolicy(category, failure(yf), { ...yctx, now: NOW }), row.c1).toEqual(yes)
      expect(retryPolicy(category, failure(nf), { ...nctx, now: NOW }), row.c1).toEqual(NO)
      expect(CATEGORY_INFO[category].retry.auto).toBe('conditional')
    }
  })

  it('rate_limited reads resetsAt when there is no retry-after', () => {
    expect(retryPolicy('rate_limited', failure({ resetsAt: NOW + 30_000 }), { now: NOW })).toEqual(
      after(30_000),
    )
    expect(
      retryPolicy('rate_limited', failure({ resetsAt: NOW + RATE_LIMIT_AUTO_MAX_MS + 1 }), { now: NOW }),
    ).toEqual(NO)
    expect(retryPolicy('rate_limited', failure(), { now: NOW })).toEqual(NO)
  })

  it('process_crash without a run time never retries', () => {
    expect(retryPolicy('process_crash', failure(), { now: NOW })).toEqual(NO)
  })
})

describe('retryPolicy end to end: classified failure → decision', () => {
  const decide = (f: Failure, ranMs?: number) =>
    retryPolicy(f.category, f, ranMs !== undefined ? { ranMs, now: NOW } : { now: NOW })

  it('C08c bogus resume → retry fresh without spending the budget', () => {
    const f = classify(recorded('C08c-resume-bogus'))!
    expect(decide(f)).toEqual({ auto: true, delayMs: 0, strategy: 'fresh', consumesBudget: false })
  })

  it('C10b external kill after ~11 s → retry (it ran > 3 s)', () => {
    const input = recorded('C10b-taskkill-tree')
    const f = classify(input)!
    expect(f.category).toBe('process_crash')
    expect(input.ranMs).toBeGreaterThan(CRASH_MIN_RUN_MS)
    expect(decide(f, input.ranMs)).toEqual(after(0))
  })

  it('C09b logged out → no retry', () => {
    expect(decide(classify(recorded('C09b-logged-out'))!)).toEqual(NO)
  })

  it('C12a max turns → no retry (resume "continue" is the user’s)', () => {
    expect(decide(classify(recorded('C12a-max-turns'))!)).toEqual(NO)
  })

  it('Claude rejection resetting in 90 s → auto after 90 s; a five-hour window → no', () => {
    const soon = classify(
      claude({ exitCode: 1, structured: [rateLimit({ status: 'rejected', resetsAt: NOW / 1000 + 90 })] }),
    )!
    expect(decide(soon)).toEqual(after(90_000))
    const quota = classify(
      claude({
        exitCode: 1,
        structured: [
          rateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: NOW / 1000 + 90 }),
        ],
      }),
    )!
    expect(quota.category).toBe('quota_exceeded')
    expect(decide(quota)).toEqual(NO)
  })

  it('Gemini per-minute 429 with "retry in 41.5s" → auto after 41.5 s; per-day → no', () => {
    const minute = classify(
      gemini({ exitCode: 1, stderrTail: gemini429('GenerateRequestsPerMinutePerProjectPerModel') }),
    )!
    expect(decide(minute)).toEqual(after(41_500))
    const day = classify(
      gemini({ exitCode: 1, stderrTail: gemini429('GenerateRequestsPerDayPerProjectPerModel') }),
    )!
    expect(day.category).toBe('quota_exceeded')
    expect(decide(day)).toEqual(NO)
  })

  it('Codex rate limit "try again in 3 minutes" → over 120 s, so the snag waits for the user', () => {
    const f = classify(
      codex({
        structured: [
          codexTurnFailed('rateLimitExceeded', 'Rate limit reached. Please try again in 3 minutes.'),
        ],
      }),
    )!
    expect(f.retryAfterMs).toBe(180_000)
    expect(decide(f)).toEqual(NO)
  })

  it('git: a held lock re-checks after 2 s; dubious ownership does not', () => {
    const lock = classify(
      app('git', {
        exitCode: 128,
        stderrTail: "fatal: Unable to create 'C:/r/.git/index.lock': File exists.",
      }),
    )!
    expect(decide(lock)).toEqual(after(2_000))
    const dubious = classify(
      app('git', {
        exitCode: 128,
        stderrTail: "fatal: detected dubious ownership in repository at 'C:/r'",
      }),
    )!
    expect(decide(dubious)).toEqual(NO)
  })

  it('a shadow snapshot failure retries once after 2 s; the same disk-full failure does not', () => {
    const snap = classify(app('git', { appDetected: { check: 'snapshot' }, exitCode: 128 }))!
    expect(decide(snap)).toEqual(after(2_000))
    const full = classify(app('git', { appDetected: { check: 'snapshot' }, errno: 'ENOSPC' }))!
    expect(full.category).toBe('disk_full')
    expect(decide(full)).toEqual(NO)
  })
})
