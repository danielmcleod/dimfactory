// "After the run": the run's summary area at the end of the Flow tab once the run has ended (a stop keeps the
// changes and offers [Revert all], R13; reverting goes back to S0). Two things the user may
// want once a run is over:
// - [Revert all]: the run's changes out of the folder (diff.revert, Undo toast), disabled while the folder is busy;
// - with a run branch (RunSnapshot.branch): [Return to <prev>] [Delete run branch]. Core decides on each press
//   (runs.branch): done, or why not with the commands to run instead, shown under the buttons with [Copy];
// - a revert core made on a card choice that can still be undone (RunSnapshot.revertUndo: Restore run's version,
//   Revert Plan's changes, Revert partial then fresh) with its [Undo]: the toast that offered it first usually came
//   while the run went on working, so the undo stays here once the run is over.
// UI control standards: the panel arrives at the end of the flow (nothing above it moves), its buttons keep their
// labels (state is text beside them, a spinner takes the icon slot), and what core answered stays in view.
// An isolated run's changes are in its copy: the panel says whether they were applied, and links to the Diff
// tab's Apply panel while they are not.
// Re-run (R14): [Re-run] (runs.rerun with the same config, then the new
// run) and [Re-run from Fix] (the findings picker, which arrives after this panel), disabled with core's reason when
// it is not available; its tooltip says whether Fix would continue Implement's session, or why it starts fresh.
// Run it (Run & Preview): how to start the project the run worked on and preview it, behind its own [Run it] (nothing
// is detected or started until the user opens it; RunItPanel.tsx).
// Commit and PR (opt-in per project; deploy/CommitPanel.tsx) and Deploy (where it could go, the checklist and the
// commands to copy, behind its own [Deploy]; deploy/DeployPanel.tsx). Context and Context health: per pass how full
// its context got and how often the vendor summarised it, and what made passes heavier (ContextHealthSection.tsx).
import { CornerUpLeft, FolderInput, GitBranch, RotateCcw, Trash2, Undo2, Wrench } from 'lucide-react'
import type { RunBranchInfo, RunSnapshot, RevertUndoView } from '@shared/run.ts'
import { formatFiles } from '../../lib/format.ts'
import { href } from '../../lib/router.ts'
import { APPLY_TITLE } from '../diff/text.ts'
import { CopyCommands } from '../recovery/CopyCommands.tsx'
import { Button } from '../ui/Button.tsx'
import { DisabledHint, LATER_VERSION } from '../ui/DisabledHint.tsx'
import { Tooltip } from '../ui/Tooltip.tsx'
import { useBusy } from './commands.ts'
import { branchAction, DELETE_LABEL, previousLabel, returnLabel, useBranchOutcomes } from './branch.ts'
import { finalizeInfoOf, isolatedNotApplied } from './isolation.ts'
import type { BranchAction, BranchOutcome } from './branch.ts'
import {
  openFixPicker,
  readRerunFromFix,
  RERUN_FROM_FIX_LABEL,
  RERUN_SHORT_LABEL,
  rerunFromFixText,
  rerunFromFixWhy,
  rerunStart,
  rerunStartReason,
  useFixPickerLoading,
} from './rerun.ts'
import { RevertAllButton } from './RevertAllButton.tsx'
import { RunItPanel } from './RunItPanel.tsx'
import { CommitPanel } from '../deploy/CommitPanel.tsx'
import { DeployPanel } from '../deploy/DeployPanel.tsx'
import { AcceptanceChecklist } from './AcceptanceChecklist.tsx'
import { ExplainSection } from './ExplainSection.tsx'
import { ContextHealthSection } from './ContextHealthSection.tsx'
import { useRunCommit } from '../../state/runGit.ts'
import { cardRevertText, UNDO_LABEL, undoRevert, useFolderBusyReason } from './revert.ts'
import { MemoryPanel } from '../../pages/queue/MemoryPanel.tsx'
import type { QualityGatesView } from '@shared/factory.ts'

export const NO_CHANGES_REASON = 'The run made no changes'

/** The heading of the plan's checklist at the end of the run. */
export const ACCEPTANCE_TITLE = 'Acceptance criteria'

/**
 * Core says the run changed nothing: its outcome `no-changes`, or Implement never ran (a run stopped at the plan gate)
 * and core counts no changed files.
 */
