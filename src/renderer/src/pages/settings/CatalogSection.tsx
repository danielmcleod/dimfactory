// Settings → Catalog (models and pricing tables, editable; schedule, AI vendor, diff review, history): the refresh
// controls (schedule,
// vendor and model, Update now with the consent card's words: catalog/RefreshGroup.tsx), the review of an update
// (catalog/DiffReview.tsx), the price tables with editing (catalog/PriceTables.tsx), the models core recorded, and the
// last 20 changes with Undo of the newest (catalog/HistoryTable.tsx). The catalog itself is the store's (state/
// catalog.ts), so an apply, an undo, a price edit or a job's event shows here and on the Dashboard alike.
//
// Nothing is read until the section has been open a moment (performance.spec.ts). The refresh controls are fixed and come first; what
// core's catalog holds (the review, the tables, the history) appears whole once it is read, after them, so nothing
// shown moves when it arrives. Later, only the user's own actions change that part's size: a job started here reserves
// the review's height, a job that ends keeps it until the user opens or closes it, and changes that arrive while the
// section is open wait behind Show changes.
import { useEffect, useRef, useState } from 'react'
import type { CatalogJob, CatalogState } from '@shared/catalog.ts'
import { cn } from '../../lib/cn.ts'
import { useCoreNow } from '../../lib/coreClock.ts'
import { vendorName } from '../../lib/format.ts'
import { loadCatalog, useCatalogJob, useCatalogState } from '../../state/catalog.ts'
import { useConfigEpoch, useProbes } from '../../state/selectors.ts'
import { ReviewBlock } from './catalog/DiffReview.tsx'
import { HistoryTable } from './catalog/HistoryTable.tsx'
import { formatDay } from './catalog/model.ts'
import { PriceTables } from './catalog/PriceTables.tsx'
import { RefreshGroup } from './catalog/RefreshGroup.tsx'
import { Group, SETTINGS_TABLE } from './kit.tsx'
import { SECTION_LOAD_DELAY_MS } from './sectionData.ts'

export { formatDay, formatPrice, NO_PRICE_TEXT } from './catalog/model.ts'

export const NO_MODELS = 'No model lists are recorded yet. Model pickers use what each CLI reports.'
const LOADING = 'Loading the catalog…'

const SUMMARY_WORD: Readonly<Record<string, string>> = {
  verified: 'verified',
  unverified: 'not verified',
  user: 'edited by you',
  mixed: 'partly verified',
  none: 'none recorded',
}

/** The amber note under the prices' status line while core says they are stale. */
export const STALE_NOTE = 'Older than twice the refresh interval, so estimates may be off.'

function statusLine(s: CatalogState['status']): string {
  const word = SUMMARY_WORD[s.confidence] ?? s.confidence
  return s.pricingUpdatedAt !== null
    ? `Prices from ${formatDay(s.pricingUpdatedAt)}, ${word}.`
    : `Prices: ${word}.`
}

const MODEL_COLUMNS = ['Vendor', 'Model', 'Context window', 'Source'] as const

