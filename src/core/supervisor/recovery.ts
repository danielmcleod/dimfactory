// Startup recovery (boot step 6, crash relaunch, P24):
//   for every run that is not completed or cancelled
//     - bring run.json up to the event log when it is behind (`projectFromLog`)
//     - live work (a running/stalled step, a step waiting on an ask, a launch or request in flight, a process
//       recorded alive, an owed end snapshot) → `relaunch`: orphan sweep, `interrupted` snapshot, the steps
//       become paused(interrupted). NEVER auto-resume.
//     - otherwise a lock-holding run (waiting on a card — retryPartial included —, paused, failed) keeps its lock
//     - queued runs are left as they are (re-queued when resumed)
// Armed `wait_until` timers come back disarmed: the relaunch clears every timer.
import type { FindingsFile } from '../../shared/findings.ts'
import type { CardView, RunEnvelope, RunSummary, StepKey } from '../../shared/run.ts'
import { STEP_KEYS, configPassOf, isAgentStep, isStepKey } from '../../shared/run.ts'
import { parseFindings } from '../findings/parse.ts'
import { newContextState } from '../context/state.ts'
import type { RunTextOutput } from '../home.ts'
import type { Logger } from '../log.ts'
import { addAutoAnswered, addAutoApproved, deriveStatus, isTerminalPassStatus } from './derive.ts'
import type { RunController, RunDoc } from './controller.ts'
import { REVIEWER_PASSES, addSpend, isMutatingStep, isReviewerStep, stepIsActive } from './machine.ts'
import type { AskState, CardState, FindingsState, ReviewerPass, RunState } from './types.ts'

export interface RecoveredRun {
  runId: string
  displayNo: number
  /** Steps that became paused(interrupted). */
  steps: StepKey[]
}

export interface RecoveryReport {
  /** Runs whose live work was interrupted by the previous process ending (now paused). */
  paused: RecoveredRun[]
  /** Runs whose folder lock was restored (waiting on a card, paused or failed). */
  holders: string[]
  /** Runs left queued by the previous process (re-queued on resume). */
  queued: string[]
  /** Runs whose run.json was behind events.jsonl and was brought up to date. */
  projected: string[]
  errors: { runId: string; message: string }[]
}

export function emptyRecoveryReport(): RecoveryReport {
  return { paused: [], holders: [], queued: [], projected: [], errors: [] }
}

/**
 * True when a relaunch reduction is needed: a process the previous instance recorded as alive (whatever its
 * step's status, so orphans are always swept), live work of a non-terminal step (the reducer's P24 condition; a
 * launch parked on its retryPartial card is not), outstanding requests, an end snapshot still owed by a finished
 * mutating pass, or a cancelled run that still holds its lock.
 */
export function needsRelaunch(state: RunState): boolean {
  if (state.stop !== undefined && state.lock === 'held') return true
  if (Object.keys(state.requests).length > 0) return true
  if (state.flow.runStart === 'requested') return true
  if (finalizeWorkPending(state)) return true
  // An end-of-pass check the user asked to redo, with no card left to answer (the relaunch asks again).
  const reconcileCardOpen = state.cards.some((c) => c.view.kind === 'reconcile')
  if (!reconcileCardOpen && state.stop === undefined && state.outcome === undefined) {
    if (state.steps.implement.endCheck === 'hold' || state.steps.fix.endCheck === 'hold') return true
  }
  return STEP_KEYS.some((k) => {
    const st = state.steps[k]
    if (st.proc?.live === true) return true
    if (isMutatingStep(k) && st.status === 'done' && st.endSnapStatus === 'requested') return true
    return !isTerminalPassStatus(st.status) && stepIsActive(st)
  })
}

/**
 * R12: finalize work of the dead instance (a preview, an apply or undo waiting for the folder or writing it, a
 * deferred discard whose timer died with it), also on a run that has finished: the relaunch asks again, or opens
 * interruptedApply (never auto-resumed).
 */
export function finalizeWorkPending(state: RunState): boolean {
  const f = state.isolation?.finalize
  if (f === undefined) return false
  return (
    f.op !== undefined ||
    f.state === 'preview' ||
    f.state === 'applying' ||
    f.state === 'undoing' ||
    f.state === 'discarding'
  )
}

/**
 * A run.json state as a new controller should load it. A `suspendedAt` read from disk was written by an earlier
 * process that ended while the machine slept (say the battery ran out in S3). This process starts awake, and its
 * power router drops a resume that follows no suspend. A kept mark would therefore hold every stall, hard and ask
 * timer until the next real sleep, so it is dropped. A run with live work is relaunched, which clears it as well;
 * any other run has no inactivity timer armed, so its next transition arms them as usual.
 */
