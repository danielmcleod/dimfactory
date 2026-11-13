// Human and JSON output for the dev CLI: a bus sink that streams one run's events, and the end-of-run footer.
//   human (default): pass headers, streamed text (Review ∥ Critic line by line with a label, since they run at
//                    the same time), tool lines, findings, snags, notes
//   --json:          the run's envelopes as NDJSON on stdout, byte-identical to events.jsonl lines
import { isPlaytestArgv } from '../shared/playtest.ts'
import { NO_RUN_COST, noRunCost } from '../shared/cost-text.ts'
import type { CostBasis } from '../shared/estimates.ts'
import type { FixStopReason, Mode, RunEnvelope, RunEventBody, RunStatus, StepKey } from '../shared/run.ts'
import { STEP_KEYS } from '../shared/run.ts'
import type { BusSink } from '../core/bus/bus.ts'
import { parseFixReport } from '../core/findings/parse.ts'
import { categoryTitle } from '../core/heal/categories.ts'
import { stepLabel } from '../core/supervisor/cards.ts'
import { findingCounts, stepSpend } from '../core/supervisor/derive.ts'
import { fixRoundsMax } from '../core/supervisor/step-use.ts'
import type { RunState, StepState } from '../core/supervisor/types.ts'
import { acceptanceView } from '../core/supervisor/acceptance-view.ts'
import { ACCEPTANCE_STATUS_LABEL, acceptanceSummaryText } from '../shared/acceptance.ts'
import type { CliIo } from './io.ts'

/** The events.jsonl line for an envelope (`{seq,ts,body}`, same key order as the bus writer). */
export function envelopeLine(env: RunEnvelope): string {
  return JSON.stringify({ seq: env.seq, ts: env.ts, body: env.body })
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

const VENDOR_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  grok: 'Grok',
  muse: 'Muse',
}

/** The product name of a vendor id ("Claude Code"), for failure titles. */
export function vendorName(vendor: string | undefined): string {
  return vendor === undefined ? 'The vendor' : (VENDOR_NAMES[vendor] ?? vendor)
}

const OUTCOME_TEXT: Record<string, string> = {
  fixed: 'Fixed',
  clean: 'Clean',
  'no-changes': 'No changes made',
  'findings-open': 'Findings open',
  'verify-failed': 'Completed with failures',
  'security-open': 'Completed with failures',
  'fix-stopped': 'Completed with failures',
  'gates-failed': 'Completed with failures',
  failed: 'Failed',
}

const STATUS_TEXT: Record<RunStatus, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting for you',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

const MODE_TEXT: Record<Mode, string> = {
  readonly: 'read-only',
  autoedit: 'edits files',
  full: 'full access',
}

/** Why Fix did not run, as the footer says it. */
/** Fix until green's stop reasons, as the completed line says them. */
const FIX_STOP_WORDS: Readonly<Record<FixStopReason, string>> = {
  green: 'green',
  cap: 'round cap reached',
  budget: 'budget reached',
  'no-progress': 'no progress',
}

/** " (round 2 of 3)" for Fix, verify:2 and the re-check in a later round of Fix until green; '' otherwise. */
function roundTag(state: RunState | undefined, step: StepKey): string {
  const loop = state?.fixLoop
  if (state === undefined || loop === undefined || loop.round <= 1) return ''
  if (step !== 'fix' && step !== 'verify:2' && step !== 'recheck') return ''
  return ` (round ${loop.round} of ${fixRoundsMax(state)})`
}

/** "Fix rounds: 2 of 3 · round 1: F1 resolved, F2 still open · round 2: green". */
function roundsLine(state: RunState): string | undefined {
  const loop = state.fixLoop
  if (loop === undefined) return undefined
  const parts = loop.rounds.map((r) => {
    const bits: string[] = []
    if (r.changed === false) bits.push('no changes')
    if (r.resolved.length > 0) bits.push(`${r.resolved.map((x) => `F${x}`).join(', ')} resolved`)
    if ((r.failing ?? []).length > 0) bits.push(`${(r.failing ?? []).join(', ')} failing`)
    const open = r.open.length
    if (open > 0) bits.push(`${open} still open`)
    if (r.status === 'done' && open === 0 && (r.failing ?? []).length === 0) bits.push('green')
    return `round ${r.n}: ${bits.length > 0 ? bits.join(', ') : r.status === 'running' ? 'running' : 'no checks'}`
  })
  return `Fix rounds: ${loop.rounds.length} of ${fixRoundsMax(state)} · ${parts.join(' · ')}`
}

