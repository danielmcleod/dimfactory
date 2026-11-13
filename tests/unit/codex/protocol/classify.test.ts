// The failure fixtures through the real classifier (failure table, X column: classified by the structured
// codexErrorInfo, then the message; the Codex signal table was synthesized until these fixtures).
import { describe, expect, it } from 'vitest'
import { classify } from '../../../../src/core/heal/classify.ts'
import type { FailureCategory } from '../../../../src/shared/failure.ts'
import type { Fixture, Json } from './fixtures.ts'
import { loadFixture, messages } from './fixtures.ts'

const NOW = Date.parse('2026-10-09T23:30:00Z')

function category(fx: Fixture): FailureCategory | undefined {
  const exit = fx.frames.find((f) => f.dir === 'exit')
  const stderr = fx.frames.filter((f) => f.dir === 'err').map((f) => f.line ?? '')
  const refused = messages(fx, 'out').find((m) => m['error'] !== undefined)
  const request = refused
    ? messages(fx, 'in').find((m) => m['id'] === refused['id'] && typeof m['method'] === 'string')
    : undefined
  const failure = classify({
    vendor: 'codex',
    step: 'implement',
    mode: 'autoedit',
    structured: messages(fx, 'out'),
    exitCode: exit?.code ?? null,
    stderrTail: stderr,
    ...(refused !== undefined && request !== undefined
      ? {
          rpcError: {
            code: Number((refused['error'] as Json)['code']),
            message: String((refused['error'] as Json)['message']),
            method: String(request['method']),
          },
        }
      : {}),
    now: NOW,
  })
  return failure?.category
}

describe('Codex failure fixtures → failure categories', () => {
  it.each([
    ['app-server', 'X09a-error-rate-limit', 'rate_limited'],
    ['app-server', 'X09b-error-usage-limit', 'quota_exceeded'],
    ['app-server', 'X09c-error-unauthorized', 'auth_expired'],
    ['app-server', 'X09d-error-context-window', 'context_exceeded'],
    ['app-server', 'X09e-error-server-overloaded', 'vendor_internal'],
    ['app-server', 'X09f-error-sandbox', 'sandbox_unavailable'],
    ['app-server', 'X09g-error-http-connection', 'network'],
    // Live: the everyday profile's configured model, refused for a ChatGPT login (400, codexErrorInfo "other").
    ['app-server', 'X09h-error-model-unsupported', 'model_unavailable'],
    ['app-server', 'X15-resume-unknown-thread', 'resume_failed'],
    ['exec', 'E05-turn-failed', 'quota_exceeded'],
    ['exec', 'E08-resume-unknown-thread', 'resume_failed'],
  ] as const)('%s/%s → %s', (route, name, expected) => {
    const fx = loadFixture(route, name)
    expect(category(fx)).toBe(expected)
    // …which is what the fixture's terminal event says.
    expect(fx.expected.at(-1)).toMatchObject({ type: 'error', fatal: true, category: expected })
  })

  it('the willRetry:true errors before X09e are not a failure by themselves', () => {
    const fx = loadFixture('app-server', 'X09e-error-server-overloaded')
    const retries = messages(fx, 'out').filter(
      (m) => m['method'] === 'error' && (m['params'] as Json)['willRetry'] === true,
    )
    expect(retries).toHaveLength(2)
    expect(classify({ vendor: 'codex', structured: retries, now: NOW })).toBeNull()
  })

  it('a usage limit carries its reset time (wait_until)', () => {
    const failure = classify({
      vendor: 'codex',
      structured: messages(loadFixture('app-server', 'X09b-error-usage-limit'), 'out'),
      now: NOW,
    })
    expect(failure?.category).toBe('quota_exceeded')
    expect(failure?.resetsAt ?? NOW + (failure?.retryAfterMs ?? 0)).toBe(NOW + (2 * 60 + 13) * 60_000)
  })
})
