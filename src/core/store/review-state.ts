// The Diff tab's reviewed marks (file list with reviewed checkboxes; Accept is a UI-only mark in
// review-state.json): `runs/<id>/review-state.json` = {schemaVersion:1, reviewed:{[seg]:{[path]:
// blobSha}}}. A mark names the blob the user looked at, so a file whose content changed since (a later pass, a retry
// moving the segment's end) reads unreviewed again. Written atomically; writes for one run are serialized.
import type { DiffSegment, FileChange } from '../../shared/ipc.ts'
import { DIFF_SEGMENTS } from '../../shared/ipc.ts'
import { DimFactoryError } from '../errors.ts'
import { AsyncMutex } from '../git/mutex.ts'
import { sameBlobId } from '../git/diff-view.ts'
import { readJsonFile, writeJsonAtomic } from './atomic.ts'
import { isPlainObject } from './versions.ts'

export const REVIEW_STATE_SCHEMA = 1

export interface ReviewStateFile {
  schemaVersion: typeof REVIEW_STATE_SCHEMA
  reviewed: Partial<Record<DiffSegment, Record<string, string>>>
}

const empty = (): ReviewStateFile => ({ schemaVersion: REVIEW_STATE_SCHEMA, reviewed: {} })

/** The file as stored; missing or unreadable → no marks; `newer` when a later Dim Factory wrote it. */
export async function readReviewState(file: string): Promise<{ state: ReviewStateFile; newer: boolean }> {
  const r = await readJsonFile(file)
  if (r.kind !== 'ok' || !isPlainObject(r.value)) return { state: empty(), newer: false }
  const v = r.value
  const version = v['schemaVersion']
  if (typeof version === 'number' && version > REVIEW_STATE_SCHEMA) return { state: empty(), newer: true }
  const out = empty()
  const reviewed = v['reviewed']
  if (!isPlainObject(reviewed)) return { state: out, newer: false }
  for (const seg of DIFF_SEGMENTS) {
    const marks = reviewed[seg]
    if (!isPlainObject(marks)) continue
    const clean: Record<string, string> = {}
    for (const [p, sha] of Object.entries(marks)) if (typeof sha === 'string') clean[p] = sha
    out.reviewed[seg] = clean
  }
  return { state: out, newer: false }
}

/** The segment's paths whose mark still names the blob the row shows now. */
export function reviewedPaths(
  state: ReviewStateFile,
  seg: DiffSegment,
  rows: readonly FileChange[],
): string[] {
  const marks = state.reviewed[seg]
  if (marks === undefined) return []
  return rows
    .filter((r) => {
      const sha = marks[r.path]
      // A saved patch names no blob for a pure rename (no `index` line): a mark made on that row is kept as ''.
      return sha !== undefined && (sameBlobId(sha, r.newSha) || (sha === '' && r.newSha === ''))
    })
    .map((r) => r.path)
}

const locks = new Map<string, AsyncMutex>()

/**
 * Set (`reviewed`) or clear the marks of `marks` (path → the blob it shows) in `seg`, read-modify-write under a
 * per-file lock. NEWER_SCHEMA when a later Dim Factory wrote the file.
 */
export async function writeReviewMarks(
  file: string,
  seg: DiffSegment,
  marks: readonly { path: string; sha: string }[],
  reviewed: boolean,
): Promise<void> {
  let lock = locks.get(file)
  if (lock === undefined) {
    lock = new AsyncMutex()
    locks.set(file, lock)
  }
  const mine = lock
  try {
    await mine.run(async () => {
      const { state, newer } = await readReviewState(file)
      if (newer) {
        throw new DimFactoryError(
          'NEWER_SCHEMA',
          'A newer Dim Factory saved the reviewed marks of this run, so this one cannot change them.',
        )
      }
      const seg0 = { ...(state.reviewed[seg] ?? {}) }
      for (const m of marks) {
        if (reviewed) seg0[m.path] = m.sha
        else delete seg0[m.path]
      }
      state.reviewed[seg] = seg0
      await writeJsonAtomic(file, state)
    })
  } finally {
    if (!mine.busy && mine.waiting === 0 && locks.get(file) === mine) locks.delete(file)
  }
}