/** "Research: 3 items kept for Plan (web) · research.md" once Research has answered; undefined otherwise. */
function researchLine(state: RunState): string | undefined {
  const cfg = state.config.research
  const r = state.research
  if (cfg === undefined || r === undefined) return undefined
  const where = cfg.web ? 'web' : 'repository only'
  switch (r.status) {
    case 'chosen': {
      const n = (r.chosen?.length ?? 0) + Object.keys(r.answers ?? {}).length
      return `Research: ${n === 1 ? '1 item' : `${n} items`} kept for Plan${r.auto === true ? ' (Auto)' : ''} (${where}) · research.md`
    }
    case 'skipped':
      return `Research: not used by Plan (${where}) · research.md`
    case 'none':
      return `Research: nothing usable (${where})`
    case 'reviewing':
    case 'pending':
      return `Research: waiting for your review (${where})`
  }
}

/**
 * The acceptance checklist: "Acceptance: 3 of 5 criteria met, 1 not met, 1 unknown." and one line per criterion
 * ("[Not met] AC2 Lists items · evidence · tests: ..."). Empty while the plan has no criteria.
 */
export function acceptanceLines(state: RunState): string[] {
  const v = acceptanceView(state)
  if (v === undefined) return []
  const head = acceptanceSummaryText(v.counts)
  const lines = [v.review === 'off' ? `${head.slice(0, -1)} (no acceptance review).` : head]
  for (const i of v.items) {
    const bits = [`[${ACCEPTANCE_STATUS_LABEL[i.status]}] ${i.id} ${i.text}`]
    if (i.evidence !== undefined) bits.push(i.evidence)
    if (i.finding !== undefined) bits.push(`F${i.finding}`)
    if (i.tests !== undefined && i.tests.length > 0) bits.push(`tests: ${i.tests.join('; ')}`)
    lines.push(`  ${bits.join(' · ')}`)
  }
  return lines
}

const FIX_SKIP_TEXT: Readonly<Record<string, string>> = {
  disabled: 'Fix is turned off',
  user: 'you skipped Fix',
  'no findings selected': 'no findings were selected',
  'no findings': 'no findings could be read',
}

function stepDescr(st: StepState): string {
  const parts: string[] = []
  if (st.vendor !== undefined) parts.push(st.vendor)
  if (st.model !== undefined) parts.push(st.model ?? 'default model')
  if (st.key === 'plan' && st.planMode !== undefined) {
    parts.push(st.planMode === 'native' ? 'native plan' : 'plan template')
  } else if (st.mode !== undefined) parts.push(MODE_TEXT[st.mode])
  return parts.join(' · ')
}

const isReviewer = (k: StepKey): k is 'review' | 'critic' => k === 'review' || k === 'critic'

/** "2 must · 1 should", or "no findings". */
export function countsText(c: { must: number; should: number }): string {
  return c.must + c.should === 0 ? 'no findings' : `${c.must} must · ${c.should} should`
}

/** What a finished reviewer reported, from its parsed output. */
function reviewerReport(state: RunState, k: 'review' | 'critic'): string | undefined {
  const src = state.findings?.sources[k]
  if (src === undefined || src.status === 'parsing') return undefined
  const must = src.findings.filter((f) => f.severity === 'must').length
  const counts = { must, should: src.findings.length - must }
  switch (src.status) {
    case 'none':
      return src.treatedAsNone === true ? 'no output (treated as no findings)' : 'no findings'
    case 'ok':
      return countsText(counts)
    case 'untagged':
      return `${countsText(counts)} (not tagged must/should; counted as should)`
    case 'unstructured':
      return 'replied without a findings list (kept as one should finding)'
    case 'empty':
      return 'no output'
    case 'failed':
      return 'output could not be read'
  }
}

/** Fix's closing report as it said it (`F1 fixed · F3 disputed`), or undefined when it gave none. */
function fixReportText(state: RunState): string | undefined {
  const text = state.steps.fix.result
  if (text === undefined) return undefined
  const entries = parseFixReport(text)
  return entries.length > 0 ? entries.map((e) => `F${e.n} ${e.status}`).join(' · ') : undefined
}

