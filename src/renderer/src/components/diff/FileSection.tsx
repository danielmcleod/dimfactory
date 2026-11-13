// One file of the Diff tab: its header (expand or collapse, core's status letter, the path
// or the rename, edited-after-run and mode chips, +/- counts, the Reviewed mark, Revert) and its body, the diff or a
// special row (SpecialRows.tsx).
// - Lazy: the body asks core for the patch and lays it out only once the section is near the page scroller's view
//   (useNearView), and the section is `content-visibility: auto` with its estimated height as its intrinsic size, so
//   the browser skips laying out files out of view. Until a body's diff has drawn (PatchView's onDrawn), it keeps the
//   estimated height (an added or deleted file has no context rows), so the page does not jump as diffs arrive.
// - A diff on screen stays until its replacement has drawn (a new patch for the file, Ignore line endings): the next
//   one lays out unseen beside it and takes its place in one step, never via the estimate.
// - A file with more than 3000 changed lines starts collapsed, with an Expand control and no request to core.
// - Revert keeps its place and label; while it cannot run (the folder is busy, a saved patch, a submodule) it shows
//   the reason (DisabledHint), and while core reverts the spinner takes its icon slot.
// - The section takes focus (J/K, or a click inside it) without scrolling on its own; J/K's jump is the caller's.
import { ChevronRight, Undo2 } from 'lucide-react'
import { Suspense, lazy, useId, useRef, useState } from 'react'
import type { DiffFilePatch, DiffSegment, FileChange } from '@shared/ipc.ts'
import { cn } from '../../lib/cn.ts'
import { ariaKeyShortcuts, KEYS } from '../../lib/keys.ts'
import { useBusy } from '../run/commands.ts'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Checkbox } from '../ui/Checkbox.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import { patchKey, usePatch } from './patches.ts'
import { BinaryBody, MessageRow, looksLikeImage } from './SpecialRows.tsx'
import {
  COLLAPSE_LABEL,
  DIFF_CUT_SHORT,
  CHANGED_BY_FIX,
  CHANGED_BY_FIX_HINT,
  EDITED_AFTER_RUN,
  EDITED_AFTER_RUN_HINT,
  EOL_ONLY_TEXT,
  EXPAND_LABEL,
  GITLINK_REVERT_REASON,
  LOADING_DIFF,
  NO_TEXT_CHANGES,
  REVERT_FILE_LABEL,
  REVIEWED_LABEL,
  STATUS_LABEL,
  gitlinkText,
  isLarge,
  largeText,
  metadataText,
  modeChanged,
  modeText,
  onlyMetadata,
  similarityText,
} from './text.ts'
import type { DiffLayout } from './text.ts'
import { useNearView } from './useNearView.ts'

/** The diff renderer (@pierre/diffs, Shiki), loaded the first time a diff shows. */
const PatchView = lazy(() => import('./PatchView.tsx').then((m) => ({ default: m.PatchView })))

/** Height of one diff row at the default size (px), for the estimate a section holds before its diff lays out. */
const ROW_PX = 20
const HEADER_PX = 41
const ROW_BODY_PX = 40
const IMAGE_BODY_PX = 232

/** The tone of core's status letter. */
const STATUS_TONE: Readonly<Record<FileChange['status'], string>> = {
  A: 'text-diff-add border-diff-add/40',
  D: 'text-diff-del border-diff-del/40',
  M: 'text-info border-info/40',
  R: 'text-st-waiting border-st-waiting/40',
  T: 'text-warning border-warning/40',
}

export function StatusLetter({ status }: { status: FileChange['status'] }): React.JSX.Element {
  return (
    <span
      title={STATUS_LABEL[status]}
      data-status={status}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded border font-mono text-[11px] font-semibold',
        STATUS_TONE[status],
      )}
    >
      <span aria-hidden>{status}</span>
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  )
}

