// Test double for window.dimFactory (the IPC contract): answers commands from per-command handlers, records every
// call in order (with `subscribe` as its own entry), and lets a test push AppEvent batches as main would.
import type {
  AppEvent,
  AppInfo,
  Cmd,
  DimFactoryApi,
  Platform,
  Req,
  Res,
  Result,
  ResultCode,
  ThemeState,
} from '@shared/ipc.ts'

export type MockHandler<C extends Cmd> = (req: Req<C>) => Res<C> | Promise<Res<C>>
export type MockHandlers = { [C in Cmd]?: MockHandler<C> }

/** Throw from a handler to answer `{ok:false, error:{code, message, details?}}`. */
export class MockIpcError extends Error {
  readonly code: ResultCode
  readonly details: unknown
  constructor(code: ResultCode, message: string, details?: unknown) {
    super(message)
    this.code = code
    this.details = details
  }
}

export function mockError(code: ResultCode, message: string = code, details?: unknown): MockIpcError {
  return new MockIpcError(code, message, details)
}

export interface MockCall {
  cmd: Cmd | 'subscribe'
  req: unknown
}

export interface MockDimFactory {
  readonly api: DimFactoryApi
  /** Every invoke (and subscribe) in call order. */
  readonly calls: MockCall[]
  callsOf<C extends Cmd>(cmd: C): Req<C>[]
  /** Deliver one batch to every subscriber (synchronously, like the preload's listener). */
  push(...events: AppEvent[]): void
  on<C extends Cmd>(cmd: C, handler: MockHandler<C>): void
  subscriberCount(): number
  uninstall(): void
}

export function defaultAppInfo(over: Partial<AppInfo> = {}): AppInfo {
  return {
    name: 'Dim Factory',
    version: '0.1.0-test',
    platform: 'win32',
    arch: 'x64',
    versions: { electron: '44.5.1', chrome: '140.0.0.0', node: '24.15.0' },
    home: 'C:\\dim-factory-test-home',
    logsDir: 'C:\\dim-factory-test-home\\logs',
    packaged: false,
    e2e: false,
    ipcProtocol: 1,
    git: null,
    notifications: null,
    ...over,
  }
}

const DEFAULTS: MockHandlers = {
  'app.info': () => defaultAppInfo(),
  'app.ready': () => undefined,
  'events.focus': () => undefined,
  'log.write': () => undefined,
  'runs.list': () => ({ items: [], nextCursor: null }),
  'vendors.list': () => [],
}

export interface InstallOptions {
  handlers?: MockHandlers
  platform?: Platform
  initialTheme?: ThemeState
  /** Answer app.info/app.ready/events.focus/log.write/runs.list/vendors.list with empty defaults (default true). */
  defaults?: boolean
}

/** Install window.dimFactory; `uninstall` removes it. Unhandled commands answer UNSUPPORTED. */
export function installMockDimFactory(opts: InstallOptions = {}): MockDimFactory {
  const handlers: MockHandlers = { ...(opts.defaults === false ? {} : DEFAULTS), ...opts.handlers }
  const calls: MockCall[] = []
  const subscribers = new Set<(batch: AppEvent[]) => void>()

  const invoke = async (cmd: Cmd, req?: unknown): Promise<Result<unknown>> => {
    calls.push({ cmd, req })
    const h = handlers[cmd] as ((r: unknown) => unknown) | undefined
    if (h === undefined) return { ok: false, error: { code: 'UNSUPPORTED', message: `${cmd} is not mocked` } }
    try {
      return { ok: true, value: await h(req) }
    } catch (err) {
      if (err instanceof MockIpcError) {
        const error = { code: err.code, message: err.message }
        return { ok: false, error: err.details === undefined ? error : { ...error, details: err.details } }
      }
      return {
        ok: false,
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  const api = {
    invoke,
    subscribe(cb: (batch: AppEvent[]) => void): () => void {
      calls.push({ cmd: 'subscribe', req: undefined })
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    platform: opts.platform ?? 'win32',
    initialTheme: opts.initialTheme ?? { theme: 'system', resolved: 'light', accent: 'slate' },
  } as unknown as DimFactoryApi

  ;(window as unknown as { dimFactory?: DimFactoryApi }).dimFactory = api

  return {
    api,
    calls,
    callsOf: <C extends Cmd>(cmd: C) => calls.filter((c) => c.cmd === cmd).map((c) => c.req as Req<C>),
    push: (...events) => {
      for (const s of [...subscribers]) s(events)
    },
    on: (cmd, handler) => {
      ;(handlers as Record<string, unknown>)[cmd] = handler
    },
    subscriberCount: () => subscribers.size,
    uninstall: () => {
      delete (window as unknown as { dimFactory?: DimFactoryApi }).dimFactory
      subscribers.clear()
    },
  }
}

/** A promise with its resolve exposed (hold a mocked command until the test releases it). */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
