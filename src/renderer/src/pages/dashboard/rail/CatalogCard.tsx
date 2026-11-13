// Catalog consent card (the price refresh asks first). Shown when core says a
// price refresh is due: it names the vendor and model, says "read-only, web search, cannot change files", shows ~time
// and ≈cost (catalog.refreshPlan), and offers [Update now] [Not now (7 days)] [Turn off]. It never runs anything by
// itself: catalog.refresh `{consent: true}` is sent only from Update now's click (state/catalog.ts startRefresh).
// While a job runs the card is its status line (elapsed, core's progress) with [Cancel]; once the job found changes it
// links to the review in Settings → Catalog.
//
// The card is the last thing in the rail (RightRail), so its coming, going and changing height move nothing else.
// Inside it the lines that core's answers fill (who reads, time and cost) are one line each, cut with a tooltip, and
// notes that may come later (a fallback vendor, a failed update) sit after the buttons.
// A job the card showed running that then fails (a refresh from Settings, the 10-minute timeout) keeps the
// card in the running card's layout ("The price update failed: …", what Try again would run, [Try again] [Close])
// until the user closes it, so the card never shrinks or vanishes on its own (the rail's end may be on screen).
import { RefreshCw, Tags } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/Button.tsx'
import { useCoreNow } from '../../../lib/coreClock.ts'
import {
  cancelRefresh,
  loadCatalog,
  setCatalogSchedule,
  startRefresh,
  useCatalogLive,
} from '../../../state/catalog.ts'
import {
  CATALOG_CARD_TITLE,
  REVIEW_HREF,
  changesText,
  consentLine,
  consentTitle,
  jobLine,
  planFacts,
  pricesFromText,
  useRefreshPlan,
} from '../../settings/catalog/consent.ts'

export type CatalogCardMode = 'consent' | 'running' | 'review' | 'failed' | null

/** The review card's second line. */
export const REVIEW_DETAIL = 'Nothing changes until you apply them.'

/**
 * What the card shows, from core's status and job. `watched`: the card showed this job running (its
 * failure then stays on the card, in the running card's layout, until the user closes it).
 */
export function catalogCardMode(
  status: { refreshDue: boolean } | null,
  job: { state: string } | null,
  watched = false,
): CatalogCardMode {
  if (job?.state === 'running') return 'running'
  if (job?.state === 'diff-ready') return 'review'
  if (job?.state === 'failed' && watched) return 'failed'
  if (status?.refreshDue === true) return 'consent'
  return null
}

type Busy = 'update' | 'snooze' | 'off' | 'cancel' | 'retry' | null

/**
 * Review cards set aside this session (Not now), and failed cards closed (Close), by job id. Core keeps the changes
 * until they are applied or a new update replaces them; Settings → Catalog still offers them.
 */
const setAside = new Set<string>()
/** Jobs this card showed running in this session (their failure stays on the card until it is closed). */
const watched = new Set<string>()

export function resetCatalogCardForTests(): void {
  setAside.clear()
  watched.clear()
}

