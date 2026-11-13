// ipc/bridge.ts against a mocked window.dimFactory: subscribe-first start-up, seq dedupe, one catch-up per gap, resync,
// focus replay merged with live envelopes (reload-mid-stream.spec.ts: no loss, no duplication), the heartbeat watchdog and push routing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEvent, RunEventsPage } from '@shared/ipc.ts'
import type { RunEnvelope } from '@shared/run.ts'
import {
  E2E_HOOK,
  HEARTBEAT_TIMEOUT_MS,
  focusRun,
  isStructural,
  resetBridgeForTests,
  startBridge,
} from '@renderer/ipc/bridge.ts'
import type { DimFactoryE2EHook } from '@renderer/ipc/bridge.ts'
import { streamBuffer, streamText } from '@renderer/lib/streamBuffer.ts'
import { cancelRefetches, REFETCH_DEBOUNCE_MS } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { deferred, defaultAppInfo, installMockDimFactory } from './helpers/mockDimFactory.ts'
import type { MockDimFactory } from './helpers/mockDimFactory.ts'
import { env, ev, makeSnapshot, makeSummary, runEvent, text, textLog } from './helpers/fixtures.ts'

let mock: MockDimFactory

/** Let timers due now and every pending promise chain run. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

/** runs.events over a mutable log, paged like the bus. */
function serve(log: RunEnvelope[]) {
  return (req: { sinceSeq: number; limit?: number }): RunEventsPage => {
    const events = log.filter((e) => e.seq > req.sinceSeq).slice(0, req.limit ?? 2000)
    const lastSeq = log.at(-1)?.seq ?? 0
    return { events, lastSeq, more: (events.at(-1)?.seq ?? req.sinceSeq) < lastSeq }
  }
}

const lines = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('')

const cmds = (): string[] => mock.calls.map((c) => c.cmd)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
})

afterEach(() => {
  resetBridgeForTests()
  cancelRefetches()
  mock.uninstall()
  clearToasts()
  vi.useRealTimers()
  document.documentElement.className = ''
})

describe('start-up', () => {
  it('subscribes before its first command and applies what was pushed while loading', async () => {
    const info = deferred<ReturnType<typeof defaultAppInfo>>()
    mock = installMockDimFactory({ handlers: { 'app.info': () => info.promise } })
    startBridge()
    expect(cmds()[0]).toBe('subscribe')
    mock.push({ kind: 'run-summary', summary: makeSummary({ runId: 'r7', displayNo: 7 }) })
    await settle()
    expect(useStore.getState().summaries.byId['r7']).toBeUndefined()
    info.resolve(defaultAppInfo())
    await settle()
    expect(useStore.getState().summaries.byId['r7']?.displayNo).toBe(7)
    expect(useStore.getState().app.bridge).toBe('ready')
  })

  it('loads active and recent runs, vendors and active snapshots, and calls app.ready once', async () => {
    window.location.hash = '#/runs/r1'
    mock = installMockDimFactory({
      handlers: {
        'runs.list': (q) =>
          q.status !== undefined
            ? { items: [makeSummary({ runId: 'r1', status: 'running' })], nextCursor: null }
            : { items: [makeSummary({ runId: 'r0', status: 'completed', createdAt: 1 })], nextCursor: null },
        'runs.get': (q) => makeSnapshot({ runId: q.runId }, 4),
        'vendors.list': () => [
          {
            vendor: 'claude',
            displayName: 'Claude',
            built: true,
            experimental: false,
            health: 'ready',
            healthDetail: 'Ready',
          } as never,
        ],
      },
    })
    const release = startBridge()
    // StrictMode: unmount + remount in the same tick keeps the same connection.
    release()
    const release2 = startBridge()
    await settle()
    const q = mock.callsOf('runs.list')
    expect(q).toContainEqual({ status: ['queued', 'running', 'waiting', 'paused'] })
    expect(q.some((x) => x.limit !== undefined && x.status === undefined)).toBe(true)
    const s = useStore.getState()
    expect(s.summaries.order).toEqual(['r1', 'r0'])
    expect(s.runs.byId['r1']?.snapshot?.lastSeq).toBe(4)
    expect(s.probes.order).toEqual(['claude'])
    expect(mock.callsOf('app.ready')).toEqual([{ route: '#/runs/r1' }])
    expect(cmds().filter((c) => c === 'subscribe')).toHaveLength(1)
    release2()
    window.location.hash = ''
  })

  it('drops start-up envelopes the snapshot already reflects and refetches for a newer structural one', async () => {
    const info = deferred<ReturnType<typeof defaultAppInfo>>()
    mock = installMockDimFactory({
      handlers: {
        'app.info': () => info.promise,
        'runs.list': (q) => ({ items: q.status ? [makeSummary({ runId: 'r1' })] : [], nextCursor: null }),
        'runs.get': (q) => makeSnapshot({ runId: q.runId }, 5),
      },
    })
    startBridge()
    mock.push(runEvent(env('r1', 3, { t: 'run-status', status: 'running', phase: 'planning' })))
    mock.push(runEvent(env('r1', 5, { t: 'run-status', status: 'running', phase: 'implementing' })))
    info.resolve(defaultAppInfo())
    await settle(REFETCH_DEBOUNCE_MS * 3)
    expect(mock.callsOf('runs.get')).toHaveLength(1)
    mock.push(runEvent(env('r1', 6, { t: 'run-status', status: 'waiting', phase: 'plan-review' })))
    await settle(REFETCH_DEBOUNCE_MS * 3)
    expect(mock.callsOf('runs.get')).toHaveLength(2)
  })

  it('without a preload bridge shows lost contact instead of failing', async () => {
    mock = installMockDimFactory()
    mock.uninstall()
    startBridge()
    await settle()
    expect(useStore.getState().app.bridge).toBe('unavailable')
    expect(useStore.getState().app.lostContact).toBe(true)
  })
})

