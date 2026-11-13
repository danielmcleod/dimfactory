// Revert the folder to a snapshot (Revert to S0; reconcile's "Restore run's version"; P21
// `revert-then-fresh`). Only the user's working files are written, through the shadow: a scratch GIT_INDEX_FILE is
// filled from the snapshot with `update-index -z --index-info`, then `checkout-index -f -z --stdin` writes the files.
// Never the user's index, refs or objects. Undo = revertTo(the `pre-revert` snapshot taken first).
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { GitError } from './exec.ts'
import { withFolderLock } from './mutex.ts'
import { parseRawZ } from './patch.ts'
import type { Shadow, SnapLabel, SnapshotRecord } from './shadow.ts'
import { BRAND } from '../../shared/brand.ts'

const GITLINK = '160000'
const SYMLINK = '120000'
const BIG_OUTPUT = 256 * 1024 * 1024
/** Files hashed at once when checking what checkout-index wrote. */
const VERIFY_CONCURRENCY = 16

export const UNREADABLE_REASON = 'could not be read, so its current content could not be saved'
export const NO_SYMLINKS_REASON = 'symbolic links cannot be created here'

export interface RevertOptions {
  /** The run whose snapshot chain gets the `pre-revert` undo point. */
  runId: string
  /**
   * Scope-relative, `/`-separated paths (files, or folders meaning everything under them). Absent: every path that
   * differs. For a rename, list both its paths (FileChange `path` and `oldPath`).
   */
  paths?: readonly string[]
  /** A process (a pass) holds the folder; revert is refused (only when no process holds it). */
  folderHeld?: boolean
  /** Label of the undo snapshot (default `pre-revert`). */
  label?: SnapLabel
  /**
   * Undo: what the selected paths should hold now, the tree (or commit) the revert being undone wrote (a path absent
   * there was deleted by it). A path that differs from it changed after that revert, by a later step or by the user:
   * the undo is refused (`conflict`) and nothing is written, so it never overwrites newer work.
   */
  expect?: string
  /**
   * Write-ahead: called with the undo point and the paths about to change once both are known, before any file is
   * written (the caller records them, so a crash part way still leaves an Undo). A throw aborts the revert.
   */
  onPlanned?: (p: { preRevert: SnapshotRecord; paths: string[] }) => Promise<void>
  /**
   * Paths the undo point holds even when the folder's ignore rules leave them out (Shadow.snapshot `force`), so
   * a file an apply wrote there is seen, and restored or removed, like any other.
   */
  force?: readonly string[]
}

export interface RevertOutcome {
  /** The folder just before the revert: the undo point. */
  preRevert: SnapshotRecord
  /** The tree the paths were reverted to. */
  targetTree: string
  /** Written from the target and checked on disk (content, type and, on POSIX, the exec bit). */
  restored: string[]
  /** Absent in the target, so removed from the folder. */
  deleted: string[]
  /**
   * Left alone: gitlinks (nested repositories), a folder in a file's place, a file or a link (a Windows junction
   * included) in the place of a folder the path needs, files git could not read for the undo point or could not
   * write, symbolic links where none can be made.
   */
  skipped: { path: string; reason: string }[]
}

export type RevertToResult =
  | { ok: true; outcome: RevertOutcome }
  | { ok: false; refused: 'folder-busy'; message: string }
  /** `expect` did not hold: these paths changed after the revert being undone. Nothing was written. */
  | { ok: false; refused: 'conflict'; message: string; paths: string[] }

/** One of the shadow's own refs. */
const OWN_REF = new RegExp(`^${BRAND.refNamespace}[A-Za-z0-9._/-]+$`)

/** A snapshot Dim Factory passes: an object id or one of its own refs (never an option or a user ref). */
function assertTarget(rev: string): string {
  if (/^[0-9a-f]{40,64}$/i.test(rev) || OWN_REF.test(rev)) return rev
  throw new GitError('exit', `invalid revert target: ${JSON.stringify(rev)}`, {
    args: [],
    category: 'snapshot_failed',
  })
}

interface Write {
  mode: string
  sha: string
  path: string
}

interface Planned {
  writes: Write[]
  deletes: string[]
  skipped: { path: string; reason: string }[]
}

const normPath = (s: string, fold: boolean): string => {
  const t = s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return fold ? t.toLowerCase() : t
}

/** Does `p` fall under one of `paths` (equal, or inside a listed folder)? */
function under(paths: readonly string[] | undefined, fold: boolean): (p: string) => boolean {
  if (paths === undefined) return () => true
  const set = new Set(paths.map((x) => normPath(x, fold)).filter((x) => x !== ''))
  return (p) => {
    const n = normPath(p, fold)
    if (set.has(n)) return true
    for (let i = n.indexOf('/'); i !== -1; i = n.indexOf('/', i + 1)) if (set.has(n.slice(0, i))) return true
    return false
  }
}

