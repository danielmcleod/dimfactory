// Main's wiring: notifications.* and e2e.power / e2e.clock handlers exist only when their deps are
// given (and pass the request through the router), e2e.state carries the recorded notifications and extras, the
// simulated focus, and state.json observation for the notification pause.
import { describe, expect, it, vi } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { createMemoryLogger } from '../../../src/core/log.ts'
import { parseRequest } from '../../../src/shared/ipc-schemas.ts'
import { IPC_PROTOCOL } from '../../../src/shared/ipc.ts'
import type { AppState, Cmd } from '../../../src/shared/ipc.ts'
import { createAppStateStore, observeAppState } from '../../../src/main/app-state.ts'
import { E2E_GLOBAL, FocusOverride, buildE2EState, installE2EGlobals } from '../../../src/main/e2e.ts'
import { createMainHandlers } from '../../../src/main/main-handlers.ts'
import type { MainHandlerDeps } from '../../../src/main/main-handlers.ts'
import { createRouter } from '../../../src/main/router.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

function deps(over: Partial<MainHandlerDeps> = {}): MainHandlerDeps {
  const paths = homePaths(home())
  return {
    core: { paths, log: createMemoryLogger() },
    appInfo: () => ({
      name: 'Dim Factory',
      version: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      versions: { electron: '44.5.1', chrome: '1', node: '24' },
      home: paths.home,
      logsDir: paths.logsDir,
      packaged: false,
      e2e: true,
      ipcProtocol: 1,
      notifications: { aumid: false, clsid: false },
    }),
    gitInfo: () => Promise.resolve(null),
    pickFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    openExternal: () => Promise.resolve(),
    theme: { set: () => Promise.resolve({ theme: 'dark', resolved: 'dark', accent: 'slate' }) },
    appState: createAppStateStore(paths),
    setFocus: () => undefined,
    rendererReady: () => undefined,
    requestQuit: () => Promise.resolve({ quitting: false, activeRuns: 0 }),
    e2eState: () => ({
      now: 1,
      timeScale: 1,
      activeRuns: 0,
      procs: [],
      windowFocused: false,
      notifications: [],
      tray: { icon: '', tooltip: '' },
    }),
    ...over,
  }
}

const envelope = (cmd: string, req?: unknown) => ({ v: IPC_PROTOCOL, cmd, req, cid: 'c1' })

describe('main handlers', () => {
  it('notifications.test / repairShortcut answer through the router when wired', async () => {
    const test = vi.fn(() => Promise.resolve({ shown: true, surface: 'native' as const }))
    const repairShortcut = vi.fn(() => Promise.resolve({ applicable: false, aumid: false, clsid: false }))
    const main = createMainHandlers(deps({ notifications: { test, repairShortcut } }))
    const core = vi.fn()
    const router = createRouter({ e2e: false, parse: (c: Cmd, r) => parseRequest(c, r), main, core })
    expect(await router(true, envelope('notifications.test'))).toEqual({
      ok: true,
      value: { shown: true, surface: 'native' },
    })
    expect(await router(true, envelope('notifications.repairShortcut'))).toEqual({
      ok: true,
      value: { applicable: false, aumid: false, clsid: false },
    })
    expect(core).not.toHaveBeenCalled()
  })

  it('e2e.power / e2e.clock exist only with their deps, and only under E2E', async () => {
    const e2ePower = vi.fn(() => Promise.resolve())
    const e2eClock = vi.fn((ms: number) => Promise.resolve({ now: 10 + ms }))
    const main = createMainHandlers(deps({ e2ePower, e2eClock }))
    const on = createRouter({ e2e: true, parse: (c: Cmd, r) => parseRequest(c, r), main, core: vi.fn() })
    expect(await on(true, envelope('e2e.power', { event: 'suspend' }))).toEqual({
      ok: true,
      value: undefined,
    })
    expect(e2ePower).toHaveBeenCalledWith('suspend')
    expect(await on(true, envelope('e2e.clock', { advanceMs: 90 }))).toEqual({
      ok: true,
      value: { now: 100 },
    })
    const off = createRouter({ e2e: false, parse: (c: Cmd, r) => parseRequest(c, r), main, core: vi.fn() })
    const hidden = await off(true, envelope('e2e.clock', { advanceMs: 1 }))
    expect(hidden.ok === false && hidden.error.code).toBe('UNKNOWN_COMMAND')
    const plain = createMainHandlers(deps())
    expect(plain['e2e.power']).toBeUndefined()
    expect(plain['e2e.clock']).toBeUndefined()
    expect(plain['notifications.test']).toBeUndefined()
  })

  it('preview.openPair goes to the preview windows through the router, and is UNSUPPORTED without them', async () => {
    const { DimFactoryError } = await import('../../../src/core/errors.ts')
    const unused = (): Promise<never> => Promise.reject(new Error('not used'))
    const openPair = vi.fn((ids: readonly [string, string]) =>
      ids[1] === 'pv_gone'
        ? Promise.reject(new DimFactoryError('NOT_FOUND', 'That preview is not running.'))
        : Promise.resolve(),
    )
    const preview = {
      open: unused,
      openPair,
      smoke: unused,
      savePdf: unused,
      playtest: unused,
      tryIt: unused,
      shareCheck: unused,
      phone: unused,
    }
    const core = vi.fn()
    const parse = (c: Cmd, r: unknown) => parseRequest(c, r)
    const wired = createRouter({ e2e: false, parse, main: createMainHandlers(deps({ preview })), core })
    const req = { sessionIds: ['pv_a', 'pv_b'], labels: ['Claude', 'Codex'] }
    expect(await wired(true, envelope('preview.openPair', req))).toEqual({ ok: true, value: undefined })
    expect(openPair).toHaveBeenLastCalledWith(['pv_a', 'pv_b'], ['Claude', 'Codex'])
    // A preview that is not running is refused by the preview windows, and the refusal is the answer.
    expect(
      await wired(true, envelope('preview.openPair', { ...req, sessionIds: ['pv_a', 'pv_gone'] })),
    ).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'That preview is not running.' } })
    // A URL is never part of the request: the schema refuses one before the handler is reached.
    const calls = openPair.mock.calls.length
    const extra = await wired(
      true,
      envelope('preview.openPair', { ...req, urls: ['http://127.0.0.1:1/', 'http://127.0.0.1:2/'] }),
    )
    expect(extra.ok === false && extra.error.code).toBe('VALIDATION')
    const one = await wired(true, envelope('preview.openPair', { ...req, sessionIds: ['pv_a'] }))
    expect(one.ok === false && one.error.code).toBe('VALIDATION')
    expect(openPair.mock.calls.length).toBe(calls)

    const bare = createRouter({ e2e: false, parse, main: createMainHandlers(deps()), core })
    for (const [cmd, r] of [
      ['preview.openPair', req],
      ['preview.open', { sessionId: 'pv_a', target: 'app' }],
    ] as const) {
      const out = await bare(true, envelope(cmd, r))
      expect(out.ok === false && out.error.code).toBe('UNSUPPORTED')
    }
    expect(core).not.toHaveBeenCalled()
  })

  it('a refused clock comes back as the core error', async () => {
    const { DimFactoryError } = await import('../../../src/core/errors.ts')
    const main = createMainHandlers(
      deps({ e2eClock: () => Promise.reject(new DimFactoryError('UNSUPPORTED', 'E2E only.')) }),
    )
    const router = createRouter({ e2e: true, parse: (c: Cmd, r) => parseRequest(c, r), main, core: vi.fn() })
    expect(await router(true, envelope('e2e.clock', { advanceMs: 1 }))).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED', message: 'E2E only.' },
    })
  })
})