export function runMadeNoChanges(snap: RunSnapshot): boolean {
  const s = snap.summary
  return s.outcome === 'no-changes' || (s.progress.filesChanged === 0 && snap.steps.implement.attempt === 0)
}

function changesText(snap: RunSnapshot): string {
  if (runMadeNoChanges(snap)) return 'The run made no changes to the folder.'
  const n = snap.summary.progress.filesChanged
  const what = n > 0 ? `The run's changes (${formatFiles(n)})` : "The run's changes"
  return `${what} stay in the folder. Revert all puts it back as it was before the run changed it; you can undo that.`
}

/**
 * An isolated run's changes are in its copy until applied. Core says whether
 * they are (RunSummary.worktree); the Diff tab's "Apply to folder…" panel applies them (Revert all is for runs that
 * changed the folder itself).
 */
export function isolatedChangesText(snap: RunSnapshot): string {
  const fin = finalizeInfoOf(snap.steps.finalize).state
  if (fin === 'discarded' || fin === 'discarding')
    return 'The isolated copy was discarded: your folder is unchanged.'
  if (fin === 'applied') return "The run's changes were applied to your folder."
  if (runMadeNoChanges(snap)) return 'The run made no changes.'
  const n = snap.summary.progress.filesChanged
  const what = n > 0 ? `The run's changes (${formatFiles(n)})` : "The run's changes"
  return isolatedNotApplied(snap.summary)
    ? `${what} are in its isolated copy, not in your folder. Apply them from the Diff tab.`
    : `${what} are in its isolated copy.`
}

function IsolatedChanges({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const runId = snap.summary.runId
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p data-testid="run-end-changes" className="min-w-0 flex-1 basis-64 text-sm">
        {isolatedChangesText(snap)}
      </p>
      {isolatedNotApplied(snap.summary) && (
        <Button size="sm" variant="outline" asChild data-testid="run-end-apply">
          <a href={href({ name: 'run', runId, tab: 'diff' })}>
            <FolderInput aria-hidden />
            {APPLY_TITLE}
          </a>
        </Button>
      )}
    </div>
  )
}

function ActionButton({
  action,
  label,
  icon,
  outcome,
  busy,
  onPress,
}: {
  action: BranchAction
  label: string
  icon: React.ReactNode
  outcome: BranchOutcome | undefined
  busy: string | null
  onPress: () => void
}): React.JSX.Element {
  const testId = `branch-${action}`
  const reason =
    outcome?.kind === 'unsupported' ? LATER_VERSION : outcome?.kind === 'done' ? outcome.message : undefined
  if (reason !== undefined) {
    return (
      <DisabledHint reason={reason}>
        <Button size="sm" variant="outline" disabled data-testid={testId} icon={icon}>
          {label}
        </Button>
      </DisabledHint>
    )
  }
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid={testId}
      icon={icon}
      loading={busy === action}
      disabled={busy !== null && busy !== action}
      onClick={onPress}
    >
      {label}
    </Button>
  )
}

/** What core answered for one action: done (a line), or why not with the commands to run instead. */
function Outcome({
  action,
  outcome,
}: {
  action: BranchAction
  outcome: BranchOutcome
}): React.JSX.Element | null {
  if (outcome.kind === 'unsupported') return null
  if (outcome.kind === 'done') {
    return (
      <p data-testid={`branch-${action}-done`} className="text-xs text-muted-foreground">
        {outcome.message}
      </p>
    )
  }
  return (
    <div data-testid={`branch-${action}-refused`} className="flex flex-col gap-1.5">
      <p className="text-sm break-words">{outcome.reason}</p>
      {outcome.commands.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">Run it yourself in a terminal in the folder:</p>
          <CopyCommands commands={outcome.commands} testId={`branch-${action}-commands`} />
        </>
      )}
    </div>
  )
}