/** Paths that differ between two trees (`diff-tree -r --no-renames`), case-folded on a case-insensitive volume. */
async function differing(shadow: Shadow, from: string, to: string): Promise<Set<string>> {
  const fold = shadow.scope.caseInsensitive
  const raw = await shadow.git(
    ['diff-tree', '-r', '-z', '--no-renames', '--raw', '--no-ext-diff', from, to],
    {
      maxBytes: BIG_OUTPUT,
    },
  )
  return new Set(parseRawZ(raw.stdout).map((r) => normPath(r.path, fold)))
}

/**
 * What to do for each difference between the folder now (`from`) and the target: `diff-tree -r -z --no-renames
 * --raw`, so every path stands alone (a rename's two paths are two entries; callers list both). On a
 * case-insensitive volume, paths that differ only in case are one file: selecting either takes both, so a case-only
 * rename reverts as one rename. Paths git could not read for the undo point (`unreadable`, and anything under them)
 * are left alone: their current bytes are in no snapshot, so writing or deleting them could not be undone.
 */
async function plan(
  shadow: Shadow,
  from: string,
  to: string,
  paths: readonly string[] | undefined,
  unreadable: readonly string[],
): Promise<Planned> {
  const fold = shadow.scope.caseInsensitive
  const raw = await shadow.git(
    ['diff-tree', '-r', '-z', '--no-renames', '--raw', '--no-ext-diff', from, to],
    {
      maxBytes: BIG_OUTPUT,
    },
  )
  const records = parseRawZ(raw.stdout)
  const picked = under(paths, fold)
  const notRead = under(unreadable.length > 0 ? unreadable : [], fold)
  const key = (p: string): string => (fold ? p.toLowerCase() : p)
  const chosen = new Set(records.filter((r) => picked(r.path)).map((r) => key(r.path)))
  const out: Planned = { writes: [], deletes: [], skipped: [] }
  for (const r of records) {
    if (!chosen.has(key(r.path))) continue
    if (r.oldMode === GITLINK || r.newMode === GITLINK) {
      out.skipped.push({ path: r.path, reason: 'nested repository (gitlink)' })
      continue
    }
    if (notRead(r.path)) {
      out.skipped.push({ path: r.path, reason: UNREADABLE_REASON })
      continue
    }
    if (r.status === 'D') out.deletes.push(r.path)
    else if (r.newMode === SYMLINK && !shadow.symlinks)
      out.skipped.push({ path: r.path, reason: NO_SYMLINKS_REASON })
    else out.writes.push({ mode: r.newMode, sha: r.newSha, path: r.path })
  }
  return out
}

/**
 * Remove now-empty parent folders of `rel`, up to (not including) the scope root. Only real folders: it stops at a
 * symbolic link or a Windows junction (lstat reads both as links), since rmdir on a junction removes the junction
 * itself, whatever its target holds.
 */
