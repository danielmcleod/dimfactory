// Signal tables (src/core/heal/signals/*): registry, well-formed rules, the Codex/ACP/Gemini maps against the
// documented error lists (SYNTHESIZED where no recording exists), Dim Factory checks, and retry-delay parsing.
import { describe, expect, it } from 'vitest'
import { classifyDetailed, signalTableFor } from '@core/heal/classify.ts'
import {
  ACP_REGEX,
  ACP_STOP_REASONS,
  GEMINI_EXIT,
  GEMINI_REGEX,
  GEMINI_SIGNALS,
  acpRpcMatch,
  acpSignals,
} from '@core/heal/signals/acp-gemini.ts'
import { CLAUDE_REGEX, CLAUDE_SIGNALS } from '@core/heal/signals/claude.ts'
import { CODEX_ERROR_INFO, CODEX_REGEX, CODEX_SIGNALS } from '@core/heal/signals/codex.ts'
import { APP_CHECKS, APP_CHECK_TABLE } from '@core/heal/signals/app.ts'
import { GENERIC_EXIT, GENERIC_REGEX, isLocalTarget, retryAfterFromText } from '@core/heal/signals/generic.ts'
import { FAILURE_CATEGORIES } from '@shared/failure.ts'
import { codex, codexError, codexTurnFailed, app, execError, gemini, local } from './inputs.ts'

describe('registry', () => {
  it('claude, codex and gemini tables are registered; local presets share codex', () => {
    expect(signalTableFor('claude')).toBe(CLAUDE_SIGNALS)
    expect(signalTableFor('codex')).toBe(CODEX_SIGNALS)
    expect(signalTableFor('gemini')).toBe(GEMINI_SIGNALS)
    expect(signalTableFor('local-ollama')).toBe(CODEX_SIGNALS)
  })

  it('later ACP vendors build their table from acpSignals (as Grok does)', () => {
    expect(signalTableFor('grok')).toBeUndefined()
    const grok = acpSignals('grok')
    expect(grok.vendor).toBe('grok')
    expect(grok.regex).toEqual(ACP_REGEX)
    expect(grok.exit).toBeUndefined()
  })

  it('isLocalTarget: local-<preset> vendors or a loopback target', () => {
    expect(isLocalTarget({ vendor: 'local-ollama' })).toBe(true)
    expect(isLocalTarget({ vendor: 'local-' })).toBe(false)
    expect(isLocalTarget({ vendor: 'codex' })).toBe(false)
    expect(isLocalTarget({ vendor: 'codex', loopback: true })).toBe(true)
  })
})

describe('rules are well-formed', () => {
  const all = [...CLAUDE_REGEX, ...CODEX_REGEX, ...GEMINI_REGEX, ...ACP_REGEX, ...GENERIC_REGEX]

  it('regex ids are unique, prefixed by their table, and never global or sticky', () => {
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length)
    const prefixed = (rules: readonly { id: string }[], p: string) => rules.every((r) => r.id.startsWith(p))
    expect(prefixed(CLAUDE_REGEX, 'claude.regex.')).toBe(true)
    expect(prefixed(CODEX_REGEX, 'codex.regex.')).toBe(true)
    expect(prefixed(GEMINI_REGEX, 'gemini.regex.')).toBe(true)
    expect(prefixed(ACP_REGEX, 'acp.regex.')).toBe(true)
    expect(prefixed(GENERIC_REGEX, 'generic.regex.')).toBe(true)
    for (const r of all) expect(r.re.global || r.re.sticky, r.id).toBe(false)
  })

  it('every rule maps to a known category', () => {
    for (const r of [...all, ...GEMINI_EXIT, ...GENERIC_EXIT])
      expect(FAILURE_CATEGORIES).toContain(r.category)
    for (const c of Object.values(CODEX_ERROR_INFO)) if (c !== null) expect(FAILURE_CATEGORIES).toContain(c)
  })
})

