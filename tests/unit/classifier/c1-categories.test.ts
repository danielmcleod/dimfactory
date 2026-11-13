// Classifier suite, one test per failure category. Each category lists its
// cases by detection column: C = Claude, X = Codex (and local-<preset>), G = Gemini/ACP, * = any vendor,
// app = Dim Factory's own detection. `source: 'recorded'` cases read tests/fixtures/claude/stdio/*, adding only
// what Dim Factory itself knew (a kill it made, a protocol flag). X and G cases without a recording are SYNTHESIZED.
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyDetailed } from '@core/heal/classify.ts'
import type { ClassifyInput } from '@core/heal/classify.ts'
import type { ClassifiedBy, FailureCategory } from '@shared/failure.ts'
import { FAILURE_CATEGORIES } from '@shared/failure.ts'
import { assistantError, errorText, rateLimit, refusal, startupFailure } from '../heal/claude-frames.ts'
import {
  GEMINI_AUTH_TEXT,
  NOW,
  STDIO,
  acpErrorResponse,
  acpStop,
  claude,
  codex,
  codexError,
  codexTurnFailed,
  app,
  execTurnFailed,
  gemini,
  gemini429,
  local,
  recorded,
} from './inputs.ts'

type Column = 'C' | 'X' | 'G' | '*' | 'app'

interface Case {
  name: string
  column: Column
  source: 'recorded' | 'synthesized'
  /** Recorded fixture id (source 'recorded'). */
  fixture?: string
  input: ClassifyInput
  by: ClassifiedBy
  rule: string
  hints?: string[]
  retryAfterMs?: number
  message?: string
}

const rec = (fixture: string, extra: Partial<ClassifyInput> = {}) => ({
  source: 'recorded' as const,
  fixture,
  input: recorded(fixture, extra),
})
const syn = (input: ClassifyInput) => ({ source: 'synthesized' as const, input })

const exit1 = (o: Partial<ClassifyInput>) => claude({ exitCode: 1, ...o })

/** Failure table detection columns per category: each needs at least one case. */
const COLUMNS: Record<FailureCategory, readonly Column[]> = {
  cli_missing: ['*', 'X', 'C', 'app'],
  cli_version: ['C', 'app'],
  flag_drift: ['C', 'X', 'G', 'app'],
  auth_required: ['C', 'X', 'G'],
  auth_expired: ['C', 'X'],
  rate_limited: ['C', 'X', 'G'],
  quota_exceeded: ['C', 'X', 'G'],
  billing: ['C', 'X'],
  model_unavailable: ['C', 'X', 'G'],
  network: ['*', 'X'],
  sandbox_unavailable: ['X', 'G'],
  trust_required: ['G', 'app'],
  capability_missing: ['app', 'X', 'G'],
  resume_failed: ['C', 'X', 'G', 'app'],
  stream_malformed: ['*', 'C'],
  config_invalid: ['app', 'G', 'X', 'C'],
  git_missing: ['*'],
  git_state: ['*', 'app'],
  folder_guard: ['app', 'C'],
  snapshot_failed: ['app'],
  worktree_failed: ['app'],
  deps_missing: ['app'],
  local_server: ['*', 'X'],
  verify_failed: ['app'],
  verify_untrusted: ['app'],
  timeout_stall: ['app'],
  timeout_hard: ['app'],
  ask_timeout: ['app'],
  permission_denied: ['X', 'app'],
  turn_limit: ['C', 'G'],
  context_exceeded: ['X', 'C', 'G'],
  runaway_loop: ['app'],
  content_policy: ['X', 'C', 'G'],
  vendor_internal: ['C', 'X'],
  process_crash: ['*', 'C'],
  disk_full: ['*', 'G', 'app'],
  user_cancelled: ['app'],
  unknown: ['*', 'C', 'X'],
}

