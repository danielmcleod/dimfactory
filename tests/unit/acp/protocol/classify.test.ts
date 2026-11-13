// The Gemini failure fixtures through the real classifier (failure table, G column: ACP authRequired,
// "Invalid session identifier", stopReason refusal / max_turn_requests, the exit codes 41/42/44/52/53/54/55; the
// Gemini signal table was synthesized until these fixtures). A JSON-RPC error's words are read as the ACP
// base reads them: the message and `data.details` (protocol.ts acpErrorText), since a thrown Error arrives as -32603
// "Internal error" with its text in the details.
import { describe, expect, it } from 'vitest'
import { acpErrorText } from '../../../../src/core/adapters/acp-base/protocol.ts'
import { classify } from '../../../../src/core/heal/classify.ts'
import type { FailureCategory } from '../../../../src/shared/failure.ts'
import type { Fixture, Json } from './fixtures.ts'
import { loadFixture, messages } from './fixtures.ts'

const NOW = Date.parse('2026-10-10T12:00:00Z')

function category(fx: Fixture): FailureCategory | undefined {
  const exit = fx.frames.find((f) => f.dir === 'exit')
  const stderr = fx.frames.filter((f) => f.dir === 'err').map((f) => f.line ?? '')
  const refused = messages(fx, 'out').find((m) => m['error'] !== undefined && typeof m['method'] !== 'string')
  const request = refused
    ? messages(fx, 'in').find((m) => m['id'] === refused['id'] && typeof m['method'] === 'string')
    : undefined
  const error = refused?.['error'] as { code: number; message: string; data?: unknown } | undefined
  const failure = classify({
    vendor: 'gemini',
    step: 'implement',
    mode: 'autoedit',
    structured: messages(fx, 'out'),
    exitCode: exit?.code ?? null,
    stderrTail: stderr,
    ...(error !== undefined && request !== undefined
      ? { rpcError: { code: error.code, message: acpErrorText(error), method: String(request['method']) } }
      : {}),
    now: NOW,
  })
  return failure?.category
}

describe('Gemini failure fixtures → failure categories', () => {
  it.each([
    ['G09c-resume-unknown-session', 'resume_failed'],
    ['G10b-auth-required', 'auth_required'],
    ['G10c-prompt-error-quota', 'quota_exceeded'],
    ['G10d-max-turn-requests', 'turn_limit'],
    ['G10e-refusal', 'content_policy'],
    ['GX41-exit-auth', 'auth_required'],
    ['GX42-exit-input', 'flag_drift'],
    ['GX44-exit-sandbox', 'sandbox_unavailable'],
    ['GX52-exit-config', 'config_invalid'],
    ['GX53-exit-turn-limit', 'turn_limit'],
    ['GX54-exit-tool-disk-full', 'disk_full'],
    ['GX55-exit-untrusted-folder', 'trust_required'],
  ] as const)('%s → %s', (name, expected) => {
    const fx = loadFixture(name)
    expect(category(fx)).toBe(expected)
    // …which is what the fixture's terminal event says.
    expect(fx.expected.at(-1)).toMatchObject({ type: 'error', fatal: true, category: expected })
  })

  it('the words of a -32603 are in data.details: the message alone does not say what failed', () => {
    for (const name of ['G09c-resume-unknown-session', 'G10c-prompt-error-quota']) {
      const fx = loadFixture(name)
      const error = messages(fx, 'out').find((m) => m['error'] !== undefined)?.['error'] as Json
      expect(error['message']).toBe('Internal error')
      expect(typeof (error['data'] as Json)['details']).toBe('string')
    }
  })

  it('a clean pass is not a failure (stopReason end_turn, cancelled)', () => {
    for (const name of ['G02-review-message-chunks', 'G08-plan-exit-captured']) {
      const fx = loadFixture(name)
      expect(
        classify({ vendor: 'gemini', structured: messages(fx, 'out'), exitCode: 0, now: NOW }),
      ).toBeNull()
    }
  })
})
