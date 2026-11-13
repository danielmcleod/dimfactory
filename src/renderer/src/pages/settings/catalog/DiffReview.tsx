// Settings → Catalog's review of a price update (core validates, the user applies). Each row core proposes, old → new, with its flags as chips (their reason in the chip's tooltip,
// core's own reason under them) and core's default tick; the user ticks and unticks, and Apply sends exactly the
// ticked row ids (catalog.apply), with "Prices updated · Undo". Rejected proposals and the models the AI could not
// confirm are listed after the rows, never tickable.
//
// Nothing moves on its own (UI standard): the rows keep the order they were first shown in for as long as the review is
// on screen (a later copy of the same job's diff never reorders them, and keeps the user's ticks); the review block
// keeps one reserved height while the job runs and after it ends, until the user opens the changes, applies or closes.
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { CatalogDiff, CatalogDiffRow, CatalogJob } from '@shared/catalog.ts'
import { Badge } from '../../../components/ui/Badge.tsx'
import { Button } from '../../../components/ui/Button.tsx'
import { Checkbox } from '../../../components/ui/Checkbox.tsx'
import { invoke } from '../../../ipc/client.ts'
import { cn } from '../../../lib/cn.ts'
import { vendorName } from '../../../lib/format.ts'
import { applyCatalogRows, cancelRefresh } from '../../../state/catalog.ts'
import { toast } from '../../../state/toasts.ts'
import { SETTINGS_TABLE } from '../kit.tsx'
import { jobLine, REVIEW_FIELD } from './consent.ts'
import {
  applyLabel,
  applyLabels,
  defaultTicks,
  flagInfo,
  hostOf,
  isRejected,
  rejectedValue,
  rowChange,
  rowFlags,
  rowWhat,
} from './model.ts'
import type { FlagTone } from './model.ts'

const TONE_CLASS: Readonly<Record<FlagTone, string>> = {
  warn: 'border-warning/40 bg-warning/10 text-warning',
  bad: 'border-destructive/40 bg-destructive/10 text-destructive',
  info: 'border-border text-muted-foreground',
}

/** The block's height while it holds a line or two instead of the rows (running, ended, ready but not opened). */
export const REVIEW_RESERVED_CLASS = 'h-28'

async function openSource(url: string): Promise<void> {
  const r = await invoke('shell.open', { target: 'url', url })
  if (!r.ok) toast({ level: 'error', message: r.error.message })
}

export function FlagChip({ flag }: { flag: string }): React.JSX.Element {
  const info = flagInfo(flag)
  return (
    <Badge
      variant="outline"
      data-flag={flag}
      title={info.explain !== '' ? info.explain : undefined}
      className={cn('font-normal', TONE_CLASS[info.tone])}
    >
      {info.label}
    </Badge>
  )
}

function SourceCell({
  url,
  quote,
  verified,
}: {
  url: string | null
  quote: string | null
  verified?: boolean
}): React.JSX.Element {
  const host = hostOf(url)
  if (url === null || host === null) return <span className="text-muted-foreground">No source</span>
  return (
    <>
      <button
        type="button"
        title={quote !== null && quote !== '' ? `${host}: ${quote}` : url}
        aria-label={`Price page on ${host}`}
        className="inline-flex items-center gap-1 rounded-sm text-left text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => void openSource(url)}
      >
        {host}
        <ExternalLink aria-hidden className="size-3 shrink-0" />
      </button>
      {verified === true && <span className="block text-muted-foreground">Official page, quoted</span>}
    </>
  )
}

/**
 * The rows in the order first shown for this job (new ones go last; ones core dropped leave), so nothing reorders
 * while the user reads.
 */
function useFrozenOrder(jobId: string, rows: readonly CatalogDiffRow[]): CatalogDiffRow[] {
  const order = useRef<{ jobId: string; ids: string[] } | null>(null)
  if (order.current?.jobId !== jobId) order.current = { jobId, ids: rows.map((r) => r.id) }
  const known = new Set(order.current.ids)
  for (const r of rows) if (!known.has(r.id)) order.current.ids.push(r.id)
  const byId = new Map(rows.map((r) => [r.id, r]))
  return order.current.ids.flatMap((id) => {
    const r = byId.get(id)
    return r !== undefined ? [r] : []
  })
}

interface Ticks {
  isTicked: (r: CatalogDiffRow) => boolean
  set: (id: string, on: boolean) => void
}

/** The user's ticks for this job: core's defaults for rows not touched yet. */
function useTicks(jobId: string, rows: readonly CatalogDiffRow[]): Ticks {
  const [state, setState] = useState<{ jobId: string; changed: Map<string, boolean> }>({
    jobId,
    changed: new Map(),
  })
  const changed = state.jobId === jobId ? state.changed : new Map<string, boolean>()
  const defaults = defaultTicks(rows)
  const isTicked = (r: CatalogDiffRow): boolean => !isRejected(r) && (changed.get(r.id) ?? defaults.has(r.id))
  const set = (id: string, on: boolean): void =>
    setState((s) => {
      const next = new Map(s.jobId === jobId ? s.changed : [])
      next.set(id, on)
      return { jobId, changed: next }
    })
  return { isTicked, set }
}

