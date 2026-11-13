// `muse exec --json` records → the six normalized events. Each stdout line
// is one journal record (protocol.ts, the synthesized pin): the session stream names the session, `run.output.delta`
// streams the answer, tool tasks (`task.lifecycle.*` with `task_kind: tool.<name>`) are the tool rows, and
// `run.terminal.*` ends the run. exec relays nothing: there is never an ask.
import type { AdapterSignal, NormalizedEvent, ToolStatus, Usage } from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import type { Mode, StepKey } from '../../../shared/run.ts'
import type { AppKill } from '../../heal/classify.ts'
import { classify } from '../../heal/classify.ts'
import { arr, num, rec, str } from '../acp-base/wire.ts'
import type { Rec } from '../acp-base/wire.ts'
import { classifyFailure, errorEvent, makeFailure } from '../errors.ts'
import { relativeTo } from '../paths.ts'
import { META_MODEL_USED, META_USAGE } from '../types.ts'
import type { StartStep } from '../types.ts'
import { addUsage } from '../usage.ts'
import { MUSE_VENDOR } from './cli-spec.ts'
import {
  P,
  RUN_TERMINAL_PREFIX,
  TASK_END_KINDS,
  TASK_LIFECYCLE_PREFIX,
  TERMINAL_COMPLETED,
  TOOL_KEY_PREFIX,
  TOOL_TASK_PREFIX,
} from './protocol.ts'
import { ensureMuseSignals } from './signals.ts'

export interface MuseStep {
  events: NormalizedEvent[]
  signals: AdapterSignal[]
  /** A `run.terminal.*` record arrived: the process should exit soon (the run arms its exit timer). */
  terminalRecord?: boolean
}

const emptyStep = (): MuseStep => ({ events: [], signals: [] })

export interface MuseNormalizerOptions {
  step: StartStep
  mode: Mode
  cwd: string
  /** The pass's own model; with none, the model Muse reports is sent as META_MODEL_USED. */
  model?: string | null | undefined
  now: () => number
}

interface ToolTask {
  name: string
  callId?: string
  started: boolean
  ended: boolean
  /** The policy refused the task's side effect (`policy_decision: deny:…`). */
  denied: boolean
  /** `tool.result.correlation_facts.outcome`. */
  outcome?: string
  /** `tool.result.edit_facts.path`. */
  path?: string
}

/** Words that say a tool was refused rather than broken (an escalation under --disable-approval). */
const REFUSED = /\bden(?:y|ied)\b|reject|refus|not approved|approval|blocked|escalat/i

/**
 * A model call's usage in the Responses API's words (x-assumed in the pin: no capture shows exec usage). Cached reads
 * are part of `input_tokens` there, so they come off `input`; reasoning is part of `output_tokens`.
 */
export function museUsage(v: unknown): Usage | undefined {
  const r = rec(v)
  if (r === undefined) return undefined
  const input = num(r['input_tokens']) ?? num(r['prompt_tokens'])
  const output = num(r['output_tokens']) ?? num(r['completion_tokens'])
  if (input === undefined && output === undefined) return undefined
  const cached =
    num(rec(r['input_tokens_details'])?.['cached_tokens']) ??
    num(rec(r['prompt_tokens_details'])?.['cached_tokens']) ??
    num(r['cached_input_tokens']) ??
    0
  const reasoning =
    num(rec(r['output_tokens_details'])?.['reasoning_tokens']) ?? num(r['reasoning_output_tokens'])
  const u: Usage = {
    input: Math.max(0, (input ?? 0) - cached),
    output: Math.max(0, output ?? 0),
    cacheRead: Math.max(0, cached),
  }
  if (reasoning !== undefined) u.reasoning = Math.max(0, reasoning)
  return u
}

/** The usage a `task.lifecycle.status` record's producer facets report (one per model call). */
function statusUsage(event: Rec): Usage | undefined {
  let total: Usage | undefined
  for (const facet of arr(rec(event['details'])?.['facets'])) {
    const f = rec(facet)
    const u = museUsage(rec(f?.['detail'])?.['usage']) ?? museUsage(f?.['usage'])
    if (u !== undefined) total = total === undefined ? u : addUsage(total, u)
  }
  return total
}

