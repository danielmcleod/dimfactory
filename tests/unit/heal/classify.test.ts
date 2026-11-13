// Table-driven classifier cases from synthesized frames and strings (documented Claude CLI behaviour
// with its verified corrections). Recorded fixtures are covered by classify.fixtures.test.ts.
import { describe, expect, it } from 'vitest'
import { classify, classifyDetailed, registerSignalTable, signalTableFor } from '@core/heal/classify.ts'
import type { ClassifyInput } from '@core/heal/classify.ts'
import { CLAUDE_REGEX, CLAUDE_SIGNALS, resetsAtMs } from '@core/heal/signals/claude.ts'
import { GENERIC_REGEX, errnoCategory, isWillRetryFrame } from '@core/heal/signals/generic.ts'
import type { ClassifiedBy, FailureCategory } from '@shared/failure.ts'
import { FAILURE_CATEGORIES } from '@shared/failure.ts'
import {
  apiRetry,
  assistantError,
  authStatusError,
  errorResult,
  errorText,
  initFrame,
  keepAlive,
  okResult,
  rateLimit,
  refusal,
  startupFailure,
} from './claude-frames.ts'

const NOW = 1_760_000_000_000
const claude = (o: Partial<ClassifyInput>): ClassifyInput => ({ vendor: 'claude', now: NOW, ...o })
const exit1 = (o: Partial<ClassifyInput>): ClassifyInput => claude({ exitCode: 1, ...o })

interface Case {
  name: string
  input: ClassifyInput
  category: FailureCategory
  by: ClassifiedBy
  rule?: string
}