function BranchActions({ runId, branch }: { runId: string; branch: RunBranchInfo }): React.JSX.Element {
  const [busy, run] = useBusy()
  const outcomes = useBranchOutcomes(runId)
  const committed = useRunCommit(runId)
  const press = (action: BranchAction): void => run(action, () => branchAction(runId, action, branch))
  return (
    <div data-testid="run-end-branch" className="flex flex-col gap-2">
      <p className="flex min-w-0 items-start gap-1.5 text-sm">
        <GitBranch aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-words">
          The run worked on its own branch <code className="font-mono text-xs">{branch.name}</code>, made from{' '}
          <code className="font-mono text-xs">{previousLabel(branch.previous)}</code>.{' '}
          {committed !== undefined
            ? `Dim Factory committed the run's changes there (${committed.slice(0, 7)}).`
            : 'Dim Factory made no commits.'}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          action="return"
          label={returnLabel(branch)}
          icon={<CornerUpLeft aria-hidden />}
          outcome={outcomes.return}
          busy={busy}
          onPress={() => press('return')}
        />
        <ActionButton
          action="delete"
          label={DELETE_LABEL}
          icon={<Trash2 aria-hidden />}
          outcome={outcomes.delete}
          busy={busy}
          onPress={() => press('delete')}
        />
      </div>
      <div role="status" className="flex flex-col gap-2">
        {outcomes.return !== undefined && <Outcome action="return" outcome={outcomes.return} />}
        {outcomes.delete !== undefined && <Outcome action="delete" outcome={outcomes.delete} />}
      </div>
    </div>
  )
}

/** "Reverted your edits outside the run (1 file)." and [Undo] (diff.undoRevert with core's token). */
function RevertUndoLine({ runId, undo }: { runId: string; undo: RevertUndoView }): React.JSX.Element {
  const [busy, run] = useBusy()
  const folderBusy = useFolderBusyReason(runId)
  const icon = <Undo2 aria-hidden />
  return (
    <div data-testid="run-end-revert-undo" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1 basis-64 text-sm">
        {cardRevertText(undo.label)} ({formatFiles(undo.files)}). You can undo that.
      </p>
      {folderBusy !== undefined && busy === null ? (
        <DisabledHint reason={folderBusy}>
          <Button size="sm" variant="outline" disabled data-testid="run-end-undo" icon={icon}>
            {UNDO_LABEL}
          </Button>
        </DisabledHint>
      ) : (
        <Button
          size="sm"
          variant="outline"
          data-testid="run-end-undo"
          icon={icon}
          loading={busy !== null}
          onClick={() => run('undo', () => undoRevert(runId, undo.undoToken, undo.label))}
        >
          {UNDO_LABEL}
        </Button>
      )}
    </div>
  )
}

export const RUN_AGAIN_TEXT =
  'Start this task again with the same settings, or start at Fix with the findings you pick (Plan, Implement, Review and Critic carried over).'

