// Copy-ins for an isolated run (Prepare step 2): the
// `isolation.worktree.copy` globs bring files a fresh worktree lacks (`.env`, local certificates, a dev database) from
// the user's folder into the run's copy. Only ignored or untracked files are copied: never a tracked file (the worktree
// has HEAD's version; copying the folder's would mirror uncommitted changes, which isolated runs leave out), never
// anything under `.git`, never through a symbolic link or a Windows junction (on either side), never outside the
// folder, and never over a file the run's copy already has. Globs are relative to the run folder (`/` separators;
// `\` too on Windows): `*`, `?`, `[abc]`, `{a,b}`, `**` for any number of folders; a plain path names a file or a
// whole folder.
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runGit, splitNul } from '../git/exec.ts'
import { cwdRelOf } from '../verify/discover.ts'

/** At most this many files are copied (a glob that reaches into node_modules is a mistake, not a copy-in). */
export const COPY_IN_MAX_FILES = 10_000
/** At most this many bytes in all. */
export const COPY_IN_MAX_BYTES = 1024 * 1024 * 1024
/** At most this many folder entries are looked at, over all globs. */
export const COPY_IN_MAX_VISITED = 200_000

export interface CopyInSkip {
  /** Relative to the run folder, `/` separators. */
  path: string
  /** UI copy. */
  reason: string
}

export interface CopyInResult {
  /** Copied files, relative to the run folder (`/` separators), in the order they were copied. */
  copied: string[]
  /** Matched but not copied, with why (tracked, a link, already in the run's copy…), and plain paths not found. */
  skipped: CopyInSkip[]
  /** Globs refused as written (absolute, `..`, `.git`), with why. */
  refused: { glob: string; reason: string }[]
  bytes: number
  /** A limit (files, bytes, entries looked at) stopped the copy early; `skipped` says which. */
  truncated?: boolean
}

/** What git tracks under the folder (paths relative to it), and the nested repositories (gitlinks) among them. */
export interface TrackedFiles {
  files: ReadonlySet<string>
  gitlinks: readonly string[]
}

export interface CopyInOptions {
  /** Default: `git ls-files -z -s` in the folder (--no-optional-locks). null: unknown, so nothing is copied. */
  tracked?: (folder: string) => Promise<TrackedFiles | null>
  maxFiles?: number
  maxBytes?: number
  maxVisited?: number
  platform?: NodeJS.Platform
  /** Each copied file, as it is copied (the PrepareCard's stream). */
  onCopied?: (rel: string) => void
}

// ---- globs -------------------------------------------------------------------------------------------------------

type Seg = { globstar: true } | { globstar: false; re: RegExp; literal: string | null }

const MAX_BRACE_EXPANSIONS = 64

/** `{a,b}` alternatives expanded (not nested within one another; at most 64 patterns). */
export function expandBraces(glob: string): string[] {
  const out: string[] = []
  const queue = [glob]
  while (queue.length > 0 && out.length + queue.length <= MAX_BRACE_EXPANSIONS) {
    const g = queue.shift() ?? ''
    const m = /\{([^{}]*,[^{}]*)\}/.exec(g)
    if (m === null) {
      out.push(g)
      continue
    }
    for (const alt of (m[1] ?? '').split(','))
      queue.push(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length))
  }
  return [...out, ...queue]
}

const hasWildcard = (s: string): boolean => /[*?[]/.test(s)

function segmentRegExp(seg: string, nocase: boolean): RegExp {
  let re = ''
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] ?? ''
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const close = seg.indexOf(']', i + 2)
      if (close === -1) {
        re += '\\['
        continue
      }
      let body = seg.slice(i + 1, close)
      const negate = body.startsWith('!') || body.startsWith('^')
      if (negate) body = body.slice(1)
      re += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
      i = close
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, nocase ? 'i' : '')
}

