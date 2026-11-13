// Readers for CardView payloads (shapes from core supervisor/cards.ts).
// Payload is `unknown` on the wire, so each reader checks what it uses and falls back to the card's own text.
// Choice ids are core's stable API (CHOICE in cards.ts; tests/renderer/run/text.test.ts keeps them equal).
import type { RecoveryAction } from '@shared/failure.ts'
import { RECOVERY_ACTION_KINDS } from '@shared/failure.ts'
import type { Finding, FindingSource, SourceParseStatus } from '@shared/findings.ts'
import { SOURCE_PARSE_STATUSES } from '@shared/findings.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { CardChoice, CardView, ClarifyQuestion } from '@shared/run.ts'
import type { ResearchPayload, ResearchPriority, ResearchResult } from '@shared/research.ts'
import { formatCommandLine } from '../run/text.ts'

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
  continueFix: 'continue',
  skipFix: 'skip-fix',
  retry: 'retry',
  treatAsNone: 'treat-as-none',
} as const

const rec = (p: unknown): Record<string, unknown> =>
  typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined

/** gate:afterPlan: the plan markdown. */
export function planOf(card: CardView): string {
  const p = rec(card.payload)['plan']
  return typeof p === 'string' ? p : card.body
}

/** insufficientContext: the task as the run has it. */
export function taskOf(card: CardView): string {
  const t = rec(card.payload)['task']
  return typeof t === 'string' ? t : ''
}

function isFinding(v: unknown): v is Finding {
  const f = rec(v)
  return (
    typeof f['id'] === 'string' &&
    typeof f['n'] === 'number' &&
    (f['severity'] === 'must' || f['severity'] === 'should') &&
    typeof f['source'] === 'string' &&
    typeof f['title'] === 'string'
  )
}

/** gate:beforeFix: every finding (must first, numbered), the default selection and core's notes. */
export function gateFindings(card: CardView): { findings: Finding[]; selected: string[]; notes: string[] } {
  const p = rec(card.payload)
  const findings = Array.isArray(p['findings']) ? p['findings'].filter(isFinding) : []
  return {
    findings,
    selected: strings(p['selected']) ?? findings.map((f) => f.id),
    notes: strings(p['notes']) ?? [],
  }
}

/**
 * One reviewer's part of core's findings.json (FindingsFile, read through runs.output): its parse status and its
 * findings in core's order and numbering. null when the text is not that file or has nothing for this reviewer yet.
 */
export function reviewerFindings(
  text: string,
  source: FindingSource,
): { status: SourceParseStatus; findings: Finding[] } | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const d = rec(doc)
  const status = rec(rec(d['sources'])[source])['status']
  if (typeof status !== 'string' || !(SOURCE_PARSE_STATUSES as readonly string[]).includes(status))
    return null
  const all = Array.isArray(d['findings']) ? d['findings'].filter(isFinding) : []
  return { status: status as SourceParseStatus, findings: all.filter((f) => f.source === source) }
}

function isCheck(v: unknown): v is CheckResult {
  const c = rec(v)
  return typeof c['id'] === 'string' && typeof c['title'] === 'string' && Array.isArray(c['recovery'])
}

/** preflight: the blocking checks with their recovery actions, and the warnings. */
export function preflightChecks(card: CardView): { blocking: CheckResult[]; warnings: CheckResult[] } {
  const p = rec(card.payload)
  const list = (v: unknown): CheckResult[] => (Array.isArray(v) ? v.filter(isCheck) : [])
  return { blocking: list(p['blocking']), warnings: list(p['warnings']) }
}

/** Text a generic `input` choice starts from (the payload's plan/task/command, else nothing). */
export function inputSeed(card: CardView, input: 'plan' | 'task' | 'command'): string {
  const v = rec(card.payload)[input]
  return typeof v === 'string' ? v : ''
}

// ---- reconcile and planMutated (core's reconciliation and plan-end guard) -----------------------------------------

function isAction(v: unknown): v is RecoveryAction {
  const a = rec(v)
  return (
    typeof a['id'] === 'string' &&
    typeof a['label'] === 'string' &&
    typeof a['kind'] === 'string' &&
    (RECOVERY_ACTION_KINDS as readonly string[]).includes(a['kind'])
  )
}

/** Paths from a list of strings or of `{path}` objects (a FileChange, a core path record); empty ones dropped. */
function pathsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    const p = typeof x === 'string' ? x : rec(x)['path']
    if (typeof p === 'string' && p !== '') out.push(p)
  }
  return out
}

/** The first of `keys` in `o` that holds a list of paths. */
function firstPaths(o: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const k of keys) {
    const p = pathsOf(o[k])
    if (p.length > 0) return p
  }
  return []
}

