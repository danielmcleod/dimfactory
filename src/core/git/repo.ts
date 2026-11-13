// Repository detection, scope roots, lock keys and folder keys.
// Every read of the user's repo uses `--no-optional-locks`, so Dim Factory never takes their index.lock.
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isDubiousOwnership, runGit, splitNul, tryGit } from './exec.ts'

export interface RepoInfo {
  /** The folder as given, made absolute. */
  folder: string
  /** realpath of `folder` (symlinks and 8.3 names resolved, true case on win32). */
  realFolder: string
  isRepo: boolean
  /** realpath of `rev-parse --show-toplevel` (repo only). */
  toplevel?: string
  /** `rev-parse --absolute-git-dir` (repo only; unknown when ownership was refused). */
  gitDir?: string
  /** `rev-parse --git-common-dir`, absolute (differs from gitDir in a linked worktree). */
  commonDir?: string
  /**
   * git refused the repository because another user owns it (CVE-2022-24765). `toplevel` then comes from walking
   * up to the nearest `.git`. The fix is `git config --global --add safe.directory "<path>"`.
   */
  dubiousOwnership: boolean
  /** git's first stderr line when detection failed for another reason (e.g. the folder is inside `.git`). */
  error?: string
}

export interface ScopeInfo {
  folder: string
  /** git toplevel for a repo, else the folder's realpath. Snapshots, diffs and the folder lock cover it. */
  scopeRoot: string
  isRepo: boolean
  repo: RepoInfo
  /** normalize(realpath(scopeRoot)), case-folded on case-insensitive volumes. */
  lockKey: string
  /** sha256(lockKey).slice(0,16) — shadow repo, trust grants and project backups use it. */
  folderKey: string
  /** The scope's volume folds case (drives the shadow's core.ignorecase). */
  caseInsensitive: boolean
}

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '') ?? ''

const errCode = (err: unknown): string | undefined =>
  err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined

/** Strip the win32 long-path prefixes `\\?\C:\…` and `\\?\UNC\server\share`. */
export function stripLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

async function realpathNative(p: string): Promise<string> {
  return stripLongPathPrefix(await realpath(p))
}

async function findDotGitUpwards(dir: string): Promise<string | null> {
  let cur = dir
  for (;;) {
    try {
      await lstat(path.join(cur, '.git'))
      return cur
    } catch {
      // keep walking
    }
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/**
 * Is `folder` inside a git work tree? One read-only call:
 * `git --no-optional-locks rev-parse --is-inside-work-tree --show-toplevel --absolute-git-dir --git-common-dir`.
 * Throws when the folder does not exist (ENOENT) or git itself is missing (GitError kind 'missing').
 */
export async function detectRepo(folder: string): Promise<RepoInfo> {
  const abs = path.resolve(folder)
  const realFolder = await realpathNative(abs)
  const base: RepoInfo = { folder: abs, realFolder, isRepo: false, dubiousOwnership: false }
  const r = await tryGit(
    ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    { cwd: realFolder, noOptionalLocks: true, timeoutMs: 15_000, category: 'git_state' },
  )
  if (!r.ok) {
    if (r.error.kind !== 'exit') throw r.error
    const stderr = r.error.stderr
    if (isDubiousOwnership(stderr)) {
      const top = await findDotGitUpwards(realFolder)
      if (top === null) return { ...base, dubiousOwnership: true, error: firstLine(stderr) }
      const info: RepoInfo = { ...base, isRepo: true, dubiousOwnership: true, toplevel: top }
      const dotGit = path.join(top, '.git')
      if (
        await stat(dotGit).then(
          (s) => s.isDirectory(),
          () => false,
        )
      ) {
        info.gitDir = dotGit
        info.commonDir = dotGit
      }
      return info
    }
    if (/not a git repository/i.test(stderr)) return base
    return { ...base, error: firstLine(stderr) }
  }
  const lines = r.result.stdout.split(/\r?\n/)
  if (lines[0]?.trim() !== 'true') return base
  const [, top = '', gitDir = '', commonDir = ''] = lines
  if (top.trim() === '') return { ...base, error: 'git reported no work tree top level' }
  const toplevel = await realpathNative(path.resolve(realFolder, top.trim()))
  const info: RepoInfo = { ...base, isRepo: true, toplevel }
  if (gitDir.trim() !== '') info.gitDir = path.resolve(realFolder, gitDir.trim())
  if (commonDir.trim() !== '') info.commonDir = path.resolve(realFolder, commonDir.trim())
  return info
}

// ---- case sensitivity, lock keys, folder keys --------------------------------------------------

const caseCache = new Map<string, boolean>()

/** Test hook: forget cached volume probes. */
export function resetCaseProbeCache(): void {
  caseCache.clear()
}

const swapAsciiCase = (s: string): string =>
  s.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))

