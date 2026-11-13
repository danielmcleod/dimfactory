// The composer's passes block (pass rows, Fix row, gates line, In place | Isolated
// run, New run branch, Verify, the Critic-swap chip, and the footer "Save all overrides as project default").
// The one-line profile summary (data-testid `composer-passes`) toggles the five rows; each row expands on its own.
// Values and provenance are core's (config.resolve); edits become run overrides.
//
// Core's configuration arrives after the first paint, so until then PassRowsPending holds the same summary line
// ("Reading the configuration…") and, with the rows open, the open rows' last measured height (state.ts
// usePassesHeight): the rows arriving move nothing below them (UI standard). The summary
// line never wraps; a configuration error takes the passes text's place in it.
import { ArrowLeftRight, ChevronRight, Save } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ProvenanceMap, RunOverrides } from '@shared/config-schema.ts'
import type { RunEstimate } from '@shared/estimates.ts'
import type { ComposerSuggestions } from '@shared/ipc.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import type { PassName } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { isolationIneligible, uncommittedCount } from '../../../components/run/isolation.ts'
import { Badge } from '../../../components/ui/Badge.tsx'
import { Button } from '../../../components/ui/Button.tsx'
import { DisabledHint } from '../../../components/ui/DisabledHint.tsx'
import { StableLabel } from '../../../components/ui/StableLabel.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import { cn } from '../../../lib/cn.ts'
import { passesLine } from '../composer-model.ts'
import type { ComposerActions } from './actions.ts'
import { GatesLine } from './GatesLine.tsx'
import { IsolationControls } from './IsolationControls.tsx'
import {
  checkById,
  criticSwapTarget,
  criticSwapTooltip,
  gatesOf,
  isolationModeOf,
  otherFixVendor,
  PASS_ORDER,
  passOf,
  vendorText,
  verifyCommandCount,
  verifyEnabledOf,
  verifyRunAfterOf,
} from './model.ts'
import type { FixSession, ResolvedView } from './model.ts'
import {
  countOverrides,
  isEmptyOverrides,
  passOverride,
  setGate,
  setIsolationBranch,
  setIsolationMode,
  setPassValues,
  setVerifyEnabled,
} from './overrides.ts'
import { withoutTools } from './tools.ts'
import type { OverridesUpdate } from './state.ts'
import { PassRow } from './PassRow.tsx'
import type { VendorModels } from './useVendorModels.ts'

export interface PassRowsProps {
  config: ResolvedView
  provenance: ProvenanceMap
  probes: readonly ProbeView[]
  report: PreflightReport | null
  estimate: RunEstimate | null
  overrides: RunOverrides
  update: (fn: OverridesUpdate) => void
  actions: ComposerActions
  models: VendorModels
  /** The committed folder when it is a full path (saving needs one). */
  folder: string | null
  open: boolean
  onOpen: (open: boolean) => void
  /** Core's Critic swap and Fix session answers (config.resolve); absent from an older core. */
  suggestions?: ComposerSuggestions | undefined
  /** config.resolve's last error, shown in the summary line instead of the passes text. */
  error?: string | null
  /** Called with the open rows' height (all rows collapsed), so the composer can reserve it next time. */
  onMeasure?: (px: number) => void
}

/** The passes toggle (the same in PassRows and PassRowsPending, so the summary line never changes). */
function PassesToggle({
  open,
  onOpen,
  panelId,
}: {
  open: boolean
  onOpen: (open: boolean) => void
  panelId: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="composer-passes-toggle"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => onOpen(!open)}
      className="inline-flex shrink-0 items-center gap-1 rounded-md py-0.5 pr-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      <StableLabel labels={PASSES_TOGGLE_LABELS} align="start">
        {open ? 'Hide passes' : 'Passes'}
      </StableLabel>
    </button>
  )
}

/** config.resolve's error, in the summary line (one line, whole in its title). */
function ConfigError({ text }: { text: string }): React.JSX.Element {
  return (
    <p
      data-testid="composer-config-error"
      title={text}
      className="min-w-0 flex-1 truncate text-xs text-destructive"
    >
      {text}
    </p>
  )
}

