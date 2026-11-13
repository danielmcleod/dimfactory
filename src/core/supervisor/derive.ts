// Run status and phase derivation (the state machine's rules, first match wins; core only) and the views the
// renderer formats.
// Interpretation used throughout: run-level boundary work (`state.boundary`: waiting for S1 after Implement, the
// pre-review reconcile and the post-review snapshot around Review ∥ Critic, waiting for S2 after Fix) counts as its
// step running, so the phase never drops to `queued` between two steps (implementing → reviewing → findings-review
// → fixing). The plan-end guard after Plan (R4) counts as Plan running the same way (planning → plan-review).
// The views stay pure: what core knows beyond the state (the estimate frozen at run start, the adapters' mode copy)
// comes in as RunViewInputs.
import type { Percentiles, RunEstimate } from '../../shared/estimates.ts'
import type { AskDecision, AutoAnswerReason } from '../../shared/events.ts'
import { AGENT_STEPS, STEP_KEYS, TERMINAL_PASS_STATUSES, configPassOf } from '../../shared/run.ts'
import type {
  AskView,
  AutoAnsweredCounts,
  CardKind,
  CardView,
  ClarifyView,
  FindingCounts,
  FixLoopView,
  InputBytesBucket,
  PassStatus,
  RerunFromFix,
  RevertUndoView,
  RunPhase,
  RunSnapshot,
  RunStatus,
  RunSummary,
  ScanAuditView,
  ScanView,
  StepCost,
  StepKey,
  StepView,
  VerifyCommandView,
  VerifyStepView,
} from '../../shared/run.ts'
import type { Support } from '../../shared/vendors.ts'
import { modelOverrideIgnored, reportsModelBeforeTurn, supportsEffort } from '../../shared/vendors.ts'
import { runEta, stepEta } from '../estimates/eta.ts'
import { finalizeView, prepareView, worktreeSummary } from './isolation-view.ts'
import { carriedFindings, rerunFromFixView } from './rerun.ts'
import type { SessionCapabilities } from './sessions.ts'
import type { EtaStep, RunEta } from '../estimates/eta.ts'
import { fixSummary, withoutFixReport } from '../findings/parse.ts'
import type { Finding, RevertRecord, RunState, StepSpend, StepState, VerifyRoundState } from './types.ts'
import {
  acceptanceOn,
  clarifyOn,
  deployOn,
  explainOn,
  fixLoopOn,
  fixRoundsMax,
  recheckAll,
  researchOn,
  securityOn,
  stepPassConfig,
} from './step-use.ts'
import type { ResearchView } from '../../shared/research.ts'
import type { DeployRunView } from '../../shared/deploy.ts'
import { acceptanceView } from './acceptance-view.ts'
import { buildContextHealth } from '../context/health.ts'
import { contextSummary, contextView } from '../context/state.ts'