export type ReconcileSeverity = 'block' | 'choice' | 'info'

/** One row of core's reconciliation table that applies now, in plain words. */
export interface ReconcileReasonView {
  row: string
  severity: ReconcileSeverity
  title: string
  detail: string
  /** Core's actions for it (the copyable `git <op> --abort`), run through recovery.execute. */
  actions: RecoveryAction[]
  /** Commands core wrote as text only, without an action of their own: copied by the renderer. */
  commands: string[]
}

export interface ReconcileView {
  reasons: ReconcileReasonView[]
  /** Paths changed outside the run since its last snapshot. */
  external: string[]
  /** The external paths the run changed too. */
  overlapping: string[]
  /** Actions core put on the card itself rather than on one reason. */
  actions: RecoveryAction[]
}

const SEVERITIES: readonly ReconcileSeverity[] = ['block', 'choice', 'info']

/** A reason's commands: core's actions, and plain commands (`{command}` records or strings) as text. */
function reasonCommands(r: Record<string, unknown>): { actions: RecoveryAction[]; commands: string[] } {
  const actions: RecoveryAction[] = []
  const commands: string[] = []
  for (const key of ['actions', 'recovery', 'commands']) {
    const list = r[key]
    if (!Array.isArray(list)) continue
    for (const x of list) {
      if (isAction(x)) actions.push(x)
      else if (typeof x === 'string' && x.trim() !== '') commands.push(x)
      else {
        const c = rec(x)['command']
        if (typeof c === 'string' && c.trim() !== '') commands.push(c)
      }
    }
  }
  // A command core offers as an action is not repeated as text.
  const offered = new Set(actions.flatMap((a) => (a.kind === 'shell_copy' ? [a.command] : [])))
  return { actions, commands: commands.filter((c) => !offered.has(c)) }
}

/**
 * reconcile (core git/reconcile.ts ReconcileResult in the payload): the table rows that apply, the external and
 * overlapping paths, and any actions. Rows or paths core left out read as empty; the card's body then says it.
 */
export function reconcileOf(card: CardView): ReconcileView {
  const p = rec(card.payload)
  const reasons: ReconcileReasonView[] = []
  if (Array.isArray(p['reasons'])) {
    for (const x of p['reasons']) {
      const r = rec(x)
      const title = r['title']
      if (typeof title !== 'string' || title === '') continue
      const sev = r['severity']
      const detail = r['detail']
      reasons.push({
        row: typeof r['row'] === 'string' ? r['row'] : '',
        severity: SEVERITIES.includes(sev as ReconcileSeverity) ? (sev as ReconcileSeverity) : 'info',
        title,
        detail: typeof detail === 'string' ? detail : '',
        ...reasonCommands(r),
      })
    }
  }
  const paths = rec(p['paths'])
  const external = pathsOf(paths['external'] ?? p['external'])
  const overlapping = pathsOf(paths['overlapping'] ?? p['overlapping'])
  const own = Array.isArray(p['actions']) ? p['actions'].filter(isAction) : []
  const recovery = Array.isArray(p['recovery']) ? p['recovery'].filter(isAction) : []
  return { reasons, external, overlapping, actions: [...own, ...recovery] }
}

/** planMutated: the files the Plan step changed (the payload's `paths`, `files` or `changed`). */
export function planChangedPaths(card: CardView): string[] {
  return firstPaths(rec(card.payload), ['paths', 'files', 'changed'])
}

/**
 * Core's choices with the card's default as the one primary button (Auto takes `defaultChoice`, so it is
 * what the user is offered first). A card without a default keeps core's own primary flags.
 */
export function choicesWithDefault(card: CardView): CardChoice[] {
  const d = card.defaultChoice
  if (d === undefined || !card.choices.some((c) => c.id === d)) return card.choices
  return card.choices.map((c) => ({ ...c, primary: c.id === d }))
}

// ---- trust and verifyEnv (verify commands and their trust, environment failures) -----------------------------------

/** Core's trust and verifyEnv choice ids (supervisor/cards.ts TRUST_CHOICE, VERIFY_ENV_CHOICE). */
export const TRUST_CHOICE = { trust: 'trust', skip: 'skip' } as const
export const VERIFY_ENV_CHOICE = { retry: 'retry', skipVerify: 'skip-verify' } as const

/** A line of a script body against the body an earlier grant covered. */
export interface BodyDiffLine {
  op: 'same' | 'del' | 'add'
  text: string
}

