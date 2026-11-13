// Match commands: `matches.start` (a Head to head: one task, two builders, each side an isolated run in its own copy
// of the folder), `matches.get` and `matches.list`, keeping a result (`matches.pick`, `matches.undoPick`), hiding the
// builders' names (`matches.blind`) and putting the two results against each other (`matches.compare`,
// `matches.compareFile`). A HandlerMap fragment createHandlers spreads in; the core's side
// comes through `ctx.matches` (match/service.ts, wired in app-core.ts), so a context without it answers UNSUPPORTED.
import { isAbsolute, resolve } from 'node:path'
import type { DiffFilePatch } from '../shared/ipc.ts'
import type {
  BatchAdded,
  BatchPlan,
  MatchCompare,
  MatchContestant,
  NewModelOffer,
  MatchPatchSaved,
  MatchPickResult,
  MatchPickSide,
  MatchRematchRequest,
  MatchSide,
  MatchStarted,
  MatchView,
  RematchCheck,
} from '../shared/match.ts'
import type { Scoreboard } from '../shared/scoreboard.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'
import type { MatchStartInput } from './match/service.ts'

/** What the match commands need (match/service.ts `MatchService`). */
export interface MatchHost {
  start(req: MatchStartInput): Promise<MatchStarted>
  get(matchId: string): Promise<MatchView>
  list(): Promise<MatchView[]>
  pick(matchId: string, side: MatchPickSide): Promise<MatchPickResult>
  undoPick(matchId: string): Promise<MatchView>
  setBlind(matchId: string, on: boolean): Promise<MatchView>
  compare(matchId: string): Promise<MatchCompare>
  compareFile(matchId: string, path: string, o?: { ignoreEol?: boolean }): Promise<DiffFilePatch>
  rematch(req: MatchRematchRequest): Promise<MatchStarted>
  rematchCheck(runId: string): Promise<RematchCheck>
  savePatch(matchId: string, side: MatchSide): Promise<MatchPatchSaved>
  scoreboard(): Promise<Scoreboard>
  batchPlan(challenger: MatchContestant): Promise<BatchPlan>
  batchAdd(challenger: MatchContestant, runIds: readonly string[]): Promise<BatchAdded>
  offers(): Promise<NewModelOffer[]>
  dismissOffer(vendor: string, model: string): Promise<void>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function need(cond: unknown, message: string): void {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

export function matchHandlers(ctx: Pick<HandlerContext, 'readOnly' | 'matches'>): HandlerMap {
  const host = (): MatchHost => {
    const h = ctx.matches
    if (h === undefined) throw new DimFactoryError('UNSUPPORTED', 'Matches are not available here.')
    return h
  }
  return {
    'matches.start': (req) => {
      need(isObj(req), 'request body is required')
      need(typeof req.folder === 'string' && req.folder.trim() !== '', 'folder is required')
      need(typeof req.task === 'string' && req.task.trim() !== '', 'task is required')
      need(Array.isArray(req.sides) && req.sides.length === 2, 'sides must name exactly two builders')
      need(
        req.sides.every((s) => isObj(s) && typeof s.vendor === 'string' && s.vendor.trim() !== ''),
        'each side needs a vendor',
      )
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      const folder = isAbsolute(req.folder) ? req.folder : resolve(req.folder)
      // Only what the command names: a caller inside core may say more (hints), a request over IPC may not.
      return host().start({
        folder,
        task: req.task,
        sides: req.sides,
        ...(req.blind !== undefined ? { blind: req.blind } : {}),
        ...(req.overrides !== undefined ? { overrides: req.overrides } : {}),
        ...(req.brief !== undefined ? { brief: req.brief } : {}),
        ...(req.recipe !== undefined ? { recipe: req.recipe } : {}),
      })
    },
    // Reads: a read-only process may answer.
    'matches.get': (req) => {
      need(isObj(req) && typeof req.matchId === 'string' && req.matchId !== '', 'matchId is required')
      return host().get(req.matchId)
    },
    'matches.list': () => host().list(),
    'matches.scoreboard': () => host().scoreboard(),
    'matches.offers': () => host().offers(),
    'matches.batchPlan': (req) => {
      need(
        isObj(req) && isObj(req.challenger) && typeof req.challenger.vendor === 'string',
        'challenger is required',
      )
      return host().batchPlan(req.challenger)
    },
    'matches.batchAdd': (req) => {
      need(
        isObj(req) && isObj(req.challenger) && typeof req.challenger.vendor === 'string',
        'challenger is required',
      )
      need(Array.isArray(req.runIds) && req.runIds.length > 0, 'runIds must list at least one run')
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return host().batchAdd(req.challenger, req.runIds)
    },
    'matches.dismissOffer': (req) => {
      need(
        isObj(req) && typeof req.vendor === 'string' && typeof req.model === 'string',
        'vendor and model are required',
      )
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return host().dismissOffer(req.vendor, req.model)
    },
    'matches.compare': (req) => {
      need(isObj(req) && typeof req.matchId === 'string' && req.matchId !== '', 'matchId is required')
      return host().compare(req.matchId)
    },
    'matches.compareFile': (req) => {
      need(isObj(req) && typeof req.matchId === 'string' && req.matchId !== '', 'matchId is required')
      need(typeof req.path === 'string' && req.path !== '', 'path is required')
      return host().compareFile(req.matchId, req.path, req.ignoreEol === true ? { ignoreEol: true } : {})
    },
    'matches.rematchCheck': (req) => {
      need(isObj(req) && typeof req.runId === 'string' && req.runId !== '', 'runId is required')
      return host().rematchCheck(req.runId)
    },
    'matches.rematch': (req) => {
      need(isObj(req) && typeof req.runId === 'string' && req.runId !== '', 'runId is required')
      need(
        isObj(req.challenger) &&
          typeof req.challenger.vendor === 'string' &&
          req.challenger.vendor.trim() !== '',
        'the challenger needs a vendor',
      )
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return host().rematch(req)
    },
    'matches.savePatch': (req) => {
      need(isObj(req) && typeof req.matchId === 'string' && req.matchId !== '', 'matchId is required')
      need(req.side === 'a' || req.side === 'b', 'side must be a or b')
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return host().savePatch(req.matchId, req.side)
    },
    // Writes: the folder (a pick applies a side to it) and the record.
    'matches.pick': (req) => {
      need(isObj(req) && typeof req.matchId === 'string' && req.matchId !== '', 'matchId is required')
      need(req.side === 'a' || req.side === 'b' || req.side === 'none', 'side must be a, b or none')
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return host().pick(req.matchId, req.side)
    },
    'matches.undoPick': (req) => {
      need(isObj(req) && typeof req.matchId === 'string' && req.matchId !== '', 'matchId is required')
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return host().undoPick(req.matchId)
    },
    'matches.blind': (req) => {
      need(isObj(req) && typeof req.matchId === 'string' && req.matchId !== '', 'matchId is required')
      need(typeof req.on === 'boolean', 'on must be true or false')
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return host().setBlind(req.matchId, req.on)
    },
  }
}
