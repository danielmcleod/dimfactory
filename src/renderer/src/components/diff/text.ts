// The Diff tab's words (UI copy standards: no em dash, an empty value gets a
// word). Everything here formats core's views (DiffFiles, FileChange, DiffBlob); nothing is worked out from the folder.
import { LARGE_DIFF_LINES } from '@shared/ipc.ts'
import type { DiffSegment, FileChange } from '@shared/ipc.ts'

export const SEGMENT_LABEL: Readonly<Record<DiffSegment, string>> = {
  implement: 'Implement',
  fix: 'Fix',
  'fix-round-1': 'Fix round 1',
  'fix-round-2': 'Fix round 2',
  'fix-round-3': 'Fix round 3',
  deploy: 'Deploy',
  combined: 'Combined',
}

/** What each segment covers, the segment button's tooltip. */
export const SEGMENT_HINT: Readonly<Record<DiffSegment, string>> = {
  implement: "Implement's changes (S0 to S1)",
  fix: "Fix's changes (F0 to S2), every round of Fix until green",
  'fix-round-1': 'What round 1 of Fix until green changed (its Fix start to its end)',
  'fix-round-2': 'What round 2 of Fix until green changed (its Fix start to its end)',
  'fix-round-3': 'What round 3 of Fix until green changed (its Fix start to its end)',
  deploy: "The Deploy step's config files (its start to its end)",
  combined: "The run's changes from before Implement to its last snapshot",
}

export type DiffLayout = 'split' | 'stacked'

export const LAYOUT_LABEL: Readonly<Record<DiffLayout, string>> = { split: 'Split', stacked: 'Stacked' }

export const STATUS_LABEL: Readonly<Record<FileChange['status'], string>> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  T: 'Type changed',
}

export const IGNORE_EOL_LABEL = 'Ignore line endings'
export const MARK_ALL_LABEL = 'Mark all reviewed'
export const ALL_REVIEWED = 'Every file is marked reviewed.'
export const REVIEWED_LABEL = 'Reviewed'
export const REVERT_FILE_LABEL = 'Revert'
export const EXPAND_LABEL = 'Expand'
export const COLLAPSE_LABEL = 'Collapse'
export const FILES_HEADING = 'Files'
export const SHOW_LIST_LABEL = 'Show the list'
export const HIDE_LIST_LABEL = 'Hide the list'
export const EDITED_AFTER_RUN = 'Edited after the run'
export const EDITED_AFTER_RUN_HINT =
  "The folder changed after the run wrote this file: what is shown is the run's version."
/** Live balanced run: an Implement file Fix changed later in the run (FileChange.changedByFix). */
export const CHANGED_BY_FIX = 'Changed by Fix'
export const CHANGED_BY_FIX_HINT =
  "Fix changed this file later in the run. This view shows Implement's version; Fix and Combined show the rest."
export const EOL_ONLY_TEXT = 'Only line endings changed'
export const LOADING_DIFF = 'Loading the diff…'
export const DIFF_CUT_SHORT = 'This diff is cut short: it is larger than Dim Factory shows.'
export const NO_TEXT_CHANGES = 'No line changes to show.'
export const DIFF_UNREADABLE = 'Dim Factory could not lay this diff out, so it is shown as text.'

/** The run changed its files since the list was shown; the newer list waits for the user (nothing moves on its own). */
export const NEWER_CHANGES_TEXT = 'The run has changed its files since this list was shown.'
export const SHOW_NEWER_LABEL = 'Show the latest changes'

/** History runs (persisted patches): why nothing can be reverted. */
export const READ_ONLY_REASON =
  "Shown from the saved patch: this run's snapshots were cleared, so its files cannot be reverted."

export const GITLINK_REVERT_REASON = 'Dim Factory does not revert submodules.'

/** Over this many files, the list above the diffs starts closed (it is in the page's flow, never its own scroller). */
export const LIST_OPEN_MAX = 40

export function lineCount(f: FileChange): number {
  return (f.added ?? 0) + (f.deleted ?? 0)
}

/** Core's `large` (more than 3000 changed lines: the file starts collapsed); its counts when an older core sends none. */
export function isLarge(f: FileChange): boolean {
  return f.large ?? lineCount(f) > LARGE_DIFF_LINES
}

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