/**
 * Does the volume holding `p` fold case? Probed once per volume (st_dev): stat the nearest path component that has
 * ASCII letters under its case-swapped name; the same file answering means case-insensitive. Falls back to the
 * platform default (win32/darwin insensitive, others sensitive) when no component can be probed.
 */
export async function probeCaseInsensitive(
  p: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const real = await realpathNative(path.resolve(p))
  const devKey = String((await stat(real, { bigint: true })).dev)
  const cached = caseCache.get(devKey)
  if (cached !== undefined) return cached
  let result: boolean | undefined
  let cur = real
  for (;;) {
    const name = path.basename(cur)
    if (/[A-Za-z]/.test(name)) {
      const flipped = path.join(path.dirname(cur), swapAsciiCase(name))
      try {
        const [a, b] = await Promise.all([stat(cur, { bigint: true }), stat(flipped, { bigint: true })])
        result = a.dev === b.dev && a.ino === b.ino
      } catch (err) {
        const code = errCode(err)
        if (code === 'ENOENT' || code === 'ENOTDIR') result = false
      }
      if (result !== undefined) break
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  const value = result ?? (platform === 'win32' || platform === 'darwin')
  caseCache.set(devKey, value)
  return value
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

/** Pure part of lockKey: strip `\\?\`, resolve, drop trailing separators (not the root), fold case if asked. */
export function normalizeLockPath(
  p: string,
  caseInsensitive: boolean,
  platform: NodeJS.Platform = process.platform,
): string {
  const P = pathFor(platform)
  let out = P.resolve(stripLongPathPrefix(p))
  const root = P.parse(out).root
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1)
  return caseInsensitive ? out.toLowerCase() : out
}

/** `lockKey = normalize(realpath(p))`, case folded per the volume's case-sensitivity probe. */
export async function lockKey(p: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const real = await realpathNative(path.resolve(p))
  return normalizeLockPath(real, await probeCaseInsensitive(real, platform), platform)
}

/** `folderKey = sha256(lockKey).slice(0,16)` (shadow repo, trust.json, project backups). */
export function folderKeyOf(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

/** Two lock keys conflict when one equals, contains or is contained by the other. */
export function lockKeysOverlap(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (a === b) return true
  const sep = pathFor(platform).sep
  const under = (child: string, parent: string): boolean =>
    child.startsWith(parent.endsWith(sep) || parent.endsWith('/') ? parent : parent + sep)
  return under(a, b) || under(b, a)
}

/** Detect the repo, pick the scope root (git toplevel, else the folder) and derive its keys. */
export async function resolveScope(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ScopeInfo> {
  const repo = await detectRepo(folder)
  const scopeRoot = repo.isRepo && repo.toplevel !== undefined ? repo.toplevel : repo.realFolder
  const caseInsensitive = await probeCaseInsensitive(scopeRoot, platform)
  const key = normalizeLockPath(scopeRoot, caseInsensitive, platform)
  return {
    folder: repo.folder,
    scopeRoot,
    isRepo: repo.isRepo,
    repo,
    lockKey: key,
    folderKey: folderKeyOf(key),
    caseInsensitive,
  }
}

// ---- reads the shadow setup needs from the user's repo ---------------------------------------------

/**
 * The user's `info/exclude` (via `rev-parse --git-path info/exclude`, resolved against the top level, so linked
 * worktrees read the common dir's file). Empty text when the repo has none or git refuses the repo.
 */
export async function readUserExclude(toplevel: string): Promise<{ path: string | null; text: string }> {
  const r = await tryGit(['rev-parse', '--git-path', 'info/exclude'], {
    cwd: toplevel,
    noOptionalLocks: true,
    timeoutMs: 15_000,
    category: 'git_state',
  })
  if (!r.ok) return { path: null, text: '' }
  const rel = firstLine(r.result.stdout)
  if (rel === '') return { path: null, text: '' }
  const file = path.resolve(toplevel, rel)
  const text = await readFile(file, 'utf8').catch(() => '')
  return { path: file, text }
}

/** Files the user tracks although they match ignore rules: `ls-files -z -c -i --exclude-standard`. */
export async function listTrackedIgnored(toplevel: string): Promise<string[]> {
  const r = await runGit(['ls-files', '-z', '-c', '-i', '--exclude-standard'], {
    cwd: toplevel,
    noOptionalLocks: true,
    maxBytes: 64 * 1024 * 1024,
    timeoutMs: 120_000,
    category: 'git_state',
  })
  return [...new Set(splitNul(r.stdout))]
}
