// Isolated runs as core states them (prepare and finalize; the
// PrepareCard and the Dashboard chip "Isolated: not applied"): the prepare rows as the run's config plans them from its
// start, and the views (StepView.prepare / StepView.finalize, RunSummary.worktree) the renderer only formats.
import type { FinalizeView, PrepareStepId, PrepareView, RunWorktreeSummary } from '../../shared/run.ts'
import type { PrepareRowState, RunConfig, RunState } from './types.ts'

/** Why a prepare row is skipped (UI copy, no em dashes). */
export const PREPARE_SKIP = {
  installOff: 'Install is off for this project.',
  nothingToInstall: 'Nothing to install: no lockfile or install command was found.',
  skipped: 'Skipped: the run goes on without installing dependencies.',
  verifyOff: 'Verify is off.',
  baselineOff: 'The baseline check is off.',
  noCopies: 'No files to copy.',
} as const

/**
 * The five rows as the run's config plans them (prepare steps 1 to 5). Rows the config turns off are skipped
 * from the start with why (install off, verify off, no baseline), so later only statuses change.
 */
export function plannedPrepareRows(c: RunConfig): PrepareRowState[] {
  const verifyOn = c.verify.enabled
  const row = (id: PrepareStepId, skip?: string): PrepareRowState =>
    skip !== undefined ? { id, status: 'skipped', detail: skip } : { id, status: 'queued' }
  return [
    row('worktree'),
    row('copy'),
    row('deps', c.worktree?.install === 'never' ? PREPARE_SKIP.installOff : undefined),
    row(
      'baseline',
      !verifyOn ? PREPARE_SKIP.verifyOff : !c.verify.baseline ? PREPARE_SKIP.baselineOff : undefined,
    ),
    row('ready', !verifyOn ? PREPARE_SKIP.verifyOff : undefined),
  ]
}

/** StepView.prepare of an isolated run (undefined for an in-place one). */
export function prepareView(s: RunState): PrepareView | undefined {
  if (s.config.isolation !== 'worktree') return undefined
  const I = s.isolation
  const rows = I?.rows ?? plannedPrepareRows(s.config)
  const v: PrepareView = {
    steps: rows.map((r) => (r.detail !== undefined ? { ...r } : { id: r.id, status: r.status })),
  }
  if (I?.worktree !== undefined) v.worktree = { ...I.worktree }
  if (I?.uncommitted !== undefined) v.uncommitted = I.uncommitted
  const c = I?.deps?.command
  if (c !== undefined) {
    v.deps = {
      manager: c.manager,
      argv: [...c.argv],
      cwdRel: c.cwdRel,
      source: c.source,
      ...(c.lockfile !== undefined ? { lockfile: c.lockfile } : {}),
    }
  }
  return v
}

/** StepView.finalize once R12 began (or the user acted on a stopped run's worktree). */
export function finalizeView(s: RunState): FinalizeView | undefined {
  const f = s.isolation?.finalize
  if (f === undefined) return undefined
  const v: FinalizeView = { state: f.state }
  if (f.files !== undefined) v.files = f.files
  if (f.conflicts !== undefined && f.conflicts.length > 0) v.conflicts = f.conflicts.map((c) => c.path)
  const live = [...f.applies].reverse().find((a) => a.undone !== true)
  if (live !== undefined) {
    v.applied = live.applied.length
    v.undoToken = live.token
  }
  if (f.discard !== undefined && f.discard.removing !== true) {
    v.deleteAt = f.discard.deleteAt
    v.discardToken = f.discard.token
  }
  if (f.error !== undefined) v.error = f.error
  return v
}

/**
 * RunSummary.worktree. `notApplied` (the Dashboard chip): the worktree exists, none of the run's changes are in the
 * folder (no apply that was not undone, none interrupted part way), it was not discarded, and its preview did not find
 * it changed nothing, once the run has stopped working in it (finalize began, or the run was stopped).
 */
export function worktreeSummary(s: RunState): RunWorktreeSummary | undefined {
  if (s.config.isolation !== 'worktree') return undefined
  const I = s.isolation
  const f = I?.finalize
  const exists = I?.worktree !== undefined
  const ended = s.stop !== undefined || s.outcome !== undefined
  if (!exists && ended) return undefined
  const state: RunWorktreeSummary['state'] =
    f !== undefined ? f.state : ended ? 'kept' : s.flow.prepared === 'all' ? 'working' : 'preparing'
  const applied = f?.applies.some((a) => a.undone !== true) ?? false
  const gone = f?.state === 'discarded' || f?.state === 'discarding'
  // A run that changed no files has nothing to apply, so nothing is "not applied".
  const nothing = f?.files === 0 && (f.conflicts ?? []).length === 0
  // An apply Dim Factory's close interrupted may have written part of the run's changes, so they are
  // not "not in the folder"; `state: 'interrupted'` says so (the chip "Isolated: apply interrupted").
  const partly = f?.state === 'interrupted'
  return { state, notApplied: exists && ended && !applied && !gone && !nothing && !partly }
}
