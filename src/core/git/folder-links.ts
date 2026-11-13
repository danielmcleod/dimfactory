// Links to folders inside a snapshot's scope: Windows
// directory junctions and symbolic links to folders. Git for Windows reads a junction as a folder, so `add -A` took its
// target's files in as the project's; a link to a folder is otherwise stored as its target text. The shadow leaves
// both out of every snapshot. This module only reads: links are never followed into.
import { lstat, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Folder names the walk does not read: generated dependency and cache folders, which are huge and practically always
 * ignored (pnpm fills node_modules with junctions). A link the shadow index still reaches inside one is found after
 * `add -A` instead (Shadow's second pass), so leaving them out of the walk only costs time, never correctness.
 */
export const LINK_WALK_PRUNE: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
])
/** The walk stops reading folders past this many (the second pass still drops what `add -A` reached). */
export const LINK_WALK_MAX_DIRS = 200_000
const WALK_CONCURRENCY = 32

export interface FolderLinkScan {
  /** Scope-relative, `/`-separated links to folders, sorted; a link inside another link is never listed. */
  links: string[]
  /** Real folders the walk read ('' is the scope root): a link directly inside one of them would be in `links`. */
  visited: Set<string>
  /** Nested repositories the walk found (folders holding `.git`, left unread): scope-relative, `/`-separated, sorted. */
  repos: string[]
  /** Folders left unread (pruned names, nested repositories, DIM_FACTORY_HOME, the cap). */
  partial: boolean
  ms: number
}

export interface ScanFolderLinksOptions {
  /** Scope-relative folders not to read (DIM_FACTORY_HOME inside the scope). */
  skip?: readonly string[]
  prune?: ReadonlySet<string>
  maxDirs?: number
}

const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)
const abs = (root: string, rel: string): string => (rel === '' ? root : path.join(root, ...rel.split('/')))

/** `p` is a link (a junction, or a symbolic link) whose target is a folder. Never throws. */
export async function isFolderLink(p: string): Promise<boolean> {
  try {
    if (!(await lstat(p)).isSymbolicLink()) return false
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** `rel` is one of `links` or inside one (`fold`: compare case-insensitively). */
export function underLink(rel: string, links: readonly string[], fold = false): boolean {
  const r = fold ? rel.toLowerCase() : rel
  return links.some((l) => {
    const k = fold ? l.toLowerCase() : l
    return r === k || r.startsWith(`${k}/`)
  })
}

/** Sorted, unique, and without a link that lies inside another one. */
export function outermostLinks(links: readonly string[], fold = false): string[] {
  const sorted = [...new Set(links)].sort()
  const out: string[] = []
  for (const l of sorted) if (!underLink(l, out, fold)) out.push(l)
  return out
}

/**
 * The links to folders inside `root`, breadth first: `.git` entries are skipped, a nested repository (a folder holding
 * `.git`) is not read (git does not look inside one either), links are recorded and never entered, and the pruned
 * folder names and `skip` are left unread. A dangling link is not a link to a folder.
 */
export async function scanFolderLinks(root: string, o: ScanFolderLinksOptions = {}): Promise<FolderLinkScan> {
  const t0 = Date.now()
  const prune = o.prune ?? LINK_WALK_PRUNE
  const skip = new Set(o.skip ?? [])
  const maxDirs = o.maxDirs ?? LINK_WALK_MAX_DIRS
  const visited = new Set<string>()
  const links: string[] = []
  const repos: string[] = []
  let partial = false
  let level = ['']
  /** A folder to read next, unless its name is pruned or it is skipped. */
  const enter = (rel: string, name: string, into: string[]): void => {
    if (skip.has(rel) || prune.has(name)) partial = true
    else into.push(rel)
  }
  while (level.length > 0) {
    if (visited.size + level.length > maxDirs) {
      partial = true
      level = level.slice(0, Math.max(0, maxDirs - visited.size))
    }
    const next: string[] = []
    // Entries the listing calls links: on Windows that is any reparse point, so each is asked again with lstat (a
    // cloud placeholder folder is a folder to read; a junction or symbolic link is a link).
    const reparse: { rel: string; name: string }[] = []
    let i = 0
    const read = async (): Promise<void> => {
      for (let k = i++; k < level.length; k = i++) {
        const dir = level[k] ?? ''
        const entries = await readdir(abs(root, dir), { withFileTypes: true }).catch(() => null)
        if (entries === null) continue
        if (dir !== '' && entries.some((e) => e.name === '.git')) {
          partial = true
          repos.push(dir)
          continue
        }
        visited.add(dir)
        for (const e of entries) {
          if (e.name === '.git') continue
          const rel = join(dir, e.name)
          if (e.isSymbolicLink()) reparse.push({ rel, name: e.name })
          else if (e.isDirectory()) enter(rel, e.name, next)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, level.length) }, read))
    let j = 0
    const judge = async (): Promise<void> => {
      for (let k = j++; k < reparse.length; k = j++) {
        const { rel, name } = reparse[k] ?? { rel: '', name: '' }
        const p = abs(root, rel)
        const l = await lstat(p).catch(() => null)
        if (l === null) continue
        if (l.isSymbolicLink()) {
          if (await isFolderLink(p)) links.push(rel)
        } else if (l.isDirectory()) enter(rel, name, next)
      }
    }
    await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, reparse.length) }, judge))
    level = next.sort()
    if (partial && visited.size >= maxDirs) break
  }
  return { links: outermostLinks(links), visited, repos: repos.sort(), partial, ms: Date.now() - t0 }
}

/** `rel`'s folder was read by the walk, so the walk's verdict on `rel` (a link or not) stands. */
export function walkCovers(scan: Pick<FolderLinkScan, 'visited'>, rel: string): boolean {
  const slash = rel.lastIndexOf('/')
  return scan.visited.has(slash === -1 ? '' : rel.slice(0, slash))
}

/**
 * A run note naming the links Dim Factory left out of its snapshots (UI copy; core's run notes reach the Run view).
 * Undefined when there are none.
 */
export function linksLeftOutNote(links: readonly string[]): string | undefined {
  if (links.length === 0) return undefined
  const shown = links.slice(0, 5)
  const more = links.length - shown.length
  const names =
    more > 0
      ? `${shown.join(', ')} and ${more} more`
      : shown.length === 1
        ? (shown[0] ?? '')
        : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`
  const one = links.length === 1
  return (
    `${names} ${one ? 'is a link' : 'are links'} to ${one ? 'another folder' : 'other folders'}, so Dim Factory leaves ` +
    `${one ? 'it' : 'them'} out of its snapshots: changes there do not show in diffs, and Dim Factory never reverts or ` +
    'applies them.'
  )
}