const CASES: Case[] = [
  // cli_missing
  { name: 'spawn ENOENT', input: claude({ errno: 'ENOENT' }), category: 'cli_missing', by: 'errno' },
  {
    name: 'spawn EINVAL (.cmd without shell)',
    input: claude({ errno: { code: 'EINVAL', syscall: 'spawn' } }),
    category: 'cli_missing',
    by: 'errno',
  },
  {
    name: 'startup shell_tool_missing',
    input: exit1({ structured: [startupFailure('shell_tool_missing')] }),
    category: 'cli_missing',
    by: 'structured',
    rule: 'claude.startup.shell_tool_missing',
  },
  { name: 'cmd.exe 9009', input: claude({ exitCode: 9009 }), category: 'cli_missing', by: 'exit' },
  {
    name: '"is not recognized"',
    input: exit1({ stderrTail: "'claude' is not recognized as an internal or external command," }),
    category: 'cli_missing',
    by: 'regex',
  },
  // cli_version
  {
    name: 'startup cli_version_too_old',
    input: exit1({ structured: [startupFailure('cli_version_too_old')] }),
    category: 'cli_version',
    by: 'structured',
  },
  // flag_drift
  {
    name: 'requires --verbose',
    input: exit1({ stderrTail: 'Error: When using --print, --output-format=stream-json requires --verbose' }),
    category: 'flag_drift',
    by: 'regex',
    rule: 'claude.regex.requires-flag',
  },
  {
    name: 'unknown option',
    input: exit1({ stderrTail: "error: unknown option '--permission-prompts'" }),
    category: 'flag_drift',
    by: 'regex',
    rule: 'claude.regex.unknown-option',
  },
  {
    name: 'stream-json input requires --print',
    input: exit1({ stderrTail: 'Error: --input-format=stream-json requires --print.' }),
    category: 'flag_drift',
    by: 'regex',
  },
  {
    name: 'initialize handshake timeout',
    input: claude({ appInitiated: { kind: 'handshake' }, exitCode: null, signal: 'SIGKILL' }),
    category: 'flag_drift',
    by: 'app',
  },
  {
    name: 'required RPC method missing',
    input: {
      vendor: 'gemini',
      now: NOW,
      rpcError: { code: -32601, message: 'Method not found', method: 'session/load', required: true },
    },
    category: 'flag_drift',
    by: 'structured',
  },
  {
    name: 'heuristic: other vendor rejects an argument',
    input: { vendor: 'grok', now: NOW, exitCode: 2, stderrTail: "error: unexpected argument '--yolo' found" },
    category: 'flag_drift',
    by: 'heuristic',
  },
  // auth_required
  {
    name: 'Not logged in (is_error result)',
    input: exit1({ structured: [initFrame, errorText('Not logged in · Please run /login')] }),
    category: 'auth_required',
    by: 'regex',
    rule: 'claude.regex.not-logged-in',
  },
  {
    name: 'assistant authentication_failed',
    input: exit1({
      structured: [
        assistantError('authentication_failed', 'Please run /login'),
        errorText('Please run /login'),
      ],
    }),
    category: 'auth_required',
    by: 'structured',
    rule: 'claude.assistant.error.authentication_failed',
  },
  {
    name: 'Invalid API key',
    input: exit1({ structured: [errorText('Invalid API key · Fix external API key')] }),
    category: 'auth_required',
    by: 'regex',
    rule: 'claude.regex.invalid-api-key',
  },
  {
    name: 'API Error 401',
    input: exit1({ stdoutTail: 'API Error: 401 Invalid authentication credentials' }),
    category: 'auth_required',
    by: 'regex',
  },
  {
    name: 'api_error_status 401',
    input: exit1({ structured: [errorText('Authentication error', { api_error_status: 401 })] }),
    category: 'auth_required',
    by: 'structured',
  },
  {
    name: 'oauth_org_not_allowed',
    input: exit1({
      structured: [assistantError('oauth_org_not_allowed', 'Your organization does not allow OAuth')],
    }),
    category: 'auth_required',
    by: 'structured',
  },
  {
    name: 'startup org_pin_api_key_conflict',
    input: exit1({ structured: [startupFailure('org_pin_api_key_conflict')] }),
    category: 'auth_required',
    by: 'structured',
  },
  {
    name: 'auth_status error frame',
    input: exit1({ structured: [authStatusError('Authentication failed')] }),
    category: 'auth_required',
    by: 'structured',
  },
  {
    name: '`claude auth status` logged out (exit 1, JSON)',
    input: exit1({ stdoutTail: ['{', '  "loggedIn": false,', '  "authMethod": "none"', '}'] }),
    category: 'auth_required',
    by: 'regex',
    rule: 'claude.regex.auth-status',
  },
  {
    name: 'bare "Please run /login"',
    input: exit1({ structured: [errorText('Session ended · Please run /login')] }),
    category: 'auth_required',
    by: 'regex',
    rule: 'claude.regex.run-login',
  },
  // auth_expired
  {
    name: 'OAuth token has expired',
    input: exit1({ structured: [errorText('OAuth token has expired. Please run /login')] }),
    category: 'auth_expired',
    by: 'regex',
    rule: 'claude.regex.login-expired',
  },
  {
    name: 'OAuth token revoked',
    input: exit1({ stderrTail: 'OAuth token revoked · Please run /login' }),
    category: 'auth_expired',
    by: 'regex',
  },
  {
    name: 'Login expired',
    input: exit1({ structured: [errorText('Login expired · Please run /login')] }),
    category: 'auth_expired',
    by: 'regex',
  },
  {
    name: 'authentication_failed with expired text',
    input: exit1({ structured: [assistantError('authentication_failed', 'OAuth token has expired')] }),
    category: 'auth_expired',
    by: 'structured',
  },
  {
    name: 'startup gateway_signin_required',
    input: exit1({ structured: [startupFailure('gateway_signin_required')] }),
    category: 'auth_expired',
    by: 'structured',
  },
  // rate_limited
  {
    name: 'rate_limit_event rejected (no window)',
    input: exit1({
      structured: [rateLimit({ status: 'rejected', resetsAt: NOW / 1000 + 90 }), errorText('Rate limited')],
    }),
    category: 'rate_limited',
    by: 'structured',
    rule: 'claude.rate_limit_event.rejected',
  },
  {
    name: 'Request rejected (429)',
    input: exit1({ structured: [errorText('API Error: Request rejected (429) · retry later')] }),
    category: 'rate_limited',
    by: 'regex',
    rule: 'claude.regex.rate-429',
  },
  {
    name: 'assistant rate_limit',
    input: exit1({ structured: [assistantError('rate_limit', 'Rate limit reached')] }),
    category: 'rate_limited',
    by: 'structured',
  },
  {
    name: 'api_error_status 429',
    input: exit1({ structured: [errorText('x', { api_error_status: 429 })] }),
    category: 'rate_limited',
    by: 'structured',
  },
  // quota_exceeded
  {
    name: 'rate_limit_event five_hour',
    input: exit1({
      structured: [
        rateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: NOW / 1000 + 3600 }),
      ],
    }),
    category: 'quota_exceeded',
    by: 'structured',
    rule: 'claude.rate_limit_event.quota',
  },
  {
    name: 'rate_limit_event seven_day_opus',
    input: exit1({ structured: [rateLimit({ status: 'rejected', rateLimitType: 'seven_day_opus' })] }),
    category: 'quota_exceeded',
    by: 'structured',
  },
  {
    name: "You've hit your session limit",
    input: exit1({ structured: [errorText("You've hit your session limit · resets 3pm (Europe/London)")] }),
    category: 'quota_exceeded',
    by: 'regex',
    rule: 'claude.regex.hit-limit',
  },
  {
    name: 'weekly limit text',
    input: exit1({ stderrTail: "You've hit your weekly limit" }),
    category: 'quota_exceeded',
    by: 'regex',
  },
  {
    name: 'rate_limit error + hit-your-limit text',
    input: exit1({ structured: [assistantError('rate_limit', "You've hit your Opus limit")] }),
    category: 'quota_exceeded',
    by: 'structured',
  },
  // billing
  {
    name: 'Credit balance is too low',
    input: exit1({ structured: [errorText('Credit balance is too low')] }),
    category: 'billing',
    by: 'regex',
    rule: 'claude.regex.credit-balance',
  },
  {
    name: 'assistant billing_error',
    input: exit1({ structured: [assistantError('billing_error', 'Billing problem')] }),
    category: 'billing',
    by: 'structured',
  },
  {
    name: 'assistant account_on_hold',
    input: exit1({ structured: [assistantError('account_on_hold')] }),
    category: 'billing',
    by: 'structured',
  },
  // model_unavailable
  {
    name: 'assistant model_not_found',
    input: exit1({
      structured: [
        assistantError('model_not_found', "There's an issue with the selected model (claude-nope)."),
      ],
    }),
    category: 'model_unavailable',
    by: 'structured',
  },
  {
    name: 'selected model text',
    input: exit1({
      structured: [
        errorText(
          "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it.",
        ),
      ],
    }),
    category: 'model_unavailable',
    by: 'regex',
  },
  // network
  { name: 'errno ECONNRESET', input: claude({ errno: 'ECONNRESET' }), category: 'network', by: 'errno' },
  {
    name: 'getaddrinfo ENOTFOUND',
    input: exit1({ stderrTail: 'Error: getaddrinfo ENOTFOUND api.anthropic.com' }),
    category: 'network',
    by: 'regex',
    rule: 'generic.regex.network',
  },
  {
    name: 'startup proxy_invalid',
    input: exit1({ structured: [startupFailure('proxy_invalid')] }),
    category: 'network',
    by: 'structured',
  },
  // local_server
  {
    name: 'errno ECONNREFUSED to loopback',
    input: { vendor: 'local-ollama', now: NOW, errno: 'ECONNREFUSED', loopback: true },
    category: 'local_server',
    by: 'errno',
  },
  {
    name: 'ECONNREFUSED 127.0.0.1 text',
    input: { vendor: 'codex', now: NOW, exitCode: 1, stderrTail: 'connect ECONNREFUSED 127.0.0.1:11434' },
    category: 'local_server',
    by: 'regex',
  },
  // capability_missing
  {
    name: 'optional RPC method missing',
    input: {
      vendor: 'codex',
      now: NOW,
      rpcError: { code: -32601, message: 'Method not found', method: 'model/list', required: false },
    },
    category: 'capability_missing',
    by: 'structured',
  },
  {
    name: 'optional RPC params rejected',
    input: {
      vendor: 'codex',
      now: NOW,
      rpcError: { code: -32602, message: 'Invalid params', method: 'turn/start', required: false },
    },
    category: 'capability_missing',
    by: 'structured',
  },
  // resume_failed
  {
    name: 'No conversation found + exit 1',
    input: exit1({
      stderrTail: 'No conversation found with session ID: 0d6e1c1a-0000-4000-8000-00000000beef',
    }),
    category: 'resume_failed',
    by: 'regex',
    rule: 'claude.regex.no-conversation',
  },
  {
    name: 'No conversation found as result',
    input: exit1({
      structured: [errorResult('error_during_execution', ['No conversation found with session ID: abc'])],
    }),
    category: 'resume_failed',
    by: 'regex',
  },
  {
    name: 'startup session_held_by_background',
    input: exit1({ structured: [startupFailure('session_held_by_background')] }),
    category: 'resume_failed',
    by: 'structured',
  },
  // stream_malformed
  {
    name: '3 unparseable lines',
    input: claude({ exitCode: 0, protocol: { malformedLines: 3 } }),
    category: 'stream_malformed',
    by: 'structured',
  },
  {
    name: 'exit 0 without result',
    input: claude({ exitCode: 0, structured: [initFrame], protocol: { noTerminal: true } }),
    category: 'stream_malformed',
    by: 'exit',
  },
  {
    name: 'schema failure on a known frame',
    input: claude({ protocol: { schemaError: 'result.usage: expected object' } }),
    category: 'stream_malformed',
    by: 'structured',
  },
  // config_invalid
  {
    name: 'startup bypass_root',
    input: exit1({ structured: [startupFailure('bypass_root')] }),
    category: 'config_invalid',
    by: 'structured',
  },
  {
    name: 'startup managed_settings_invalid',
    input: exit1({ structured: [startupFailure('managed_settings_invalid')] }),
    category: 'config_invalid',
    by: 'structured',
  },
  // git_missing / git_state
  {
    name: 'git ENOENT',
    input: { vendor: 'git', now: NOW, errno: 'ENOENT' },
    category: 'git_missing',
    by: 'errno',
  },
  {
    name: 'dubious ownership',
    input: {
      vendor: 'git',
      now: NOW,
      exitCode: 128,
      stderrTail: "fatal: detected dubious ownership in repository at 'C:/r'",
    },
    category: 'git_state',
    by: 'regex',
  },
  {
    name: 'index.lock exists',
    input: {
      vendor: 'git',
      now: NOW,
      exitCode: 128,
      stderrTail: "fatal: Unable to create 'C:/r/.git/index.lock': File exists.",
    },
    category: 'git_state',
    by: 'regex',
  },
  // folder_guard
  {
    name: 'startup cwd_unavailable',
    input: exit1({ structured: [startupFailure('cwd_unavailable')] }),
    category: 'folder_guard',
    by: 'structured',
  },
  // timers / stop
  {
    name: 'stall timer',
    input: claude({ appInitiated: { kind: 'stall' } }),
    category: 'timeout_stall',
    by: 'app',
  },
  {
    name: 'hard timer',
    input: claude({ appInitiated: { kind: 'hard' }, exitCode: 1 }),
    category: 'timeout_hard',
    by: 'app',
  },
  {
    name: 'loop stop (the same call too many times)',
    input: claude({ appInitiated: { kind: 'loop' }, exitCode: 1 }),
    category: 'runaway_loop',
    by: 'app',
  },
  {
    name: 'ask timer',
    input: claude({ appInitiated: { kind: 'ask' } }),
    category: 'ask_timeout',
    by: 'app',
  },
  {
    name: 'user stop',
    input: claude({ appInitiated: { kind: 'stop' }, exitCode: 143 }),
    category: 'user_cancelled',
    by: 'app',
  },
  // turn_limit
  {
    name: 'error_max_turns',
    input: exit1({ structured: [errorResult('error_max_turns')] }),
    category: 'turn_limit',
    by: 'structured',
    rule: 'claude.result.error_max_turns',
  },
  {
    name: 'error_max_budget_usd',
    input: exit1({ structured: [errorResult('error_max_budget_usd')] }),
    category: 'turn_limit',
    by: 'structured',
  },
  {
    name: 'assistant max_output_tokens',
    input: exit1({ structured: [assistantError('max_output_tokens')] }),
    category: 'turn_limit',
    by: 'structured',
  },
  // context_exceeded
  {
    name: 'prompt is too long',
    input: exit1({ structured: [errorText('Prompt is too long')] }),
    category: 'context_exceeded',
    by: 'regex',
    rule: 'claude.regex.prompt-too-long',
  },
  {
    name: 'terminal_reason prompt_too_long',
    input: exit1({ structured: [errorText('Request failed', { terminal_reason: 'prompt_too_long' })] }),
    category: 'context_exceeded',
    by: 'structured',
  },
  {
    name: 'invalid_request + prompt too long',
    input: exit1({
      structured: [assistantError('invalid_request', 'Prompt is too long: 210000 tokens > 200000 maximum')],
    }),
    category: 'context_exceeded',
    by: 'structured',
  },
  // content_policy
  {
    name: 'model_refusal_no_fallback',
    input: exit1({ structured: [refusal(), errorText('Request refused')] }),
    category: 'content_policy',
    by: 'structured',
  },
  // vendor_internal
  {
    name: 'Repeated 529 Overloaded',
    input: exit1({ structured: [errorText('API Error: Repeated 529 Overloaded errors')] }),
    category: 'vendor_internal',
    by: 'regex',
    rule: 'claude.regex.overloaded',
  },
  {
    name: 'assistant overloaded',
    input: exit1({ structured: [assistantError('overloaded', 'Overloaded')] }),
    category: 'vendor_internal',
    by: 'structured',
  },
  {
    name: 'assistant server_error',
    input: exit1({ structured: [assistantError('server_error')] }),
    category: 'vendor_internal',
    by: 'structured',
  },
  {
    name: 'api_error_status 529',
    input: exit1({ structured: [errorText('API Error', { api_error_status: 529 })] }),
    category: 'vendor_internal',
    by: 'structured',
  },
  {
    name: 'RPC overloaded -32001',
    input: { vendor: 'codex', now: NOW, rpcError: { code: -32001, message: 'Server overloaded' } },
    category: 'vendor_internal',
    by: 'structured',
  },
  // process_crash
  {
    name: 'Windows access violation 0xC0000005',
    input: claude({ exitCode: 3221225477, stderrTail: 'boom' }),
    category: 'process_crash',
    by: 'exit',
    rule: 'generic.exit.windows-crash',
  },
  {
    name: 'Windows fail-fast 0xC0000409',
    input: claude({ exitCode: 3221226505 }),
    category: 'process_crash',
    by: 'exit',
  },
  {
    name: 'SIGSEGV',
    input: claude({ exitCode: null, signal: 'SIGSEGV' }),
    category: 'process_crash',
    by: 'exit',
  },
  {
    name: 'external SIGTERM (exit 143, not Dim Factory)',
    input: claude({ exitCode: 143 }),
    category: 'process_crash',
    by: 'exit',
  },
  {
    name: 'non-zero exit, nothing to read',
    input: exit1({}),
    category: 'process_crash',
    by: 'exit',
    rule: 'exit.silent-nonzero',
  },
  {
    name: 'heuristic: out of memory',
    input: exit1({
      stderrTail: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    }),
    category: 'process_crash',
    by: 'heuristic',
  },
  // disk_full
  { name: 'errno ENOSPC', input: claude({ errno: 'ENOSPC' }), category: 'disk_full', by: 'errno' },
  {
    name: 'ENOSPC text',
    input: exit1({ stderrTail: 'Error: ENOSPC: no space left on device, write' }),
    category: 'disk_full',
    by: 'regex',
    rule: 'generic.regex.disk-full',
  },
  {
    name: 'Windows disk full text',
    input: exit1({ stderrTail: 'There is not enough space on the disk.' }),
    category: 'disk_full',
    by: 'regex',
  },
  // unknown
  {
    name: 'unmatched stderr',
    input: exit1({ stderrTail: 'Something unexpected happened in the frobnicator' }),
    category: 'unknown',
    by: 'heuristic',
    rule: 'unknown',
  },
  {
    name: 'unmatched is_error result',
    input: claude({ exitCode: 0, structured: [errorText('A brand new failure mode')] }),
    category: 'unknown',
    by: 'heuristic',
  },
  {
    name: 'failed:true with no evidence',
    input: claude({ failed: true }),
    category: 'unknown',
    by: 'heuristic',
  },
]