/** The run is over (the end panel shows): completed, failed or cancelled. */
export function isRunOver(status: RunState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** What the views need beyond the run state (app-core supplies them). */
export interface RunViewInputs {
  /** The estimate frozen at run start (runs/<id>/estimate.json): StepView.eta, RunSummary.progress.etaMs. */
  estimate?: RunEstimate | null
  /** `adapter.support(need)` per pass step: StepView.modeCopy, the only source of mode copy. */
  modeCopy?: Partial<Record<StepKey, Support>>
  /**
   * Live balanced run: per pass step that names no model and still expects one (awaitsModelWord), the model core
   * expects it to run (what its estimate is priced at): StepView.expectedModel, set only while the step's view reads
   * model null.
   */
  expectedModel?: Partial<Record<StepKey, string>>
  /**
   * The resume capabilities of the run's Fix vendor as its probe reports them now (what a Re-run from Fix would
   * record and decide its session with): RunSnapshot.rerunFromFix's model rule. Absent: unknown.
   */
  fixCapabilities?: SessionCapabilities
}

/** Per-step extras of toStepView. */
export interface StepViewInputs {
  eta?: Percentiles
  modeCopy?: Support
}

export function isTerminalPassStatus(s: PassStatus): boolean {
  return (TERMINAL_PASS_STATUSES as readonly PassStatus[]).includes(s)
}

/** A process exists or is expected for these. */
export function isLiveStatus(s: PassStatus): boolean {
  return s === 'running' || s === 'waiting' || s === 'stalled'
}

/**
 * Live balanced run: whether a pass that names no model still names the model core expects
 * (StepView.expectedModel): while it is queued, and once it runs (a pause included) only on a route whose vendor says
 * which model it runs before its turn (reportsModelBeforeTurn: Codex's app-server, Claude's stdio; `route` is the
 * step's, else the vendor's probed one) until it has said so in this spawn, a model or none (StepState.modelUsed,
 * modelUnreported).
 * A pass that has ended, or runs where its vendor never says (Codex exec, Gemini), expects nothing: its card
 * reads "default model" unless its vendor said what ran.
 */
export function awaitsModelWord(st: StepState, route: string | undefined): boolean {
  if (st.status === 'queued') return true
  if (!isLiveStatus(st.status) && st.status !== 'paused') return false
  if (st.modelUsed !== undefined || st.modelUnreported === true) return false
  return reportsModelBeforeTurn(route)
}

export function anyLiveProc(s: RunState): boolean {
  return STEP_KEYS.some((k) => s.steps[k].proc?.live === true)
}

export function liveProcSteps(s: RunState): StepKey[] {
  return STEP_KEYS.filter((k) => s.steps[k].proc?.live === true)
}

/**
 * A verify round is running its commands (until its result answers, a cancelled one included), or the security
 * scan its audits.
 */
export function verifyRoundInFlight(s: RunState): boolean {
  return Object.values(s.requests).some((r) => r.kind === 'verify' || r.kind === 'scan')
}

/** An isolated run's dependency install is running (until its result answers, a cancelled one included). */
export function installInFlight(s: RunState): boolean {
  return Object.values(s.requests).some((r) => r.kind === 'prepare' && r.stage === 'install')
}

/**
 * R4's plan-end guard in flight: the snapshot that checks whether Plan changed files (it waits for `run-start`,
 * or runs), or Revert Plan's changes. Live balanced run: Claude's native plan writes its plan file with Write,
 * so every such Plan takes this check, and the run read `queued` between Plan's end and the plan gate.
 */
function planEndInFlight(s: RunState): boolean {
  const p = s.flow.planEnd
  return p === 'wait' || p === 'requested' || p === 'reverting'
}

/** Status counting boundary work (and the plan-end guard, for Plan) as the owning step running. */
function effective(s: RunState, k: StepKey): PassStatus {
  // Test-first's steps in a run without it are never used (they stay queued with no events): skipped.
  if ((k === 'tests' || k === 'verify:red') && s.config.testFirst !== true) return 'skipped'
  // The security advisor's steps in a run without it: never used (Fix until green uses the re-check on its own).
  if ((k === 'scan' || k === 'security') && !securityPassOn(s)) return 'skipped'
  if (k === 'recheck' && !securityPassOn(s) && !recheckAll(s)) return 'skipped'
  // Clarify in a run without it: never used.
  if (k === 'clarify' && !clarifyOn(s)) return 'skipped'
  // Research in a run without it: never used.
  if (k === 'research' && !researchOn(s)) return 'skipped'
  // The Deploy step in a run without it: never used.
  if (k === 'deploy' && !deployOn(s)) return 'skipped'
  // The acceptance review and Explain in a run without them: never used.
  if (k === 'acceptance' && !acceptanceOn(s)) return 'skipped'
  if (k === 'explain' && !explainOn(s)) return 'skipped'
  if (s.boundary?.step === k) return 'running'
  if (k === 'plan' && planEndInFlight(s) && s.steps.plan.status === 'done') return 'running'
  return s.steps[k].status
}

/** The security advisor is on for this run (step-use.ts securityOn; a run.json from before it has none). */
function securityPassOn(s: RunState): boolean {
  return securityOn(s)
}

const ALL_DONE: readonly PassStatus[] = ['done', 'skipped']

/** Run status derivation. */
export function deriveStatus(s: RunState): RunStatus {
  if (s.stop) return 'cancelled'
  // A completed run stays completed. A later apply or undo of its isolated copy (the Diff tab) changes only
  // its finalize view, never the run's status (the same way a stopped run stays cancelled).
  if (s.endedAt !== undefined && s.outcome !== undefined) return 'completed'
  const statuses = STEP_KEYS.map((k) => effective(s, k))
  if (statuses.every((x) => ALL_DONE.includes(x)) && s.cards.length === 0) return 'completed'
  if (s.cards.length > 0 || statuses.some((x) => x === 'waiting' || x === 'stalled')) return 'waiting'
  if (statuses.some((x) => x === 'running')) return 'running'
  if (statuses.some((x) => x === 'paused')) return 'paused'
  if (statuses.some((x) => x === 'failed')) return 'failed'
  return 'queued'
}

const PHASE_OWNED_CARDS: readonly CardKind[] = [
  'clarify',
  'research',
  'gate:afterPlan',
  'insufficientContext',
  'gate:beforeFix',
  'finalize',
  'finalizeConflicts',
  'interruptedApply',
]

/** Run phase derivation. A pending ask keeps its step's phase. */
export function derivePhase(s: RunState, status: RunStatus = deriveStatus(s)): RunPhase {
  const open = (...kinds: CardKind[]): boolean => s.cards.some((c) => kinds.includes(c.view.kind))
  const is = (k: StepKey, ...st: PassStatus[]): boolean => st.includes(effective(s, k))
  if (s.stop && (anyLiveProc(s) || verifyRoundInFlight(s) || installInFlight(s))) return 'stopping'
  if (status === 'completed' || status === 'cancelled') return 'done'
  if (open('clarify')) return 'clarifying'
  if (open('research')) return 'research-review'
  if (open('gate:afterPlan', 'insufficientContext')) return 'plan-review'
  if (open('gate:beforeFix')) return 'findings-review'
  if (open('finalize', 'finalizeConflicts', 'interruptedApply')) return 'ready-to-apply'
  if (
    s.cards.some((c) => c.view.blocking && !PHASE_OWNED_CARDS.includes(c.view.kind)) ||
    STEP_KEYS.some((k) => is(k, 'paused', 'failed', 'stalled'))
  ) {
    return 'needs-attention'
  }
  if (is('preflight', 'running')) return 'preflight'
  // Finalize without its card (the preview, an apply waiting for the folder or writing it, a deferred discard)
  // is still the run's apply stage.
  if (is('finalize', 'running', 'waiting')) return 'ready-to-apply'
  if (is('explain', 'running', 'waiting')) return 'explaining'
  if (is('deploy', 'running', 'waiting')) return 'deploying'
  if (is('fix', 'running', 'waiting')) return 'fixing'
  if (is('recheck', 'running', 'waiting')) return securityPassOn(s) ? 'security-recheck' : 'rechecking'
  if (is('verify:2', 'running')) return 'final-verify'
  if (
    is('review', 'running', 'waiting') ||
    is('critic', 'running', 'waiting') ||
    is('security', 'running', 'waiting') ||
    is('scan', 'running', 'waiting')
  )
    return 'reviewing'
  if (is('acceptance', 'running', 'waiting')) return 'accepting'
  if (is('verify:1', 'running')) return 'verifying'
  if (is('implement', 'running', 'waiting')) return 'implementing'
  if (is('verify:red', 'running')) return 'verifying'
  if (is('tests', 'running', 'waiting')) return 'writing-tests'
  if (is('plan', 'running', 'waiting')) return 'planning'
  if (is('research', 'running', 'waiting')) return 'researching'
  if (is('clarify', 'running', 'waiting')) return 'clarifying'
  if ((is('prepare', 'running') || is('verify:0', 'running')) && isTerminalPassStatus(s.steps.plan.status)) {
    return 'preparing'
  }
  return 'queued'
}

// ---- views -------------------------------------------------------------------------------------------------

/** Running + stalled time over every attempt up to `at` (the stored figure plus the open segment). */
export function activeMsAt(st: StepState, at?: number): number {
  return (
    st.activeMs + (st.activeSince !== undefined && at !== undefined ? Math.max(0, at - st.activeSince) : 0)
  )
}

/**
 * The current (final) attempt's running + stalled time up to `at`: StepView / RunSummaryStep `activeMs`, the
 * estimates' samples and the live ETA (final attempt only; a failed attempt's time is not the step's).
 */
export function attemptActiveMsAt(st: StepState, at?: number): number {
  return Math.max(0, activeMsAt(st, at) - (st.attemptActiveFrom ?? 0))
}

export function toStepView(st: StepState, at?: number, inputs?: StepViewInputs): StepView {
  const activeMs = attemptActiveMsAt(st, at)
  const v: StepView = { key: st.key, status: st.status, attempt: st.attempt, activeMs }
  if (st.reason !== undefined) v.reason = st.reason
  if (st.pause !== undefined) v.pause = st.pause
  if (st.startedAt !== undefined) v.startedAt = st.startedAt
  if (st.endedAt !== undefined) v.endedAt = st.endedAt
  if (inputs?.eta !== undefined) v.eta = inputs.eta
  if (st.vendor !== undefined) v.vendor = st.vendor
  if (st.model !== undefined) v.model = st.model
  if (st.effort !== undefined) v.effort = st.effort
  if (st.modelUsed !== undefined) v.modelUsed = st.modelUsed
  if (st.modelReplaced !== undefined) v.modelReplaced = st.modelReplaced
  if (st.modelAsked !== undefined && st.modelUsed === undefined) v.modelAsked = st.modelAsked
  if (st.modelRerouted !== undefined && st.modelUsed !== undefined) v.modelRerouted = st.modelRerouted
  if (st.mode !== undefined) v.mode = st.mode
  if (inputs?.modeCopy !== undefined) v.modeCopy = inputs.modeCopy
  if (st.planMode !== undefined) v.planMode = st.planMode
  if (st.planFallbackReason !== undefined) v.planFallbackReason = st.planFallbackReason
  if (st.sessionNote !== undefined) v.sessionNote = st.sessionNote
  if (st.sessionNote !== undefined && st.freshDetail !== undefined) v.freshDetail = st.freshDetail
  if (st.route !== undefined) v.route = st.route
  if (st.usage !== undefined) {
    v.usage = st.usage
    if (st.usageApprox === true) v.usageApprox = true
    v.cost = stepCost(st)
  }
  const context = contextView(st.context)
  if (context !== undefined) v.context = context
  if (st.failure !== undefined && (st.status === 'failed' || st.status === 'cancelled'))
    v.failure = st.failure
  // Live balanced run: the vendor did not run the account's default Dim Factory sent in place of its own settings'
  // model (its refusal names that model, not the default): the view names what ran, never the default. Also the
  // default asked for and never confirmed (modelAsked; a run recorded before modelAsked existed kept it as the model
  // used). A turn
  // the vendor rerouted ran its own model (modelUsed), not the folder's.
  const sent = st.modelAsked ?? st.modelUsed
  if (
    st.modelReplaced !== undefined &&
    st.modelRerouted === undefined &&
    sent !== undefined &&
    modelOverrideIgnored({ modelUsed: sent, modelReplaced: st.modelReplaced, failure: v.failure })
  ) {
    v.modelUsed = st.modelReplaced
    v.modelOverrideIgnored = sent
    delete v.modelReplaced
    delete v.modelAsked
    delete v.modelRerouted
  }
  if (st.autoAnswered !== undefined) v.autoAnswered = { ...st.autoAnswered }
  if (st.chip !== undefined) v.chip = st.chip
  // The AI diagnosis and the wait_until retry (healId and auto are core's bookkeeping).
  if (st.heal !== undefined) {
    const { healId: _id, ...heal } = st.heal
    v.heal = heal
  }
  if (st.wait !== undefined) {
    const { auto: _auto, ...wait } = st.wait
    v.wait = wait
  }
  // A verify round's commands with their statuses and results (the round's bookkeeping stays core's).
  if (st.verify !== undefined) v.verify = verifyStepView(st.verify)
  return v
}

/** StepView.verify of a round (verify results): the commands in configured order. */
export function verifyStepView(r: VerifyRoundState): VerifyStepView {
  const view: VerifyStepView = {
    commands: r.commands.map((c) => {
      const out: VerifyCommandView = { name: c.name, argv: [...c.argv], status: c.status }
      if (c.exitCode !== undefined) out.exitCode = c.exitCode
      if (c.durationMs !== undefined) out.durationMs = c.durationMs
      if (c.excerpt !== undefined && c.excerpt !== '') out.excerpt = c.excerpt
      if (c.reason !== undefined && c.reason !== '') out.reason = c.reason
      if (c.scenarios !== undefined) out.scenarios = c.scenarios.map((x) => ({ ...x }))
      return out
    }),
  }
  if (r.aborted === true) view.aborted = true
  return view
}

/** A revert core made for a card choice (RunSnapshot.revertUndo), not one the user asked for or an undo. */
export const isCardRevert = (rec: RevertRecord): boolean =>
  rec.why === 'plan' || rec.why === 'retry' || rec.why === 'restore'

/**
 * RunSnapshot.revertUndo: the latest card revert (not a diff.revert) that can still be undone, or a diff.revert
 * that Dim Factory's closing interrupted (its toast never came). None once it is undone, still running, or a later
 * pass changed one of its paths (`stale`; core still checks each path if an older toast's Undo is pressed).
 */
export function revertUndoView(s: RunState): RevertUndoView | undefined {
  const reverts = s.git?.reverts ?? []
  for (let i = reverts.length - 1; i >= 0; i--) {
    const r = reverts[i]
    if (r === undefined) continue
    if (!isCardRevert(r) && !(r.why === 'user' && r.interrupted === true)) continue
    if (r.undone === true || r.stale === true || r.pending === true) return undefined
    return { undoToken: r.token, label: r.what ?? r.label, files: r.paths.length, at: r.at }
  }
  return undefined
}

/**
 * Count one `auto-answered` answer on its step (StepView.autoAnswered, "AUTO approved N"). Allows are approved,
 * the rest denied; the native plan's capture (`why: 'plan-capture'`) is how the plan is taken, not a denial.
 */
export function addAutoAnswered(st: StepState, decision: AskDecision, why: AutoAnswerReason): void {
  if (why === 'plan-capture') return
  const c = st.autoAnswered ?? { approved: 0, denied: 0 }
  if (why === 'project-permission') c.project = (c.project ?? 0) + 1
  else if (decision === 'allow' || decision === 'allow-session') c.approved += 1
  else c.denied += 1
  st.autoAnswered = c
}

/** Count one ask Auto approved after a switch to Auto (`ask-resolved` `by: 'auto'`) on its step ("AUTO approved N"). */
export function addAutoApproved(st: StepState): void {
  const c = st.autoAnswered ?? { approved: 0, denied: 0 }
  c.approved += 1
  st.autoAnswered = c
}

/** The run's auto-answered asks over every step (RunSnapshot.autoAnswered); undefined while none. */
export function runAutoAnswered(s: RunState): AutoAnsweredCounts | undefined {
  let any = false
  const total: AutoAnsweredCounts = { approved: 0, denied: 0 }
  for (const k of STEP_KEYS) {
    const c = s.steps[k].autoAnswered
    if (c === undefined) continue
    any = true
    total.approved += c.approved
    total.denied += c.denied
    if (c.project !== undefined) total.project = (total.project ?? 0) + c.project
  }
  return any ? total : undefined
}

/**
 * The cost of the step's usage: as frozen at `done` (`StepState.cost`), else the vendor-reported figure;
 * none when the usage is only approximate (meta usageApprox).
 */
export function stepCost(st: StepState): StepCost {
  if (st.cost !== undefined) return { ...st.cost }
  const usd = st.usageApprox === true ? undefined : st.usage?.costUsd
  return usd !== undefined
    ? { usd, basis: 'vendor', apiEquivalent: false }
    : { usd: null, basis: 'none', apiEquivalent: false }
}

/** `RunSummary.steps[].inBytesBucket`: prompt size < 10 KB, < 50 KB, < 150 KB, ≥ 150 KB. */
export function inBytesBucket(bytes: number): InputBytesBucket {
  const KB = 1024
  if (bytes < 10 * KB) return 0
  if (bytes < 50 * KB) return 1
  if (bytes < 150 * KB) return 2
  return 3
}

/** Pending asks of every step, in FIFO order per step. */
export function toAskViews(s: RunState): AskView[] {
  const out: AskView[] = []
  for (const k of STEP_KEYS) {
    const st = s.steps[k]
    st.asks.forEach((a, i) => {
      const v: AskView = {
        runId: s.runId,
        step: k,
        attempt: st.attempt,
        requestId: a.requestId,
        vendor: st.vendor ?? s.config.passes.implement.vendor,
        kind: a.kind,
        detail: a.detail,
        expiresAt: a.expiresAt,
        allowSession: a.allowSession,
        queue: { index: i + 1, total: st.asks.length },
      }
      if (a.reason !== undefined) v.reason = a.reason
      if (a.defaultToNo !== undefined) v.defaultToNo = a.defaultToNo
      if (a.pendingDeny) v.pendingDenyUntil = a.pendingDeny.until
      out.push(v)
    })
  }
  return out
}

export function toCardViews(s: RunState): CardView[] {
  return s.cards.map((c) => c.view)
}

/**
 * What the step spent over all its attempts (`StepState.spent`). A state written before `spent` existed
 * falls back to its last usage and cost. Undefined while nothing was reported.
 */
export function stepSpend(st: StepState): StepSpend | undefined {
  if (st.spent !== undefined) return st.spent
  const u = st.usage
  if (u === undefined) return undefined
  const c = stepCost(st)
  return {
    tokens: u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    usd: c.usd,
    bases: c.usd !== null ? [c.basis] : [],
    apiEquivalent: c.usd !== null && c.apiEquivalent,
    approx: st.usageApprox === true,
    spawnNo: st.spawnNo,
  }
}

/** Every step's spend, every attempt (RunSummary.progress.tokens, the CLI footer's Tokens line). */
export function totalTokens(s: RunState): number {
  let n = 0
  for (const k of STEP_KEYS) n += stepSpend(s.steps[k])?.tokens ?? 0
  return n
}

/** Every priced attempt's cost (RunSummary.progress.costUsd); null when nothing was priced. */
export function totalCost(s: RunState): number | null {
  let usd = 0
  let any = false
  for (const k of STEP_KEYS) {
    const c = stepSpend(s.steps[k])?.usd ?? null
    if (c !== null) {
      usd += c
      any = true
    }
  }
  return any ? Math.round(usd * 1e10) / 1e10 : null
}

/**
 * The run's last word to the person who asked: the summary Fix wrote for them (under its Summary heading), else
 * Implement's closing reply, else whatever Fix said besides its report lines. Fix's `F<n> fixed` lines are for the
 * engine, never this. Paths into the folder the run worked in (the run's folder, or its isolated copy) read relative
 * to the project. Undefined when no pass said anything.
 */
export function closingMessage(
  s: Pick<RunState, 'steps'> & Partial<Pick<RunState, 'folder' | 'isolation'>>,
): string | undefined {
  const said = closingText(s)
  return said !== undefined ? projectRelativePaths(said, workRoots(s)) : undefined
}

function closingText(s: Pick<RunState, 'steps'>): string | undefined {
  const fix = s.steps.fix.result
  const own = fix !== undefined ? fixSummary(fix) : undefined
  if (own !== undefined) return own
  const implement = s.steps.implement.result?.trim() ?? ''
  if (implement !== '') return implement
  const rest = fix !== undefined ? withoutFixReport(fix) : ''
  return rest !== '' ? rest : undefined
}

/** The folders a pass worked in, most specific first: the run's folder inside its isolated copy, then the run's folder. */
function workRoots(s: Partial<Pick<RunState, 'folder' | 'isolation'>>): string[] {
  const roots: string[] = []
  const wt = s.isolation?.worktree
  if (wt !== undefined && wt.path !== '') {
    const rel = wt.rel ?? ''
    roots.push(rel !== '' ? `${wt.path.replace(/[\\/]+$/, '')}/${rel}` : wt.path)
  }
  if (s.folder !== undefined && s.folder !== '') roots.push(s.folder)
  return roots
}

/**
 * `text` with every absolute path under one of `roots` made relative to that root (`/`-separated; the root itself
 * reads `.`). Catches the forms a builder writes: `C:\x\y`, `C:/x/y`, `/C:/x/y` (a Markdown link) and `file:///...`.
 * A drive-letter root matches without regard to case, as Windows paths do.
 */
export function projectRelativePaths(text: string, roots: readonly string[]): string {
  const sep = String.raw`[\\/]+`
  // What ends a path in prose: whitespace, a Markdown link's or code span's closing mark, a quote.
  const stop = String.raw`\s)\]>"'\x60`
  let out = text
  for (const root of roots) {
    const parts = root
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .split('/')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (parts.every((p) => p === '')) continue
    const drive = /^[A-Za-z]:$/.test(parts[0] ?? '')
    const lead = drive ? '(?:file:///|/)?' : '(?:file://)?'
    // The root, then the rest of the path; the root alone must end there (`work` is not `work2`).
    const re = new RegExp(
      `${lead}${parts.join(sep)}(?:${sep}([^${stop}]*))?(?![^${stop}\\\\/.,;:!?])`,
      drive ? 'gi' : 'g',
    )
    out = out.replace(re, (_m, rest: string | undefined) => {
      const r = (rest ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
      return r === '' ? '.' : r
    })
  }
  return out
}

/**
 * Findings found so far: the merged list once Review ∥ Critic joined (R8), else what each finished reviewer
 * reported (a failed reviewer keeps none).
 */
export function findingCounts(s: RunState): FindingCounts {
  const fs = s.findings
  if (fs === undefined) return { must: 0, should: 0 }
  const all =
    fs.list.length > 0
      ? fs.list
      : (['review', 'critic'] as const).flatMap((k) =>
          s.steps[k].status === 'done' ? (fs.sources[k]?.findings ?? []) : [],
        )
  const must = all.filter((f) => f.severity === 'must').length
  return { must, should: all.length - must }
}

/**
 * The findings Fix addresses (`{{findings}}`): the selection, in list order (must first, F1…). In a later round of
 * Fix until green, what the last round left open (by F-number).
 */
export function selectedFindings(s: RunState): Finding[] {
  const fs = s.findings
  if (fs === undefined) return []
  const targets = s.fixLoop !== undefined && s.fixLoop.round > 1 ? s.fixLoop.targets : undefined
  if (targets !== undefined) {
    const want = new Set(targets)
    return fs.list.filter((f) => want.has(f.n))
  }
  const want = new Set(fs.selected)
  return fs.list.filter((f) => want.has(f.id))
}

/** RunSnapshot.fixLoop: Fix until green's rounds (a round the run's Stop cut short reads stopped). */
export function fixLoopView(s: RunState): FixLoopView | undefined {
  const loop = s.fixLoop
  if (loop === undefined) return undefined
  const cfg = s.config.fixLoop
  const view: FixLoopView = {
    max: fixRoundsMax(s),
    round: loop.round,
    rounds: loop.rounds.map((r) => ({
      n: r.n,
      status: r.status === 'running' && s.stop !== undefined ? 'stopped' : r.status,
      ...(r.changed !== undefined ? { changed: r.changed } : {}),
      ...(r.failing !== undefined ? { failing: [...r.failing] } : {}),
      resolved: [...r.resolved],
      open: [...r.open],
      usd: r.usd,
      activeMs: r.activeMs,
      ...(r.views !== undefined ? { views: structuredClone(r.views) } : {}),
    })),
  }
  if (loop.stop !== undefined) view.stop = { ...loop.stop }
  if (cfg?.maxUsd !== undefined || cfg?.maxMinutes !== undefined) {
    view.budget = {
      ...(cfg.maxUsd !== undefined ? { usd: cfg.maxUsd } : {}),
      ...(cfg.maxMinutes !== undefined ? { minutes: cfg.maxMinutes } : {}),
    }
  }
  return view
}

/** StepView.research: the run's lenses, then Research's cited answer and what was kept for Plan. */
export function researchView(s: RunState): ResearchView | undefined {
  const cfg = s.config.research
  if (cfg === undefined) return undefined
  const r = s.research
  const v: ResearchView = {
    status: r?.status ?? 'pending',
    lenses: cfg.lenses.map((l) => ({ id: l.id, label: l.label, web: l.web })),
    web: cfg.web,
  }
  if (r === undefined) return v
  if (r.result !== undefined) v.result = structuredClone(r.result)
  if (r.chosen !== undefined) v.chosen = [...r.chosen]
  if (r.answers !== undefined) v.answers = { ...r.answers }
  if (r.auto === true) v.auto = true
  if (r.note !== undefined) v.note = r.note
  return v
}

/** StepView.deploy: the Deploy step's plan (class, target, files) and the files it wrote. */
export function deployView(s: RunState): DeployRunView | undefined {
  if (!deployOn(s)) return undefined
  const d = s.deploy
  if (d === undefined) return undefined
  const p = d.plan
  const v: DeployRunView = {
    phase: d.phase,
    files: (p?.files ?? []).map((f) => ({ ...f })),
    present: [...(p?.present ?? [])],
    env: [...(p?.env ?? [])],
  }
  if (p !== undefined) v.cls = { ...p.cls }
  if (p?.target !== undefined && p.target !== null) v.target = { ...p.target }
  if (d.written !== undefined) v.written = [...d.written]
  if (d.note !== undefined) v.note = d.note
  return v
}

/** StepView.clarify: Clarify's questions and the answers given. */
export function clarifyView(s: RunState): ClarifyView | undefined {
  const c = s.clarify
  if (c === undefined) return undefined
  const v: ClarifyView = {
    status: c.status,
    questions: c.questions.map((q) => ({ ...q, options: [...q.options] })),
  }
  if (c.answers !== undefined) v.answers = [...c.answers]
  if (c.note !== undefined) v.note = c.note
  return v
}

/**
 * The run's live ETA from the frozen estimate (estimates/eta.ts) over each step's final attempt; undefined without
 * an estimate and outside queued/running/waiting.
 */
export function runEtaOf(
  s: RunState,
  estimate: RunEstimate | null | undefined,
  at?: number,
): RunEta | undefined {
  if (estimate === null || estimate === undefined) return undefined
  const steps: Partial<Record<StepKey, EtaStep>> = {}
  for (const k of STEP_KEYS) {
    const st = s.steps[k]
    // Without a reference time the open segment is not counted, so nothing counts down.
    steps[k] = {
      status: st.status,
      activeMs: attemptActiveMsAt(st, at),
      active: at !== undefined && st.activeSince !== undefined,
    }
  }
  return runEta(estimate, steps, s.status)
}

/**
 * RunSummary.progress.etaMs from the frozen estimate; undefined without one, outside queued/running/waiting, and
 * while a live step runs longer than usual (past its p80).
 */
export function runEtaMs(
  s: RunState,
  estimate: RunEstimate | null | undefined,
  at?: number,
): number | undefined {
  return runEtaOf(s, estimate, at)?.remainingMs
}

/** runs/index.jsonl row. `etaMs` comes from `inputs.estimate`; pinning is filled by its owner. */
export function toRunSummary(s: RunState, at?: number, inputs?: RunViewInputs): RunSummary {
  const summary: RunSummary = {
    runId: s.runId,
    displayNo: s.displayNo,
    folder: s.folder,
    folderKey: s.folderKey,
    title: s.title,
    status: s.status,
    phase: s.phase,
    profile: s.profile,
    auto: s.config.auto,
    isolation: s.config.isolation,
    pinned: false,
    createdAt: s.createdAt,
    progress: { tokens: totalTokens(s), costUsd: totalCost(s), filesChanged: s.diffStats?.files ?? 0 },
    findings: findingCounts(s),
    steps: STEP_KEYS.filter((k) => s.steps[k].attempt > 0).map((k) => {
      const st = s.steps[k]
      const v = toStepView(st, at)
      const row: RunSummary['steps'][number] = { key: k, status: st.status, activeMs: v.activeMs }
      if (st.vendor !== undefined) row.vendor = st.vendor
      if (st.model !== undefined) row.model = st.model
      if (st.effort !== undefined) row.effort = st.effort
      if (st.mode !== undefined) row.mode = st.mode
      if (st.planMode !== undefined) row.planMode = st.planMode
      if (st.usage !== undefined) {
        row.usage = st.usage
        if (st.usageApprox === true) row.usageApprox = true
        row.costBasis = stepCost(st).basis
      }
      if (st.inBytes !== undefined) row.inBytesBucket = inBytesBucket(st.inBytes)
      if (st.failure !== undefined && st.status === 'failed') row.failureCategory = st.failure.category
      const context = contextSummary(st.context)
      if (context !== undefined) row.context = context
      return row
    }),
  }
  if (s.outcome !== undefined) summary.outcome = s.outcome
  if (s.failure !== undefined) summary.failure = s.failure
  if (s.endedAt !== undefined) summary.endedAt = s.endedAt
  if (s.lock !== 'none') summary.lock = s.lock
  if (s.recipe !== undefined) summary.recipe = s.recipe
  // The run this one re-runs ("Re-run of #N"), and what Re-run from Fix of it would do (the Runs history row).
  if (s.rerunOf !== undefined) {
    summary.rerunOf = { runId: s.rerunOf.runId, displayNo: s.rerunOf.displayNo, from: s.rerunOf.from }
  }
  if (s.matchOf !== undefined) {
    summary.matchOf = {
      matchId: s.matchOf.matchId,
      side: s.matchOf.side,
      ...(s.matchOf.rematch === true ? { rematch: true as const } : {}),
    }
  }
  summary.rerunFromFix = rerunFromFixOf(s, inputs)
  // Fix until green: rounds run, the cap, and why it stopped (the Runs history's "Completed with failures · …").
  if (fixLoopOn(s)) {
    const loop = s.fixLoop
    summary.fixLoop = {
      rounds: loop?.rounds.length ?? 0,
      max: fixRoundsMax(s),
      ...(loop?.stop !== undefined ? { stop: loop.stop.reason } : {}),
    }
  }
  // The project's quality gates as the run ended (the Runs history's "Completed with failures · quality gates: …").
  if (s.gates !== undefined)
    summary.gates = { passed: [...s.gates.passed], failed: s.gates.failed.map((f) => ({ ...f })) }
  // An isolated run's worktree (the Dashboard chip "Isolated: not applied").
  const wt = worktreeSummary(s)
  if (wt !== undefined) summary.worktree = wt
  const eta = runEtaOf(s, inputs?.estimate, at)
  if (eta !== undefined) {
    summary.progress.etaState = eta.state
    if (eta.remainingMs !== undefined) {
      summary.progress.etaMs = eta.remainingMs
      if (eta.countsDown && at !== undefined) summary.progress.etaEndsAt = at + eta.remainingMs
    }
  }
  return summary
}

/** RunSnapshot / RunSummary `rerunFromFix`, with the Fix vendor's capabilities when core knows them. */
function rerunFromFixOf(s: RunState, inputs: RunViewInputs | undefined): RerunFromFix {
  return rerunFromFixView(
    s,
    inputs?.fixCapabilities !== undefined ? { capabilities: inputs.fixCapabilities } : {},
  )
}

/** RunSnapshot.rerunFromFix with the findings Re-run from Fix offers (only while it is available). */
function withCarriedFindings(v: RerunFromFix, s: RunState): RerunFromFix {
  return v.available ? { ...v, findings: structuredClone(carriedFindings(s)) } : v
}

/** StepView.scan: the security scan's facts (never a full secret: only their masked prefix is kept). */
export function scanView(s: RunState): ScanView | undefined {
  const sc = s.security?.scan
  if (sc === undefined) return undefined
  return {
    phase: sc.phase,
    secrets: sc.secrets.map((x) => ({ ...x })),
    audits: sc.audits.map((a): ScanAuditView => {
      const v: ScanAuditView = { name: a.name, argv: [...a.argv], status: a.status }
      if (a.reason !== undefined) v.reason = a.reason
      if (a.introduced !== undefined) v.introduced = a.introduced
      if (a.existing !== undefined) v.existing = a.existing
      return v
    }),
    advisories: sc.advisories.map((x) => ({ ...x })),
    existing: sc.existing,
    notes: [...sc.notes],
  }
}

/** `runs.get`. `lastSeq` is the bus's. */
export function toRunSnapshot(
  s: RunState,
  lastSeq: number,
  at?: number,
  inputs?: RunViewInputs,
): RunSnapshot {
  const stepInputs = (k: StepKey): StepViewInputs | undefined => {
    if (inputs === undefined) return undefined
    const eta = stepEta(inputs.estimate, k)
    const modeCopy = inputs.modeCopy?.[k]
    return { ...(eta !== undefined ? { eta } : {}), ...(modeCopy !== undefined ? { modeCopy } : {}) }
  }
  const steps = Object.fromEntries(
    STEP_KEYS.map((k) => [k, toStepView(s.steps[k], at, stepInputs(k))]),
  ) as Record<StepKey, StepView>
  // A pass that has not spawned yet shows what it is configured to run with (the run's resolved config), so a
  // queued card names its vendor, model and mode next to the mode copy core already computed from the same config.
  // Live balanced run: so does a pass whose launch is under way (it has begun, nothing spawned yet: its preflight
  // and start snapshot), which spawns with the same config; else its vendor, model and mode would read "Not recorded"
  // between its queued row and its spawn (the Config tab), and its card's chips would appear only at the spawn.
  for (const k of AGENT_STEPS) {
    const v = steps[k]
    // The Tests step runs on Implement's config (and only in a Test-first run); the security re-check on the
    // Security pass's (only when the advisor is on).
    if (k === 'tests' && s.config.testFirst !== true) continue
    if (k === 'security' && !securityPassOn(s)) continue
    if (k === 'recheck' && !securityPassOn(s) && !recheckAll(s)) continue
    if (k === 'clarify' && !clarifyOn(s)) continue
    if (k === 'research' && !researchOn(s)) continue
    if (k === 'deploy' && !deployOn(s)) continue
    if (k === 'acceptance' && !acceptanceOn(s)) continue
    if (k === 'explain' && !explainOn(s)) continue
    const cfg = stepPassConfig(s, k)
    const launching = v.attempt > 0 && s.steps[k].spawnNo === 0
    if (v.vendor !== undefined || !cfg.enabled || (v.status !== 'queued' && !launching)) continue
    v.vendor = cfg.vendor
    v.model = cfg.model
    if (cfg.effort !== undefined && cfg.effort !== null && supportsEffort(cfg.vendor)) v.effort = cfg.effort
    v.mode = cfg.mode
  }
  // Live balanced run: a pass that names no model names the model core expects it to run while it still awaits its
  // vendor's word (app-core, awaitsModelWord): queued (the Config tab), and from its start until Codex says which model
  // runs, so its card's model chip and its Config row do not change when the vendor confirms the model.
  for (const k of AGENT_STEPS) {
    const v = steps[k]
    const expected = inputs?.expectedModel?.[k]
    if (expected !== undefined && expected !== '' && v.model === null) v.expectedModel = expected
  }
  // A verify round the run's config runs is `planned` while it waits, so its timeline node is there
  // from the start (a round is only settled skipped by P2 when Implement or Fix ends).
  for (const [k, after] of [
    ['verify:1', 'implement'],
    ['verify:2', 'fix'],
  ] as const) {
    const v = steps[k]
    if (v.status !== 'queued' || v.attempt !== 0) continue
    if (s.config.verify.enabled && s.config.verify.runAfter.includes(after) && s.config.passes[after].enabled)
      v.planned = true
  }
  // Test-first: the Tests step and its red check are planned from the start (their nodes never appear mid-row).
  if (s.config.testFirst === true) {
    const t = steps.tests
    if (t.status === 'queued' && t.attempt === 0 && s.config.passes.implement.enabled) t.planned = true
    const red = steps['verify:red']
    if (red.status === 'queued' && red.attempt === 0 && s.config.verify.enabled) red.planned = true
    const v1 = steps['verify:1']
    if (v1.status === 'queued' && v1.attempt === 0 && s.config.verify.enabled) v1.planned = true
    const tf = s.testFirst
    if (tf !== undefined) {
      t.testFirst = {
        files: [...tf.files],
        ...(tf.guard !== undefined ? { guard: tf.guard === 'requested' ? 'checking' : tf.guard } : {}),
        ...(tf.guard === 'weakened' ? { weakened: tf.findings?.length ?? 0 } : {}),
      }
    }
  }
  // The security advisor: its scan and re-check are planned from the start (their nodes never appear mid-row), and
  // their facts are on their steps.
  if (securityPassOn(s)) {
    for (const k of ['scan', 'recheck'] as const) {
      const v = steps[k]
      if (v.status === 'queued' && v.attempt === 0) v.planned = true
    }
    const scan = scanView(s)
    if (scan !== undefined) steps.scan.scan = scan
    const rc = s.security?.recheck
    if (rc !== undefined) {
      steps.recheck.recheck = {
        status: rc.status,
        resolved: [...rc.resolved],
        open: rc.open.map((o) => ({ ...o })),
      }
    }
  }
  // Fix until green: its re-check is planned from the start too (the advisor's case is above), and Fix, verify:2
  // and the re-check say which round they are in.
  if (recheckAll(s) && !securityPassOn(s)) {
    const v = steps.recheck
    if (v.status === 'queued' && v.attempt === 0 && s.config.passes.fix.enabled) v.planned = true
  }
  if (recheckAll(s)) {
    const rc = s.security?.recheck
    if (rc !== undefined && steps.recheck.recheck === undefined) {
      steps.recheck.recheck = {
        status: rc.status,
        resolved: [...rc.resolved],
        open: rc.open.map((o) => ({ ...o })),
      }
    }
  }
  const loop = s.fixLoop
  if (fixLoopOn(s) && loop !== undefined) {
    const round = { n: loop.round, of: fixRoundsMax(s) }
    for (const k of ['fix', 'verify:2', 'recheck'] as const) steps[k].round = { ...round }
  }
  // Clarify: planned from the start when the run will ask (its node never appears mid-row), and its questions.
  if (clarifyOn(s)) {
    const v = steps.clarify
    const asks = s.config.passes.plan.enabled && (!s.config.auto || s.config.clarify?.inAuto === true)
    if (v.status === 'queued' && v.attempt === 0 && asks) v.planned = true
    const c = clarifyView(s)
    if (c !== undefined) v.clarify = c
  }
  // Research: planned from the start (its node never appears mid-row), its lenses from the start, then its answer.
  if (researchOn(s)) {
    const v = steps.research
    if (v.status === 'queued' && v.attempt === 0 && s.config.passes.plan.enabled) v.planned = true
    const rv = researchView(s)
    if (rv !== undefined) v.research = rv
  }
  // The Deploy step: planned from the start (its node never appears mid-row), then its plan and what it wrote.
  if (deployOn(s)) {
    const v = steps.deploy
    if (v.status === 'queued' && v.attempt === 0 && s.config.passes.implement.enabled) v.planned = true
    const dv = deployView(s)
    if (dv !== undefined) v.deploy = dv
  }
  // The acceptance review and Explain: planned from the start (their nodes never appear mid-row) when a pass they run on
  // is on; the acceptance checklist on its step and on the snapshot.
  if (acceptanceOn(s)) {
    const v = steps.acceptance
    if (v.status === 'queued' && v.attempt === 0 && passEnabled(s, 'acceptance')) v.planned = true
  }
  if (explainOn(s)) {
    const v = steps.explain
    if (v.status === 'queued' && v.attempt === 0 && passEnabled(s, 'explain')) v.planned = true
  }
  const acceptance = acceptanceView(s)
  if (acceptance !== undefined && acceptanceOn(s)) steps.acceptance.acceptance = acceptance
  // An isolated run's prepare rows (from its start), and the baseline and finalize nodes it will run planned from
  // its start too, so the timeline never inserts a node mid-row.
  const prep = prepareView(s)
  if (prep !== undefined) {
    steps.prepare.prepare = prep
    const v0 = steps['verify:0']
    if (v0.status === 'queued' && v0.attempt === 0 && s.config.verify.enabled && s.config.verify.baseline)
      v0.planned = true
    const fz = steps.finalize
    if (fz.status === 'queued' && fz.attempt === 0) fz.planned = true
  }
  const fin = finalizeView(s)
  if (fin !== undefined) steps.finalize.finalize = fin
  // R2: Plan's launch waits for the run-start snapshot before it spawns (minutes for a cold shadow on a large
  // folder), and the step says so meanwhile instead of reading as a vendor CLI starting.
  if (s.steps.plan.launch !== undefined && s.flow.runStart === 'requested')
    steps.plan.launchWait = 'run-start'
  const snap: RunSnapshot = {
    summary: toRunSummary(s, at, inputs),
    steps,
    asks: toAskViews(s),
    cards: toCardViews(s),
    allowRules: s.allowRules,
    notes: s.notes,
    // Re-run from Fix: available or why not, how its Fix would start, and the
    // findings its picker offers: core's list, also when the run's Review/Critic join never ran (no findings.json).
    rerunFromFix: withCarriedFindings(rerunFromFixOf(s, inputs), s),
    lastSeq,
  }
  snap.guardrails = {
    rules: s.config.guardrailRules ?? 0,
    fired: s.guardrails?.fired ?? 0,
    undone: s.guardrails?.undone ?? 0,
    stopped: s.guardrails?.stopped ?? false,
    ...(s.guardrails?.blocked !== undefined ? { blocked: s.guardrails.blocked } : {}),
  }
  const auto = runAutoAnswered(s)
  if (auto !== undefined) snap.autoAnswered = auto
  // Context health once the run is over (the end panel's section; runs/<id>/context-health.json holds the same).
  if (isRunOver(s.status)) {
    const health = buildContextHealth(s, inputs?.estimate)
    if (health !== undefined) snap.contextHealth = health
  }
  if (s.branch !== undefined) snap.branch = { ...s.branch }
  if (fin !== undefined) snap.finalize = fin
  const undo = revertUndoView(s)
  if (undo !== undefined) snap.revertUndo = undo
  const rounds = fixLoopView(s)
  if (rounds !== undefined) {
    // An earlier round's frozen views read as the live steps did when the round ended: the same mode copy (the
    // machine keeps the views without it). Without it, round 1's Fix and Re-check cards lost their mode-copy line the
    // moment round 2 began, and everything under them moved up on its own.
    for (const r of rounds.rounds) {
      const v = r.views
      if (v === undefined) continue
      for (const [view, k] of [
        [v.fix, 'fix'],
        [v.verify, 'verify:2'],
        [v.recheck, 'recheck'],
      ] as const) {
        const copy = inputs?.modeCopy?.[k]
        if (view.modeCopy === undefined && copy !== undefined) view.modeCopy = copy
      }
    }
    snap.fixLoop = rounds
  }
  if (acceptance !== undefined) snap.acceptance = acceptance
  // Adaptive depth (read defensively: a hand-made state may leave its config out).
  const depth = (s as Partial<RunState>).config?.depth
  if (depth !== undefined) snap.depth = { ...depth }
  const wrong = s.findings?.wrong
  if (wrong !== undefined && wrong.disputed.length > 0)
    snap.findingsWrong = { disputed: wrong.disputed.length, wrong: wrong.wrong.length }
  return snap
}

/** The pass a step runs on is on in this run's config. */
function passEnabled(s: RunState, k: 'acceptance' | 'explain'): boolean {
  return s.config.passes[configPassOf(k, s.config.passes)].enabled
}