const C1: Record<FailureCategory, readonly Case[]> = {
  cli_missing: [
    {
      name: 'spawn ENOENT',
      column: '*',
      ...syn(claude({ errno: 'ENOENT' })),
      by: 'errno',
      rule: 'errno.ENOENT',
    },
    {
      name: 'startup shell_tool_missing',
      column: 'C',
      ...syn(exit1({ structured: [startupFailure('shell_tool_missing')] })),
      by: 'structured',
      rule: 'claude.startup.shell_tool_missing',
    },
    {
      name: 'Codex platform package missing',
      column: 'X',
      ...syn(
        codex({
          exitCode: 1,
          stderrTail:
            'Error: Missing optional dependency @openai/codex-win32-x64. Reinstall Codex: npm install -g @openai/codex@latest',
        }),
      ),
      by: 'regex',
      rule: 'codex.regex.missing-optional-dependency',
    },
    {
      name: 'placeholder stub found by resolve-cli',
      column: 'app',
      ...syn(claude({ appDetected: { check: 'cli-placeholder' } })),
      by: 'app',
      rule: 'app.check.cli-placeholder',
    },
  ],
  cli_version: [
    {
      name: 'startup cli_version_too_old',
      column: 'C',
      ...syn(exit1({ structured: [startupFailure('cli_version_too_old')] })),
      by: 'structured',
      rule: 'claude.startup.cli_version_too_old',
    },
    {
      name: 'probe: below the floor',
      column: 'app',
      ...syn(
        claude({
          appDetected: { check: 'cli-below-floor', detail: 'Claude Code 2.0.1 is below 2.1.0.' },
        }),
      ),
      by: 'app',
      rule: 'app.check.cli-below-floor',
      message: 'Claude Code 2.0.1 is below 2.1.0.',
    },
  ],
  flag_drift: [
    {
      name: 'C11a unknown option',
      column: 'C',
      ...rec('C11a-unknown-flag'),
      by: 'regex',
      rule: 'claude.regex.unknown-option',
      message: "error: unknown option '--not-a-real-flag'",
    },
    {
      name: 'Codex exit 2 unexpected argument',
      column: 'X',
      ...syn(
        codex({
          exitCode: 2,
          stderrTail: [
            "error: unexpected argument '--full-auto' found",
            '',
            "  tip: to pass '--full-auto' as a value, use '-- --full-auto'",
          ],
        }),
      ),
      by: 'regex',
      rule: 'codex.regex.unexpected-argument',
    },
    {
      name: 'Gemini exit 42 (FatalInputError)',
      column: 'G',
      ...syn(gemini({ exitCode: 42, stderrTail: 'Unknown argument: approval-mode' })),
      by: 'exit',
      rule: 'gemini.exit.42',
    },
    {
      name: 'ACP set_mode: Invalid or unavailable mode',
      column: 'G',
      ...syn(
        gemini({
          rpcError: {
            code: -32603,
            message: 'Invalid or unavailable mode: autoEdit',
            method: 'session/set_mode',
          },
        }),
      ),
      by: 'structured',
      rule: 'acp.rpc.invalid-mode',
    },
    {
      name: 'ACP -32601 on a required method',
      column: 'G',
      ...syn(
        gemini({
          rpcError: { code: -32601, message: 'Method not found', method: 'session/prompt', required: true },
        }),
      ),
      by: 'structured',
      rule: 'generic.rpc.method-not-found',
    },
    {
      // codex-cli 0.160.1 answers an unknown method with -32600 "unknown variant" (protocol.ts).
      name: 'Codex -32600 unknown variant on a required method (0.160.1 form)',
      column: 'X',
      ...syn(
        codex({
          rpcError: {
            code: -32600,
            message:
              'Invalid request: unknown variant `turn/start`, expected one of `initialize`, `thread/start`',
            method: 'turn/start',
            required: true,
          },
        }),
      ),
      by: 'structured',
      rule: 'codex.rpc.unknown-method',
    },
    {
      name: 'Codex -32600 unknown variant on thread/resume (0.160.1 form; not resume_failed)',
      column: 'X',
      ...syn(
        codex({
          rpcError: {
            code: -32600,
            message: 'Invalid request: unknown variant `thread/resume`, expected one of `initialize`',
            method: 'thread/resume',
            required: true,
          },
        }),
      ),
      by: 'structured',
      rule: 'codex.rpc.unknown-method',
    },
    {
      name: 'Codex -32601 on a required method',
      column: 'X',
      ...syn(
        codex({
          rpcError: { code: -32601, message: 'Method not found', method: 'turn/start', required: true },
        }),
      ),
      by: 'structured',
      rule: 'generic.rpc.method-not-found',
    },
    {
      name: 'handshake timeout',
      column: 'app',
      ...syn(claude({ appInitiated: { kind: 'handshake' }, exitCode: null, signal: 'SIGKILL' })),
      by: 'app',
      rule: 'app.handshake',
    },
  ],
  auth_required: [
    {
      name: 'C09b logged out',
      column: 'C',
      ...rec('C09b-logged-out'),
      by: 'structured',
      rule: 'claude.assistant.error.authentication_failed',
      message: 'Not logged in · Please run /login',
    },
    {
      name: 'C09c invalid API key (env key hint)',
      column: 'C',
      ...rec('C09c-invalid-api-key'),
      by: 'structured',
      rule: 'claude.assistant.error.authentication_failed',
      hints: ['claude-env-key'],
    },
    {
      name: '`claude auth status` exit 1',
      column: 'C',
      ...syn(exit1({ stdoutTail: ['{', '  "loggedIn": false,', '  "authMethod": "none"', '}'] })),
      by: 'regex',
      rule: 'claude.regex.auth-status',
    },
    {
      name: '`codex login status` exit 1',
      column: 'X',
      ...syn(codex({ exitCode: 1, stderrTail: 'Not logged in' })),
      by: 'regex',
      rule: 'codex.regex.not-logged-in',
    },
    {
      name: 'Gemini exit 41',
      column: 'G',
      ...syn(gemini({ exitCode: 41, stderrTail: GEMINI_AUTH_TEXT })),
      by: 'exit',
      rule: 'gemini.exit.41',
    },
    {
      name: 'Gemini "Please set an Auth method" text',
      column: 'G',
      ...syn(gemini({ failed: true, stderrTail: GEMINI_AUTH_TEXT })),
      by: 'regex',
      rule: 'gemini.regex.auth-method',
    },
    {
      name: 'ACP authRequired on session/new',
      column: 'G',
      ...syn(
        gemini({ rpcError: { code: -32000, message: 'Authentication required', method: 'session/new' } }),
      ),
      by: 'structured',
      rule: 'acp.rpc.auth-required',
    },
  ],
  auth_expired: [
    {
      name: 'OAuth token has expired',
      column: 'C',
      ...syn(exit1({ structured: [errorText('OAuth token has expired. Please run /login')] })),
      by: 'regex',
      rule: 'claude.regex.login-expired',
    },
    {
      name: 'app-server unauthorized while logged in',
      column: 'X',
      ...syn(
        codex({
          structured: [codexTurnFailed('unauthorized', 'unexpected status 401 Unauthorized: token expired')],
        }),
      ),
      by: 'structured',
      rule: 'codex.error.unauthorized',
    },
    {
      name: 'exec 401 Unauthorized',
      column: 'X',
      ...syn(codex({ exitCode: 1, structured: [execTurnFailed('unexpected status 401 Unauthorized')] })),
      by: 'regex',
      rule: 'codex.regex.unauthorized',
    },
  ],
  rate_limited: [
    {
      name: 'rate_limit_event rejected, no quota window',
      column: 'C',
      ...syn(exit1({ structured: [rateLimit({ status: 'rejected', resetsAt: NOW / 1000 + 90 })] })),
      by: 'structured',
      rule: 'claude.rate_limit_event.rejected',
      retryAfterMs: 90_000,
    },
    {
      name: 'Claude API Error 429',
      column: 'C',
      ...syn(exit1({ structured: [errorText('API Error: Request rejected (429) · retry later')] })),
      by: 'regex',
      rule: 'claude.regex.rate-429',
    },
    {
      name: 'app-server rateLimitExceeded',
      column: 'X',
      ...syn(
        codex({
          structured: [
            codexError(
              'rateLimitExceeded',
              'Rate limit reached for gpt-5.5. Please try again in 20s.',
              false,
            ),
          ],
        }),
      ),
      by: 'structured',
      rule: 'codex.error.rateLimitExceeded',
      retryAfterMs: 20_000,
    },
    {
      name: 'Gemini per-minute 429',
      column: 'G',
      ...syn(
        gemini({
          exitCode: 1,
          stderrTail: gemini429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
        }),
      ),
      by: 'regex',
      rule: 'gemini.regex.rate-per-minute',
      retryAfterMs: 41_500,
    },
  ],
  quota_exceeded: [
    {
      name: 'rate_limit_event five_hour',
      column: 'C',
      ...syn(
        exit1({
          structured: [
            rateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: NOW / 1000 + 3600 }),
          ],
        }),
      ),
      by: 'structured',
      rule: 'claude.rate_limit_event.quota',
      retryAfterMs: 3_600_000,
    },
    {
      name: "You've hit your limit",
      column: 'C',
      ...syn(
        exit1({ structured: [errorText("You've hit your session limit · resets 3pm (Europe/London)")] }),
      ),
      by: 'regex',
      rule: 'claude.regex.hit-limit',
    },
    {
      name: 'app-server usageLimitExceeded',
      column: 'X',
      ...syn(
        codex({
          structured: [
            codexTurnFailed(
              'usageLimitExceeded',
              "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 days 3 hours 4 minutes.",
            ),
          ],
        }),
      ),
      by: 'structured',
      rule: 'codex.error.usageLimitExceeded',
      retryAfterMs: (2 * 86_400 + 3 * 3_600 + 4 * 60) * 1000,
    },
    {
      name: 'app-server sessionBudgetExceeded',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('sessionBudgetExceeded', 'Session budget exceeded')] })),
      by: 'structured',
      rule: 'codex.error.sessionBudgetExceeded',
    },
    {
      name: 'Gemini per-day quota',
      column: 'G',
      ...syn(
        gemini({
          exitCode: 1,
          stderrTail: gemini429(
            'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            'Please retry in 7h3m12s.',
          ),
        }),
      ),
      by: 'regex',
      rule: 'gemini.regex.quota-daily',
      retryAfterMs: (7 * 3_600 + 3 * 60 + 12) * 1000,
    },
  ],
  billing: [
    {
      name: 'Credit balance is too low',
      column: 'C',
      ...syn(exit1({ structured: [errorText('Credit balance is too low')] })),
      by: 'regex',
      rule: 'claude.regex.credit-balance',
    },
    {
      name: 'assistant account_on_hold',
      column: 'C',
      ...syn(exit1({ structured: [assistantError('account_on_hold')] })),
      by: 'structured',
      rule: 'claude.assistant.error.account_on_hold',
    },
    {
      name: 'Codex insufficient_quota',
      column: 'X',
      ...syn(
        codex({
          exitCode: 1,
          structured: [
            execTurnFailed(
              "429 Too Many Requests: You exceeded your current quota, please check your plan and billing details. (type: insufficient_quota, code: 'insufficient_quota')",
            ),
          ],
        }),
      ),
      by: 'regex',
      rule: 'codex.regex.insufficient-quota',
    },
  ],
  model_unavailable: [
    {
      name: 'C11b invalid model',
      column: 'C',
      ...rec('C11b-invalid-model'),
      by: 'structured',
      rule: 'claude.assistant.error.model_not_found',
    },
    {
      name: 'app-server badRequest naming the model',
      column: 'X',
      ...syn(
        codex({
          structured: [
            codexTurnFailed(
              'badRequest',
              'The model `gpt-9` does not exist or you do not have access to it.',
            ),
          ],
        }),
      ),
      by: 'structured',
      rule: 'codex.error.badRequest',
    },
    {
      name: 'app-server flexUnavailable',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('flexUnavailable', 'Flex processing is unavailable')] })),
      by: 'structured',
      rule: 'codex.error.flexUnavailable',
    },
    {
      name: 'Gemini model not found',
      column: 'G',
      ...syn(
        gemini({
          exitCode: 1,
          stderrTail:
            '[API Error: models/gemini-9-pro is not found for API version v1beta, or is not supported for generateContent.]',
        }),
      ),
      by: 'regex',
      rule: 'gemini.regex.model',
    },
  ],
  network: [
    {
      name: 'errno ECONNRESET',
      column: '*',
      ...syn(claude({ errno: 'ECONNRESET' })),
      by: 'errno',
      rule: 'errno.ECONNRESET',
    },
    {
      name: 'getaddrinfo ENOTFOUND',
      column: '*',
      ...syn(exit1({ stderrTail: 'Error: getaddrinfo ENOTFOUND api.anthropic.com' })),
      by: 'regex',
      rule: 'generic.regex.network',
    },
    {
      name: 'app-server httpConnectionFailed',
      column: 'X',
      ...syn(
        codex({
          structured: [
            codexError(
              { httpConnectionFailed: { httpStatusCode: null } },
              'error sending request for url (https://api.openai.com/v1/responses)',
              false,
            ),
          ],
        }),
      ),
      by: 'structured',
      rule: 'codex.error.httpConnectionFailed',
    },
    {
      name: 'app-server responseStreamDisconnected',
      column: 'X',
      ...syn(
        codex({
          structured: [
            codexTurnFailed(
              { responseStreamDisconnected: { httpStatusCode: 502 } },
              'stream disconnected before completion',
            ),
          ],
        }),
      ),
      by: 'structured',
      rule: 'codex.error.responseStreamDisconnected',
    },
  ],
  sandbox_unavailable: [
    {
      name: 'app-server sandboxError',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('sandboxError', 'sandbox error: setup failed')] })),
      by: 'structured',
      rule: 'codex.error.sandboxError',
    },
    {
      name: 'CreateRestrictedToken failed',
      column: 'X',
      ...syn(codex({ exitCode: 1, stderrTail: 'Error: CreateRestrictedToken failed: 87' })),
      by: 'regex',
      rule: 'codex.regex.sandbox-setup',
    },
    {
      name: '`sandbox: read-only` when autoedit was requested',
      column: 'X',
      ...syn(codex({ exitCode: 1, mode: 'autoedit', stderrTail: ['workdir: C:/r', 'sandbox: read-only'] })),
      by: 'regex',
      rule: 'codex.regex.sandbox-read-only',
    },
    {
      name: 'Gemini exit 44 (FatalSandboxError)',
      column: 'G',
      ...syn(gemini({ exitCode: 44 })),
      by: 'exit',
      rule: 'gemini.exit.44',
    },
    {
      name: 'Codex windowsSandbox readiness not ready',
      column: 'app',
      ...syn(codex({ appDetected: { check: 'sandbox-not-ready' } })),
      by: 'app',
      rule: 'app.check.sandbox-not-ready',
    },
  ],
  trust_required: [
    {
      name: 'Gemini exit 55 (untrusted workspace)',
      column: 'G',
      ...syn(
        gemini({
          exitCode: 55,
          stderrTail: 'Gemini CLI is not running in a trusted directory. To proceed, trust this folder.',
        }),
      ),
      by: 'exit',
      rule: 'gemini.exit.55',
    },
    {
      name: 'ACP set_mode refused in an untrusted folder',
      column: 'G',
      ...syn(
        gemini({
          rpcError: {
            code: -32603,
            message: 'Cannot enable privileged approval modes in an untrusted folder.',
            method: 'session/set_mode',
          },
        }),
      ),
      by: 'structured',
      rule: 'acp.rpc.untrusted',
    },
    {
      name: 'projectAuto grant missing',
      column: 'app',
      ...syn(app('claude', { appDetected: { check: 'grant-missing' } })),
      by: 'app',
      rule: 'app.check.grant-missing',
    },
  ],
  capability_missing: [
    {
      name: 'support() unsupported at a pass boundary',
      column: 'app',
      ...syn(
        claude({
          appDetected: { check: 'unsupported', detail: 'Claude cannot run Plan natively here.' },
        }),
      ),
      by: 'app',
      rule: 'app.check.unsupported',
    },
    {
      name: 'Codex -32601 on an optional method',
      column: 'X',
      ...syn(
        codex({
          rpcError: { code: -32601, message: 'Method not found', method: 'model/list', required: false },
        }),
      ),
      by: 'structured',
      rule: 'generic.rpc.method-not-found',
    },
    {
      name: 'Codex -32600 unknown variant on an optional method (0.160.1 form)',
      column: 'X',
      ...syn(
        codex({
          rpcError: {
            code: -32600,
            message: 'Invalid request: unknown variant `model/list`, expected one of `initialize`',
            method: 'model/list',
            required: false,
          },
        }),
      ),
      by: 'structured',
      rule: 'codex.rpc.unknown-method',
    },
    {
      name: 'Codex -32602 on an optional method',
      column: 'X',
      ...syn(
        codex({
          rpcError: { code: -32602, message: 'Invalid params', method: 'turn/start', required: false },
        }),
      ),
      by: 'structured',
      rule: 'generic.rpc.invalid-params-optional',
    },
    {
      name: 'ACP agent lacks session/load when needed',
      column: 'G',
      ...syn(
        gemini({
          rpcError: { code: -32601, message: 'Method not found', method: 'session/load', required: false },
        }),
      ),
      by: 'structured',
      rule: 'generic.rpc.method-not-found',
    },
  ],
  resume_failed: [
    {
      name: 'C08c bogus resume',
      column: 'C',
      ...rec('C08c-resume-bogus'),
      by: 'regex',
      rule: 'claude.regex.no-conversation',
    },
    {
      name: 'C08d bogus resume (startup results on)',
      column: 'C',
      ...rec('C08d-resume-bogus-startup-results'),
      by: 'regex',
      rule: 'claude.regex.no-conversation',
    },
    {
      name: 'transcript missing',
      column: 'app',
      ...syn(claude({ appDetected: { check: 'transcript-missing' } })),
      by: 'app',
      rule: 'app.check.transcript-missing',
    },
    {
      name: 'app-server threadRollbackFailed',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('threadRollbackFailed', 'Thread rollback failed')] })),
      by: 'structured',
      rule: 'codex.error.threadRollbackFailed',
    },
    {
      name: 'thread/resume error',
      column: 'X',
      ...syn(
        codex({
          rpcError: {
            code: -32600,
            message: 'no rollout found for thread id 0199a0c3-0000-7000-8000-000000000001',
            method: 'thread/resume',
            required: true,
          },
        }),
      ),
      by: 'structured',
      rule: 'codex.rpc.thread-resume',
    },
    {
      name: 'ACP Invalid session identifier',
      column: 'G',
      ...syn(
        gemini({
          rpcError: { code: -32602, message: 'Invalid session identifier format.', method: 'session/load' },
        }),
      ),
      by: 'structured',
      rule: 'acp.rpc.invalid-session',
    },
  ],
  stream_malformed: [
    {
      name: '3 unparseable lines',
      column: '*',
      ...syn(claude({ exitCode: 0, protocol: { malformedLines: 3 } })),
      by: 'structured',
      rule: 'protocol.malformed',
    },
    {
      name: 'unknown RPC id',
      column: '*',
      ...syn(codex({ protocol: { unknownRpcId: true } })),
      by: 'structured',
      rule: 'protocol.malformed',
    },
    {
      name: 'C16 frames: exit 0 without a result',
      column: 'C',
      ...rec('C16-probe-handshake', { protocol: { noTerminal: true } }),
      by: 'exit',
      rule: 'exit.zero-without-result',
    },
  ],
  config_invalid: [
    {
      name: 'Dim Factory schema error',
      column: 'app',
      ...syn(
        app('app', {
          appDetected: { check: 'config', detail: 'config.jsonc:3:5 Unknown key "promptTemplte"' },
        }),
      ),
      by: 'app',
      rule: 'app.check.config',
      message: 'config.jsonc:3:5 Unknown key "promptTemplte"',
    },
    {
      name: 'Gemini exit 52 (FatalConfigError)',
      column: 'G',
      ...syn(gemini({ exitCode: 52 })),
      by: 'exit',
      rule: 'gemini.exit.52',
    },
    {
      name: 'Codex wire_api = "chat"',
      column: 'X',
      ...syn(
        local({
          exitCode: 1,
          stderrTail:
            'Error loading config.toml: `wire_api = "chat"` is no longer supported. How to fix: set `wire_api = "responses"`',
        }),
      ),
      by: 'regex',
      rule: 'codex.regex.config-retired',
    },
    {
      name: 'Codex approval_policy = "untrusted"',
      column: 'X',
      ...syn(
        codex({
          exitCode: 1,
          stderrTail: 'approval_policy = "untrusted" is no longer supported; remove this setting',
        }),
      ),
      by: 'regex',
      rule: 'codex.regex.config-retired',
    },
    {
      name: 'startup bypass_root',
      column: 'C',
      ...syn(exit1({ structured: [startupFailure('bypass_root')] })),
      by: 'structured',
      rule: 'claude.startup.bypass_root',
    },
  ],
  git_missing: [
    {
      name: 'git ENOENT',
      column: '*',
      ...syn(app('git', { errno: 'ENOENT' })),
      by: 'errno',
      rule: 'errno.ENOENT',
    },
  ],
  git_state: [
    {
      name: 'dubious ownership',
      column: '*',
      ...syn(
        app('git', {
          exitCode: 128,
          stderrTail: "fatal: detected dubious ownership in repository at 'C:/r'",
        }),
      ),
      by: 'regex',
      rule: 'generic.regex.git-dubious',
      hints: ['git-dubious'],
    },
    {
      name: "index.lock': File exists",
      column: '*',
      ...syn(
        app('git', {
          exitCode: 128,
          stderrTail: "fatal: Unable to create 'C:/r/.git/index.lock': File exists.",
        }),
      ),
      by: 'regex',
      rule: 'generic.regex.git-lock',
      hints: ['git-lock'],
    },
    {
      name: 'operation in progress (op markers)',
      column: 'app',
      ...syn(app('git', { appDetected: { check: 'git-op', detail: 'A merge is in progress.' } })),
      by: 'app',
      rule: 'app.check.git-op',
      hints: ['git-op'],
    },
    {
      name: 'unborn HEAD',
      column: 'app',
      ...syn(app('git', { appDetected: { check: 'git-unborn' } })),
      by: 'app',
      rule: 'app.check.git-unborn',
    },
  ],
  folder_guard: [
    {
      name: 'guard refused the folder',
      column: 'app',
      ...syn(app('app', { appDetected: { check: 'folder-guard' } })),
      by: 'app',
      rule: 'app.check.folder-guard',
    },
    {
      name: 'folder over the size guard',
      column: 'app',
      ...syn(app('app', { appDetected: { check: 'folder-size' } })),
      by: 'app',
      rule: 'app.check.folder-size',
      hints: ['size-guard'],
    },
    {
      name: 'folder missing',
      column: 'app',
      ...syn(app('app', { appDetected: { check: 'folder-missing' } })),
      by: 'app',
      rule: 'app.check.folder-missing',
    },
    {
      name: 'startup cwd_unavailable',
      column: 'C',
      ...syn(exit1({ structured: [startupFailure('cwd_unavailable')] })),
      by: 'structured',
      rule: 'claude.startup.cwd_unavailable',
    },
  ],
  snapshot_failed: [
    {
      name: 'shadow write-tree failed',
      column: 'app',
      ...syn(
        app('git', {
          appDetected: { check: 'snapshot' },
          exitCode: 128,
          stderrTail: 'fatal: git-write-tree: error building trees',
        }),
      ),
      by: 'app',
      rule: 'app.check.snapshot',
    },
    {
      name: 'a shadow lock stays snapshot_failed (it retries)',
      column: 'app',
      ...syn(
        app('git', {
          appDetected: { check: 'snapshot' },
          exitCode: 128,
          stderrTail: "fatal: Unable to create 'C:/h/shadow/index.lock': File exists.",
        }),
      ),
      by: 'app',
      rule: 'app.check.snapshot',
    },
    {
      name: 'shadow refused an over-size folder',
      column: 'app',
      ...syn(app('git', { appDetected: { check: 'snapshot-size' } })),
      by: 'app',
      rule: 'app.check.snapshot-size',
      hints: ['size-guard'],
    },
  ],
  worktree_failed: [
    {
      name: 'worktree add: branch exists',
      column: 'app',
      ...syn(
        app('git', {
          appDetected: { check: 'worktree' },
          exitCode: 128,
          stderrTail: "fatal: a branch named 'dim/run-12' already exists",
        }),
      ),
      by: 'app',
      rule: 'app.check.worktree',
    },
    {
      name: 'worktree add: path too long',
      column: 'app',
      ...syn(
        app('git', {
          appDetected: { check: 'worktree' },
          exitCode: 128,
          stderrTail: 'error: unable to create file src/deeply/nested/path/file.ts: Filename too long',
        }),
      ),
      by: 'app',
      rule: 'app.check.worktree',
    },
    {
      name: 'worktree add: LFS smudge failure',
      column: 'app',
      ...syn(
        app('git', {
          appDetected: { check: 'worktree' },
          exitCode: 128,
          stderrTail: [
            'Error downloading object: assets/big.bin',
            'error: external filter git-lfs smudge failed',
          ],
        }),
      ),
      by: 'app',
      rule: 'app.check.worktree',
    },
  ],
  deps_missing: [
    {
      name: 'install tool missing',
      column: 'app',
      ...syn(
        app('install', {
          appDetected: { check: 'install', detail: 'pnpm was not found on PATH.' },
          errno: 'ENOENT',
        }),
      ),
      by: 'app',
      rule: 'app.check.install',
    },
    {
      name: 'install exit non-zero',
      column: 'app',
      ...syn(
        app('install', {
          appDetected: { check: 'install' },
          exitCode: 1,
          stderrTail: 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/nope: Not Found - 404',
        }),
      ),
      by: 'app',
      rule: 'app.check.install',
    },
    {
      name: 'verify exit 9009 (argv[0] unresolved, cmd.exe)',
      column: 'app',
      ...syn(
        app('verify', {
          appDetected: { check: 'verify' },
          exitCode: 9009,
          stderrTail: "'vitest' is not recognized as an internal or external command,",
        }),
      ),
      by: 'exit',
      rule: 'app.verify.env',
    },
    {
      name: 'verify: missing module',
      column: 'app',
      ...syn(
        app('verify', {
          appDetected: { check: 'verify' },
          exitCode: 1,
          stderrTail: "Error: Cannot find module 'typescript'",
        }),
      ),
      by: 'regex',
      rule: 'app.verify.env',
    },
    {
      name: 'verify spawn ENOENT',
      column: 'app',
      ...syn(app('verify', { appDetected: { check: 'verify' }, errno: 'ENOENT' })),
      by: 'errno',
      rule: 'app.verify.env',
    },
  ],
  local_server: [
    {
      name: 'ECONNREFUSED to the loopback baseUrl',
      column: '*',
      ...syn(local({ errno: 'ECONNREFUSED', loopback: true })),
      by: 'errno',
      rule: 'errno.ECONNREFUSED',
    },
    {
      name: 'ECONNREFUSED 127.0.0.1 text',
      column: '*',
      ...syn(local({ exitCode: 1, stderrTail: 'connect ECONNREFUSED 127.0.0.1:11434' })),
      by: 'regex',
      rule: 'generic.regex.loopback-refused',
    },
    {
      name: 'local preset: connection failed',
      column: 'X',
      ...syn(
        local({
          structured: [
            codexError(
              { httpConnectionFailed: { httpStatusCode: null } },
              'error sending request for url (http://127.0.0.1:11434/v1/responses)',
              false,
            ),
          ],
        }),
      ),
      by: 'structured',
      rule: 'codex.error.httpConnectionFailed',
    },
    {
      name: 'local preset: /responses 404',
      column: 'X',
      ...syn(
        local({
          exitCode: 1,
          structured: [
            execTurnFailed(
              'unexpected status 404 Not Found: 404 page not found, url: http://127.0.0.1:11434/v1/responses',
            ),
          ],
        }),
      ),
      by: 'regex',
      rule: 'codex.regex.local-responses-404',
    },
    {
      name: 'local preset: model missing',
      column: 'X',
      ...syn(
        local({
          exitCode: 1,
          structured: [execTurnFailed('model "qwen3:32b" not found, try pulling it first')],
        }),
      ),
      by: 'regex',
      rule: 'codex.regex.local-model',
    },
    {
      name: 'local server lacks the model (model list)',
      column: 'app',
      ...syn(local({ appDetected: { check: 'local-model' } })),
      by: 'app',
      rule: 'app.check.local-model',
    },
  ],
  verify_failed: [
    {
      name: 'verify exit 1',
      column: 'app',
      ...syn(
        app('verify', {
          appDetected: { check: 'verify', detail: '`pnpm test` failed (exit 1, 4s)' },
          exitCode: 1,
          stderrTail: ['FAIL src/a.test.ts > adds', 'AssertionError: expected 2 to be 3'],
        }),
      ),
      by: 'app',
      rule: 'app.check.verify',
      message: '`pnpm test` failed (exit 1, 4s)',
    },
  ],
  verify_untrusted: [
    {
      name: 'command hash not granted',
      column: 'app',
      ...syn(app('verify', { appDetected: { check: 'verify-untrusted' } })),
      by: 'app',
      rule: 'app.check.verify-untrusted',
    },
  ],
  timeout_stall: [
    {
      name: 'C10b frames + stall timer',
      column: 'app',
      ...rec('C10b-taskkill-tree', { appInitiated: { kind: 'stall' } }),
      by: 'app',
      rule: 'app.stall',
    },
  ],
  timeout_hard: [
    {
      name: 'C10b frames + hard timer kill',
      column: 'app',
      ...rec('C10b-taskkill-tree', { appInitiated: { kind: 'hard' } }),
      by: 'app',
      rule: 'app.hard',
    },
  ],
  ask_timeout: [
    {
      name: 'C04d frames (deny + interrupt) + ask timer',
      column: 'app',
      ...rec('C04d-ask-cancel', { appInitiated: { kind: 'ask' } }),
      by: 'app',
      rule: 'app.ask',
    },
  ],
  permission_denied: [
    {
      name: 'C04d frames + deny under denyPauses',
      column: 'app',
      ...rec('C04d-ask-cancel', { appInitiated: { kind: 'deny' } }),
      by: 'app',
      rule: 'app.deny',
    },
    {
      name: 'app-server tooManyDenials',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('tooManyDenials', 'Too many denied requests')] })),
      by: 'structured',
      rule: 'codex.error.tooManyDenials',
    },
  ],
  turn_limit: [
    {
      name: 'C12a error_max_turns',
      column: 'C',
      ...rec('C12a-max-turns'),
      by: 'structured',
      rule: 'claude.result.error_max_turns',
      message: 'Reached maximum number of turns (1)',
    },
    {
      name: 'C12b error_max_budget_usd',
      column: 'C',
      ...rec('C12b-max-budget'),
      by: 'structured',
      rule: 'claude.result.error_max_budget_usd',
    },
    {
      name: 'Gemini exit 53',
      column: 'G',
      ...syn(gemini({ exitCode: 53 })),
      by: 'exit',
      rule: 'gemini.exit.53',
    },
    {
      name: 'ACP stopReason max_turn_requests',
      column: 'G',
      ...syn(gemini({ structured: [acpStop('max_turn_requests')] })),
      by: 'structured',
      rule: 'acp.stop.max_turn_requests',
    },
  ],
  runaway_loop: [
    {
      name: 'C10b frames + loop stop',
      column: 'app',
      ...rec('C10b-taskkill-tree', { appInitiated: { kind: 'loop' } }),
      by: 'app',
      rule: 'app.loop',
      message: 'The AI kept repeating the same step, so Dim Factory stopped it.',
    },
  ],
  context_exceeded: [
    {
      name: 'app-server contextWindowExceeded',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('contextWindowExceeded', 'Context window exceeded')] })),
      by: 'structured',
      rule: 'codex.error.contextWindowExceeded',
    },
    {
      name: 'prompt is too long',
      column: 'C',
      ...syn(exit1({ structured: [errorText('Prompt is too long')] })),
      by: 'regex',
      rule: 'claude.regex.prompt-too-long',
    },
    {
      name: 'Gemini exceeds the maximum number of tokens',
      column: 'G',
      ...syn(
        gemini({
          exitCode: 1,
          stderrTail:
            '[API Error: The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).]',
        }),
      ),
      by: 'regex',
      rule: 'gemini.regex.context',
    },
  ],
  content_policy: [
    {
      name: 'app-server cyberPolicy',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('cyberPolicy', 'This request was flagged')] })),
      by: 'structured',
      rule: 'codex.error.cyberPolicy',
    },
    {
      name: 'app-server misalignmentPolicyViolation',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('misalignmentPolicyViolation', 'Policy violation')] })),
      by: 'structured',
      rule: 'codex.error.misalignmentPolicyViolation',
    },
    {
      name: 'model_refusal_no_fallback',
      column: 'C',
      ...syn(exit1({ structured: [refusal(), errorText('Request refused')] })),
      by: 'structured',
      rule: 'claude.system.model_refusal_no_fallback',
    },
    {
      name: 'ACP stopReason refusal',
      column: 'G',
      ...syn(gemini({ structured: [acpStop('refusal')] })),
      by: 'structured',
      rule: 'acp.stop.refusal',
    },
  ],
  vendor_internal: [
    {
      name: 'Repeated 529 Overloaded',
      column: 'C',
      ...syn(exit1({ structured: [errorText('API Error: Repeated 529 Overloaded errors')] })),
      by: 'regex',
      rule: 'claude.regex.overloaded',
    },
    {
      name: 'assistant server_error',
      column: 'C',
      ...syn(exit1({ structured: [assistantError('server_error')] })),
      by: 'structured',
      rule: 'claude.assistant.error.server_error',
    },
    {
      name: 'app-server serverOverloaded',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('serverOverloaded', 'Server overloaded')] })),
      by: 'structured',
      rule: 'codex.error.serverOverloaded',
    },
    {
      name: 'app-server internalServerError',
      column: 'X',
      ...syn(codex({ structured: [codexTurnFailed('internalServerError', 'Internal server error')] })),
      by: 'structured',
      rule: 'codex.error.internalServerError',
    },
    {
      name: 'app-server responseTooManyFailedAttempts',
      column: 'X',
      ...syn(
        codex({
          structured: [
            codexTurnFailed(
              { responseTooManyFailedAttempts: { httpStatusCode: 500 } },
              'exceeded retry limit, last status: 500 Internal Server Error',
            ),
          ],
        }),
      ),
      by: 'structured',
      rule: 'codex.error.responseTooManyFailedAttempts',
    },
  ],
  process_crash: [
    {
      name: 'C10b: tree killed from outside, nothing to read',
      column: 'C',
      ...rec('C10b-taskkill-tree'),
      by: 'exit',
      rule: 'exit.silent-nonzero',
    },
    {
      name: 'Windows 0xC0000005',
      column: '*',
      ...syn(claude({ exitCode: 3221225477, stderrTail: 'boom' })),
      by: 'exit',
      rule: 'generic.exit.windows-crash',
    },
    {
      name: 'Windows 0xC0000409',
      column: '*',
      ...syn(codex({ exitCode: 3221226505 })),
      by: 'exit',
      rule: 'generic.exit.windows-crash',
    },
    {
      name: 'SIGSEGV',
      column: '*',
      ...syn(gemini({ exitCode: null, signal: 'SIGSEGV' })),
      by: 'exit',
      rule: 'generic.exit.crash-signal',
    },
  ],
  disk_full: [
    {
      name: 'errno ENOSPC',
      column: '*',
      ...syn(claude({ errno: 'ENOSPC' })),
      by: 'errno',
      rule: 'errno.ENOSPC',
    },
    {
      name: 'No space left on device',
      column: '*',
      ...syn(exit1({ stderrTail: 'Error: ENOSPC: no space left on device, write' })),
      by: 'regex',
      rule: 'generic.regex.disk-full',
    },
    {
      name: 'Gemini exit 54 (NO_SPACE_LEFT)',
      column: 'G',
      ...syn(gemini({ exitCode: 54 })),
      by: 'exit',
      rule: 'gemini.exit.54',
    },
    {
      name: 'snapshot: ENOSPC beats snapshot_failed',
      column: 'app',
      ...syn(app('git', { appDetected: { check: 'snapshot' }, errno: 'ENOSPC' })),
      by: 'errno',
      rule: 'app.snapshot.disk-full',
    },
    {
      name: 'snapshot: "No space left" text beats snapshot_failed',
      column: 'app',
      ...syn(
        app('git', {
          appDetected: { check: 'snapshot' },
          exitCode: 128,
          stderrTail: 'fatal: unable to write sha1 file: No space left on device',
        }),
      ),
      by: 'regex',
      rule: 'app.snapshot.disk-full',
    },
  ],
  user_cancelled: [
    {
      name: 'C10a frames + user Stop',
      column: 'app',
      ...rec('C10a-interrupt-then-close', { appInitiated: { kind: 'stop' } }),
      by: 'app',
      rule: 'app.stop',
    },
  ],
  unknown: [
    {
      name: 'C08e rejected flag combination (no specific rule)',
      column: 'C',
      ...rec('C08e-session-id-with-resume'),
      by: 'heuristic',
      rule: 'unknown',
    },
    {
      name: 'C04d interrupt without a Dim Factory reason',
      column: 'C',
      ...rec('C04d-ask-cancel'),
      by: 'heuristic',
      rule: 'unknown',
    },
    {
      name: 'app-server error the table does not know',
      column: 'X',
      ...syn(codex({ exitCode: 1, structured: [codexTurnFailed('other', 'The frobnicator jammed')] })),
      by: 'heuristic',
      rule: 'unknown',
    },
    {
      name: 'failed with no evidence at all',
      column: '*',
      ...syn(claude({ failed: true })),
      by: 'heuristic',
      rule: 'unknown',
    },
  ],
}