export function withoutStaleSuspend(state: RunState): RunState {
  if (state.suspendedAt === undefined) return state
  const next = { ...state }
  delete next.suspendedAt
  return next
}

/**
 * Chaos: finalize work an index summary shows on its way (a preview, an apply, an undo or a discard of a run that
 * may already have finished): boot recovery looks at such a run however the index lists its status, so the relaunch
 * finishes it or opens interruptedApply (finalizeWorkPending).
 */
export function summaryWorkPending(s: RunSummary): boolean {
  const w = s.worktree?.state
  return w === 'preview' || w === 'waiting' || w === 'applying' || w === 'undoing' || w === 'discarding'
}

/**
 * Chaos: the index fields a reader relies on (the Dashboard, Runs history, boot recovery's own filter), compared
 * with what run.json says now. A Dim Factory killed between a run's transition and its index write leaves the index a
 * step behind; recovery writes the line it never wrote when these differ.
 */
export function summaryStale(indexed: RunSummary | undefined, fresh: RunSummary): boolean {
  if (indexed === undefined) return true
  const key = (s: RunSummary): string =>
    JSON.stringify([s.status, s.phase, s.outcome, s.endedAt, s.lock, s.failure, s.worktree])
  return key(indexed) !== key(fresh)
}

/** completed / cancelled runs need nothing. */
export function isFinishedState(state: RunState): boolean {
  const s = deriveStatus(state)
  return s === 'completed' || s === 'cancelled'
}

function cardStep(card: CardView): StepKey | undefined {
  if (card.kind === 'gate:afterPlan' || card.kind === 'insufficientContext') return 'plan'
  if (card.kind === 'preflight') return 'preflight'
  const p = card.payload
  if (p !== null && typeof p === 'object' && 'step' in p) {
    const step = (p as { step?: unknown }).step
    if (isStepKey(step)) return step
  }
  return undefined
}

export interface ProjectOptions {
  /** plan.md as on disk now: used when the projected bodies include an `output` for `plan`. */
  planText?: string | null
  /** plan.original.md as on disk now (an edited plan's original). */
  planOriginal?: string | null
  /** review.md / critic.md as on disk now: used when the projected bodies include their `output`. */
  reviewerText?: Partial<Record<ReviewerPass, string | null>>
  /** findings.json as on disk now: used when the projected bodies include an `output` for `findings`. */
  findings?: FindingsFile | null
}

/**
 * Recovery: "projectFromLog(bodies) rebuilds statuses, sessions and cards when run.json is behind the log".
 * Applies the persisted bodies with seq > the run.json checkpoint onto a copy of its state. Process handles,
 * timers and request ids of the dead instance are not reconstructed (the relaunch reduction re-issues work from the
 * state). The reducer's private state the bodies imply is: `flow.prepared` (a passed preflight in place), the
 * plan decision and text (plan step, gate / insufficient-context cards, plan.md), the end snapshot a finished
 * mutating pass still owes (`endSnapStatus: 'requested'`), pending asks, a Stop (`stop`), the R2b lock release,
 * and the Review ∥ Critic flow, the gate before Fix / Fix underway, the joined findings and selection
 * (findings.json) and an unanswered findings parse (review.md / critic.md).
 */