/** Streams one run to the terminal. Envelopes of other runs are ignored; before the run id is known they wait. */
export class RunPrinter implements BusSink {
  readonly name = 'cli-printer'
  readonly #io: CliIo
  readonly #json: boolean
  readonly #state: () => RunState | undefined
  #runId: string | undefined
  #pending: RunEnvelope[] = []
  #midLine = false
  #headers = new Set<string>()
  /** Review ∥ Critic stream at the same time: their text is printed a whole line at a time, labelled. */
  readonly #lineBuf = new Map<StepKey, string>()
  /** Tool rows already printed (a later start for the same id is its progress, not a new line). */
  readonly #toolsShown = new Set<string>()

  constructor(io: CliIo, o: { json: boolean; state: () => RunState | undefined }) {
    this.#io = io
    this.#json = o.json
    this.#state = o.state
  }

  /** Start printing `runId` (flushes what arrived before the id was known). */
  follow(runId: string): void {
    this.#runId = runId
    const pending = this.#pending
    this.#pending = []
    for (const env of pending) if (env.runId === runId) this.#print(env)
  }

  run(env: RunEnvelope): void {
    if (this.#runId === undefined) {
      this.#pending.push(env)
      return
    }
    if (env.runId === this.#runId) this.#print(env)
  }

  /** A line from the CLI itself (prompts, notices): stdout in human mode, stderr with --json. */
  line(text: string): void {
    this.endLine()
    if (this.#json) this.#io.err(text)
    else this.#io.out(text)
  }

  /** A prompt without a newline. */
  ask(text: string): void {
    this.endLine()
    if (this.#json) this.#io.err(text)
    else this.#io.write(text)
  }

  endLine(): void {
    if (this.#midLine) {
      this.#io.write('\n')
      this.#midLine = false
    }
  }

  #print(env: RunEnvelope): void {
    if (this.#json) {
      this.#io.out(envelopeLine(env))
      return
    }
    this.#human(env.body)
  }

  #text(step: StepKey, delta: string): void {
    if (delta === '') return
    if (!isReviewer(step)) {
      this.#io.write(delta)
      this.#midLine = !delta.endsWith('\n')
      return
    }
    const parts = `${this.#lineBuf.get(step) ?? ''}${delta}`.split('\n')
    this.#lineBuf.set(step, parts.pop() ?? '')
    for (const l of parts) this.#reviewerLine(step, l)
  }

  #reviewerLine(step: StepKey, text: string): void {
    this.line(`  ${stepLabel(step)} | ${text}`)
  }