describe('structural envelopes', () => {
  it('stream events never refetch; an ask and other bodies do, debounced per run', async () => {
    mock = installMockDimFactory({ handlers: { 'runs.get': (q) => makeSnapshot({ runId: q.runId }, 99) } })
    startBridge()
    await settle()
    for (let i = 1; i <= 5; i++) mock.push(runEvent(env('r1', i, text('plan', 'x'))))
    await settle(REFETCH_DEBOUNCE_MS * 3)
    expect(mock.callsOf('runs.get')).toHaveLength(0)
    mock.push(
      runEvent(
        env(
          'r1',
          6,
          ev('plan', {
            type: 'ask',
            requestId: 'q',
            kind: 'shell',
            detail: 'ls',
            expiresAt: 1,
            allowSession: true,
          }),
        ),
      ),
    )
    mock.push(
      runEvent(
        env('r1', 7, {
          t: 'usage',
          step: 'plan',
          attempt: 1,
          usage: { input: 1, output: 1 },
          costBasis: 'none',
        }),
      ),
    )
    mock.push(runEvent(env('r1', 8, { t: 'diff-stats', files: 1, added: 1, deleted: 0, live: true })))
    await settle(REFETCH_DEBOUNCE_MS * 3)
    expect(mock.callsOf('runs.get')).toEqual([{ runId: 'r1' }])
    expect(useStore.getState().runs.byId['r1']?.lastSeq).toBe(99)
  })

  it('classifies bodies', () => {
    expect(isStructural(text('plan', 'x'))).toBe(false)
    expect(isStructural(ev('plan', { type: 'tool', name: 'a', summary: '' }))).toBe(false)
    expect(isStructural(ev('plan', { type: 'done', result: '' }))).toBe(false)
    expect(
      isStructural(
        ev('plan', {
          type: 'ask',
          requestId: 'q',
          kind: 'edit',
          detail: '',
          expiresAt: 0,
          allowSession: false,
        }),
      ),
    ).toBe(true)
    expect(isStructural({ t: 'card', card: {} as never, state: 'open' })).toBe(true)
  })
})

