// Where the run works (`In place | Isolated run`, `New run branch`, `Verify: N commands`).
// Isolated run (opt-in) is a run override like In place. It is
// disabled with core's own words when the folder cannot have one (core's live checks: not a git repository, no commit
// yet, run.isolation.worktree's reasons), and with "Available in a later version" when the composer offers no handler.
// Chosen, a line under the controls says what an isolated run leaves out: "N uncommitted changes not included" (core's
// count: the worktree starts from HEAD), or that it starts from the last commit while core has not counted. The
// line comes with the user's own click (never on its own), and its words change in place as core's count arrives.
// New run branch (`isolation.branch`) is a run override like the gates: the box shows
// the user's pending choice at once and core's resolved value otherwise, with core's provenance badge (run in amber),
// whose room is reserved so the badge never moves the box. Its tooltip says what the branch does, with core's own
// `run.branch` check (the name core will use, or why it cannot) when the live preflight has one; the check itself shows
// in the preflight strip like every other check.
// Verify (opt-in) is a run override the same way: the box is `verify.enabled` for this
// run, with core's provenance badge, and its label counts the commands core would run ("Verify: 3 commands", one
// reserved width as the count arrives). Which commands run, and whether they are trusted, is Settings → Isolation &
// Verify: the link beside the box opens it for the composer's folder. The tooltip says what verify does, with core's
// own `run.verify` check when the live preflight has one.
import { GitBranch, ListChecks, SlidersHorizontal } from 'lucide-react'
import type { Provenance } from '@shared/config-schema.ts'
import type { CheckResult } from '@shared/preflight.ts'
import { verifySettingsHref } from '../../../components/run/VerifyModel.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { Checkbox } from '../../../components/ui/Checkbox.tsx'
import { uncommittedText } from '../../../components/run/isolation.ts'
import { DisabledHint, LATER_VERSION } from '../../../components/ui/DisabledHint.tsx'
import { StableLabel } from '../../../components/ui/StableLabel.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import { cn } from '../../../lib/cn.ts'
import { GATE_PROVENANCE_LABELS } from './GatesLine.tsx'
import { ProvenanceBadge } from './ProvenanceBadge.tsx'

/** Shown with an isolated run: the worktree starts from the last commit. */
export const ISOLATED_UNCOMMITTED_WARNING =
  'Isolated runs start from your last commit. Uncommitted changes in this folder are not copied into the run.'

/** With an isolated run and no uncommitted changes (core counted none). */
export const ISOLATED_CLEAN =
  'Isolated runs start from your last commit; this folder has no uncommitted changes.'

/** What an isolated run leaves out, from core's count (null: not counted yet). */
export function isolationWarning(uncommitted: number | null): { text: string; warn: boolean } {
  if (uncommitted === null) return { text: ISOLATED_UNCOMMITTED_WARNING, warn: true }
  if (uncommitted === 0) return { text: ISOLATED_CLEAN, warn: false }
  return { text: `${uncommittedText(uncommitted)}: isolated runs start from your last commit.`, warn: true }
}

/** What Isolated run does, its tooltip. */
export const ISOLATED_HINT =
  'The run works in its own copy of the repository (a git worktree) and changes nothing in this folder until you apply its changes.'

/** What New run branch does, the start of its tooltip. */
export const RUN_BRANCH_HINT =
  'Before Implement, Dim Factory makes a new branch from the one you are on and switches to it. Your uncommitted changes stay as they are, and Dim Factory never commits.'

/** The Verify label keeps one width as the count arrives: any 1- or 2-digit count fits (tabular digits). */
const VERIFY_LABELS: readonly string[] = ['Verify: no commands', 'Verify: 1 command', 'Verify: 00 commands']

/** The link to the verify commands in Settings. */
export const VERIFY_SETTINGS_LABEL = 'Choose commands'

/** "Verify: 3 commands", "Verify: 1 command", "Verify: no commands". */
export function verifyLabel(n: number): string {
  return n === 0 ? 'Verify: no commands' : `Verify: ${n} ${n === 1 ? 'command' : 'commands'}`
}

/** What Verify does, the start of its tooltip. */
export function verifyHint(runAfter: readonly ('implement' | 'fix')[]): string {
  const after =
    runAfter.includes('implement') && runAfter.includes('fix')
      ? 'after Implement and after Fix'
      : runAfter.includes('fix')
        ? 'after Fix'
        : runAfter.includes('implement')
          ? 'after Implement'
          : 'at no point (choose when in Settings)'
  return `Runs your trusted verify commands ${after}. A failing command becomes a must-fix finding; a command that cannot run in this environment is never a finding.`
}

/** The tooltip: what the branch does, then core's run.branch check when it said something. */
export function runBranchTooltip(check: CheckResult | undefined): string {
  return withCheck(RUN_BRANCH_HINT, check)
}

/** The Verify tooltip: what verify does, then core's run.verify check when it said something. */
export function verifyTooltip(
  runAfter: readonly ('implement' | 'fix')[],
  check: CheckResult | undefined,
): string {
  return withCheck(verifyHint(runAfter), check)
}

function withCheck(hint: string, check: CheckResult | undefined): string {
  if (check === undefined) return hint
  const said = [check.title, check.detail].filter((t) => t !== '').join(': ')
  return said === '' ? hint : `${hint}\n${said}`
}

