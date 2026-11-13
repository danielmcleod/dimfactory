// Card builders and the default snag buttons.
// Core builds every choice; the renderer and the CLI only display them. Choice ids are stable API.
import type { Failure, RecoveryAction } from '../../shared/failure.ts'
import type { PreflightReport } from '../../shared/preflight.ts'
import { isAgentStep, isStepKey } from '../../shared/run.ts'
import type { AgentStep, CardKind, CardView, ClarifyQuestion, StepKey } from '../../shared/run.ts'
import { autoResearchChoice } from '../../shared/research.ts'
import type { ResearchPayload, ResearchResult } from '../../shared/research.ts'
import { formatIdle } from './timers.ts'
import type {
  Finding,
  GitHead,
  ReconcileBoundary,
  ReconcileCardInput,
  ReconcileReasonView,
  ReviewerPass,
  SnagInfo,
} from './types.ts'

export const CHOICE = {
  approve: 'approve',
  cancel: 'cancel',
  replan: 'replan',
  proceed: 'proceed',
  recheck: 'recheck',
  keepWaiting: 'keep-waiting',
  stop: 'stop',
  revertThenFresh: 'revert-then-fresh',
  keepChanges: 'keep-changes',
  /** gate:beforeFix: Continue with the selected findings (`input: 'findings'` = finding ids). */
  continueFix: 'continue',
  skipFix: 'skip-fix',
  /** emptyFindings */
  retry: 'retry',
  treatAsNone: 'treat-as-none',
} as const
export type ChoiceId = (typeof CHOICE)[keyof typeof CHOICE]

/** Reconcile card choices (git/reconcile.ts ReconcileChoiceId; `stop` / `recheck` as in CHOICE). */
export const RECONCILE_CHOICE = {
  continueOnBranch: 'continue-on-branch',
  includeEdits: 'include-my-edits',
  restoreRun: 'restore-run-version',
  stop: 'stop',
  recheck: 'recheck',
} as const

/** planMutated card choices (R4 plan-end guard). */
export const PLAN_MUTATED_CHOICE = {
  revert: 'revert-plan',
  keep: 'keep',
} as const

/** Trust card choices ("trust: [Trust for this project] [Skip]"). */
export const TRUST_CHOICE = {
  trust: 'trust',
  skip: 'skip',
} as const

/** verifyEnv card choices ("verifyEnv: [Retry] [Skip verify]"). */
export const VERIFY_ENV_CHOICE = {
  retry: 'retry',
  skipVerify: 'skip-verify',
} as const

/** depsConsent / depsFailed choices (the isolated run's dependency step). */
export const DEPS_CHOICE = {
  install: 'install',
  /** `input: 'command'`: the install command line the user typed (argv only, no shell). */
  editCommand: 'edit-command',
  skipInstall: 'skip-install',
  retry: 'retry',
  cancel: 'cancel',
} as const

/** Finalize choices (R12). */
export const FINALIZE_CHOICE = {
  apply: 'apply',
  keep: 'keep',
  discard: 'discard',
} as const

/** finalizeConflicts choices (the apply table): `input: 'paths'`, every conflicting file when absent. */
export const CONFLICT_CHOICE = {
  keepMine: 'keep-mine',
  takeTheirs: 'take-theirs',
} as const

/** interruptedApply choice (the journal makes [Finish apply] idempotent after a crash). */
export const INTERRUPTED_APPLY_CHOICE = {
  finish: 'finish-apply',
} as const

/** testsNotRed choices (Test-first: the new tests did not fail before Implement). */
export const TESTS_NOT_RED_CHOICE = {
  rewrite: 'rewrite',
  continue: 'continue',
  stop: 'stop',
} as const

/** Clarify card choices: `answer` takes `input: 'answers'` (one per question, '' for one left unanswered). */
export const CLARIFY_CHOICE = {
  answer: 'answer',
  skip: 'skip',
} as const

/**
 * Research card choices: `use` takes `input: 'research'` (the kept item ids and `q<n>=<answer>` entries; Auto sends
 * none and keeps the must-haves and recommendations), `skip` plans without the research.
 */
export const RESEARCH_CHOICE = {
  use: 'use',
  skip: 'skip',
} as const

const STEP_LABEL: Record<StepKey, string> = {
  preflight: 'Preflight',
  prepare: 'Prepare',
  'verify:0': 'Baseline verify',
  clarify: 'Clarify',
  research: 'Research',
  plan: 'Plan',
  tests: 'Tests',
  'verify:red': 'Red check',
  implement: 'Implement',
  'verify:1': 'Verify',
  scan: 'Security scan',
  acceptance: 'Acceptance review',
  review: 'Review',
  critic: 'Critic',
  security: 'Security',
  fix: 'Fix',
  'verify:2': 'Final verify',
  recheck: 'Re-check',
  deploy: 'Deploy',
  explain: 'Explain it to me',
  finalize: 'Finalize',
}

export function stepLabel(step: StepKey): string {
  return STEP_LABEL[step]
}

/** Card ids are `<kind>-<n>`, unique per run. */
export function cardId(kind: CardKind, n: number): string {
  return `${kind}-${n}`
}

/** R4: Approve (optionally with an edited plan as `input`) / Cancel run. */
export function afterPlanGateCard(id: string, plan: string): CardView {
  return {
    id,
    kind: 'gate:afterPlan',
    title: 'Review the plan',
    body: plan,
    payload: { plan },
    blocking: true,
    defaultChoice: CHOICE.approve,
    choices: [
      { id: CHOICE.approve, label: 'Approve', primary: true, input: 'plan' },
      { id: CHOICE.cancel, label: 'Cancel run', danger: true },
    ],
  }
}