describe('classify: one case per reachable category', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = classifyDetailed(c.input)
    expect(r).not.toBeNull()
    expect(r!.failure.category).toBe(c.category)
    expect(r!.failure.classifiedBy).toBe(c.by)
    if (c.rule) expect(r!.rule).toBe(c.rule)
    expect(r!.failure.message.trim()).not.toBe('')
  })

  it('reaches every category the Claude and generic tables can produce', () => {
    const reached = new Set(CASES.map((c) => c.category))
    const notFromSignals: FailureCategory[] = [
      'sandbox_unavailable',
      'trust_required',
      'snapshot_failed',
      'worktree_failed',
      'deps_missing',
      'verify_failed',
      'verify_untrusted',
      'permission_denied',
    ]
    for (const c of FAILURE_CATEGORIES) {
      if (notFromSignals.includes(c)) expect(reached.has(c)).toBe(false)
      else expect(reached.has(c), c).toBe(true)
    }
  })
})

describe('precedence', () => {
  it('a Dim Factory stop beats exit 143 and any vendor error', () => {
    const f = classify(
      claude({
        appInitiated: { kind: 'stop' },
        exitCode: 143,
        structured: [assistantError('authentication_failed', 'Not logged in')],
        stderrTail: 'Not logged in',
      }),
    )!
    expect(f).toMatchObject({ category: 'user_cancelled', classifiedBy: 'app' })
  })

  it('a quit/relaunch is not a failure', () => {
    expect(classify(claude({ appInitiated: { kind: 'quit' }, exitCode: 1, failed: true }))).toBeNull()
  })

  it('errno beats structured fields', () => {
    expect(classify(claude({ errno: 'ENOENT', structured: [errorText('Not logged in')] }))!.category).toBe(
      'cli_missing',
    )
  })

  it('an unmapped errno falls through to later stages', () => {
    expect(
      classify(exit1({ errno: 'EPIPE', stderrTail: 'Not logged in · Please run /login' }))!.category,
    ).toBe('auth_required')
  })

  it('structured beats exit code and regex', () => {
    const f = classify(
      claude({
        exitCode: 3221225477,
        structured: [assistantError('billing_error')],
        stderrTail: 'Not logged in',
      }),
    )!
    expect(f).toMatchObject({ category: 'billing', classifiedBy: 'structured' })
  })

  it('exit-code table beats regex', () => {
    expect(classify(claude({ exitCode: 3221225477, stderrTail: 'Not logged in' }))!.category).toBe(
      'process_crash',
    )
  })

  it('vendor regex beats generic regex and heuristics', () => {
    const r = classifyDetailed(
      exit1({ stderrTail: "error: unknown option '--x'\nError: getaddrinfo ENOTFOUND x" }),
    )!
    expect(r.rule).toBe('claude.regex.unknown-option')
    expect(r.failure.classifiedBy).toBe('regex')
  })

  it('subagent assistant errors are ignored', () => {
    const f = classify(exit1({ structured: [assistantError('billing_error', '', 'toolu_1')] }))!
    expect(f.category).not.toBe('billing')
  })
})