/**
 * The passes block before core's configuration arrives: the same summary line, and with the rows open, the room they
 * took last time. A configuration error ends the wait (there are no rows to show).
 */
export function PassRowsPending({
  open,
  onOpen,
  reservedPx,
  error,
}: {
  open: boolean
  onOpen: (open: boolean) => void
  reservedPx: number
  error: string | null
}): React.JSX.Element {
  const panelId = useId()
  return (
    <div
      data-testid="composer-passes-pending"
      aria-busy={error === null || undefined}
      style={open && error === null ? { minHeight: reservedPx } : undefined}
      className="flex flex-col gap-1.5"
    >
      {/* The summary line's own height (PassRows: the swap chip's h-6), so the pending → loaded swap moves nothing. */}
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <PassesToggle open={open} onOpen={onOpen} panelId={panelId} />
        {error !== null ? (
          <ConfigError text={error} />
        ) : (
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Reading the configuration…</p>
        )}
      </div>
      {open && error === null && <div id={panelId} />}
    </div>
  )
}

/** The passes disclosure reserves both labels' width (the chevron and aria-expanded carry the state too). */
const PASSES_TOGGLE_LABELS: readonly string[] = ['Passes', 'Hide passes']

export function PassRows(p: PassRowsProps): React.JSX.Element {
  const { config, probes, overrides, update, actions } = p
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const [openRows, setOpenRows] = useState<ReadonlySet<PassName>>(() => new Set())
  const toggleRow = (pass: PassName): void =>
    setOpenRows((cur) => {
      const next = new Set(cur)
      if (next.has(pass)) next.delete(pass)
      else next.add(pass)
      return next
    })
  // The run's Tools (the Tools row) are for this run only: not counted here, never saved to the project.
  const saveable = withoutTools(overrides)
  const overrideCount = countOverrides(saveable)
  const swap = criticSwapTarget(p.suggestions)
  const swapLabel = swap !== null ? vendorText(swap, config, probes) : null
  // Every vendor the suggestion could name: the button keeps one width whichever it names.
  const swapLabels = [swapLabel ?? '', ...probes.map((v) => vendorText(v.vendor, config, probes))].map(
    (name) => `Swap Critic to ${name}`,
  )
  const gates = gatesOf(config)
  const saveBlocked = p.folder === null ? 'Choose a folder first' : null
  const otherFix = otherFixVendor(p.suggestions)

  const fixSession = (s: FixSession): void => {
    if (s === 'reuse')
      update((o) => setPassValues(o, 'fix', { reuseSession: true }, ['vendor', 'model', 'effort']))
    else if (s === 'fresh')
      update((o) => setPassValues(o, 'fix', { reuseSession: false }, ['vendor', 'model', 'effort']))
    else if (otherFix !== null)
      update((o) =>
        setPassValues(o, 'fix', { reuseSession: false, vendor: otherFix, model: null, effort: null }),
      )
  }

  // The open rows' height while every row is collapsed: what PassRowsPending reserves next time.
  const { onMeasure } = p
  const measuring = p.open && openRows.size === 0
  useEffect(() => {
    const el = root.current
    if (!measuring || el === null || onMeasure === undefined) return
    const measure = (): void => {
      const h = el.getBoundingClientRect().height
      if (h > 0) onMeasure(h)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measuring, onMeasure])

  return (
    <div ref={root} className="flex flex-col gap-1.5">
      {/* One line that never wraps: the passes text gives way (ellipsis) to the badge and the swap chip. It has the
          swap chip's height (h-6) from the start, so the chip that comes with a vendor's probe (e.g. Gemini
          ready seconds after the Dashboard showed) moves nothing below it. */}
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <PassesToggle open={p.open} onOpen={p.onOpen} panelId={panelId} />
        {p.error !== undefined && p.error !== null ? (
          <ConfigError text={p.error} />
        ) : (
          <p
            data-testid="composer-passes"
            title={passesLine(config)}
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          >
            {passesLine(config)}
          </p>
        )}
        {overrideCount > 0 && (
          <Badge
            variant="auto"
            data-testid="composer-override-count"
            className="shrink-0 text-[10px] font-normal tabular-nums"
          >
            {overrideCount} run {overrideCount === 1 ? 'override' : 'overrides'}
          </Badge>
        )}
        {swap !== null && swapLabel !== null && (
          <Tooltip
            content={criticSwapTooltip(
              vendorText(passOf(config, 'implement').vendor, config, probes),
              swapLabel,
              probes.find((v) => v.vendor === swap),
            )}
          >
            <Button
              size="sm"
              variant="outline"
              data-testid="critic-swap"
              onClick={() => actions.swapCritic(swap, swapLabel)}
              className="h-6 shrink-0 text-xs"
              icon={<ArrowLeftRight aria-hidden />}
              labels={swapLabels}
            >
              {`Swap Critic to ${swapLabel}`}
            </Button>
          </Tooltip>
        )}
      </div>
      {p.open && (
        <div id={panelId} className="flex flex-col gap-2 border-l pl-3">
          <ul aria-label="Passes" className="flex flex-col gap-0.5">
            {PASS_ORDER.map((pass) => (
              <PassRow
                key={pass}
                pass={pass}
                config={config}
                provenance={p.provenance}
                probes={probes}
                report={p.report}
                estimate={p.estimate}
                models={p.models.options(passOf(config, pass).vendor)}
                open={openRows.has(pass)}
                onToggle={() => toggleRow(pass)}
                overridden={passOverride(overrides, pass) !== undefined}
                saveBlocked={saveBlocked}
                saving={actions.saving === pass}
                onChange={(values, remove) => update((o) => setPassValues(o, pass, values, remove))}
                onSave={() => void actions.saveRow(pass)}
                onReset={() => actions.resetRow(pass)}
                onWantModels={p.models.want}
                suggestions={p.suggestions}
                {...(pass === 'fix' ? { otherFixVendor: otherFix, onFixSession: fixSession } : {})}
              />
            ))}
          </ul>
          {gates !== null && (
            <GatesLine
              gates={gates}
              auto={config.auto}
              provenance={p.provenance}
              onChange={(gate, value) => update((o) => setGate(o, gate, value))}
            />
          )}
          <IsolationControls
            // The user's pending choice at once (like Auto), core's resolved value otherwise.
            mode={overrides.isolation?.mode ?? isolationModeOf(config)}
            branch={overrides.isolation?.branch ?? config.isolation?.branch ?? 'none'}
            verifyCommands={verifyCommandCount(config)}
            onInPlace={() => update((o) => setIsolationMode(o, 'inPlace'))}
            onIsolated={() => update((o) => setIsolationMode(o, 'worktree'))}
            isolatedBlocked={isolationIneligible(p.report)}
            uncommitted={uncommittedCount(p.report)}
            onBranch={(b) => update((o) => setIsolationBranch(o, b))}
            branchProvenance={p.provenance['/isolation/branch']}
            branchCheck={checkById(p.report, 'run.branch')}
            verify={overrides.verify?.enabled ?? verifyEnabledOf(config)}
            onVerify={(v) => update((o) => setVerifyEnabled(o, v))}
            verifyProvenance={p.provenance['/verify/enabled']}
            verifyCheck={checkById(p.report, 'run.verify')}
            verifyRunAfter={verifyRunAfterOf(config)}
            folder={p.folder}
          />
        </div>
      )}
      {/* The footer stays reachable with the rows hidden: profile and Auto are run overrides too. */}
      {(p.open || !isEmptyOverrides(saveable)) && (
        <div className="flex items-center gap-2">
          {isEmptyOverrides(saveable) || saveBlocked !== null ? (
            <DisabledHint reason={saveBlocked ?? 'Nothing to save: no run overrides yet'}>
              <Button
                size="sm"
                variant="ghost"
                disabled
                data-testid="save-project-default"
                icon={<Save aria-hidden />}
              >
                Save all overrides as project default
              </Button>
            </DisabledHint>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              data-testid="save-project-default"
              icon={<Save aria-hidden />}
              loading={actions.saving === 'all'}
              onClick={() => void actions.saveAll()}
            >
              Save all overrides as project default
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