/** R3: opens even in Auto, and never has a default. */
export function insufficientContextCard(id: string, message: string, task: string): CardView {
  return {
    id,
    kind: 'insufficientContext',
    title: 'The planner needs more context',
    body: message,
    payload: { message, task },
    blocking: true,
    choices: [
      { id: CHOICE.replan, label: 'Edit task & re-plan', primary: true, input: 'task' },
      { id: CHOICE.proceed, label: 'Proceed anyway' },
      { id: CHOICE.cancel, label: 'Cancel run', danger: true },
    ],
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** `- [must] F1 (review) <title>`, the `{{findings}}` entry line (the template rendering rules). */
export function findingLine(f: Finding): string {
  return `- [${f.severity}] F${f.n} (${f.source}) ${f.title}`
}

/**
 * R8/R9 gate before Fix. `payload.findings` lists every finding (numbered, must first); `payload.selected` is the
 * default selection (all). "Continue with N" takes `input: 'findings'` = the finding ids to fix (none ⇒ the
 * default); an empty list completes the run with findings open. Payload `step: 'fix'` ties the card to Fix.
 */
export function beforeFixGateCard(
  id: string,
  findings: readonly Finding[],
  selected: readonly string[],
  notes: readonly string[] = [],
): CardView {
  const must = findings.filter((f) => f.severity === 'must').length
  const should = findings.length - must
  const n = selected.length
  const lines = findings.map(findingLine)
  if (notes.length > 0) lines.push('', ...notes.map((x) => `Note: ${x}`))
  return {
    id,
    kind: 'gate:beforeFix',
    title:
      findings.length === 0
        ? 'No findings could be read'
        : `${plural(findings.length, 'finding')} before Fix: ${must} must, ${should} should`,
    body: lines.join('\n'),
    payload: { step: 'fix', findings: [...findings], selected: [...selected], notes: [...notes] },
    blocking: true,
    defaultChoice: CHOICE.continueFix,
    choices: [
      {
        id: CHOICE.continueFix,
        label: `Continue with ${plural(n, 'finding')}`,
        primary: true,
        input: 'findings',
      },
      { id: CHOICE.skipFix, label: 'Skip Fix' },
      { id: CHOICE.cancel, label: 'Cancel run', danger: true },
    ],
  }
}

/** The facts behind an empty reviewer output once the automatic retry is spent (card body, Auto note). */
export interface EmptyOutputFacts {
  /** How many of the reviewer's outputs were empty (≥ 1). */
  emptyOutputs: number
  /** The attempt whose output was empty just now. */
  attempt: number
}

/**
 * "returned no output twice" when both were empty; "returned no output on attempt 2 (its automatic retry was
 * already used)" when an earlier failure spent the retry and this is the first empty output.
 */
export function emptyOutputText(f: EmptyOutputFacts): string {
  if (f.emptyOutputs >= 3) return `returned no output ${f.emptyOutputs} times`
  if (f.emptyOutputs === 2) return 'returned no output twice'
  return `returned no output on attempt ${f.attempt} (its automatic retry was already used)`
}

/**
 * Empty output: the pass produced no output and the automatic retry is spent (by an earlier empty output, or by an
 * earlier failure). Non-Auto only; Auto treats the output as no findings with a warning note instead. Retry is a
 * user click (no budget).
 */
export function emptyFindingsCard(
  id: string,
  step: ReviewerPass,
  facts: EmptyOutputFacts = { emptyOutputs: 2, attempt: 2 },
): CardView {
  const label = stepLabel(step)
  return {
    id,
    kind: 'emptyFindings',
    title: `${label} returned nothing`,
    body:
      `${label} ${emptyOutputText(facts)}, so Dim Factory cannot tell whether it found problems. ` +
      `Retry ${label}, or treat it as "no findings" (Fix is then skipped if nothing else needs fixing).`,
    payload: { step },
    blocking: true,
    defaultChoice: CHOICE.treatAsNone,
    choices: [
      { id: CHOICE.retry, label: `Retry ${label}`, primary: true },
      { id: CHOICE.treatAsNone, label: 'Treat as no findings' },
    ],
  }
}

/** R2b: every blocking check with its recovery actions (in `payload.blocking[].recovery`). */
export function preflightCard(id: string, report: PreflightReport): CardView {
  const n = report.blocking.length
  const first = report.blocking[0]
  return {
    id,
    kind: 'preflight',
    title: n === 1 && first ? first.title : `${n} problems block this run`,
    body: report.blocking.map((c) => `- ${c.title}${c.detail ? `: ${c.detail}` : ''}`).join('\n'),
    payload: { blocking: report.blocking, warnings: report.warnings },
    blocking: true,
    choices: [
      { id: CHOICE.recheck, label: 'Recheck', primary: true },
      { id: CHOICE.cancel, label: 'Cancel run', danger: true },
    ],
  }
}

/** P12: informational (the step itself counts as needing attention), no default. */
export function stallCard(id: string, step: AgentStep, idleMs: number): CardView {
  const idle = formatIdle(idleMs)
  return {
    id,
    kind: 'stall',
    title: `No output for ${idle}`,
    body: `${stepLabel(step)} has produced no output for ${idle}. It may still be working.`,
    payload: { step, idleMs },
    blocking: false,
    choices: [
      { id: CHOICE.keepWaiting, label: 'Keep waiting', primary: true },
      { id: CHOICE.stop, label: 'Stop run', danger: true },
    ],
  }
}

/** Context health's cards: the restart after compactions and the loop card. */
export const REACTION_CHOICE = {
  restart: 'restart-fresh',
  keepGoing: 'keep-going',
  stop: 'stop',
} as const

const timesText = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/**
 * The pass's session compacted `compactions` times (Implement or Fix): restart it fresh with a short summary of where
 * the work stands, or keep going. Informational (the pass keeps running), no default; Auto restarts on its own.
 */
export function restartFreshCard(id: string, step: AgentStep, compactions: number): CardView {
  const label = stepLabel(step)
  return {
    id,
    kind: 'restartFresh',
    title: 'Restart this pass fresh with a summary',
    body:
      `The AI ran low on memory and summarised its notes ${timesText(compactions)} in ${label}; results may be less reliable. ` +
      `Restart ${label} in a fresh session with a short summary of the plan, the criteria and the files changed so far, or keep going.`,
    payload: { step, compactions },
    blocking: false,
    choices: [
      { id: REACTION_CHOICE.restart, label: 'Restart fresh with a summary', primary: true },
      { id: REACTION_CHOICE.keepGoing, label: 'Keep going' },
    ],
  }
}

/**
 * The pass made the same call `count` times: stop it now, or keep going (Dim Factory still stops it at `stopAt`).
 * Informational, no default; Auto stops and retries fresh once instead.
 */
export function loopCard(
  id: string,
  step: AgentStep,
  o: { tool: string; count: number; stopAt: number },
): CardView {
  const label = stepLabel(step)
  return {
    id,
    kind: 'loop',
    title: 'The AI keeps repeating the same step',
    body:
      `${label} ran the same ${o.tool} call ${o.count} times. It may be stuck. ` +
      `Stop it, or keep going (Dim Factory stops it at ${o.stopAt}).`,
    payload: { step, tool: o.tool, count: o.count, stopAt: o.stopAt },
    blocking: false,
    choices: [
      { id: REACTION_CHOICE.stop, label: 'Stop', danger: true },
      { id: REACTION_CHOICE.keepGoing, label: 'Keep going', primary: true },
    ],
  }
}

/** The loop stop's failure (UI copy, no em dashes). */
export const LOOP_STOP_MESSAGE = 'The AI kept repeating the same step, so Dim Factory stopped it.'

/** Retry `auto` on a mutating pass with changes and no session. Default: keep changes, fresh. */
export function retryPartialCard(id: string, step: AgentStep, failure: Failure | undefined): CardView {
  const why = failure ? ` after: ${failure.message}` : ''
  return {
    id,
    kind: 'retryPartial',
    title: `${stepLabel(step)} left partial changes`,
    body:
      `${stepLabel(step)} changed files before it failed${why}. ` +
      'There is no session to resume, so the retry starts fresh.',
    payload: { step, category: failure?.category },
    blocking: true,
    defaultChoice: CHOICE.keepChanges,
    choices: [
      { id: CHOICE.revertThenFresh, label: 'Revert partial then fresh' },
      { id: CHOICE.keepChanges, label: 'Keep changes, fresh', primary: true },
      { id: CHOICE.cancel, label: 'Cancel', danger: true },
    ],
  }
}

// ---- reconcile and planMutated (reconciliation, the plan-end guard) ---------------------------------------------

/** Paths named in card copy before "and N more". */
const CARD_PATHS_MAX = 20

function pathList(paths: readonly string[]): string {
  const shown = paths.slice(0, CARD_PATHS_MAX).join(', ')
  return paths.length > CARD_PATHS_MAX ? `${shown} and ${paths.length - CARD_PATHS_MAX} more` : shown
}

/** Where a reconcile ran, as card copy. */
export function boundaryText(boundary: ReconcileBoundary, step?: StepKey): string {
  switch (boundary) {
    case 'pre-implement':
      return 'before Implement'
    case 'pre-review':
      return 'before Review'
    case 'pre-fix':
      return 'before Fix'
    case 'pre-apply':
      return 'before applying the run'
    case 'end-of-pass':
      return step !== undefined ? `after ${stepLabel(step)}` : 'after the pass'
  }
}

/** One reconcile reason as a line of card body or run note: "A git merge is in progress: Finish or abort …". */
export function reasonLine(r: Pick<ReconcileReasonView, 'title' | 'detail'>): string {
  return r.detail === '' ? r.title : `${r.title}: ${r.detail}`
}

/**
 * The reconcile card's payload (read back when a choice is made; recovery.ts keeps cards from the log, so the card
 * carries what its choices need). `step` ties the card to a pass (R5 Implement, R10 Fix, the end of a mutating pass).
 */
export interface ReconcileCardPayload {
  boundary: ReconcileBoundary
  step?: StepKey
  verdict: 'choice' | 'block'
  reasons: ReconcileReasonView[]
  paths: { external: string[]; overlapping: string[] }
  /** Prompt notes applied with [Include my edits]. */
  notes: string[]
  /** HEAD as observed: [Continue on <branch>] makes it the expected HEAD. */
  head?: GitHead
  /** Branch prep (R5) could not make the run branch; Recheck redoes reconcile and branch prep. */
  branchPrep?: boolean
}

/**
 * A reconcile card ("reconcile: Paths + core-built choices"). Choice verdicts carry their default (Auto
 * takes it); a block has none, so it always waits, Auto included.
 */
export function reconcileCard(
  id: string,
  o: {
    boundary: ReconcileBoundary
    step?: StepKey
    input: ReconcileCardInput
    head?: GitHead
    branchPrep?: boolean
  },
): CardView {
  const { input } = o
  const deciding = input.reasons.filter((r) => r.severity === input.verdict)
  const first = deciding[0] ?? input.reasons[0]
  const title =
    first === undefined
      ? 'Dim Factory needs you to check the folder'
      : deciding.length > 1
        ? `${first.title} (and ${deciding.length - 1} more)`
        : first.title
  const where =
    o.branchPrep === true
      ? 'The run branch could not be made'
      : `Dim Factory checked the folder ${boundaryText(o.boundary, o.step)}`
  const lines = [`${where}.`, ...input.reasons.map((r) => `- ${reasonLine(r)}`)]
  const payload: ReconcileCardPayload = {
    boundary: o.boundary,
    verdict: input.verdict,
    reasons: input.reasons.map((r) => ({ ...r, actions: [...r.actions] })),
    paths: { external: [...input.external], overlapping: [...input.overlapping] },
    notes: [...input.notes],
  }
  if (o.step !== undefined) payload.step = o.step
  if (o.head !== undefined) payload.head = { ...o.head }
  if (o.branchPrep === true) payload.branchPrep = true
  const view: CardView = {
    id,
    kind: 'reconcile',
    title,
    body: lines.join('\n'),
    payload,
    blocking: true,
    choices: input.choices.map((c) =>
      c.id === RECONCILE_CHOICE.stop ? { ...c, label: 'Stop run', danger: true } : { ...c },
    ),
  }
  if (input.verdict === 'choice' && input.defaultChoice !== undefined)
    view.defaultChoice = input.defaultChoice
  return view
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const BOUNDARIES: readonly ReconcileBoundary[] = [
  'pre-implement',
  'pre-review',
  'pre-fix',
  'pre-apply',
  'end-of-pass',
]

/** A reconcile card's payload as it was built (undefined when it is not one). */
export function reconcilePayloadOf(view: CardView): ReconcileCardPayload | undefined {
  const p = view.payload
  if (view.kind !== 'reconcile' || !isRec(p)) return undefined
  const boundary = p['boundary']
  if (typeof boundary !== 'string' || !(BOUNDARIES as readonly string[]).includes(boundary)) return undefined
  const paths = isRec(p['paths']) ? p['paths'] : {}
  const out: ReconcileCardPayload = {
    boundary: boundary as ReconcileBoundary,
    verdict: p['verdict'] === 'choice' ? 'choice' : 'block',
    reasons: Array.isArray(p['reasons']) ? (p['reasons'] as ReconcileReasonView[]) : [],
    paths: { external: strs(paths['external']), overlapping: strs(paths['overlapping']) },
    notes: strs(p['notes']),
  }
  const step = p['step']
  if (typeof step === 'string' && isStepKey(step)) out.step = step
  const head = p['head']
  if (isRec(head)) {
    const ref = head['ref']
    const commit = head['commit']
    out.head = {
      ref: typeof ref === 'string' ? ref : null,
      commit: typeof commit === 'string' ? commit : null,
    }
  }
  if (p['branchPrep'] === true) out.branchPrep = true
  return out
}

/**
 * R4 plan-end guard: Plan (a read-only pass) reported a write and the folder differs from `run-start`. No default:
 * the card waits for the user, Auto included.
 */
export function planMutatedCard(id: string, paths: readonly string[]): CardView {
  const n = paths.length
  const what = n === 0 ? 'files changed' : `${plural(n, 'file')} changed`
  return {
    id,
    kind: 'planMutated',
    title: 'Plan changed files',
    body:
      `The Plan step should only read, but ${what} while it ran${n > 0 ? `: ${pathList(paths)}` : ''}. ` +
      "Revert Plan's changes (you can undo that), or keep them.",
    payload: { step: 'plan', paths: [...paths] },
    blocking: true,
    choices: [
      { id: PLAN_MUTATED_CHOICE.revert, label: "Revert Plan's changes", primary: true },
      { id: PLAN_MUTATED_CHOICE.keep, label: 'Keep' },
    ],
  }
}

// ---- trust and verifyEnv (verify commands, trust and results) ------------------------------------------------

/** One command as the user would type it: argv joined, an argument with spaces or quotes in double quotes. */
export function commandLine(argv: readonly string[]): string {
  return argv.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
}

/** A line of a script body against the body a grant covered. */
export interface BodyDiffLine {
  op: 'same' | 'del' | 'add'
  text: string
}

/** Line diff (longest common subsequence) of the granted body against the current one; scripts are short. */
export function bodyDiff(before: string | null, after: string | null): BodyDiffLine[] {
  const a = before === null || before === '' ? [] : before.replace(/\r\n?/g, '\n').split('\n')
  const b = after === null || after === '' ? [] : after.replace(/\r\n?/g, '\n').split('\n')
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text) => ({ op: 'del' as const, text })),
      ...b.map((text) => ({ op: 'add' as const, text })),
    ]
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] =
        a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: BodyDiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    const ai = a[i]
    const bj = b[j]
    if (ai !== undefined && bj !== undefined && ai === bj) {
      out.push({ op: 'same', text: ai })
      i++
      j++
    } else if (ai !== undefined && (bj === undefined || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      // A removed line comes before the line that replaces it.
      out.push({ op: 'del', text: ai })
      i++
    } else if (bj !== undefined) {
      out.push({ op: 'add', text: bj })
      j++
    }
  }
  return out
}