/** Why a glob is refused as written, or null. */
function refusal(glob: string, platform: NodeJS.Platform): string | null {
  const g = platform === 'win32' ? glob.replace(/\\/g, '/') : glob
  if (g.trim() === '') return 'It is empty'
  if (/\0/.test(g)) return 'It contains a NUL character'
  if (g.startsWith('/') || /^[A-Za-z]:/.test(g) || g.startsWith('~')) return 'It is outside the folder'
  const segs = g.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.some((s) => s === '..')) return 'It is outside the folder'
  if (segs.some((s) => s.toLowerCase() === '.git')) return "Dim Factory never copies git's own files"
  if (segs.length === 0) return 'It names the whole folder'
  return null
}

function compile(glob: string, platform: NodeJS.Platform): Seg[] {
  const nocase = platform === 'win32' || platform === 'darwin'
  const g = platform === 'win32' ? glob.replace(/\\/g, '/') : glob
  // A trailing slash names a folder: everything under it.
  const segs = g.split('/').filter((s) => s !== '' && s !== '.')
  return segs.map((s): Seg =>
    s === '**'
      ? { globstar: true }
      : { globstar: false, re: segmentRegExp(s, nocase), literal: hasWildcard(s) ? null : s },
  )
}

/** The path's segments match the pattern whole (`partial`: some path below it could). */
function matches(pat: readonly Seg[], path: readonly string[], partial: boolean): boolean {
  const memo = new Map<number, boolean>()
  const m = (pi: number, si: number): boolean => {
    const key = pi * 4096 + si
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    let r: boolean
    if (si === path.length) r = partial ? pi < pat.length : pat.slice(pi).every((s) => s.globstar)
    else if (pi === pat.length) r = false
    else {
      const p = pat[pi]
      if (p === undefined) r = false
      else if (p.globstar) r = m(pi + 1, si) || m(pi, si + 1)
      else r = p.re.test(path[si] ?? '') && m(pi + 1, si + 1)
    }
    memo.set(key, r)
    return r
  }
  return m(0, 0)
}

// ---- tracked files -----------------------------------------------------------------------------------------------

/** `git ls-files -z -s` in the folder: tracked paths relative to it, and the gitlinks (mode 160000) among them. */
export async function gitTrackedFiles(folder: string): Promise<TrackedFiles | null> {
  try {
    const r = await runGit(['ls-files', '-z', '-s'], {
      cwd: folder,
      noOptionalLocks: true,
      maxBytes: 512 * 1024 * 1024,
      timeoutMs: 120_000,
      category: 'git_state',
    })
    if (r.truncated) return null
    const files = new Set<string>()
    const gitlinks: string[] = []
    for (const rec of splitNul(r.stdout)) {
      const tab = rec.indexOf('\t')
      if (tab === -1) continue
      const path = rec.slice(tab + 1)
      files.add(path)
      if (rec.startsWith('160000 ')) gitlinks.push(path)
    }
    return { files, gitlinks }
  } catch {
    return null
  }
}

// ---- copy --------------------------------------------------------------------------------------------------------

type Kind = 'file' | 'dir' | 'link' | 'other' | 'missing'

async function kindOf(abs: string): Promise<{ kind: Kind; size: number }> {
  const st = await lstat(abs).catch(() => null)
  if (st === null) return { kind: 'missing', size: 0 }
  if (st.isSymbolicLink()) return { kind: 'link', size: 0 } // Node reads a Windows junction as a link too
  if (st.isDirectory()) return { kind: 'dir', size: 0 }
  if (st.isFile()) return { kind: 'file', size: st.size }
  return { kind: 'other', size: 0 }
}

/**
 * Copy the files `globs` match from `folder` into `worktreeFolder` (the same place in the run's copy). See the header
 * for what is never copied. Never throws for a file; a glob or file it leaves out is listed with why.
 */
