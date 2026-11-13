// worktree.* commands (isolated runs; the Diff tab's "Apply to folder…"): requests are checked here; app-core's
// WorktreeHost goes through the run's controller (lease, journal, the
// 10 s Discard), and worktree.preview reads the run's worktree shadow directly (nothing written).
import type {
  Commands,
  FileChange,
  WorktreeApplyResult,
  WorktreeConflictChoice,
  WorktreeDiscardResult,
  WorktreePreview,
} from '../shared/ipc.ts'
import { DIFF_SEGMENTS } from '../shared/ipc.ts'
import { DimFactoryError, errorMessage, isDimFactoryError } from './errors.ts'
import { previewApply } from './git/finalize.ts'
import type { FinalizeTarget } from './git/finalize.ts'
import { ShadowReader } from './git/diff-view.ts'
import { isGitError } from './git/exec.ts'
import { resolveScope } from './git/repo.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'
import { isRunRelativePath } from './handlers-diff-settings.ts'
import type { HomePaths } from './home.ts'
import { readReviewState, reviewedPaths } from './store/review-state.ts'
import type { RunController, RunDoc } from './supervisor/controller.ts'
import { missingSegmentText, segmentEnds } from './supervisor/diff-segments.ts'
import type { FinalizeRunState, RunState } from './supervisor/types.ts'

/** worktree.apply's request after its checks. */
export interface WorktreeApplyRequest {
  paths?: string[]
  resolutions?: Record<string, WorktreeConflictChoice>
  reviewedOnly?: boolean
}

