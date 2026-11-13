// The Diff tab's toolbar: Implement | Fix | Combined (only the segments core says the
// run has) · Split | Stacked · Ignore line endings · Mark all reviewed · Revert all, and what the segment changed.
// Every control keeps its size and place whatever its state: a control that cannot act stays where it is, disabled,
// with the reason (DisabledHint). It sits in the page's flow above the files, not sticky: the Run view's own sticky
// block is the page's top bar. Under it, one line of a fixed height: what the segment changed (cut, whole in its
// tooltip) and, when the run has changed its files since the list was shown, [Show the latest changes] (the list is
// never replaced on its own, so nothing moves while the user reads).
import { CheckCheck, RefreshCw } from 'lucide-react'
import { useId } from 'react'
import type { DiffSegment } from '@shared/ipc.ts'
import { formatCombo, ariaKeyShortcuts, KEYS } from '../../lib/keys.ts'
import { RevertAllButton } from '../run/RevertAllButton.tsx'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import { Switch } from '../ui/Switch.tsx'
import { Segmented } from './Segmented.tsx'
import {
  ALL_REVIEWED,
  IGNORE_EOL_LABEL,
  LAYOUT_LABEL,
  MARK_ALL_LABEL,
  NEWER_CHANGES_TEXT,
  SEGMENT_HINT,
  SEGMENT_LABEL,
  SHOW_NEWER_LABEL,
} from './text.ts'
import type { DiffLayout } from './text.ts'

export interface DiffToolbarProps {
  runId: string
  /** Core's segments for the run (DiffFiles.available); empty until it answers. */
  segments: readonly DiffSegment[]
  seg: DiffSegment
  onSeg: (seg: DiffSegment) => void
  layout: DiffLayout
  onLayout: (layout: DiffLayout) => void
  ignoreEol: boolean
  onIgnoreEol: (on: boolean) => void
  /** Files not marked reviewed yet. */
  unreviewed: number
  onMarkAll: () => void
  markingAll: boolean
  /** Why Revert all cannot run (a saved patch, no changes), before the folder's own reason. */
  revertAllReason: string | undefined
  /** "2 files changed +12 −3": what the segment changed. */
  summary: string
  /** Core has a newer list than the one shown (held so nothing moves on its own). */
  newer: boolean
  onShowNewer: () => void
  /** After Revert all and its Undo: the user's own change, shown at once. */
  onReverted?: () => void
}

export function DiffToolbar(p: DiffToolbarProps): React.JSX.Element {
  const id = useId()
  const eolId = `${id}-eol`
  const markIcon = <CheckCheck aria-hidden />
  const segments = p.segments.includes(p.seg) ? p.segments : [...p.segments, p.seg]
  return (
    <div className="flex flex-col gap-2" data-testid="diff-toolbar">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented
          label="Changes from"
          testId="diff-segments"
          options={segments.map((s) => ({ value: s, label: SEGMENT_LABEL[s], hint: SEGMENT_HINT[s] }))}
          value={p.seg}
          onChange={p.onSeg}
        />
        <Segmented
          label={`Layout (${formatCombo(KEYS.diffLayout)})`}
          testId="diff-layout"
          keyShortcuts={ariaKeyShortcuts(KEYS.diffLayout)}
          options={(['split', 'stacked'] as const).map((l) => ({ value: l, label: LAYOUT_LABEL[l] }))}
          value={p.layout}
          onChange={p.onLayout}
        />
        <span className="inline-flex items-center gap-2">
          <Switch
            id={eolId}
            checked={p.ignoreEol}
            onCheckedChange={p.onIgnoreEol}
            data-testid="diff-ignore-eol"
          />
          <label htmlFor={eolId} className="text-xs whitespace-nowrap select-none">
            {IGNORE_EOL_LABEL}
          </label>
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {p.unreviewed === 0 && !p.markingAll ? (
            <DisabledHint reason={ALL_REVIEWED}>
              <Button size="sm" variant="outline" disabled icon={markIcon} data-testid="diff-mark-all">
                {MARK_ALL_LABEL}
              </Button>
            </DisabledHint>
          ) : (
            <Button
              size="sm"
              variant="outline"
              icon={markIcon}
              loading={p.markingAll}
              data-testid="diff-mark-all"
              onClick={p.onMarkAll}
            >
              {MARK_ALL_LABEL}
            </Button>
          )}
          <RevertAllButton
            runId={p.runId}
            testId="diff-revert-all"
            disabledReason={p.revertAllReason}
            {...(p.onReverted !== undefined ? { onDone: p.onReverted } : {})}
          />
        </span>
      </div>
      <div className="flex h-7 min-w-0 items-center gap-3">
        <p
          className="min-w-0 truncate text-sm text-muted-foreground tabular-nums"
          title={p.summary}
          data-testid="diff-summary"
        >
          {p.summary}
        </p>
        <span role="status" className="sr-only" data-testid="diff-newer-status">
          {p.newer ? NEWER_CHANGES_TEXT : ''}
        </span>
        {p.newer && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto shrink-0"
            icon={<RefreshCw aria-hidden />}
            title={NEWER_CHANGES_TEXT}
            data-testid="diff-show-newer"
            onClick={p.onShowNewer}
          >
            {SHOW_NEWER_LABEL}
          </Button>
        )}
      </div>
    </div>
  )
}
