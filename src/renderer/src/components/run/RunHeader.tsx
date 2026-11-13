// RunHeader: title · folder · profile · AUTO (with core's "AUTO approved N") · status ·
// phase · elapsed/ETA · cost · [Auto ▾] [Stop] [Re-run ▾], plus the "Allowed for this run" rules. Status, phase, ETA and cost
// are core's (RunSummary). Re-run ▾ holds Re-run with same config (runs.rerun{from:'start'}, then the new run)
// and Re-run from Fix, which opens the findings picker at the end of the Flow tab (FixPicker.tsx); its line says
// what core's rerunFromFix says (Fix continues Implement's session, or starts fresh and why, in the Fix card's
// session-line words, SessionLine.tsx) or why it is not available.
// UI control standards: the header sits in the Run view's sticky block, so it keeps one height for the whole
// run. Each line is one line that never wraps (what does not fit is cut), the status and phase reserve their widest
// labels (the outcome takes the phase's box once the run ends, and Stop leaves its room), the time with its ETA comes
// last, and the "Allowed for this run" rules sit on the facts line instead of a row that appears with the first rule.
// `compact` (where the full header would leave too little room to read; headerForm.ts) is one row: the title (cut,
// whole in its tooltip with the folder and profile), AUTO, status, phase, cost, the time with its ETA in a box that
// keeps the room of its usual widths, and Stop (a filled square) and Re-run as icon buttons named by their labels and
// tooltips. Where
// the row is narrow (a large zoom), the cost (the SummaryBar has it too), then the time, then the phase give way.
// A run on its own branch says so on the facts line, "On dim/20261008-add-version-flag
// (from main)" (cut to fit, whole in its title), from core's RunSnapshot.branch; the compact row shows a branch icon
// with the same words as its name and tooltip (and in the title's tooltip), giving way before the phase does. The
// end-of-run branch actions are in the Flow tab's "After the run" (RunEndPanel.tsx), where core's answers have room.
import { ChevronDown, FolderOpen, GitBranch, RotateCcw, Square, Swords, Wrench, Zap } from 'lucide-react'
import { useMemo, useRef } from 'react'
import type { AllowRule } from '@shared/events.ts'
import type { RunBranchInfo, RunSnapshot } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import {
  RUN_PHASE_LABEL,
  formatClock,
  formatRunEta,
  formatRunCost,
  outcomeText,
  runCostBasis,
  runCostTitle,
} from '../../lib/format.ts'
import { ariaKeyShortcuts, formatCombo, KEYS } from '../../lib/keys.ts'
import { pricingTitle, runPricingFacts, usePricingFacts } from '../../lib/pricing.ts'
import { navigate } from '../../lib/router.ts'
import { useNow } from '../../lib/ticker.ts'
import { isActiveStatus } from '../../state/selectors.ts'
import { AutoApprovedCount, coreAutoApproved } from '../attention/AutoApproved.tsx'
import { AutoBadge, StatusBadge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { StableLabel } from '../ui/StableLabel.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu.tsx'
import { Tooltip } from '../ui/Tooltip.tsx'
import { branchLineText } from './branch.ts'
import { AutoSwitchMenu, canSwitchToAuto } from './AutoSwitch.tsx'
import { depthFact, depthTitle } from './depth.ts'
import { runCommand, useBusy } from './commands.ts'
import { MatchChip, REMATCH_HINT, REMATCH_LABEL } from '../match/MatchChip.tsx'
import {
  openFixPicker,
  readRerunFromFix,
  RERUN_FROM_FIX_LABEL,
  RERUN_LABEL,
  RERUN_SHORT_LABEL,
  rerunFromFixText,
  rerunFromFixWhy,
  rerunStart,
  rerunStartHint,
  rerunStartReason,
  useFixPickerLoading,
} from './rerun.ts'

const TERMINAL = new Set(['completed', 'cancelled'])

export function isTerminalRun(snap: RunSnapshot): boolean {
  return TERMINAL.has(snap.summary.status)
}

/** What Re-run from Fix would do (or why it cannot), and its "Why?": components/run/rerun.ts. */
export { rerunFromFixText, rerunFromFixWhy } from './rerun.ts'

/**
 * The Re-run button's tooltip: what Re-run from Fix would do with its Why, or why it cannot (the
 * tooltip says fresh or why).
 */
export function rerunTooltip(snap: RunSnapshot): string {
  const facts = readRerunFromFix(snap.rerunFromFix)
  const why = rerunFromFixWhy(snap)
  const text = rerunFromFixText(snap)
  return facts?.available === true
    ? `${text}.${why !== null ? ` ${why}` : ''}`
    : `${RERUN_FROM_FIX_LABEL} is not available: ${text}.`
}

/** `npm test`, `src/**`, `api.example.com`: what an allow rule matches, as narrow as core stored it. */
export function allowRuleText(rule: AllowRule): string {
  const m = rule.match
  const what =
    m.argv !== undefined
      ? m.argv.join(' ')
      : m.argvPrefix !== undefined
        ? `${m.argvPrefix.join(' ')} …`
        : (m.pathGlob ?? m.host ?? '')
  return what !== '' ? `${rule.tool}: ${what}` : rule.tool
}

/** A header line that never wraps: what does not fit is cut, so the sticky header keeps its height. */
const ONE_LINE = 'flex min-w-0 items-center overflow-clip whitespace-nowrap [overflow-clip-margin:0.25rem]'

/** Every phase label, reserved in one box. */
const PHASE_LABELS = Object.values(RUN_PHASE_LABEL)

/**
 * "Allowed for this run: npm test, src/**" on the facts line (never a row of its own that appears with the first
 * rule and moves everything under the sticky header); the full list is the tooltip.
 */
function AllowRules({ rules }: { rules: readonly AllowRule[] }): React.JSX.Element {
  const all = rules.map((r) => `${allowRuleText(r)} (${r.vendor} · ${r.kind})`).join('\n')
  return (
    <>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <Tooltip content={<span className="whitespace-pre-line">{all}</span>}>
        <span tabIndex={0} data-testid="allow-rules" className="min-w-0 truncate rounded px-0.5">
          Allowed for this run:{' '}
          {rules.map((r, i) => (
            <span key={i} className="font-mono text-foreground">
              {i > 0 ? ', ' : ''}
              {allowRuleText(r)}
            </span>
          ))}
        </span>
      </Tooltip>
    </>
  )
}

/** "· On dim/… (from main)" on the facts line: cut to fit, whole in its title. */
function BranchFact({ branch }: { branch: RunBranchInfo }): React.JSX.Element {
  const text = branchLineText(branch)
  return (
    <>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <span data-testid="run-branch" title={text} className="inline-flex min-w-0 shrink items-center gap-1">
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{text}</span>
      </span>
    </>
  )
}

/** The compact row's branch: an icon named by the branch line, which says it as its tooltip too. */
function BranchIcon({ branch }: { branch: RunBranchInfo }): React.JSX.Element {
  const text = branchLineText(branch)
  return (
    <Tooltip content={text}>
      <span
        tabIndex={0}
        role="img"
        aria-label={text}
        data-testid="run-branch"
        className="hidden shrink-0 items-center rounded text-muted-foreground @min-[32rem]:inline-flex"
      >
        <GitBranch aria-hidden className="size-3.5" />
      </span>
    </Tooltip>
  )
}

/** The compact row's time box keeps the room of its usual widths ("12:34 · ETA ~15 min"), so ticking moves nothing. */
const TIME_RESERVE = ['00:00 · ETA ~00 min'] as const

export interface RunHeaderProps {
  snap: RunSnapshot
  /** Stop was pressed (header button, ⌘/Ctrl+.); the page owns it so the shortcut and button agree. */
  onStop: () => void
  stopping: boolean
  /** One row instead of three (the Run view's compact sticky block; headerForm.ts). */
  compact?: boolean
}

/**
 * Re-run ▾: Re-run with same config and Re-run from Fix, each disabled with its reason when it is not offered. The
 * trigger keeps its label; while a re-run starts (or the picker's findings are read), the spinner takes its icon slot.
 */
function RerunMenu({ snap, compact }: { snap: RunSnapshot; compact: boolean }): React.JSX.Element {
  const runId = snap.summary.runId
  const [busy, run] = useBusy()
  const fixLoading = useFixPickerLoading(runId)
  const startReason = rerunStartReason(snap.summary)
  const facts = readRerunFromFix(snap.rerunFromFix)
  const fromFixWhy = rerunFromFixWhy(snap)
  const tip = rerunTooltip(snap)
  const loading = busy !== null || fixLoading
  const icon = <RotateCcw aria-hidden />
  // Re-run from Fix hands the focus to its picker once that is on the page, not back to this button.
  const handOff = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const pickFix = (): void => {
    handOff.current = true
    // The picker is the last thing in the Flow tab: that tab, then the picker once its findings are read.
    navigate({ name: 'run', runId, tab: 'flow' })
    void openFixPicker(runId).then((open) => {
      if (!open) trigger.current?.focus()
    })
  }
  return (
    <DropdownMenu>
      <Tooltip content={compact ? `${RERUN_SHORT_LABEL}. ${tip}` : tip}>
        <DropdownMenuTrigger asChild>
          {compact ? (
            <Button
              ref={trigger}
              size="sm"
              variant="outline"
              data-testid="rerun-menu"
              aria-label="Re-run"
              className="gap-0.5 px-1.5"
              loading={loading}
              icon={icon}
            >
              <ChevronDown aria-hidden />
            </Button>
          ) : (
            <Button
              ref={trigger}
              size="sm"
              variant="outline"
              data-testid="rerun-menu"
              loading={loading}
              icon={icon}
            >
              Re-run
              <ChevronDown aria-hidden />
            </Button>
          )}
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-72"
        onCloseAutoFocus={(e) => {
          if (!handOff.current) return
          handOff.current = false
          e.preventDefault()
        }}
      >
        <DropdownMenuItem
          disabled={startReason !== null}
          data-testid="rerun-start"
          className="flex-col items-start gap-0"
          onSelect={() => run('start', () => rerunStart(runId))}
        >
          <span className="flex items-center gap-2">
            <RotateCcw aria-hidden />
            {RERUN_LABEL}
          </span>
          <span className="pl-6 text-xs text-muted-foreground" data-testid="rerun-start-hint">
            {rerunStartHint(snap.summary)}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={facts?.available !== true}
          data-testid="rerun-from-fix"
          className="flex-col items-start gap-0"
          onSelect={pickFix}
        >
          <span className="flex items-center gap-2">
            <Wrench aria-hidden />
            {RERUN_FROM_FIX_LABEL}
          </span>
          <span className="pl-6 text-xs text-muted-foreground">{rerunFromFixText(snap)}</span>
          {fromFixWhy !== null && (
            <span className="pl-6 text-xs text-muted-foreground" data-testid="rerun-from-fix-why">
              {fromFixWhy}
            </span>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="rerun-rematch"
          className="flex-col items-start gap-0"
          onSelect={() => navigate({ name: 'rematch', runId })}
        >
          <span className="flex items-center gap-2">
            <Swords aria-hidden />
            {REMATCH_LABEL}
          </span>
          <span className="pl-6 text-xs text-muted-foreground">{REMATCH_HINT}</span>
        </DropdownMenuItem>
        <DropdownMenuLabel className="font-normal">
          Re-running starts a new run with this run&apos;s settings.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Stop's icon: a filled square, the media "stop". An outline square in an outlined button with no label beside it (the
 * compact header) reads as an unchecked checkbox.
 */
const STOP_ICON = <Square aria-hidden data-icon="stop" className="fill-current" />

/**
 * Stop, while the run can stop; once it has ended, Stop's room stays (empty), so nothing in the header moves when it
 * ends. The label stays "Stop" while stopping (the phase beside says so); the spinner takes the icon slot.
 */
function StopControl({
  snap,
  onStop,
  stopping,
  compact,
}: {
  snap: RunSnapshot
  onStop: () => void
  stopping: boolean
  compact: boolean
}): React.JSX.Element {
  if (isTerminalRun(snap)) {
    return (
      <span aria-hidden className="invisible" data-testid="stop-run-room">
        {compact ? (
          <Button size="sm" variant="outline" tabIndex={-1} className="px-1.5" icon={STOP_ICON} />
        ) : (
          <Button size="sm" variant="outline" tabIndex={-1} icon={STOP_ICON} kbd={KEYS.stop}>
            Stop
          </Button>
        )}
      </span>
    )
  }
  const loading = stopping || snap.summary.phase === 'stopping'
  if (compact) {
    return (
      <Tooltip content={`Stop (${formatCombo(KEYS.stop)})`}>
        <Button
          size="sm"
          variant="outline"
          data-testid="stop-run"
          aria-label="Stop"
          aria-keyshortcuts={ariaKeyShortcuts(KEYS.stop)}
          className="px-1.5"
          loading={loading}
          icon={STOP_ICON}
          onClick={onStop}
        />
      </Tooltip>
    )
  }
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="stop-run"
      aria-keyshortcuts={ariaKeyShortcuts(KEYS.stop)}
      loading={loading}
      icon={STOP_ICON}
      kbd={KEYS.stop}
      onClick={onStop}
    >
      Stop
    </Button>
  )
}

/**
 * [Auto ▾] while the run goes on outside Auto (AutoSwitch.tsx). Once the run ends its room stays (empty), as Stop's
 * does, so nothing moves when it ends; switching to Auto removes it (the user's own click, and AUTO appears).
 */
function AutoSwitchControl({
  snap,
  compact,
}: {
  snap: RunSnapshot
  compact: boolean
}): React.JSX.Element | null {
  const s = snap.summary
  if (s.auto) return null
  if (!canSwitchToAuto(s)) {
    return (
      <span aria-hidden className="invisible" data-testid="auto-switch-room">
        <Button
          size="sm"
          variant="outline"
          tabIndex={-1}
          className={compact ? 'gap-0.5 px-1.5' : undefined}
          icon={<Zap aria-hidden />}
        >
          {compact ? null : 'Auto'}
          <ChevronDown aria-hidden />
        </Button>
      </span>
    )
  }
  return <AutoSwitchMenu runId={s.runId} form={compact ? 'compact' : 'header'} />
}

/**
 * The status and the phase, each keeping its widest label's width; the outcome takes the phase's box once the run
 * ends. A status or phase change, or the run ending, never moves the cost and time after them.
 */
function StatusAndPhase({ snap, phaseClass }: { snap: RunSnapshot; phaseClass?: string }): React.JSX.Element {
  const s = snap.summary
  // "Fixed · 3 must · 5 should", "Failed at Implement · Claude login expired" … once the run has an outcome.
  const outcome = outcomeText(s)
  return (
    <>
      <StatusBadge kind="run" status={s.status} reserve data-testid="run-status" className="shrink-0" />
      <span className={cn('relative shrink-0', phaseClass)}>
        <span
          data-testid="run-phase"
          data-phase={s.phase}
          className={outcome !== null ? 'invisible' : 'text-muted-foreground'}
        >
          <StableLabel labels={PHASE_LABELS} align="start">
            {RUN_PHASE_LABEL[s.phase]}
          </StableLabel>
        </span>
        {outcome !== null && (
          <span
            data-testid="run-outcome"
            className="absolute inset-y-0 left-0 max-w-full truncate font-medium"
            title={outcome}
          >
            {outcome}
          </span>
        )}
      </span>
    </>
  )
}

export function RunHeader({ snap, onStop, stopping, compact = false }: RunHeaderProps): React.JSX.Element {
  const s = snap.summary
  const terminal = isTerminalRun(snap)
  const now = useNow(!terminal)
  const elapsed = (s.endedAt ?? now) - s.createdAt
  // Core's live ETA: `ETA ~6 min` counting down, or "longer than usual".
  const runEta = formatRunEta(s.progress, now)
  const [busy, run] = useBusy()
  const basis = runCostBasis(s)
  // The tooltip names the pricing a catalog figure came from and the figure is amber when
  // those prices were stale. A run's passes are priced at its own frozen prices (pricingRef), whose facts
  // core sends with each pass's cost; only a run whose costs carry none, while it goes on, names today's catalog.
  const facts = usePricingFacts()
  const own = useMemo(() => runPricingFacts(Object.values(snap.steps).map((v) => v.cost)), [snap.steps])
  const priced = own ?? (isActiveStatus(s.status) ? facts : null)
  const stalePrices = basis === 'catalog' && priced?.stale === true
  const time = `${formatClock(Math.max(0, elapsed))}${!terminal && runEta !== null ? ` · ${runEta}` : ''}`
  const cost = (className?: string): React.JSX.Element => (
    <Tooltip content={runCostTitle(s, priced !== null ? pricingTitle(priced) : undefined)}>
      <span
        tabIndex={0}
        data-testid="run-cost"
        data-stale-prices={stalePrices || undefined}
        className={cn(
          'shrink-0 tabular-nums',
          basis === 'none' && 'text-muted-foreground',
          stalePrices && 'text-warning',
          className,
        )}
      >
        {formatRunCost(s)}
      </span>
    </Tooltip>
  )

  if (compact) {
    return (
      <header
        data-testid="run-header"
        data-form="compact"
        // A size container: where the row is narrow (a small window, a large zoom), the cost (also in the
        // SummaryBar), then the time, then the phase give way whole, so Stop and Re-run always have their room.
        className="@container flex h-10 min-w-0 items-center gap-2.5 overflow-clip border-b px-4 text-xs whitespace-nowrap"
      >
        <h1
          className="min-w-12 flex-1 truncate text-sm font-semibold"
          // Cut to fit: its tooltip says it in full, with the folder, profile and branch the full header shows.
          title={`#${s.displayNo} ${s.title}\n${s.folder} · Profile ${s.profile}${
            snap.depth !== undefined ? ` · ${depthFact(snap.depth)}` : ''
          }${s.recipe !== undefined ? ` · Recipe: ${s.recipe.label}` : ''}${snap.branch !== undefined ? `\n${branchLineText(snap.branch)}` : ''}`}
        >
          {/* A space, not a margin: the heading reads "#1 Add a flag", never "#1Add a flag" (accessibility). */}
          <span className="text-muted-foreground tabular-nums">#{s.displayNo}</span> {s.title}
        </h1>
        {snap.branch !== undefined && <BranchIcon branch={snap.branch} />}
        {s.auto && <AutoBadge data-testid="auto-badge" className="shrink-0" />}
        <StatusAndPhase snap={snap} phaseClass="hidden @min-[29rem]:inline-block" />
        {cost('hidden @min-[40rem]:inline')}
        <span
          className="hidden shrink-0 text-muted-foreground tabular-nums @min-[36rem]:inline-block"
          data-testid="run-elapsed"
        >
          <StableLabel labels={TIME_RESERVE} align="start">
            {time}
          </StableLabel>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <AutoSwitchControl snap={snap} compact />
          <StopControl snap={snap} onStop={onStop} stopping={stopping} compact />
          <RerunMenu snap={snap} compact />
        </div>
      </header>
    )
  }

  return (
    <header data-testid="run-header" data-form="full" className="flex flex-col gap-2 border-b px-4 pt-3 pb-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold" title={s.title}>
            <span className="text-muted-foreground tabular-nums">#{s.displayNo}</span> {s.title}
          </h1>
          <div className={cn('mt-0.5 h-5 gap-x-2 text-xs text-muted-foreground', ONE_LINE)}>
            <button
              type="button"
              data-testid="run-folder"
              // The path is cut to fit: its tooltip says it in full.
              title={`Open the folder: ${s.folder}`}
              onClick={() =>
                run('folder', () => runCommand(null, 'shell.open', { target: 'folder', path: s.folder }))
              }
              className="inline-flex max-w-[28rem] min-w-16 shrink items-center gap-1 truncate rounded px-0.5 hover:bg-accent hover:text-foreground"
            >
              <FolderOpen aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{s.folder}</span>
            </button>
            <span aria-hidden className="shrink-0">
              ·
            </span>
            <span className="shrink-0">Profile {s.profile}</span>
            {snap.depth !== undefined && (
              <>
                <span aria-hidden className="shrink-0">
                  ·
                </span>
                <span
                  data-testid="run-depth"
                  data-depth={snap.depth.depth}
                  data-escalated={snap.depth.escalated !== undefined ? 'true' : undefined}
                  title={depthTitle(snap.depth)}
                  className="shrink-0"
                >
                  {depthFact(snap.depth)}
                </span>
              </>
            )}
            {s.recipe !== undefined && (
              <>
                <span aria-hidden className="shrink-0">
                  ·
                </span>
                <span data-testid="run-recipe" className="shrink-0">
                  Recipe: {s.recipe.label}
                </span>
              </>
            )}
            {s.isolation === 'worktree' && (
              <>
                <span aria-hidden className="shrink-0">
                  ·
                </span>
                <span className="shrink-0">Isolated</span>
              </>
            )}
            {s.matchOf !== undefined && <MatchChip summary={s} link />}
            {snap.branch !== undefined && <BranchFact branch={snap.branch} />}
            {snap.allowRules.length > 0 && <AllowRules rules={snap.allowRules} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AutoSwitchControl snap={snap} compact={false} />
          <StopControl snap={snap} onStop={onStop} stopping={stopping} compact={false} />
          <RerunMenu snap={snap} compact={false} />
        </div>
      </div>
      <div className={cn('h-6 gap-x-3 text-sm', ONE_LINE)}>
        {s.auto && (
          <>
            <AutoBadge data-testid="auto-badge" className="shrink-0" />
            <AutoApprovedCount count={coreAutoApproved(snap) ?? 0} className="shrink-0 text-xs" />
          </>
        )}
        <StatusAndPhase snap={snap} />
        {cost()}
        {/* Last on the line: the ETA that comes and goes moves nothing after it. */}
        <span className="shrink-0 text-muted-foreground tabular-nums" data-testid="run-elapsed">
          {time}
        </span>
        {busy === 'folder' && <span className="sr-only">Opening the folder</span>}
      </div>
    </header>
  )
}
