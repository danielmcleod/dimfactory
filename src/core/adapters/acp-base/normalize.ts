// ACP frames → normalized events and signals for one pass (updates, permissions in their checking order, the
// decision table, cancel; usage: the adapter emits this pass's delta). Pure state, no I/O but a real-path lookup
// when a path is not inside the pass folder as written: the run handle (run.ts) feeds it and applies what it
// returns, and the unit tests drive it directly.
import { isAbsolute, resolve } from 'node:path'
import type {
  AdapterSignal,
  AllowRule,
  AskDecision,
  AutoAnswerReason,
  NormalizedEvent,
  Usage,
} from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import type { Mode } from '../../../shared/run.ts'
import type { AppKill } from '../../heal/classify.ts'
import { classify } from '../../heal/classify.ts'
import { samePath } from '../../real-path.ts'
import { ruleMatches } from '../allow-cache.ts'
import type { AllowSource } from '../allow-cache.ts'
import { classifyFailure, errorEvent, makeFailure } from '../errors.ts'
import {
  META_LATE_ALLOW_RULE,
  META_PLAN_FALLBACK,
  META_PLAN_SOURCE,
  META_USAGE,
  META_USAGE_APPROX,
} from '../types.ts'
import type { AskCancelReason, StartStep } from '../types.ts'
import { UsageTracker, addUsage, isZeroUsage, normalizeUsage } from '../usage.ts'
import { outputTokens, toolFingerprint } from '../fingerprint.ts'
import type { AcpUsageSpec } from './config.ts'
import {
  allowQueryOf,
  allowRuleOf,
  askDetail,
  askKindOf,
  isModeSwitch,
  isPlanExit,
  placeOf,
  planTextOf,
  toolNameOf,
  toolRowOf,
} from './permissions.ts'
import { commandOf } from './permissions.ts'
import type { ShellReader } from './permissions.ts'
import {
  CANCELLED_OUTCOME,
  cachedReadInInputOf,
  canAllowSession,
  permissionReply,
  promptUsageOf,
  rejectReply,
  usageFromAcp,
  usageFromContext,
} from './protocol.ts'
import type { PermissionOption, PermissionOptionPrefs } from './protocol.ts'
import type { Rec } from './wire.ts'
import { contentText, num, permissionOptions, rec, str } from './wire.ts'

export interface AcpNormalizerOptions {
  vendor: string
  /** The vendor's display name for user-facing text. */
  displayName: string
  step: StartStep
  /** The pass's own mode (read-only steps run read-only whatever their mode). */
  mode: Mode
  cwd: string
  /** The Plan pass runs in the vendor's native plan mode (plan exit captured). */
  planNative: boolean
  /** Continuing a session (load or resume); `priorUsage` is its last cumulative totals. */
  resumed: boolean
  priorUsage?: Usage | undefined
  askTimeoutMs: number
  allowRules: readonly AllowRule[]
  /** Easy mode's project permission (StartOptions.permit), asked after the run's rules. */
  permit?: AllowSource | undefined
  optionPrefs: PermissionOptionPrefs
  usage: AcpUsageSpec
  /** Mode rank (config.modeRank): a mode change above the pass's own stops the pass. */
  modeRank?: Readonly<Record<string, number>> | undefined
  /** Folders a plan exit's plan file may be read from (the vendor's own temp folder). */
  planRoots: readonly string[]
  /** The vendor's reader of its shell requests (AcpVendorConfig.shellRequest; Gemini: title and explanation). */
  shell?: ShellReader | undefined
  /** The vendor's title-only plan exit (AcpVendorConfig.planExitTitle; Gemini's exit_plan_mode). */
  planExitTitle?: RegExp | undefined
  /** A message chunk that reports a mode change (AcpVendorConfig.modeUpdateText; Gemini `[MODE_UPDATE] <mode>`). */
  modeUpdateText?: RegExp | undefined
  /** Prefix of the ask ids (the run handle's id): request ids restart in every process. */
  requestPrefix: string
  now: () => number
}

export interface AcpStep {
  events: NormalizedEvent[]
  signals: AdapterSignal[]
  /** The run handle sends `session/cancel` (a plan was captured, an ask was cancelled, the mode widened). */
  cancelTurn?: boolean
  /** The run handle ends the process at once (the agent widened its own mode). */
  hardStop?: boolean
}