describe('e2e.state', () => {
  it('carries the recorded notifications and the extras', () => {
    const s = buildE2EState({
      clock: { now: () => 5, scale: 1 },
      activeRuns: 1,
      procs: [],
      windowFocused: false,
      tray: { icon: 'tray-1-attn.png', tooltip: '1 run active · 1 needs you' },
      eventLoop: { read: () => ({ p50Ms: 1, p95Ms: 2, maxMs: 3, samples: 4 }) },
      notifications: [
        { title: 'Claude needs approval · my-app', body: 'b', actions: ['Allow once', 'Deny'] },
      ],
      extra: { attention: { overlay: 'overlay-1.png' } },
    })
    expect(s.notifications).toEqual([
      { title: 'Claude needs approval · my-app', body: 'b', actions: ['Allow once', 'Deny'] },
    ])
    expect(s.extra).toEqual({ attention: { overlay: 'overlay-1.png' }, eventLoopP95Ms: 2, eventLoopMaxMs: 3 })
  })

  it('simulated focus overrides the real one until cleared', () => {
    const f = new FocusOverride()
    expect(f.resolve(true)).toBe(true)
    f.simulate(false)
    expect(f.simulated).toBe(false)
    expect(f.resolve(true)).toBe(false)
    f.simulate(true)
    expect(f.resolve(false)).toBe(true)
    f.simulate(null)
    expect(f.resolve(false)).toBe(false)
  })

  it('installs the notification and focus hooks on the main-process global', async () => {
    const simulate = vi.fn()
    const activate = vi.fn(() => Promise.resolve({ kind: 'unknown' as const }))
    installE2EGlobals({
      eventLoop: { read: () => ({ p50Ms: 0, p95Ms: 0, maxMs: 0, samples: 0 }), reset: () => undefined },
      notifications: { list: () => [], act: () => Promise.resolve(null), activate, clear: () => undefined },
      focus: { simulate },
    })
    const g = (globalThis as Record<string, unknown>)[E2E_GLOBAL] as {
      notifications: { activate(a: string): Promise<unknown> }
      focus: { simulate(v: boolean | null): void }
    }
    g.focus.simulate(false)
    expect(simulate).toHaveBeenCalledWith(false)
    expect(await g.notifications.activate('x')).toEqual({ kind: 'unknown' })
  })
})

describe('observeAppState', () => {
  it('reports every state read and written; a throwing observer never breaks the store', async () => {
    const seen: AppState[] = []
    const store = observeAppState(createAppStateStore(homePaths(home())), (s) => seen.push(s))
    await store.get()
    await store.set({ notificationsPausedUntil: 123 })
    expect(seen.map((s) => s.notifications.pausedUntil)).toEqual([null, 123])
    const throwing = observeAppState(createAppStateStore(homePaths(home())), () => {
      throw new Error('observer')
    })
    expect((await throwing.set({ notificationsPausedUntil: null })).notifications.pausedUntil).toBeNull()
  })
})