/** "+12 −3" in the diff colours; a binary file has no line counts. */
export function Counts({ f }: { f: FileChange }): React.JSX.Element {
  if (f.added === null || f.deleted === null) {
    return (
      <span className="shrink-0 text-xs text-muted-foreground">{f.gitlink ? 'Submodule' : 'Binary'}</span>
    )
  }
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums" data-testid="diff-counts">
      <span className="text-diff-add">+{f.added}</span>{' '}
      <span className="text-diff-del">
        {'−'}
        {f.deleted}
      </span>
    </span>
  )
}

/** "src/old.ts → src/new.ts" for a rename, else the path. */
export function pathText(f: FileChange): string {
  return f.status === 'R' && f.oldPath !== undefined ? `${f.oldPath} → ${f.path}` : f.path
}

/** What the body is: a special row, or a diff from core's patch. */
type BodyKind = 'gitlink' | 'binary' | 'eol' | 'meta' | 'patch'

function bodyKind(f: FileChange): BodyKind {
  if (f.gitlink) return 'gitlink'
  if (f.binary) return 'binary'
  if (f.eolOnly) return 'eol'
  if (onlyMetadata(f)) return 'meta'
  return 'patch'
}

/** The body's height before it lays out (px): rows of the layout, or a special row's. */
export function estimateBodyPx(f: FileChange, layout: DiffLayout): number {
  const kind = bodyKind(f)
  if (kind === 'binary') return looksLikeImage(f.path) ? IMAGE_BODY_PX : ROW_BODY_PX
  if (kind !== 'patch') return ROW_BODY_PX
  const a = f.added ?? 0
  const d = f.deleted ?? 0
  const rows = layout === 'split' ? Math.max(a, d) : a + d
  // Context lines and hunk separators: a few per hunk, unknown until the patch is here. An added or deleted file is
  // one hunk of its own lines, with no context.
  const context = f.status === 'A' || f.status === 'D' ? 0 : 8
  return (rows + context) * ROW_PX + 16
}

/** One drawn (or drawing) diff of the body. */
function DiffView({
  value,
  cacheKey,
  layout,
  theme,
  minHeight,
  next,
  onDrawn,
}: {
  value: DiffFilePatch
  cacheKey: string
  layout: DiffLayout
  theme: 'light' | 'dark'
  /** Held until it has drawn (the estimate), else none. */
  minHeight: number | undefined
  /** Laid out unseen over the diff on screen until it has drawn. */
  next: boolean
  onDrawn: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid={next ? 'diff-view-next' : 'diff-view'}
      aria-hidden={next || undefined}
      className={cn(next && 'pointer-events-none invisible absolute inset-x-0 top-0')}
      style={minHeight !== undefined ? { minHeight } : undefined}
    >
      {value.truncated && <MessageRow testId="diff-truncated">{DIFF_CUT_SHORT}</MessageRow>}
      <Suspense fallback={<MessageRow testId="diff-loading">{LOADING_DIFF}</MessageRow>}>
        <PatchView patch={value.patch} cacheKey={cacheKey} layout={layout} theme={theme} onDrawn={onDrawn} />
      </Suspense>
    </div>
  )
}