describe('focused runs', () => {
  it('replays the log after events.focus and merges live envelopes with no loss or duplication', async () => {
    const log = textLog('r1', 'implement', 2600)
    const firstPage = deferred<void>()
    let pages = 0
    const page = serve(log)
    mock = installMockDimFactory({
      handlers: {
        'runs.get': (q) => makeSnapshot({ runId: q.runId }, 2600),
        'runs.events': async (q) => {
          if (pages++ === 0) await firstPage.promise
          return page(q)
        },
      },
    })
    startBridge()
    await settle()
    focusRun('r1')
    await settle()
    // Start-up tells main "nothing focused" (a reload must not inherit the old page's focus), then the run.
    expect(mock.callsOf('events.focus')).toEqual([{ runIds: [] }, { runIds: ['r1'] }])
    expect(cmds().indexOf('runs.events')).toBeGreaterThan(cmds().lastIndexOf('events.focus'))
    expect(mock.callsOf('runs.events')[0]).toMatchObject({ runId: 'r1', sinceSeq: 0 })
    // Live delivery overlaps the replay.
    for (const e of log.slice(2399)) mock.push(runEvent(e))
    firstPage.resolve()
    await settle()
    for (let i = 2601; i <= 2610; i++) mock.push(runEvent(env('r1', i, text('implement', `line ${i}\n`))))
    expect(streamText('r1', 'implement')).toBe(lines(1, 2610))
    expect(streamBuffer.lastSeq('r1')).toBe(2610)
    expect(mock.callsOf('runs.events').map((r) => r.sinceSeq)).toEqual([0, 1000, 2000])
  })

  it('fetches once for a gap and applies what arrived meanwhile in seq order', async () => {
    const log = textLog('r1', 'fix', 3)
    let gate: Promise<void> | null = null
    const page = serve(log)
    mock = installMockDimFactory({
      handlers: {
        'runs.get': (q) => makeSnapshot({ runId: q.runId }, 3),
        'runs.events': async (q) => {
          if (gate !== null) await gate
          return page(q)
        },
      },
    })
    startBridge()
    await settle()
    focusRun('r1')
    await settle()
    expect(streamText('r1', 'fix')).toBe(lines(1, 3))
    log.push(...textLog('r1', 'fix', 9).slice(3))
    const hold = deferred<void>()
    gate = hold.promise
    mock.push(runEvent(log[6]!)) // seq 7: 4..6 never arrived
    mock.push(runEvent(log[7]!), runEvent(log[8]!))
    await settle()
    expect(mock.callsOf('runs.events').slice(1)).toEqual([{ runId: 'r1', sinceSeq: 3, limit: 1000 }])
    hold.resolve()
    await settle()
    mock.push(runEvent(env('r1', 10, text('fix', 'line 10\n'))))
    expect(streamText('r1', 'fix')).toBe(lines(1, 10))
    expect(mock.callsOf('runs.events')).toHaveLength(2)
  })

  it('on resync refetches the snapshot and catches a focused run up', async () => {
    const log = textLog('r1', 'plan', 3)
    mock = installMockDimFactory({
      handlers: {
        'runs.get': (q) => makeSnapshot({ runId: q.runId }, log.length),
        'runs.events': serve(log),
      },
    })
    startBridge()
    await settle()
    focusRun('r1')
    await settle(REFETCH_DEBOUNCE_MS * 3)
    const gets = mock.callsOf('runs.get').length
    log.push(...textLog('r1', 'plan', 6).slice(3))
    mock.push({ kind: 'resync', runIds: ['r1'] })
    await settle(REFETCH_DEBOUNCE_MS * 3)
    expect(streamText('r1', 'plan')).toBe(lines(1, 6))
    expect(mock.callsOf('runs.events').at(-1)).toMatchObject({ sinceSeq: 3 })
    expect(mock.callsOf('runs.get').length).toBe(gets + 1)
  })

  it('does not stream unfocused runs, and a re-focus replays only what the buffer lacks', async () => {
    const log = textLog('r1', 'review', 3)
    mock = installMockDimFactory({
      handlers: {
        'runs.get': (q) => makeSnapshot({ runId: q.runId }, log.length),
        'runs.events': serve(log),
      },
    })
    startBridge()
    await settle()
    const release = focusRun('r1')
    await settle()
    release()
    await settle()
    expect(mock.callsOf('events.focus').at(-1)).toEqual({ runIds: [] })
    log.push(...textLog('r1', 'review', 5).slice(3))
    mock.push(runEvent(log[4]!)) // would not arrive from main; it must not be applied either
    expect(streamText('r1', 'review')).toBe(lines(1, 3))
    focusRun('r1')
    await settle()
    expect(mock.callsOf('runs.events').at(-1)).toMatchObject({ sinceSeq: 3 })
    expect(streamText('r1', 'review')).toBe(lines(1, 5))
  })

  it('a run focused before the bridge starts replays once start-up is done', async () => {
    const log = textLog('r2', 'plan', 4)
    mock = installMockDimFactory({
      handlers: { 'runs.get': (q) => makeSnapshot({ runId: q.runId }, 4), 'runs.events': serve(log) },
    })
    focusRun('r2')
    await settle()
    startBridge()
    await settle()
    expect(mock.callsOf('events.focus')).toEqual([{ runIds: ['r2'] }])
    expect(streamText('r2', 'plan')).toBe(lines(1, 4))
  })
})