/**
 * The steps a trust card belongs to: the verify rounds (verify:0 is the isolated run's baseline), and the security
 * advisor's scan (a dependency audit).
 */
type TrustRound = 'verify:0' | 'verify:red' | 'verify:1' | 'verify:2' | 'scan'

const isTrustRound = (v: unknown): v is TrustRound =>
  v === 'verify:0' || v === 'verify:1' || v === 'verify:2' || v === 'verify:red' || v === 'scan'

/** The trust card's payload (read back when a choice is made). */
export interface TrustCardPayload {
  step: TrustRound
  name: string
  argv: string[]
  cwdRel: string
  /** The command as one line. */
  command: string
  /** The script the grant's hash covers (null: none, e.g. a program run directly). */
  body: string | null
  trust: 'untrusted' | 'changed'
  /** `changed`: the body the earlier grant covered. */
  grantedBody?: string | null
  /** `changed`: the granted body against the current one, line by line. */
  diff?: BodyDiffLine[]
}

const whereRuns = (cwdRel: string): string =>
  cwdRel === '.' || cwdRel === '' ? 'in the project folder' : `in ${cwdRel}`

const roundWhen = (step: TrustRound): string =>
  step === 'scan'
    ? 'to audit the dependencies this run added or changed'
    : step === 'verify:0'
      ? 'in the isolated copy before the run changes anything (the baseline)'
      : step === 'verify:red'
        ? 'after the Tests step, to see the new tests fail'
        : step === 'verify:1'
          ? 'after Implement'
          : 'after Fix'