export function projectFromLog(
  state: RunState,
  envelopes: readonly RunEnvelope[],
  o: ProjectOptions = {},
): RunState {
  const s = structuredClone(state)
  let planTouched = false
  let planOutput = false
  let planOriginalOutput = false
  let gateResolved = false
  const reviewSeen: ReviewSeen = { reviewerOutput: new Set(), findingsOutput: false, touched: false }
  for (const env of envelopes) {
    const b = env.body
    switch (b.t) {
      case 'step-status': {
        const st = s.steps[b.step]
        const was = st.status
        if (b.step === 'plan') planTouched = true
        if (isReviewerStep(b.step) || b.step === 'fix') reviewSeen.touched = true
        // P15: a mutating pass that went done owes its end snapshot (its result is not in the log).
        if (isMutatingStep(b.step) && b.status === 'done' && was !== 'done') {
          st.endSnapStatus = 'requested'
          delete st.endSnap
        }
        if (b.step === 'preflight' && b.status === 'done' && s.config.isolation === 'inPlace') {
          s.flow.prepared = 'all'
        }
        if (b.step === 'prepare' && b.status === 'done') s.flow.prepared = 'all'
        // R2/R2b: preflight runs once the lock is granted; the lock is released while preflight is failed and
        // requested again by Recheck (preflight queued until the grant).
        if (b.step === 'preflight') {
          if (b.status === 'running' && s.lock === 'requested') s.lock = 'held'
          else if (b.status === 'failed' && s.lock === 'held') s.lock = 'none'
          else if (b.status === 'queued' && was === 'failed' && s.lock === 'none') s.lock = 'requested'
        }
        st.status = b.status
        // A later attempt in the log: its active time starts from what run.json recorded (the log has no timings).
        if (b.attempt > st.attempt && st.attempt > 0) st.attemptActiveFrom = st.activeMs
        st.attempt = Math.max(st.attempt, b.attempt)
        if (b.reason !== undefined) st.reason = b.reason
        else delete st.reason
        if (b.pause !== undefined) st.pause = b.pause
        else delete st.pause
        if (b.sessionNote !== undefined) {
          st.sessionNote = b.sessionNote
          if (b.freshDetail !== undefined) st.freshDetail = b.freshDetail
          else delete st.freshDetail
        }
        if (b.route !== undefined) st.route = b.route
        if (b.argv !== undefined) st.argv = b.argv
        if (b.planMode !== undefined) st.planMode = b.planMode
        if (b.planFallbackReason !== undefined) st.planFallbackReason = b.planFallbackReason
        // Every step-status carries the step's model used while it has one (machine.ts emitStepStatus): a body without
        // it is a later spawn whose vendor has not said (yet).
        if (b.modelUsed !== undefined) st.modelUsed = b.modelUsed
        else delete st.modelUsed
        if (b.modelReplaced !== undefined) st.modelReplaced = b.modelReplaced
        else delete st.modelReplaced
        if (b.modelAsked !== undefined) st.modelAsked = b.modelAsked
        else delete st.modelAsked
        if (b.modelRerouted !== undefined) st.modelRerouted = b.modelRerouted
        else delete st.modelRerouted
        if (b.status === 'running' && st.startedAt === undefined) st.startedAt = env.ts
        if (isTerminalPassStatus(b.status) || b.status === 'failed') st.endedAt = env.ts
        break
      }
      case 'run-status':
        s.status = b.status
        s.phase = b.phase
        if (b.outcome !== undefined) {
          s.outcome = b.outcome
          // R12: an isolated run's outcome is fixed before finalize; it ends only once finalize is over.
          if (b.status === 'completed' || b.status === 'cancelled') s.endedAt ??= env.ts
        }
        // A finished run has no boundary work left (R6 cleared it before completing).
        if (b.status === 'completed' || b.status === 'cancelled') delete s.boundary
        if (b.status === 'cancelled' && s.stop === undefined) {
          // R13: a held lock is released after the `stopped` snapshot; a queued run left the queue at once.
          s.stop = {
            at: env.ts,
            by: 'stop',
            snapshot: s.lock === 'held' && s.flow.runStart !== 'none' ? 'todo' : 'none',
          }
          if (s.lock === 'requested') s.lock = 'none'
          s.endedAt ??= env.ts
        }
        break
      case 'card': {
        s.cards = s.cards.filter((c) => c.view.id !== b.card.id)
        if (b.state === 'open') {
          const c: CardState = { view: b.card, openedAt: env.ts }
          const step = cardStep(b.card)
          if (step !== undefined) c.step = step
          s.cards.push(c)
        }
        if (b.card.kind === 'gate:afterPlan' || b.card.kind === 'insufficientContext') planTouched = true
        if (b.card.kind === 'gate:afterPlan' && b.state === 'resolved') gateResolved = true
        // R4: the plan-end guard is over once its card was answered or the gate opened.
        if (
          (b.card.kind === 'planMutated' && b.state === 'resolved') ||
          (b.card.kind === 'gate:afterPlan' && s.flow.planEnd !== undefined)
        ) {
          s.flow.planEnd = 'done'
        }
        if (b.card.kind === 'planMutated') planTouched = true
        if (b.card.kind === 'gate:beforeFix' || b.card.kind === 'emptyFindings') reviewSeen.touched = true
        if (b.state === 'resolved' && b.card.kind === 'insufficientContext') delete s.plan.insufficient
        break
      }
      case 'ev':
        if (b.ev.type === 'session' && isAgentStep(b.step)) {
          const st = s.steps[b.step]
          st.sessionId = b.ev.id
          s.sessions[b.ev.id] ??= {
            vendor: st.vendor ?? s.config.passes[configPassOf(b.step, s.config.passes)].vendor,
            step: b.step,
          }
        }
        if (b.ev.type === 'ask' && isAgentStep(b.step)) {
          // So the relaunch resolves it (`ask-resolved` by stop) like the asks run.json knew about.
          const st = s.steps[b.step]
          const ev = b.ev
          if (!st.asks.some((a) => a.requestId === ev.requestId)) {
            const ask: AskState = {
              requestId: ev.requestId,
              kind: ev.kind,
              detail: ev.detail,
              expiresAt: ev.expiresAt,
              allowSession: ev.allowSession,
              raisedAt: env.ts,
            }
            st.asks.push(ask)
          }
        }
        break
      case 'guardrail': {
        const tally = (s.guardrails ??= { fired: 0, undone: 0, stopped: false })
        tally.fired++
        if (b.undone) tally.undone++
        if (b.blocked === true) tally.blocked = (tally.blocked ?? 0) + 1
        else if (b.finding.onBreak === 'stop') tally.stopped = true
        break
      }
      case 'output':
        s.outputs[b.file] = Math.max(s.outputs[b.file] ?? 0, b.version)
        if (b.file === 'plan') planOutput = true
        if (b.file === 'plan.original') planOriginalOutput = true
        if (b.file === 'review' || b.file === 'critic') {
          reviewSeen.reviewerOutput.add(b.file)
          reviewSeen.touched = true
        }
        if (b.file === 'findings') {
          reviewSeen.findingsOutput = true
          reviewSeen.touched = true
        }
        break
      case 'usage': {
        const st = s.steps[b.step]
        // The catalog figure itself is not in the log; its basis is.
        const usd = b.costBasis === 'vendor' ? (b.usage.costUsd ?? null) : null
        const cost = { usd, basis: b.costBasis, apiEquivalent: st.cost?.apiEquivalent ?? false }
        // Each body is one `done` after the run.json checkpoint: it adds to the step's spend.
        addSpend(st, null, b.usage, cost)
        st.usage = b.usage
        st.cost = cost
        break
      }
      case 'context': {
        // The meter as last announced (the detectors' counters live in run.json alone).
        const st = s.steps[b.step]
        const cs = st.context ?? newContextState()
        if (b.used !== undefined) cs.used = b.used
        if (b.window !== undefined && cs.vendorWindow === undefined && cs.facts?.window !== b.window)
          cs.vendorWindow = b.window
        if (b.percent !== undefined) cs.peakPercent = Math.max(cs.peakPercent ?? 0, b.percent)
        cs.compactions = Math.max(cs.compactions, b.compactions)
        cs.compacting = b.compacting
        st.context = cs
        break
      }
      case 'snag':
        s.steps[b.step].failure = b.failure
        s.steps[b.step].snagOpen = true
        s.failure = { step: b.step, category: b.failure.category }
        break
      case 'diff-stats':
        s.diffStats = { files: b.files, added: b.added, deleted: b.deleted, live: b.live }
        break
      case 'ask-resolved':
        if (isAgentStep(b.step)) {
          const st = s.steps[b.step]
          st.asks = st.asks.filter((a) => a.requestId !== b.requestId)
          // An ask Auto approved after a switch to Auto counts for "AUTO approved N" as the reducer counted it.
          if (b.by === 'auto') addAutoApproved(st)
        }
        break
      case 'ask-extended':
        // A sleep moved the ask's expiry.
        if (isAgentStep(b.step)) {
          const ask = s.steps[b.step].asks.find((a) => a.requestId === b.requestId)
          if (ask !== undefined) ask.expiresAt = b.expiresAt
        }
        break
      case 'auto-answered':
        // "AUTO approved N" counts every auto-answered ask, also those after the run.json checkpoint.
        addAutoAnswered(s.steps[b.step], b.decision, b.why)
        break
    }
  }
  if (planTouched || planOutput) projectPlan(s, { planOutput, planOriginalOutput, gateResolved }, o)
  if (reviewSeen.touched) projectReview(s, reviewSeen, o)
  return s
}