describe('Codex (failure table X column, SYNTHESIZED)', () => {
  it('covers every CodexErrorInfo variant (app-server v2 shared.rs)', () => {
    expect(Object.keys(CODEX_ERROR_INFO).sort()).toEqual(
      [
        'contextWindowExceeded',
        'sessionBudgetExceeded',
        'usageLimitExceeded',
        'rateLimitExceeded',
        'flexUnavailable',
        'serverOverloaded',
        'cyberPolicy',
        'misalignmentPolicyViolation',
        'tooManyDenials',
        'httpConnectionFailed',
        'responseStreamConnectionFailed',
        'internalServerError',
        'unauthorized',
        'badRequest',
        'threadRollbackFailed',
        'sandboxError',
        'responseStreamDisconnected',
        'responseTooManyFailedAttempts',
        'activeTurnNotSteerable',
        'other',
      ].sort(),
    )
  })

  it('maps the X detections', () => {
    expect(CODEX_ERROR_INFO).toMatchObject({
      rateLimitExceeded: 'rate_limited',
      usageLimitExceeded: 'quota_exceeded',
      sessionBudgetExceeded: 'quota_exceeded',
      flexUnavailable: 'model_unavailable',
      httpConnectionFailed: 'network',
      responseStreamConnectionFailed: 'network',
      responseStreamDisconnected: 'network',
      sandboxError: 'sandbox_unavailable',
      threadRollbackFailed: 'resume_failed',
      tooManyDenials: 'permission_denied',
      contextWindowExceeded: 'context_exceeded',
      cyberPolicy: 'content_policy',
      misalignmentPolicyViolation: 'content_policy',
      serverOverloaded: 'vendor_internal',
      internalServerError: 'vendor_internal',
      responseTooManyFailedAttempts: 'vendor_internal',
      unauthorized: 'auth_expired',
    })
  })

  it('willRetry:true errors and exec error lines are not failures on a clean exit', () => {
    expect(
      classifyDetailed(
        codex({
          exitCode: 0,
          structured: [codexError('responseStreamDisconnected', 'Reconnecting... 1/5', true)],
        }),
      ),
    ).toBeNull()
    expect(
      classifyDetailed(codex({ exitCode: 0, structured: [execError('Reconnecting... 2/5')] })),
    ).toBeNull()
  })

  it('exec error lines are text evidence when the process failed', () => {
    const r = classifyDetailed(
      codex({ exitCode: 1, structured: [execError("You've hit your usage limit.")] }),
    )!
    expect(r.rule).toBe('codex.regex.usage-limit')
  })

  it('a failed turn with no message still reads as a failure', () => {
    const frame = { method: 'turn/completed', params: { turn: { status: 'failed' } } }
    const r = classifyDetailed(codex({ structured: [frame] }))!
    expect(r.failure).toMatchObject({ category: 'unknown' })
  })

  it('a completed turn is not a failure', () => {
    const frame = { method: 'turn/completed', params: { turn: { status: 'completed' } } }
    expect(classifyDetailed(codex({ exitCode: 0, structured: [frame] }))).toBeNull()
  })

  it('a local preset reads connection failures and 404s as its server', () => {
    const r = classifyDetailed(
      local({
        structured: [codexTurnFailed({ httpConnectionFailed: { httpStatusCode: 404 } }, 'Not Found')],
      }),
    )!
    expect(r.failure.category).toBe('local_server')
    const cloud = classifyDetailed(
      codex({
        structured: [codexTurnFailed({ httpConnectionFailed: { httpStatusCode: 404 } }, 'Not Found')],
      }),
    )!
    expect(cloud.failure.category).toBe('network')
  })

  it('raw is the failing frame, redacted', () => {
    const key = `sk-proj-${'A'.repeat(40)}`
    const f = classifyDetailed(
      codex({ structured: [codexTurnFailed('unauthorized', `401 for key ${key}`)] }),
    )!.failure
    expect(f.raw).not.toContain(key)
    expect(f.message).not.toContain(key)
    expect(JSON.parse(f.raw)).toMatchObject({ method: 'turn/completed' })
  })
})

