// "Where they differ": what each side of a match changed against the start, path by path, and one file of side A's
// result against side B's.
//
// Each side's snapshots are in its own copy's shadow repository, so the two results are in two object stores. The
// lists need no object from the other store: a file both sides changed ended the same when its new blob and mode are
// the same (blob ids name content). One file against the other reads side A's shadow with side B's objects as an
// alternate store for that one command; nothing is copied and nothing is written.
import { join } from 'node:path'
import type { DiffFilePatch, FileChange } from '../../shared/ipc.ts'
import type { MatchCompare, MatchCompareFile } from '../../shared/match.ts'
import { DIFF_FILE_MAX_BYTES, ShadowReader, isMissingObject } from '../git/diff-view.ts'

/** Where a side's result is: its shadow repository, the work tree its attributes come from, and its last snapshot. */
export interface SideResult {
  gitDir: string
  workTree?: string
  /** The commit of the side's last result snapshot (the end of its combined changes). */
  to: string
}

/** Merge the two sides' changed files by path (a rename counts under its new path), sorted by path. */
export function compareFiles(
  a: readonly FileChange[] | null,
  b: readonly FileChange[] | null,
  between: boolean,
): MatchCompare {
  const byPath = new Map<string, MatchCompareFile>()
  for (const f of a ?? []) byPath.set(f.path, { path: f.path, a: f })
  for (const f of b ?? []) {
    const row = byPath.get(f.path)
    if (row === undefined) byPath.set(f.path, { path: f.path, b: f })
    else {
      row.b = f
      const fa = row.a as FileChange
      row.same = fa.status === f.status && fa.newSha === f.newSha && fa.newMode === f.newMode
    }
  }
  const files = [...byPath.values()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  return { files, available: { a: a !== null, b: b !== null, between } }
}

/**
 * One file of side A's result against side B's (a patch the Diff viewer reads: the old side is A's, the new side is
 * B's). Null when either result's objects are gone.
 */
export async function betweenPatch(
  a: SideResult,
  b: SideResult,
  path: string,
  o: { ignoreEol?: boolean; maxBytes?: number } = {},
): Promise<DiffFilePatch | null> {
  const reader = await ShadowReader.open(a.gitDir, a.workTree)
  if (reader === null) return null
  const maxBytes = o.maxBytes ?? DIFF_FILE_MAX_BYTES
  try {
    const r = await reader.git(
      [
        'diff-tree',
        '-r',
        '-p',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        ...(o.ignoreEol === true ? ['--ignore-cr-at-eol'] : []),
        a.to,
        b.to,
        '--',
        path,
      ],
      {
        maxBytes,
        literalPathspecs: true,
        env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(b.gitDir, 'objects') },
      },
    )
    if (!r.truncated) return { patch: r.stdout, truncated: false }
    const nl = r.stdout.lastIndexOf('\n')
    return { patch: nl === -1 ? '' : r.stdout.slice(0, nl + 1), truncated: true }
  } catch (err) {
    if (isMissingObject(err)) return null
    throw err
  }
}

/** Both results can still be read (each shadow holds its last snapshot). */
export async function bothReadable(a: SideResult, b: SideResult): Promise<boolean> {
  for (const s of [a, b]) {
    const reader = await ShadowReader.open(s.gitDir, s.workTree)
    if (reader === null || !(await reader.has([s.to]).catch(() => false))) return false
  }
  return true
}