/** The usage of the last model call a status record's facets report. */
function lastCallUsage(event: Rec): Usage | undefined {
  let last: Usage | undefined
  for (const facet of arr(rec(event['details'])?.['facets'])) {
    const f = rec(facet)
    last = museUsage(rec(f?.['detail'])?.['usage']) ?? museUsage(f?.['usage']) ?? last
  }
  return last
}

/** The stdout lines that were not records (kept for the classifier's stdout tail). */
const STRAY_MAX = 20

export class MuseNormalizer {
  readonly #o: MuseNormalizerOptions
  readonly #tasks = new Map<string, ToolTask>()
  readonly #callTask = new Map<string, string>()
  /** A tool.result that came before its task named its call id. */
  readonly #earlyResults = new Map<string, Rec>()
  /** Failure evidence: the failed `run.terminal.*` record (never a tool's own failure, which the run survives). */
  readonly #evidence: unknown[] = []
  readonly #stray: string[] = []
  #sessionId: string | undefined
  #text = ''
  #anyText = false
  #terminal = false
  #terminalSeen = false
  #killedBy: AppKill | undefined
  #usage: Usage | undefined
  #terminalUsage: Usage | undefined
  #modelSent = false

  constructor(o: MuseNormalizerOptions) {
    this.#o = o
    ensureMuseSignals()
  }

  /** A terminal event (`done` or a fatal `error`) was emitted. */
  get terminal(): boolean {
    return this.#terminal
  }

  /** A `run.terminal.*` record arrived. */
  get terminalSeen(): boolean {
    return this.#terminalSeen
  }

  sessionId(): string | undefined {
    return this.#sessionId
  }

  /** A fresh session's totals are this pass's usage (Muse passes never resume: capabilities.resume 'none'). */
  cumulativeUsage(): Usage | undefined {
    return this.#terminalUsage ?? this.#usage
  }

  markKilled(kind: AppKill): void {
    this.#killedBy ??= kind
  }

  /** One stdout line. A line that is not a JSON record is kept for the classifier and otherwise ignored. */
  line(line: string): MuseStep {
    const t = line.trim()
    if (t === '') return emptyStep()
    let frame: unknown
    try {
      frame = JSON.parse(t)
    } catch {
      this.#keepStray(t)
      return { events: [], signals: [{ type: 'liveness' }] }
    }
    const r = rec(frame)
    if (r === undefined || str(r['payload_type']) === undefined) {
      this.#keepStray(t)
      return { events: [], signals: [{ type: 'liveness' }] }
    }
    return this.record(r)
  }

  /** One record (`{stream, payload_type, payload, …}`). */
  record(r: Rec): MuseStep {
    const step = emptyStep()
    if (this.#terminal) return step
    step.signals.push({ type: 'liveness' })
    const stream = rec(r['stream'])
    const sid = str(stream?.['id'])
    if (
      str(stream?.['kind']) === 'session' &&
      sid !== undefined &&
      sid !== '' &&
      this.#sessionId === undefined
    ) {
      this.#sessionId = sid
      step.events.push({ type: 'session', id: sid })
    }
    const type = str(r['payload_type']) ?? ''
    const payload = rec(r['payload']) ?? {}
    if (type === P.outputDelta) {
      this.#textDelta(str(payload['text']) ?? '', step)
    } else if (type === P.modelConfigured) {
      this.#modelConfigured(payload, step)
    } else if (type === P.toolResult) {
      this.#toolResult(payload)
    } else if (type.startsWith(TASK_LIFECYCLE_PREFIX)) {
      this.#taskLifecycle(type.slice(TASK_LIFECYCLE_PREFIX.length), payload, step)
    } else if (type.startsWith(RUN_TERMINAL_PREFIX)) {
      this.#runTerminal(type, r, payload, step)
    }
    return step
  }