describe('retries are never failures on their own', () => {
  it('api_retry frames with a clean exit → null', () => {
    const frames = [
      initFrame,
      apiRetry('rate_limit', 429),
      apiRetry('overloaded', 529, 2),
      keepAlive,
      okResult(),
    ]
    expect(classify(claude({ exitCode: 0, structured: frames }))).toBeNull()
  })

  it('Codex-style willRetry errors with a clean exit → null', () => {
    const frames = [{ method: 'error', params: { error: { message: 'Reconnecting… 1/5' }, willRetry: true } }]
    expect(isWillRetryFrame(frames[0])).toBe(true)
    expect(classify({ vendor: 'codex', now: NOW, exitCode: 0, structured: frames })).toBeNull()
  })

  it('a final error result beats the retries before it', () => {
    const frames = [
      apiRetry('overloaded', 529),
      apiRetry('overloaded', 529, 2),
      errorText('Credit balance is too low'),
    ]
    expect(classify(exit1({ structured: frames }))!.category).toBe('billing')
  })

  it('retries are supporting evidence when nothing else explains the failure', () => {
    const r = classifyDetailed(
      exit1({ structured: [apiRetry('authentication_failed', 401, 3)], stderrTail: '' }),
    )!
    expect(r.failure).toMatchObject({ category: 'auth_required', classifiedBy: 'structured' })
    expect(r.rule).toBe('claude.api_retry.authentication_failed')
    expect(r.failure.message).toContain('attempt 3/10')
  })

  it('a retry with only an HTTP status maps through the status table', () => {
    expect(classify(exit1({ structured: [apiRetry('unknown', 503)] }))!.category).toBe('vendor_internal')
  })
})