interface ReviewSeen {
  /** review / critic outputs among the projected bodies. */
  reviewerOutput: Set<ReviewerPass>
  /** A findings.json version among the projected bodies (written at the R8 join and by the R9 gate). */
  findingsOutput: boolean
  /** Any reviewer or Fix body (the steps, their cards and outputs) was projected. */
  touched: boolean
}

/**
 * R6–R11 state the bodies imply (the reducer re-derives the rest on relaunch): the Review ∥ Critic flow, the gate
 * before Fix or Fix underway, the joined findings and selection (findings.json), and a reviewer whose output was
 * written but whose parse never answered (its text from review.md / critic.md, parsed again by the relaunch).
 */
function projectReview(s: RunState, seen: ReviewSeen, o: ProjectOptions): void {
  const reviewers = REVIEWER_PASSES.filter((k) => s.steps[k].status !== 'queued')
  const ran = reviewers.some((k) => s.steps[k].status !== 'skipped')
  const gate = s.cards.some((c) => c.view.kind === 'gate:beforeFix')
  if (ran && (s.flow.review === undefined || s.flow.review === 'reconcile')) {
    s.flow.review = 'running'
    if (s.boundary?.name === 'pre-review') delete s.boundary
  }
  const file = o.findings
  if (seen.findingsOutput && file !== undefined && file !== null && Array.isArray(file.findings)) {
    const fs: FindingsState = s.findings ?? { sources: {}, list: [], selected: [], notes: [] }
    fs.list = structuredClone(file.findings)
    fs.selected = fs.list.filter((f) => file.selected[f.id] === true).map((f) => f.id)
    for (const k of REVIEWER_PASSES) {
      const p = file.sources[k]
      if (p === undefined) continue
      fs.sources[k] = {
        status: p.status,
        attempt: s.steps[k].attempt,
        findings: fs.list.filter((f) => f.source === k),
      }
    }
    s.findings = fs
    // findings.json is first written at the R8 join.
    s.flow.review = 'joined'
    if (s.boundary?.name === 'post-review') delete s.boundary
  }
  if (gate) {
    s.flow.review = 'joined'
    s.flow.fix = 'gate'
  } else if (s.steps.fix.status !== 'queued' && s.steps.fix.status !== 'skipped') {
    s.flow.review = 'joined'
    s.flow.fix = 'started'
  }
  for (const k of REVIEWER_PASSES) {
    const st = s.steps[k]
    const text = o.reviewerText?.[k]
    if (!seen.reviewerOutput.has(k) || text === undefined || text === null) continue
    const src = s.findings?.sources[k]
    if (st.status === 'running' && st.launch === undefined) {
      // P15 wrote the output; the parse request died with the old process: the relaunch asks again.
      st.result = text
      s.findings ??= { sources: {}, list: [], selected: [], notes: [] }
      s.findings.sources[k] = {
        status: 'parsing',
        attempt: st.attempt,
        findings: [],
        ...(src?.emptyOutputs !== undefined ? { emptyOutputs: src.emptyOutputs } : {}),
      }
    } else if (st.status === 'done' && (src === undefined || src.status === 'parsing')) {
      // The parse answered but run.json missed it: parse the same output again (pure, deterministic).
      const parsed = parseFindings(text, k)
      s.findings ??= { sources: {}, list: [], selected: [], notes: [] }
      s.findings.sources[k] = {
        status: parsed.parse.status === 'empty' ? 'none' : parsed.parse.status,
        attempt: st.attempt,
        findings: parsed.findings,
        ...(parsed.parse.status === 'empty' ? { treatedAsNone: true } : {}),
      }
    }
  }
}