describe('failure categories: one test per category', () => {
  it.each([...FAILURE_CATEGORIES])('%s', (category) => {
    const cases = C1[category]
    expect(cases.length, category).toBeGreaterThan(0)
    for (const c of cases) {
      const label = `${category} / ${c.column} / ${c.source}: ${c.name}`
      const r = classifyDetailed(c.input)
      expect(r, label).not.toBeNull()
      expect(r!.failure.category, label).toBe(category)
      expect(r!.failure.classifiedBy, label).toBe(c.by)
      expect(r!.rule, label).toBe(c.rule)
      expect(r!.failure.message.trim(), label).not.toBe('')
      expect(r!.failure.message, label).not.toContain('\u2014')
      expect(r!.hints, label).toEqual(c.hints ?? [])
      if (c.message !== undefined) expect(r!.failure.message, label).toBe(c.message)
      if (c.retryAfterMs !== undefined) {
        expect(r!.failure.retryAfterMs, label).toBe(c.retryAfterMs)
        expect(r!.failure.resetsAt, label).toBe(NOW + c.retryAfterMs)
      }
    }
  })
})

describe('failure categories: coverage of the detection columns', () => {
  it('every detection column of every category has a case', () => {
    const missing: string[] = []
    for (const category of FAILURE_CATEGORIES) {
      for (const col of COLUMNS[category])
        if (!C1[category].some((c) => c.column === col)) missing.push(`${category}/${col}`)
    }
    expect(missing).toEqual([])
  })

  it('cases are tagged with their vendor: C = claude, X = codex or local-*, G = gemini', () => {
    for (const category of FAILURE_CATEGORIES) {
      for (const c of C1[category]) {
        const v = c.input.vendor
        if (c.column === 'C') expect(v, c.name).toBe('claude')
        if (c.column === 'X') expect(v === 'codex' || v.startsWith('local-'), c.name).toBe(true)
        if (c.column === 'G') expect(v, c.name).toBe('gemini')
      }
    }
  })

  it('recorded cases read real Claude fixtures; Codex and Gemini cases are synthesized', () => {
    const recordedCases = FAILURE_CATEGORIES.flatMap((k) => C1[k].filter((c) => c.source === 'recorded'))
    expect(recordedCases.length).toBeGreaterThanOrEqual(12)
    for (const c of recordedCases) {
      expect(c.fixture, c.name).toBeDefined()
      expect(existsSync(`${STDIO}${c.fixture}/recording.jsonl`), c.name).toBe(true)
      expect(c.input.vendor).toBe('claude')
      // Every recording ends with the process exit.
      expect(c.input.exitCode, c.name).not.toBeUndefined()
    }
    for (const k of FAILURE_CATEGORIES)
      for (const c of C1[k])
        if (c.column === 'X' || c.column === 'G') expect(c.source, c.name).toBe('synthesized')
  })

  it('a recorded fixture with a specific detection rule is used for that category', () => {
    const used = new Set(FAILURE_CATEGORIES.flatMap((k) => C1[k].map((c) => c.fixture).filter(Boolean)))
    for (const id of [
      'C08c-resume-bogus',
      'C08d-resume-bogus-startup-results',
      'C08e-session-id-with-resume',
      'C09b-logged-out',
      'C09c-invalid-api-key',
      'C10a-interrupt-then-close',
      'C10b-taskkill-tree',
      'C11a-unknown-flag',
      'C11b-invalid-model',
      'C12a-max-turns',
      'C12b-max-budget',
    ])
      expect(used.has(id), id).toBe(true)
  })
})

