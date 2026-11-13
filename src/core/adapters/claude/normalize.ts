// Raw Claude stream-json lines → the six normalized events + adapter signals. No I/O: the run handle (run.ts),
// `dimf normalize` and the fixture tests all drive the
// same state machine. Frames the CLI must receive (automatic answers, error replies) come back in `stdin`.
import type { GuardrailFinding, ToolPolicy } from '../../../shared/guardrails.ts'
import { refuseCommand, refuseEdit, refuseRead, refuseSearch, refuseWeb } from '../../../shared/guardrails.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AdapterSignal,
  AllowRule,
  AskDecision,
  AutoAnswerReason,
  NormalizedEvent,
  Usage,
} from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import type { ClassifyInput, AppKill } from '../../heal/classify.ts'
import { classify, redactRaw } from '../../heal/classify.ts'
import { getEnv } from '../../proc/env.ts'
import { AllowCache } from '../allow-cache.ts'
import type { AllowSource } from '../allow-cache.ts'
import { FAILURE_HINTS_META, TailBuffer, classifyFailureDetailed, errorEvent } from '../errors.ts'
import {
  META_LATE_ALLOW_RULE,
  META_SESSION_MODEL,
  META_STRUCTURED_OUTPUT,
  META_USAGE,
  META_USAGE_APPROX,
} from '../types.ts'
import type { AskCancelReason } from '../types.ts'
import type { UsageDelta } from '../usage.ts'
import { UsageTracker, addUsage, sumClaudeModelUsage } from '../usage.ts'
import { outputTokens, toolFingerprint } from '../fingerprint.ts'
import { allowRuleFor, autoAnswerFor, askEvent, capturePlan, summarizeTool } from './asks.ts'
import { parseContextUsage } from './context-usage.ts'
import {
  AUTH_RETRY_FAIL_FAST_ATTEMPT,
  CLAUDE_VENDOR,
  DENY_MESSAGE,
  EMPTY_MODEL_USAGE_IS_UNKNOWN,
  PLAN_CAPTURE_IS_SUCCESS,
  PLAN_CAPTURED_MESSAGE,
  PLAN_EMPTY_MESSAGE,
  READONLY_DENY_MESSAGE,
  UNSUPPORTED_ASK_MESSAGE,
} from './capabilities.ts'
import type { PlanCapture } from './plan-hygiene.ts'
import type {
  CanUseToolRequest,
  ControlResponseBody,
  JsonObject,
  ResultFrame,
  ResultUsage,
  StdinFrame,
} from './protocol.ts'
import {
  allowResponse,
  asCanUseTool,
  denyResponse,
  errorResponse,
  num,
  obj,
  parseFrame,
  sessionPermissions,
  str,
  hookResponse,
  preToolDeny,
} from './protocol.ts'

/** plan = native plan + host; readonly = read-only route (no host); edit = implement / fix (host). */
export type ClaudeRoute = 'plan' | 'readonly' | 'edit'

export interface NormalizerOptions {
  route: ClaudeRoute
  /** The process continues an existing session (`--resume`). */
  resumed?: boolean
  /** The session's cumulative totals before this pass; usage is reported as a delta against them. */
  priorUsage?: Usage | undefined
  askTimeoutMs: number
  now?: () => number
  allowRules?: readonly AllowRule[]
  /** Easy mode's project permission (StartOptions.permit), asked after the run's rules. */
  permit?: AllowSource | undefined
  cwd?: string
  home?: string
  /** `${CLAUDE_CONFIG_DIR ?? ~/.claude}`; ExitPlanMode's planFilePath must lie under its `plans/`. */
  configDir?: string
  readPlanFile?: (path: string) => string | undefined
  /**
   * ANTHROPIC_API_KEY is set in the environment the CLI runs with (the adapter learns it from its own spawn
   * env, {@link ClaudeNormalizer.noteSpawnEnv}; a replay from the recording header's `envKeys`). Only then, or with
   * init's apiKeySource naming it, does an auth failure name the variable.
   */
  apiKeyEnv?: boolean
  /** The MCP servers the pass allowed (Allowed list): one that init reports as not connected gets a warning. */
  allowedMcp?: readonly string[]
  /**
   * The callback id of Dim Factory's own SessionStart hook (the post-compaction reminder), when the pass registered
   * one: its hook_callback goes to the adapter (NormalizeStep.hook). Every other hook callback stays unsupported.
   */
  reminderHookId?: string
  /** Guardrails to hold through Dim Factory's own PreToolUse hook (`GUARDRAIL_HOOK_ID`). */
  guardrails?: ToolPolicy
  /** The private files in the folder, folder-relative (core/guardrails/private-files.ts): what a search would reach. */
  privateFiles?: () => readonly string[]
}

export interface ControlReply {
  requestId: string
  ok: boolean
  response?: JsonObject
  error?: string
}

/** Consumers emit `signals` before `events` (a plan-captured signal precedes the `done` it explains). */
export interface NormalizeStep {
  events: NormalizedEvent[]
  signals: AdapterSignal[]
  /** Frames to write to the CLI, in order. */
  stdin: StdinFrame[]
  /** A reply to one of Dim Factory's own control requests (initialize, interrupt). */
  reply?: ControlReply
  /** The first `result` arrived in this step. */
  result?: boolean
  /** ExitPlanMode was captured in this step (arm the 10 s result timer). */
  planCaptured?: boolean
  /** The pass already failed; the adapter should stop the process (e.g. an invalid API key being retried). */
  abort?: boolean
  /** The background work a held answer waits on just finished (the CLI should start its follow-up turn). */
  drained?: boolean
  /** Dim Factory's own SessionStart hook fired (source: why the session started; 'compact' after a compaction). */
  hook?: { requestId: string; source: string | undefined }
}

export interface EndInput {
  code: number | null
  signal: string | null
  ranMs?: number
  stderrTail?: readonly string[]
}

interface PendingAsk {
  req: CanUseToolRequest
}

interface ToolInfo {
  name: string
  summary: string
  ended: boolean
  /** The tool's own summary (a subagent's progress is added after it). */
  base?: string
  /** The subagent type a task frame named (later progress frames may leave it out). */
  agentType?: string
}

/** MCP statuses at init that mean an allowed server will not be there for the pass. */
const MCP_NOT_CONNECTED = new Set(['failed', 'needs-auth', 'disabled'])

/** `18.7k tokens`, `950 tokens`. */
function tokensText(n: number): string {
  return n >= 1000 ? `${(Math.round(n / 100) / 10).toString()}k tokens` : `${String(n)} tokens`
}

const STATUS_FRAMES_MAX = 60
const STDOUT_TAIL_MAX = 20

/** Recovery hint (auth_required): offer `shell_copy` unset ANTHROPIC_API_KEY. */
export const ENV_KEY_HINT = 'claude-env-key'