/**
 * "trust: Command + body (diff when changed) · [Trust for this project] [Skip]". Non-Auto only (Auto skips an
 * untrusted command with a `[should]` finding: Auto never implies trust), and never a default.
 */
export function trustCard(
  id: string,
  o: {
    step: TrustRound
    name: string
    argv: readonly string[]
    cwdRel: string
    body: string | null
    trust: 'untrusted' | 'changed'
    grantedBody?: string | null
  },
): CardView {
  const command = commandLine(o.argv)
  const payload: TrustCardPayload = {
    step: o.step,
    name: o.name,
    argv: [...o.argv],
    cwdRel: o.cwdRel,
    command,
    body: o.body,
    trust: o.trust,
  }
  const lines: string[] = []
  let title: string
  if (o.trust === 'changed') {
    const diff = bodyDiff(o.grantedBody ?? null, o.body)
    payload.grantedBody = o.grantedBody ?? null
    payload.diff = diff
    title = `The ${o.name} check changed since you trusted it`
    lines.push(
      `The script behind \`${command}\` changed since you trusted it, so ${o.step === 'scan' ? 'the security scan' : 'Verify'} does not run it until you trust it again.`,
      '',
      'Changes:',
      ...diff.filter((d) => d.op !== 'same').map((d) => `${d.op === 'del' ? '-' : '+'} ${d.text}`),
    )
  } else {
    title = `Trust the ${o.name} check?`
    lines.push(
      `${o.step === 'scan' ? 'The security scan' : 'Verify'} wants to run \`${command}\` ${whereRuns(o.cwdRel)} ${roundWhen(o.step)}. Dim Factory runs only the commands you trust for this project.`,
    )
    // A body of several lines (a package.json's scripts, a makefile) starts on its own line.
    if (o.body !== null && o.body !== '')
      lines.push('', o.body.includes('\n') ? `Script:\n${o.body}` : `Script: ${o.body}`)
  }
  lines.push('', 'Trust it to run it now and in later runs until its script changes, or skip it this round.')
  return {
    id,
    kind: 'trust',
    title,
    body: lines.join('\n'),
    payload,
    blocking: true,
    choices: [
      { id: TRUST_CHOICE.trust, label: 'Trust for this project', primary: true },
      { id: TRUST_CHOICE.skip, label: 'Skip' },
    ],
  }
}

