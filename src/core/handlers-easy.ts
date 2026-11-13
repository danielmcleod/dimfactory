// Easy mode's commands (easy/service.ts) and `runs.limits` (a run's own limits and the stop one of them caused).
// app-core implements EasyHost; without one these answer UNSUPPORTED.
import type {
  EasyAttachment,
  EasyChangeEstimate,
  EasyAskAnswer,
  EasyChangeRequest,
  EasyCreateRequest,
  EasyFolderView,
  EasyHelper,
  EasyHelperCost,
  EasyIntentAnswer,
  EasyKind,
  EasyPermissionState,
  EasyPermissionView,
  EasyProjectView,
  EasyQueueAddRequest,
  EasyQueueStartRequest,
  EasyQueueView,
  EasyResolveRequest,
  EasyResolved,
  EasyStarted,
  EasyState,
  EasyThinkAnswer,
  EasyThinkRequest,
  EasyVisualResult,
  EasyVisualState,
  EasyWorkRequest,
  RunLimitsView,
} from '../shared/easy.ts'
import type { Experience } from '../shared/config-schema.ts'
import type { ShareFilesReport } from '../shared/share-check.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'

export interface EasyHost {
  state(): Promise<EasyState>
  setExperience(experience: Experience): Promise<EasyState>
  resolve(req: EasyResolveRequest): Promise<EasyResolved>
  create(req: EasyCreateRequest): Promise<EasyStarted>
  change(req: EasyChangeRequest): Promise<EasyStarted>
  changeEstimate(req: { folder: string; change: string }): Promise<EasyChangeEstimate>
  projects(): Promise<EasyProjectView[]>
  limits(runId: string): Promise<RunLimitsView>
  attachCheck(paths: string[]): Promise<EasyAttachment[]>
  permissions(): Promise<EasyPermissionView[]>
  permission(folder: string, runId?: string): Promise<EasyPermissionState>
  revokePermission(folder: string): Promise<EasyPermissionView[]>
  inspectFolder(folder: string): Promise<EasyFolderView>
  work(req: EasyWorkRequest): Promise<EasyStarted>
  intent(idea: string, candidates: EasyKind[]): Promise<EasyIntentAnswer>
  visual(runId: string): Promise<EasyVisualState>
  visualReview(runId: string): Promise<EasyVisualResult>
  helperCost(helper: EasyHelper, runId?: string): Promise<EasyHelperCost>
  think(req: EasyThinkRequest): Promise<EasyThinkAnswer>
  ask(runId: string, question: string): Promise<EasyAskAnswer>
  shareFiles(runId: string): Promise<ShareFilesReport>
  queue(): Promise<EasyQueueView>
  queueAdd(req: EasyQueueAddRequest): Promise<EasyQueueView>
  queueStart(req: EasyQueueStartRequest & { noticeId?: string }): Promise<EasyQueueView>
  queuePause(): Promise<EasyQueueView>
  queueRemove(folder: string): Promise<EasyQueueView>
}

export function easyHandlers(ctx: HandlerContext): HandlerMap {
  const host = (): EasyHost => {
    const h = ctx.easy
    if (h === undefined) throw new DimFactoryError('UNSUPPORTED', 'Easy mode is not available in this build.')
    return h
  }
  const writable = (): void => {
    if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
  }
  return {
    'easy.state': () => host().state(),
    'easy.setExperience': (req) => {
      writable()
      return host().setExperience(req.experience)
    },
    'easy.resolve': (req) => host().resolve(req),
    'easy.create': (req) => {
      writable()
      return host().create(req)
    },
    'easy.change': (req) => {
      writable()
      return host().change(req)
    },
    'easy.changeEstimate': (req) => host().changeEstimate(req),
    'easy.projects': () => host().projects(),
    'easy.attachCheck': (req) => host().attachCheck(req.paths),
    'easy.permissions': () => host().permissions(),
    'easy.permission': (req) => host().permission(req.folder, req.runId),
    'easy.revokePermission': (req) => {
      writable()
      return host().revokePermission(req.folder)
    },
    'runs.limits': (req) => host().limits(req.runId),
    'easy.inspectFolder': (req) => host().inspectFolder(req.folder),
    'easy.work': (req) => {
      writable()
      return host().work(req)
    },
    'easy.intent': (req) => host().intent(req.idea, req.candidates),
    'easy.visual': (req) => host().visual(req.runId),
    'easy.visualReview': (req) => {
      writable()
      return host().visualReview(req.runId)
    },
    // Read-only helpers, each one call on the user's click: nothing is changed, so a read-only process may answer.
    'easy.helperCost': (req) => host().helperCost(req.helper, req.runId),
    'easy.think': (req) => host().think(req),
    'easy.ask': (req) => host().ask(req.runId, req.question),
    'easy.shareFiles': (req) => host().shareFiles(req.runId),
    'easy.queue': () => host().queue(),
    'easy.queueAdd': (req) => {
      writable()
      return host().queueAdd(req)
    },
    'easy.queueStart': (req) => {
      writable()
      return host().queueStart(req)
    },
    'easy.queuePause': () => {
      writable()
      return host().queuePause()
    },
    'easy.queueRemove': (req) => {
      writable()
      return host().queueRemove(req.folder)
    },
  }
}