describe('heartbeat watchdog', () => {
  it(`flags lost contact after ${HEARTBEAT_TIMEOUT_MS / 1000} s of silence and clears on the next event`, async () => {
    mock = installMockDimFactory()
    startBridge()
    await settle()
    await settle(HEARTBEAT_TIMEOUT_MS - 10)
    expect(useStore.getState().app.lostContact).toBe(false)
    await settle(20)
    expect(useStore.getState().app.lostContact).toBe(true)
    mock.push({ kind: 'heartbeat', at: 1 })
    expect(useStore.getState().app.lostContact).toBe(false)
    await settle(HEARTBEAT_TIMEOUT_MS + 10)
    expect(useStore.getState().app.lostContact).toBe(true)
  })

  it('does not flag while the window is hidden', async () => {
    mock = installMockDimFactory()
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    startBridge()
    await settle()
    await settle(HEARTBEAT_TIMEOUT_MS * 2)
    expect(useStore.getState().app.lostContact).toBe(false)
    vis.mockRestore()
  })
})

describe('push routing', () => {
  it('routes theme, toast, app, attention, probe, summary and config events', async () => {
    mock = installMockDimFactory()
    startBridge()
    await settle()
    const events: AppEvent[] = [
      { kind: 'theme', theme: { theme: 'dark', resolved: 'dark', accent: 'violet' } },
      { kind: 'toast', level: 'warn', message: 'Codex sandbox not set up' },
      { kind: 'app', state: 'quit-requested', activeRuns: 2, runIds: ['a', 'b'] },
      { kind: 'app', state: 'recovered', activeRuns: 0, runIds: ['a'], detail: '1 run was paused' },
      { kind: 'attention', needsYou: 3, items: [] },
      { kind: 'probe', vendor: 'codex', view: { vendor: 'codex', displayName: 'Codex' } as never },
      { kind: 'run-summary', summary: makeSummary({ runId: 'z', status: 'completed' }) },
      { kind: 'config-changed', scope: 'user' },
    ]
    mock.push(...events)
    const s = useStore.getState()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset['accent']).toBe('violet')
    expect(s.app.theme?.accent).toBe('violet')
    expect(s.toasts.items.map((t) => t.message)).toEqual(['Codex sandbox not set up'])
    expect(s.app.quitRequested).toEqual({ activeRuns: 2, runIds: ['a', 'b'] })
    expect(s.app.notices).toEqual([
      { id: 'recovered:a', kind: 'recovered', runIds: ['a'], detail: '1 run was paused' },
    ])
    expect(s.attention.needsYou).toBe(3)
    expect(s.probes.byVendor['codex']?.displayName).toBe('Codex')
    expect(s.summaries.byId['z']?.status).toBe('completed')
    expect(s.app.configEpoch).toBe(1)
  })

  it("leaves a gate's in-app toast out while that run's view is open, and shows it anywhere else", async () => {
    mock = installMockDimFactory()
    startBridge()
    await settle()
    const gate = (runId: string, message: string): AppEvent => ({
      kind: 'toast',
      level: 'info',
      message,
      skipInRunView: runId,
    })
    try {
      // In run r1's view (any tab): its gate is there already, as a card with a jump pill.
      window.location.hash = '#/runs/r1/log'
      mock.push(gate('r1', 'Findings ready · r1'))
      // Another run's gate, and a toast with no run, still show.
      mock.push(gate('r2', 'Plan ready · r2'))
      mock.push({ kind: 'toast', level: 'warn', message: 'Claude needs approval · r1' })
      expect(useStore.getState().toasts.items.map((t) => t.message)).toEqual([
        'Plan ready · r2',
        'Claude needs approval · r1',
      ])
      // On the Dashboard the same gate's toast shows.
      clearToasts()
      window.location.hash = '#/'
      mock.push(gate('r1', 'Plan ready · r1'))
      expect(useStore.getState().toasts.items.map((t) => t.message)).toEqual(['Plan ready · r1'])
    } finally {
      window.location.hash = ''
    }
  })

  it('installs the E2E stream hook only when app.info says e2e', async () => {
    mock = installMockDimFactory({
      handlers: {
        'app.info': () => defaultAppInfo({ e2e: true }),
        'runs.events': serve(textLog('r1', 'plan', 2)),
      },
    })
    startBridge()
    await settle()
    focusRun('r1')
    await settle()
    const hook = (window as unknown as Record<string, DimFactoryE2EHook>)[E2E_HOOK]
    expect(hook?.streamText('r1', 'plan')).toBe(lines(1, 2))
    expect(hook?.focusedRuns()).toEqual(['r1'])
    hook?.toast({ level: 'error', message: 'Failed · Something went wrong' })
    expect(useStore.getState().toasts.items.map((t) => t.message)).toEqual(['Failed · Something went wrong'])
  })
})