/** [Re-run] [Re-run from Fix]: a new run from this one (R14). */
function RunAgain({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const runId = snap.summary.runId
  const [busy, run] = useBusy()
  const fixLoading = useFixPickerLoading(runId)
  const startReason = rerunStartReason(snap.summary)
  const facts = readRerunFromFix(snap.rerunFromFix)
  const fixText = rerunFromFixText(snap)
  const why = rerunFromFixWhy(snap)
  const startIcon = <RotateCcw aria-hidden />
  const fixIcon = <Wrench aria-hidden />
  return (
    <div data-testid="run-end-rerun" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1 basis-64 text-sm">{RUN_AGAIN_TEXT}</p>
      <div className="flex shrink-0 items-center gap-2">
        {startReason !== null ? (
          <DisabledHint reason={startReason}>
            <Button size="sm" variant="outline" disabled data-testid="run-end-rerun-start" icon={startIcon}>
              {RERUN_SHORT_LABEL}
            </Button>
          </DisabledHint>
        ) : (
          <Button
            size="sm"
            variant="outline"
            data-testid="run-end-rerun-start"
            icon={startIcon}
            loading={busy === 'start'}
            disabled={busy !== null && busy !== 'start'}
            onClick={() => run('start', () => rerunStart(runId))}
          >
            {RERUN_SHORT_LABEL}
          </Button>
        )}
        {facts?.available === true ? (
          <Tooltip content={`${fixText}.${why !== null ? ` ${why}` : ''}`}>
            <Button
              size="sm"
              variant="outline"
              data-testid="run-end-rerun-fix"
              icon={fixIcon}
              loading={fixLoading}
              onClick={() => void openFixPicker(runId)}
            >
              {RERUN_FROM_FIX_LABEL}
            </Button>
          </Tooltip>
        ) : (
          <DisabledHint reason={fixText}>
            <Button size="sm" variant="outline" disabled data-testid="run-end-rerun-fix" icon={fixIcon}>
              {RERUN_FROM_FIX_LABEL}
            </Button>
          </DisabledHint>
        )}
      </div>
    </div>
  )
}

/** The project's quality gates as the run ended: what passed, and each that did not with core's reason. */
export function QualityGates({ gates }: { gates: QualityGatesView }): React.JSX.Element {
  return (
    <section aria-label="Quality gates" data-testid="run-end-gates" className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold">Quality gates</h4>
      {gates.failed.length === 0 ? (
        <p className="text-sm">Passed: {gates.passed.join(', ')}.</p>
      ) : (
        <>
          <p className="text-sm">
            Not passed, so the run completed with failures
            {gates.passed.length > 0 ? ` (passed: ${gates.passed.join(', ')})` : ''}:
          </p>
          <ul className="flex flex-col text-sm" data-testid="run-end-gates-failed">
            {gates.failed.map((g) => (
              <li key={g.name}>
                <span className="font-medium">{g.name}</span>: {g.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** The review's honesty at the end of the run: findings Fix disputed, and how many the checks confirmed were wrong. */
export function wrongFindingsText(w: { disputed: number; wrong: number }): string {
  const disputed = w.disputed === 1 ? 'one finding' : `${w.disputed} findings`
  if (w.wrong === 0)
    return `Findings that turned out wrong: none confirmed (Fix disputed ${disputed}; no check after Fix confirmed it).`
  return `Findings that turned out wrong: ${w.wrong} (Fix disputed ${disputed} and the checks after Fix passed).`
}

/** What guardrails did, in one line. */
export function guardrailsText(g: NonNullable<RunSnapshot['guardrails']>): string {
  const rules = `${g.rules} rule${g.rules === 1 ? '' : 's'} in force`
  if (g.fired === 0) return `Guardrails: ${rules}, none fired.`
  const parts = [`${g.fired} fired`]
  if ((g.blocked ?? 0) > 0) parts.push(`${g.blocked} refused before running`)
  if (g.undone > 0) parts.push(`${g.undone} change${g.undone === 1 ? '' : 's'} put back`)
  if (g.stopped) parts.push('the run was stopped')
  return `Guardrails: ${rules}, ${parts.join(', ')}.`
}

export function RunEndPanel({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const runId = snap.summary.runId
  const noChanges = runMadeNoChanges(snap)
  return (
    <section
      aria-label="After the run"
      data-testid="run-end"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <h3 className="text-xs font-semibold text-muted-foreground uppercase">After the run</h3>
      {snap.summary.isolation === 'worktree' ? (
        <IsolatedChanges snap={snap} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p data-testid="run-end-changes" className="min-w-0 flex-1 basis-64 text-sm">
            {changesText(snap)}
          </p>
          <RevertAllButton runId={runId} disabledReason={noChanges ? NO_CHANGES_REASON : undefined} />
        </div>
      )}
      {snap.summary.gates !== undefined && <QualityGates gates={snap.summary.gates} />}
      {snap.guardrails !== undefined && (
        <p data-testid="run-end-guardrails" className="text-sm text-muted-foreground">
          {guardrailsText(snap.guardrails)}
        </p>
      )}
      {snap.findingsWrong !== undefined && (
        <p data-testid="run-end-wrong-findings" className="text-sm">
          {wrongFindingsText(snap.findingsWrong)}
        </p>
      )}
      {snap.revertUndo !== undefined && <RevertUndoLine runId={runId} undo={snap.revertUndo} />}
      {snap.branch !== undefined && <BranchActions runId={runId} branch={snap.branch} />}
      <CommitPanel runId={runId} />
      <RunAgain snap={snap} />
      <RunItPanel target={{ runId }} collapsible />
      <DeployPanel target={{ runId }} collapsible step={snap.steps.deploy.deploy} />
      {snap.acceptance !== undefined && (
        <section aria-label={ACCEPTANCE_TITLE} className="flex flex-col gap-1.5">
          <h4 className="text-sm font-semibold">{ACCEPTANCE_TITLE}</h4>
          <AcceptanceChecklist view={snap.acceptance} testId="run-end-acceptance" />
        </section>
      )}
      <ExplainSection snap={snap} />
      {/* Core's context report: in the snapshot with the panel, so it arrives with it. */}
      {snap.contextHealth !== undefined && <ContextHealthSection report={snap.contextHealth} />}
      {/* Last, so its arrival (memory.get answers after the panel shows) moves nothing above it. */}
      <MemoryPanel folder={snap.summary.folder} runId={runId} testId="run-end-memory" />
    </section>
  )
}
