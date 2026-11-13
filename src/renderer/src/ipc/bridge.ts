// The renderer's side of the push channel (reload-mid-stream.spec.ts).
//   1. Subscribe first and buffer, so nothing pushed during start-up is lost.
//   2. app.info, runs.list (active + recent), vendors.list, runs.get for active runs.
//   3. Drain the buffer; envelopes with seq ≤ what a snapshot already reflects are dropped.
// Stream focus: main forwards `{t:'ev'}` envelopes only for runs the renderer focused (asks always), every other body
// for every run. So seq continuity is checked only for focused runs: a gap triggers one paged runs.events catch-up
// before later envelopes apply, and a newly focused run first replays its log from what the stream buffer already
// has, with live envelopes queued behind the replay; the buffer's seq idempotence removes the overlap (no loss, no
// duplication). Structural envelopes schedule a debounced runs.get (state/runs.ts). A 15 s silence shows the
// lost-contact banner. start/stop are idempotent and StrictMode-safe.
import { useEffect } from 'react'
import type { AppEvent, AppEventOf } from '@shared/ipc.ts'
import type { RunEnvelope, RunEventBody, RunSummary, StepKey } from '@shared/run.ts'
import { configureCoreClock, observeCoreEvents, resetCoreClock } from '../lib/coreClock.ts'
import { currentHash, currentRoute } from '../lib/router.ts'
import { streamBuffer } from '../lib/streamBuffer.ts'
import type { StreamBuffer } from '../lib/streamBuffer.ts'
import { applyTheme } from '../lib/theme.ts'
import {
  addNotice,
  bumpConfigEpoch,
  pruneRunSnapshots,
  setAppInfo,
  setAttention,
  setBridgeState,
  setLostContact,
  setQuitRequested,
  setSummariesError,
  setThemeState,
  upsertProbes,
  upsertSummaries,
} from '../state/actions.ts'
import { onCatalogEvent } from '../state/catalog.ts'
import { cancelRefetches, fetchSnapshot, forgetRunLane, scheduleRefetch } from '../state/runs.ts'
import { ACTIVE_RUN_STATUSES } from '../state/selectors.ts'
import { useStore } from '../state/store.ts'
import { dismissToast, toast } from '../state/toasts.ts'
import type { ToastInput } from '../state/toasts.ts'
import { getDimFactory, invoke, logToMain } from './client.ts'
import { setMcpRequests } from '../state/mcpRequests.ts'
import { upsertPreviewSessions } from '../state/previews.ts'
import { bumpMatch } from '../state/matches.ts'
import { bumpMemory, setQueueView } from '../state/queue.ts'
import { bumpEasyPermission } from '../state/easyPermission.ts'

export const HEARTBEAT_TIMEOUT_MS = 15_000
/** Run statuses after which a run's snapshot may be dropped when nobody shows it (pruneRunSnapshots). */
const FINISHED_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled'])
export const RECENT_RUNS_LIMIT = 50
/** runs.events page size for catch-ups and replays (core caps it at 2000). */
export const REPLAY_PAGE_LIMIT = 1000

/** Terminal run statuses: an approval toast about such a run is stale. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed'])

/** The toast id of a run's approval toast (one per run; a newer one replaces it). */
export const askToastId = (runId: string): string => `asks:${runId}`

/** Everything except a stream event; an ask is structural (it changes the snapshot's asks). */
export function isStructural(body: RunEventBody): boolean {
  return body.t !== 'ev' || body.ev.type === 'ask'
}

interface Lane {
  /** Catch-ups queued or running; live envelopes wait in `pending` while > 0. */
  jobs: number
  pending: RunEnvelope[]
  chain: Promise<void>
}

/** Test/E2E handle installed on window when AppInfo.e2e is true. */
export interface DimFactoryE2EHook {
  streamText(runId: string, step: StepKey, attempt?: number): string
  streamLastSeq(runId: string): number
  focusedRuns(): string[]
  flushStreams(): void
  /** Show a toast as the app does (ui-layout.spec.ts: a burst of toasts, where none may move). */
  toast(input: ToastInput): string
}

export const E2E_HOOK = '__dimFactoryE2E'

