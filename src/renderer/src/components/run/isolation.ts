// Isolated runs in the renderer (a run in its own worktree: prepare steps 1 to 5, finalize, Apply, Discard; the
// cards depsConsent / depsFailed / finalize / finalizeConflicts / interruptedApply; the Dashboard chip
// "Isolated: not applied"). Readers for what core sends about an isolated run, and its words. Core derives every
// status (StepView.prepare / StepView.finalize, the cards' payloads); this only checks what it reads, since the fields
// are optional on the wire (an older core sends none), and words them. Nothing here works a status out.
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type {
  CardChoice,
  CardView,
  FinalizeState,
  PassStatus,
  PrepareStepId,
  RunOutputFile,
  RunSummary,
  StepView,
} from '@shared/run.ts'
import { FINALIZE_STATES, PASS_STATUSES, PREPARE_STEP_IDS, RUN_OUTPUT_FILES } from '@shared/run.ts'
import { formatCommandLine } from './text.ts'

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null

/** Paths from a list of strings or of `{path}` records; empty ones dropped. */
function pathsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    const p = typeof x === 'string' ? x : rec(x)['path']
    if (typeof p === 'string' && p !== '') out.push(p)
  }
  return out
}

// ---- prepare (worktree, copy-ins, deps, verify:0 baseline, isolation.verifyReady) ----------------------------------

/** What each prepare step does, as its row's label. */
export const PREPARE_STEP_LABEL: Readonly<Record<PrepareStepId, string>> = {
  worktree: 'Make the isolated copy',
  copy: 'Copy your local files',
  deps: 'Install dependencies',
  baseline: 'Check the commands first',
  ready: 'Check the copy is ready',
}

/** One row of the PrepareCard: core's status of one prepare step, and its detail line. */
export interface PrepareRow {
  id: PrepareStepId
  status: PassStatus
  detail: string | null
}

/** Words core may use for a step's state that are not PassStatus values. */
const STATUS_ALIASES: Readonly<Record<string, PassStatus>> = {
  pending: 'queued',
  planned: 'queued',
  waiting: 'waiting',
  ok: 'done',
  pass: 'done',
  passed: 'done',
  fail: 'failed',
  error: 'failed',
  active: 'running',
}

function statusOf(v: unknown): PassStatus | null {
  if (typeof v !== 'string') return null
  if ((PASS_STATUSES as readonly string[]).includes(v)) return v as PassStatus
  return STATUS_ALIASES[v] ?? null
}

/**
 * Core's prepare steps (StepView.prepare.steps), in the order core lists them; a row core did not name is left out,
 * an unknown status reads as queued. null when core sent no prepare view (an in-place run, an older core).
 */
export function prepareRowsOf(view: StepView): PrepareRow[] | null {
  const p = rec(view.prepare)
  const list = p['steps']
  if (!Array.isArray(list)) return null
  const out: PrepareRow[] = []
  for (const x of list) {
    const r = rec(x)
    const id = r['id']
    if (typeof id !== 'string' || !(PREPARE_STEP_IDS as readonly string[]).includes(id)) continue
    if (out.some((o) => o.id === id)) continue
    out.push({ id: id as PrepareStepId, status: statusOf(r['status']) ?? 'queued', detail: str(r['detail']) })
  }
  return out
}

/** Core's prepare view lists the baseline check (verify:0) as a step it will run (not skipped). */
export function plansBaseline(view: StepView): boolean {
  const rows = prepareRowsOf(view)
  return rows?.some((r) => r.id === 'baseline' && r.status !== 'skipped' && r.status !== 'cancelled') ?? false
}

/** The runs.output file the dependency install streams through (`prepare`), when this build's contract has it. */
export function prepareOutputFile(): RunOutputFile | null {
  return (RUN_OUTPUT_FILES as readonly string[]).includes('prepare') ? 'prepare' : null
}

// ---- finalize and Apply (R12) -----------------------------------------------------------------------------------------