describe('failure categories: recorded failures without Dim Factory context', () => {
  it('C09a (startup failure results on) classifies like C09b', () => {
    const a = classifyDetailed(recorded('C09a-logged-out-startup-results'))!
    const b = classifyDetailed(recorded('C09b-logged-out'))!
    expect(a.failure.category).toBe('auth_required')
    expect(a.rule).toBe(b.rule)
  })

  it('C10a without a Stop is not user_cancelled (only Dim Factory knows who interrupted)', () => {
    expect(classifyDetailed(recorded('C10a-interrupt-then-close'))!.failure.category).toBe('unknown')
  })

  it.each(['C01-plain-text', 'C04b-ask-deny', 'C08a-session-id-implement', 'C14c-shell-bash-missing'])(
    '%s is not a failure',
    (id) => {
      expect(classifyDetailed(recorded(id))).toBeNull()
    },
  )

  it('C09c raw is the deciding frame, capped', () => {
    const f = classifyDetailed(recorded('C09c-invalid-api-key'))!.failure
    expect(f.raw.length).toBeLessThanOrEqual(4000)
    expect(f.raw.startsWith('{"type":"assistant"')).toBe(true)
    // Live re-record: 2.1.289 now answers an invalid key at once, in these words (2026-10-05: after ten retries).
    expect(f.message).toBe('Invalid API key · Fix external API key')
  })
})

