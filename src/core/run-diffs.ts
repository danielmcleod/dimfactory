// A run's Diff tab data (IPC diff.files / diff.file / diff.blob /
// diff.markReviewed): a segment's rows, one file's patch and an image's bytes, read from the folder's shadow by the
// snapshots run.json names (diff-segments.ts). When those snapshots are gone (Clear snapshots, retention, a history
// run), the rows and patches come from the run's persisted `diffs/<a>..<b>.patch` (`persisted`), and reverting is
// unavailable with a reason. Reviewed marks live in `runs/<id>/review-state.json` (store/review-state.ts).
import { access, readFile } from 'node:fs/promises'
import type { DiffBlob, DiffFilePatch, DiffFiles, DiffSegment, FileChange } from '../shared/ipc.ts'
import { DIFF_BLOB_MAX_BYTES } from '../shared/ipc.ts'
import { DimFactoryError, errnoCode, errorMessage } from './errors.ts'
import {
  DIFF_FILE_MAX_BYTES,
  ShadowReader,
  imageMime,
  isMissingObject,
  markEditedAfterRun,
  withRowFacts,
} from './git/diff-view.ts'
import { parsePatchFiles, patchSectionFor, withoutCrOnlyHunks } from './git/patch.ts'
import type { HomePaths } from './home.ts'
import type { Logger } from './log.ts'
import { writeFileAtomic } from './store/atomic.ts'
import { readReviewState, reviewedPaths, writeReviewMarks } from './store/review-state.ts'
import { workScopeOf } from './supervisor/controller.ts'
import type { RunDoc } from './supervisor/controller.ts'
import { availableSegments, missingSegmentText, segmentEnds } from './supervisor/diff-segments.ts'
import type { SegmentEnds } from './supervisor/diff-segments.ts'

/** DiffFiles.revertUnavailable, and diff.revert's refusal, for a diff read from the saved patch. */
export const SNAPSHOTS_CLEARED_REVERT =
  "This run's snapshots were cleared, so its changes cannot be reverted. The diff shown is the copy saved with the run."
export const SNAPSHOTS_CLEARED_UNDO = "This run's snapshots were cleared, so this revert cannot be undone."
export const SNAPSHOTS_CLEARED_BLOB = "This run's snapshots were cleared, so its images cannot be previewed."

const SEGMENT_NAME: Readonly<Record<DiffSegment, string>> = {
  implement: 'Implement',
  fix: 'Fix',
  'fix-round-1': 'Fix round 1',
  'fix-round-2': 'Fix round 2',
  'fix-round-3': 'Fix round 3',
  deploy: 'Deploy',
  combined: 'combined',
}

/** The persisted patch names a segment may be saved under, best first (the controller's, then Clear snapshots'). */
export function persistedLabels(seg: DiffSegment, ends: SegmentEnds): string[] {
  switch (seg) {
    case 'implement':
      return ['S0..S1']
    case 'fix':
      return ['F0..S2']
    case 'fix-round-1':
    case 'fix-round-2':
    case 'fix-round-3':
      return [seg]
    case 'deploy':
      return ['deploy-start..deploy-end']
    case 'combined':
      return [...new Set([`S0..${ends.to.label}`, 'S0..S2', 'S0..S1'])]
  }
}

/** The name Clear snapshots saves a segment under when the run has no copy yet (exact for its ends). */
export function persistLabel(seg: DiffSegment, ends: SegmentEnds): string {
  return seg === 'implement'
    ? 'S0..S1'
    : seg === 'fix'
      ? 'F0..S2'
      : seg === 'deploy'
        ? 'deploy-start..deploy-end'
        : seg === 'combined'
          ? `S0..${ends.to.label}`
          : seg
}

export interface RunDiffDeps {
  paths: HomePaths
  /** run.json of a run (the live state when loaded); null when there is no such run. */
  readDoc(runId: string): Promise<RunDoc | null>
  log?: Logger
}

type SegmentView =
  | { kind: 'live'; doc: RunDoc; ends: SegmentEnds; reader: ShadowReader; rows: FileChange[] }
  | { kind: 'persisted'; doc: RunDoc; ends: SegmentEnds; patch: string; rows: FileChange[] }