export function DiffTable({
  jobId,
  diff,
  onClose,
}: {
  jobId: string
  diff: CatalogDiff
  /** Close the review: Not now (the Refresh group still offers it), or once the ticked rows are applied. */
  onClose?: () => void
}): React.JSX.Element {
  const rows = useFrozenOrder(jobId, Array.isArray(diff.rows) ? diff.rows : [])
  const { isTicked, set } = useTicks(jobId, rows)
  const [busy, setBusy] = useState(false)
  const statusId = useId()
  const rejected = Array.isArray(diff.rejected) ? diff.rejected : []
  const unverifiable = Array.isArray(diff.unverifiable) ? diff.unverifiable : []
  const ticked = rows.filter(isTicked).map((r) => r.id)
  const offered = rows.filter((r) => !isRejected(r)).length

  const apply = async (): Promise<void> => {
    setBusy(true)
    const ok = await applyCatalogRows(jobId, ticked)
    setBusy(false)
    // Applied (the user's action): the review closes; the tables and the history show core's answer.
    if (ok) onClose?.()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={SETTINGS_TABLE.frame}>
        <table
          aria-label="Proposed price changes"
          data-testid="catalog-diff"
          className={SETTINGS_TABLE.table}
        >
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className={cn(SETTINGS_TABLE.cell, 'w-14 font-medium')}>
                Apply
              </th>
              <th scope="col" className={cn(SETTINGS_TABLE.cell, 'w-1/5 font-medium')}>
                Model
              </th>
              <th scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium')}>
                Change
              </th>
              <th scope="col" className={cn(SETTINGS_TABLE.cell, 'w-1/5 font-medium')}>
                Old to new
              </th>
              <th scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium')}>
                Source
              </th>
              <th scope="col" className={cn(SETTINGS_TABLE.cell, 'w-1/4 font-medium')}>
                Flags
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && rejected.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-muted-foreground">
                  The update found no price to change.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const flags = rowFlags(r)
              const change = rowChange(r)
              const no = isRejected(r)
              const what = rowWhat(r)
              return (
                <tr
                  key={r.id}
                  data-testid={`catalog-diff-row-${r.id}`}
                  data-ticked={isTicked(r) || undefined}
                  className="border-t"
                >
                  <td className={SETTINGS_TABLE.cell}>
                    <Checkbox
                      aria-label={`Apply ${r.model} ${what}`}
                      data-testid={`catalog-diff-tick-${r.id}`}
                      checked={isTicked(r)}
                      disabled={no || busy}
                      onCheckedChange={(v) => set(r.id, v === true)}
                    />
                  </td>
                  <th scope="row" className={cn(SETTINGS_TABLE.cell, 'font-normal')}>
                    <span className="block text-muted-foreground">{vendorName(r.vendor)}</span>
                    <span className="font-mono">{r.model}</span>
                  </th>
                  <td className={SETTINGS_TABLE.cell}>{what}</td>
                  <td className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>
                    <span className="text-muted-foreground">{change.from}</span>
                    <span aria-hidden> → </span>
                    <span className="sr-only"> to </span>
                    <span className="font-medium">{change.to}</span>
                    {change.delta !== null && (
                      <span
                        data-testid={`catalog-diff-delta-${r.id}`}
                        className={cn(
                          'block',
                          flags.includes('bigChange') || flags.includes('suspicious')
                            ? 'text-warning'
                            : 'text-muted-foreground',
                        )}
                      >
                        {change.delta}
                      </span>
                    )}
                  </td>
                  <td className={SETTINGS_TABLE.cell}>
                    <SourceCell
                      url={r.sourceUrl}
                      quote={r.sourceQuote}
                      {...(r.verified !== undefined ? { verified: r.verified } : {})}
                    />
                  </td>
                  <td className={SETTINGS_TABLE.cell}>
                    {flags.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {flags.map((f) => (
                          <FlagChip key={f} flag={f} />
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                    {typeof r.reason === 'string' && r.reason !== '' && (
                      <span
                        data-testid={`catalog-diff-reason-${r.id}`}
                        className="mt-1 block text-muted-foreground"
                      >
                        {r.reason}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
            {rejected.map((r, i) => (
              <tr key={`rejected-${i}`} data-testid={`catalog-diff-rejected-${i}`} className="border-t">
                <td className={SETTINGS_TABLE.cell}>
                  <Checkbox aria-label={`Apply ${r.model} (rejected)`} checked={false} disabled />
                </td>
                <th scope="row" className={cn(SETTINGS_TABLE.cell, 'font-normal')}>
                  <span className="block text-muted-foreground">{vendorName(r.vendor)}</span>
                  <span className="font-mono">{r.model}</span>
                </th>
                <td className={SETTINGS_TABLE.cell}>
                  {r.field !== undefined ? rowWhat({ ...EMPTY_ROW, field: r.field }) : 'Price'}
                </td>
                <td className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>{rejectedValue(r)}</td>
                <td className={SETTINGS_TABLE.cell}>
                  <span className="text-muted-foreground">Not offered</span>
                </td>
                <td className={SETTINGS_TABLE.cell}>
                  <span className="flex flex-wrap gap-1">
                    <FlagChip flag="rejected" />
                  </span>
                  <span className="mt-1 block text-muted-foreground">{r.reason}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unverifiable.length > 0 && (
        <div data-testid="catalog-diff-unverifiable" className="flex flex-col gap-1 text-xs">
          <p className="text-muted-foreground">Not confirmed on an official page, so left as they are:</p>
          <ul className="list-disc pl-5">
            {unverifiable.map((u, i) => (
              <li key={`${u.vendor}:${u.model}:${i}`}>
                <span className="font-mono">{u.model}</span> ({vendorName(u.vendor)}): {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          data-testid="catalog-diff-apply"
          className="tabular-nums"
          labels={applyLabels(offered)}
          loading={busy}
          disabled={ticked.length === 0}
          aria-describedby={statusId}
          onClick={() => void apply()}
        >
          {applyLabel(ticked.length)}
        </Button>
        {onClose !== undefined && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="catalog-diff-close"
            disabled={busy}
            onClick={onClose}
          >
            Not now
          </Button>
        )}
        <p id={statusId} data-testid="catalog-diff-status" className="text-xs text-muted-foreground">
          {`${ticked.length} of ${offered} ticked. Rows with a flag start unticked.`}
        </p>
      </div>
    </div>
  )
}

const EMPTY_ROW: CatalogDiffRow = {
  id: '',
  vendor: '',
  model: '',
  kind: 'price',
  current: null,
  proposed: null,
  deltaPct: null,
  sourceUrl: null,
  sourceQuote: null,
  flags: [],
  ticked: false,
}

/**
 * The review block: the job's line while it runs or after it ended (with Cancel, or Close), the changes it found
 * (opened at once when the section opened with them, else held behind Show changes), or the table.
 */
export function ReviewBlock({
  job,
  open,
  now,
  onOpen,
  onClose,
}: {
  job: CatalogJob
  /** The rows are shown (the section opened with them, or the user asked). */
  open: boolean
  now: number
  onOpen: () => void
  onClose: () => void
}): React.JSX.Element {
  const [cancelling, setCancelling] = useState(false)
  const diff = job.diff
  const showTable = job.state === 'diff-ready' && diff !== undefined && open
  const line = jobLine(job, now)
  const detail =
    job.state === 'running'
      ? (job.progress ?? 'Prices appear here to review when it has finished.')
      : job.state === 'diff-ready'
        ? 'Open them to tick the ones to apply.'
        : ''
  return (
    <section
      aria-labelledby={`${REVIEW_FIELD}-heading`}
      data-setting-field={REVIEW_FIELD}
      data-testid="catalog-review"
      data-state={job.state}
      tabIndex={-1}
      className="flex flex-col gap-3 outline-none"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={`${REVIEW_FIELD}-heading`} className="text-sm font-semibold">
          Review the update
        </h3>
        <p className="text-xs text-muted-foreground">
          What the AI read on the vendors&apos; pages. Nothing changes until you apply the rows you tick.
        </p>
      </div>
      {showTable ? (
        <DiffTable jobId={job.id} diff={diff} onClose={onClose} />
      ) : (
        <div
          data-testid="catalog-review-reserved"
          className={cn(
            'flex flex-col justify-between gap-2 rounded-md border border-dashed p-3',
            REVIEW_RESERVED_CLASS,
          )}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p
              data-testid="catalog-review-line"
              role="status"
              title={line}
              className={cn(
                'flex min-w-0 items-center gap-1.5 text-xs tabular-nums',
                job.state === 'failed' && 'text-destructive',
              )}
            >
              {job.state === 'running' && (
                <RefreshCw aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{line}</span>
            </p>
            <p
              data-testid="catalog-review-progress"
              title={detail}
              className="min-h-4 truncate text-xs text-muted-foreground"
            >
              {detail}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {job.state === 'running' && (
              <Button
                size="sm"
                variant="outline"
                data-testid="catalog-review-cancel"
                loading={cancelling}
                onClick={() => {
                  setCancelling(true)
                  void cancelRefresh(job.id).then((ok) => {
                    setCancelling(false)
                    if (ok) onClose()
                  })
                }}
              >
                Cancel
              </Button>
            )}
            {job.state === 'diff-ready' && diff !== undefined && (
              <Button size="sm" data-testid="catalog-review-show" onClick={onOpen}>
                Show changes
              </Button>
            )}
            {job.state !== 'running' && (
              <Button size="sm" variant="ghost" data-testid="catalog-review-close" onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