describe('ACP and Gemini (failure table G column, SYNTHESIZED)', () => {
  it('Gemini FatalError exit codes', () => {
    expect(Object.fromEntries(GEMINI_EXIT.map((r) => [r.codes![0], r.category]))).toEqual({
      41: 'auth_required',
      42: 'flag_drift',
      44: 'sandbox_unavailable',
      52: 'config_invalid',
      53: 'turn_limit',
      54: 'disk_full',
      55: 'trust_required',
    })
  })

  it('exit 130 (cancel) and 1 (general) are not in the table', () => {
    expect(classifyDetailed(gemini({ exitCode: 130 }))!.rule).toBe('exit.silent-nonzero')
    expect(classifyDetailed(gemini({ exitCode: 1 }))!.rule).toBe('exit.silent-nonzero')
  })

  it('only refusal and max_turn_requests stop reasons are failures', () => {
    expect(ACP_STOP_REASONS).toEqual({ refusal: 'content_policy', max_turn_requests: 'turn_limit' })
    for (const stopReason of ['end_turn', 'max_tokens', 'cancelled']) {
      const frame = { jsonrpc: '2.0', id: 1, result: { stopReason } }
      expect(classifyDetailed(gemini({ structured: [frame] })), stopReason).toBeNull()
    }
  })

  it('acpRpcMatch', () => {
    expect(acpRpcMatch({ code: -32000, message: 'Authentication required' })?.category).toBe('auth_required')
    expect(acpRpcMatch({ code: -32602, method: 'session/resume' })?.category).toBe('resume_failed')
    expect(acpRpcMatch({ code: -32602, method: 'session/prompt' })).toBeUndefined()
    expect(acpRpcMatch({ code: -32603, message: 'Invalid or unavailable mode: x' })?.category).toBe(
      'flag_drift',
    )
    expect(acpRpcMatch({ code: -32601, method: 'session/load' })).toBeUndefined()
  })

  it('a daily quota beats a per-minute limit beats a bare 429', () => {
    const t = (text: string) => classifyDetailed(gemini({ exitCode: 1, stderrTail: text }))!.rule
    expect(t('429 RESOURCE_EXHAUSTED quotaId GenerateRequestsPerDayPerProject, PerMinute')).toBe(
      'gemini.regex.quota-daily',
    )
    expect(t('429 RESOURCE_EXHAUSTED quotaId GenerateRequestsPerMinutePerProject')).toBe(
      'gemini.regex.rate-per-minute',
    )
    expect(t('RESOURCE_EXHAUSTED')).toBe('gemini.regex.resource-exhausted')
    expect(t('got 429 Too Many Requests')).toBe('gemini.regex.429')
  })
})

describe('Dim Factory checks', () => {
  it('every check has a row with a category and a plain UI message', () => {
    expect(Object.keys(APP_CHECK_TABLE).sort()).toEqual([...APP_CHECKS].sort())
    for (const check of APP_CHECKS) {
      const row = APP_CHECK_TABLE[check]
      expect(FAILURE_CATEGORIES).toContain(row.category)
      expect(row.message, check).toMatch(/^[A-Z].*\.$/)
      expect(row.message, check).not.toContain('—')
    }
  })

  it.each([...APP_CHECKS])('%s classifies by app with its default message', (check) => {
    const r = classifyDetailed(app('app', { appDetected: { check } }))!
    expect(r.failure).toMatchObject({
      category: APP_CHECK_TABLE[check].category,
      classifiedBy: 'app',
      message: APP_CHECK_TABLE[check].message,
    })
    expect(r.rule).toBe(`app.check.${check}`)
  })

  it('a detail replaces the default message (first line, capped at 300)', () => {
    const long = `${'x'.repeat(400)}\nsecond line`
    const f = classifyDetailed(app('verify', { appDetected: { check: 'verify', detail: long } }))!.failure
    expect(f.message.length).toBe(300)
    expect(f.message.endsWith('...')).toBe(true)
  })

  it('verify: environment failures are deps_missing, failing tests are verify_failed', () => {
    const v = (o: Parameters<typeof app>[1]) =>
      classifyDetailed(app('verify', { appDetected: { check: 'verify' }, ...o }))!.failure.category
    expect(v({ exitCode: 127, stderrTail: 'sh: 1: vitest: not found' })).toBe('deps_missing')
    expect(v({ exitCode: 126 })).toBe('deps_missing')
    expect(v({ exitCode: 1, stderrTail: 'bash: vitest: command not found' })).toBe('deps_missing')
    expect(v({ exitCode: 1, stderrTail: "ModuleNotFoundError: No module named 'pytest'" })).toBe(
      'deps_missing',
    )
    expect(v({ exitCode: 1, stderrTail: 'FAIL  src/a.test.ts' })).toBe('verify_failed')
    expect(v({ exitCode: 2, stderrTail: 'error TS2322: Type string is not assignable' })).toBe(
      'verify_failed',
    )
  })
})

describe('retryAfterFromText', () => {
  it.each([
    ['Please retry in 41.5s.', 41_500],
    ['"retryDelay": "41s"', 41_000],
    ['try again in 2 days 3 hours 4 minutes.', (2 * 86_400 + 3 * 3_600 + 4 * 60) * 1000],
    ['Please retry in 7h3m12s.', (7 * 3_600 + 3 * 60 + 12) * 1000],
    ['try again in 5 minutes and 2 seconds', 302_000],
    ['Retrying in 3 min', 180_000],
    ['retry after 500ms', 500],
    ['Retry-After: 30', 30_000],
  ] as const)('%s', (text, ms) => {
    expect(retryAfterFromText(text)).toBe(ms)
  })

  it.each(['try again at 3:15 PM', 'Retry later', 'no delay here', 'retry in a moment'])(
    '%s → undefined',
    (t) => {
      expect(retryAfterFromText(t)).toBeUndefined()
    },
  )
})
