// Muse failures through the classifier (exit codes from dev.meta.ai/docs/muse-code/
// extending: 1 failed or cancelled, 2 usage; a failed run's reason on its terminal record and the last stderr line).
// The texts are synthesized from the docs' wording until a live recording shows Muse's own.
import { describe, expect, it } from 'vitest'
import { classify } from '@core/heal/classify.ts'
import { MUSE_SIGNALS, ensureMuseSignals, failedTerminalOf } from '@core/adapters/muse/signals.ts'
import type { FailureCategory } from '@shared/failure.ts'

ensureMuseSignals()

const terminal = (t: string, reason: string | null) => ({
  payload_type: `run.terminal.${t}`,
  payload: { kind: 'run_terminal', terminal: t, reason },
})

const viaStderr = (line: string, code = 1): FailureCategory | undefined =>
  classify({ vendor: 'muse', exitCode: code, stderrTail: [line], failed: true })?.category

describe('Muse signal table', () => {
  it.each([
    ['error: Not signed in: run `muse` and sign in, or set META_API_KEY.', 'auth_required'],
    ['error: 401 Unauthorized', 'auth_required'],
    ['error: your sign-in has expired', 'auth_expired'],
    ['error: workspace is not trusted; pass --trust-workspace', 'trust_required'],
    ['error: stopped after reaching --max-model-steps (40)', 'turn_limit'],
    ['error: malformed settings file ~/.config/muse/settings.json', 'config_invalid'],
    ['error: could not confirm the sandbox is active', 'sandbox_unavailable'],
    ['error: 402 Payment Required', 'billing'],
    ['error: usage limit reached for this account', 'quota_exceeded'],
    ['error: 429 Too Many Requests, retry in 30s', 'rate_limited'],
    ['error: unknown model muse-spark-9', 'model_unavailable'],
    ['error: prompt is too long for the context window', 'context_exceeded'],
    ['error: the command requires approval, but approvals are disabled', 'permission_denied'],
    ['error: 503 Service Unavailable', 'vendor_internal'],
  ] as const)('%s → %s', (line, category) => {
    expect(viaStderr(line)).toBe(category)
  })

  it('exit 2 (a usage error) is flag_drift; a rate limit carries its retry delay', () => {
    expect(viaStderr('error: something', 2)).toBe('flag_drift')
    const f = classify({
      vendor: 'muse',
      exitCode: 1,
      stderrTail: ['429: retry in 30s'],
      failed: true,
      now: 1000,
    })
    expect(f).toMatchObject({ category: 'rate_limited', retryAfterMs: 30_000, resetsAt: 31_000 })
  })

  it('a failed terminal record is failure evidence; its reason is read before stderr', () => {
    expect(MUSE_SIGNALS.hasFailure?.([terminal('failed', 'x')])).toBe(true)
    expect(MUSE_SIGNALS.hasFailure?.([terminal('completed', null)])).toBe(false)
    expect(failedTerminalOf(terminal('cancelled', 'max model steps reached'))).toEqual({
      terminal: 'cancelled',
      reason: 'max model steps reached',
    })
    const f = classify({
      vendor: 'muse',
      structured: [terminal('cancelled', 'reached the max model steps')],
      exitCode: 1,
      stderrTail: ['warning: unrelated 503'],
    })
    expect(f?.category).toBe('turn_limit')
    // A terminal without a reason still names how it ended.
    expect(MUSE_SIGNALS.texts?.([terminal('failed', null)])).toEqual(['Muse run failed'])
  })

  it('a clean exit with nothing failed is no failure', () => {
    expect(classify({ vendor: 'muse', exitCode: 0, structured: [terminal('completed', null)] })).toBeNull()
  })
})