/** A trust card's payload as it was built (undefined when it is not one). */
export function trustPayloadOf(view: CardView): TrustCardPayload | undefined {
  const p = view.payload
  if (view.kind !== 'trust' || !isRec(p)) return undefined
  const step = p['step']
  const name = p['name']
  if (!isTrustRound(step) || typeof name !== 'string') return undefined
  const body = p['body']
  return {
    step,
    name,
    argv: strs(p['argv']),
    cwdRel: typeof p['cwdRel'] === 'string' ? p['cwdRel'] : '.',
    command: typeof p['command'] === 'string' ? p['command'] : '',
    body: typeof body === 'string' ? body : null,
    trust: p['trust'] === 'changed' ? 'changed' : 'untrusted',
  }
}

/** One command the environment could not run (the verifyEnv card). */
export interface VerifyEnvCommand {
  name: string
  argv: string[]
  exitCode: number | null
  reason?: string
  excerpt?: string
}

/**
 * What a verifyEnv card is about: a verify round (verify:1 / verify:2), or `prepare`, the isolated run's
 * `isolation.verifyReady` check before Implement (a failure opens verifyEnv before Implement).
 */
export type VerifyEnvStep = 'verify:red' | 'verify:1' | 'verify:2' | 'prepare'

/** The verifyEnv card's payload. */
export interface VerifyEnvCardPayload {
  step: VerifyEnvStep
  commands: (VerifyEnvCommand & { command: string })[]
  /** The round could not run at all (why). */
  failure?: string
}

/**
 * "Environment failures are never findings" (127/9009, ENOENT, "not recognized", a missing module):
 * [Retry] [Skip verify]. The default (taken in Auto, with its note) is Skip verify, so an Auto run is not blocked.
 */
export function verifyEnvCard(
  id: string,
  o: { step: VerifyEnvStep; commands: readonly VerifyEnvCommand[]; failure?: string },
): CardView {
  const commands = o.commands.map((c) => ({ ...c, argv: [...c.argv], command: commandLine(c.argv) }))
  const payload: VerifyEnvCardPayload = { step: o.step, commands }
  let title: string
  const lines: string[] = []
  if (o.failure !== undefined) {
    payload.failure = o.failure
    title = 'Verify could not run'
    lines.push(`Verify could not run: ${o.failure}`, '', 'Retry, or skip verify to go on without it.')
  } else if (o.step === 'prepare') {
    // `isolation.verifyReady`: checked in the isolated copy after its dependencies, before Implement.
    const first = commands[0]
    title =
      commands.length === 1 && first !== undefined
        ? `The ${first.name} check cannot run in the isolated copy`
        : `${plural(commands.length, 'check')} cannot run in the isolated copy`
    lines.push(
      'Verify checks the run later, but these checks cannot start in the isolated copy (their program was not found there):',
      ...commands.map((c) => `- ${c.name} (\`${c.command}\`): ${c.reason ?? 'its program was not found'}`),
      '',
      'Fix the environment and retry, or skip verify to go on (these checks are then reported as not run).',
    )
  } else {
    const first = commands[0]
    title =
      commands.length === 1 && first !== undefined
        ? `The ${first.name} check could not run`
        : `${plural(commands.length, 'check')} could not run`
    lines.push(
      'These checks could not run in this environment (a missing program or module, for example), so they are not findings:',
      ...commands.map((c) => {
        const why = c.reason ?? (c.exitCode !== null ? `exit ${c.exitCode}` : 'it did not start')
        return `- ${c.name} (\`${c.command}\`): ${why}`
      }),
      '',
      'Fix the environment and retry, or skip verify to go on without them.',
    )
  }
  return {
    id,
    kind: 'verifyEnv',
    title,
    body: lines.join('\n'),
    payload,
    blocking: true,
    defaultChoice: VERIFY_ENV_CHOICE.skipVerify,
    choices: [
      { id: VERIFY_ENV_CHOICE.retry, label: 'Retry', primary: true },
      { id: VERIFY_ENV_CHOICE.skipVerify, label: 'Skip verify' },
    ],
  }
}

