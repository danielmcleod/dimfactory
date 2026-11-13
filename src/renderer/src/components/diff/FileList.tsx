// The Diff tab's file list, with reviewed checkboxes: every file of the
// segment with its Reviewed mark, core's status letter, the path and the +/- counts; a path is a link to the file's
// diff below (a click is the user's, so the page may scroll to it). The list is in the page's flow, above the diffs,
// never a scroller of its own (UI standard: one scroll region per screen); a long list starts closed behind its toggle,
// whose label keeps one width.
import { ChevronDown } from 'lucide-react'
import { useId } from 'react'
import type { FileChange } from '@shared/ipc.ts'
import { cn } from '../../lib/cn.ts'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Checkbox } from '../ui/Checkbox.tsx'
import { Counts, StatusLetter, pathText } from './FileSection.tsx'
import {
  CHANGED_BY_FIX,
  CHANGED_BY_FIX_HINT,
  EDITED_AFTER_RUN,
  EDITED_AFTER_RUN_HINT,
  FILES_HEADING,
  HIDE_LIST_LABEL,
  SHOW_LIST_LABEL,
  filesText,
  reviewedCountText,
} from './text.ts'

export function FileList({
  files,
  reviewed,
  onReviewed,
  onOpen,
  open,
  onOpenChange,
}: {
  files: readonly FileChange[]
  reviewed: ReadonlySet<string>
  onReviewed: (f: FileChange, value: boolean) => void
  /** Go to the file's diff (by its index). */
  onOpen: (index: number) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const id = useId()
  const headingId = `${id}-heading`
  const listId = `${id}-list`
  const done = files.filter((f) => reviewed.has(f.path)).length
  return (
    <section aria-labelledby={headingId} data-testid="diff-file-list" className="rounded-md border">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <h2 id={headingId} className="text-sm font-medium">
          {FILES_HEADING}
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums" data-testid="diff-reviewed-count">
          {filesText(files.length)} · {reviewedCountText(done, files.length)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-expanded={open}
          aria-controls={listId}
          labels={[SHOW_LIST_LABEL, HIDE_LIST_LABEL]}
          icon={
            <ChevronDown
              aria-hidden
              className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-180')}
            />
          }
          data-testid="diff-list-toggle"
          onClick={() => onOpenChange(!open)}
        >
          {open ? HIDE_LIST_LABEL : SHOW_LIST_LABEL}
        </Button>
      </header>
      {open && (
        <ol id={listId} aria-label="Changed files" className="border-t py-1">
          {files.map((f, i) => (
            <li
              key={f.path}
              data-testid="diff-list-row"
              data-path={f.path}
              className="flex min-h-7 items-center gap-2 px-3 py-0.5"
            >
              <Checkbox
                checked={reviewed.has(f.path)}
                onCheckedChange={(v) => onReviewed(f, v === true)}
                aria-label={`Reviewed: ${f.path}`}
                data-testid="diff-list-reviewed"
              />
              <StatusLetter status={f.status} />
              <button
                type="button"
                title={pathText(f)}
                onClick={() => onOpen(i)}
                className="min-w-0 flex-1 truncate rounded-sm text-left font-mono text-xs outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="diff-list-open"
              >
                {pathText(f)}
              </button>
              {f.editedAfterRun === true && (
                <Badge variant="outline" title={EDITED_AFTER_RUN_HINT}>
                  {EDITED_AFTER_RUN}
                </Badge>
              )}
              {f.changedByFix === true && (
                <Badge variant="outline" title={CHANGED_BY_FIX_HINT}>
                  {CHANGED_BY_FIX}
                </Badge>
              )}
              <Counts f={f} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