describe('failure categories: messages', () => {
  it('every case carries a readable message (no em dash, at most 300 chars)', () => {
    for (const k of FAILURE_CATEGORIES) {
      for (const c of C1[k]) {
        const f = classifyDetailed(c.input)!.failure
        expect(f.message.length, c.name).toBeLessThanOrEqual(300)
        expect(f.message, c.name).not.toMatch(/\u2014/)
      }
    }
  })

  it('a Codex app-server failure with no codexErrorInfo falls to the regex stage', () => {
    const r = classifyDetailed(codex({ exitCode: 1, structured: [codexTurnFailed(null, 'Not logged in')] }))!
    expect(r.rule).toBe('codex.regex.not-logged-in')
  })

  it('a Gemini stream-json error result is read as text', () => {
    const frame = { type: 'result', status: 'error', error: { type: 'Error', message: GEMINI_AUTH_TEXT } }
    const r = classifyDetailed(gemini({ exitCode: 1, structured: [frame] }))!
    expect(r.rule).toBe('gemini.regex.auth-method')
  })

  it('an ACP JSON-RPC error response in the frames classifies like rpcError', () => {
    const r = classifyDetailed(gemini({ structured: [acpErrorResponse(-32000, 'Authentication required')] }))!
    expect(r.rule).toBe('acp.rpc.auth-required')
    expect(r.failure.classifiedBy).toBe('structured')
  })
})