/** The verify round (or `prepare`, the readiness check) a verifyEnv card belongs to (undefined when not one). */
export function verifyEnvStepOf(view: CardView): VerifyEnvStep | undefined {
  const p = view.payload
  if (view.kind !== 'verifyEnv' || !isRec(p)) return undefined
  const step = p['step']
  return step === 'verify:1' || step === 'verify:2' || step === 'prepare' || step === 'verify:red'
    ? step
    : undefined
}

// ---- Test-first: testsNotRed ---------------------------------------------------------------------------------------

/** The testsNotRed card's payload. */
export interface TestsNotRedPayload {
  step: 'verify:red'
  /** Some check ran (and passed); false: none ran, so nothing could fail. */
  ran: boolean
  /** The checks that passed. */
  passed: string[]
  /** The Tests step's attempt the check ran after. */
  attempt: number
}

/**
 * Test-first: the red check found no failing command, so the new tests were not seen failing before Implement.
 * [Rewrite the tests] sends the Tests step back with why; [Continue anyway]; [Stop run]. The default (Auto) is one
 * rewrite when a check ran, then Continue anyway.
 */
export function testsNotRedCard(
  id: string,
  o: { ran: boolean; passed: readonly string[]; attempt: number; rewrite: boolean },
): CardView {
  const payload: TestsNotRedPayload = {
    step: 'verify:red',
    ran: o.ran,
    passed: [...o.passed],
    attempt: o.attempt,
  }
  const body = o.ran
    ? [
        `Test-first needs the new tests to fail before Implement, but every check passed: ${o.passed.join(', ')}.`,
        'The tests may not cover the planned change yet, or the checks may not run them.',
        '',
        'Rewrite the tests (the Tests step gets this result and tries again), continue anyway, or stop the run.',
      ]
    : [
        'No check ran after the Tests step, so Dim Factory could not see the new tests fail.',
        '',
        'Rewrite the tests, continue anyway, or stop the run.',
      ]
  return {
    id,
    kind: 'testsNotRed',
    title: o.ran ? 'The new tests already pass' : 'The new tests were not run',
    body: body.join('\n'),
    payload,
    blocking: true,
    defaultChoice: o.rewrite ? TESTS_NOT_RED_CHOICE.rewrite : TESTS_NOT_RED_CHOICE.continue,
    choices: [
      { id: TESTS_NOT_RED_CHOICE.rewrite, label: 'Rewrite the tests', primary: true },
      { id: TESTS_NOT_RED_CHOICE.continue, label: 'Continue anyway' },
      { id: TESTS_NOT_RED_CHOICE.stop, label: 'Stop run', danger: true },
    ],
  }
}

/** The Clarify card's payload: the questions, each with its options (the card adds "Other" free text to each). */
export interface ClarifyPayload {
  step: 'clarify'
  questions: ClarifyQuestion[]
}

/** The Clarify card's payload, or undefined for another card. */
export function clarifyPayloadOf(card: CardView): ClarifyPayload | undefined {
  if (card.kind !== 'clarify') return undefined
  const p = card.payload as Partial<ClarifyPayload> | null
  return p !== null && typeof p === 'object' && Array.isArray(p.questions) ? (p as ClarifyPayload) : undefined
}

/**
 * Clarify's questions before Plan: answer inline (an option or "Other" text per question; any question may be left
 * unanswered) or skip them all. Blocking with no default, so it waits even in Auto.
 */
export function clarifyCard(id: string, o: { questions: readonly ClarifyQuestion[] }): CardView {
  const n = o.questions.length
  const payload: ClarifyPayload = {
    step: 'clarify',
    questions: o.questions.map((q) => ({ question: q.question, options: [...q.options] })),
  }
  return {
    id,
    kind: 'clarify',
    title: n === 1 ? 'One question before Plan' : `${n} questions before Plan`,
    body: [
      'Your answers join the brief that Plan, Implement and the reviewers read.',
      'Pick an option or write your own for each question. Leave any of them blank and Plan decides it.',
    ].join('\n'),
    payload,
    blocking: true,
    choices: [
      { id: CLARIFY_CHOICE.answer, label: 'Use these answers', primary: true, input: 'answers' },
      { id: CLARIFY_CHOICE.skip, label: 'Skip questions' },
    ],
  }
}

/** The research card's payload, or undefined for another card. */
export function researchPayloadOf(card: CardView): ResearchPayload | undefined {
  if (card.kind !== 'research') return undefined
  const p = card.payload as Partial<ResearchPayload> | null
  return p !== null && typeof p === 'object' && p.result !== undefined && Array.isArray(p.suggested)
    ? (p as ResearchPayload)
    : undefined
}

/**
 * Research's review before Plan (like the catalog's diff review): tick the features, standards and recommendations Plan
 * gets, answer open questions inline, or plan without it. Blocking; its default (Auto) keeps the must-haves and every
 * recommendation and answers no question.
 */
export function researchCard(id: string, o: { result: ResearchResult; web: boolean }): CardView {
  const r = o.result
  const items = r.features.length + r.standards.length + r.options.length
  const payload: ResearchPayload = {
    step: 'research',
    result: structuredClone(r),
    suggested: autoResearchChoice(r),
    web: o.web,
  }
  return {
    id,
    kind: 'research',
    title: 'Review the research',
    body: [
      `Research found ${plural(items, 'item')} with sources${r.questions.length > 0 ? ` and ${plural(r.questions.length, 'open question')}` : ''}.`,
      'Tick what Plan should build in; the must-haves and recommendations are ticked to start. Web content is untrusted: check the sources you rely on.',
    ].join('\n'),
    payload,
    blocking: true,
    defaultChoice: RESEARCH_CHOICE.use,
    choices: [
      { id: RESEARCH_CHOICE.use, label: 'Use selected', primary: true, input: 'research' },
      { id: RESEARCH_CHOICE.skip, label: 'Plan without research' },
    ],
  }
}

// ---- isolated runs (worktree): depsConsent / depsFailed (command + streamed output), finalize / finalizeConflicts /
// interruptedApply ------------------------------------------------------------------------------------------------

