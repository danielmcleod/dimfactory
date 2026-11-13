// Quick composer helpers: folder paths and chips, the per-folder task
// draft, the "folder busy" fallback that labels Run as a queue, the profile's pass line, and reading a
// PREFLIGHT_BLOCKED reply. Pure functions over core data and the user's input; no React here. The view helpers
// live in ./composer/model.ts.
// "Folder busy" is a label, not a decision: core's scheduler queues the run either way. The label is core's
// own answer (live preflight's `folder.lock`); `wouldQueue` stands in only until core answered for the folder, or
// when this core has no live preflight, reading core's facts: its folderKey and the statuses of the runs it reports.
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { Platform, ResultError } from '@shared/ipc.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { PassName, RunStatus, RunSummary } from '@shared/run.ts'
import { stepLabel, vendorName } from '../../lib/format.ts'
import { BRAND } from '@shared/brand.ts'

// ---- paths ------------------------------------------------------------------------------------------------------------

/** Forward slashes, no trailing separator (a drive root keeps its own), case-folded on Windows. */
export function normalizeFolder(path: string, platform: Platform): string {
  let p = path.trim().replace(/\\/g, '/')
  const unc = p.startsWith('//')
  p = p.replace(/\/{2,}/g, '/')
  if (unc) p = `/${p}`
  while (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1)
  return platform === 'win32' ? p.toLowerCase() : p
}

function within(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

/** The same folder, or one inside the other: a run in either would queue behind the other's lock. */
export function overlappingFolders(a: string, b: string, platform: Platform): boolean {
  const na = normalizeFolder(a, platform)
  const nb = normalizeFolder(b, platform)
  if (na === '' || nb === '') return false
  return within(na, nb) || within(nb, na)
}

/** One of `runFolders` is this folder, a parent or a child of it (the path half of wouldQueue). */
export function folderBusy(folder: string, runFolders: readonly string[], platform: Platform): boolean {
  if (folder.trim() === '') return false
  return runFolders.some((f) => overlappingFolders(f, folder, platform))
}

/**
 * Statuses of a run that holds its folder lock or is queued for it (core's scheduler: the lock is held while running,
 * waiting, paused or failed; queued runs are ahead in the folder's FIFO).
 */
const LOCKING: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'queued',
  'running',
  'waiting',
  'paused',
  'failed',
])

/** A failed run keeps its lock until it is closed, except after a failed preflight (R2b releases it). */
export function holdsFolderLock(s: Pick<RunSummary, 'status' | 'failure'>): boolean {
  return LOCKING.has(s.status) && !(s.status === 'failed' && s.failure?.step === 'preflight')
}

/**
 * A run started in `folder` would queue: a run holding (or queued for) a lock has core's folderKey of this folder (the
 * same scope root, e.g. two sub-folders of one repo), or its folder contains this one or lies inside it.
 */
export function wouldQueue(
  folder: string,
  folderKey: string | null,
  runs: readonly Pick<RunSummary, 'folder' | 'folderKey' | 'status' | 'failure'>[],
  platform: Platform,
): boolean {
  if (folder.trim() === '') return false
  const holders = runs.filter(holdsFolderLock)
  if (folderKey !== null && holders.some((r) => r.folderKey === folderKey)) return true
  return folderBusy(
    folder,
    holders.map((r) => r.folder),
    platform,
  )
}

export function folderBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '')
  return parts.at(-1) ?? path
}

export const RECENT_FOLDER_CHIPS = 6

/** Distinct folders of the given summaries (newest first in), most recent first, at most `max`. */
export function recentFolders(
  summaries: readonly RunSummary[],
  platform: Platform,
  max = RECENT_FOLDER_CHIPS,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of summaries) {
    const key = normalizeFolder(s.folder, platform)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(s.folder)
    if (out.length >= max) break
  }
  return out
}

/** A full path: `C:\…`, `\\server\share`, or `/…`. Core would resolve anything else against its own directory. */
export function isAbsoluteFolder(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim())
}

// ---- drafts (per folder, browser storage: a per-window convenience) -----------------------------------------------
// Browser storage belongs to the page's origin: app://dim-factory for the built renderer
// (file:// before), so drafts and the last folder kept under file:// were left behind once, when the renderer
// moved to app://. Nothing reads them back; a convenience may start empty.

export const DRAFT_PREFIX = `${BRAND.storagePrefix}draft.`
export const LAST_FOLDER_KEY = `${BRAND.storagePrefix}composer.folder`

export function draftKey(folder: string): string {
  return `${DRAFT_PREFIX}${folder.trim()}`
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    const s = storage()
    if (s === null) return
    if (value === null || value === '') s.removeItem(key)
    else s.setItem(key, value)
  } catch {
    // Storage full, blocked or unavailable: drafts are a convenience, never an error.
  }
}

export function loadDraft(folder: string): string | null {
  return folder.trim() === '' ? null : read(draftKey(folder))
}

/** An empty task removes the draft. Nothing is stored without a folder. */
export function saveDraft(folder: string, task: string): void {
  if (folder.trim() === '') return
  write(draftKey(folder), task.trim() === '' ? null : task)
}

export function loadLastFolder(): string {
  return read(LAST_FOLDER_KEY) ?? ''
}

export function saveLastFolder(folder: string): void {
  write(LAST_FOLDER_KEY, folder.trim())
}

// ---- profile line ---------------------------------------------------------------------------------------------------

const LINE_PASSES: readonly PassName[] = ['plan', 'implement', 'review', 'critic', 'security', 'fix']

/** `Plan · Claude · opus · Implement · Claude · default · …` over the enabled passes of a resolved config. */
export function passesLine(config: Pick<ResolvedConfig, 'passes'>): string {
  const passes = config.passes as Partial<ResolvedConfig['passes']>
  return LINE_PASSES.filter((p) => passes[p]?.enabled === true)
    .map((p) => {
      const pass = config.passes[p]
      return `${stepLabel(p)} · ${vendorName(pass.vendor)} · ${pass.model ?? 'default'}`
    })
    .join(' · ')
}

// ---- preflight -------------------------------------------------------------------------------------------------------

function isCheckResult(v: unknown): v is CheckResult {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return typeof c['id'] === 'string' && typeof c['title'] === 'string' && Array.isArray(c['recovery'])
}

/** The blocking checks of a PREFLIGHT_BLOCKED reply (`details` is core's PreflightReport); null for other errors. */
export function blockingChecks(error: ResultError): CheckResult[] | null {
  if (error.code !== 'PREFLIGHT_BLOCKED') return null
  const d = error.details as Partial<PreflightReport> | undefined
  const list = typeof d === 'object' && d !== null && Array.isArray(d.blocking) ? d.blocking : []
  return list.filter(isCheckResult)
}