const emptyStep = (): AcpStep => ({ events: [], signals: [] })

/** The fields of a frame that carry a value (ACP updates leave a field out, or null, when it did not change). */
function present(r: Rec | undefined): Rec {
  const out: Rec = {}
  for (const [k, v] of Object.entries(r ?? {})) if (v !== undefined && v !== null) out[k] = v
  return out
}

/** Steps that never change anything (read-only passes reject every permission request). */
const READ_ONLY_STEPS = new Set<string>(['plan', 'review', 'critic', 'heal', 'catalog', 'research'])

export function isReadOnlyPass(step: StartStep, mode: Mode): boolean {
  return READ_ONLY_STEPS.has(step) || mode === 'readonly'
}

/**
 * A PromptResponse's usage (unstable `usage`) → Usage (protocol.ts usageFromAcp). Cached reads come off `input` when
 * they are part of `inputTokens` (G05): the report's own total says so when it can (an agent whose `totalTokens` sums
 * every part: protocol.ts cachedReadInInputOf; Gemini's total cannot tell), else the vendor's `inputIncludesCached`.
 * undefined when the answer carries none.
 */
export function acpUsageOf(result: unknown, inputIncludesCached: boolean): Usage | undefined {
  const u = promptUsageOf(result)
  if (u === undefined) return undefined
  const cachedReadInInput = cachedReadInInputOf(u) ?? inputIncludesCached
  return normalizeUsage(usageFromAcp(u, { cachedReadInInput }))
}

interface PendingAsk {
  toolCallId: string | undefined
  toolCall: Rec | undefined
  options: PermissionOption[]
  resolve: (reply: unknown) => void
}

interface ToolState {
  name: string
  summary: string
  open: boolean
}

export type RequestOutcome = { reply: Promise<unknown>; step: AcpStep }

/** The last frames that can explain a failure (stop reasons, errors; no content). */
const EVIDENCE_MAX = 20

export class AcpNormalizer {
  readonly #o: AcpNormalizerOptions
  readonly #pending = new Map<string, PendingAsk>()
  readonly #tools = new Map<string, ToolState>()
  /** What the agent said about each tool call so far (tool_call, then its updates), for the permission request. */
  readonly #toolCalls = new Map<string, Rec>()
  readonly #declined = new Set<string>()
  readonly #cacheRules: AllowRule[]
  readonly #evidence: unknown[] = []
  readonly #tracker: UsageTracker
  #sessionId: string | undefined
  #final = ''
  #anyText = false
  #sep = false
  #lastMessageId: string | undefined
  #terminal = false
  #killedBy: AppKill | undefined
  #dropping = false
  #targetMode: string | undefined
  #modeSet = false
  #plan: { markdown: string } | undefined
  #planExitSeen = false
  #planFallback: string | undefined
  #promptResult: unknown
  #context: { used: number; cost?: { amount: number; currency: string } } | undefined
  /** compaction_update ids: started, or ended (each counted once). */
  readonly #compactions = new Map<string, 'started' | 'ended'>()
  #cumulative: Usage | undefined

  constructor(o: AcpNormalizerOptions) {
    this.#o = o
    this.#cacheRules = [...o.allowRules]
    this.#tracker = new UsageTracker({ base: o.resumed ? o.priorUsage : undefined, resumed: o.resumed })
  }

  get terminal(): boolean {
    return this.#terminal
  }

  get killedBy(): AppKill | undefined {
    return this.#killedBy
  }

  /** A plan exit was captured (the prompt's `cancelled` answer then ends the pass successfully). */
  get planCaptured(): boolean {
    return this.#plan !== undefined
  }

  sessionId(): string | undefined {
    return this.#sessionId
  }

  cumulativeUsage(): Usage | undefined {
    return this.#cumulative
  }