export interface MarkReviewedRequest {
  seg?: DiffSegment
  paths: readonly string[]
  reviewed: boolean
}

export interface RunDiffs {
  files(runId: string, seg: DiffSegment): Promise<DiffFiles>
  file(runId: string, seg: DiffSegment, path: string, ignoreEol: boolean): Promise<DiffFilePatch>
  blob(runId: string, seg: DiffSegment, side: 'old' | 'new', path: string): Promise<DiffBlob>
  markReviewed(runId: string, req: MarkReviewedRequest): Promise<void>
  /**
   * diff.revert's check that the segment's snapshots are still in the shadow (NOT_FOUND with the reason otherwise).
   * A segment the run has not reached passes: the revert itself answers that.
   */
  assertRevertable(runId: string, seg: DiffSegment | undefined): Promise<void>
  /** diff.undoRevert's check that the folder's shadow still exists. */
  assertUndoable(runId: string): Promise<void>
  /**
   * Before a folder's shadow is cleared: save each listed run's segments that have no persisted patch yet, so its
   * diffs read the same afterwards. Each copy is written atomically (a partial file never counts as saved). Reports
   * how many were written and every run whose copy could not be made (a write that failed, or a patch past the output
   * cap), so the caller can refuse to clear.
   */
  persistRuns(runIds: readonly string[]): Promise<PersistResult>
}

export interface PersistResult {
  written: number
  /** Runs with a segment that could not be saved, and why (UI words). */
  failed: { runId: string; reason: string }[]
}

/** Why a copy could not be saved, in words: "the drive is full" for ENOSPC (and the like), else the error. */
export function persistFailureReason(err: unknown): string {
  const details = err instanceof DimFactoryError ? err.details : undefined
  const category =
    details !== null && typeof details === 'object' && 'category' in details ? details.category : undefined
  const errno = errnoCode(err)
  if (category === 'disk_full' || errno === 'ENOSPC' || errno === 'EDQUOT') return 'the drive is full'
  return errorMessage(err)
}

/**
 * Clear snapshots' refusal when some runs' diffs could not be saved first: nothing is cleared, so those diffs are not
 * lost. `label` names a run ("Run #12").
 */
export function persistFailedText(failed: readonly { label: string; reason: string }[]): string {
  const [first] = failed
  if (first === undefined) return ''
  if (failed.length === 1) {
    return `Nothing was cleared: Dim Factory could not save a copy of the changes of ${first.label} first (${first.reason}). Its diff would be lost. Try again once that is fixed.`
  }
  const reasons = [...new Set(failed.map((f) => f.reason))]
  return `Nothing was cleared: Dim Factory could not save a copy of the changes of ${failed.length} runs first (${failed
    .map((f) => f.label)
    .join(', ')}: ${reasons.join('; ')}). Their diffs would be lost. Try again once that is fixed.`
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  )

function gitReadError(err: unknown): DimFactoryError {
  if (err instanceof DimFactoryError) return err
  return new DimFactoryError('GIT', `Dim Factory could not read this run's changes: ${errorMessage(err)}`)
}

const findRow = (rows: readonly FileChange[], rel: string): FileChange | undefined =>
  rows.find((c) => c.path === rel) ?? rows.find((c) => c.oldPath === rel)

const notInSegment = (rel: string): DimFactoryError =>
  new DimFactoryError('NOT_FOUND', `${rel} did not change in this part of the run.`)

/** Cut a patch at `max` bytes on a line end. */
function capPatch(text: string, max: number): DiffFilePatch {
  if (Buffer.byteLength(text, 'utf8') <= max) return { patch: text, truncated: false }
  const cut = Buffer.from(text, 'utf8').subarray(0, max).toString('utf8')
  const nl = cut.lastIndexOf('\n')
  return { patch: nl === -1 ? '' : cut.slice(0, nl + 1), truncated: true }
}