/** What core does for an isolated run's worktree (app-core: createWorktreeHost over the run's controller). */
export interface WorktreeHost {
  /** What Apply would do now: the run's files, the conflicts, each path's action. Writes nothing. */
  preview(runId: string): Promise<WorktreePreview>
  apply(runId: string, req: WorktreeApplyRequest): Promise<WorktreeApplyResult>
  undoApply(runId: string, undoToken: string): Promise<void>
  discard(runId: string): Promise<WorktreeDiscardResult>
  undoDiscard(runId: string, undoToken: string): Promise<void>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const need = (cond: unknown, message: string): void => {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

function runIdOf(req: unknown): string {
  const id = isObj(req) ? req['runId'] : undefined
  need(typeof id === 'string' && id !== '', 'runId is required')
  return id as string
}

function undoTokenOf(req: unknown): string {
  const t = isObj(req) ? req['undoToken'] : undefined
  need(typeof t === 'string' && t !== '', 'undoToken is required')
  return t as string
}

/** worktree.apply's body: `paths` or `reviewedOnly` (not both), `resolutions` per relative path. */
export function applyRequestOf(req: unknown): WorktreeApplyRequest {
  const r = isObj(req) ? req : {}
  const out: WorktreeApplyRequest = {}
  const paths = r['paths']
  if (paths !== undefined) {
    need(
      Array.isArray(paths) && paths.length > 0 && paths.every(isRunRelativePath),
      "paths must be a list of the run's relative file paths",
    )
    out.paths = [...(paths as string[])]
  }
  const reviewedOnly = r['reviewedOnly']
  if (reviewedOnly !== undefined) {
    need(typeof reviewedOnly === 'boolean', 'reviewedOnly must be true or false')
    need(!(reviewedOnly === true && paths !== undefined), 'Send paths or reviewedOnly, not both')
    if (reviewedOnly === true) out.reviewedOnly = true
  }
  const res = r['resolutions']
  if (res !== undefined) {
    need(
      isObj(res) &&
        !Array.isArray(res) &&
        Object.entries(res).every(([k, v]) => isRunRelativePath(k) && (v === 'mine' || v === 'theirs')),
      "resolutions must map the run's relative file paths to mine or theirs",
    )
    out.resolutions = { ...(res as Record<string, WorktreeConflictChoice>) }
  }
  return out
}

export function worktreeHandlers(ctx: HandlerContext): HandlerMap {
  const host = (): WorktreeHost => {
    const h = ctx.worktree
    if (h === undefined) throw new DimFactoryError('UNSUPPORTED', 'Isolated runs are not available here.')
    return h
  }
  const writable = (): void => {
    if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
  }
  return {
    // A preview only reads (the worktree's shadow, the folder's files), so read-only cores answer it too.
    'worktree.preview': (req) => host().preview(runIdOf(req)),
    'worktree.apply': (req) => {
      const runId = runIdOf(req)
      const body = applyRequestOf(req)
      writable()
      return host().apply(runId, body)
    },
    'worktree.undoApply': (req) => {
      const runId = runIdOf(req)
      const token = undoTokenOf(req)
      writable()
      return host().undoApply(runId, token)
    },
    'worktree.discard': (req) => {
      const runId = runIdOf(req)
      writable()
      return host().discard(runId)
    },
    'worktree.undoDiscard': (req) => {
      const runId = runIdOf(req)
      const token = undoTokenOf(req)
      writable()
      return host().undoDiscard(runId, token)
    },
  }
}

/** Isolated-run commands (apply to the folder, its undo, discard and its undo, the preview). */
export const WORKTREE_COMMANDS = [
  'worktree.preview',
  'worktree.apply',
  'worktree.undoApply',
  'worktree.discard',
  'worktree.undoDiscard',
] as const satisfies readonly (keyof Commands)[]

// ---- the controller-backed host (app-core) ---------------------------------------------------------------------------

/** How long worktree.apply and worktree.undoApply wait for their result (the lease can queue behind a run). */
export const WORKTREE_WAIT_MS = 15 * 60_000

export const NONE_REVIEWED =
  'No file is marked reviewed yet. Mark files reviewed in the Diff tab, or apply all files.'

export interface WorktreeHostDeps {
  paths: HomePaths
  /** The run's controller, loading the run if needed (writable cores; FORBIDDEN otherwise). */
  controller(runId: string): Promise<RunController>
  /** run.json of a run (the live state preferred); null when there is no such run. */
  readDoc(runId: string): Promise<RunDoc | null>
  /** Default WORKTREE_WAIT_MS. */
  waitMs?: number
  platform?: NodeJS.Platform
}

const fin = (s: RunState): FinalizeRunState | undefined => s.isolation?.finalize

/** A git or file error as a Result code the renderer shows (DimFactoryErrors keep theirs). */
function asDimFactoryError(err: unknown, what: string): DimFactoryError {
  if (isDimFactoryError(err)) return err
  if (isGitError(err)) return new DimFactoryError(err.resultCode, `${what}: ${err.message}`)
  return new DimFactoryError('INTERNAL', `${what}: ${errorMessage(err)}`)
}

/** The finalize target of an isolated run's state (its worktree, the combined segment's ends in its shadow). */
export function finalizeTargetOf(home: string, s: RunState, platform?: NodeJS.Platform): FinalizeTarget {
  const wt = s.config.isolation === 'worktree' ? s.isolation?.worktree : undefined
  if (wt === undefined) throw new DimFactoryError('NOT_FOUND', 'This run has no isolated copy.')
  const ends = segmentEnds(s, 'combined')
  if (ends === undefined) throw new DimFactoryError('NOT_FOUND', missingSegmentText('combined'))
  return {
    home,
    runId: s.runId,
    folder: s.folder,
    worktree: { path: wt.path, branch: wt.branch, base: wt.base },
    from: ends.from.commit,
    to: ends.to.commit,
    ...(platform !== undefined ? { platform } : {}),
  }
}

/**
 * The files marked reviewed for this run (review-state.json): a mark in any segment counts when it names the blob the
 * combined segment applies. Both sides of a reviewed rename are included.
 */
export async function reviewedApplyPaths(paths: HomePaths, t: FinalizeTarget): Promise<string[]> {
  const key = (await resolveScope(t.worktree.path, t.platform).catch(() => null))?.folderKey
  const reader = key !== undefined ? await ShadowReader.open(paths.shadowRepo(key), t.worktree.path) : null
  if (reader === null) throw new DimFactoryError('NOT_FOUND', "This run's snapshots are gone.")
  const rows: FileChange[] = await reader.changes(t.from, t.to)
  const { state } = await readReviewState(paths.run(t.runId).reviewStateJson)
  const marked = new Set(DIFF_SEGMENTS.flatMap((seg) => reviewedPaths(state, seg, rows)))
  const out: string[] = []
  for (const r of rows) {
    if (!marked.has(r.path)) continue
    out.push(r.path)
    if (r.oldPath !== undefined) out.push(r.oldPath)
  }
  return out
}

/**
 * worktree.* through the run's controller: Apply and its Undo are user commands the reducer turns into a lease of the
 * folder and git/finalize's work; this waits for the run's record of the result (ApplyRecord by its number, or the
 * failure). Discard and its Undo answer at once (the deletion is the run's 10 s timer). The preview reads the
 * worktree's shadow and the folder directly.
 */
export function createWorktreeHost(d: WorktreeHostDeps): WorktreeHost {
  const waitMs = d.waitMs ?? WORKTREE_WAIT_MS
  const stateOf = async (runId: string): Promise<RunState> => {
    const doc = await d.readDoc(runId)
    if (doc === null) throw new DimFactoryError('NOT_FOUND', `Run ${runId} not found.`)
    return doc.state
  }
  const command = async (c: RunController, cmd: Parameters<RunController['command']>[0]): Promise<void> => {
    const r = await c.command(cmd)
    if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message, { details: r.error.details })
  }
  const wait = async (
    c: RunController,
    pred: (f: FinalizeRunState | undefined) => boolean,
  ): Promise<RunState> => {
    try {
      return await c.waitFor((s) => pred(fin(s)), waitMs)
    } catch {
      throw new DimFactoryError(
        'TIMEOUT',
        'Dim Factory is still waiting for the folder (another run is using it). The apply goes on in the run; its Flow tab shows when it is done.',
      )
    }
  }
  return {
    preview: async (runId) => {
      const s = await stateOf(runId)
      try {
        const t = finalizeTargetOf(d.paths.home, s, d.platform)
        // The reviewed files by the same rule as worktree.apply {reviewedOnly} (the panel counts and sends that).
        const [p, reviewed] = await Promise.all([
          previewApply(t),
          reviewedApplyPaths(d.paths, t).catch(() => undefined),
        ])
        return {
          files: p.files,
          conflicts: p.conflicts,
          actions: p.actions,
          ...(reviewed !== undefined ? { reviewed } : {}),
        }
      } catch (err) {
        throw asDimFactoryError(err, 'Dim Factory could not read what Apply would change')
      }
    },
    apply: async (runId, req) => {
      const c = await d.controller(runId)
      let paths = req.paths
      if (req.reviewedOnly === true) {
        const t = finalizeTargetOf(d.paths.home, c.state, d.platform)
        paths = await reviewedApplyPaths(d.paths, t).catch((err: unknown) => {
          throw asDimFactoryError(err, 'Dim Factory could not read the reviewed files')
        })
        if (paths.length === 0) throw new DimFactoryError('VALIDATION', NONE_REVIEWED)
      }
      await command(c, {
        kind: 'apply',
        ...(paths !== undefined ? { paths } : {}),
        ...(req.resolutions !== undefined ? { resolutions: req.resolutions } : {}),
      })
      const no = fin(c.state)?.applyNo ?? 0
      const s = await wait(
        c,
        (f) =>
          f === undefined ||
          f.applies.some((a) => a.no === no) ||
          f.failedNo === no ||
          !(f.op?.kind === 'apply' && f.op.no === no),
      )
      const f = fin(s)
      const rec = f?.applies.find((a) => a.no === no)
      if (rec !== undefined)
        return { applied: [...rec.applied], conflicts: [...rec.conflicts], undoToken: rec.token }
      throw new DimFactoryError('GIT', f?.error ?? 'The apply did not finish.')
    },
    undoApply: async (runId, undoToken) => {
      const c = await d.controller(runId)
      await command(c, { kind: 'undo-apply', token: undoToken })
      const s = await wait(c, (f) => f === undefined || !(f.op?.kind === 'undo' && f.op.token === undoToken))
      const f = fin(s)
      if (f?.applies.find((a) => a.token === undoToken)?.undone === true) return
      const message = f?.error ?? 'The undo did not finish.'
      throw new DimFactoryError(/refused/i.test(message) ? 'CONFLICT' : 'GIT', message)
    },
    discard: async (runId) => {
      const c = await d.controller(runId)
      await command(c, { kind: 'discard' })
      const dis = fin(c.state)?.discard
      if (dis === undefined) throw new DimFactoryError('INTERNAL', 'The discard did not start.')
      return { undoToken: dis.token, deleteAt: dis.deleteAt }
    },
    undoDiscard: async (runId, undoToken) => {
      const c = await d.controller(runId)
      await command(c, { kind: 'undo-discard', token: undoToken })
    },
  }
}