/** Core's finalize view (StepView.finalize), each field checked: its state and what it applied or left. */
export interface FinalizeInfo {
  /** Core's state (FINALIZE_STATES); null when core sent none. */
  state: FinalizeState | null
  /** Files the run changed in its copy (core's count). */
  files: number | null
  /** Files the last apply wrote or deleted. */
  applied: number | null
  conflicts: string[]
  /** worktree.undoApply's token while the last apply can be undone. */
  undoToken: string | null
  /** `discarding`: when core deletes the copy, and worktree.undoDiscard's token. */
  deleteAt: number | null
  discardToken: string | null
  /** Why the last apply, undo or deletion did not finish (core's words). */
  error: string | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function finalizeInfoOf(view: StepView | undefined): FinalizeInfo {
  const f = rec(view?.finalize)
  const state = f['state']
  const files = f['files']
  return {
    state:
      typeof state === 'string' && (FINALIZE_STATES as readonly string[]).includes(state)
        ? (state as FinalizeState)
        : null,
    files: num(files) ?? (Array.isArray(files) ? pathsOf(files).length : null),
    applied: num(f['applied']),
    conflicts: pathsOf(f['conflicts']),
    undoToken: str(f['undoToken']),
    deleteAt: num(f['deleteAt']),
    discardToken: str(f['discardToken']),
    error: str(f['error']),
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** What the finalize step's state says, in words (FinalizeView.state). */
export function finalizeStateText(info: FinalizeInfo): string | null {
  const n = info.applied ?? info.files
  switch (info.state) {
    case null:
      return null
    case 'preview':
      return "Comparing the run's changes with your folder…"
    case 'pending':
      return 'Waiting for your choice below.'
    case 'waiting':
      return 'Waiting for the folder: another run is using it.'
    case 'applying':
      return 'Applying to your folder…'
    case 'conflicts':
      return `${plural(info.conflicts.length, 'file differs', 'files differ')} in your folder: choose for each below.`
    case 'interrupted':
      return 'Dim Factory closed while applying: finish the apply below.'
    case 'applied':
      return n !== null
        ? `Applied to your folder (${plural(n, 'file', 'files')}).`
        : 'Applied to your folder.'
    case 'kept':
      return info.files === 0
        ? 'Nothing to apply: the run changed no files. Its isolated copy stays until you discard it.'
        : 'Kept for later: the isolated copy stays until you apply or discard it.'
    case 'undoing':
      return 'Undoing the apply…'
    case 'discarding':
      return 'Discarding the isolated copy: you can still undo it.'
    case 'discarded':
      return 'Discarded: the isolated copy is deleted.'
  }
}

// ---- the Dashboard chip (unfinalized worktrees are never auto-deleted) ------------------------------------------------

export const ISOLATED_NOT_APPLIED = 'Isolated: not applied'
export const ISOLATED_NOT_APPLIED_HINT =
  "This run worked in an isolated copy of the folder. Its changes are not in your folder until you apply them from the run's Diff tab (Apply to folder…)."

/** Core says the run's isolated copy exists and its changes are not in the folder (RunSummary.worktree). */
export function isolatedNotApplied(s: Pick<RunSummary, 'worktree'>): boolean {
  return s.worktree?.notApplied === true
}

/** An apply Dim Factory's close interrupted; part of the run's changes may be in the folder. */
export const ISOLATED_APPLY_INTERRUPTED = 'Isolated: apply interrupted'
export const ISOLATED_APPLY_INTERRUPTED_HINT =
  "Dim Factory closed while it was applying this run's changes, so some may be in your folder and others not yet. Open the run and choose Finish apply."

/**
 * The Dashboard's isolated chip, as core's RunSummary.worktree says: "Isolated: not applied" while the run's changes
 * are not in the folder, "Isolated: apply interrupted" while an apply a close interrupted waits for [Finish apply]
 * (not "not applied": part may be written), else none.
 */
export function isolatedChipOf(
  s: Pick<RunSummary, 'worktree' | 'matchOf'>,
): { text: string; hint: string } | null {
  // A rematch's side is never applied: "not applied" is how it is meant to stay, not something to act on.
  if (s.matchOf?.rematch === true) return null
  if (s.worktree?.state === 'interrupted')
    return { text: ISOLATED_APPLY_INTERRUPTED, hint: ISOLATED_APPLY_INTERRUPTED_HINT }
  if (isolatedNotApplied(s)) return { text: ISOLATED_NOT_APPLIED, hint: ISOLATED_NOT_APPLIED_HINT }
  return null
}

// ---- cards: depsConsent / depsFailed (deps detection; the command and its streamed output) -----------------------

export interface DepsCardData {
  /** The install command as one line. */
  command: string
  argv: string[]
  /** The package manager core detected (pnpm, npm, uv, …), when it named one. */
  manager: string | null
  /** The file it detected it from (pnpm-lock.yaml, package-lock.json, …). */
  lockfile: string | null
  /** Where it runs, relative to the isolated copy ('.' at its root). */
  cwdRel: string
  /** depsFailed: the install's exit code, why it failed, and the end of its output. */
  exitCode: number | null
  /** depsFailed: the install ran past its 15 min budget and was stopped. */
  timedOut: boolean
  reason: string | null
  excerpt: string | null
  /**
   * Where the command came from (DepsCommandView.source): the lockfile table, the project's settings
   * (`isolation.worktree.installCommand`), or the user's edit on this card; null when core did not say.
   */
  source: 'detected' | 'config' | 'edited' | null
}

const DEPS_SOURCES: readonly string[] = ['detected', 'config', 'edited']

/** depsConsent / depsFailed payloads (core prepare/install): the command, what it was found from, how it failed. */
export function depsOf(card: CardView): DepsCardData {
  const p = rec(card.payload)
  const deps = rec(p['deps'])
  const cmd = rec(p['command'])
  const pick = (k: string): unknown => p[k] ?? deps[k] ?? cmd[k]
  const argv = strings(pick('argv')) ?? []
  const line = str(p['command']) ?? str(deps['command']) ?? str(cmd['line'])
  const command = line ?? (argv.length > 0 ? formatCommandLine(argv) : '')
  const exit = pick('exitCode')
  const source = pick('source')
  return {
    command,
    argv,
    manager: str(pick('manager')),
    lockfile: str(pick('lockfile')),
    cwdRel: str(pick('cwdRel')) ?? '.',
    exitCode: typeof exit === 'number' ? exit : null,
    timedOut: pick('timedOut') === true,
    reason: str(pick('reason')) ?? str(pick('failure')),
    excerpt: str(pick('excerpt')) ?? str(pick('output')),
    source:
      typeof source === 'string' && DEPS_SOURCES.includes(source)
        ? (source as 'detected' | 'config' | 'edited')
        : null,
  }
}

/** The choice that takes an edited command (core's [Edit command]: `input: 'command'`). */
export function editCommandChoice(card: CardView): CardChoice | undefined {
  return card.choices.find((c) => c.input === 'command')
}

// ---- cards: finalizeConflicts (anything Apply cannot write cleanly: [Keep mine] / [Take run's]) ---------------------

export interface ConflictFile {
  path: string
  /** Why it is a conflict, as core words it ("Changed in your folder since the run started"). */
  reason: string | null
}

/** finalizeConflicts: the files whose folder content no longer equals the run's base. */
export function conflictsOf(card: CardView): ConflictFile[] {
  const p = rec(card.payload)
  const list = Array.isArray(p['files']) ? p['files'] : Array.isArray(p['conflicts']) ? p['conflicts'] : []
  const out: ConflictFile[] = []
  for (const x of list) {
    const r = rec(x)
    const path = typeof x === 'string' ? x : str(r['path'])
    if (path === null || path === '' || out.some((o) => o.path === path)) continue
    out.push({ path, reason: typeof x === 'string' ? null : (str(r['reason']) ?? str(r['detail'])) })
  }
  return out
}

export type ConflictSide = 'mine' | 'theirs'

/**
 * Core's [Keep mine] and [Take run's] choices. Each takes the paths it applies to as its input (one file from that
 * file's row, every file from the card's row), so the user decides file by file.
 */
export function conflictChoices(card: CardView): Partial<Record<ConflictSide, CardChoice>> {
  const out: Partial<Record<ConflictSide, CardChoice>> = {}
  // Core's ids (CONFLICT_CHOICE: keep-mine, take-theirs) match the words below.
  for (const c of card.choices) {
    const id = c.id.toLowerCase()
    if (out.mine === undefined && (id.includes('mine') || id === 'keep')) out.mine = c
    else if (out.theirs === undefined && (id.includes('theirs') || id.includes('take'))) out.theirs = c
  }
  return out
}

/** The per-file buttons' words. */
export const KEEP_MINE = 'Keep mine'
export const TAKE_RUNS = "Take run's"

// ---- cards: interruptedApply (a journal in run.json.finalize makes [Finish apply] idempotent) ---------------------

export interface InterruptedApplyData {
  /** Files the apply wrote before Dim Factory closed. */
  done: number | null
  /** Files it still has to write. */
  remaining: number | null
}

export function interruptedOf(card: CardView): InterruptedApplyData {
  const p = rec(card.payload)
  const j = rec(p['journal'])
  const count = (k: string): number | null => {
    const v = p[k] ?? j[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    return Array.isArray(v) ? v.length : null
  }
  return { done: count('applied') ?? count('done'), remaining: count('remaining') ?? count('pending') }
}

// ---- the composer (In place | Isolated run, which warns about uncommitted changes) --------------------------------

/** "3 uncommitted changes not included" (an isolated run starts from HEAD), from core's count. */
export function uncommittedText(n: number): string {
  return `${plural(n, 'uncommitted change', 'uncommitted changes')} not included`
}

const UNCOMMITTED = /(\d[\d,]*)\s+uncommitted\s+change/i

/**
 * Core's count of the folder's uncommitted changes, from its live checks (the isolated-run check says how many it
 * leaves out). null when no check says.
 */
export function uncommittedCount(report: PreflightReport | null): number | null {
  if (report === null) return null
  for (const c of [...report.blocking, ...report.warnings, ...report.info]) {
    const m = UNCOMMITTED.exec(`${c.title} ${c.detail}`)
    if (m !== null) return Number((m[1] ?? '0').replace(/,/g, ''))
  }
  return null
}

/** Why the folder cannot have an isolated run, in core's words; empty when nothing says it cannot. */
export function isolationIneligible(report: PreflightReport | null): string[] {
  if (report === null) return []
  const all: CheckResult[] = [...report.blocking, ...report.warnings, ...report.info]
  const reasons: string[] = []
  const say = (text: string): void => {
    const one = text.replace(/\s*\n\s*/g, ' ').trim()
    if (one !== '' && !reasons.includes(one)) reasons.push(one)
  }
  const whole = (c: CheckResult): string => [c.title, c.detail].filter((t) => t !== '').join(': ')
  for (const c of all) {
    // Core's eligibility check for an isolated run (it runs once Isolated is chosen), and the git facts that rule one
    // out before that (the folder.git check: not a repo; no commit yet), in core's title.
    if (c.id === 'run.isolation.worktree' && c.status === 'fail') say(whole(c))
    else if (c.id === 'folder.git.head') say(`${c.title}: isolated runs need at least one commit.`)
    else if (c.id === 'folder.git' && /needs? a git repositor/i.test(c.title)) say(whole(c))
    else if (c.id === 'folder.git' && /not a git repositor/i.test(`${c.title} ${c.detail}`))
      say(`${c.title}: isolated runs need a git repository with at least one commit.`)
  }
  return reasons
}