  /** A failure found by the run handle itself (flags, trust, the binary, the prompt file, a spawn error). */
  fail(failure: Failure): MuseStep {
    const step = emptyStep()
    if (this.#terminal) return step
    this.#terminal = true
    step.events.push(errorEvent(failure, true))
    return step
  }

  /** The process is gone: the terminal event when none was emitted. */
  end(exit: {
    code: number | null
    signal: string | null
    ranMs: number
    stderrTail: readonly string[]
  }): MuseStep {
    const step = emptyStep()
    if (this.#terminal) return step
    if (this.#killedBy !== undefined) {
      const f =
        classify({ vendor: MUSE_VENDOR, appInitiated: { kind: this.#killedBy }, now: this.#o.now() }) ??
        makeFailure('user_cancelled', 'Dim Factory is shutting down.', { classifiedBy: 'app' })
      this.#failWith(step, f)
      return step
    }
    const runStep = this.#runStep()
    const f = classifyFailure({
      vendor: MUSE_VENDOR,
      ...(runStep !== undefined ? { step: runStep } : {}),
      structured: [...this.#evidence],
      stderrTail: exit.stderrTail,
      stdoutTail: this.#stray,
      exitCode: exit.code,
      signal: exit.signal,
      ranMs: exit.ranMs,
      mode: this.#o.mode,
      ...(this.#terminalSeen ? {} : { protocol: { noTerminal: true } }),
      now: this.#o.now(),
    })
    this.#failWith(step, f)
    return step
  }

  // ---- records ----------------------------------------------------------------------------------------------------

  #runStep(): StepKey | undefined {
    const s = this.#o.step
    return s === 'heal' || s === 'catalog' ? undefined : s
  }

  #keepStray(line: string): void {
    this.#stray.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line)
    if (this.#stray.length > STRAY_MAX) this.#stray.splice(0, this.#stray.length - STRAY_MAX)
  }

  #textDelta(text: string, step: MuseStep): void {
    if (text === '') return
    this.#text += text
    this.#anyText = true
    step.events.push({ type: 'text', delta: text })
  }

  #modelConfigured(payload: Rec, step: MuseStep): void {
    const model = str(payload['model_id'])
    const own = this.#o.model
    // META_MODEL_USED: a pass that names no model learns which one Muse runs before the turn's output.
    if (
      this.#modelSent ||
      model === undefined ||
      model === '' ||
      (own !== undefined && own !== null && own !== '')
    )
      return
    this.#modelSent = true
    step.signals.push({ type: 'meta', key: META_MODEL_USED, value: { model } })
  }

  #taskLifecycle(kindFromType: string, payload: Rec, step: MuseStep): void {
    const event = rec(payload['event']) ?? {}
    const kind = str(event['kind']) ?? kindFromType
    const taskId = str(event['task_id']) ?? str(payload['task_id'])
    if (taskId === undefined || taskId === '') return
    if (kind === 'proposed') {
      const taskKind = str(event['task_kind']) ?? ''
      if (taskKind.startsWith(TOOL_TASK_PREFIX) && !this.#tasks.has(taskId)) {
        this.#tasks.set(taskId, {
          name: taskKind.slice(TOOL_TASK_PREFIX.length),
          started: false,
          ended: false,
          denied: false,
        })
      }
      return
    }
    if (kind === 'status') {
      const u = statusUsage(event)
      if (u !== undefined) this.#usage = this.#usage === undefined ? u : addUsage(this.#usage, u)
      // The context meter: the latest model call's prompt (its input, cached reads included). Muse names no window.
      const call = lastCallUsage(event)
      if (call !== undefined && call.input + (call.cacheRead ?? 0) > 0) {
        step.signals.push({
          type: 'context',
          used: call.input + (call.cacheRead ?? 0),
          ...(call.cacheRead !== undefined ? { cacheRead: call.cacheRead } : {}),
          source: 'request',
        })
      }
      return
    }
    const task = this.#tasks.get(taskId)
    if (task === undefined) return
    if (kind === 'scheduled') {
      const key = str(event['idempotency_key']) ?? ''
      if (key.startsWith(TOOL_KEY_PREFIX)) {
        const callId = key.slice(TOOL_KEY_PREFIX.length)
        task.callId = callId
        this.#callTask.set(callId, taskId)
        const early = this.#earlyResults.get(callId)
        if (early !== undefined) {
          this.#earlyResults.delete(callId)
          this.#applyResult(task, early)
        }
      }
      return
    }
    if (kind === 'side_effect_intent') {
      if (/^deny\b/i.test(str(event['policy_decision']) ?? '')) task.denied = true
      return
    }
    if (kind === 'started') {
      this.#toolStart(taskId, task, step)
      return
    }
    if (TASK_END_KINDS.has(kind)) {
      if (task.ended) return
      const reason = str(event['reason']) ?? ''
      const status: ToolStatus =
        kind === 'completed'
          ? this.#resultStatus(task)
          : kind === 'rejected' || task.denied || REFUSED.test(reason)
            ? 'declined'
            : 'failed'
      // A task refused before it started still gets its row, so the user sees what Muse could not do.
      if (!task.started) this.#toolStart(taskId, task, step)
      this.#toolEnd(taskId, task, status, step)
    }
  }

  #toolResult(payload: Rec): void {
    const callId = str(payload['call_id'])
    if (callId === undefined) return
    const taskId = this.#callTask.get(callId)
    const task = taskId !== undefined ? this.#tasks.get(taskId) : undefined
    if (task === undefined) {
      this.#earlyResults.set(callId, payload)
      return
    }
    this.#applyResult(task, payload)
  }

