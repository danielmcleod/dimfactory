// Runs history: the summary tiles for a period,
// filters by status, folder, vendor, date and title text (all sent to core as runs.list's query), 100 runs per page
// with Load more, and each run's row with its actions (RunRow.tsx).
// Nothing moves on its own (UI standard): the list holds the runs core listed for the
// filters the user chose, each row following its run's summary as it changes (a live run's status, a pin); a run that
// starts or changes status meanwhile never inserts or drops a row under the pointer. Only the user's own input
// replaces the list (a filter) or adds to it (Load more appends below). The tiles keep their size while core answers.
import { ChevronsDown, ListChecks, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { RecentFolder, RunListQuery } from '@shared/ipc.ts'
import { Button } from '../../components/ui/Button.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { vendorName } from '../../lib/format.ts'
import { useNow } from '../../lib/ticker.ts'
import { upsertSummaries } from '../../state/actions.ts'
import { useProbes } from '../../state/selectors.ts'
import { useStore } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import { folderBaseName } from '../dashboard/composer-model.ts'
import {
  DATE_PRESETS,
  filtersActive,
  listQuery,
  NO_FILTERS,
  RUNS_PAGE_SIZE,
  STATUS_FILTERS,
  TEXT_DEBOUNCE_MS,
} from './filters.ts'
import type { DatePreset, RunFilters } from './filters.ts'
import { RunRow } from './RunRow.tsx'
import { StatsTiles } from './StatsTiles.tsx'

export { RUNS_PAGE_SIZE, STATUS_FILTERS } from './filters.ts'
export type { StatusFilter, StatusFilterId } from './filters.ts'

interface Listing {
  status: 'loading' | 'ready' | 'error'
  /** The runs core listed for the query, in its order (pages appended). */
  ids: string[]
  nextCursor: string | null
  /** The query of the first page: Load more asks with the same bounds. */
  query: RunListQuery
  error?: string
  loadingMore: boolean
}

const SELECT =
  'h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** The folders to filter by: core's recent folders (folders.recent), else the folders of the runs loaded. */
function useFolderOptions(): string[] {
  const [recent, setRecent] = useState<RecentFolder[] | null>(null)
  useEffect(() => {
    let live = true
    void invoke('folders.recent').then((r) => {
      if (live && r.ok) setRecent(r.value)
    })
    return () => {
      live = false
    }
  }, [])
  // The folders of the loaded runs (an array equal item by item keeps its identity, so live updates re-render nothing).
  const loaded = useStore(
    useShallow((s) => [...new Set(s.summaries.order.map((id) => s.summaries.byId[id]?.folder ?? ''))]),
  )
  return useMemo(() => {
    const seen = new Map<string, string>()
    const add = (p: string): void => {
      const k = p.toLowerCase()
      if (p !== '' && !seen.has(k)) seen.set(k, p)
    }
    for (const f of recent ?? []) add(f.folder)
    for (const f of loaded) add(f)
    return [...seen.values()]
  }, [recent, loaded])
}

/** The vendors to filter by: the built ones core probed, and any a loaded run used. */
function useVendorOptions(): string[] {
  const probes = useProbes()
  const loaded = useStore(
    useShallow((s) => [
      ...new Set(
        s.summaries.order.flatMap((id) => (s.summaries.byId[id]?.steps ?? []).map((st) => st.vendor ?? '')),
      ),
    ]),
  )
  return useMemo(() => {
    const out = new Set<string>()
    for (const p of probes) if (p.built) out.add(p.vendor)
    for (const v of loaded) if (v !== '') out.add(v)
    return [...out]
  }, [probes, loaded])
}

export function RunsPage(): React.JSX.Element {
  const [filters, setFilters] = useState<RunFilters>(NO_FILTERS)
  const [textDraft, setTextDraft] = useState('')
  const [listing, setListing] = useState<Listing>({
    status: 'loading',
    ids: [],
    nextCursor: null,
    query: {},
    loadingMore: false,
  })
  const seq = useRef(0)
  const folders = useFolderOptions()
  const vendors = useVendorOptions()
  const ids = useId()

  // The text box asks core once typing pauses (Enter at once).
  useEffect(() => {
    const t = setTimeout(
      () => setFilters((f) => (f.text === textDraft.trim() ? f : { ...f, text: textDraft.trim() })),
      TEXT_DEBOUNCE_MS,
    )
    return () => clearTimeout(t)
  }, [textDraft])

  useEffect(() => {
    const mine = ++seq.current
    const query = listQuery(filters, Date.now())
    // The rows on screen stay until core's answer replaces them (no empty flash between two lists).
    setListing((l) => ({ ...l, status: 'loading', query, loadingMore: false }))
    void invoke('runs.list', { limit: RUNS_PAGE_SIZE, ...query }).then((r) => {
      if (mine !== seq.current) return
      if (!r.ok) {
        // The rows on screen stay, but no page of theirs is offered: core did not list this query.
        setListing((l) => ({ ...l, status: 'error', error: r.error.message, nextCursor: null }))
        return
      }
      upsertSummaries(r.value.items)
      setListing({
        status: 'ready',
        ids: r.value.items.map((s) => s.runId),
        nextCursor: r.value.nextCursor,
        query,
        loadingMore: false,
      })
    })
  }, [filters])

  const loadMore = async (): Promise<void> => {
    const { nextCursor: cursor, query } = listing
    // Not while a new filter's first page is on its way: the cursor on screen belongs to the listing it replaces.
    if (cursor === null || listing.loadingMore || listing.status === 'loading') return
    const mine = seq.current
    setListing((l) => ({ ...l, loadingMore: true }))
    const r = await invoke('runs.list', { limit: RUNS_PAGE_SIZE, ...query, cursor })
    if (mine !== seq.current) return
    if (!r.ok) {
      setListing((l) => ({ ...l, loadingMore: false }))
      toast({ level: 'error', message: r.error.message })
      return
    }
    upsertSummaries(r.value.items)
    setListing((l) => {
      const have = new Set(l.ids)
      return {
        ...l,
        status: 'ready',
        ids: [...l.ids, ...r.value.items.map((s) => s.runId).filter((id) => !have.has(id))],
        nextCursor: r.value.nextCursor,
        loadingMore: false,
      }
    })
  }

  const set = (patch: Partial<RunFilters>): void => setFilters((f) => ({ ...f, ...patch }))
  const clearAll = (): void => {
    setTextDraft('')
    setFilters(NO_FILTERS)
  }
  const active = filtersActive(filters) || textDraft.trim() !== ''
  const now = useNow(false)
  const shown = listing.ids
  const folderTitle = filters.folder ?? 'Every folder'

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-5">
      <h1 className="text-lg font-semibold">Runs</h1>
      <StatsTiles />

      <div className="flex flex-col gap-2" data-testid="runs-filters">
        <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filters.status === f.id}
              data-testid={`runs-filter-${f.id}`}
              onClick={() => set({ status: f.id })}
              className={cn(
                'h-7 rounded-full border px-3 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                // Border and background only: a weight change would widen the chip and move its neighbours.
                filters.status === f.id
                  ? 'border-primary/60 bg-accent text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${ids}-folder`} className="sr-only">
            Folder
          </label>
          <select
            id={`${ids}-folder`}
            data-testid="runs-filter-folder"
            title={folderTitle}
            value={filters.folder ?? ''}
            onChange={(e) => set({ folder: e.currentTarget.value === '' ? null : e.currentTarget.value })}
            // A fixed width: the options come from core and must not move what follows.
            className={cn(SELECT, 'w-44')}
          >
            <option value="">All folders</option>
            {folders.map((f) => (
              <option key={f} value={f} title={f}>
                {folderBaseName(f)} ({f})
              </option>
            ))}
          </select>
          <label htmlFor={`${ids}-vendor`} className="sr-only">
            Vendor
          </label>
          <select
            id={`${ids}-vendor`}
            data-testid="runs-filter-vendor"
            value={filters.vendor ?? ''}
            onChange={(e) => set({ vendor: e.currentTarget.value === '' ? null : e.currentTarget.value })}
            className={cn(SELECT, 'w-32')}
          >
            <option value="">All vendors</option>
            {vendors.map((v) => (
              <option key={v} value={v}>
                {vendorName(v)}
              </option>
            ))}
          </select>
          <label htmlFor={`${ids}-date`} className="sr-only">
            Date
          </label>
          <select
            id={`${ids}-date`}
            data-testid="runs-filter-date"
            value={filters.date}
            onChange={(e) => set({ date: e.currentTarget.value as DatePreset })}
            className={cn(SELECT, 'w-32')}
          >
            {DATE_PRESETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          {filters.date === 'custom' && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <label htmlFor={`${ids}-from`}>From</label>
              <input
                id={`${ids}-from`}
                type="date"
                data-testid="runs-filter-from"
                value={filters.fromDay}
                max={filters.toDay !== '' ? filters.toDay : undefined}
                onChange={(e) => set({ fromDay: e.currentTarget.value })}
                className={cn(SELECT, 'w-36')}
              />
              <label htmlFor={`${ids}-to`}>to</label>
              <input
                id={`${ids}-to`}
                type="date"
                data-testid="runs-filter-to"
                value={filters.toDay}
                min={filters.fromDay !== '' ? filters.fromDay : undefined}
                onChange={(e) => set({ toDay: e.currentTarget.value })}
                className={cn(SELECT, 'w-36')}
              />
            </span>
          )}
          <div className="relative w-56 max-w-full min-w-40 flex-1">
            <Search aria-hidden className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Filter by title"
              data-testid="runs-filter-text"
              placeholder="Filter by title"
              value={textDraft}
              onChange={(e) => setTextDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') set({ text: textDraft.trim() })
              }}
              className="h-8 pl-8 text-xs"
            />
          </div>
          {/* Always there (disabled while nothing is filtered), so setting a filter never moves the row. */}
          <Button
            size="sm"
            variant="ghost"
            icon={<X aria-hidden />}
            disabled={!active}
            data-testid="runs-filter-clear"
            onClick={clearAll}
          >
            Clear filters
          </Button>
        </div>
      </div>

      {shown.length > 0 ? (
        <ul
          aria-label="Runs"
          data-testid="runs-list"
          aria-busy={listing.status === 'loading' || undefined}
          className="flex flex-col divide-y"
        >
          {shown.map((id) => (
            <RunRow key={id} runId={id} now={now} />
          ))}
        </ul>
      ) : listing.status === 'ready' ? (
        <EmptyState
          icon={ListChecks}
          title={active ? 'No runs match these filters' : 'No runs yet'}
          description={
            active
              ? 'Try another status, folder, vendor or date, or clear the filters.'
              : 'Start one from the Dashboard; every run is listed here.'
          }
          className="rounded-lg border border-dashed"
        />
      ) : null}

      {/* Load more first, then the count: the button keeps its place as the count changes. Core's error comes here,
          below the rows the page keeps, so its late answer never moves what the user is reading. */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {listing.nextCursor !== null && (
          <Button
            size="sm"
            variant="outline"
            icon={<ChevronsDown aria-hidden />}
            loading={listing.loadingMore}
            disabled={listing.status === 'loading'}
            onClick={() => void loadMore()}
            data-testid="runs-load-more"
          >
            Load more
          </Button>
        )}
        {listing.status === 'ready' && shown.length > 0 && (
          <span data-testid="runs-count" className="tabular-nums">
            {`${shown.length} ${shown.length === 1 ? 'run' : 'runs'}`}
          </span>
        )}
        {listing.status === 'error' && (
          <p role="alert" data-testid="runs-list-error" className="min-w-0 text-destructive">
            Could not load runs: {listing.error}
          </p>
        )}
      </div>
    </div>
  )
}
