// Typed access to main over the preload bridge (the IPC contract in src/shared). `invoke` never rejects:
// a missing bridge (scaffold preload, tests without a mock) or a failed IPC call becomes `{ok:false}`, so callers
// handle one shape. `call` unwraps and throws IpcError for code that prefers exceptions.
import type {
  AppEvent,
  Cmd,
  CommandCall,
  DimFactoryApi,
  InvokeArgs,
  Res,
  Result,
  ResultCode,
  ResultError,
} from '@shared/ipc.ts'

export class IpcError extends Error {
  readonly code: ResultCode
  readonly details: unknown
  readonly cmd: string | undefined

  constructor(error: ResultError, cmd?: string) {
    super(error.message)
    this.name = 'IpcError'
    this.code = error.code
    this.details = error.details
    this.cmd = cmd
  }
}

export const NO_BRIDGE_MESSAGE = "Dim Factory's main process is not connected to this window."

/** window.dimFactory when the preload exposed a usable API (invoke + subscribe), else null. */
export function getDimFactory(): DimFactoryApi | null {
  const api = (window as unknown as { dimFactory?: Partial<DimFactoryApi> }).dimFactory
  if (api === undefined || typeof api.invoke !== 'function' || typeof api.subscribe !== 'function')
    return null
  return api as DimFactoryApi
}

export function hasBridge(): boolean {
  return getDimFactory() !== null
}

function failure(code: ResultCode, message: string): { ok: false; error: ResultError } {
  return { ok: false, error: { code, message } }
}

function isResult(v: unknown): v is Result<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean'
}

/** Run a command. Resolves to the handler's Result; never rejects. */
export async function invoke<C extends Cmd>(cmd: C, ...args: InvokeArgs<C>): Promise<Result<Res<C>>> {
  const api = getDimFactory()
  if (api === null) return failure('INTERNAL', NO_BRIDGE_MESSAGE)
  try {
    const r: unknown = await api.invoke(cmd, ...args)
    if (isResult(r)) return r as Result<Res<C>>
    return failure('INTERNAL', `Unexpected reply to ${cmd}.`)
  } catch (err) {
    return failure('INTERNAL', err instanceof Error ? err.message : String(err))
  }
}

/** The value of an ok Result; throws IpcError otherwise. */
export function unwrap<T>(r: Result<T>, cmd?: string): T {
  if (r.ok) return r.value
  throw new IpcError(r.error, cmd)
}

/** invoke + unwrap: resolves to the value or rejects with IpcError. */
export async function call<C extends Cmd>(cmd: C, ...args: InvokeArgs<C>): Promise<Res<C>> {
  return unwrap(await invoke(cmd, ...args), cmd)
}

/** Run a prepared command (toast actions, recovery buttons). */
export function invokeCall(c: CommandCall): Promise<Result<unknown>> {
  // CommandCall pairs each cmd with its own req; the union cannot be spread back into invoke's generic signature.
  const run = invoke as (cmd: Cmd, req?: unknown) => Promise<Result<unknown>>
  return run(c.cmd, c.req)
}

/** Subscribe to pushed AppEvent batches; a no-op without a bridge. */
export function subscribeEvents(cb: (batch: AppEvent[]) => void): () => void {
  const api = getDimFactory()
  if (api === null) return () => {}
  return api.subscribe(cb)
}

/** Fire-and-forget renderer log line into main's log (errors are ignored: logging must never throw). */
export function logToMain(level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void {
  void invoke('log.write', data === undefined ? { level, msg } : { level, msg, data })
}
