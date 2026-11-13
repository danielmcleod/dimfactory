// Diff and storage commands (the Diff tab and Settings → Diagnostics): `diff.blob`,
// `diff.markReviewed`, `storage.usage` and `storage.clearShadow`. A HandlerMap fragment createHandlers spreads in; the
// core's side comes through `ctx.diffView` and `ctx.storage` (app-core.ts), read when a command runs, so a context
// without them answers UNSUPPORTED.
import type { DiffBlob, DiffSegment, StorageUsage } from '../shared/ipc.ts'
import { DIFF_SEGMENTS } from '../shared/ipc.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'

/** The Diff tab's reads and marks beyond RunGitHost (run-diffs.ts). */
export interface DiffViewHost {
  blob(runId: string, seg: DiffSegment, side: 'old' | 'new', path: string): Promise<DiffBlob>
  markReviewed(runId: string, req: { seg?: DiffSegment; paths: string[]; reviewed: boolean }): Promise<void>
}

/** Settings → Diagnostics storage (store/storage.ts; clearing refuses while a run uses the folder). */
export interface StorageHost {
  usage(): Promise<StorageUsage>
  clearShadow(folderKey: string): Promise<StorageUsage>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function need(cond: unknown, message: string): void {
  if (!cond) throw new DimFactoryError('VALIDATION', message)
}

/** A scope-relative path as the diff lists it: not blank, not absolute (on any OS), no `..` segment. */
export function isRunRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.trim() === '' || p.includes('\0')) return false
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return false
  return !p.split(/[\\/]+/).some((seg) => seg === '..')
}

const isSegment = (v: unknown): v is DiffSegment =>
  typeof v === 'string' && (DIFF_SEGMENTS as readonly string[]).includes(v)

const FOLDER_KEY = /^[0-9a-f]{16}$/

export function diffSettingsHandlers(ctx: HandlerContext): HandlerMap {
  const writable = (): void => {
    if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
  }
  const diffView = (): DiffViewHost => {
    const h = ctx.diffView
    if (h === undefined) throw new DimFactoryError('UNSUPPORTED', 'The diff viewer is not available here.')
    return h
  }
  const storage = (): StorageHost => {
    const h = ctx.storage
    if (h === undefined) throw new DimFactoryError('UNSUPPORTED', 'Storage details are not available here.')
    return h
  }
  const runIdOf = (req: unknown): string => {
    const id = isObj(req) ? req['runId'] : undefined
    need(typeof id === 'string' && id !== '', 'runId is required')
    return id as string
  }
  return {
    'diff.blob': (req) => {
      const runId = runIdOf(req)
      need(isSegment(req.seg), 'seg must be implement, fix or combined')
      need(req.side === 'old' || req.side === 'new', 'side must be old or new')
      need(isRunRelativePath(req.path), "path must be one of the run's files")
      writable()
      return diffView().blob(runId, req.seg, req.side, req.path)
    },
    'diff.markReviewed': async (req) => {
      const runId = runIdOf(req)
      need(
        Array.isArray(req.paths) && req.paths.length > 0 && req.paths.every(isRunRelativePath),
        "paths must be a list of the run's relative file paths",
      )
      need(typeof req.reviewed === 'boolean', 'reviewed must be true or false')
      need(req.seg === undefined || isSegment(req.seg), 'seg must be implement, fix or combined')
      writable()
      await diffView().markReviewed(runId, {
        paths: [...new Set(req.paths)],
        reviewed: req.reviewed,
        ...(req.seg !== undefined ? { seg: req.seg } : {}),
      })
    },
    'storage.usage': () => storage().usage(),
    'storage.clearShadow': (req) => {
      need(
        isObj(req) && typeof req.folderKey === 'string' && FOLDER_KEY.test(req.folderKey),
        'folderKey is required',
      )
      writable()
      return storage().clearShadow(req.folderKey)
    },
  }
}