const megabytes = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`
/** ShadowReader.patch's output cap: a segment's patch this large is cut short, so no whole copy can be saved. */
const BIG_PATCH_BYTES = 256 * 1024 * 1024

export function createRunDiffs(d: RunDiffDeps): RunDiffs {
  const docOf = async (runId: string): Promise<RunDoc> => {
    const doc = await d.readDoc(runId)
    if (doc === null) throw new DimFactoryError('NOT_FOUND', `Run ${runId} not found.`)
    return doc
  }
  const endsOf = (doc: RunDoc, seg: DiffSegment): SegmentEnds => {
    const ends = segmentEnds(doc.state, seg)
    if (ends === undefined) throw new DimFactoryError('NOT_FOUND', missingSegmentText(seg))
    return ends
  }
  // The project folder as the work tree: its .gitattributes count, as they did for the controller's saved patches.
  const readerOf = (doc: RunDoc): Promise<ShadowReader | null> =>
    ShadowReader.open(d.paths.shadowRepo(workScopeOf(doc).folderKey), workScopeOf(doc).scopeRoot)

  const persistedPatch = async (doc: RunDoc, seg: DiffSegment, ends: SegmentEnds): Promise<string | null> => {
    const run = d.paths.run(doc.runId)
    for (const label of persistedLabels(seg, ends)) {
      try {
        return await readFile(run.diffPatch(label), 'utf8')
      } catch {
        // the next name
      }
    }
    return null
  }

  const view = async (runId: string, seg: DiffSegment): Promise<SegmentView> => {
    const doc = await docOf(runId)
    const ends = endsOf(doc, seg)
    const reader = await readerOf(doc)
    if (reader !== null) {
      try {
        const rows = await reader.changes(ends.from.commit, ends.to.commit)
        return { kind: 'live', doc, ends, reader, rows }
      } catch (err) {
        if (!isMissingObject(err)) throw gitReadError(err)
      }
    }
    const patch = await persistedPatch(doc, seg, ends)
    if (patch === null) {
      throw new DimFactoryError(
        'NOT_FOUND',
        `This run's snapshots were cleared and no copy of its ${SEGMENT_NAME[seg]} changes was saved, so they cannot be shown.`,
      )
    }
    const rows = parsePatchFiles(patch).map((r) => withRowFacts(r, r.similarity))
    return { kind: 'persisted', doc, ends, patch, rows }
  }

  const available = async (v: SegmentView): Promise<DiffSegment[]> => {
    const all = availableSegments(v.doc.state)
    if (v.kind === 'live') return all
    const run = d.paths.run(v.doc.runId)
    const out: DiffSegment[] = []
    for (const seg of all) {
      const ends = segmentEnds(v.doc.state, seg)
      if (ends === undefined) continue
      for (const label of persistedLabels(seg, ends)) {
        if (await exists(run.diffPatch(label))) {
          out.push(seg)
          break
        }
      }
    }
    return out
  }

  /**
   * Live balanced run: the folder holds Fix's version of a file Implement wrote, so the Implement segment read
   * every such file "Edited after the run". Those rows are marked `changedByFix` instead: the file is not in Implement's
   * state because Fix changed it later in the run, and the folder still holds what Fix left (S2's side of F0..S2).
   * A file the folder no longer holds in that state either keeps `editedAfterRun`. Only the Implement segment of a
   * run whose Fix segment exists, read from the snapshots (a saved patch names no Fix blobs to compare with).
   */
  const markChangedByFix = async (v: SegmentView, rows: FileChange[]): Promise<FileChange[]> => {
    if (v.kind !== 'live' || !rows.some((r) => r.editedAfterRun === true)) return rows
    const fix = segmentEnds(v.doc.state, 'fix')
    if (fix === undefined || fix.to.at < v.ends.to.at) return rows
    let later: FileChange[]
    try {
      later = await v.reader.changes(fix.from.commit, fix.to.commit)
    } catch {
      return rows
    }
    // What Fix left at each path it touched: its new side, or gone (a deletion, or a rename's old path).
    const fixSide = new Map<string, FileChange>()
    for (const f of later) {
      fixSide.set(f.path, f)
      if (f.oldPath !== undefined) fixSide.set(f.oldPath, { ...f, path: f.oldPath, status: 'D', newSha: '' })
    }
    // The row as Fix left it takes Fix's side whole, its status included: a file Implement deleted and Fix wrote again
    // is there now (Fix's status, Fix's blob), not gone (Implement's 'D' would read any file there as a later edit).
    const asFixLeftIt = rows.flatMap((r) => {
      const f = r.editedAfterRun === true ? fixSide.get(r.path) : undefined
      if (f === undefined) return []
      const gone = f.status === 'D'
      return [{ ...r, status: f.status, newSha: gone ? '0'.repeat(40) : f.newSha }]
    })
    if (asFixLeftIt.length === 0) return rows
    const checked = await markEditedAfterRun(workScopeOf(v.doc).scopeRoot, asFixLeftIt)
    const holdsFix = new Set(checked.filter((r) => r.editedAfterRun === false).map((r) => r.path))
    return rows.map((r) => (holdsFix.has(r.path) ? { ...r, editedAfterRun: false, changedByFix: true } : r))
  }

  return {
    files: async (runId, seg) => {
      const v = await view(runId, seg)
      const [marked, review, segs] = await Promise.all([
        markEditedAfterRun(workScopeOf(v.doc).scopeRoot, v.rows),
        readReviewState(d.paths.run(runId).reviewStateJson),
        available(v),
      ])
      const rows = seg === 'implement' ? await markChangedByFix(v, marked) : marked
      return {
        seg,
        files: rows,
        reviewed: reviewedPaths(review.state, seg, rows),
        available: segs,
        persisted: v.kind === 'persisted',
        ...(v.kind === 'persisted' ? { revertUnavailable: SNAPSHOTS_CLEARED_REVERT } : {}),
      }
    },

    file: async (runId, seg, rel, ignoreEol) => {
      const v = await view(runId, seg)
      const change = findRow(v.rows, rel)
      if (change === undefined) throw notInSegment(rel)
      let patch = v.kind === 'persisted' ? v.patch : null
      if (v.kind === 'live') {
        try {
          return await v.reader.filePatch(v.ends.from.commit, v.ends.to.commit, change, { ignoreEol })
        } catch (err) {
          // The rows were cached before the snapshots went (retention): the saved copy, when there is one.
          if (!isMissingObject(err)) throw gitReadError(err)
          patch = await persistedPatch(v.doc, seg, v.ends)
          if (patch === null) throw gitReadError(err)
        }
      }
      const section = patchSectionFor(patch ?? '', change)?.text ?? ''
      return capPatch(ignoreEol ? withoutCrOnlyHunks(section) : section, DIFF_FILE_MAX_BYTES)
    },

    blob: async (runId, seg, side, rel) => {
      const v = await view(runId, seg)
      if (v.kind === 'persisted') throw new DimFactoryError('UNSUPPORTED', SNAPSHOTS_CLEARED_BLOB)
      // Only a path this segment lists, on the side asked for: never a path the request made up.
      const change = v.rows.find((c) => (side === 'new' ? c.path : (c.oldPath ?? c.path)) === rel)
      if (change === undefined) throw notInSegment(rel)
      if (change.gitlink) {
        throw new DimFactoryError('UNSUPPORTED', `${rel} is a nested repository, not a file to preview.`)
      }
      const sha = side === 'old' ? change.oldSha : change.newSha
      if (/^0+$/.test(sha)) {
        throw new DimFactoryError(
          'NOT_FOUND',
          side === 'old'
            ? `${rel} did not exist before this part of the run.`
            : `${rel} was deleted in this part of the run.`,
        )
      }
      try {
        const bytes = await v.reader.blobSize(sha)
        if (bytes > DIFF_BLOB_MAX_BYTES) {
          throw new DimFactoryError(
            'UNSUPPORTED',
            `${rel} is ${megabytes(bytes)}. Images over 2 MB are not previewed.`,
            { details: { bytes } },
          )
        }
        const data = await v.reader.blob(sha)
        const mime = imageMime(data)
        return mime === null
          ? { base64: '', bytes, mime: null }
          : { base64: data.toString('base64'), bytes, mime }
      } catch (err) {
        throw gitReadError(err)
      }
    },

    markReviewed: async (runId, req) => {
      const doc = await docOf(runId)
      const segs = req.seg !== undefined ? [req.seg] : availableSegments(doc.state)
      const found = new Set<string>()
      const writes: { seg: DiffSegment; marks: { path: string; sha: string }[] }[] = []
      for (const seg of segs) {
        let v: SegmentView
        try {
          v = await view(runId, seg)
        } catch (err) {
          if (req.seg === undefined && err instanceof DimFactoryError && err.code === 'NOT_FOUND') continue
          throw err
        }
        const marks: { path: string; sha: string }[] = []
        for (const p of req.paths) {
          const row = findRow(v.rows, p)
          if (row === undefined) continue
          found.add(p)
          marks.push({ path: row.path, sha: row.newSha })
        }
        if (marks.length > 0) writes.push({ seg, marks })
      }
      const missing = req.paths.filter((p) => !found.has(p))
      if (missing.length > 0) {
        const more = missing.length > 5 ? ` and ${missing.length - 5} more` : ''
        throw new DimFactoryError(
          'NOT_FOUND',
          `${missing.slice(0, 5).join(', ')}${more} did not change in this part of the run.`,
        )
      }
      const file = d.paths.run(runId).reviewStateJson
      for (const w of writes) await writeReviewMarks(file, w.seg, w.marks, req.reviewed)
    },

    assertRevertable: async (runId, seg) => {
      const doc = await docOf(runId)
      const ends = segmentEnds(doc.state, seg ?? 'combined')
      if (ends === undefined) return
      const reader = await readerOf(doc)
      let present = false
      try {
        present = reader !== null && (await reader.has([ends.from.commit, ends.to.commit]))
      } catch (err) {
        if (!isMissingObject(err)) throw gitReadError(err)
      }
      if (!present) throw new DimFactoryError('NOT_FOUND', SNAPSHOTS_CLEARED_REVERT)
    },

    assertUndoable: async (runId) => {
      const doc = await docOf(runId)
      if ((await readerOf(doc)) === null) throw new DimFactoryError('NOT_FOUND', SNAPSHOTS_CLEARED_UNDO)
    },

    persistRuns: async (runIds) => {
      const out: PersistResult = { written: 0, failed: [] }
      /** Save the run's segments that have no copy yet; the reason one could not be saved, else null. */
      const persistRun = async (runId: string): Promise<string | null> => {
        const doc = await d.readDoc(runId)
        if (doc === null) return null
        const reader = await readerOf(doc)
        if (reader === null) return null
        const run = d.paths.run(runId)
        for (const seg of availableSegments(doc.state)) {
          const ends = segmentEnds(doc.state, seg)
          if (ends === undefined) continue
          // Only an exact copy counts (the combined segment's fallbacks, S0..S2 and S0..S1, may end elsewhere).
          const file = run.diffPatch(persistLabel(seg, ends))
          if (await exists(file)) continue
          let patch: { text: string; truncated: boolean }
          try {
            patch = await reader.patch(ends.from.commit, ends.to.commit)
          } catch (err) {
            // Already gone from the shadow (retention): clearing it loses nothing more.
            if (isMissingObject(err)) continue
            throw err
          }
          if (patch.truncated) {
            return `its ${SEGMENT_NAME[seg]} changes are over ${megabytes(BIG_PATCH_BYTES)}, too large to save`
          }
          await writeFileAtomic(file, patch.text, { mode: 0o600, dirMode: 0o700 })
          out.written++
        }
        return null
      }
      for (const runId of runIds) {
        let reason: string | null
        try {
          reason = await persistRun(runId)
        } catch (err) {
          d.log?.warn('could not save a run diff before clearing snapshots', {
            runId,
            err: errorMessage(err),
          })
          reason = persistFailureReason(err)
        }
        if (reason !== null) out.failed.push({ runId, reason })
      }
      return out
    },
  }
}
