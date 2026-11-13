// The host half of `recovery.execute` (shell_copy copies through the main-process clipboard; open_docs is https
// only, and only allowlisted hosts). Core is host-agnostic: it answers the text to
// copy or the checked URL, and main does the side effect before the renderer hears the result, so a success always
// means it happened. Electron-free: the clipboard and openExternal are injected (index.ts passes Electron's).
import type { Cmd, RecoveryResult, Result } from '@shared/ipc.ts'
import { allowedExternalUrl } from './urls.ts'

export interface RecoveryHostDeps {
  /** Electron `clipboard.writeText` (a promise since Electron 44; settled before the result is answered). */
  writeClipboard(text: string): void | Promise<void>
  /** Electron `shell.openExternal`. */
  openExternal(url: string): Promise<void>
  log?: { warn(msg: string, data?: Record<string, unknown>): void }
}

export type CoreInvoke = (cmd: Cmd, req: unknown) => Promise<Result<unknown>>

const fail = (code: 'VALIDATION' | 'INTERNAL', message: string): Result<unknown> => ({
  ok: false,
  error: { code, message },
})

const isRecoveryResult = (v: unknown): v is RecoveryResult =>
  typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string'

/** Perform a successful recovery.execute result's side effect (copy, open); failures become `{ok:false}`. */
export async function applyRecoveryResult(r: Result<unknown>, d: RecoveryHostDeps): Promise<Result<unknown>> {
  if (!r.ok || !isRecoveryResult(r.value)) return r
  const v = r.value
  if (v.kind === 'shell_copy') {
    if (typeof v.copied !== 'string' || v.copied === '') return fail('INTERNAL', 'There was nothing to copy.')
    try {
      await d.writeClipboard(v.copied)
    } catch (err) {
      d.log?.warn('clipboard write failed', { err })
      return fail('INTERNAL', 'The command could not be copied to the clipboard.')
    }
    return r
  }
  if (v.kind === 'open_docs') {
    // Checked again here: main opens only allowlisted https links, whoever asks.
    const url = v.url !== undefined ? allowedExternalUrl(v.url) : null
    if (url === null) return fail('VALIDATION', 'Only https links to known documentation sites open.')
    try {
      await d.openExternal(url)
    } catch (err) {
      d.log?.warn('openExternal failed', { err })
      return fail('INTERNAL', 'The link could not be opened in your browser.')
    }
    return r
  }
  return r
}

/** The router's core call with recovery.execute's side effects done in main. */
export function withRecoveryHost(core: CoreInvoke, d: RecoveryHostDeps): CoreInvoke {
  return async (cmd, req) => {
    const r = await core(cmd, req)
    return cmd === 'recovery.execute' ? applyRecoveryResult(r, d) : r
  }
}