class Bridge {
  readonly #buffer: StreamBuffer
  #generation = 0
  #unsubscribe: (() => void) | null = null
  #startup: AppEvent[] | null = null
  readonly #seen = new Map<string, number>()
  readonly #lanes = new Map<string, Lane>()
  #focused = new Set<string>()
  /** Runs whose approval toast is up (askToastId). */
  readonly #askToasts = new Set<string>()
  #focusSent = false
  #focusChain: Promise<void> = Promise.resolve()
  #watchdog: ReturnType<typeof setTimeout> | null = null
  readonly #onVisibility = (): void => {
    if (document.visibilityState === 'visible' && this.#unsubscribe !== null) this.#armWatchdog()
  }

  constructor(buffer: StreamBuffer) {
    this.#buffer = buffer
  }

  async start(): Promise<void> {
    const gen = ++this.#generation
    const api = getDimFactory()
    if (api === null) {
      setBridgeState('unavailable')
      setLostContact(true)
      return
    }
    setBridgeState('starting')
    this.#startup = []
    this.#unsubscribe = api.subscribe((batch) => this.#onBatch(batch))
    this.#armWatchdog()
    document.addEventListener('visibilitychange', this.#onVisibility)

    await this.#initialLoad(gen)
    if (gen !== this.#generation) return

    // Runs focused before start (a deep link at launch) take their replay lane now, so buffered live envelopes for
    // them queue behind the replay instead of looking like gaps.
    this.syncFocus(desiredFocus())
    const startup = this.#startup ?? []
    this.#startup = null
    for (const ev of startup) this.#handle(ev)
    setBridgeState('ready')
    if (!readySent) {
      readySent = true
      void invoke('app.ready', { route: currentHash() })
    }
  }

  stop(): void {
    this.#generation++
    this.#unsubscribe?.()
    this.#unsubscribe = null
    if (this.#watchdog !== null) clearTimeout(this.#watchdog)
    this.#watchdog = null
    document.removeEventListener('visibilitychange', this.#onVisibility)
    this.#startup = null
    this.#seen.clear()
    this.#lanes.clear()
    this.#focused = new Set()
    this.#focusSent = false
    cancelRefetches()
    resetCoreClock()
    setBridgeState('idle')
  }

  async #initialLoad(gen: number): Promise<void> {
    const [info, active, recent, vendors] = await Promise.all([
      invoke('app.info'),
      invoke('runs.list', { status: [...ACTIVE_RUN_STATUSES] }),
      invoke('runs.list', { limit: RECENT_RUNS_LIMIT }),
      invoke('vendors.list'),
    ])
    if (gen !== this.#generation) return
    if (info.ok) {
      setAppInfo(info.value)
      configureCoreClock(info.value, () => invoke('e2e.state'))
      if (info.value.e2e) installE2EHook(this.#buffer)
    }
    const summaries: RunSummary[] = []
    if (recent.ok) summaries.push(...recent.value.items)
    if (active.ok) summaries.push(...active.value.items)
    if (active.ok || recent.ok) upsertSummaries(summaries, { loaded: true })
    else setSummariesError(active.error.message)
    if (vendors.ok) upsertProbes(vendors.value)
    if (!active.ok) return
    await Promise.all(
      active.value.items.map(async (s) => {
        await fetchSnapshot(s.runId)
        const entry = useStore.getState().runs.byId[s.runId]
        if (entry?.snapshot != null) this.#noteBaseline(s.runId, entry.lastSeq)
      }),
    )
  }

  // ---- events ---------------------------------------------------------------------------------------------------

  #onBatch(batch: AppEvent[]): void {
    // Core's clock is read at arrival, before start-up buffering delays the batch (lib/coreClock.ts).
    observeCoreEvents(batch)
    this.#armWatchdog()
    setLostContact(false)
    if (this.#startup !== null) {
      this.#startup.push(...batch)
      return
    }
    for (const ev of batch) this.#handle(ev)
  }

  #handle(ev: AppEvent): void {
    switch (ev.kind) {
      case 'run':
        this.#onRun(ev.env)
        return
      case 'resync':
        for (const runId of ev.runIds) {
          scheduleRefetch(runId)
          if (this.#focused.has(runId)) this.#enqueueCatchUp(runId)
        }
        return
      case 'run-summary':
        upsertSummaries([ev.summary])
        if (FINISHED_STATUSES.has(ev.summary.status)) this.#pruneSnapshots()
        // A run that ended has nothing waiting: its approval toast goes.
        if (ENDED_STATUSES.has(ev.summary.status)) this.#clearAskToast(ev.summary.runId)
        return
      case 'attention': {
        setAttention(ev.needsYou, ev.items)
        // An approval toast whose run has no ask waiting any more (answered, timed out, ended) goes.
        const asking = new Set(ev.items.filter((i) => i.kind === 'ask').map((i) => i.runId))
        for (const runId of [...this.#askToasts]) if (!asking.has(runId)) this.#clearAskToast(runId)
        return
      }
      case 'probe':
        upsertProbes([ev.view])
        return
      case 'catalog':
        // A refresh is due, or the refresh job moved on (state/catalog.ts).
        onCatalogEvent(ev)
        return
      case 'config-changed':
        bumpConfigEpoch()
        return
      case 'theme':
        applyTheme(ev.theme)
        setThemeState(ev.theme)
        return
      case 'toast': {
        // A gate's in-app toast in that run's own view says what the gate card, its jump pill and the view's
        // announcement say already, and would cover the card's sticky actions: left out there.
        const route = currentRoute()
        // Easy mode's view of the run shows the same card in its place.
        if (
          ev.skipInRunView !== undefined &&
          (route.name === 'run' || route.name === 'easyRun') &&
          route.runId === ev.skipInRunView
        )
          return
        if (ev.askRunId !== undefined) {
          // Easy's view of the run shows the ask card in place (and announces it).
          if (route.name === 'easyRun' && route.runId === ev.askRunId) return
          this.#askToasts.add(ev.askRunId)
          toast({ id: askToastId(ev.askRunId), level: ev.level, message: ev.message })
          return
        }
        toast({
          level: ev.level,
          message: ev.message,
          ...(ev.action !== undefined ? { action: ev.action } : {}),
        })
        return
      }
      case 'app':
        this.#onApp(ev)
        return
      case 'heartbeat':
        return
      case 'mcp-requests':
        // Outside agents' run requests waiting for the user (the Dashboard's Needs you).
        setMcpRequests(ev.requests)
        return
      case 'preview':
        // A preview started, printed, found its page or ended (the Run it panels).
        upsertPreviewSessions([ev.session])
        return
      case 'queue':
        // The factory's queues, limits, schedule or launch notice changed (the Queue page, its card and banner).
        setQueueView(ev.view)
        return
      case 'memory':
        // A folder's project memory changed: its readers ask memory.get again.
        bumpMemory(ev.folder)
        return
      case 'easy-permission':
        // An Easy project's permission was given, used or revoked: its readers ask again.
        bumpEasyPermission(ev.folder)
        return
      case 'match':
        // A match's record changed: its page asks matches.get again.
        bumpMatch(ev.matchId)
        return
    }
  }

  #clearAskToast(runId: string): void {
    if (!this.#askToasts.delete(runId)) return
    dismissToast(askToastId(runId))
  }

  #onApp(ev: AppEventOf<'app'>): void {
    switch (ev.state) {
      case 'quit-requested':
        setQuitRequested(ev.activeRuns > 0 ? { activeRuns: ev.activeRuns, runIds: ev.runIds ?? [] } : null)
        return
      case 'recovered': {
        const runIds = ev.runIds ?? []
        if (runIds.length === 0) return
        addNotice({
          id: `recovered:${runIds.join(',')}`,
          kind: 'recovered',
          runIds,
          ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
        })
        return
      }
      case 'unclean-exit':
        toast({ level: 'warn', message: ev.detail ?? 'Dim Factory did not close cleanly last time.' })
        return
    }
  }

  // ---- run envelopes ----------------------------------------------------------------------------------------------

  #lane(runId: string): Lane {
    let l = this.#lanes.get(runId)
    if (l === undefined) {
      l = { jobs: 0, pending: [], chain: Promise.resolve() }
      this.#lanes.set(runId, l)
    }
    return l
  }

  #noteBaseline(runId: string, seq: number): void {
    if (seq > (this.#seen.get(runId) ?? 0)) this.#seen.set(runId, seq)
  }

  /** Dedupe for snapshot refetches: structural envelopes past what we have seen schedule one. */
  #noteSeen(env: RunEnvelope): void {
    const seen = this.#seen.get(env.runId) ?? 0
    if (env.seq <= seen) return
    this.#seen.set(env.runId, env.seq)
    if (isStructural(env.body)) scheduleRefetch(env.runId)
  }

  #onRun(env: RunEnvelope): void {
    const lane = this.#lanes.get(env.runId)
    if (lane !== undefined && lane.jobs > 0) {
      lane.pending.push(env)
      return
    }
    this.#applyLive(env, true)
  }

  #applyLive(env: RunEnvelope, gapCheck: boolean): void {
    if (this.#focused.has(env.runId)) {
      const base = this.#buffer.lastSeq(env.runId)
      if (gapCheck && env.seq > base + 1) {
        this.#lane(env.runId).pending.push(env)
        this.#enqueueCatchUp(env.runId)
        return
      }
      this.#buffer.apply(env)
    }
    this.#noteSeen(env)
  }

  /**
   * Queue a paged runs.events fetch from the stream buffer's last seq. `after` delays it (a focus replay waits for
   * main to acknowledge events.focus); `reserved` means the caller already counted the job.
   */
  #enqueueCatchUp(runId: string, after?: Promise<void>, reserved = false): void {
    const lane = this.#lane(runId)
    if (!reserved) lane.jobs++
    const gen = this.#generation
    lane.chain = lane.chain
      .then(() => after)
      .then(async () => {
        if (gen === this.#generation && this.#focused.has(runId)) await this.#catchUp(runId, gen)
      })
      .catch((err: unknown) => logToMain('warn', `stream catch-up failed for ${runId}`, String(err)))
      .finally(() => {
        lane.jobs--
        if (lane.jobs === 0 && gen === this.#generation) this.#drain(runId)
      })
  }

  async #catchUp(runId: string, gen: number): Promise<void> {
    let since = this.#buffer.lastSeq(runId)
    for (;;) {
      const r = await invoke('runs.events', { runId, sinceSeq: since, limit: REPLAY_PAGE_LIMIT })
      if (gen !== this.#generation) return
      if (!r.ok) {
        logToMain('warn', `runs.events failed for ${runId}`, r.error)
        return
      }
      for (const e of r.value.events) {
        const env = e.runId === runId ? e : { ...e, runId }
        if (this.#focused.has(runId)) this.#buffer.apply(env)
        this.#noteSeen(env)
      }
      const last = r.value.events.at(-1)?.seq
      if (last === undefined || !r.value.more) return
      since = last
    }
  }

  /** Apply what queued during catch-ups, in seq order. The catch-up already ran, so no second gap fetch. */
  #drain(runId: string): void {
    const lane = this.#lanes.get(runId)
    if (lane === undefined || lane.pending.length === 0) return
    const pending = lane.pending.sort((a, b) => a.seq - b.seq)
    lane.pending = []
    for (const env of pending) this.#applyLive(env, false)
  }

  // ---- focus ----------------------------------------------------------------------------------------------------

  /** Make `want` the focused set: tell main, then replay each newly focused run before its live envelopes apply. */
  syncFocus(want: ReadonlySet<string>): void {
    const added = [...want].filter((id) => !this.#focused.has(id))
    const removed = [...this.#focused].filter((id) => !want.has(id))
    if (this.#focusSent && added.length === 0 && removed.length === 0) return
    this.#focusSent = true
    this.#focused = new Set(want)
    const gen = this.#generation
    const runIds = [...want]
    for (const id of added) this.#lane(id).jobs++
    const acked = this.#focusChain.then(async () => {
      if (gen !== this.#generation) return
      await invoke('events.focus', { runIds })
    })
    this.#focusChain = acked
    for (const id of added) {
      this.#enqueueCatchUp(id, acked, true)
      const entry = useStore.getState().runs.byId[id]
      if (entry === undefined || entry.status === 'error') void fetchSnapshot(id)
    }
    this.#buffer.evict(this.#focused)
    this.#pruneSnapshots()
  }

  /**
   * Finished runs nobody shows give up their snapshots (state/actions.ts pruneRunSnapshots), and with them
   * their idle refetch and replay lanes and seen seqs; a later envelope or a view that opens one starts afresh.
   */
  #pruneSnapshots(): void {
    for (const runId of pruneRunSnapshots(this.#focused)) {
      forgetRunLane(runId)
      const lane = this.#lanes.get(runId)
      if (lane !== undefined && lane.jobs > 0) continue
      this.#lanes.delete(runId)
      this.#seen.delete(runId)
    }
  }

  focused(): string[] {
    return [...this.#focused]
  }

  // ---- heartbeat watchdog ------------------------------------------------------------------------------------------

  #armWatchdog(): void {
    if (this.#watchdog !== null) clearTimeout(this.#watchdog)
    this.#watchdog = setTimeout(() => {
      this.#watchdog = null
      // Main only beats while the window is shown or runs are active; a hidden window re-arms when shown.
      if (document.visibilityState === 'hidden') return
      setLostContact(true)
    }, HEARTBEAT_TIMEOUT_MS)
  }
}

function installE2EHook(buffer: StreamBuffer): void {
  const hook: DimFactoryE2EHook = {
    streamText: (runId, step, attempt) => buffer.streamText(runId, step, attempt),
    streamLastSeq: (runId) => buffer.lastSeq(runId),
    focusedRuns: () => bridge?.focused() ?? [],
    flushStreams: () => buffer.flush(),
    toast: (input) => toast(input),
  }
  ;(window as unknown as Record<string, unknown>)[E2E_HOOK] = hook
}

// ---- module API ----------------------------------------------------------------------------------------------------

let bridge: Bridge | null = null
let refs = 0
let teardown: ReturnType<typeof setTimeout> | null = null
let readySent = false

const focusCounts = new Map<string, number>()
let manualFocus: readonly string[] = []
let focusQueued = false

function desiredFocus(): Set<string> {
  return new Set([...focusCounts.keys(), ...manualFocus])
}

function queueFocusSync(): void {
  if (focusQueued) return
  focusQueued = true
  // Coalesces churn within one tick (StrictMode's mount → unmount → mount, route changes).
  queueMicrotask(() => {
    focusQueued = false
    bridge?.syncFocus(desiredFocus())
  })
}

/**
 * Start the bridge (App does this in an effect). Returns a release function; the bridge stops one tick after the
 * last release, so StrictMode's unmount/remount keeps the same connection.
 */
export function startBridge(): () => void {
  refs++
  if (teardown !== null) {
    clearTimeout(teardown)
    teardown = null
  }
  if (bridge === null) {
    bridge = new Bridge(streamBuffer)
    void bridge.start()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    refs--
    if (refs > 0) return
    teardown = setTimeout(() => {
      teardown = null
      if (refs === 0) stopBridgeNow()
    }, 0)
  }
}

/** Stop immediately (tests; the deferred stop of startBridge's release in the app). */
export function stopBridgeNow(): void {
  bridge?.stop()
  bridge = null
}

/** Focus a run's full stream while the returned release is not called (ref-counted). */
export function focusRun(runId: string): () => void {
  focusCounts.set(runId, (focusCounts.get(runId) ?? 0) + 1)
  queueFocusSync()
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (focusCounts.get(runId) ?? 1) - 1
    if (n <= 0) focusCounts.delete(runId)
    else focusCounts.set(runId, n)
    queueFocusSync()
  }
}

/** Replace the explicitly focused runs (in addition to focusRun holders). */
export function setFocusedRuns(runIds: readonly string[]): void {
  manualFocus = [...runIds]
  queueFocusSync()
}

/** Runs currently focused (what the renderer applies streams for). */
export function focusedRunIds(): string[] {
  return bridge?.focused() ?? [...desiredFocus()]
}

/** Focus a run's stream while the component is mounted (Run view). */
export function useFocusRun(runId: string | null | undefined): void {
  useEffect(() => (runId != null && runId !== '' ? focusRun(runId) : undefined), [runId])
}

/** Tests: forget everything module-level (bridge, focus holders, the app.ready latch). */
export function resetBridgeForTests(): void {
  stopBridgeNow()
  if (teardown !== null) clearTimeout(teardown)
  teardown = null
  refs = 0
  readySent = false
  focusCounts.clear()
  manualFocus = []
  focusQueued = false
  delete (window as unknown as Record<string, unknown>)[E2E_HOOK]
}