export async function copyIns(
  folder: string,
  worktreeFolder: string,
  globs: readonly string[],
  opts: CopyInOptions = {},
): Promise<CopyInResult> {
  const platform = opts.platform ?? process.platform
  const nocase = platform === 'win32' || platform === 'darwin'
  const key = (rel: string): string => (nocase ? rel.toLowerCase() : rel)
  const src = resolve(folder)
  const dst = resolve(worktreeFolder)
  const result: CopyInResult = { copied: [], skipped: [], refused: [], bytes: 0 }
  const valid: { glob: string; pat: Seg[] }[] = []
  for (const glob of globs) {
    const why = refusal(glob, platform)
    if (why !== null) {
      result.refused.push({ glob, reason: why })
      continue
    }
    for (const g of expandBraces(glob)) {
      const again = refusal(g, platform)
      if (again !== null) result.refused.push({ glob: g, reason: again })
      else valid.push({ glob: g, pat: compile(g, platform) })
    }
  }
  if (valid.length === 0) return result
  for (const [label, path] of [
    ['folder', src],
    ["run's copy", dst],
  ] as const) {
    if ((await kindOf(path)).kind !== 'dir') {
      for (const v of valid)
        result.refused.push({ glob: v.glob, reason: `The ${label} ${path} is not a folder` })
      return result
    }
  }

  const tracked = await (opts.tracked ?? gitTrackedFiles)(src)
  if (tracked === null) {
    for (const v of valid) {
      result.refused.push({
        glob: v.glob,
        reason: 'Dim Factory could not list the tracked files, so it copies nothing',
      })
    }
    return result
  }
  const trackedKeys = new Set([...tracked.files].map(key))
  const gitlinkKeys = tracked.gitlinks.map(key)
  const insideGitlink = (rel: string): boolean =>
    gitlinkKeys.some((g) => key(rel) === g || key(rel).startsWith(`${g}/`))

  const maxFiles = opts.maxFiles ?? COPY_IN_MAX_FILES
  const maxBytes = opts.maxBytes ?? COPY_IN_MAX_BYTES
  const maxVisited = opts.maxVisited ?? COPY_IN_MAX_VISITED
  let visited = 0
  const seen = new Set<string>()
  const skippedSeen = new Set<string>()
  const skip = (path: string, reason: string): void => {
    if (skippedSeen.has(key(path))) return
    skippedSeen.add(key(path))
    result.skipped.push({ path, reason })
  }
  const stop = (reason: string): void => {
    result.truncated = true
    result.skipped.push({ path: '', reason })
  }
  /** What stands in the run's copy at each existing folder of `rel`: a link or a file there blocks the copy. */
  const destBlocker = async (rel: string): Promise<string | null> => {
    const parts = rel.split('/')
    let at = dst
    for (let i = 0; i < parts.length - 1; i++) {
      at = join(at, parts[i] ?? '')
      const k = (await kindOf(at)).kind
      if (k === 'missing') return null
      if (k === 'link') return `The run's copy has a link at ${parts.slice(0, i + 1).join('/')}`
      if (k !== 'dir') return `The run's copy has a file at ${parts.slice(0, i + 1).join('/')}`
    }
    return null
  }

  const copyOne = async (rel: string, size: number): Promise<boolean> => {
    if (seen.has(key(rel))) return true
    seen.add(key(rel))
    if (trackedKeys.has(key(rel))) {
      skip(rel, 'It is tracked by git: the run uses the committed version')
      return true
    }
    if (insideGitlink(rel)) {
      skip(rel, 'It is inside a nested repository')
      return true
    }
    if (result.copied.length >= maxFiles) {
      stop(`Stopped after ${maxFiles} files`)
      return false
    }
    if (result.bytes + size > maxBytes) {
      stop(`Stopped before going over ${Math.round(maxBytes / (1024 * 1024))} MB`)
      return false
    }
    const blocked = await destBlocker(rel)
    if (blocked !== null) {
      skip(rel, blocked)
      return true
    }
    const to = join(dst, ...rel.split('/'))
    if ((await kindOf(to)).kind !== 'missing') {
      skip(rel, "The run's copy already has it")
      return true
    }
    try {
      await mkdir(join(to, '..'), { recursive: true })
      // EXCL: never over anything that appeared at the destination meanwhile (a link included).
      await copyFile(join(src, ...rel.split('/')), to, constants.COPYFILE_EXCL)
    } catch (err) {
      skip(rel, `It could not be copied: ${(err as NodeJS.ErrnoException).code ?? String(err)}`)
      return true
    }
    result.copied.push(rel)
    result.bytes += size
    try {
      opts.onCopied?.(rel)
    } catch {
      // a listener's failure never stops the copy
    }
    return true
  }

  /** Copy everything under `rel` (a folder the glob names whole). Returns false once a limit stopped the copy. */
  const walk = async (
    rel: string,
    want: (segs: string[], dir: boolean) => 'copy' | 'descend' | 'no',
  ): Promise<boolean> => {
    const abs = rel === '' ? src : join(src, ...rel.split('/'))
    const entries = await readdir(abs).catch((): string[] => [])
    // A nested repository's files are its own (and its .git is never copied).
    if (rel !== '' && entries.some((e) => e.toLowerCase() === '.git')) {
      if (want(rel.split('/'), true) !== 'no') skip(rel, 'It is a nested repository')
      return true
    }
    for (const name of entries.sort()) {
      if (name.toLowerCase() === '.git') continue
      if (++visited > maxVisited) {
        stop(`Stopped after looking at ${maxVisited} files and folders`)
        return false
      }
      const childRel = rel === '' ? name : `${rel}/${name}`
      const segs = childRel.split('/')
      const info = await kindOf(join(abs, name))
      if (info.kind === 'dir') {
        const w = want(segs, true)
        if (w === 'no') continue
        if (w === 'copy') {
          if (!(await walk(childRel, () => 'copy'))) return false
        } else if (!(await walk(childRel, want))) return false
        continue
      }
      const w = want(segs, false)
      if (w === 'no') continue
      if (info.kind === 'link') skip(childRel, 'It is a link: Dim Factory never copies through links')
      else if (info.kind !== 'file') skip(childRel, 'It is not a regular file')
      else if (!(await copyOne(childRel, info.size))) return false
    }
    return true
  }

  for (const { pat } of valid) {
    // The leading folders without wildcards: checked one by one (never through a link), then walked from there.
    const fixed: string[] = []
    for (const s of pat) {
      if (s.globstar || s.literal === null) break
      fixed.push(s.literal)
    }
    let ok = true
    let at = src
    for (let i = 0; i < fixed.length; i++) {
      at = join(at, fixed[i] ?? '')
      const rel = fixed.slice(0, i + 1).join('/')
      const info = await kindOf(at)
      const last = i === fixed.length - 1 && fixed.length === pat.length
      if (info.kind === 'missing') {
        // A plain path that is not there is named; a pattern that matches nothing is not.
        if (fixed.length === pat.length) skip(fixed.join('/'), 'Not found in the folder')
        ok = false
        break
      }
      if (info.kind === 'link') {
        skip(rel, 'It is a link: Dim Factory never copies through links')
        ok = false
        break
      }
      if (rel.split('/').some((s) => s.toLowerCase() === '.git')) {
        ok = false
        break
      }
      if (last) {
        ok = false
        if (info.kind === 'file') {
          if (!(await copyOne(rel, info.size))) return result
        } else if (info.kind === 'dir') {
          if (!(await walk(rel, () => 'copy'))) return result
        } else skip(rel, 'It is not a regular file')
        break
      }
      if (info.kind !== 'dir') {
        ok = false
        break
      }
    }
    if (!ok) continue
    if (cwdRelOf(src, at) === null) continue
    const startRel = fixed.join('/')
    const go = await walk(startRel, (segs, dir) => {
      if (matches(pat, segs, false)) return 'copy'
      return dir && matches(pat, segs, true) ? 'descend' : 'no'
    })
    if (!go) return result
  }
  return result
}
