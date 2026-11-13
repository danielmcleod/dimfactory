// One row of the Runs history (row actions: Open · Re-run with same config · Re-run from Fix, whose tooltip says
// fresh or why · Open diff · Reveal folder · Pin / Remove with undo). The row shows core's
// summary: status, outcome text (the Recent-runs strings), folder, age, duration, cost, and the AUTO and isolated
// chips. Pin and Remove are buttons on the row; the rest are in its actions menu. Re-run from Fix opens the findings
// picker under the row (inline, never a dialog), once its findings are read.
// Nothing moves on its own (UI standard): a removed run leaves a row of the same height in its place, saying so with its
// Undo, instead of the list closing up under the pointer; Re-run from Fix's facts, read when the menu opens, fill a
// line the item always has.
import {
  Ellipsis,
  ExternalLink,
  FileDiff,
  FolderOpen,
  Pin,
  RotateCcw,
  Swords,
  Trash2,
  Undo2,
  Wrench,
} from 'lucide-react'
import { useRef, useState } from 'react'
import type { Finding } from '@shared/findings.ts'
import type { RunSummary } from '@shared/run.ts'
import { useBusy, runCommand } from '../../components/run/commands.ts'
import { FixPicker } from '../../components/run/FixPicker.tsx'
import {
  CHECKING_TEXT,
  loadFindings,
  rerunFromFixOf,
  rerunFromFixSessionText,
  rerunFromFixUnavailableReason,
  rerunFromFixWhyOf,
  RERUN_FROM_FIX_LABEL,
  RERUN_LABEL,
  rerunStart,
  rerunStartHint,
  rerunStartReason,
  revealPickerById,
  stopsSourceFirst,
  vendorsOfSnapshot,
  vendorsOfSummary,
} from '../../components/run/rerun.ts'
import { isolatedChipOf } from '../../components/run/isolation.ts'
import { AutoBadge, Badge, StatusBadge } from '../../components/ui/Badge.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/DropdownMenu.tsx'
import { Tooltip } from '../../components/ui/Tooltip.tsx'
import { cn } from '../../lib/cn.ts'
import { formatAgo, formatDuration, formatRunCost, outcomeText, RUN_PHASE_LABEL } from '../../lib/format.ts'
import { href, navigate } from '../../lib/router.ts'
import { ensureRun } from '../../state/runs.ts'
import { isActiveStatus, useSummary } from '../../state/selectors.ts'
import { useStore } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import { MatchChip, REMATCH_HINT, REMATCH_LABEL } from '../../components/match/MatchChip.tsx'
import { IsolatedChip } from '../dashboard/IsolatedChip.tsx'
import { folderBaseName } from '../dashboard/composer-model.ts'
import { removeRun, undoRemove, UNDO_LABEL, useRemoval } from './removals.ts'
import type { Removal } from './removals.ts'

export const PINNED_REMOVE_REASON = 'Pinned runs are kept. Unpin it to remove it.'
export const ACTIVE_REMOVE_REASON = 'Stop the run before removing it'
export const LOCKED_REMOVE_REASON = 'The run still holds its folder. Close it before removing it.'
export const PIN_TITLE = 'Pin: retention never removes a pinned run'
export const UNPIN_TITLE = 'Pinned: retention keeps it. Click to unpin.'
export const ISOLATED_LABEL = 'Isolated'

/** Why Remove is not offered for this run, from core's summary; null when it is (core checks again). */
export function removeReason(s: RunSummary): string | null {
  if (s.pinned) return PINNED_REMOVE_REASON
  if (isActiveStatus(s.status)) return ACTIVE_REMOVE_REASON
  if (s.lock !== undefined) return LOCKED_REMOVE_REASON
  return null
}

/**
 * "Re-run of #12" / "Re-run from Fix of #12": the run core says this one re-runs (RunSummary.rerunOf; read
 * defensively, an older core sends none); null for a run started anew.
 */
export function rerunOfText(s: RunSummary): string | null {
  const r: unknown = (s as { rerunOf?: unknown }).rerunOf
  if (typeof r !== 'object' || r === null) return null
  const { displayNo, from } = r as { displayNo?: unknown; from?: unknown }
  if (typeof displayNo !== 'number') return null
  return from === 'fix' ? `${RERUN_FROM_FIX_LABEL} of #${displayNo}` : `Re-run of #${displayNo}`
}