function PatchBody({
  runId,
  seg,
  f,
  layout,
  theme,
  ignoreEol,
  near,
}: {
  runId: string
  seg: DiffSegment
  f: FileChange
  layout: DiffLayout
  theme: 'light' | 'dark'
  ignoreEol: boolean
  near: boolean
}): React.JSX.Element {
  const key = patchKey(runId, seg, f, ignoreEol)
  const patch = usePatch(runId, seg, f, ignoreEol, near)
  /** The last diff that has drawn: it stays on screen until the next one has drawn too. */
  const [shown, setShown] = useState<{ key: string; value: DiffFilePatch } | null>(null)
  const estimate = estimateBodyPx(f, layout)
  if (patch !== null && patch.kind === 'error') {
    return (
      <MessageRow testId="diff-error" tone="error">
        {patch.message}
      </MessageRow>
    )
  }
  const ready = patch !== null && patch.kind === 'ready' ? patch.value : null
  if (ready !== null && ready.patch === '') {
    return <MessageRow testId="diff-empty">{ignoreEol ? EOL_ONLY_TEXT : NO_TEXT_CHANGES}</MessageRow>
  }
  const drawn = (value: DiffFilePatch) => () =>
    setShown((s) => (s?.key === key && s.value === value ? s : { key, value }))
  if (shown === null && ready === null) {
    return (
      <div style={{ minHeight: estimate }} aria-busy="true" data-testid="diff-pending">
        <MessageRow testId="diff-loading">{LOADING_DIFF}</MessageRow>
      </div>
    )
  }
  // One wrapper whatever the state, each diff keyed by its content: the first diff (held at the estimate until it has
  // drawn), the diff on screen, and its replacement laid out unseen until it has drawn. A drawn diff is never mounted
  // again.
  const views: { key: string; value: DiffFilePatch; next: boolean }[] = []
  if (shown !== null) views.push({ key: shown.key, value: shown.value, next: false })
  if (ready !== null && shown?.key !== key) views.push({ key, value: ready, next: shown !== null })
  return (
    <div className="relative" aria-busy={shown?.key !== key || undefined}>
      {views.map((v) => (
        <DiffView
          key={v.key}
          value={v.value}
          cacheKey={v.key}
          layout={layout}
          theme={theme}
          minHeight={shown === null ? estimate : undefined}
          next={v.next}
          onDrawn={v.key === key ? drawn(v.value) : () => undefined}
        />
      ))}
    </div>
  )
}

export interface FileSectionProps {
  runId: string
  seg: DiffSegment
  file: FileChange
  /** Position in the list (its element id: `diff-file-<index>`). */
  index: number
  reviewed: boolean
  onReviewed: (value: boolean) => void
  collapsed: boolean
  onCollapsed: (value: boolean) => void
  layout: DiffLayout
  theme: 'light' | 'dark'
  ignoreEol: boolean
  /** Why Revert cannot run now (the folder is busy, a saved patch), or undefined. */
  revertReason: string | undefined
  onRevert: () => Promise<boolean>
  /** Focus came into the section (J/K and R act from it). */
  onFocusFile: () => void
}