  #applyResult(task: ToolTask, payload: Rec): void {
    if (task.ended) return
    const outcome = str(rec(payload['correlation_facts'])?.['outcome'])
    if (outcome !== undefined) task.outcome = outcome
    const path = str(rec(payload['edit_facts'])?.['path'])
    if (path !== undefined && path !== '') task.path = path
  }

  /** A completed task: ok unless its tool.result said otherwise. */
  #resultStatus(task: ToolTask): ToolStatus {
    const outcome = task.outcome
    if (outcome === undefined || /^(?:success|ok|succeeded)$/i.test(outcome))
      return task.denied ? 'declined' : 'ok'
    return REFUSED.test(outcome) || task.denied ? 'declined' : 'failed'
  }

  #summary(task: ToolTask): string {
    return task.path !== undefined ? `${task.name} ${relativeTo(task.path, this.#o.cwd)}` : task.name
  }

  #toolStart(taskId: string, task: ToolTask, step: MuseStep): void {
    if (task.started) return
    task.started = true
    // The final answer is the text since the last tool event (`done.result`).
    this.#text = ''
    step.events.push({
      type: 'tool',
      id: taskId,
      name: task.name,
      summary: this.#summary(task),
      phase: 'start',
    })
  }

  #toolEnd(taskId: string, task: ToolTask, status: ToolStatus, step: MuseStep): void {
    task.ended = true
    this.#text = ''
    step.events.push({
      type: 'tool',
      id: taskId,
      name: task.name,
      summary: this.#summary(task),
      phase: 'end',
      status,
    })
  }

  #runTerminal(type: string, record: Rec, payload: Rec, step: MuseStep): void {
    this.#terminalSeen = true
    step.terminalRecord = true
    const u = museUsage(payload['usage'])
    if (u !== undefined) this.#terminalUsage = u
    const terminal = str(payload['terminal']) ?? type.slice(RUN_TERMINAL_PREFIX.length)
    if (terminal !== TERMINAL_COMPLETED) {
      // The reason is on the record and, once the process ends, on the last stderr line: the error waits for the exit
      // (the run stops a process that lingers).
      this.#evidence.push(record)
      return
    }
    const final = str(payload['text'])
    const result = final !== undefined && final.trim() !== '' ? final : this.#text
    // A run that streamed nothing still shows its answer once (never twice: deltas already printed it otherwise).
    if (!this.#anyText && result !== '') step.events.push({ type: 'text', delta: result })
    const usage = this.cumulativeUsage()
    this.#terminal = true
    step.events.push(usage !== undefined ? { type: 'done', result, usage } : { type: 'done', result })
  }

  #failWith(step: MuseStep, f: Failure): void {
    // An error result still bills: the engine adds it to the step's spend.
    const usage = this.cumulativeUsage()
    if (usage !== undefined) step.signals.push({ type: 'meta', key: META_USAGE, value: usage })
    this.#terminal = true
    step.events.push(errorEvent(f, true))
  }
}