  pendingAsks(): string[] {
    return [...this.#pending.keys()]
  }

  markKilled(kind: AppKill): void {
    this.#killedBy ??= kind
  }

  /** The ask id of a JSON-RPC request id (the run handle's prefix + the id). */
  askId(rpcId: number | string): string {
    return `${this.#o.requestPrefix}${String(rpcId)}`
  }

  /** The session id from session/new (or the id a load/resume continues): the `session` event. */
  session(id: string): AcpStep {
    const step = emptyStep()
    if (this.#sessionId === id) return step
    this.#sessionId = id
    step.events.push({ type: 'session', id })
    return step
  }

  /** While a session/load replays its history, updates are dropped (until 400 ms of quiet, 10 s cap). */
  setDropping(on: boolean): void {
    this.#dropping = on
  }

  /** session/set_mode answered: from now on a mode change above `modeId` stops the pass. */
  modeSet(modeId: string | undefined): void {
    this.#targetMode = modeId
    this.#modeSet = modeId !== undefined
  }

  /** The native plan ran emulated (the vendor offers no plan mode): the Plan card says so. */
  planFellBack(reason: string): AcpStep {
    this.#planFallback = reason
    return { events: [], signals: [{ type: 'meta', key: META_PLAN_FALLBACK, value: { reason } }] }
  }

  // ---- session/update ---------------------------------------------------------------------------------------

  update(params: unknown): AcpStep {
    const step = emptyStep()
    step.signals.push({ type: 'liveness' })
    if (this.#terminal || this.#dropping) return step
    const p = rec(params) ?? {}
    const sid = str(p['sessionId'])
    if (sid !== undefined && this.#sessionId !== undefined && sid !== this.#sessionId) return step
    const u = rec(p['update'])
    if (u === undefined) return step
    switch (str(u['sessionUpdate']) ?? '') {
      case 'agent_message_chunk': {
        const text = contentText(u['content'])
        if (text === undefined || text === '') return step
        // Gemini reports a mode change as text (`[MODE_UPDATE] <mode>`): never printed, read as the mode change it is.
        const modeUpdate = this.#o.modeUpdateText?.exec(text.trim())
        if (modeUpdate?.[1] !== undefined) {
          this.#modeChanged(modeUpdate[1], step, 'agent_message_chunk')
          return step
        }
        const messageId = str(u['messageId'])
        if (messageId !== undefined && this.#lastMessageId !== undefined && messageId !== this.#lastMessageId)
          this.#sep = true
        if (messageId !== undefined) this.#lastMessageId = messageId
        if (this.#sep && this.#anyText) step.events.push({ type: 'text', delta: '\n\n' })
        if (this.#sep) this.#final = ''
        this.#sep = false
        this.#anyText = true
        this.#final += text
        step.events.push({ type: 'text', delta: text })
        return step
      }
      case 'tool_call':
        this.#toolCall(u, step)
        return step
      case 'tool_call_update':
        this.#toolUpdate(u, step)
        return step
      case 'usage_update': {
        // Context size and the session's running cost (schema UsageUpdate): the fallback usage source (G05b).
        const used = num(u['used'])
        if (used === undefined) return step
        const cost = rec(u['cost'])
        const amount = num(cost?.['amount'])
        const currency = str(cost?.['currency'])
        this.#context =
          amount !== undefined && currency !== undefined ? { used, cost: { amount, currency } } : { used }
        // The context meter: `used` of the window `size` (UsageUpdate), the session's own report.
        const size = num(u['size'])
        step.signals.push({
          type: 'context',
          used,
          ...(size !== undefined && size > 0 ? { window: size } : {}),
          source: 'session',
        })
        return step
      }
      case 'compaction_update': {
        // Unstable ACP CompactionUpdate (`in_progress`, then `completed` / `failed` / `cancelled`), by compactionId.
        const id = str(u['compactionId']) ?? ''
        const status = str(u['status']) ?? ''
        const seen = this.#compactions.get(id)
        if (status === 'in_progress' && seen === undefined) {
          this.#compactions.set(id, 'started')
          step.signals.push({ type: 'compaction', phase: 'start' })
        } else if (
          (status === 'completed' || status === 'failed' || status === 'cancelled') &&
          seen !== 'ended'
        ) {
          this.#compactions.set(id, 'ended')
          step.signals.push({
            type: 'compaction',
            phase: 'end',
            ...(status !== 'completed' ? { failed: true as const } : {}),
          })
        }
        return step
      }
      case 'current_mode_update':
        this.#modeChanged(str(u['currentModeId']), step, 'current_mode_update')
        return step
      default:
        // agent_thought_chunk, user_message_chunk, plan, available_commands_update, config_option_update,
        // session_info_update and anything newer: liveness only.
        return step
    }
  }

  #toolStart(id: string, toolCall: Rec, step: AcpStep): void {
    const { name, summary } = toolRowOf(toolCall, this.#o.cwd, this.#o.shell, this.#o.planExitTitle)
    this.#tools.set(id, { name, summary, open: true })
    this.#final = ''
    this.#sep = true
    // The fingerprint: the tool's name with what it was asked (rawInput, else its title and locations).
    const input = toolCall['rawInput'] ?? { title: toolCall['title'], locations: toolCall['locations'] }
    step.events.push({ type: 'tool', id, name, summary, phase: 'start', fp: toolFingerprint(name, input) })
  }

  #toolEnd(id: string, status: string, step: AcpStep): void {
    const t = this.#tools.get(id)
    if (t === undefined || !t.open) return
    t.open = false
    this.#final = ''
    this.#sep = true
    const known = this.#toolCalls.get(id)
    const out = outputTokens(known?.['rawOutput'] ?? known?.['content'])
    step.events.push({
      type: 'tool',
      id,
      name: t.name,
      summary: t.summary,
      phase: 'end',
      status: this.#declined.has(id) ? 'declined' : status === 'completed' ? 'ok' : 'failed',
      ...(out !== undefined ? { outTokens: out } : {}),
    })
  }

  /** Folds a tool_call or tool_call_update into what is known of that call (a field the frame leaves out stays). */
  #knowTool(id: string, u: Rec | undefined): Rec {
    const known = { ...this.#toolCalls.get(id), ...present(u) }
    this.#toolCalls.set(id, known)
    return known
  }

  /** `tool_call`: a tool start, deduped by toolCallId (a pending tool_call precedes each permission request). */
  #toolCall(u: Rec, step: AcpStep): void {
    const id = str(u['toolCallId'])
    if (id === undefined || id === '') return
    const known = this.#knowTool(id, u)
    if (!this.#tools.has(id)) {
      const command = commandOf(u, this.#o.shell)
      if (command !== undefined) step.signals.push({ type: 'shell-command', command })
      this.#toolStart(id, known, step)
    }
    const status = str(u['status'])
    if (status === 'completed' || status === 'failed') this.#toolEnd(id, status, step)
  }

  /** `tool_call_update`: the tool's end once it completed or failed (a start first when none was seen). */
  #toolUpdate(u: Rec, step: AcpStep): void {
    const id = str(u['toolCallId'])
    if (id === undefined || id === '') return
    const known = this.#knowTool(id, u)
    const status = str(u['status'])
    if (status !== 'completed' && status !== 'failed') return
    if (!this.#tools.has(id)) this.#toolStart(id, known, step)
    this.#toolEnd(id, status, step)
  }

  #rank(modeId: string): number {
    return this.#o.modeRank?.[modeId] ?? Number.POSITIVE_INFINITY
  }

  /**
   * The agent changed its mode. Dim Factory never approves a mode switch, so a change above the pass's own mode (a
   * mode in which more runs without asking) ends the pass at once: nothing may run unasked that the pass did not allow.
   * The echo of Dim Factory's own session/set_mode (before it answered, or naming the mode it set) changes nothing.
   */
  #modeChanged(
    modeId: string | undefined,
    step: AcpStep,
    via: 'current_mode_update' | 'agent_message_chunk',
  ): void {
    const target = this.#targetMode
    if (modeId === undefined || !this.#modeSet || target === undefined || modeId === target) return
    if (this.#rank(modeId) <= this.#rank(target)) return
    const f = makeFailure(
      'config_invalid',
      `${this.#o.displayName} switched itself to its "${modeId}" mode, which runs more without asking than this pass allows ("${target}"). Dim Factory stopped the pass.`,
      {
        raw: JSON.stringify({
          sessionUpdate: via,
          currentModeId: modeId,
          expected: target,
        }),
      },
    )
    this.#error(step, f)
    step.cancelTurn = true
    step.hardStop = true
  }

  // ---- session/request_permission (checked in order) ------------------------------------------------------

  request(params: unknown, rpcId: number | string): RequestOutcome {
    const step = emptyStep()
    const id = this.askId(rpcId)
    const p = rec(params) ?? {}
    // The request's toolCall is a ToolCallUpdate: an agent may send only the id and what changed, after the pending
    // tool_call that described it. What the request names wins; the rest comes from that tool_call.
    const sent = rec(p['toolCall'])
    const sentId = str(sent?.['toolCallId'])
    const toolCall =
      sentId !== undefined && sentId !== ''
        ? this.#knowTool(sentId, sent)
        : sent !== undefined
          ? present(sent)
          : undefined
    const toolCallId = str(toolCall?.['toolCallId'])
    const options = permissionOptions(p['options'])
    const tool = toolNameOf(str(toolCall?.['kind']))
    const prefs = this.#o.optionPrefs
    const reject = (): unknown => rejectReply(options, prefs)
    const auto = (decision: AskDecision, why: AutoAnswerReason) =>
      step.signals.push({ type: 'auto-answered', requestId: id, decision, tool, why })

    if (
      toolCallId !== undefined &&
      toolCallId !== '' &&
      !this.#tools.has(toolCallId) &&
      toolCall !== undefined
    )
      this.#toolStart(toolCallId, toolCall, step)
    if (this.#terminal) {
      auto('cancel', 'unsupported')
      return { reply: Promise.resolve(CANCELLED_OUTCOME), step }
    }

    // 1. A mode switch: the plan exit of a native Plan pass is captured; any other is rejected (never approved:
    //    an approved exit could widen what the pass may do).
    const exitTitle = this.#o.planExitTitle
    if (isModeSwitch(toolCall, exitTitle)) {
      if (toolCallId !== undefined) this.#declined.add(toolCallId)
      if (this.#o.planNative && isPlanExit(toolCall, exitTitle) && !this.#planExitSeen) {
        this.#planExitSeen = true
        const text = planTextOf(toolCall, this.#o.planRoots, exitTitle)
        if (text !== undefined) {
          this.#plan = { markdown: text }
          step.signals.push({ type: 'plan-captured', markdown: text, source: 'acp-exit-plan' })
        }
        auto('deny', 'plan-capture')
        step.cancelTurn = true
        return { reply: Promise.resolve(reject()), step }
      }
      auto('deny', this.#readOnly() ? 'readonly' : 'unsupported')
      return { reply: Promise.resolve(reject()), step }
    }

    // 2. A read-only pass rejects every request.
    if (this.#readOnly()) {
      if (toolCallId !== undefined) this.#declined.add(toolCallId)
      auto('deny', 'readonly')
      return { reply: Promise.resolve(reject()), step }
    }

    // 3. "Allow for this run" from an earlier ask (this run's allow cache): allow once.
    const once = permissionReply('allow', options, prefs)
    const hit = once !== CANCELLED_OUTCOME ? this.#cacheHit(toolCall) : undefined
    if (hit !== undefined) {
      auto('allow', hit)
      return { reply: Promise.resolve(once), step }
    }

    // 4. Ask the user.
    let resolveReply: (v: unknown) => void = () => undefined
    const reply = new Promise<unknown>((r) => {
      resolveReply = r
    })
    this.#pending.set(id, { toolCallId, toolCall, options, resolve: resolveReply })
    this.#sep = true
    step.events.push({
      type: 'ask',
      requestId: id,
      kind: askKindOf(str(toolCall?.['kind'])),
      detail: askDetail(toolCall, this.#o.cwd, this.#o.shell),
      expiresAt: this.#o.now() + this.#o.askTimeoutMs,
      allowSession: canAllowSession(options, prefs),
    })
    return { reply, step }
  }

  #readOnly(): boolean {
    return isReadOnlyPass(this.#o.step, this.#o.mode)
  }

  /**
   * The request runs in the pass's folder: one that names another folder, or whose folder Dim Factory cannot read for
   * certain (Gemini's explanation), is never matched (nor cached) for this folder.
   */
  #samePlace(toolCall: Rec | undefined): boolean {
    const d = placeOf(toolCall, this.#o.shell)
    if (d === undefined) return false
    if (d === '' || d === '.') return true
    // The same folder however each side spells it (Gemini names it by its getcwd(): /private/var on macOS).
    return samePath(this.#o.cwd, isAbsolute(d) ? d : resolve(this.#o.cwd, d))
  }

  /** Why the run's rules (or the project permission) allow this tool call now; undefined when nothing does. */
  #cacheHit(toolCall: Rec | undefined): 'allow-cache' | 'project-permission' | undefined {
    if (!this.#samePlace(toolCall)) return undefined
    const q = allowQueryOf(this.#o.vendor, toolCall, this.#o.shell)
    if (this.#cacheRules.some((r) => r.vendor === this.#o.vendor && ruleMatches(r, q, { cwd: this.#o.cwd })))
      return 'allow-cache'
    return this.#o.permit?.(q, { cwd: this.#o.cwd }) !== undefined ? 'project-permission' : undefined
  }

  /**
   * The user's (or the engine's) answer. allow → allow_once; allow-session → the session-scoped allow_always option
   * (and an exact rule for later processes); deny → reject_once. `cancel` (the ask timer, or a deny that pauses):
   * every pending permission is answered `cancelled` and the run handle sends session/cancel.
   */
  answer(requestId: string, decision: AskDecision, why?: AskCancelReason): AcpStep {
    const step = emptyStep()
    const p = this.#pending.get(requestId)
    if (p === undefined) return step
    if (decision === 'cancel') {
      this.markKilled(why === 'denied' ? 'deny' : 'ask')
      if (why !== 'denied') {
        // P19 "Allow & resume": the exact rule a late Allow adds (never wider than the request).
        const rule = this.#samePlace(p.toolCall)
          ? allowRuleOf(this.#o.vendor, p.toolCall, false, this.#o.shell)
          : undefined
        if (rule !== undefined)
          step.signals.push({ type: 'meta', key: META_LATE_ALLOW_RULE, value: { requestId, rule } })
      }
      this.#pending.delete(requestId)
      p.resolve(CANCELLED_OUTCOME)
      if (p.toolCallId !== undefined) this.#declined.add(p.toolCallId)
      this.#cancelPending(step)
      step.cancelTurn = true
      return step
    }
    this.#pending.delete(requestId)
    p.resolve(permissionReply(decision, p.options, this.#o.optionPrefs))
    if (decision === 'deny' && p.toolCallId !== undefined) this.#declined.add(p.toolCallId)
    if (decision === 'allow-session' && this.#samePlace(p.toolCall)) {
      const rule = allowRuleOf(
        this.#o.vendor,
        p.toolCall,
        canAllowSession(p.options, this.#o.optionPrefs),
        this.#o.shell,
      )
      if (rule !== undefined) {
        this.#cacheRules.push(rule)
        step.signals.push({ type: 'allow-rule', rule })
      }
    }
    return step
  }

  /**
   * Answers every waiting permission `cancelled` (ACP "Cancellation": after session/cancel the client answers them
   * all so), and tells the engine nobody answered them (`ask-withdrawn`).
   */
  #cancelPending(step: AcpStep): void {
    for (const [id, p] of this.#pending) {
      p.resolve(CANCELLED_OUTCOME)
      // Nobody allowed it: its tool, if it ends, ends declined.
      if (p.toolCallId !== undefined) this.#declined.add(p.toolCallId)
      step.signals.push({ type: 'ask-withdrawn', requestId: id })
    }
    this.#pending.clear()
  }

  /**
   * `$/cancel_request{requestId}`: the agent withdrew one of its own requests. A pending permission it names is
   * answered `cancelled` (the agent no longer waits for it) and withdrawn from the engine.
   */
  withdraw(params: unknown): AcpStep {
    const step = emptyStep()
    const id = rec(params)?.['requestId']
    if (typeof id !== 'number' && typeof id !== 'string') return step
    const key = this.askId(id)
    const p = this.#pending.get(key)
    if (p === undefined) return step
    this.#pending.delete(key)
    p.resolve(CANCELLED_OUTCOME)
    if (p.toolCallId !== undefined) this.#declined.add(p.toolCallId)
    step.signals.push({ type: 'ask-withdrawn', requestId: key })
    return step
  }

  /** A stop: every pending permission answered `cancelled` (the run handle then sends session/cancel). */
  cancelAll(): AcpStep {
    const step = emptyStep()
    this.#cancelPending(step)
    return step
  }

  // ---- the prompt's answer ------------------------------------------------------------------------------------

  #remember(frame: unknown): void {
    this.#evidence.push(frame)
    if (this.#evidence.length > EVIDENCE_MAX) this.#evidence.shift()
  }

  /** `session/prompt` answered `{stopReason, usage?}`. */
  promptResult(result: unknown): AcpStep {
    const step = emptyStep()
    if (this.#terminal) return step
    const r = rec(result) ?? {}
    this.#promptResult = result
    const stop = str(r['stopReason'])
    this.#remember({ result: { stopReason: stop ?? null } })
    switch (stop ?? '') {
      case 'cancelled':
        if (this.#plan !== undefined) this.#done(step)
        else if (this.#killedBy !== undefined) this.#dimFactoryError(step)
        else if (this.#planExitSeen) this.#noPlan(step)
        else this.#failed(step, {})
        return step
      case 'max_turn_requests':
      case 'refusal':
        this.#failed(step, {})
        return step
      default:
        // end_turn, max_tokens (the answer as far as it got) and any newer reason: the pass's answer.
        this.#done(step)
        return step
    }
  }

  /** A plan exit arrived but carried no plan Dim Factory could read. */
  #noPlan(step: AcpStep): void {
    this.#error(
      step,
      makeFailure(
        'stream_malformed',
        `${this.#o.displayName} asked to leave plan mode, but Dim Factory could not read the plan it wrote.`,
        { classifiedBy: 'app' },
      ),
    )
  }

  /** This pass's usage and the session's running total (the adapter computes the delta). */
  #passUsage(step: AcpStep): Usage | undefined {
    const prior = this.#o.resumed ? this.#o.priorUsage : undefined
    const u = acpUsageOf(this.#promptResult, this.#o.usage.inputIncludesCached)
    if (u !== undefined) {
      if (this.#o.usage.cumulative) {
        const d = this.#tracker.report(u)
        this.#cumulative = this.#tracker.cumulative()
        if (d.approx) {
          step.signals.push({
            type: 'meta',
            key: META_USAGE_APPROX,
            value:
              d.resetFields.length > 0
                ? { reason: 'counter-reset', fields: d.resetFields }
                : { reason: 'resumed-without-base' },
          })
        }
        return d.usage
      }
      this.#cumulative = prior !== undefined ? addUsage(normalizeUsage(prior), u) : u
      return u
    }
    const meta = this.#o.usage.metaUsage?.(this.#promptResult)
    if (meta !== undefined) {
      // No usage on the answer, the vendor's own totals in its _meta (Gemini 0.62 and 0.63 `_meta.quota.token_count`:
      // input includes the cached reads, no split, so the pass's usage is approximate; Grok `_meta.usage`: cached
      // reads apart, exact).
      const { approx, ...reported } = meta
      const usage = normalizeUsage(reported)
      this.#cumulative = prior !== undefined ? addUsage(normalizeUsage(prior), usage) : usage
      const reason = approx ?? 'no-cached-split'
      if (reason !== false) step.signals.push({ type: 'meta', key: META_USAGE_APPROX, value: { reason } })
      return usage
    }
    if (this.#context !== undefined) {
      // No usage on the answer: the last usage_update's context size stands in for the input (G05b), approximate.
      const usage = normalizeUsage(usageFromContext(this.#context))
      if (usage.costUsd !== undefined && prior?.costUsd !== undefined) {
        // The update's cost is the session's running total: this pass's share of it.
        usage.costUsd = Math.round(Math.max(0, usage.costUsd - prior.costUsd) * 1e10) / 1e10
      }
      this.#cumulative = prior !== undefined ? addUsage(normalizeUsage(prior), usage) : usage
      step.signals.push({ type: 'meta', key: META_USAGE_APPROX, value: { reason: 'context-only' } })
      return usage
    }
    step.signals.push({ type: 'meta', key: META_USAGE_APPROX, value: { reason: 'no-usage-reported' } })
    return undefined
  }

  #closeTools(step: AcpStep, status: 'failed' | 'declined'): void {
    for (const [id, t] of this.#tools) {
      if (!t.open) continue
      t.open = false
      step.events.push({
        type: 'tool',
        id,
        name: t.name,
        summary: t.summary,
        phase: 'end',
        status: this.#declined.has(id) ? 'declined' : status,
      })
    }
  }

  #done(step: AcpStep): void {
    this.#terminal = true
    this.#closeTools(step, 'failed')
    this.#cancelPending(step)
    let result = this.#final
    if (this.#o.step === 'plan' && this.#o.planNative && this.#planFallback === undefined) {
      if (this.#plan !== undefined) result = this.#plan.markdown
      else if (this.#final.trim() !== '') {
        // Plan mode ended without asking to leave it: its final message is the plan (with a warning, as for Codex).
        step.signals.push({ type: 'plan-captured', markdown: this.#final, source: 'final-message' })
        step.signals.push({
          type: 'meta',
          key: META_PLAN_SOURCE,
          value: {
            source: 'final-message',
            warning: `${this.#o.displayName} finished without leaving plan mode, so its final message is used as the plan.`,
          },
        })
      }
    }
    const usage = this.#passUsage(step)
    step.events.push(usage !== undefined ? { type: 'done', result, usage } : { type: 'done', result })
  }

  /** A failed attempt still bills: its usage goes in META_USAGE (never with `done`). */
  #billFailed(step: AcpStep): void {
    const before = step.signals.length
    const usage = this.#passUsage(step)
    // The approximate-usage note is for a `done`; a failed attempt reports what it has.
    step.signals.splice(before)
    if (usage !== undefined && !isZeroUsage(usage))
      step.signals.push({ type: 'meta', key: META_USAGE, value: usage })
  }

  #error(step: AcpStep, failure: Failure): void {
    this.#terminal = true
    this.#closeTools(step, this.#killedBy !== undefined ? 'declined' : 'failed')
    this.#cancelPending(step)
    this.#billFailed(step)
    step.events.push(errorEvent(failure, true))
  }

  #runStep(): Exclude<StartStep, 'heal' | 'catalog'> | undefined {
    const s = this.#o.step
    return s === 'heal' || s === 'catalog' ? undefined : s
  }

  #stepField(): { step?: Exclude<StartStep, 'heal' | 'catalog'> } {
    const s = this.#runStep()
    return s !== undefined ? { step: s } : {}
  }

  #dimFactoryError(step: AcpStep): void {
    const f =
      classify({
        vendor: this.#o.vendor,
        ...this.#stepField(),
        appInitiated: { kind: this.#killedBy ?? 'stop' },
        now: this.#o.now(),
      }) ?? makeFailure('user_cancelled', 'Dim Factory is shutting down.', { classifiedBy: 'app' })
    this.#error(step, f)
  }

  #failed(
    step: AcpStep,
    o: {
      rpcError?: { method: string; code: number; message: string; required?: boolean }
      stderrTail?: readonly string[]
      exitCode?: number | null
      signal?: string | null
      ranMs?: number
      noTerminal?: boolean
    },
  ): void {
    const f = classifyFailure({
      vendor: this.#o.vendor,
      ...this.#stepField(),
      structured: [...this.#evidence],
      ...(o.rpcError !== undefined ? { rpcError: o.rpcError } : {}),
      ...(o.stderrTail !== undefined ? { stderrTail: o.stderrTail } : {}),
      ...(o.exitCode !== undefined ? { exitCode: o.exitCode } : {}),
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
      ...(o.ranMs !== undefined ? { ranMs: o.ranMs } : {}),
      ...(o.noTerminal === true ? { protocol: { noTerminal: true } } : {}),
      mode: this.#o.mode,
      now: this.#o.now(),
    })
    this.#error(step, f)
  }

  /** A failure the run handle found itself (spawn, handshake, a refused session, a persist that failed). */
  fail(failure: Failure): AcpStep {
    const step = emptyStep()
    if (this.#terminal) return step
    this.#error(step, failure)
    return step
  }

  /** A JSON-RPC error on a request the pass needs (session/new, set_mode, prompt, …), classified. */
  failRpc(o: {
    rpcError: { method: string; code: number; message: string; required?: boolean }
    stderrTail?: readonly string[]
  }): AcpStep {
    const step = emptyStep()
    if (this.#terminal) return step
    if (this.#killedBy !== undefined) {
      this.#dimFactoryError(step)
      return step
    }
    this.#remember({ error: { code: o.rpcError.code, message: o.rpcError.message } })
    this.#failed(step, o)
    return step
  }

  /** The process ended: the terminal event when none was emitted (crash, an exit code, a kill). */
  end(exit: {
    code: number | null
    signal: string | null
    ranMs: number
    stderrTail: readonly string[]
  }): AcpStep {
    const step = emptyStep()
    this.#cancelPending(step)
    if (this.#terminal) return step
    if (this.#killedBy !== undefined) {
      this.#dimFactoryError(step)
      return step
    }
    if (this.#plan !== undefined) {
      // The plan was captured and the turn cancelled; the agent ended before answering the prompt: the pass is done.
      this.#done(step)
      return step
    }
    this.#failed(step, {
      stderrTail: exit.stderrTail,
      exitCode: exit.code,
      signal: exit.signal,
      ranMs: exit.ranMs,
      noTerminal: true,
    })
    return step
  }
}