/** What the deps cards show about the install command (the PrepareCard streams its output). */
export interface DepsCardInput {
  manager: string
  argv: readonly string[]
  cwdRel: string
  lockfile?: string
  source: 'detected' | 'config' | 'edited'
}

function depsPayload(d: DepsCardInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    step: 'prepare',
    command: commandLine(d.argv),
    argv: [...d.argv],
    manager: d.manager,
    cwdRel: d.cwdRel,
    source: d.source,
    configured: d.source === 'config',
  }
  if (d.lockfile !== undefined) out['lockfile'] = d.lockfile
  return out
}

/** Where the install command came from, as card copy. */
function depsOrigin(d: DepsCardInput): string {
  if (d.source === 'config') return "from this project's install command setting"
  if (d.source === 'edited') return 'as you edited it'
  return d.lockfile !== undefined ? `from ${d.lockfile}` : `for ${d.manager}`
}

/**
 * Dependency step: with `install: 'ask'` and no `deps` grant (or one for another lockfile), [Install] (writes the grant,
 * then installs) · [Edit command] (`input: 'command'`) · [Skip install]. The default, taken in Auto with its note, is
 * Skip install: Auto never trusts a command on its own.
 */
export function depsConsentCard(
  id: string,
  o: { deps: DepsCardInput; trust: 'untrusted' | 'changed' | 'invalid'; reason?: string },
): CardView {
  const command = commandLine(o.deps.argv)
  const where = whereRuns(o.deps.cwdRel).replace('the project folder', 'the isolated copy')
  const lines = [
    `The isolated copy starts without your installed dependencies. Dim Factory wants to run \`${command}\` ${where} (${depsOrigin(o.deps)}).`,
  ]
  if (o.trust === 'changed')
    lines.push(
      '',
      'You trusted an install like this before, but the files it installs from changed since then.',
    )
  if (o.reason !== undefined && o.reason !== '') lines.push('', o.reason)
  lines.push(
    '',
    'Install trusts it for this project and runs it. Skip install goes on without dependencies (checks that need them may not run).',
  )
  return {
    id,
    kind: 'depsConsent',
    title: 'Install dependencies in the isolated copy?',
    body: lines.join('\n'),
    payload: { ...depsPayload(o.deps), trust: o.trust },
    blocking: true,
    defaultChoice: DEPS_CHOICE.skipInstall,
    choices: [
      { id: DEPS_CHOICE.install, label: 'Install', primary: true },
      { id: DEPS_CHOICE.editCommand, label: 'Edit command', input: 'command' },
      { id: DEPS_CHOICE.skipInstall, label: 'Skip install' },
    ],
  }
}

/**
 * An install that failed (or could not run, or could not be read): [Retry] [Edit command] [Skip install]
 * [Cancel]. The default, taken in Auto with its note, is Skip install, as verifyEnv's is Skip verify.
 */
export function depsFailedCard(
  id: string,
  o: {
    deps?: DepsCardInput
    exitCode?: number | null
    timedOut?: boolean
    reason?: string
    excerpt?: string
  },
): CardView {
  const d = o.deps
  const command = d !== undefined ? commandLine(d.argv) : ''
  const how =
    o.timedOut === true
      ? 'timed out'
      : o.exitCode !== undefined && o.exitCode !== null
        ? `failed (exit ${o.exitCode})`
        : 'could not run'
  const lines = [
    d !== undefined
      ? `Installing dependencies in the isolated copy ${how}: \`${command}\`.`
      : 'Dim Factory could not work out how to install the dependencies in the isolated copy.',
  ]
  if (o.reason !== undefined && o.reason !== '') lines.push('', o.reason)
  lines.push(
    '',
    'Retry it, edit the command, or skip install to go on without dependencies (checks that need them may not run).',
  )
  const payload: Record<string, unknown> = d !== undefined ? depsPayload(d) : { step: 'prepare' }
  if (o.exitCode !== undefined) payload['exitCode'] = o.exitCode
  if (o.timedOut === true) payload['timedOut'] = true
  if (o.reason !== undefined) payload['reason'] = o.reason
  if (o.excerpt !== undefined && o.excerpt !== '') payload['excerpt'] = o.excerpt
  return {
    id,
    kind: 'depsFailed',
    title: d !== undefined ? 'Installing dependencies failed' : 'Dependencies could not be installed',
    body: lines.join('\n'),
    payload,
    blocking: true,
    defaultChoice: DEPS_CHOICE.skipInstall,
    choices: [
      { id: DEPS_CHOICE.retry, label: 'Retry', primary: true },
      { id: DEPS_CHOICE.editCommand, label: 'Edit command', input: 'command' },
      { id: DEPS_CHOICE.skipInstall, label: 'Skip install' },
      { id: DEPS_CHOICE.cancel, label: 'Cancel run', danger: true },
    ],
  }
}

/** A conflicting file as the finalize cards list it. */
export interface ConflictFileInput {
  path: string
  reason?: string
}

/**
 * R12 (finalize): [Apply to folder] [Keep for later] [Discard] (deletion deferred 10 s; undoable). The
 * default, taken in Auto with its note, is Keep for later: Auto writes the folder only with `autoApply` and no
 * conflicts, which applies without this card.
 */