export function FileSection({
  runId,
  seg,
  file: f,
  index,
  reviewed,
  onReviewed,
  collapsed,
  onCollapsed,
  layout,
  theme,
  ignoreEol,
  revertReason,
  onRevert,
  onFocusFile,
}: FileSectionProps): React.JSX.Element {
  const id = useId()
  const titleId = `${id}-title`
  const bodyId = `${id}-body`
  const checkId = `${id}-reviewed`
  const ref = useRef<HTMLElement>(null)
  const near = useNearView(ref)
  const [busy, run] = useBusy()
  const kind = bodyKind(f)
  const large = isLarge(f)
  const estimate = HEADER_PX + (collapsed ? (large ? ROW_BODY_PX : 0) : estimateBodyPx(f, layout))
  const reason = f.gitlink ? GITLINK_REVERT_REASON : revertReason
  const revertIcon = <Undo2 aria-hidden />

  return (
    <article
      ref={ref}
      id={`diff-file-${index}`}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-keyshortcuts={`${ariaKeyShortcuts(KEYS.diffNext)} ${ariaKeyShortcuts(KEYS.diffPrev)}`}
      data-testid="diff-file"
      data-path={f.path}
      data-status={f.status}
      data-reviewed={reviewed ? '' : undefined}
      data-collapsed={collapsed ? '' : undefined}
      onFocus={onFocusFile}
      style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${estimate}px` }}
      className="scroll-mt-2 rounded-md border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <header className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 rounded-t-md border-b bg-muted/50 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${collapsed ? EXPAND_LABEL : COLLAPSE_LABEL} ${f.path}`}
          data-testid="diff-file-toggle"
          onClick={() => onCollapsed(!collapsed)}
        >
          <ChevronRight
            aria-hidden
            className={cn('transition-transform motion-reduce:transition-none', !collapsed && 'rotate-90')}
          />
        </Button>
        <StatusLetter status={f.status} />
        <h3
          id={titleId}
          title={pathText(f)}
          className="min-w-0 flex-1 basis-40 truncate font-mono text-xs font-medium"
          data-testid="diff-file-path"
        >
          {pathText(f)}
        </h3>
        {f.editedAfterRun === true && (
          <Badge variant="outline" title={EDITED_AFTER_RUN_HINT} data-testid="diff-edited-after-run">
            {EDITED_AFTER_RUN}
          </Badge>
        )}
        {f.changedByFix === true && (
          <Badge variant="outline" title={CHANGED_BY_FIX_HINT} data-testid="diff-changed-by-fix">
            {CHANGED_BY_FIX}
          </Badge>
        )}
        {modeChanged(f) && (
          <Badge variant="outline" data-testid="diff-mode">
            {modeText(f)}
          </Badge>
        )}
        {similarityText(f) !== null && (
          <Badge variant="outline" data-testid="diff-similarity">
            {similarityText(f)}
          </Badge>
        )}
        <Counts f={f} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1.5">
            <Checkbox
              id={checkId}
              checked={reviewed}
              onCheckedChange={(v) => onReviewed(v === true)}
              aria-keyshortcuts={ariaKeyShortcuts(KEYS.diffReviewed)}
              // Accessibility: each file's box names its file ("Reviewed src/a.ts"), not one of many "Reviewed".
              aria-labelledby={`${checkId}-label ${titleId}`}
              data-testid="diff-file-reviewed"
            />
            <label id={`${checkId}-label`} htmlFor={checkId} className="text-xs select-none">
              {REVIEWED_LABEL}
            </label>
          </span>
          {reason !== undefined && busy === null ? (
            <DisabledHint reason={reason}>
              <Button
                size="sm"
                variant="outline"
                disabled
                icon={revertIcon}
                aria-label={`${REVERT_FILE_LABEL} ${f.path}`}
                data-testid="diff-file-revert"
              >
                {REVERT_FILE_LABEL}
              </Button>
            </DisabledHint>
          ) : (
            <Button
              size="sm"
              variant="outline"
              icon={revertIcon}
              loading={busy !== null}
              aria-label={`${REVERT_FILE_LABEL} ${f.path}`}
              data-testid="diff-file-revert"
              onClick={() => run('revert', onRevert)}
            >
              {REVERT_FILE_LABEL}
            </Button>
          )}
        </span>
      </header>
      <div id={bodyId} data-testid="diff-file-body" data-kind={kind}>
        {collapsed ? (
          large && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              <p className="text-sm text-muted-foreground" data-testid="diff-large">
                {largeText(f)}
              </p>
              <Button
                size="sm"
                variant="outline"
                data-testid="diff-expand"
                onClick={() => onCollapsed(false)}
              >
                {EXPAND_LABEL}
              </Button>
            </div>
          )
        ) : kind === 'gitlink' ? (
          <MessageRow testId="diff-gitlink">{gitlinkText(f)}</MessageRow>
        ) : kind === 'binary' ? (
          <BinaryBody runId={runId} seg={seg} f={f} enabled={near} />
        ) : kind === 'eol' ? (
          <MessageRow testId="diff-eol-only">{EOL_ONLY_TEXT}</MessageRow>
        ) : kind === 'meta' ? (
          <MessageRow testId="diff-meta">{metadataText(f)}</MessageRow>
        ) : (
          <PatchBody
            runId={runId}
            seg={seg}
            f={f}
            layout={layout}
            theme={theme}
            ignoreEol={ignoreEol}
            near={near}
          />
        )}
      </div>
    </article>
  )
}