export interface TrustCardData {
  name: string
  /** The command as one line (core's, else argv joined). */
  command: string
  argv: string[]
  cwdRel: string
  /** The script the grant's hash covers; null when there is none (a program run directly). */
  body: string | null
  /** `changed`: the script changed since the user trusted it; `untrusted`: never trusted. */
  trust: 'untrusted' | 'changed'
  /** `changed`: what the earlier grant covered. */
  grantedBody: string | null
  /** `changed`: core's line diff of the granted body against the current one (empty when core sent none). */
  diff: BodyDiffLine[]
}

const DIFF_OPS: readonly BodyDiffLine['op'][] = ['same', 'del', 'add']

function diffOf(v: unknown): BodyDiffLine[] {
  if (!Array.isArray(v)) return []
  const out: BodyDiffLine[] = []
  for (const x of v) {
    const d = rec(x)
    const op = d['op']
    const text = d['text']
    if (typeof text === 'string' && DIFF_OPS.includes(op as BodyDiffLine['op']))
      out.push({ op: op as BodyDiffLine['op'], text })
  }
  return out
}

/** trust (core TrustCardPayload): the command, where it runs, and its script (with the diff when it changed). */
export function trustOf(card: CardView): TrustCardData {
  const p = rec(card.payload)
  const cmd = rec(p['command'])
  const argv = strings(p['argv']) ?? strings(cmd['argv']) ?? []
  const command =
    typeof p['command'] === 'string' && p['command'] !== ''
      ? p['command']
      : argv.length > 0
        ? formatCommandLine(argv)
        : ''
  const name = typeof p['name'] === 'string' ? p['name'] : typeof cmd['name'] === 'string' ? cmd['name'] : ''
  const cwdRel =
    typeof p['cwdRel'] === 'string' ? p['cwdRel'] : typeof cmd['cwdRel'] === 'string' ? cmd['cwdRel'] : '.'
  const body = typeof p['body'] === 'string' ? p['body'] : null
  const grantedBody = typeof p['grantedBody'] === 'string' ? p['grantedBody'] : null
  const trust = p['trust'] === 'changed' || p['changed'] === true ? 'changed' : 'untrusted'
  return { name, command, argv, cwdRel, body, trust, grantedBody, diff: diffOf(p['diff']) }
}

/** One command the environment could not run (core VerifyEnvCommand). */
export interface VerifyEnvCommandData {
  name: string
  command: string
  exitCode: number | null
  reason: string | null
  excerpt: string | null
}

/** verifyEnv (core VerifyEnvCardPayload): the commands that could not run, or why the round could not run at all. */
export function verifyEnvOf(card: CardView): {
  commands: VerifyEnvCommandData[]
  failure: string | null
  actions: RecoveryAction[]
} {
  const p = rec(card.payload)
  const commands: VerifyEnvCommandData[] = []
  if (Array.isArray(p['commands'])) {
    for (const x of p['commands']) {
      const c = rec(x)
      const argv = strings(c['argv']) ?? []
      const name = typeof c['name'] === 'string' ? c['name'] : ''
      const command =
        typeof c['command'] === 'string' && c['command'] !== ''
          ? c['command']
          : argv.length > 0
            ? formatCommandLine(argv)
            : name
      if (name === '' && command === '') continue
      const exit = c['exitCode']
      commands.push({
        name: name !== '' ? name : command,
        command,
        exitCode: typeof exit === 'number' ? exit : null,
        reason: typeof c['reason'] === 'string' && c['reason'] !== '' ? c['reason'] : null,
        excerpt: typeof c['excerpt'] === 'string' && c['excerpt'] !== '' ? c['excerpt'] : null,
      })
    }
  }
  const failure = typeof p['failure'] === 'string' && p['failure'] !== '' ? p['failure'] : null
  const actions = [
    ...(Array.isArray(p['actions']) ? p['actions'].filter(isAction) : []),
    ...(Array.isArray(p['recovery']) ? p['recovery'].filter(isAction) : []),
  ]
  return { commands, failure, actions }
}