describe('no failure evidence → null', () => {
  it.each([
    ['clean exit', claude({ exitCode: 0, structured: [initFrame, okResult()] })],
    [
      'warning on stderr, clean exit',
      claude({ exitCode: 0, stderrTail: 'Warning: Not logged in to telemetry' }),
    ],
    [
      'allowed rate-limit event',
      claude({
        exitCode: 0,
        structured: [rateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour' })],
      }),
    ],
    [
      'rejection covered by overage',
      claude({
        exitCode: 0,
        structured: [
          rateLimit({
            status: 'rejected',
            rateLimitType: 'five_hour',
            overageStatus: 'allowed',
            isUsingOverage: true,
          }),
        ],
      }),
    ],
  ])('%s', (_name, input) => {
    expect(classify(input)).toBeNull()
  })
})

describe('Failure fields', () => {
  it('carries resetsAt (seconds → ms) and retryAfterMs', () => {
    const resetsSec = Math.floor(NOW / 1000) + 90
    const f = classify(
      exit1({
        structured: [rateLimit({ status: 'rejected', resetsAt: resetsSec, rateLimitType: 'overage' })],
      }),
    )!
    expect(f.category).toBe('rate_limited')
    expect(f.resetsAt).toBe(resetsSec * 1000)
    expect(f.retryAfterMs).toBe(resetsSec * 1000 - NOW)
    expect(f.message).toContain('Rate limited (overage) until')
  })

  it('resetsAtMs accepts seconds and milliseconds', () => {
    expect(resetsAtMs(1_760_000_000)).toBe(1_760_000_000_000)
    expect(resetsAtMs(1_760_000_000_123)).toBe(1_760_000_000_123)
    expect(resetsAtMs(-1)).toBeUndefined()
    expect(resetsAtMs('x')).toBeUndefined()
  })

  it('message is the matching line; raw is redacted evidence', () => {
    const stderr = [
      'starting...',
      'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA for someone@example.com',
      'Invalid API key · Fix external API key',
    ]
    const r = classifyDetailed(exit1({ stderrTail: stderr, step: 'implement' }))!
    expect(r.failure.message).toBe('Invalid API key · Fix external API key')
    expect(r.failure.step).toBe('implement')
    expect(r.failure.raw).not.toContain('sk-ant-')
    expect(r.failure.raw).not.toContain('someone@example.com')
    expect(r.hints).toEqual(['claude-env-key'])
  })

  it('structured raw is the matching frame', () => {
    const f = classify(
      exit1({ structured: [initFrame, errorResult('error_max_turns', ['Reached max turns (1)'])] }),
    )!
    expect(JSON.parse(f.raw)).toMatchObject({ type: 'result', subtype: 'error_max_turns' })
    expect(f.message).toBe('Reached max turns (1)')
  })

  it('accepts raw JSON lines as frames', () => {
    const line = JSON.stringify(startupFailure('cli_version_too_old'))
    expect(classify(exit1({ structured: [line, 'not json'] }))!.category).toBe('cli_version')
  })

  it('caps raw at 4000 chars', () => {
    const f = classify(exit1({ stderrTail: `${'x'.repeat(10_000)}\nNot logged in` }))!
    expect(f.raw.length).toBeLessThanOrEqual(4000)
    expect(f.raw.endsWith('Not logged in')).toBe(true)
  })

  it('JSON raw is redacted by key too (uuid, secret-named fields)', () => {
    const frame = { ...errorResult('error_max_turns'), uuid: 'u-1234', apiKey: 'plain-looking' }
    const f = classify(exit1({ structured: [frame] }))!
    expect(f.raw).not.toMatch(/u-1234|plain-looking/)
    expect(JSON.parse(f.raw)).toMatchObject({ subtype: 'error_max_turns', uuid: '[REDACTED]' })
  })

  it('Dim Factory kills carry their evidence redacted and capped like any raw', () => {
    const raw = `${'y'.repeat(9_000)} token sk-ant-api03-${'B'.repeat(40)} for someone@example.com`
    const f = classify(claude({ appInitiated: { kind: 'deny', raw } }))!
    expect(f).toMatchObject({ category: 'permission_denied', classifiedBy: 'app' })
    expect(f.raw.length).toBeLessThanOrEqual(4000)
    expect(f.raw).not.toMatch(/sk-ant-|someone@example\.com/)
  })
})

describe('signal tables', () => {
  it('local-<preset> vendors share the codex table', () => {
    expect(signalTableFor('local-ollama')).toBe(signalTableFor('codex'))
    expect(signalTableFor('claude')).toBe(CLAUDE_SIGNALS)
  })

  it('a registered table plugs into every stage', () => {
    registerSignalTable({
      vendor: 'testvendor',
      hasFailure: (fs) => fs.some((f) => (f as { fail?: boolean }).fail === true),
      structured: (fs) =>
        fs.some((f) => (f as { code?: string }).code === 'quota')
          ? { category: 'quota_exceeded', rule: 'test.structured', message: 'quota' }
          : undefined,
      exit: [{ id: 'test.exit.55', codes: [55], category: 'trust_required' }],
      regex: [{ id: 'test.regex', re: /sandbox: read-only/, category: 'sandbox_unavailable' }],
    })
    const t = (o: Partial<ClassifyInput>) => classifyDetailed({ vendor: 'testvendor', now: NOW, ...o })!
    expect(t({ structured: [{ fail: true, code: 'quota' }] }).rule).toBe('test.structured')
    expect(t({ exitCode: 55 }).failure.category).toBe('trust_required')
    expect(t({ exitCode: 1, stderrTail: 'sandbox: read-only' }).failure.category).toBe('sandbox_unavailable')
  })

  it('regex tables are well-formed (no global flags, unique ids)', () => {
    const all = [...CLAUDE_REGEX, ...GENERIC_REGEX]
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length)
    for (const r of all) expect(r.re.global || r.re.sticky).toBe(false)
  })

  it('errnoCategory', () => {
    expect(errnoCategory('enoent', { vendor: 'claude' })).toBe('cli_missing')
    expect(errnoCategory('ETIMEDOUT', { vendor: 'codex', loopback: true })).toBe('local_server')
    expect(errnoCategory('EPIPE', { vendor: 'claude' })).toBeUndefined()
    expect(errnoCategory('ECWD', { vendor: 'claude' })).toBe('folder_guard')
  })
})
