// User-facing boot texts: why Dim Factory cannot start (home locked by the app or a CLI
// command, home from a newer version, storage) and the one-time "N runs were paused because Dim Factory closed"
// notice. Pure.
import { errorMessage, isDimFactoryError } from '@core/errors.ts'
import type { AppEvent } from '@shared/ipc.ts'

export interface BootFailure {
  /** ResultCode of the failure, or 'error'. */
  code: string
  title: string
  /** Dialog body: what happened and what to do. */
  message: string
}

export function bootFailure(err: unknown, home: string): BootFailure {
  const code = isDimFactoryError(err) ? err.code : 'error'
  const title = 'Dim Factory cannot start'
  if (code === 'HOME_LOCKED') {
    const details = isDimFactoryError(err) ? err.details : undefined
    const kind =
      typeof details === 'object' && details !== null
        ? (details as Record<string, unknown>)['kind']
        : undefined
    const message =
      kind === 'cli'
        ? `A Dim Factory command-line session is using ${home}. Wait for it to finish or stop it, then start Dim Factory again.`
        : `Dim Factory is already running with ${home}. Close it (it may be in the system tray) or wait for it to finish, then start Dim Factory again.`
    return { code, title, message }
  }
  if (code === 'NEWER_SCHEMA') {
    return {
      code,
      title,
      message: `${home} was written by a newer version of Dim Factory. Install that version, or set DIM_FACTORY_HOME to another folder.\n\n${errorMessage(err)}`,
    }
  }
  return { code, title, message: `Dim Factory could not open ${home}.\n\n${errorMessage(err)}` }
}

/** The recovery notice pushed once after the renderer is ready; null when nothing was paused. */
export function recoveredNotice(pausedRunIds: readonly string[], activeRuns: number): AppEvent | null {
  const n = pausedRunIds.length
  if (n === 0) return null
  return {
    kind: 'app',
    state: 'recovered',
    activeRuns,
    runIds: [...pausedRunIds],
    detail: `${n} ${n === 1 ? 'run was' : 'runs were'} paused because Dim Factory closed`,
  }
}