/** C09c: an auth failure while ANTHROPIC_API_KEY is in play, in Dim Factory's words (`status`: the HTTP status). */
export function envKeyMessage(status: number | undefined): string {
  const tag = status !== undefined ? ` (${status})` : ''
  return `API key is invalid${tag}. ANTHROPIC_API_KEY is set and takes precedence over your Claude login.`
}

/**
 * An auth failure where the CLI only said that "ANTHROPIC_API_KEY or another auth source is set and takes
 * precedence" (its stderr), while neither init's apiKeySource nor the spawn env shows ANTHROPIC_API_KEY: an
 * apiKeyHelper or an auth token may be the credential, so the variable is named only as the CLI names it.
 */
export function otherCredentialMessage(status: number | undefined): string {
  const tag = status !== undefined ? ` (${status})` : ''
  return `API key is invalid${tag}. A key or other credential set for Claude Code (ANTHROPIC_API_KEY or another auth source) takes precedence over your Claude login.`
}

/** Meta signal: the pass's usage is an estimate (`value`: {reason, fields?, costUnknown?}). */
export const USAGE_APPROX_META = META_USAGE_APPROX
const ENV_KEY_RE = /ANTHROPIC_API_KEY/

const emptyStep = (): NormalizeStep => ({ events: [], signals: [], stdin: [] })

/**
 * What a Dim Factory-ended turn's `raw` keeps of the result frame: status fields and which tools were denied. Never
 * the final text, tool inputs (file bodies, commands) or ids (C04d).
 */
function resultSummary(r: ResultFrame): string {
  const out: Record<string, unknown> = { type: 'result', subtype: r.subtype }
  for (const k of ['is_error', 'terminal_reason', 'stop_reason', 'api_error_status', 'num_turns'] as const) {
    if (r[k] !== undefined && r[k] !== null) out[k] = r[k]
  }
  if (Array.isArray(r.errors)) out['errors'] = r.errors.filter((e) => typeof e === 'string').slice(0, 5)
  const denied = (r.permission_denials ?? []).flatMap((d) =>
    typeof d?.tool_name === 'string' ? [d.tool_name] : [],
  )
  if (denied.length > 0) out['permission_denials'] = denied
  return JSON.stringify(out)
}

/** `result.usage` as Usage, or undefined when it carries no token counts. */
function turnUsage(u: ResultUsage | undefined): Usage | undefined {
  if (u === undefined || u === null || typeof u !== 'object') return undefined
  const input = num(u.input_tokens)
  const output = num(u.output_tokens)
  if (input === undefined && output === undefined) return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheWrite: num(u.cache_creation_input_tokens) ?? 0,
  }
}

const isMain = (f: JsonObject): boolean =>
  f['parent_tool_use_id'] === null || f['parent_tool_use_id'] === undefined

/** Frames kept for the classifier: everything except content (stream deltas, assistant/user messages). */
function isStatusFrame(f: JsonObject): boolean {
  const t = f['type']
  if (t === 'stream_event' || t === 'user' || t === 'control_request' || t === 'control_response')
    return false
  if (t === 'assistant') return typeof f['error'] === 'string'
  if (t === 'system') return f['subtype'] !== 'thinking_tokens' && f['subtype'] !== 'init'
  return true
}

/** The callback id of Dim Factory's own PreToolUse hook. */
export const GUARDRAIL_HOOK_ID = 'guardrails'
const GUARDED_SHELL: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])
const GUARDED_EDIT: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const GUARDED_READ: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'NotebookRead'])
const GUARDED_WEB: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch'])

/**
 * The tools the hook is registered for: shells and edits always, reads only with a private files rule and web tools
 * only with the network rule, so a run without them pays no extra round trip per read.
 */
export function guardrailHookMatcher(policy: ToolPolicy): string {
  const tools = [...GUARDED_SHELL, ...GUARDED_EDIT]
  if (policy.rules.some((r) => r.kind === 'privateFiles')) tools.push(...GUARDED_READ)
  if (policy.rules.some((r) => r.kind === 'network')) tools.push(...GUARDED_WEB)
  return tools.join('|')
}

export class ClaudeNormalizer {
  readonly route: ClaudeRoute
  readonly #o: NormalizerOptions
  readonly #now: () => number
  readonly #cache: AllowCache
  readonly #usage: UsageTracker
  readonly #pending = new Map<string, PendingAsk>()
  readonly #tools = new Map<string, ToolInfo>()
  readonly #declined = new Set<string>()
  readonly #status: unknown[] = []
  readonly #stdoutTail = new TailBuffer(STDOUT_TAIL_MAX, 300)
  readonly #stderrTail = new TailBuffer(40, 2000)
  #sessionId: string | undefined
  #finalMsg = ''
  #terminal = false
  #sawResult = false
  #plan: string | undefined
  #capture: PlanCapture | undefined
  #killedBy: AppKill | undefined
  #malformed = 0
  #maxMalformed = 0
  #reported: Usage | undefined
  #apiKeySource: string | undefined
  #apiKeyEnv: boolean
  /** Background work the CLI reports as still running (background_tasks_changed; ambient tasks left out). */
  #background: { id: string; description: string }[] = []
  /** An answer that arrived while background work still ran: the pass ends with the turn after it finishes. */
  #held: { text: string; usage: Usage | undefined } | undefined
  /** Allowed MCP servers already warned about (init repeats on a follow-up turn). */
  readonly #mcpWarned = new Set<string>()
  /** The main thread's last assistant message id: one API request repeats its usage on each content block. */
  #lastMessageId: string | undefined
  /** The prompt tokens of the main thread's latest request (context signals). */
  #contextUsed: number | undefined
  /** The context window the CLI reported (result modelUsage, or the context breakdown). */
  #contextWindow: number | undefined
  /** The model init named (its modelUsage entry has the main thread's window). */
  #sessionModel: string | undefined
  /** A compaction is under way (status `compacting` seen, no compact_boundary yet). */
  #compacting = false
  /** Dim Factory's own get_context_usage requests awaiting their answer, by request id. */
  readonly #contextRequests = new Map<string, 'start' | 'end'>()
  /** The pass ended with `done` (not an error). */
  #succeeded = false

