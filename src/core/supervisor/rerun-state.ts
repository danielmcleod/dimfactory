// Re-run from Fix (R10/R14): the new run's state. Plan,
// Implement, Review and Critic (and verify:1) are skipped "carried from run #N" with what Fix needs of them: the plan
// text, Implement's snapshots and session, the findings (Fix gets the chosen ones), the sessions, the folder's
// expected HEAD and run branch. The run starts at the pre-Fix boundary: R10 reconciles the folder against the
// source's last result snapshot (`rerunOf.base`), takes F0 and decides Fix's session. Pure.
import type { PassStatus, RunOutputFile, StepKey } from '../../shared/run.ts'
import { acceptanceOn, initRunState } from './machine.ts'
import { CARRIED_PASSES, carriedFindings, carriedReason, notFinishedReason, rerunBase } from './rerun.ts'
import type { FindingsState, RunInit, RunState, SnapshotLabel, StepState } from './types.ts'

/** The source's snapshots the new run keeps under their own labels (its Implement segment and boundaries). */
const CARRIED_SNAPSHOTS: readonly SnapshotLabel[] = [
  'run-start',
  'plan-end',
  'S0',
  'S1',
  'post-verify-1',
  'post-review',
]

/** The outputs a Re-run from Fix starts with (copied from the source's run folder). */
const CARRIED_OUTPUTS: readonly RunOutputFile[] = [
  'plan',
  'plan.original',
  'review',
  'critic',
  'security',
  'verify:1',
  'research',
  'research.json',
  'acceptance',
]

const clone = <T>(v: T): T => structuredClone(v)

/** A carried step: skipped, with what it ran on (the views and decideSession read vendor, model and session). */
function carryStep(dst: StepState, src: StepState, sourceNo: number): void {
  const reason =
    src.status === 'skipped'
      ? (src.reason ?? carriedReason(sourceNo))
      : src.status === 'done'
        ? carriedReason(sourceNo)
        : notFinishedReason(sourceNo)
  const status: PassStatus = 'skipped'
  dst.status = status
  dst.reason = reason
  if (src.vendor !== undefined) dst.vendor = src.vendor
  if (src.model !== undefined) dst.model = src.model
  if (src.mode !== undefined) dst.mode = src.mode
  if (src.planMode !== undefined) dst.planMode = src.planMode
  if (src.sessionId !== undefined) dst.sessionId = src.sessionId
}

/**
 * The state of a Re-run from Fix of `source` (a run rerunFromFixUnavailable allows), created with `init` (new id,
 * number, time and the re-run's config), Fix getting `findingIds` (in the carried list's order).
 */