/** The plan decision (R3/R4/P23) implied by the projected plan step and its cards; the text comes from plan.md. */
function projectPlan(
  s: RunState,
  seen: { planOutput: boolean; planOriginalOutput: boolean; gateResolved: boolean },
  o: ProjectOptions,
): void {
  const st = s.steps.plan
  const open = (kind: CardView['kind']): boolean => s.cards.some((c) => c.view.kind === kind)
  if (st.status === 'skipped' || (st.status === 'done' && st.reason === 'proceeded without a plan')) {
    s.plan = { decided: true, text: null, edited: false }
    return
  }
  if (open('insufficientContext')) {
    s.plan = {
      decided: false,
      text: null,
      edited: false,
      ...(s.plan.insufficient !== undefined ? { insufficient: s.plan.insufficient } : {}),
    }
    return
  }
  if (st.status !== 'done') return
  if (seen.planOutput && o.planText !== undefined && o.planText !== null) {
    s.plan.text = o.planText
    if (!seen.planOriginalOutput && !s.plan.edited) s.plan.original = o.planText
  }
  if (seen.planOriginalOutput) {
    s.plan.edited = true
    if (o.planOriginal !== undefined && o.planOriginal !== null) s.plan.original = o.planOriginal
  }
  // R4: decided once approved, or at once without the gate (Auto, or `afterPlan` off). Never while the plan-end
  // guard is open (planMutated, or its snapshot or revert in flight); with the gate, only once it was answered (it
  // opens after the guard). An undecided plan without its card takes the guard and the gate again (machine advance).
  const guardOpen = open('planMutated') || (s.flow.planEnd !== undefined && s.flow.planEnd !== 'done')
  const gated = s.config.gates.afterPlan && !s.config.auto
  s.plan.decided = !open('gate:afterPlan') && !guardOpen && (!gated || seen.gateResolved || s.plan.decided)
}