  #flush(step: StepKey): void {
    const rest = this.#lineBuf.get(step)
    this.#lineBuf.delete(step)
    if (rest !== undefined && rest.trim() !== '') this.#reviewerLine(step, rest)
  }

  #human(b: RunEventBody): void {
    switch (b.t) {
      case 'ev': {
        const ev = b.ev
        if (ev.type === 'text') {
          this.#text(b.step, ev.delta)
          return
        }
        const who = isReviewer(b.step) ? `[${stepLabel(b.step)}] ` : ''
        if (ev.type === 'tool') {
          if (ev.phase === 'end') {
            if (ev.status === 'failed' || ev.status === 'declined')
              this.line(`  ! ${who}${ev.name} ${ev.status}`)
            return
          }
          if (ev.phase === 'start' && ev.id !== undefined) {
            const key = `${b.step}:${ev.id}`
            if (this.#toolsShown.has(key)) return
            this.#toolsShown.add(key)
          }
          this.line(`  * ${who}${ev.name}${ev.summary !== '' ? `: ${ev.summary}` : ''}`)
          return
        }
        if (ev.type === 'error' && !ev.fatal) this.line(`  ! ${who}${ev.message}`)
        return
      }
      case 'step-status': {
        const st = this.#state()?.steps[b.step]
        if (b.status === 'running') {
          const key = `${b.step}#${b.attempt}#${st?.spawnNo ?? 0}`
          if (this.#headers.has(key)) return
          const descr = st !== undefined ? stepDescr(st) : ''
          // Fix until green: a later round says which round it is (each round is a new attempt of its steps).
          const round = roundTag(this.#state(), b.step)
          const attempt = round !== '' ? round : b.attempt > 1 ? ` (attempt ${b.attempt})` : ''
          const why = b.reason !== undefined ? ` · ${b.reason}` : ''
          const note = b.sessionNote !== undefined ? ` (${b.sessionNote})` : ''
          if (b.step === 'preflight') {
            this.#headers.add(key)
            this.line(`== Preflight${attempt}`)
          } else if (st?.proc?.live === true && descr !== '') {
            // Printed once the process is spawned (the first `running` is the launch pipeline starting).
            this.#headers.add(key)
            this.line(`== ${stepLabel(b.step)}${attempt} · ${descr}${why}${note}`)
          }
          return
        }
        if (isReviewer(b.step)) this.#flush(b.step)
        const label = stepLabel(b.step)
        if (b.status === 'paused') this.line(`-- ${label} paused (${b.pause ?? 'paused'})`)
        else if (b.status === 'failed') this.line(`-- ${label} failed (${b.reason ?? 'unknown'})`)
        else if (b.status === 'waiting' && b.reason !== undefined) this.line(`-- ${label}: ${b.reason}`)
        else if (b.status === 'done' && b.step !== 'preflight') {
          const s = this.#state()
          const report =
            s === undefined
              ? undefined
              : isReviewer(b.step)
                ? reviewerReport(s, b.step)
                : b.step === 'fix'
                  ? fixReportText(s)
                  : undefined
          this.line(`-- ${label} done${report !== undefined ? `: ${report}` : ''}`)
        } else if (
          b.status === 'skipped' &&
          (isReviewer(b.step) || b.step === 'fix') &&
          b.reason !== undefined
        ) {
          this.line(`-- ${label} skipped (${b.reason})`)
        }
        return
      }
      case 'snag': {
        const vendor = this.#state()?.steps[b.step].vendor
        this.line(
          `x ${stepLabel(b.step)}: ${categoryTitle(b.failure.category, { vendor: vendorName(vendor) })} · ${b.failure.message}`,
        )
        for (const a of b.actions) {
          const how = a.kind === 'shell_copy' ? `: ${a.command}` : ''
          this.line(`    -> ${a.label}${how}`)
        }
        return
      }
      case 'guardrail':
        this.line(`  Guardrail: ${b.finding.rule}: ${b.finding.subject}${b.undone ? ' (put back)' : ''}`)
        return
      case 'output':
        if (b.file === 'plan.original') this.line('  (plan edited; the original is kept in plan.original.md)')
        return
      case 'auto-answered':
        this.line(`  (auto-${b.decision} ${b.tool}: ${b.why})`)
        return
      case 'diff-stats': {
        if (b.live) return
        const s = this.#state()
        const whole = s !== undefined && s.steps.fix.status === 'done'
        const what = `${b.files} file${b.files === 1 ? '' : 's'} (+${b.added} -${b.deleted})`
        this.line(whole ? `  The run changed ${what} in total` : `  Implement changed ${what}`)
        return
      }
      case 'ask-resolved':
        if (b.by === 'timeout') this.line(`  question timed out (${b.requestId})`)
        else if (b.by === 'vendor-cancel') this.line('  question withdrawn by the vendor')
        else if (b.by === 'auto') this.line('  question approved by Auto')
        return
      case 'run-status':
      case 'card':
      case 'ask-extended':
      case 'usage':
      case 'context':
        return
    }
  }
}

// ---- footer -------------------------------------------------------------------------------------------------------

/** `$0.62`, with `~` when any part is an estimate from the price list. */
function usdText(usd: number, bases: readonly CostBasis[]): string {
  return `${bases.includes('catalog') ? '~' : ''}$${usd.toFixed(2)}`
}

/**
 * The run's cost line: total over every attempt of every step (a retried pass's first attempt still cost money),
 * where it came from, and whether a subscription covers it.
 */
export function costLine(state: RunState): string {
  let total = 0
  let any = false
  let apiEquivalent = false
  const bases = new Set<CostBasis>()
  for (const k of STEP_KEYS) {
    const sp = stepSpend(state.steps[k])
    if (sp === undefined || sp.usd === null) continue
    total += sp.usd
    any = true
    for (const b of sp.bases) bases.add(b)
    if (sp.apiEquivalent) apiEquivalent = true
  }
  if (!any) {
    // The app's words for a run total without a figure (shared/cost-text.ts), with the reason spelled out.
    const usageReported = STEP_KEYS.some((k) => stepSpend(state.steps[k]) !== undefined)
    const gap = noRunCost({ status: state.status, usageReported })
    return gap === 'unpriced'
      ? `Cost: ${NO_RUN_COST.unpriced} (the CLI reported none, and the models used are not in the price list)`
      : `Cost: ${NO_RUN_COST[gap]}`
  }
  const est = bases.has('catalog')
  const reported = bases.has('vendor')
  const how =
    reported && est
      ? 'part reported by the CLI, part estimated from the price list'
      : est
        ? 'estimated from the price list'
        : 'reported by the CLI'
  const sub = apiEquivalent ? '; what the tokens would cost on the API, your subscription covers it' : ''
  return `Cost: ${est ? '~' : ''}$${total.toFixed(2)} (${how}${sub})`
}

/** The step a cancelled run stopped in (the first one that had started). */
function cancelledAt(state: RunState): StepKey | undefined {
  const cancelled = STEP_KEYS.filter((k) => state.steps[k].status === 'cancelled')
  return cancelled.find((k) => state.steps[k].attempt > 0) ?? cancelled[0]
}

/**
 * The footer's first line, with the app's outcome strings: `Fixed · 3 must · 5 should`, `Clean: no findings`,
 * `No changes made`, `Completed with failures`, `Failed at Implement · <why>`, `Cancelled at Review`.
 */
export function headline(state: RunState, now: number): string {
  const n = `Run #${state.displayNo}`
  const dur = formatDuration((state.endedAt ?? now) - state.createdAt)
  const counts = countsText(findingCounts(state))
  const failedAt = (): string => {
    const f = state.failure
    if (f === undefined) return ''
    const title = categoryTitle(f.category, { vendor: vendorName(state.steps[f.step].vendor) })
    return `Failed at ${stepLabel(f.step)} · ${title}`
  }
  if (state.status === 'completed' && state.outcome !== undefined) {
    const o = state.outcome
    const text = OUTCOME_TEXT[o] ?? o
    switch (o) {
      case 'fixed':
        return `${n} completed (${text}) in ${dur} · ${counts}`
      case 'clean':
        // A [should] Verify added (a command Auto skipped as untrusted) does not block the skip rule.
        return `${n} completed (${text}) in ${dur} · ${counts}`
      case 'findings-open': {
        const reason = state.steps.fix.reason
        const why = reason !== undefined ? (FIX_SKIP_TEXT[reason] ?? reason) : 'Fix did not run'
        return `${n} completed (${text}) in ${dur} · ${counts} · ${why}`
      }
      case 'fix-stopped': {
        // Fix until green stopped before green: the round cap, the budget, or a round without progress.
        const stop = state.fixLoop?.stop
        return `${n} completed (${text}) in ${dur}${stop !== undefined ? ` · ${FIX_STOP_WORDS[stop.reason]}` : ''}`
      }
      case 'gates-failed': {
        // The project's quality gates: the required checks that did not pass.
        const failed = state.gates?.failed.map((g) => g.name) ?? []
        return `${n} completed (${text}) in ${dur}${failed.length > 0 ? ` · quality gates not passed: ${failed.join(', ')}` : ''}`
      }
      case 'no-changes':
      case 'verify-failed':
      case 'security-open':
      case 'failed':
        return `${n} completed (${text}) in ${dur}`
    }
  }
  if (state.status === 'cancelled') {
    if (state.outcome === 'failed') return `${n} closed in ${dur} · ${failedAt()}`
    const at = cancelledAt(state)
    return `${n} cancelled in ${dur}${at !== undefined ? ` · Cancelled at ${stepLabel(at)}` : ''}`
  }
  if (state.status === 'failed') return `${n} failed in ${dur} · ${failedAt()}`
  return `${n} ${STATUS_TEXT[state.status]} after ${dur}`
}

/** "Findings: 2 must · 1 should · Fix got 3 (F1 fixed · F2 fixed · F3 disputed)". */
function findingsLine(state: RunState): string | undefined {
  const fs = state.findings
  if (fs === undefined) return undefined
  const counts = findingCounts(state)
  if (counts.must + counts.should === 0) {
    return state.outcome === 'clean' ? 'Findings: none (Review and Critic reported no findings)' : undefined
  }
  const parts = [`Findings: ${countsText(counts)}`]
  const fix = state.steps.fix
  if (fix.status === 'done' || fix.status === 'running' || fix.status === 'failed') {
    const sent = fs.selected.length
    const said = fix.status === 'done' ? fixReportText(state) : undefined
    parts.push(`Fix got ${sent} of ${fs.list.length}${said !== undefined ? ` (${said})` : ''}`)
  }
  return parts.join(' · ')
}

/** End-of-run footer: outcome, per-step rows, findings, files changed, tokens, cost, notes, run folder. */
export function footer(state: RunState, o: { runDir: string; now: number; lastSeq: number }): string[] {
  const lines: string[] = [headline(state, o.now)]
  let tokens = 0
  for (const k of STEP_KEYS) {
    const st = state.steps[k]
    if (st.attempt === 0 && st.status !== 'skipped') continue
    if (k === 'preflight' || k === 'prepare' || k.startsWith('verify') || k === 'finalize') {
      if (st.status === 'skipped' || st.status === 'done') continue
    }
    // Every attempt's spend, so the rows add up to the Tokens / Cost totals.
    const spend = stepSpend(st)
    const tok = spend?.tokens ?? 0
    tokens += tok
    const approx = spend?.approx === true
    const active = st.activeMs + (st.activeSince !== undefined ? Math.max(0, o.now - st.activeSince) : 0)
    const report = isReviewer(k) && st.status === 'done' ? reviewerReport(state, k) : undefined
    const extra = [
      stepDescr(st),
      st.attempt > 0 ? formatDuration(active) : '',
      tok > 0 ? `${approx ? '~' : ''}${formatTokens(tok)} tok` : '',
      spend !== undefined && spend.usd !== null ? usdText(spend.usd, spend.bases) : '',
      // A finished reviewer's report says it better than its status reason.
      st.reason !== undefined && st.status !== 'running' && report === undefined ? st.reason : '',
      st.pause !== undefined ? st.pause : '',
      report ?? '',
      k === 'fix' && st.sessionNote !== undefined && st.attempt > 0 ? st.sessionNote : '',
    ]
      .filter((x) => x !== '')
      .join(' · ')
    lines.push(`  ${stepLabel(k).padEnd(10)} ${st.status.padEnd(9)} ${extra}`)
  }
  // Dim Factory's own play-test needs the app (it plays the game in its sandboxed preview): the command line says so.
  const played = (['verify:2', 'verify:1'] as const)
    .map((k) => state.steps[k].verify?.commands.find((c) => isPlaytestArgv(c.argv)))
    .find((c) => c !== undefined && c.status !== 'queued' && c.status !== 'running')
  if (played !== undefined && played.status === 'skipped' && played.reason !== undefined)
    lines.push(`  ${'Play-test'.padEnd(10)} ${'skipped'.padEnd(9)} ${played.reason}`)
  const f = findingsLine(state)
  if (f !== undefined) lines.push(`  ${f}`)
  const rounds = roundsLine(state)
  if (rounds !== undefined) lines.push(`  ${rounds}`)
  const research = researchLine(state)
  if (research !== undefined) lines.push(`  ${research}`)
  for (const l of acceptanceLines(state)) lines.push(`  ${l}`)
  if (state.diffStats !== undefined) {
    const d = state.diffStats
    lines.push(`  Files changed: ${d.files}${d.live ? ' (live count)' : ` (+${d.added} -${d.deleted})`}`)
  }
  lines.push(`  Tokens: ${formatTokens(tokens)} · ${costLine(state)}`)
  if (state.failure !== undefined && state.status !== 'failed' && state.outcome !== 'failed') {
    const title = categoryTitle(state.failure.category, {
      vendor: vendorName(state.steps[state.failure.step].vendor),
    })
    lines.push(`  Failure: ${stepLabel(state.failure.step)} · ${title}`)
  }
  for (const n of state.notes.slice(-5)) lines.push(`  Note: ${n}`)
  lines.push(`  Run: ${state.runId} · events ${o.lastSeq}`)
  lines.push(`  Run folder: ${o.runDir}`)
  return lines
}