/** "Fixed · 3 must · 5 should", then "api · 5 min ago · 4m 12s · $0.62": the row's second line. */
export function rowMeta(s: RunSummary, now: number): { outcome: string; meta: string } {
  const outcome = outcomeText(s) ?? RUN_PHASE_LABEL[s.phase]
  const meta = [folderBaseName(s.folder), formatAgo(s.createdAt, now)]
  // The recipe it ran with, after the folder (`app · Bug fix · 2h ago`).
  if (s.recipe !== undefined) meta.splice(1, 0, s.recipe.label)
  const source = rerunOfText(s)
  if (source !== null) meta.unshift(source)
  if (s.endedAt !== undefined) meta.push(formatDuration(s.endedAt - s.createdAt))
  if (s.progress.costUsd !== null) meta.push(formatRunCost(s))
  return { outcome, meta: meta.join(' · ') }
}

/**
 * The AUTO and isolated chips: amber AUTO for a run made in Auto, "Isolated: not applied" (or "Isolated: apply
 * interrupted") or "Isolated".
 */
function Chips({ s }: { s: RunSummary }): React.JSX.Element {
  return (
    <>
      {s.auto && <AutoBadge data-testid={`runs-auto-${s.runId}`} className="shrink-0" />}
      <MatchChip summary={s} />
      {isolatedChipOf(s) !== null ? (
        <IsolatedChip summary={s} />
      ) : s.isolation === 'worktree' ? (
        <Badge
          variant="outline"
          data-testid={`runs-isolated-${s.runId}`}
          title="The run worked in an isolated copy of the folder"
          className="shrink-0 font-normal text-muted-foreground"
        >
          {ISOLATED_LABEL}
        </Badge>
      ) : null}
    </>
  )
}

const ROW_ITEM = 'flex-col items-start gap-0'
const ROW_SUB = 'max-w-full truncate text-xs text-muted-foreground'