export async function pruneEmptyParents(root: string, rel: string): Promise<void> {
  let dir = path.dirname(rel)
  while (dir !== '.' && dir !== '' && dir !== '/') {
    const abs = path.join(root, dir)
    const st = await lstat(abs).catch(() => null)
    if (st === null || !st.isDirectory()) return
    try {
      await rmdir(abs)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

const isDir = async (p: string): Promise<boolean> =>
  lstat(p).then(
    (s) => s.isDirectory(),
    () => false,
  )

/** What stands where a folder of the path should be: a file, or a link (a symbolic link or a Windows junction). */
export interface Blocker {
  prefix: string
  link: boolean
}

/**
 * The first parent folder of `rel` that exists as something other than a real folder: a file, a symbolic link, or a
 * Windows junction (Node's lstat reads a junction as a link). Writing `rel` would make checkout-index -f remove it,
 * unlisted; deleting `rel` would reach through a link into a folder outside the project (git for Windows snapshots a
 * junction's target as if it were a folder). `cache` holds what each prefix was found to be.
 */
export async function blockedParent(
  root: string,
  rel: string,
  cache: Map<string, Blocker | null>,
): Promise<Blocker | undefined> {
  const parts = rel.split('/')
  let prefix = ''
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix === '' ? (parts[i] ?? '') : `${prefix}/${parts[i] ?? ''}`
    let blocked = cache.get(prefix)
    if (blocked === undefined) {
      const here = prefix
      blocked = await lstat(path.join(root, prefix)).then(
        (s) => (s.isDirectory() ? null : { prefix: here, link: s.isSymbolicLink() }),
        () => null,
      )
      cache.set(prefix, blocked)
    }
    if (blocked !== null) return blocked
  }
  return undefined
}

export const blockedText = (b: Blocker): string =>
  `a ${b.link ? 'link' : 'file'} is in the place of its folder ${b.prefix}`

/** git's object id of a blob with these bytes (sha1, or sha256 for a 64-hex id). */
function blobHasher(algo: 'sha1' | 'sha256', size: number): ReturnType<typeof createHash> {
  return createHash(algo).update(`blob ${size}\0`)
}

/**
 * Is `abs` now exactly the blob checkout-index was asked to write: a regular file with those bytes (and, on POSIX,
 * the exec bit the mode says), or a symbolic link with that target? This, not checkout-index's messages, decides
 * restored versus skipped.
 */
async function wrote(abs: string, w: Write, platform: NodeJS.Platform): Promise<boolean> {
  const algo = w.sha.length === 64 ? 'sha256' : 'sha1'
  const st = await lstat(abs).catch(() => null)
  if (st === null) return false
  if (w.mode === SYMLINK) {
    if (!st.isSymbolicLink()) return false
    const target = await readlink(abs).catch(() => null)
    if (target === null) return false
    // Git for Windows stores the target with `\`; the blob has the `/` spelling.
    const spellings = platform === 'win32' ? [target, target.replace(/\\/g, '/')] : [target]
    return spellings.some((t) => {
      const b = Buffer.from(t, 'utf8')
      return blobHasher(algo, b.length).update(b).digest('hex') === w.sha
    })
  }
  if (!st.isFile()) return false
  if (platform !== 'win32' && (w.mode === '100755') !== ((st.mode & 0o100) !== 0)) return false
  const h = blobHasher(algo, st.size)
  try {
    for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer)
  } catch {
    return false
  }
  return h.digest('hex') === w.sha
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * checkout-index's own words for a path it did not write: an `error:`/`warning:`/`fatal:` line naming exactly that
 * path (quoted, or followed by a colon). Only the reason; whether it was written is checked on disk.
 */
function reasonsByPath(stderr: string, candidates: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  const lines = stderr.split(/\r?\n/).filter((l) => /^(?:error|warning|fatal):/.test(l))
  for (const c of candidates) {
    const re = new RegExp(`(?:'${escapeRe(c)}'|(?:^|\\s)${escapeRe(c)}:)`)
    const line = lines.find((l) => re.test(l.replace(/^(?:error|warning|fatal):\s*/, ' ')))
    if (line !== undefined) out.set(c, line.replace(/^(?:error|warning|fatal):\s*/, ''))
  }
  return out
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function listText(paths: readonly string[], max = 10): string {
  const shown = paths.slice(0, max).join(', ')
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown
}

/**
 * Revert `paths` (all by default) of the folder to the snapshot `target` (Revert to S0):
 * 1. refused while a process holds the folder;
 * 2. a `pre-revert` snapshot (the undo point; it becomes the run's latest snapshot);
 * 3. under the folder mutex: plan the differences (skipping what the undo point could not read), refuse an undo whose
 *    paths changed since the revert (`expect`), report the plan (`onPlanned`, write-ahead), then delete files absent
 *    in the target first (so a case-only rename on a case-insensitive volume comes out as one rename), then put the
 *    target's blobs in a scratch index (`update-index -z --index-info`) and let `checkout-index -f -z --stdin` write
 *    them: exact bytes (the shadow turns every conversion off) and the exec bit on POSIX. A write whose path needs a
 *    folder where a file or link is now is skipped (checkout-index -f would remove that file, unlisted), and so is a
 *    delete under a link or a Windows junction (the file is outside the project); emptied folders are removed up to
 *    the first link, never the link itself. Each written file is then checked on disk. Gitlinks are skipped.
 * Undo: undoRevert(outcome).
 */
export async function revertTo(shadow: Shadow, target: string, opts: RevertOptions): Promise<RevertToResult> {
  if (opts.folderHeld === true) {
    return {
      ok: false,
      refused: 'folder-busy',
      message: 'A step is still working in this folder. Revert when it has stopped.',
    }
  }
  const rev = assertTarget(target)
  const resolved = await shadow.git(['rev-parse', '-q', '--verify', `${rev}^{tree}`])
  const targetTree = resolved.stdout.trim()
  const expectTree =
    opts.expect !== undefined
      ? (
          await shadow.git(['rev-parse', '-q', '--verify', `${assertTarget(opts.expect)}^{tree}`])
        ).stdout.trim()
      : undefined
  const preRevert = await shadow.snapshot(
    opts.runId,
    opts.label ?? 'pre-revert',
    opts.force !== undefined ? { force: opts.force } : {},
  )
  return withFolderLock(shadow.folderKey, async (): Promise<RevertToResult> => {
    const root = shadow.scopeRoot
    const fold = shadow.scope.caseInsensitive
    const planned = await plan(shadow, preRevert.commit, targetTree, opts.paths, preRevert.unreadable)
    if (expectTree !== undefined) {
      const changedSince = await differing(shadow, preRevert.commit, expectTree)
      const conflicts = [...planned.deletes, ...planned.writes.map((w) => w.path)]
        .filter((p) => changedSince.has(normPath(p, fold)))
        .sort()
      if (conflicts.length > 0) {
        return {
          ok: false,
          refused: 'conflict',
          paths: conflicts,
          message:
            `${plural(conflicts.length, 'file')} changed after the revert (${listText(conflicts)}), so undoing it ` +
            'would overwrite that work. Nothing was undone.',
        }
      }
    }
    await opts.onPlanned?.({
      preRevert,
      paths: [...planned.deletes, ...planned.writes.map((w) => w.path)].sort(),
    })
    const skipped = [...planned.skipped]
    const deleted: string[] = []
    for (const rel of planned.deletes) {
      const abs = path.join(root, rel)
      if (await isDir(abs)) {
        skipped.push({ path: rel, reason: 'a folder is in its place' })
        continue
      }
      // Never through a link: a file "inside" a junction or a linked folder lives outside the project. Checked fresh
      // for each delete (an earlier delete may have pruned a folder).
      const blocker = await blockedParent(root, rel, new Map())
      if (blocker !== undefined) {
        skipped.push({ path: rel, reason: blockedText(blocker) })
        continue
      }
      try {
        await rm(abs, { force: true })
        deleted.push(rel)
        await pruneEmptyParents(root, rel)
      } catch (err) {
        skipped.push({ path: rel, reason: `could not delete: ${(err as Error).message}` })
      }
    }
    const writes: Write[] = []
    const parents = new Map<string, Blocker | null>()
    for (const w of planned.writes) {
      if (await isDir(path.join(root, w.path))) {
        skipped.push({ path: w.path, reason: 'a folder is in its place' })
        continue
      }
      const blocker = await blockedParent(root, w.path, parents)
      if (blocker !== undefined) {
        skipped.push({ path: w.path, reason: blockedText(blocker) })
        continue
      }
      writes.push(w)
    }
    const restored: string[] = []
    if (writes.length > 0) {
      const scratch = path.join(shadow.root, `revert-${process.pid}-${randomBytes(6).toString('hex')}.index`)
      const env = { GIT_INDEX_FILE: scratch }
      try {
        await shadow.git(['update-index', '-z', '--index-info'], {
          env,
          stdin: writes.map((w) => `${w.mode} ${w.sha}\t${w.path}\0`).join(''),
        })
        const r = await shadow.git(['checkout-index', '-f', '-z', '--stdin'], {
          env,
          stdin: writes.map((w) => `${w.path}\0`).join(''),
          okCodes: [0, 1, 128],
          timeoutMs: 15 * 60_000,
        })
        const ok = await mapLimit(writes, VERIFY_CONCURRENCY, (w) =>
          wrote(path.join(root, w.path), w, shadow.platform),
        )
        const reasons =
          r.code === 0
            ? new Map<string, string>()
            : reasonsByPath(
                r.stderr,
                writes.map((w) => w.path),
              )
        const firstLine =
          r.stderr
            .split(/\r?\n/)
            .find((l) => /^(?:fatal|error):/.test(l))
            ?.replace(/^(?:fatal|error):\s*/, '') ?? ''
        // Nothing written, nothing deleted and no path named: git failed as a whole.
        if (r.code !== 0 && !ok.some(Boolean) && reasons.size === 0 && deleted.length === 0) {
          throw new GitError('exit', `git checkout-index failed: ${firstLine}`, {
            args: r.args,
            exitCode: r.code,
            stderr: r.stderr,
            category: 'snapshot_failed',
          })
        }
        writes.forEach((w, i) => {
          if (ok[i] === true) restored.push(w.path)
          else
            skipped.push({
              path: w.path,
              reason: reasons.get(w.path) ?? (firstLine !== '' ? firstLine : 'git could not write it'),
            })
        })
      } finally {
        await rm(scratch, { force: true }).catch(() => undefined)
        await rm(`${scratch}.lock`, { force: true }).catch(() => undefined)
      }
    }
    return {
      ok: true,
      outcome: { preRevert, targetTree, restored: restored.sort(), deleted: deleted.sort(), skipped },
    }
  })
}

/**
 * Undo a revert: the same paths back to the `pre-revert` snapshot, only while each still holds what the revert wrote
 * (refused with `conflict` otherwise). Itself undoable the same way (its own `pre-revert` snapshot).
 */
export function undoRevert(
  shadow: Shadow,
  outcome: RevertOutcome,
  opts: Omit<RevertOptions, 'paths' | 'expect'>,
): Promise<RevertToResult> {
  return revertTo(shadow, outcome.preRevert.commit, {
    ...opts,
    paths: [...outcome.restored, ...outcome.deleted],
    expect: outcome.targetTree,
  })
}
