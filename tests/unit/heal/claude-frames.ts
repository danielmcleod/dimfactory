// Synthesized Claude stream-json frames for classifier tests. Field names are checked against the Agent SDK's
// types (@anthropic-ai/claude-agent-sdk, the pinned devDependency) so drift fails typecheck; recorded fixtures replace
// these in phase 2 (see classify.fixtures.test.ts).
import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKAuthStatusMessage,
  SDKModelRefusalNoFallbackMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKResultError,
  SDKResultSuccess,
  SDKStartupFailureReason,
  TerminalReason,
} from '@anthropic-ai/claude-agent-sdk'

const SESSION = '3f0c8a1e-0000-4000-8000-000000000001'

type ErrorResultFrame = Pick<SDKResultError, 'type' | 'subtype' | 'is_error' | 'errors' | 'session_id'> & {
  startup_failure_reason?: SDKStartupFailureReason
  terminal_reason?: TerminalReason
}

export function errorResult(
  subtype: SDKResultError['subtype'],
  errors: string[] = [],
  extra: { startup_failure_reason?: SDKStartupFailureReason; terminal_reason?: TerminalReason } = {},
): ErrorResultFrame {
  return { type: 'result', subtype, is_error: true, errors, session_id: SESSION, ...extra }
}

export const startupFailure = (reason: SDKStartupFailureReason, text = `startup failed: ${reason}`) =>
  errorResult('error_during_execution', [text], { startup_failure_reason: reason })

type SuccessResultFrame = Pick<
  SDKResultSuccess,
  'type' | 'subtype' | 'is_error' | 'result' | 'session_id'
> & {
  api_error_status?: number | null
  terminal_reason?: TerminalReason
}

/** `subtype:'success'` with `is_error:true`: how in-run failures (auth, limits) surface in -p. */
export function errorText(
  text: string,
  extra: { api_error_status?: number | null; terminal_reason?: TerminalReason } = {},
): SuccessResultFrame {
  return { type: 'result', subtype: 'success', is_error: true, result: text, session_id: SESSION, ...extra }
}

export function okResult(text = 'done'): SuccessResultFrame {
  return { type: 'result', subtype: 'success', is_error: false, result: text, session_id: SESSION }
}

type AssistantErrorFrame = Pick<SDKAssistantMessage, 'type' | 'parent_tool_use_id' | 'session_id'> & {
  error: SDKAssistantMessageError
  message: { role: 'assistant'; content: { type: 'text'; text: string }[] }
}

export function assistantError(
  error: SDKAssistantMessageError,
  text = '',
  parent: string | null = null,
): AssistantErrorFrame {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    session_id: SESSION,
    error,
    message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [] },
  }
}

type ApiRetryFrame = Pick<
  SDKAPIRetryMessage,
  'type' | 'subtype' | 'attempt' | 'max_retries' | 'retry_delay_ms' | 'error_status' | 'error' | 'session_id'
>

export function apiRetry(
  error: SDKAssistantMessageError,
  errorStatus: number | null,
  attempt = 1,
): ApiRetryFrame {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: 10,
    retry_delay_ms: 2000,
    error_status: errorStatus,
    error,
    session_id: SESSION,
  }
}

type RateLimitFrame = Pick<SDKRateLimitEvent, 'type' | 'session_id'> & { rate_limit_info: SDKRateLimitInfo }

export function rateLimit(info: SDKRateLimitInfo): RateLimitFrame {
  return { type: 'rate_limit_event', session_id: SESSION, rate_limit_info: info }
}

type RefusalFrame = Pick<
  SDKModelRefusalNoFallbackMessage,
  'type' | 'subtype' | 'original_model' | 'request_id' | 'content' | 'session_id'
>

export function refusal(content = 'Claude declined to continue with this request.'): RefusalFrame {
  return {
    type: 'system',
    subtype: 'model_refusal_no_fallback',
    original_model: 'claude-sonnet-5',
    request_id: null,
    content,
    session_id: SESSION,
  }
}

type AuthStatusFrame = Pick<
  SDKAuthStatusMessage,
  'type' | 'isAuthenticating' | 'output' | 'error' | 'session_id'
>

export function authStatusError(error: string): AuthStatusFrame {
  return { type: 'auth_status', isAuthenticating: false, output: [], error, session_id: SESSION }
}

export const initFrame = { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-5' }
export const keepAlive = { type: 'keep_alive' }