/** The row's actions menu: Open · Re-run with same config · Re-run from Fix · Open diff · Reveal folder. */
function RowMenu({
  s,
  onFixPicker,
  fixLoading,
}: {
  s: RunSummary
  /** Resolves to whether the picker is open. */
  onFixPicker: () => Promise<boolean>
  fixLoading: boolean
}): React.JSX.Element {
  const runId = s.runId
  // Re-run from Fix hands the focus to its picker once that is on the page, not back to this button.
  const handOff = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const snap = useStore((st) => st.runs.byId[runId]?.snapshot ?? null)
  const facts = rerunFromFixOf(s, snap)
  const [busy, run] = useBusy()
  const startReason = rerunStartReason(s)
  const startHint = rerunStartHint(s)
  const fixReason =
    facts === null ? CHECKING_TEXT : facts.available ? null : rerunFromFixUnavailableReason(facts, s)
  const fixText = facts?.available === true ? rerunFromFixSessionText(facts) : (fixReason ?? '')
  const why = rerunFromFixWhyOf(facts, snap !== null ? vendorsOfSnapshot(snap) : vendorsOfSummary(s))
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Core's rerunFromFix comes with the run's snapshot: read it when the menu opens, unless core sent it.
        if (open && facts === null) ensureRun(runId)
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          size="icon"
          variant="ghost"
          aria-label="More actions"
          data-testid={`runs-menu-${runId}`}
          loading={busy !== null || fixLoading}
          icon={<Ellipsis aria-hidden />}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72"
        onCloseAutoFocus={(e) => {
          if (!handOff.current) return
          handOff.current = false
          e.preventDefault()
        }}
      >
        <DropdownMenuItem data-testid="runs-action-open" onSelect={() => navigate({ name: 'run', runId })}>
          <ExternalLink aria-hidden />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="runs-action-rerun"
          disabled={startReason !== null}
          className={ROW_ITEM}
          onSelect={() => run('start', () => rerunStart(runId))}
        >
          <span className="flex items-center gap-2">
            <RotateCcw aria-hidden />
            {RERUN_LABEL}
          </span>
          <span className={cn(ROW_SUB, 'pl-6')} title={startHint} data-testid="runs-action-rerun-text">
            {startHint}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="runs-action-rerun-fix"
          disabled={fixReason !== null}
          className={ROW_ITEM}
          // The item's tooltip says it whole: fresh or not, and why (the line under the label is cut to fit).
          title={why !== null ? `${fixText}. ${why}` : fixText}
          onSelect={() => {
            handOff.current = true
            void onFixPicker().then((open) => {
              if (!open) trigger.current?.focus()
            })
          }}
        >
          <span className="flex items-center gap-2">
            <Wrench aria-hidden />
            {RERUN_FROM_FIX_LABEL}
          </span>
          <span className={cn(ROW_SUB, 'pl-6')} data-testid="runs-action-rerun-fix-text">
            {fixText}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="runs-action-rematch"
          className={ROW_ITEM}
          onSelect={() => navigate({ name: 'rematch', runId })}
        >
          <span className="flex items-center gap-2">
            <Swords aria-hidden />
            {REMATCH_LABEL}
          </span>
          <span className={cn(ROW_SUB, 'pl-6')} title={REMATCH_HINT}>
            {REMATCH_HINT}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="runs-action-diff"
          onSelect={() => navigate({ name: 'run', runId, tab: 'diff' })}
        >
          <FileDiff aria-hidden />
          Open diff
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="runs-action-reveal"
          title={s.folder}
          onSelect={() =>
            run('reveal', () => runCommand(null, 'shell.open', { target: 'folder', path: s.folder }))
          }
        >
          <FolderOpen aria-hidden />
          Reveal folder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PinButton({ s }: { s: RunSummary }): React.JSX.Element {
  const [busy, run] = useBusy()
  const pin = (): void =>
    run('pin', () => runCommand(s.runId, 'runs.pin', { runId: s.runId, pinned: !s.pinned }))
  return (
    <Tooltip content={s.pinned ? UNPIN_TITLE : PIN_TITLE}>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Pin"
        aria-pressed={s.pinned}
        data-testid={`runs-pin-${s.runId}`}
        className={cn(s.pinned && 'text-primary')}
        loading={busy !== null}
        icon={<Pin aria-hidden className={cn(s.pinned && 'fill-current')} />}
        onClick={pin}
      />
    </Tooltip>
  )
}

function RemoveButton({ s }: { s: RunSummary }): React.JSX.Element {
  const [busy, run] = useBusy()
  const reason = removeReason(s)
  const icon = <Trash2 aria-hidden />
  if (reason !== null) {
    return (
      <DisabledHint reason={reason}>
        <Button
          size="icon"
          variant="ghost"
          disabled
          aria-label="Remove"
          data-testid={`runs-remove-${s.runId}`}
          icon={icon}
        />
      </DisabledHint>
    )
  }
  return (
    <Tooltip content="Remove from history (you can undo it)">
      <Button
        size="icon"
        variant="ghost"
        aria-label="Remove"
        data-testid={`runs-remove-${s.runId}`}
        loading={busy !== null}
        icon={icon}
        onClick={() => run('remove', () => removeRun(s))}
      />
    </Tooltip>
  )
}

/** The row a removed run leaves in its place: what was removed, and its Undo (or why it cannot come back). */
function RemovedRow({ rem }: { rem: Removal }): React.JSX.Element {
  const s = rem.summary
  const icon = <Undo2 aria-hidden />
  return (
    <li data-testid={`runs-row-${s.runId}`} data-removed={rem.state} className="flex items-center gap-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-3 px-2 py-1.5">
        <span className="inline-flex w-28 shrink-0 justify-center text-xs text-muted-foreground">
          Removed
        </span>
        <div className="min-w-0 flex-1">
          <p className="h-5 truncate text-sm text-muted-foreground" title={`#${s.displayNo} ${s.title}`}>
            <span className="tabular-nums">#{s.displayNo}</span> {s.title}
          </p>
          <p
            className="truncate text-xs text-muted-foreground"
            data-testid={`runs-removed-${s.runId}`}
            title={rem.reason}
          >
            {rem.state === 'gone'
              ? `Removed for good: ${rem.reason ?? 'it can no longer come back'}`
              : 'Removed from the history. Undo brings it back.'}
          </p>
        </div>
      </div>
      {rem.state === 'gone' ? (
        <DisabledHint reason={rem.reason ?? 'It can no longer come back'}>
          <Button size="sm" variant="outline" disabled data-testid={`runs-undo-${s.runId}`} icon={icon}>
            {UNDO_LABEL}
          </Button>
        </DisabledHint>
      ) : (
        <Button
          size="sm"
          variant="outline"
          data-testid={`runs-undo-${s.runId}`}
          icon={icon}
          loading={rem.state === 'undoing'}
          onClick={() => void undoRemove(s.runId)}
        >
          {UNDO_LABEL}
        </Button>
      )}
    </li>
  )
}

/** Re-run from Fix's picker under the row, with the findings read when it was opened. */
function RowFixPicker({
  s,
  findings,
  onClose,
}: {
  s: RunSummary
  findings: readonly Finding[]
  onClose: () => void
}): React.JSX.Element {
  const snap = useStore((st) => st.runs.byId[s.runId]?.snapshot ?? null)
  const facts = rerunFromFixOf(s, snap)
  return (
    <div className="pb-2 pl-2">
      <FixPicker
        runId={s.runId}
        displayNo={s.displayNo}
        findings={findings}
        facts={facts}
        why={rerunFromFixWhyOf(facts, snap !== null ? vendorsOfSnapshot(snap) : vendorsOfSummary(s))}
        stopsSource={stopsSourceFirst(s)}
        onCancel={onClose}
        idPrefix={`runs-fix-${s.runId}`}
        testId={`runs-fix-picker-${s.runId}`}
      />
    </div>
  )
}

export function RunRow({ runId, now }: { runId: string; now: number }): React.JSX.Element | null {
  const s = useSummary(runId)
  const removal = useRemoval(runId)
  const [picker, setPicker] = useState<readonly Finding[] | null>(null)
  const [fixLoading, setFixLoading] = useState(false)
  if (removal !== undefined) return <RemovedRow rem={removal} />
  if (s === undefined) return null
  const { outcome, meta } = rowMeta(s, now)
  const pickerId = `runs-fix-picker-${runId}`
  // Read the findings first, so the picker appears whole under the row; then bring it into view and focus it.
  const openPicker = async (): Promise<boolean> => {
    if (picker !== null) {
      revealPickerById(pickerId)
      return true
    }
    if (fixLoading) return false
    setFixLoading(true)
    const found = await loadFindings(runId)
    setFixLoading(false)
    if (typeof found === 'string') {
      toast({ level: 'error', message: found })
      return false
    }
    setPicker(found)
    revealPickerById(pickerId)
    return true
  }
  return (
    <li data-testid={`runs-row-${runId}`} data-status={s.status} data-pinned={s.pinned || undefined}>
      <div className="flex items-center gap-2 py-1">
        <a
          href={href({ name: 'run', runId })}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <StatusBadge kind="run" status={s.status} className="w-28 shrink-0 justify-center" />
          <div className="min-w-0 flex-1">
            {/* Clipped: in a narrow row the chips give way at the edge instead of pushing past it. */}
            <div className="flex h-5 min-w-0 items-center gap-1.5 overflow-hidden">
              <p className="min-w-0 truncate text-sm" title={`#${s.displayNo} ${s.title}`}>
                <span className="text-muted-foreground tabular-nums">#{s.displayNo}</span> {s.title}
              </p>
              <Chips s={s} />
            </div>
            <p
              className="truncate text-xs text-muted-foreground tabular-nums"
              title={`${outcome} · ${meta}\n${s.folder}`}
              data-testid={`runs-meta-${runId}`}
            >
              <span className="text-foreground/80" data-testid={`runs-outcome-${runId}`}>
                {outcome}
              </span>{' '}
              · {meta}
            </p>
          </div>
        </a>
        <div className="flex shrink-0 items-center gap-0.5">
          <PinButton s={s} />
          <RemoveButton s={s} />
          <RowMenu s={s} onFixPicker={openPicker} fixLoading={fixLoading} />
        </div>
      </div>
      {picker !== null && <RowFixPicker s={s} findings={picker} onClose={() => setPicker(null)} />}
    </li>
  )
}