/** A card body's paragraphs (split at blank lines), for a lead and a closing line around structured content. */
export function paragraphs(body: string): string[] {
  return body
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

// ---- isolated runs (a run in its own worktree) --------------------------------------------------------------------

/** Core's depsConsent / depsFailed choice ids (supervisor/cards.ts DEPS_CHOICE). */
export const DEPS_CHOICE = {
  install: 'install',
  editCommand: 'edit-command',
  skipInstall: 'skip-install',
  retry: 'retry',
  cancel: 'cancel',
} as const

/** Core's finalize choice ids (supervisor/cards.ts FINALIZE_CHOICE). */
export const FINALIZE_CHOICE = { apply: 'apply', keep: 'keep', discard: 'discard' } as const

/** Core's finalizeConflicts choice ids (supervisor/cards.ts CONFLICT_CHOICE): each takes `input: 'paths'`. */
export const CONFLICT_CHOICE = { keepMine: 'keep-mine', takeTheirs: 'take-theirs' } as const

/** Core's interruptedApply choice id (supervisor/cards.ts INTERRUPTED_APPLY_CHOICE). */
export const INTERRUPTED_APPLY_CHOICE = { finish: 'finish-apply' } as const

// ---- testsNotRed (Test-first's red check found no failing command) --------------------------------------------------

/** Core's testsNotRed choice ids. */
export const TESTS_NOT_RED_CHOICE = { rewrite: 'rewrite', continue: 'continue', stop: 'stop' } as const

/**
 * testsNotRed: whether the red check ran its commands, the commands that passed (they should have failed), and the
 * Tests attempt it checked.
 */
export function testsNotRedOf(card: CardView): { ran: boolean; passed: string[]; attempt: number | null } {
  const p = rec(card.payload)
  const attempt = p['attempt']
  return {
    ran: p['ran'] !== false,
    passed: strings(p['passed']) ?? [],
    attempt: typeof attempt === 'number' && Number.isFinite(attempt) ? attempt : null,
  }
}

// ---- clarify (questions before Plan) -------------------------------------------------------------------------------

/** Core's clarify choice ids (supervisor/cards.ts CLARIFY_CHOICE): `answer` takes `input: 'answers'`. */
export const CLARIFY_CHOICE = { answer: 'answer', skip: 'skip' } as const

/** clarify: the questions, each with its options (the card adds "Other" free text and "Leave it to Plan"). */
export function clarifyOf(card: CardView): ClarifyQuestion[] {
  const qs = rec(card.payload)['questions']
  if (!Array.isArray(qs)) return []
  const out: ClarifyQuestion[] = []
  for (const x of qs) {
    const q = rec(x)
    const question = q['question']
    if (typeof question !== 'string' || question === '') continue
    out.push({ question, options: strings(q['options']) ?? [] })
  }
  return out
}

// ---- research (the review before Plan) ------------------------------------------------------------------------------

/** Core's research choice ids (supervisor/cards.ts RESEARCH_CHOICE): `use` takes `input: 'research'`. */
export const RESEARCH_CHOICE = { use: 'use', skip: 'skip' } as const

const cited = (v: unknown): string[] => strings(v) ?? []
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const PRIORITIES: readonly ResearchPriority[] = ['must', 'should', 'could']

/** research: the parsed, cited answer, the ids ticked to start (Auto's choice) and whether it searched the web. */
export function researchOf(card: CardView): ResearchPayload | null {
  const p = rec(card.payload)
  const r = rec(p['result'])
  if (p['result'] === undefined) return null
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : [])
  const result: ResearchResult = {
    summary: cited(r['summary']),
    features: list(r['features'])
      .filter((x) => text(x['id']) !== '' && text(x['feature']) !== '')
      .map((x) => {
        const pr = x['priority']
        return {
          id: text(x['id']),
          feature: text(x['feature']),
          priority: PRIORITIES.includes(pr as ResearchPriority) ? (pr as ResearchPriority) : 'should',
          sources: cited(x['sources']),
        }
      }),
    standards: list(r['standards'])
      .filter((x) => text(x['id']) !== '' && text(x['standard']) !== '')
      .map((x) => ({
        id: text(x['id']),
        standard: text(x['standard']),
        ...(text(x['why']) !== '' ? { why: text(x['why']) } : {}),
        sources: cited(x['sources']),
      })),
    options: list(r['options'])
      .filter((x) => text(x['id']) !== '' && text(x['topic']) !== '')
      .map((x) => ({
        id: text(x['id']),
        topic: text(x['topic']),
        options: cited(x['options']),
        recommendation: text(x['recommendation']),
        rationale: text(x['rationale']),
        sources: cited(x['sources']),
      })),
    risks: list(r['risks'])
      .filter((x) => text(x['risk']) !== '')
      .map((x) => ({ id: text(x['id']), risk: text(x['risk']), sources: cited(x['sources']) })),
    questions: list(r['questions'])
      .filter((x) => text(x['id']) !== '' && text(x['question']) !== '')
      .map((x) => ({ id: text(x['id']), question: text(x['question']) })),
    sources: list(r['sources'])
      .filter((x) => text(x['url']) !== '')
      .map((x) => ({ url: text(x['url']), ...(text(x['title']) !== '' ? { title: text(x['title']) } : {}) })),
    dropped: typeof r['dropped'] === 'number' && Number.isFinite(r['dropped']) ? r['dropped'] : 0,
  }
  return { step: 'research', result, suggested: cited(p['suggested']), web: p['web'] === true }
}
