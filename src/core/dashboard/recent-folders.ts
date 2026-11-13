// `folders.recent` (the composer's folder chips plus Choose folder…, the palette's Folders): the
// distinct folders of recent runs, most recent run first, at most 20. Facts are cheap file-system lookups, never a
// git spawn: `exists` is a directory stat, and a folder is a git work tree when it or an ancestor holds a `.git`
// entry (a directory, or a file for worktrees and submodules) — git's own discovery, without GIT_DIR or ceiling
// directories. `scopeRoot` is that ancestor (the snapshot scope Dim Factory would use), null outside git.
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { RecentFolder } from '../../shared/ipc.ts'
import type { RunSummary } from '../../shared/run.ts'

export const RECENT_FOLDERS_LIMIT = 20

export interface FolderFacts {
  exists: boolean
  isGit: boolean
  scopeRoot: string | null
}

export type FolderFactsLookup = (folder: string) => Promise<FolderFacts>

/** Comparable folder key: absolute, no trailing separator, case-folded where the file system usually is. */
export function folderIdentity(folder: string, platform: NodeJS.Platform = process.platform): string {
  const r = resolve(folder).replace(/[\\/]+$/, '')
  const key = r === '' ? folder : r
  return platform === 'win32' || platform === 'darwin' ? key.toLowerCase() : key
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** The directory facts of one folder (see the header). */
export async function folderFacts(folder: string): Promise<FolderFacts> {
  const abs = resolve(folder)
  if (!(await isDir(abs))) return { exists: false, isGit: false, scopeRoot: null }
  let dir = abs
  for (;;) {
    if (await exists(join(dir, '.git'))) return { exists: true, isGit: true, scopeRoot: dir }
    const up = dirname(dir)
    if (up === dir) return { exists: true, isGit: false, scopeRoot: null }
    dir = up
  }
}

/** Distinct run folders, most recent run first (createdAt, then displayNo), with their facts. */
export async function recentFolders(
  summaries: readonly RunSummary[],
  facts: FolderFactsLookup = folderFacts,
  limit = RECENT_FOLDERS_LIMIT,
): Promise<RecentFolder[]> {
  const ordered = [...summaries].sort((a, b) => b.createdAt - a.createdAt || b.displayNo - a.displayNo)
  const seen = new Set<string>()
  const picked: { folder: string; lastRunAt: number }[] = []
  for (const s of ordered) {
    const key = folderIdentity(s.folder)
    if (seen.has(key)) continue
    seen.add(key)
    picked.push({ folder: s.folder, lastRunAt: s.createdAt })
    if (picked.length >= limit) break
  }
  return Promise.all(
    picked.map(async (p) => {
      const f = await facts(p.folder).catch(() => ({ exists: false, isGit: false, scopeRoot: null }))
      return {
        folder: p.folder,
        scopeRoot: f.scopeRoot,
        lastRunAt: p.lastRunAt,
        isGit: f.isGit,
        exists: f.exists,
      }
    }),
  )
}
