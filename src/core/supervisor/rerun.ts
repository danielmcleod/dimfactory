// Re-run and Re-run from Fix (R14): which
// runs can be re-run, what Re-run from Fix would do (RunSnapshot.rerunFromFix: available, fresh and why), and the
// findings it carries. Pure: derive.ts builds the view from the run's state and what core knows of Fix's vendor.
import type { FreshReason, RerunFromFix, RunStatus } from '../../shared/run.ts'
import { lastResultSnapshot } from './diff-segments.ts'
import { decideSession, fixSessionInputs } from './sessions.ts'
import type { SessionCapabilities, SessionDecision, SessionInputs } from './sessions.ts'
import type { Finding, ReviewerPass, RunState, SnapshotRef } from './types.ts'

/** R14: the statuses a run can be re-run from (either form). */
export const RERUN_STATUSES: readonly RunStatus[] = ['completed', 'cancelled', 'failed', 'paused']

/** The passes a Re-run from Fix carries from its source (skipped "carried from run #N"). */
export const CARRIED_PASSES = ['plan', 'implement', 'review', 'critic', 'security'] as const

const REVIEWERS: readonly ReviewerPass[] = ['review', 'critic', 'security']

/** UI copy (no em dashes): why a run cannot be re-run, or re-run from Fix. */
export const RERUN_TEXT = {
  notOver: 'The run is still going. Re-run it once it has finished, failed, paused or stopped.',
  isolated:
    'This run worked in an isolated copy, which Fix cannot continue in. Re-run starts the whole run again.',
  noImplement: 'Implement did not finish, so there are no changes for Fix to work on.',
  noChanges: 'Implement made no changes, so there is nothing for Fix to work on.',
  noFindings: 'Review and Critic reported no findings, so there is nothing for Fix to do.',
  fixOff: "Fix is turned off in this run's settings.",
  noneChosen: 'Choose at least one finding for Fix.',
} as const

/** StepView.reason of a pass carried from the source run (it did not run again). */
export function carriedReason(displayNo: number): string {
  return `carried from run #${displayNo}`
}

/** StepView.reason of a source pass that had not finished there (failed, stopped or paused). */
export function notFinishedReason(displayNo: number): string {
  return `not finished in run #${displayNo}`
}

/** Why a run cannot be re-run now (either form): it is still going (queued, running, waiting). */
export function rerunBlocked(s: RunState): string | undefined {
  return RERUN_STATUSES.includes(s.status) ? undefined : RERUN_TEXT.notOver
}

/** The source's Implement segment ends (S0, S1), carried as the new run's. */
export function implementEnds(s: RunState): { s0: SnapshotRef; s1: SnapshotRef } | undefined {
  const s0 = s.steps.implement.startSnap ?? s.snapshots.S0
  const s1 = s.steps.implement.endSnap ?? s.snapshots.S1
  return s0 !== undefined && s1 !== undefined ? { s0, s1 } : undefined
}

/**
 * The findings a Re-run from Fix carries: the run's merged list (R8, plus verify:2's listed after Fix), or, when the
 * join never ran (a reviewer failed, or the run stopped first), the done reviewers' findings merged as R8 would merge
 * them (must first, numbered F1…, ids unique).
 */
export function carriedFindings(s: RunState): Finding[] {
  const fs = s.findings
  if (fs === undefined) return []
  if (fs.list.length > 0) return fs.list
  const all: Finding[] = []
  for (const k of REVIEWERS) {
    if (s.steps[k].status === 'done') all.push(...(fs.sources[k]?.findings ?? []))
  }
  if (s.security?.scan?.phase === 'done') all.push(...s.security.scan.findings)
  if (fs.verify?.step === 'verify:1') all.push(...fs.verify.findings)
  // The acceptance review's unmet criteria (Fix until green).
  all.push(...(s.acceptance?.findings ?? []))
  // The preview's smoke check (a joined list already carries them).
  all.push(...(fs.preview ?? []))
  const ordered = [...all.filter((f) => f.severity === 'must'), ...all.filter((f) => f.severity !== 'must')]
  const seen = new Set<string>()
  return ordered.map((f, i) => {
    let id = f.id
    for (let n = 2; seen.has(id); n++) id = `${f.id}-${n}`
    seen.add(id)
    return { ...f, id, n: i + 1, flags: [...f.flags] }
  })
}

/**
 * The findings Fix gets when the user chose none: every must, plus the shoulds selected at the run's beforeFix gate
 * (every finding when the run never reached its join), in list order.
 */
export function defaultFindingIds(s: RunState): string[] {
  const list = carriedFindings(s)
  const fs = s.findings
  const joined = fs !== undefined && fs.list.length > 0
  const chosen = new Set(joined ? fs.selected : list.map((f) => f.id))
  // The smoke check came after the gate, which never chose against them: they are offered ticked.
  for (const f of fs?.preview ?? []) chosen.add(f.id)
  return list.filter((f) => f.severity === 'must' || chosen.has(f.id)).map((f) => f.id)
}

const sameTree = (a: SnapshotRef, b: SnapshotRef): boolean => a.tree === b.tree && a.nested === b.nested

/**
 * Why Re-run from Fix is not offered for this run, or undefined when it is (the run has a diff and at least
 * one finding, whatever its status: completed, cancelled, failed or paused). An isolated run is never offered: its
 * snapshots are its copy's.
 */
export function rerunFromFixUnavailable(s: RunState): string | undefined {
  const blocked = rerunBlocked(s)
  if (blocked !== undefined) return blocked
  if (s.config.isolation === 'worktree') return RERUN_TEXT.isolated
  if (!s.config.passes.fix.enabled) return RERUN_TEXT.fixOff
  const ends = implementEnds(s)
  if (ends === undefined) return RERUN_TEXT.noImplement
  if (sameTree(ends.s0, ends.s1)) return RERUN_TEXT.noChanges
  if (carriedFindings(s).length === 0) return RERUN_TEXT.noFindings
  return undefined
}

/** The source's last result snapshot: the folder as the source left it (the new run's reconcile base, R10). */
export function rerunBase(s: RunState): SnapshotRef | undefined {
  return lastResultSnapshot(s)
}

/**
 * decideSession's inputs for the Fix of a Re-run from Fix of `s`: the source's config, Implement and sessions, Fix in
 * the source's folder (an in-place re-run works there), and the Fix vendor's capabilities when known.
 */
export function rerunSessionInputs(s: RunState, capabilities?: SessionCapabilities): SessionInputs {
  const i = fixSessionInputs(s)
  i.fix.cwd = s.folder
  if (capabilities !== undefined) i.capabilities = capabilities
  return i
}

/** How the re-run's Fix would start (canResume is the one fact only the run itself learns, right before Fix). */
export function rerunSession(s: RunState, capabilities?: SessionCapabilities): SessionDecision {
  return decideSession(rerunSessionInputs(s, capabilities))
}

/** RunSnapshot.rerunFromFix: available or why not, fresh or not and why, and the default findings. */
export function rerunFromFixView(s: RunState, o: { capabilities?: SessionCapabilities } = {}): RerunFromFix {
  const unavailable = rerunFromFixUnavailable(s)
  if (unavailable !== undefined) return { available: false, fresh: true, unavailable }
  const d = rerunSession(s, o.capabilities)
  const findingIds = defaultFindingIds(s)
  if (d.reuse) return { available: true, fresh: false, findingIds }
  const reason: FreshReason = d.reason
  return { available: true, fresh: true, reason, findingIds }
}
