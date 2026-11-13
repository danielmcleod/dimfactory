// Normalized adapter events (the only stream the UI renders) and engine-internal adapter signals.
import type { GuardrailFinding } from './guardrails.ts'
import type { ContextBreakdown, ContextSource } from './context.ts'
import type { FailureCategory } from './failure.ts'

export const ASK_DECISIONS = ['allow', 'allow-session', 'deny', 'cancel'] as const
/** `cancel` = supervisor timeout/stop: deny plus interrupt. */
export type AskDecision = (typeof ASK_DECISIONS)[number]

export const ASK_KINDS = ['edit', 'shell', 'network', 'other'] as const
export type AskKind = (typeof ASK_KINDS)[number]

export type ToolPhase = 'start' | 'end'
export type ToolStatus = 'ok' | 'failed' | 'declined'

/** Token usage. On `done` it is THIS pass's delta; adapters compute it, the engine never subtracts. */
export type Usage = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  costUsd?: number
}

export const NORMALIZED_EVENT_TYPES = ['session', 'text', 'tool', 'ask', 'done', 'error'] as const

export type NormalizedEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; delta: string }
  | {
      type: 'tool'
      id?: string
      name: string
      summary: string
      phase?: ToolPhase
      status?: ToolStatus
      /**
       * On a start: a fingerprint of the call (a short hash of its name and canonical input, made in the adapter), so
       * a repeated call can be told without keeping its input. Never the input itself.
       */
      fp?: string
      /** On an end: the estimated tokens of the tool's output (bytes / 3.5), when the vendor shows it. */
      outTokens?: number
    }
  | {
      type: 'ask'
      requestId: string
      kind: AskKind
      detail: string
      reason?: string
      expiresAt: number
      allowSession: boolean
      defaultToNo?: boolean
    }
  | { type: 'done'; result: string; usage?: Usage }
  | {
      type: 'error'
      message: string
      raw: string
      fatal: boolean
      category?: FailureCategory
      /**
       * `heuristic` when the classifier's heuristic stage named a known category (P17 heals such a failure; an
       * `unknown` one always comes from it); absent otherwise. `resetsAt` / `retryAfterMs`: a rate or usage limit's
       * reset (wait_until, P16's retry-after rule).
       */
      classifiedBy?: 'heuristic'
      resetsAt?: number
      retryAfterMs?: number
    }

export type NormalizedEventType = NormalizedEvent['type']
export type NormalizedEventOf<T extends NormalizedEventType> = Extract<NormalizedEvent, { type: T }>

export interface AllowRuleMatch {
  argv?: string[]
  argvPrefix?: string[]
  pathGlob?: string
  host?: string
}

/**
 * A per-run "Allow for this run" grant. Matching: same tool + kind; `argvPrefix`/`pathGlob`/`host` only when
 * the vendor's own suggestion supplied that scope, else exact argv/path. Dim Factory never generalizes beyond
 * the vendor suggestion. Claude passes `nativeRules` to `--allowedTools`; other adapters match in allow-cache.
 */
export interface AllowRule {
  vendor: string
  kind: AskKind
  tool: string
  match: AllowRuleMatch
  nativeRules?: string[]
  /**
   * `project-permission`: made for one ask by Easy mode's project permission (allow-cache.ts AllowSource); never kept
   * in the run's rules, so a revoked permission covers nothing more.
   */
  source: 'vendor-suggestion' | 'exact' | 'project-permission'
}

export const PLAN_CAPTURE_SOURCES = [
  'exitPlanMode',
  'proposed_plan',
  'acp-exit-plan',
  'final-message',
] as const
export type PlanCaptureSource = (typeof PLAN_CAPTURE_SOURCES)[number]

export const AUTO_ANSWER_REASONS = [
  'readonly',
  'allow-cache',
  'plan-capture',
  'unsupported',
  'project-permission',
  /** A guardrail declined a request the AI tool relayed, before the user was asked. */
  'guardrail',
] as const
export type AutoAnswerReason = (typeof AUTO_ANSWER_REASONS)[number]

export const ADAPTER_SIGNAL_TYPES = [
  'liveness',
  'ask-withdrawn',
  'allow-rule',
  'plan-captured',
  'auto-answered',
  'meta',
  'waiting',
  'context',
  'compaction',
  'context-breakdown',
  'subagent-tokens',
  'shell-command',
  'guardrail-blocked',
] as const

/** Engine-internal; never rendered directly. */
export type AdapterSignal =
  | { type: 'liveness' }
  | { type: 'ask-withdrawn'; requestId: string }
  | { type: 'allow-rule'; rule: AllowRule }
  | { type: 'plan-captured'; markdown: string; source: PlanCaptureSource }
  | { type: 'auto-answered'; requestId: string; decision: AskDecision; tool: string; why: AutoAnswerReason }
  | { type: 'meta'; key: string; value: unknown }
  /** A shell command the pass started, in full (a tool row's summary is clipped to one line for display). */
  | { type: 'shell-command'; command: string }
  /** A guardrail refused a tool before it ran, and the model was told why. */
  | { type: 'guardrail-blocked'; finding: GuardrailFinding }
  /** The CLI answered but background work it started (shells, sub-agents) still runs; the pass waits for it. */
  | { type: 'waiting'; tasks: string[] }
  /**
   * How full the context is: `used` tokens (see ContextSource), the window when the vendor says it, and the cached part
   * of `used` when known.
   */
  | { type: 'context'; used: number; window?: number; cacheRead?: number; source: ContextSource }
  /**
   * The vendor summarised (compacted) the session's context: `start` when it begins, `end` when it is over (`failed`
   * when the vendor says it did not work). `preTokens` / `postTokens`: the context before and after, when reported.
   */
  | {
      type: 'compaction'
      phase: 'start' | 'end'
      trigger?: 'manual' | 'auto'
      preTokens?: number
      postTokens?: number
      failed?: true
    }
  /** Claude's context breakdown (get_context_usage, summary detail), at the pass's start or end. */
  | { type: 'context-breakdown'; at: 'start' | 'end'; breakdown: ContextBreakdown }
  /** A subagent's tokens so far (`id`: the tool row that started it). */
  | { type: 'subagent-tokens'; id: string; tokens: number }

export type AdapterSignalType = AdapterSignal['type']