function ModelsTable({ state }: { state: CatalogState }): React.JSX.Element {
  const rows = Object.entries(state.models.vendors).flatMap(([vendor, list]) =>
    list.models.map((m) => ({ vendor, model: m, source: m.source })),
  )
  return (
    <div className={SETTINGS_TABLE.frame}>
      <table aria-label="Models" data-testid="catalog-models" className={SETTINGS_TABLE.table}>
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {MODEL_COLUMNS.map((c) => (
              <th key={c} scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={MODEL_COLUMNS.length} className="px-2 py-3 text-muted-foreground">
                {NO_MODELS}
              </td>
            </tr>
          ) : (
            rows.map(({ vendor, model, source }) => (
              <tr key={`${vendor}:${model.id}`} className="border-t">
                <td className={SETTINGS_TABLE.cell}>{vendorName(vendor)}</td>
                <th scope="row" className={cn(SETTINGS_TABLE.cell, 'font-normal')}>
                  <span className="font-mono">{model.id}</span>
                  {model.deprecated === true && <span className="block text-warning">Deprecated</span>}
                </th>
                <td className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>
                  {model.contextWindow !== undefined
                    ? `${model.contextWindow.toLocaleString('en-US')} tokens`
                    : 'Not known'}
                </td>
                <td className={SETTINGS_TABLE.cell}>
                  {source === 'cli' ? 'The CLI' : source === 'user' ? 'You' : 'AI update'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

interface Review {
  visible: boolean
  /** The changes are on screen (not held behind Show changes). */
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** The user closed the block of a job whose changes still wait: Review changes brings it back, open. */
  onReopen: (() => void) | undefined
}

/**
 * Whether the review block shows for the store's job: always while the job runs or its changes wait, and after the
 * job ended for as long as the block was on screen in this visit (until the user closes it). The changes themselves
 * show at once only when they were there as the section's data first appeared; changes that arrive later wait for
 * the user's Show changes.
 */
function useReview(job: CatalogJob | null, dataShown: boolean): Review {
  const kept = useRef(new Set<string>())
  const first = useRef<string | null | undefined>(undefined)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const id = job?.id ?? null
  const live = job !== null && (job.state === 'running' || job.state === 'diff-ready')
  if (dataShown && first.current === undefined) first.current = job?.state === 'diff-ready' ? job.id : null
  if (live && id !== null) kept.current.add(id)
  const isClosed = id !== null && closed.has(id)
  return {
    visible: dataShown && id !== null && !isClosed && (live || kept.current.has(id)),
    open: id !== null && (opened.has(id) || first.current === id),
    onOpen: () => {
      if (id !== null) setOpened((s) => new Set([...s, id]))
    },
    onClose: () => {
      if (id !== null) setClosed((s) => new Set([...s, id]))
    },
    onReopen:
      isClosed && job !== null && job.state === 'diff-ready'
        ? () => {
            setClosed((s) => new Set([...s].filter((x) => x !== id)))
            setOpened((s) => new Set([...s, id]))
          }
        : undefined,
  }
}

function CatalogData({
  state,
  job,
  review,
}: {
  state: CatalogState
  job: CatalogJob | null
  review: Review
}): React.JSX.Element {
  const probes = useProbes()
  const now = useCoreNow(job?.state === 'running')
  const s = state.status
  const vendors = probes.filter((p) => p.built).map((p) => p.vendor)
  return (
    <>
      {review.visible && job !== null && (
        <ReviewBlock job={job} open={review.open} now={now} onOpen={review.onOpen} onClose={review.onClose} />
      )}
      <Group
        title="Prices"
        description="US dollars per million tokens, standard tier. Cache write is the 1-hour rate. Edit a price to set it yourself."
        field="prices"
        testId="catalog-prices"
      >
        {/* Two one-line rows of fixed height, the stale note in its own reserved row, so a status that
            turns stale (the scheduler's due event reads the catalog again) never moves the tables below. */}
        <div data-testid="catalog-status" className="flex flex-col text-xs text-muted-foreground">
          <p title={statusLine(s)} className="h-4 truncate">
            {statusLine(s)}
          </p>
          <p
            data-testid="catalog-status-stale"
            title={s.stale ? STALE_NOTE : undefined}
            className="h-4 truncate text-warning"
          >
            {s.stale ? STALE_NOTE : ''}
          </p>
        </div>
        <PriceTables state={state} vendors={vendors} />
      </Group>
      <Group title="Models" description="Context windows and where each model list came from.">
        <ModelsTable state={state} />
      </Group>
      <Group
        title="Update history"
        description="The last 20 changes to the prices. The newest can be undone."
        field="history"
      >
        <HistoryTable state={state} />
      </Group>
    </>
  )
}

export function CatalogSection(): React.JSX.Element {
  const epoch = useConfigEpoch()
  const [opened, setOpened] = useState(false)
  const [answer, setAnswer] = useState<{ ok: true } | { ok: false; message: string } | null>(null)
  const state = useCatalogState()
  const job = useCatalogJob()

  // Read once the section has been open a moment (performance.spec.ts: a switch costs no IPC), and again after a config change (the
  // schedule is configuration), keeping what is on screen meanwhile (a failed read again leaves the last answer).
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      setOpened(true)
      void loadCatalog().then((r) => {
        if (!alive) return
        setAnswer((prev) =>
          r.ok ? { ok: true } : prev?.ok === true ? prev : { ok: false, message: r.error.message },
        )
      })
    }, SECTION_LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [epoch])

  const dataShown = answer !== null && answer.ok && state !== null
  const review = useReview(job, dataShown)

  return (
    <div className="flex flex-col gap-6" data-testid="settings-catalog">
      <p className="text-sm text-muted-foreground">
        Dim Factory estimates what a run costs from these prices. The prices that come with Dim Factory were
        copied from the vendors&apos; price pages and are marked not verified until an update or you confirm
        them.
      </p>
      <RefreshGroup
        opened={opened}
        status={dataShown ? state.status : null}
        job={dataShown ? job : null}
        failed={answer !== null && !answer.ok}
        onReview={review.onReopen}
      />
      {dataShown ? (
        <CatalogData state={state} job={job} review={review} />
      ) : (
        <p
          data-testid="catalog-state"
          className={cn(
            'text-xs',
            answer !== null && !answer.ok ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {answer !== null && !answer.ok ? `The catalog could not be read: ${answer.message}` : LOADING}
        </p>
      )}
    </div>
  )
}