function Running({
  jobId,
  line,
  progress,
}: {
  jobId: string
  line: string
  progress?: string
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <>
      <p data-testid="catalog-card-status" title={line} className="truncate text-xs tabular-nums">
        {line}
      </p>
      <p
        data-testid="catalog-card-progress"
        title={progress}
        className="min-h-4 truncate text-xs text-muted-foreground"
      >
        {progress ?? ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid="catalog-card-cancel"
          loading={busy}
          onClick={() => {
            setBusy(true)
            void cancelRefresh(jobId).finally(() => setBusy(false))
          }}
        >
          Cancel
        </Button>
      </div>
    </>
  )
}

function Failed({
  line,
  detail,
  busy,
  onRetry,
  onClose,
}: {
  line: string
  detail: string
  busy: boolean
  onRetry: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <>
      <p
        data-testid="catalog-card-status"
        role="status"
        title={line}
        className="truncate text-xs text-destructive"
      >
        {line}
      </p>
      <p
        data-testid="catalog-card-detail"
        title={detail}
        className="min-h-4 truncate text-xs text-muted-foreground"
      >
        {detail}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid="catalog-card-retry"
          icon={<RefreshCw aria-hidden />}
          loading={busy}
          onClick={onRetry}
        >
          Try again
        </Button>
        <Button size="sm" variant="ghost" data-testid="catalog-card-close" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  )
}

export function CatalogCard(): React.JSX.Element | null {
  const { status, job } = useCatalogLive()
  const [, setAsideVersion] = useState(0)
  // Remembered while rendering (idempotent): a job seen running here keeps its failure on the card.
  if (job?.state === 'running') watched.add(job.id)
  const core = catalogCardMode(status, job, job !== null && watched.has(job.id))
  const mode: CatalogCardMode =
    (core === 'review' || core === 'failed') && job !== null && setAside.has(job.id)
      ? status?.refreshDue === true
        ? 'consent'
        : null
      : core
  const plan = useRefreshPlan(mode === 'consent' || mode === 'failed')
  const now = useCoreNow(mode === 'running')
  const [busy, setBusy] = useState<Busy>(null)

  // A job core reports in its status but the store has not seen (the window was reloaded while one ran, or a refresh
  // is due and an earlier job may have ended): read the catalog once for core's account of it.
  const asked = useRef(false)
  const wantsJob = status !== null && (status.jobRunning || status.refreshDue) && job === null
  useEffect(() => {
    if (!wantsJob || asked.current) return
    asked.current = true
    void loadCatalog()
  }, [wantsJob])

  if (mode === null || status === null) return null

  const run = (what: Exclude<Busy, null>, action: () => Promise<unknown>): void => {
    setBusy(what)
    void action().finally(() => setBusy(null))
  }

  const failed = job?.state === 'failed' ? jobLine(job, now) : null
  const note = plan.status === 'ok' ? plan.plan.fallbackNote : undefined

  return (
    <section
      aria-labelledby="catalog-card-heading"
      data-testid="catalog-card"
      data-mode={mode}
      className="flex flex-col gap-2 rounded-lg border bg-card p-3"
    >
      <h2 id="catalog-card-heading" className="flex items-center gap-2 text-sm font-semibold">
        {mode === 'running' ? (
          <RefreshCw aria-hidden className="size-4 text-muted-foreground" />
        ) : (
          <Tags aria-hidden className="size-4 text-muted-foreground" />
        )}
        {mode === 'running'
          ? 'Updating model prices'
          : mode === 'review'
            ? 'Price changes to review'
            : mode === 'failed'
              ? 'Price update failed'
              : CATALOG_CARD_TITLE}
      </h2>
      {mode === 'running' && job !== null && (
        <Running
          jobId={job.id}
          line={jobLine(job, now)}
          {...(job.progress !== undefined ? { progress: job.progress } : {})}
        />
      )}
      {mode === 'failed' && job !== null && (
        <Failed
          line={jobLine(job, now)}
          detail={consentLine(plan.status === 'ok' ? plan.plan : null)}
          busy={busy === 'retry'}
          onRetry={() => run('retry', () => startRefresh(plan.status === 'ok' ? plan.plan : undefined))}
          onClose={() => {
            setAside.add(job.id)
            setAsideVersion((n) => n + 1)
          }}
        />
      )}
      {mode === 'review' && job !== null && (
        <>
          {/* The running card's two lines and button row, so a job ending on its own keeps the card's height (the
              rail's end may be at the bottom of the page the user is reading: a shorter card would scroll it). */}
          <p
            data-testid="catalog-card-status"
            title={changesText(job.diff?.rows.length ?? 0)}
            className="truncate text-xs"
          >
            {changesText(job.diff?.rows.length ?? 0)}
          </p>
          <p
            data-testid="catalog-card-detail"
            title={REVIEW_DETAIL}
            className="min-h-4 truncate text-xs text-muted-foreground"
          >
            {REVIEW_DETAIL}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" asChild>
              <a href={REVIEW_HREF} data-testid="catalog-card-review">
                Review changes
              </a>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="catalog-card-later"
              onClick={() => {
                setAside.add(job.id)
                setAsideVersion((n) => n + 1)
              }}
            >
              Not now
            </Button>
          </div>
        </>
      )}
      {mode === 'consent' && (
        <>
          <p className="text-xs text-muted-foreground">
            {pricesFromText(status.pricingUpdatedAt)} A model can read the vendors&apos; price pages and
            propose new prices. You review them before anything changes.
          </p>
          <p
            data-testid="catalog-card-consent"
            title={consentTitle(plan.status === 'ok' ? plan.plan : null)}
            className="truncate text-xs font-medium"
          >
            {consentLine(plan.status === 'ok' ? plan.plan : null)}
          </p>
          <p
            data-testid="catalog-card-estimate"
            title={planFacts(plan)}
            className="truncate text-xs text-muted-foreground tabular-nums"
          >
            {planFacts(plan)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              data-testid="catalog-card-update"
              icon={<RefreshCw aria-hidden />}
              loading={busy === 'update'}
              disabled={busy !== null && busy !== 'update'}
              onClick={() => run('update', () => startRefresh(plan.status === 'ok' ? plan.plan : undefined))}
            >
              Update now
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="catalog-card-snooze"
              loading={busy === 'snooze'}
              disabled={busy !== null && busy !== 'snooze'}
              onClick={() =>
                run('snooze', () =>
                  setCatalogSchedule({ snoozeDays: 7 }, 'Dim Factory asks about prices again in 7 days'),
                )
              }
            >
              Not now (7 days)
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="catalog-card-off"
              loading={busy === 'off'}
              disabled={busy !== null && busy !== 'off'}
              onClick={() =>
                run('off', () =>
                  setCatalogSchedule({ enabled: false }, 'Price checks are off', { enabled: true }),
                )
              }
            >
              Turn off
            </Button>
          </div>
          {note !== undefined && note !== '' && (
            <p data-testid="catalog-card-note" className="text-xs text-warning">
              {note}
            </p>
          )}
          {failed !== null && (
            <p data-testid="catalog-card-failed" role="status" className="text-xs text-destructive">
              {failed}
            </p>
          )}
        </>
      )}
    </section>
  )
}
