// Runs history commands (Pin / Remove (undo)): `runs.pin`, `runs.remove`
// and `runs.undoRemove`. A HandlerMap fragment createHandlers spreads in; the core's side comes through
// `ctx.history` (history.ts, wired in app-core.ts), so a context without it answers UNSUPPORTED.
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'
import type { RemoveResult } from './history.ts'

/** What the Runs page's row actions need (history.ts `History`). */
export interface HistoryHost {
  pin(runId: string, pinned: boolean): Promise<void>
  remove(runIds: readonly string[]): Promise<RemoveResult>
  undoRemove(undoToken: string): Promise<void>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function need(cond: unknown, message: string): void {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

export function historyHandlers(ctx: HandlerContext): HandlerMap {
  const host = (): HistoryHost => {
    if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
    const h = ctx.history
    if (h === undefined) throw new DimFactoryError('UNSUPPORTED', 'The runs history is not available here.')
    return h
  }
  return {
    'runs.pin': (req) => {
      need(isObj(req) && typeof req.runId === 'string' && req.runId !== '', 'runId is required')
      need(typeof req.pinned === 'boolean', 'pinned must be true or false')
      return host().pin(req.runId, req.pinned)
    },
    'runs.remove': (req) => {
      need(
        isObj(req) &&
          Array.isArray(req.runIds) &&
          req.runIds.length > 0 &&
          req.runIds.every((id) => typeof id === 'string' && id !== ''),
        'runIds must list at least one run',
      )
      return host().remove(req.runIds)
    },
    'runs.undoRemove': (req) => {
      need(isObj(req) && typeof req.undoToken === 'string' && req.undoToken !== '', 'undoToken is required')
      return host().undoRemove(req.undoToken)
    },
  }
}