  constructor(o: NormalizerOptions) {
    this.route = o.route
    this.#o = o
    this.#now = o.now ?? Date.now
    this.#cache = new AllowCache(
      (o.allowRules ?? []).filter((r) => r.vendor === CLAUDE_VENDOR),
      o.cwd !== undefined ? { cwd: o.cwd } : {},
      o.permit,
    )
    this.#usage = new UsageTracker({ base: o.priorUsage, resumed: o.resumed === true })
    this.#apiKeyEnv = o.apiKeyEnv === true
  }

  /** The environment the adapter spawned the CLI with ({@link NormalizerOptions.apiKeyEnv}). */
  noteSpawnEnv(env: Readonly<Record<string, string | undefined>>): void {
    this.#apiKeyEnv = (getEnv(env, 'ANTHROPIC_API_KEY') ?? '').trim() !== ''
  }

  sessionId(): string | undefined {
    return this.#sessionId
  }

  /** The session's cumulative totals as last reported (the prior totals until this process reports). */
  cumulativeUsage(): Usage | undefined {
    return this.#reported ?? this.#o.priorUsage
  }

  pendingAsks(): string[] {
    return [...this.#pending.keys()]
  }

  get terminal(): boolean {
    return this.#terminal
  }

  get sawResult(): boolean {
    return this.#sawResult
  }

  /** The pass ended with its answer (`done`), not an error. */
  get succeeded(): boolean {
    return this.#succeeded
  }

  /**
   * Dim Factory sent a get_context_usage request (context-usage.ts) with this id: its answer becomes a
   * `context-breakdown` signal (`at`: the pass's start or end) and a `context` signal with the window it names.
   */
  expectContextUsage(requestId: string, at: 'start' | 'end'): void {
    this.#contextRequests.set(requestId, at)
  }

  /** The CLI answered but waits on background work (keep stdin open: it starts a new turn when the work ends). */
  get waiting(): boolean {
    return this.#held !== undefined && !this.#terminal
  }

  /** End a held pass with the answer it has (the work finished without a follow-up turn, or the wait ran out). */
  finishHeld(): NormalizeStep {
    const step = emptyStep()
    const h = this.#held
    if (h === undefined || this.#terminal) return step
    this.#held = undefined
    this.#done(h.text, h.usage, step)
    return step
  }

  get planCaptured(): boolean {
    return this.#plan !== undefined
  }

  /** The plan this pass captured (ExitPlanMode or, on a plan route, the final message), for plan-file hygiene. */
  planCapture(): PlanCapture | undefined {
    return this.#capture
  }

  /**
   * Dim Factory ended (or is ending) the turn; the terminal error is classified as this kill. An ask cancel
   * (`ask` / `deny`) never replaces a stop, timer or quit.
   */
  markKilled(kind: AppKill): void {
    const askKill = kind === 'ask' || kind === 'deny'
    if (this.#killedBy === undefined || !askKill) this.#killedBy = kind
  }

  /** End the pass with this failure (e.g. a rejected initialize); no-op once a terminal event exists. */
  fail(failure: Failure, hints: readonly string[] = []): NormalizeStep {
    const step = emptyStep()
    if (!this.#terminal) this.#failWith(step, failure, hints)
    return step
  }

  stderr(line: string): void {
    this.#stderrTail.push(line)
  }

  line(raw: string): NormalizeStep {
    const step = emptyStep()
    const f = parseFrame(raw)
    if (f === undefined) {
      if (raw.trim() !== '') {
        this.#stdoutTail.push(raw)
        this.#malformed++
        this.#maxMalformed = Math.max(this.#maxMalformed, this.#malformed)
      }
      return step
    }
    this.#malformed = 0
    const wasTerminal = this.#terminal
    if (isStatusFrame(f)) {
      this.#status.push(f)
      if (this.#status.length > STATUS_FRAMES_MAX) this.#status.shift()
    }
    switch (f['type']) {
      case 'stream_event':
        this.#streamEvent(f, step)
        break
      case 'assistant':
        this.#assistant(f, step)
        break
      case 'user':
        this.#user(f, step)
        break
      case 'system':
        this.#system(f, step)
        break
      case 'conversation_reset': {
        const id = str(f['new_conversation_id'])
        if (id !== undefined) this.#session(id, step)
        break
      }
      case 'control_request':
        this.#controlRequest(f, step)
        break
      case 'control_cancel_request': {
        const id = str(f['request_id'])
        if (id !== undefined && this.#pending.delete(id))
          step.signals.push({ type: 'ask-withdrawn', requestId: id })
        break
      }
      case 'control_response':
        this.#controlResponse(f, step)
        break
      case 'result':
        this.#result(f as unknown as ResultFrame, step)
        break
      default:
        break
    }
    // After the terminal event nothing else is rendered (the adapter is already stopping the process).
    if (wasTerminal) step.events = []
    if (step.events.length === 0 && step.signals.length === 0) step.signals.push({ type: 'liveness' })
    return step
  }

  /**
   * The user's (or the engine's) answer to an ask raised by this normalizer. `why` says why a `cancel` ends the
   * turn: the ask timer (default, ask_timeout) or a deny under `ask.denyPauses` (permission_denied).
   */
  answer(requestId: string, decision: AskDecision, why?: AskCancelReason): NormalizeStep {
    const step = emptyStep()
    const p = this.#pending.get(requestId)
    if (p === undefined) return step
    this.#pending.delete(requestId)
    const req = p.req
    switch (decision) {
      case 'allow':
        step.stdin.push(allowResponse(requestId, req.input))
        break
      case 'allow-session': {
        const suggestions = req.permission_suggestions ?? []
        step.stdin.push(allowResponse(requestId, req.input, sessionPermissions(suggestions)))
        const rule = allowRuleFor(req, suggestions, this.#pathOpts())
        if (rule !== undefined && this.#cache.add(rule)) step.signals.push({ type: 'allow-rule', rule })
        break
      }
      case 'deny':
        step.stdin.push(denyResponse(requestId, DENY_MESSAGE))
        this.#declined.add(req.tool_use_id)
        break
      case 'cancel': {
        step.stdin.push(denyResponse(requestId, DENY_MESSAGE, true))
        this.#declined.add(req.tool_use_id)
        this.markKilled(why === 'denied' ? 'deny' : 'ask')
        if (why !== 'denied') {
          // P19 "Allow & resume": the exact rule a late Allow adds (no vendor suggestion is widened).
          const rule = allowRuleFor(req, [], this.#pathOpts())
          if (rule !== undefined)
            step.signals.push({ type: 'meta', key: META_LATE_ALLOW_RULE, value: { requestId, rule } })
        }
        break
      }
    }
    return step
  }

  /** Process exit: the terminal event when none was emitted (crash, kill, missing result). */
  end(exit: EndInput): NormalizeStep {
    const step = emptyStep()
    for (const l of exit.stderrTail ?? []) this.#stderrTail.push(l)
    this.#pending.clear()
    if (this.#terminal) return step
    if (this.#plan !== undefined) {
      this.#done(this.#plan, undefined, step)
      return step
    }
    // Stopped or gone while waiting on background work: the answer it gave still stands.
    if (this.#held !== undefined) {
      const h = this.#held
      this.#held = undefined
      this.#done(h.text, h.usage, step)
      return step
    }
    if (this.#killedBy !== undefined) {
      this.#dimFactoryError(step)
      return step
    }
    this.#classified(step, {
      exitCode: exit.code,
      signal: exit.signal,
      ...(exit.ranMs !== undefined ? { ranMs: exit.ranMs } : {}),
      protocol: {
        noTerminal: true,
        ...(this.#maxMalformed > 0 ? { malformedLines: this.#maxMalformed } : {}),
      },
    })
    return step
  }

  // ---- terminal events --------------------------------------------------------------------------------------

  /** Every terminal event goes through here: open tool calls end first (declined or failed), then the event. */
  #emitTerminal(step: NormalizeStep, ev: NormalizedEvent, signals: AdapterSignal[] = []): void {
    for (const [id, t] of [...this.#tools]) {
      if (!t.ended) this.#toolEnd(id, undefined, this.#declined.has(id) ? 'declined' : 'failed', step)
    }
    this.#terminal = true
    step.signals.push(...signals)
    step.events.push(ev)
  }

  #failWith(step: NormalizeStep, failure: Failure, hints: readonly string[]): void {
    const all = [...hints]
    if (failure.category === 'auth_required' && this.#envKeySuspected() && !all.includes(ENV_KEY_HINT))
      all.push(ENV_KEY_HINT)
    const signals: AdapterSignal[] =
      all.length > 0 ? [{ type: 'meta', key: FAILURE_HINTS_META, value: all }] : []
    this.#emitTerminal(step, errorEvent(failure, true), signals)
  }

  /**
   * Classify from the status frames and stream tails, and end the pass with the result. `status`: the result's
   * api_error_status. Live C09c: 2.1.289 now ends an invalid ANTHROPIC_API_KEY at once, without api_retry and in
   * its own words ("Invalid API key · Fix external API key"); an auth failure with a credential in play reads as the
   * api_retry path says it ({@link ClaudeNormalizer.#credentialMessage}).
   */
  #classified(step: NormalizeStep, extra: Partial<ClassifyInput> = {}, status?: number): void {
    const c = classifyFailureDetailed({
      vendor: CLAUDE_VENDOR,
      structured: this.#status,
      stderrTail: this.#stderrTail.lines(),
      stdoutTail: this.#stdoutTail.lines(),
      now: this.#now(),
      ...extra,
    })
    const message = c.failure.category === 'auth_required' ? this.#credentialMessage(status) : undefined
    this.#failWith(step, message !== undefined ? { ...c.failure, message } : c.failure, c.hints)
  }

  /** ANTHROPIC_API_KEY may be in play: init's apiKeySource, the spawn env, or the CLI's stderr (C09c). The hint. */
  #envKeySuspected(): boolean {
    return this.#envKeyKnown() || this.#stderrTail.lines().some((l) => ENV_KEY_RE.test(l))
  }

  /** ANTHROPIC_API_KEY is in play for certain: init's apiKeySource names it, or the spawn env holds it. */
  #envKeyKnown(): boolean {
    return this.#apiKeySource === 'ANTHROPIC_API_KEY' || this.#apiKeyEnv
  }

  /**
   * An auth failure's words when a credential other than the Claude login is in play: the variable by name only when it
   * is known to be set ({@link envKeyMessage}); the CLI's "ANTHROPIC_API_KEY or another auth source" alone names both
   * ({@link otherCredentialMessage}). Undefined when neither is in play.
   */
  #credentialMessage(status: number | undefined): string | undefined {
    if (this.#envKeyKnown()) return envKeyMessage(status)
    if (this.#envKeySuspected()) return otherCredentialMessage(status)
    return undefined
  }

  // ---- frames ---------------------------------------------------------------------------------------------

  #session(id: string, step: NormalizeStep): void {
    if (id === this.#sessionId) return
    this.#sessionId = id
    step.events.push({ type: 'session', id })
  }

  #streamEvent(f: JsonObject, step: NormalizeStep): void {
    if (!isMain(f)) return
    const ev = obj(f['event'])
    if (ev?.['type'] !== 'content_block_delta') return
    const delta = obj(ev['delta'])
    if (delta?.['type'] !== 'text_delta') return
    const text = str(delta['text'])
    if (text === undefined || text === '') return
    this.#finalMsg += text
    step.events.push({ type: 'text', delta: text })
  }

  #assistant(f: JsonObject, step: NormalizeStep): void {
    if (!isMain(f)) return
    const message = obj(f['message'])
    this.#requestContext(message, step)
    const content = message?.['content']
    if (!Array.isArray(content)) return
    for (const b of content) {
      const block = obj(b)
      if (block?.['type'] !== 'tool_use') continue
      const id = str(block['id'])
      const name = str(block['name']) ?? 'tool'
      const input = obj(block['input']) ?? {}
      const summary = summarizeTool(name, input, this.#o.cwd)
      if (id !== undefined) {
        if (this.#tools.has(id)) continue
        this.#tools.set(id, { name, summary, ended: false, base: summary })
      }
      this.#finalMsg = ''
      const shell = name === 'Bash' || name === 'PowerShell' ? str(input['command']) : undefined
      if (shell !== undefined) step.signals.push({ type: 'shell-command', command: shell })
      step.events.push({
        type: 'tool',
        ...(id !== undefined ? { id } : {}),
        name,
        summary,
        phase: 'start',
        fp: toolFingerprint(name, input),
      })
    }
  }

  /**
   * A main-thread request's prompt size (live C23a: the CLI repeats one request's `message.usage` on each content block
   * of the same `message.id`, so only a new id counts): input + cache read + cache write tokens.
   */
  #requestContext(message: JsonObject | undefined, step: NormalizeStep): void {
    const id = str(message?.['id'])
    const u = obj(message?.['usage'])
    if (id === undefined || u === undefined || id === this.#lastMessageId) return
    const input = num(u['input_tokens']) ?? 0
    const cacheRead = num(u['cache_read_input_tokens']) ?? 0
    const used = input + cacheRead + (num(u['cache_creation_input_tokens']) ?? 0)
    // A synthetic message (the CLI's own words, no model call) reports no tokens.
    if (used <= 0) return
    this.#lastMessageId = id
    this.#contextUsed = used
    step.signals.push({
      type: 'context',
      used,
      ...(this.#contextWindow !== undefined ? { window: this.#contextWindow } : {}),
      cacheRead,
      source: 'request',
    })
  }

  #user(f: JsonObject, step: NormalizeStep): void {
    if (!isMain(f)) return
    const content = obj(f['message'])?.['content']
    // Live C18c: a user turn on the main thread that is not a tool result (the CLI's own nudge, such as
    // "[structured-output-enforce] You MUST call the StructuredOutput tool…") starts the final message again: what the
    // model wrote before it is not the answer the result reports.
    if (
      typeof content === 'string' ||
      (Array.isArray(content) && content.some((b) => obj(b)?.['type'] === 'text'))
    )
      this.#finalMsg = ''
    if (!Array.isArray(content)) return
    for (const b of content) {
      const block = obj(b)
      if (block?.['type'] !== 'tool_result') continue
      const id = str(block['tool_use_id'])
      if (id === undefined) continue
      const status = this.#declined.has(id) ? 'declined' : block['is_error'] === true ? 'failed' : 'ok'
      this.#toolEnd(id, undefined, status, step, outputTokens(block['content']))
    }
  }

  #toolEnd(
    id: string,
    fallbackName: string | undefined,
    status: 'ok' | 'failed' | 'declined',
    step: NormalizeStep,
    outTokens?: number,
  ): void {
    const t = this.#tools.get(id)
    if (t?.ended === true) return
    const name = t?.name ?? fallbackName ?? 'tool'
    const summary = t?.summary ?? ''
    this.#tools.set(id, { ...t, name, summary, ended: true })
    this.#finalMsg = ''
    step.events.push({
      type: 'tool',
      id,
      name,
      summary,
      phase: 'end',
      status,
      ...(outTokens !== undefined ? { outTokens } : {}),
    })
  }

  #system(f: JsonObject, step: NormalizeStep): void {
    const sub = str(f['subtype'])
    if (sub === 'init') {
      // The CLI's follow-up turn after background work: its final message is the one that follows.
      if (this.#held !== undefined) this.#finalMsg = ''
      this.#mcpStatus(f, step)
      const id = str(f['session_id'])
      if (id !== undefined) this.#session(id, step)
      this.#apiKeySource = str(f['apiKeySource'])
      this.#sessionModel = str(f['model']) ?? this.#sessionModel
      const meta: [string, unknown][] = [
        [META_SESSION_MODEL, f['model']],
        ['permissionMode', f['permissionMode']],
        ['claude_code_version', f['claude_code_version']],
        ['apiKeySource', f['apiKeySource']],
        ['mcp_server_errors', f['mcp_server_errors']],
      ]
      for (const [key, value] of meta)
        if (value !== undefined) step.signals.push({ type: 'meta', key, value })
      return
    }
    if (sub === 'task_started' || sub === 'task_progress' || sub === 'task_notification') {
      this.#taskProgress(f, step)
      return
    }
    if (sub === 'background_tasks_changed' && Array.isArray(f['tasks'])) {
      // Ambient tasks (housekeeping, live-update watchers) are not work the answer waits on.
      this.#background = f['tasks'].flatMap((t) => {
        const o = obj(t)
        const id = str(o?.['task_id'])
        if (id === undefined || o?.['ambient'] === true) return []
        return [{ id, description: str(o?.['description']) ?? str(o?.['task_type']) ?? 'background task' }]
      })
      if (this.#held !== undefined || this.#background.length > 0)
        step.signals.push({ type: 'waiting', tasks: this.#background.map((t) => t.description) })
      if (this.#held !== undefined && this.#background.length === 0) step.drained = true
      return
    }
    if (sub === 'permission_denied') {
      const id = str(f['tool_use_id'])
      if (id !== undefined) this.#declined.add(id)
      return
    }
    if (sub === 'status') {
      this.#compactionStatus(f, step)
      return
    }
    if (sub === 'compact_boundary') {
      this.#compactBoundary(f, step)
      return
    }
    if (sub === 'api_retry' && !this.#terminal && this.#isAuthRetry(f)) {
      // C09c: the CLI would retry a 401 ten times over ~3 min; fail now with the CLI's own wording.
      const c = classifyFailureDetailed({
        vendor: CLAUDE_VENDOR,
        structured: this.#status,
        stderrTail: this.#stderrTail.lines(),
        now: this.#now(),
      })
      const code = num(f['error_status'])
      const tag = code !== undefined ? ` (${code})` : ''
      const message = this.#credentialMessage(code) ?? `Claude Code could not authenticate${tag}.`
      this.#failWith(step, { ...c.failure, message }, c.hints)
      step.abort = true
    }
  }

  /**
   * `system/status` (SDKStatusMessage): `compacting` starts a compaction; live C23a then sends `{status: null,
   * compact_result: 'success'}` and, after a new init, the compact_boundary that ends it. A failed one (`compact_result:
   * 'failed'`, "Not enough messages to compact.") has no boundary: it ends here, failed.
   */
  #compactionStatus(f: JsonObject, step: NormalizeStep): void {
    if (f['status'] === 'compacting') {
      if (this.#compacting) return
      this.#compacting = true
      step.signals.push({ type: 'compaction', phase: 'start' })
      return
    }
    if (this.#compacting && f['compact_result'] === 'failed') {
      this.#compacting = false
      step.signals.push({ type: 'compaction', phase: 'end', failed: true })
    }
  }

  /**
   * `system/compact_boundary` (SDKCompactBoundaryMessage): the compaction is over. `compact_metadata` names the trigger
   * (manual `/compact` or auto) and the context before and after (live C23a: pre 26,599, post 2,160).
   */
  #compactBoundary(f: JsonObject, step: NormalizeStep): void {
    const m = obj(f['compact_metadata'])
    const trigger = str(m?.['trigger'])
    const pre = num(m?.['pre_tokens'])
    const post = num(m?.['post_tokens'])
    this.#compacting = false
    if (post !== undefined) this.#contextUsed = post
    step.signals.push({
      type: 'compaction',
      phase: 'end',
      ...(trigger === 'manual' || trigger === 'auto' ? { trigger } : {}),
      ...(pre !== undefined ? { preTokens: pre } : {}),
      ...(post !== undefined ? { postTokens: post } : {}),
    })
  }

  /**
   * A subagent's task frames (task_started / task_progress / task_notification, live C13): its type, the tool it ran
   * last and its tokens, as an update of the Agent tool row that started it (the same id, `phase: 'start'` again). A row
   * that already ended (a subagent sent to the background) is left alone.
   */
  #taskProgress(f: JsonObject, step: NormalizeStep): void {
    const toolId = str(f['tool_use_id'])
    const t = toolId !== undefined ? this.#tools.get(toolId) : undefined
    if (toolId === undefined || t === undefined || t.ended) return
    const type = str(f['subagent_type'])
    if (type !== undefined && type !== '') t.agentType = type
    const tokens = num(obj(f['usage'])?.['total_tokens'])
    if (tokens !== undefined && tokens > 0) step.signals.push({ type: 'subagent-tokens', id: toolId, tokens })
    const parts = [
      t.base ?? '',
      t.agentType ?? '',
      str(f['last_tool_name']) ?? '',
      tokens !== undefined && tokens > 0 ? tokensText(tokens) : '',
    ].filter((p) => p !== '')
    const summary = parts.join(' · ')
    if (summary === t.summary) return
    t.summary = summary
    step.events.push({ type: 'tool', id: toolId, name: t.name, summary, phase: 'start' })
  }

  /**
   * init's `mcp_servers` (name, status): an MCP server the pass allowed that did not connect (failed, needs sign-in, or
   * turned off) gets a warning, once; the pass goes on without it. `pending` is still connecting, not a failure.
   */
  #mcpStatus(f: JsonObject, step: NormalizeStep): void {
    const allowed = this.#o.allowedMcp ?? []
    const servers = f['mcp_servers']
    if (allowed.length === 0 || !Array.isArray(servers)) return
    for (const s of servers) {
      const o = obj(s)
      const name = str(o?.['name'])
      const status = str(o?.['status'])
      if (name === undefined || status === undefined || !allowed.includes(name)) continue
      if (!MCP_NOT_CONNECTED.has(status) || this.#mcpWarned.has(name)) continue
      this.#mcpWarned.add(name)
      const why =
        status === 'needs-auth'
          ? 'it needs you to sign in'
          : status === 'disabled'
            ? 'it is turned off'
            : 'it failed to start'
      step.events.push({
        type: 'error',
        message: `The MCP server ${name} you allowed for this pass did not connect (${why}). The pass goes on without it.`,
        raw: JSON.stringify({ mcp_server_status: status }),
        fatal: false,
      })
    }
  }

  #isAuthRetry(f: JsonObject): boolean {
    const attempt = num(f['attempt']) ?? 1
    const auth = f['error'] === 'authentication_failed' || num(f['error_status']) === 401
    return auth && attempt >= AUTH_RETRY_FAIL_FAST_ATTEMPT
  }

  /** A tool about to run, against the guardrails. Fails closed: an answer this cannot work out is a refusal. */
  #guardrailHook(requestId: string, input: JsonObject | undefined, step: NormalizeStep): void {
    let refusal: GuardrailFinding | undefined
    let failed = false
    try {
      const policy = this.#o.guardrails
      const tool = str(input?.['tool_name'])
      const args = obj(input?.['tool_input']) ?? {}
      if (policy !== undefined && tool !== undefined) {
        const cwd = this.#o.cwd ?? ''
        const command = GUARDED_SHELL.has(tool) ? str(args['command']) : undefined
        const path = GUARDED_EDIT.has(tool)
          ? (str(args['file_path']) ?? str(args['notebook_path']))
          : undefined
        if (command !== undefined) refusal = refuseCommand(policy, command, cwd)
        else if (path !== undefined) {
          // Claude's own plan files are written outside the folder by design.
          const plans = this.#o.configDir !== undefined ? [join(this.#o.configDir, 'plans')] : []
          refusal = refuseEdit(policy, path, cwd, { writable: plans })
        } else if (GUARDED_READ.has(tool)) {
          // Every path-like field the tool names: a search's folder and glob as well as a file.
          const named = ['file_path', 'notebook_path', 'path', 'glob', 'pattern']
            .filter((k) => tool !== 'Grep' || k !== 'pattern')
            .map((k) => str(args[k]))
            .filter((p): p is string => p !== undefined && p !== '')
          for (const p of named) {
            refusal = refuseRead(policy, p, cwd)
            if (refusal !== undefined) break
          }
          // A search over a folder reads every file in it: refused when a private file is among them.
          if (refusal === undefined && tool === 'Grep' && this.#o.privateFiles !== undefined) {
            refusal = refuseSearch(
              policy,
              { root: str(args['path']), glob: str(args['glob']), type: str(args['type']) },
              cwd,
              this.#o.privateFiles(),
            )
          }
        } else if (GUARDED_WEB.has(tool)) {
          refusal = refuseWeb(policy, str(args['url']) ?? str(args['query']) ?? tool)
        }
      } else failed = true
    } catch {
      failed = true
    }
    if (refusal !== undefined) step.signals.push({ type: 'guardrail-blocked', finding: refusal })
    if (refusal !== undefined || failed) {
      const why =
        refusal !== undefined
          ? `Dim Factory's guardrail refused this. ${refusal.rule}. ${refusal.detail} Do not try another way to do it; say so in your summary.`
          : "Dim Factory's guardrail could not check this, so it was refused."
      step.stdin.push(hookResponse(requestId, preToolDeny(why)))
      return
    }
    step.stdin.push(hookResponse(requestId, {}))
  }

  #controlRequest(f: JsonObject, step: NormalizeStep): void {
    const requestId = str(f['request_id'])
    const request = obj(f['request'])
    if (requestId === undefined || request === undefined) return
    // The post-compaction reminder's own hook: the adapter answers it (it reads the reminder asynchronously).
    if (
      request['subtype'] === 'hook_callback' &&
      this.#o.reminderHookId !== undefined &&
      str(request['callback_id']) === this.#o.reminderHookId
    ) {
      step.hook = { requestId, source: str(obj(request['input'])?.['source']) }
      return
    }
    if (request['subtype'] === 'hook_callback' && str(request['callback_id']) === GUARDRAIL_HOOK_ID) {
      this.#guardrailHook(requestId, obj(request['input']), step)
      return
    }
    const req = asCanUseTool(request)
    if (req !== undefined && this.#terminal) {
      step.stdin.push(denyResponse(requestId, UNSUPPORTED_ASK_MESSAGE, true))
      return
    }
    if (req === undefined) {
      step.stdin.push(
        errorResponse(requestId, `Unsupported by Dim Factory: ${str(request['subtype']) ?? 'unknown'}`),
      )
      return
    }
    const auto = autoAnswerFor(req, {
      planPass: this.route === 'plan',
      readOnly: this.route === 'readonly',
      cache: this.#cache,
      cwd: this.#o.cwd,
    })
    const signal = (decision: AskDecision, why: AutoAnswerReason): void => {
      step.signals.push({ type: 'auto-answered', requestId, decision, tool: req.tool_name, why })
    }
    if (auto === undefined) {
      this.#pending.set(requestId, { req })
      step.events.push(askEvent(requestId, req, this.#now() + this.#o.askTimeoutMs))
      return
    }
    switch (auto.kind) {
      case 'plan-capture': {
        const plan = capturePlan(req.input, this.#plansDir(), this.#o.readPlanFile, this.#home())
        this.#declined.add(req.tool_use_id)
        if (plan === undefined) {
          step.stdin.push(denyResponse(requestId, PLAN_EMPTY_MESSAGE))
          signal('deny', 'plan-capture')
          return
        }
        this.#plan = plan
        const planFilePath = str(req.input['planFilePath'])
        this.#capture = {
          markdown: plan,
          source: 'exitPlanMode',
          ...(planFilePath !== undefined ? { planFilePath } : {}),
        }
        step.signals.push({ type: 'plan-captured', markdown: plan, source: 'exitPlanMode' })
        step.stdin.push(denyResponse(requestId, PLAN_CAPTURED_MESSAGE, true))
        signal('deny', 'plan-capture')
        step.planCaptured = true
        return
      }
      case 'readonly':
        this.#declined.add(req.tool_use_id)
        step.stdin.push(denyResponse(requestId, READONLY_DENY_MESSAGE))
        signal('deny', 'readonly')
        return
      case 'unsupported':
        this.#declined.add(req.tool_use_id)
        step.stdin.push(denyResponse(requestId, UNSUPPORTED_ASK_MESSAGE))
        signal('deny', 'unsupported')
        return
      case 'allow-cache':
        step.stdin.push(allowResponse(requestId, req.input))
        signal('allow', auto.rule.source === 'project-permission' ? 'project-permission' : 'allow-cache')
        return
    }
  }

  #controlResponse(f: JsonObject, step: NormalizeStep): void {
    const body = obj(f['response']) as ControlResponseBody | undefined
    const requestId = str(body?.request_id)
    if (body === undefined || requestId === undefined) return
    step.reply =
      body.subtype === 'success'
        ? { requestId, ok: true, ...(body.response !== undefined ? { response: body.response } : {}) }
        : { requestId, ok: false, error: str(body.error) ?? 'error' }
    const at = this.#contextRequests.get(requestId)
    if (at === undefined) return
    this.#contextRequests.delete(requestId)
    const breakdown = body.subtype === 'success' ? parseContextUsage(body.response) : undefined
    if (breakdown === undefined) return
    step.signals.push({ type: 'context-breakdown', at, breakdown })
    // The breakdown's window is the CLI's own (the compaction window it measures against); its total is an estimate
    // (live C23b: after the result its message count read 13 tokens), so `used` stays the last request's when known.
    if (breakdown.window !== undefined && this.#contextWindow === undefined)
      this.#contextWindow = breakdown.window
    const used = this.#contextUsed ?? breakdown.total
    if (used !== undefined) {
      step.signals.push({
        type: 'context',
        used,
        ...(this.#contextWindow !== undefined ? { window: this.#contextWindow } : {}),
        source: 'breakdown',
      })
    }
  }

  /**
   * The main thread's window from a result's `modelUsage` (ModelUsage.contextWindow): the entry of the model init named,
   * else the largest (a subagent's model has its own entry).
   */
  #resultWindow(r: ResultFrame, step: NormalizeStep): void {
    const mu = obj(r.modelUsage)
    if (mu === undefined) return
    const windows = Object.entries(mu).flatMap(([model, v]) => {
      const w = num(obj(v)?.['contextWindow'])
      return w !== undefined && w > 0 ? [{ model, w }] : []
    })
    if (windows.length === 0) return
    const main = windows.find((x) => x.model === this.#sessionModel) ?? windows.sort((a, b) => b.w - a.w)[0]!
    if (main.w === this.#contextWindow) return
    this.#contextWindow = main.w
    if (this.#contextUsed !== undefined)
      step.signals.push({ type: 'context', used: this.#contextUsed, window: main.w, source: 'session' })
  }

  #result(r: ResultFrame, step: NormalizeStep): void {
    const first = !this.#sawResult
    this.#sawResult = true
    if (first) step.result = true
    this.#resultWindow(r, step)
    const usage = this.#reportUsage(r, step)
    for (const d of r.permission_denials ?? []) {
      if (typeof d?.tool_use_id === 'string') this.#toolEnd(d.tool_use_id, d.tool_name, 'declined', step)
    }
    if (this.#terminal) return
    if (PLAN_CAPTURE_IS_SUCCESS && this.#plan !== undefined) {
      this.#done(this.#plan, usage, step)
      return
    }
    const failed = r.is_error === true || r.subtype !== 'success'
    if (!failed) {
      const text = this.#finalMsg !== '' ? this.#finalMsg : (r.result ?? '')
      const total = this.#heldTotal(usage)
      // Background shells or subagents still run: hold the answer; the CLI starts a new turn when they finish.
      if (this.#background.length > 0) {
        this.#held = { text, usage: total }
        step.signals.push({ type: 'waiting', tasks: this.#background.map((t) => t.description) })
        return
      }
      this.#held = undefined
      if (this.route === 'plan' && text.trim() !== '') {
        this.#capture = { markdown: text.trim(), source: 'final-message' }
        step.signals.push({ type: 'plan-captured', markdown: text.trim(), source: 'final-message' })
      }
      // C17: the answer to initialize's jsonSchema, ahead of the `done` it belongs to.
      if (r.structured_output !== undefined && r.structured_output !== null)
        step.signals.push({ type: 'meta', key: META_STRUCTURED_OUTPUT, value: r.structured_output })
      this.#done(text, total, step)
      return
    }
    if (usage !== undefined) step.signals.push({ type: 'meta', key: META_USAGE, value: usage })
    if (this.#killedBy !== undefined) {
      this.#dimFactoryError(step, resultSummary(r))
      return
    }
    this.#classified(step, {}, num(r.api_error_status))
  }

  /**
   * The pass's usage after a follow-up turn: a result's `modelUsage` is the process's running total, so the latest
   * delta covers the held turn too; only a resumed session without a known base reports per turn (result.usage), and
   * then the held turn's usage is added.
   */
  #heldTotal(usage: Usage | undefined): Usage | undefined {
    const held = this.#held?.usage
    if (held === undefined) return usage
    if (usage === undefined) return held
    return this.#usage.resumed && this.#usage.base === undefined ? addUsage(held, usage) : usage
  }

  #done(result: string, usage: Usage | undefined, step: NormalizeStep): void {
    this.#succeeded = true
    this.#emitTerminal(step, usage !== undefined ? { type: 'done', result, usage } : { type: 'done', result })
  }

  /** `raw` is evidence (a result summary); classify() redacts and caps it like every other raw. */
  #dimFactoryError(step: NormalizeStep, raw?: string): void {
    const kind = this.#killedBy!
    const failure = classify({
      vendor: CLAUDE_VENDOR,
      appInitiated: { kind, ...(raw !== undefined ? { raw } : {}) },
      now: this.#now(),
    })
    if (failure === null) {
      const quitRaw = raw !== undefined ? redactRaw(raw) : ''
      this.#emitTerminal(step, {
        type: 'error',
        message: 'Dim Factory is shutting down.',
        raw: quitRaw,
        fatal: true,
      })
      return
    }
    this.#emitTerminal(step, errorEvent(failure, true))
  }

  /** Per-pass delta; undefined when the result carries no usage (C04d: interrupted turns report `{}`). */
  #reportUsage(r: ResultFrame, step: NormalizeStep): Usage | undefined {
    const mu = r.modelUsage
    if (mu === undefined || mu === null || typeof mu !== 'object') return undefined
    if (EMPTY_MODEL_USAGE_IS_UNKNOWN && Object.keys(mu).length === 0) return undefined
    const totals = sumClaudeModelUsage(mu)
    const cost = num(r.total_cost_usd)
    if (cost !== undefined) totals.costUsd = cost
    const delta = this.#usage.report(totals)
    this.#reported = this.#usage.cumulative()
    return this.#passUsage(delta, r, step)
  }

  /**
   * A resumed session without a known base cannot subtract: report this turn's `result.usage` tokens (C08a/C08b:
   * equal to the Δ modelUsage), with the cost unknown, and say so in a meta signal. A counter that went
   * backwards is flagged the same way.
   */
  #passUsage(delta: UsageDelta, r: ResultFrame, step: NormalizeStep): Usage {
    if (this.#usage.resumed && this.#usage.base === undefined) {
      const turn = turnUsage(r.usage)
      step.signals.push({
        type: 'meta',
        key: USAGE_APPROX_META,
        value: { reason: 'resumed-without-base', source: turn !== undefined ? 'result.usage' : 'cumulative' },
      })
      return turn ?? delta.usage
    }
    if (delta.approx) {
      step.signals.push({
        type: 'meta',
        key: USAGE_APPROX_META,
        value: { reason: 'counter-reset', fields: delta.resetFields },
      })
    }
    return delta.usage
  }

  #pathOpts(): { cwd?: string; home?: string } {
    const out: { cwd?: string; home?: string } = {}
    if (this.#o.cwd !== undefined) out.cwd = this.#o.cwd
    if (this.#o.home !== undefined) out.home = this.#o.home
    return out
  }

  #home(): string {
    return this.#o.home ?? homedir()
  }

  #plansDir(): string {
    return join(this.#o.configDir ?? join(this.#home(), '.claude'), 'plans')
  }
}

// ---- recordings -------------------------------------------------------------------------------------------

export interface RecordingHeader {
  kind: 'header'
  argv?: string[]
  scenario?: string
  [k: string]: unknown
}

export interface RecordingFrame {
  t?: number
  dir: 'in' | 'out' | 'err' | 'exit'
  line?: string
  code?: number | null
  signal?: string | null
  /** `"tree"` when the recorder killed the process tree (C10b). */
  killed?: string
}

export function parseRecording(text: string): {
  header: RecordingHeader | undefined
  frames: RecordingFrame[]
} {
  let header: RecordingHeader | undefined
  const frames: RecordingFrame[] = []
  for (const raw of text.split(/\r?\n/)) {
    const v = parseFrame(raw)
    if (v === undefined) continue
    if (v['kind'] === 'header') header = v as RecordingHeader
    else if (typeof v['dir'] === 'string') frames.push(v as unknown as RecordingFrame)
  }
  return { header, frames }
}

const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === flag) return argv[i + 1]
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
  }
  return undefined
}

/** The normalizer route a recorded argv implies (plan mode → plan; dontAsk → readonly; else edit). */
export function routeFromArgv(argv: readonly string[]): { route: ClaudeRoute; resumed: boolean } {
  const mode = flagValue(argv, '--permission-mode')
  const route: ClaudeRoute = mode === 'plan' ? 'plan' : mode === 'dontAsk' ? 'readonly' : 'edit'
  return { route, resumed: flagValue(argv, '--resume') !== undefined }
}

/** What a recorded host reply to can_use_tool means as an AskDecision. */
export function decisionFromReply(
  frame: JsonObject,
): { requestId: string; decision: AskDecision } | undefined {
  if (frame['type'] !== 'control_response') return undefined
  const body = obj(frame['response'])
  const requestId = str(body?.['request_id'])
  const res = obj(body?.['response'])
  if (requestId === undefined || res === undefined) return undefined
  if (res['behavior'] === 'allow') {
    const perms = res['updatedPermissions']
    return { requestId, decision: Array.isArray(perms) && perms.length > 0 ? 'allow-session' : 'allow' }
  }
  if (res['behavior'] === 'deny')
    return { requestId, decision: res['interrupt'] === true ? 'cancel' : 'deny' }
  return undefined
}

export type RecordingEntry = NormalizedEvent | AdapterSignal | { type: 'stdin'; frame: StdinFrame }

export interface NormalizeRecordingOptions extends Partial<Omit<NormalizerOptions, 'route'>> {
  route?: ClaudeRoute
  /** Apply the recorded host answers to raised asks (default true). */
  applyAnswers?: boolean
}

/**
 * Feed a recording through a fresh normalizer: every `out`/`err` frame, the recorded host answers to raised
 * asks, the recorded interrupt (as a user stop), then the exit. Returns events, signals and the stdin frames
 * the adapter itself would write, in order.
 */
export function normalizeRecording(text: string, o: NormalizeRecordingOptions = {}): RecordingEntry[] {
  const { header, frames } = parseRecording(text)
  const fromArgv = routeFromArgv(header?.argv ?? [])
  // The recorder gave the CLI ANTHROPIC_API_KEY (C09c): the adapter would have spawned it with that key.
  const envKeys = Array.isArray(header?.['envKeys']) ? (header['envKeys'] as unknown[]) : []
  const n = new ClaudeNormalizer({
    askTimeoutMs: 600_000,
    now: () => 0,
    apiKeyEnv: envKeys.includes('ANTHROPIC_API_KEY'),
    ...o,
    route: o.route ?? fromArgv.route,
    resumed: o.resumed ?? fromArgv.resumed,
  })
  const out: RecordingEntry[] = []
  const take = (s: NormalizeStep): void => {
    out.push(...s.signals, ...s.events)
    for (const frame of s.stdin) out.push({ type: 'stdin', frame })
  }
  let lastExit: RecordingFrame | undefined
  for (const fr of frames) {
    if (fr.dir === 'out' && typeof fr.line === 'string') take(n.line(fr.line))
    else if (fr.dir === 'err' && typeof fr.line === 'string') n.stderr(fr.line)
    else if (fr.dir === 'in' && typeof fr.line === 'string' && o.applyAnswers !== false) {
      const v = parseFrame(fr.line)
      if (v === undefined) continue
      const d = decisionFromReply(v)
      // A recorded cancel is the host's (the user's) deny + interrupt: P9b, not the ask timer.
      const subtype = v['type'] === 'control_request' ? obj(v['request'])?.['subtype'] : undefined
      if (d !== undefined && n.pendingAsks().includes(d.requestId))
        take(n.answer(d.requestId, d.decision, d.decision === 'cancel' ? 'denied' : undefined))
      else if (subtype === 'interrupt') n.markKilled('stop')
      else if (subtype === 'get_context_usage' && typeof v['request_id'] === 'string')
        n.expectContextUsage(v['request_id'], n.sawResult ? 'end' : 'start')
    } else if (fr.dir === 'exit') lastExit = fr
  }
  if (lastExit !== undefined) {
    if (lastExit.killed !== undefined) n.markKilled('stop')
    take(
      n.end({
        code: lastExit.code ?? null,
        signal: lastExit.signal ?? null,
        ...(lastExit.t !== undefined ? { ranMs: lastExit.t } : {}),
      }),
    )
  }
  return out
}
