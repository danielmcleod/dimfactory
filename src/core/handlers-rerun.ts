// `runs.rerun` (the Runs history row actions; R14): Re-run with same config (`from: 'start'`) or Re-run from Fix
// (`from: 'fix'`, optional `findingIds`).
// Validates the request and hands it to the core's re-run (rerun.ts); read-only cores refuse it.
import type { RunStarted } from '../shared/ipc.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'
import type { RerunRequest } from './rerun.ts'

/** What the handler needs from the core: its re-run (absent on read-only cores and in builds without it). */
export type RerunFn = (req: RerunRequest) => Promise<RunStarted>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const need = (cond: unknown, message: string): void => {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

/** The `runs.rerun` request as rerun.ts takes it (VALIDATION when malformed). */
export function rerunRequestOf(req: unknown): RerunRequest {
  need(isObj(req), 'request body is required')
  const r = req as Record<string, unknown>
  const runId = r['runId']
  need(typeof runId === 'string' && runId !== '', 'runId is required')
  const from = r['from']
  need(from === 'start' || from === 'fix', 'from must be start or fix')
  const ids = r['findingIds']
  need(
    ids === undefined ||
      (Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id.trim() !== '')),
    'findingIds must be a list of finding ids',
  )
  need(ids === undefined || from === 'fix', 'findingIds go with from: fix only')
  return {
    runId: runId as string,
    from: from as 'start' | 'fix',
    ...(ids !== undefined ? { findingIds: ids as string[] } : {}),
  }
}

export function rerunHandlers(ctx: Pick<HandlerContext, 'readOnly' | 'rerun'>): HandlerMap {
  return {
    'runs.rerun': async (req) => {
      const r = rerunRequestOf(req)
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      if (ctx.rerun === undefined) {
        throw new DimFactoryError('UNSUPPORTED', 'Re-run is not available here.')
      }
      return ctx.rerun(r)
    },
  }
}