export function finalizeCard(
  id: string,
  o: {
    folder: string
    branch?: string
    files?: number
    conflicts: readonly ConflictFileInput[]
    error?: string
  },
): CardView {
  const lines: string[] = []
  const copy = o.branch !== undefined ? `an isolated copy (branch ${o.branch})` : 'an isolated copy'
  lines.push(
    o.files === undefined
      ? `The run worked in ${copy}. Its changes are not in your folder yet.`
      : o.files === 0
        ? `The run worked in ${copy} and changed no files there.`
        : `The run worked in ${copy} and changed ${plural(o.files, 'file')} there. They are not in your folder yet.`,
  )
  if (o.conflicts.length > 0)
    lines.push(
      '',
      `${plural(o.conflicts.length, 'file')} also changed in your folder since the run started (${pathList(o.conflicts.map((c) => c.path))}). Apply leaves ${o.conflicts.length === 1 ? 'it' : 'them'} as ${o.conflicts.length === 1 ? 'it is' : 'they are'} and asks you about ${o.conflicts.length === 1 ? 'it' : 'each'}.`,
    )
  if (o.error !== undefined && o.error !== '') lines.push('', o.error)
  lines.push(
    '',
    `Apply to folder copies the changes into ${o.folder} (you can undo it). Keep for later leaves the isolated copy as it is. Discard deletes it in 10 seconds (you can undo that).`,
  )
  const payload: Record<string, unknown> = {
    step: 'finalize',
    folder: o.folder,
    conflicts: o.conflicts.map((c) => ({ ...c })),
  }
  if (o.files !== undefined) payload['files'] = o.files
  if (o.branch !== undefined) payload['branch'] = o.branch
  return {
    id,
    kind: 'finalize',
    title: 'Apply the run to your folder?',
    body: lines.join('\n'),
    payload,
    blocking: true,
    defaultChoice: FINALIZE_CHOICE.keep,
    choices: [
      { id: FINALIZE_CHOICE.apply, label: 'Apply to folder', primary: true },
      { id: FINALIZE_CHOICE.keep, label: 'Keep for later' },
      { id: FINALIZE_CHOICE.discard, label: 'Discard', danger: true },
    ],
  }
}

/**
 * Apply table, "anything else: conflict → [Keep mine] / [Take run's]": the files whose folder content is
 * neither the run's base nor its result. Each choice takes the files it applies to (`input: 'paths'`; every listed
 * file when absent). No default: a file in the folder is never overwritten without [Take run's], Auto included.
 */
export function finalizeConflictsCard(id: string, conflicts: readonly ConflictFileInput[]): CardView {
  const n = conflicts.length
  const lines = [
    `${n === 1 ? 'This file' : 'These files'} changed in your folder since the run started, so Apply left ${n === 1 ? 'it' : 'them'} as ${n === 1 ? 'it is' : 'they are'}:`,
    ...conflicts
      .slice(0, CARD_PATHS_MAX)
      .map((c) => `- ${c.path}${c.reason !== undefined && c.reason !== '' ? ` (${c.reason})` : ''}`),
  ]
  if (n > CARD_PATHS_MAX) lines.push(`- and ${n - CARD_PATHS_MAX} more`)
  lines.push(
    '',
    "Keep mine leaves your version. Take run's writes the run's version over it (Undo of the apply puts yours back).",
  )
  const files = conflicts.map((c) => ({ ...c }))
  return {
    id,
    kind: 'finalizeConflicts',
    title:
      n === 1
        ? `${conflicts[0]?.path ?? 'A file'} changed in your folder too`
        : `${n} files changed in your folder too`,
    body: lines.join('\n'),
    payload: { step: 'finalize', files, conflicts: files },
    blocking: true,
    choices: [
      { id: CONFLICT_CHOICE.keepMine, label: 'Keep mine', primary: true, input: 'paths' },
      { id: CONFLICT_CHOICE.takeTheirs, label: "Take run's", input: 'paths' },
    ],
  }
}

/**
 * Dim Factory closed (or the apply failed) part way through applying; the journal in run.json lets [Finish
 * apply] carry on without writing a file twice. No default (never auto-resume).
 */
export function interruptedApplyCard(
  id: string,
  o: { files?: number; applied?: number; error?: string },
): CardView {
  const lines = [
    o.error !== undefined && o.error !== ''
      ? `Applying the run to your folder stopped part way: ${o.error}`
      : 'Dim Factory closed while it was applying the run to your folder, so some files may be written and others not yet.',
    '',
    'Finish apply carries on where it stopped (files already written are not written again). After it you can still undo the apply.',
  ]
  const payload: Record<string, unknown> = { step: 'finalize' }
  if (o.applied !== undefined) payload['applied'] = o.applied
  if (o.files !== undefined) {
    payload['files'] = o.files
    if (o.applied !== undefined) payload['remaining'] = Math.max(0, o.files - o.applied)
  }
  if (o.error !== undefined) payload['error'] = o.error
  return {
    id,
    kind: 'interruptedApply',
    title: 'Finish applying the run',
    body: lines.join('\n'),
    payload,
    blocking: true,
    choices: [{ id: INTERRUPTED_APPLY_CHOICE.finish, label: 'Finish apply', primary: true }],
  }
}

const isMutating = (p: AgentStep): boolean => p === 'implement' || p === 'fix' || p === 'tests'

/** Categories whose primary recovery is "Resume" when a session exists. */
const RESUMABLE = new Set<string>(['timeout_hard', 'ask_timeout', 'permission_denied', 'turn_limit'])

/**
 * Default snag buttons until heal/recovery.ts materializes the category's own: Resume (mutating, session, resumable
 * category) · Retry · Continue without (not Implement) · Close run. Ids are `<step>:<action>` / `run:close`.
 */
export function defaultSnagActions(step: StepKey, failure: Failure, info: SnagInfo): RecoveryAction[] {
  const out: RecoveryAction[] = []
  if (isAgentStep(step)) {
    if (info.hasSession && isMutating(step) && RESUMABLE.has(failure.category)) {
      out.push({ id: `${step}:resume`, label: 'Resume', kind: 'retry', strategy: 'resume' })
    }
    // A pass stopped for repeating itself would loop again in the same session: its retry starts fresh.
    if (failure.category === 'runaway_loop')
      out.push({ id: `${step}:retry`, label: 'Retry in a fresh session', kind: 'retry', strategy: 'fresh' })
    else out.push({ id: `${step}:retry`, label: 'Retry', kind: 'retry', strategy: 'auto' })
    if (step !== 'implement') {
      out.push({
        id: `${step}:skip`,
        label: `Continue without ${stepLabel(step)}`,
        kind: 'skip_pass',
        pass: step,
      })
    }
  }
  out.push({ id: 'run:close', label: 'Close run', kind: 'close_run' })
  return out
}