export function initRerunFromFix(source: RunState, init: RunInit, findingIds: readonly string[]): RunState {
  const s = initRunState(init)
  const no = source.displayNo
  for (const k of CARRIED_PASSES) carryStep(s.steps[k], source.steps[k], no)
  // Clarify ran before the source's Plan: carried with its answers, which are in the source's brief (the Fix prompt's
  // `{{brief}}`). A source that never asked leaves it carried too, so the re-run never asks before its Fix.
  if (s.config.clarify !== undefined) {
    const src = source.steps.clarify as StepState | undefined
    if (src !== undefined && src.status !== 'queued') carryStep(s.steps.clarify, src, no)
    else Object.assign(s.steps.clarify, { status: 'skipped', reason: carriedReason(no) })
  }
  if (source.clarify !== undefined) s.clarify = clone(source.clarify)
  // Research ran before the source's Plan: carried with what the user kept (the carried plan was made from it), so
  // the re-run neither researches nor asks again. Its lenses are the source's.
  if (source.config.research !== undefined)
    s.config = { ...s.config, research: clone(source.config.research) }
  else delete s.config.research
  if (s.config.research !== undefined) {
    const src = source.steps.research as StepState | undefined
    if (src !== undefined && src.status !== 'queued') carryStep(s.steps.research, src, no)
    else Object.assign(s.steps.research, { status: 'skipped', reason: carriedReason(no) })
  }
  if (source.research !== undefined) s.research = clone(source.research)
  // The plan's acceptance criteria, the tests mapped to them and the acceptance review's verdicts are the source's (its
  // unmet criteria are among the carried findings). The review ran before the source's reviewers: carried too.
  if (source.acceptance !== undefined) s.acceptance = clone(source.acceptance)
  if (acceptanceOn(s)) {
    const src = source.steps.acceptance as StepState | undefined
    if (src !== undefined && src.status !== 'queued') carryStep(s.steps.acceptance, src, no)
    else Object.assign(s.steps.acceptance, { status: 'skipped', reason: carriedReason(no) })
  }
  if (source.brief !== undefined && source.brief !== '') s.brief = source.brief
  if (source.category !== undefined) s.category = source.category
  if (source.securityFocus !== undefined && source.securityFocus !== '')
    s.securityFocus = source.securityFocus
  // Implement's segment (S0..S1) is the source's: Fix's {{diff}} (S0..F0), the Diff tab, the reconcile's run changes.
  const impl = source.steps.implement
  const s0 = impl.startSnap ?? source.snapshots.S0
  const s1 = impl.endSnap ?? source.snapshots.S1
  if (s0 !== undefined) s.steps.implement.startSnap = clone(s0)
  if (s1 !== undefined) {
    s.steps.implement.endSnap = clone(s1)
    s.steps.implement.endSnapStatus = 'done'
  }
  // verify:1's round (Fix's {{verify}}, R11's "every verify:1 failure passes in verify:2").
  const v1 = source.steps['verify:1']
  const v1Key: StepKey = 'verify:1'
  if (v1.status !== 'queued') {
    carryStep(s.steps[v1Key], v1, no)
    if (v1.verify !== undefined) s.steps[v1Key].verify = clone(v1.verify)
  }
  // The security scan (its findings are among the carried ones; the scan step shows what it found).
  const scan = source.steps.scan
  if (scan.status !== 'queued' && source.security?.scan !== undefined) {
    carryStep(s.steps.scan, scan, no)
    s.security = { scan: clone(source.security.scan) }
  }
  for (const label of CARRIED_SNAPSHOTS) {
    const ref = source.snapshots[label]
    if (ref !== undefined) s.snapshots[label] = clone(ref)
  }
  s.plan = {
    decided: true,
    text: source.plan.text,
    edited: source.plan.edited,
    ...(source.plan.original !== undefined ? { original: source.plan.original } : {}),
  }
  const list = carriedFindings(source)
  const want = new Set(findingIds)
  const fs = source.findings
  const findings: FindingsState = {
    sources: clone(fs?.sources ?? {}),
    list: clone(list),
    selected: list.filter((f) => want.has(f.id)).map((f) => f.id),
    // The Fix prompt's Notes (reverts and edits the source's reconciles reported): the folder still holds them.
    notes: [...(fs?.notes ?? [])],
  }
  if (fs?.verify?.step === 'verify:1') findings.verify = clone(fs.verify)
  s.findings = findings
  s.sessions = clone(source.sessions)
  // R2's run-start was the source's; the run starts at R10, so it takes no run-start of its own (a Stop still takes
  // the `stopped` snapshot, since Fix may have written).
  s.flow = { runStart: 'done', prepared: 'none', review: 'joined' }
  if (source.flow.postVerify1 === 'done') s.flow.postVerify1 = 'done'
  // Where HEAD should be and Dim Factory's own writes since the base (a Revert all is not the user's edit).
  const head = source.git?.expectedHead
  const own = source.git?.ownPaths
  if (head !== undefined || (own !== undefined && own.length > 0)) {
    s.git = {
      ...(head !== undefined ? { expectedHead: clone(head) } : {}),
      ...(own !== undefined && own.length > 0 ? { ownPaths: [...own] } : {}),
    }
  }
  // The carried artifacts (copied into the new run's folder with it): runs.output serves them.
  for (const f of CARRIED_OUTPUTS) if (source.outputs[f] !== undefined) s.outputs[f] = 1
  if (source.branch !== undefined) s.branch = clone(source.branch)
  if (source.diffStats !== undefined) s.diffStats = { ...source.diffStats, live: false }
  const base = rerunBase(source)
  s.rerunOf = {
    runId: source.runId,
    displayNo: no,
    from: 'fix',
    ...(base !== undefined ? { base: clone(base) } : {}),
  }
  s.notes = [`Re-run from Fix of run #${no}: Plan, Implement, Review and Critic are carried from it.`]
  return s
}