export interface RecoveryDeps {
  /** Run ids worth checking (not known to be completed or cancelled). */
  candidates(): Promise<string[]>
  /** run.json (null when missing, corrupt or written by a newer Dim Factory). */
  readDoc(runId: string): Promise<RunDoc | null>
  /** Envelopes after `sinceSeq` from events.jsonl. */
  readLog(runId: string, sinceSeq: number): Promise<{ envelopes: RunEnvelope[]; lastSeq: number }>
  /** A run's plan.md / plan.original.md / review.md / critic.md (null when missing); used when the log is ahead. */
  readText?(runId: string, file: RunTextOutput): Promise<string | null>
  /** A run's findings.json (null when missing or unreadable); used when the log is ahead of run.json. */
  readFindings?(runId: string): Promise<FindingsFile | null>
  /** Load a run into a live controller (registers a held lock with the scheduler). */
  attach(runId: string, doc: RunDoc): Promise<RunController>
  /** Register a run's held folder lock without loading it. */
  restoreHolder(doc: RunDoc): void
  log: Logger
  /** How long to wait for the sweep and the `interrupted` snapshot per run (default 30 s). */
  settleMs?: number
}

/** Boot recovery. Never throws; per-run problems land in `errors`. */
export async function recoverRuns(d: RecoveryDeps): Promise<RecoveryReport> {
  const report = emptyRecoveryReport()
  let ids: string[]
  try {
    ids = await d.candidates()
  } catch (err) {
    report.errors.push({ runId: '*', message: err instanceof Error ? err.message : String(err) })
    return report
  }
  for (const runId of ids) {
    try {
      let doc = await d.readDoc(runId)
      if (doc === null) continue
      const log = await d.readLog(runId, doc.lastSeq)
      if (log.envelopes.length > 0) {
        const wrote = (file: string): boolean =>
          log.envelopes.some((e) => e.body.t === 'output' && e.body.file === file)
        const opts: ProjectOptions = {}
        if (d.readText !== undefined && wrote('plan')) opts.planText = await d.readText(runId, 'plan')
        if (d.readText !== undefined && wrote('plan.original'))
          opts.planOriginal = await d.readText(runId, 'plan.original')
        for (const k of REVIEWER_PASSES) {
          if (d.readText === undefined || !wrote(k)) continue
          opts.reviewerText = { ...opts.reviewerText, [k]: await d.readText(runId, k) }
        }
        if (d.readFindings !== undefined && wrote('findings')) opts.findings = await d.readFindings(runId)
        doc = { ...doc, state: projectFromLog(doc.state, log.envelopes, opts), lastSeq: log.lastSeq }
        report.projected.push(runId)
      }
      const state = doc.state
      if (!state.started) continue
      // A run cancelled before its `stopped` snapshot finished still holds the lock: the relaunch finishes it.
      if (
        isFinishedState(state) &&
        !(state.stop !== undefined && state.lock === 'held') &&
        !finalizeWorkPending(state)
      )
        continue
      if (needsRelaunch(state)) {
        const before = STEP_KEYS.filter((k) => !isTerminalPassStatus(state.steps[k].status))
        const c = await d.attach(runId, doc)
        await c.enqueue({ t: 'relaunch' })
        await c.settle(d.settleMs ?? 30_000)
        const steps = before.filter(
          (k) => c.state.steps[k].status === 'paused' && c.state.steps[k].pause === 'interrupted',
        )
        if (steps.length > 0) report.paused.push({ runId, displayNo: state.displayNo, steps })
        continue
      }
      if (state.lock === 'held') {
        d.restoreHolder(doc)
        report.holders.push(runId)
      } else if (state.lock === 'requested') {
        report.queued.push(runId)
      }
    } catch (err) {
      d.log.error('run recovery failed', { runId, err })
      report.errors.push({ runId, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}