export interface IsolationControlsProps {
  mode: 'inPlace' | 'worktree'
  branch: 'none' | 'runBranch'
  /** The commands a run would run (core's resolved list, less those turned off). */
  verifyCommands: number
  onInPlace: () => void
  /** New run branch toggled: the run override `isolation.branch`. */
  onBranch: (branch: 'none' | 'runBranch') => void
  /** Where core's `isolation.branch` came from (config.resolve provenance `/isolation/branch`). */
  branchProvenance?: Provenance | undefined
  /** Core's live `run.branch` check, when the report has one. */
  branchCheck?: CheckResult | undefined
  /** Whether this run verifies (the user's pending choice, else core's resolved `verify.enabled`). */
  verify?: boolean | undefined
  /** Verify toggled: the run override `verify.enabled`. */
  onVerify?: ((enabled: boolean) => void) | undefined
  /** Where core's `verify.enabled` came from (provenance `/verify/enabled`). */
  verifyProvenance?: Provenance | undefined
  /** Core's live `run.verify` check, when the report has one. */
  verifyCheck?: CheckResult | undefined
  /** Core's resolved `verify.runAfter`. */
  verifyRunAfter?: readonly ('implement' | 'fix')[] | undefined
  /** The composer's folder (the Settings link opens its commands). */
  folder?: string | null | undefined
  /** Isolated run chosen: the run override `isolation.mode = worktree`. Absent: the control is blocked. */
  onIsolated?: (() => void) | undefined
  /** Why the folder cannot have an isolated run, in core's words (its live checks); empty when it can. */
  isolatedBlocked?: readonly string[] | undefined
  /** Core's count of the folder's uncommitted changes an isolated run leaves out (null: not counted). */
  uncommitted?: number | null | undefined
}

export function IsolationControls({
  mode,
  branch,
  verifyCommands,
  onInPlace,
  onBranch,
  branchProvenance,
  branchCheck,
  verify = false,
  onVerify,
  verifyProvenance,
  verifyCheck,
  verifyRunAfter = ['implement', 'fix'],
  folder = null,
  onIsolated,
  isolatedBlocked = [],
  uncommitted = null,
}: IsolationControlsProps): React.JSX.Element {
  const isolatedOff =
    onIsolated === undefined ? LATER_VERSION : isolatedBlocked.length > 0 ? isolatedBlocked.join(' ') : null
  const isolatedButton = (
    <Button
      size="sm"
      variant="ghost"
      disabled={isolatedOff !== null}
      data-testid="isolation-worktree"
      aria-pressed={mode === 'worktree'}
      onClick={() => {
        if (mode !== 'worktree') onIsolated?.()
      }}
      className={cn('rounded-l-none border-l', mode === 'worktree' && 'bg-accent')}
    >
      Isolated run
    </Button>
  )
  const warning = isolationWarning(uncommitted)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <span className="w-16 font-medium text-muted-foreground">Where</span>
        <div role="group" aria-label="Where the run works" className="inline-flex rounded-md border">
          <Button
            size="sm"
            variant="ghost"
            data-testid="isolation-inplace"
            aria-pressed={mode === 'inPlace'}
            onClick={() => {
              if (mode !== 'inPlace') onInPlace()
            }}
            className={cn('rounded-r-none', mode === 'inPlace' && 'bg-accent')}
          >
            In place
          </Button>
          {isolatedOff !== null ? (
            <DisabledHint reason={isolatedOff}>{isolatedButton}</DisabledHint>
          ) : (
            <Tooltip content={ISOLATED_HINT}>{isolatedButton}</Tooltip>
          )}
        </div>
        <span data-testid="run-branch-control" className="flex items-center gap-1.5">
          <Tooltip content={<span className="whitespace-pre-line">{runBranchTooltip(branchCheck)}</span>}>
            <label className="flex cursor-pointer items-center gap-1.5">
              <Checkbox
                data-testid="run-branch"
                checked={branch === 'runBranch'}
                aria-label="New run branch"
                onCheckedChange={(v) => onBranch(v === true ? 'runBranch' : 'none')}
              />
              <GitBranch aria-hidden className="size-3.5" />
              New run branch
            </label>
          </Tooltip>
          {/* Its own tooltip, outside the box's: the room of its widest label is kept, so it never moves the box. */}
          <ProvenanceBadge
            provenance={branchProvenance}
            testId="run-branch-provenance"
            reserve={GATE_PROVENANCE_LABELS}
          />
        </span>
        <span data-testid="verify-control" className="flex items-center gap-1.5">
          <Tooltip
            content={
              <span className="whitespace-pre-line">{verifyTooltip(verifyRunAfter, verifyCheck)}</span>
            }
          >
            <label className="flex cursor-pointer items-center gap-1.5">
              <Checkbox
                data-testid="verify-enabled"
                checked={verify}
                aria-label="Verify"
                disabled={onVerify === undefined}
                onCheckedChange={(v) => onVerify?.(v === true)}
              />
              <ListChecks aria-hidden className="size-3.5" />
              <span data-testid="verify-commands" className="tabular-nums">
                <StableLabel labels={VERIFY_LABELS} align="start">
                  {verifyLabel(verifyCommands)}
                </StableLabel>
              </span>
            </label>
          </Tooltip>
          <ProvenanceBadge
            provenance={verifyProvenance}
            testId="verify-provenance"
            reserve={GATE_PROVENANCE_LABELS}
          />
          <Button
            asChild
            size="sm"
            variant="link"
            className="h-auto text-xs [&_svg]:size-3.5"
            data-testid="verify-settings"
          >
            <a href={verifySettingsHref(folder)}>
              <SlidersHorizontal aria-hidden />
              {VERIFY_SETTINGS_LABEL}
            </a>
          </Button>
        </span>
      </div>
      {mode === 'worktree' && (
        <p
          data-testid="isolation-warning"
          data-count={uncommitted ?? undefined}
          title={warning.text}
          className={cn('truncate pl-20 text-xs', warning.warn ? 'text-warning' : 'text-muted-foreground')}
        >
          {warning.text}
        </p>
      )}
    </div>
  )
}