export function filesText(n: number): string {
  return plural(n, 'file', 'files')
}

/** "4,210 changed lines: collapsed to keep the page quick." */
export function largeText(f: FileChange): string {
  return `${plural(lineCount(f), 'changed line', 'changed lines')}: collapsed to keep the page quick.`
}

/** "3 of 7 reviewed". */
export function reviewedCountText(reviewed: number, total: number): string {
  return `${reviewed} of ${total} reviewed`
}

/** "Marked 7 files reviewed". */
export function markedText(n: number): string {
  return `Marked ${filesText(n)} reviewed`
}

/** Size in KB with one decimal under 10 KB: "0.4 KB", "12 KB", "1,840 KB". */
export function kbText(bytes: number): string {
  const kb = bytes / 1024
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb).toLocaleString('en-US')} KB`
}

/** "Binary file, 12 KB" (a size core gave), or "Binary file". */
export function binaryText(bytes: number | null): string {
  return bytes === null ? 'Binary file' : `Binary file, ${kbText(bytes)}`
}

const ZERO_SHA = /^0+$/

function shortSha(sha: string): string | null {
  return sha === '' || ZERO_SHA.test(sha) ? null : sha.slice(0, 7)
}

/** A submodule's commit move: "Submodule: 1a2b3c4 to 5d6e7f8" (or added / removed). */
export function gitlinkText(f: FileChange): string {
  const from = shortSha(f.oldSha)
  const to = shortSha(f.newSha)
  if (from === null && to !== null) return `Submodule added at ${to}`
  if (to === null && from !== null) return `Submodule removed (was at ${from})`
  return `Submodule moved from ${from ?? 'none'} to ${to ?? 'none'}`
}

const ZERO_MODE = /^0+$/

/** Core's `modeChanged` (both sides exist, the mode moved); read from the modes when an older core sends none. */
export function modeChanged(f: FileChange): boolean {
  return (
    f.modeChanged ?? (f.oldMode !== f.newMode && !ZERO_MODE.test(f.oldMode) && !ZERO_MODE.test(f.newMode))
  )
}

/** "92% similar" for a rename core measured. */
export function similarityText(f: FileChange): string | null {
  return f.status === 'R' && f.similarity !== undefined ? `${f.similarity}% similar` : null
}

/** "Mode 100644 to 100755". */
export function modeText(f: FileChange): string {
  return `Mode ${f.oldMode} to ${f.newMode}`
}

/** A rename or mode change with no line changed: nothing for the diff view to show but the row. */
export function onlyMetadata(f: FileChange): boolean {
  return !f.binary && !f.gitlink && !f.eolOnly && f.added === 0 && f.deleted === 0
}

/** The words for a file with no line changes (a pure rename, a mode change, both). */
export function metadataText(f: FileChange): string {
  const parts: string[] = []
  if (f.status === 'R') parts.push(f.oldPath !== undefined ? `Renamed from ${f.oldPath}` : 'Renamed')
  if (modeChanged(f)) parts.push(`only the mode changed (${f.oldMode} to ${f.newMode})`)
  if (parts.length === 0) return NO_TEXT_CHANGES
  const text = parts.join(', ')
  const first = text.charAt(0).toUpperCase() + text.slice(1)
  return f.status === 'R' && !modeChanged(f) ? `${first}, no line changes` : first
}

/** "Reverted src/a.ts" / "Reverted 2 files" (a rename's two sides), with what core left alone. */
export function revertedFileText(path: string, changed: number, skipped: number): string {
  const head =
    changed === 0
      ? `Nothing to revert in ${path}`
      : changed === 1
        ? `Reverted ${path}`
        : `Reverted ${filesText(changed)}`
  return skipped > 0 ? `${head} · ${skipped} skipped` : head
}

export const APPLY_TITLE = 'Apply to folder…'
export const APPLY_ALL = 'All files'
export const APPLY_REVIEWED = 'Reviewed files only'
export const APPLY_HINT =
  'This run worked in its own copy of the folder. Apply brings its changes into your folder.'
