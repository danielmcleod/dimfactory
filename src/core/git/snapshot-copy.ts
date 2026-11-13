// An isolated run's copy made from a snapshot instead of a git worktree (a match's sides): the files of one tree in the
// folder's shadow, written to `<home>/worktrees/<runId>` byte for byte. It works for a folder that is not a
// repository and carries the folder as it was when the snapshot was taken, uncommitted changes included. Nothing is
// read from or written to the user's folder or repository: git runs against the shadow only, with a scratch index.
//
// What a snapshot leaves out is left out of the copy too: ignored files (dependency and build folders, `.env`), nested
// repositories and links to folders. Copy-ins and the install bring back what a run needs, as for a worktree.
//
// The copy has no branch (`branch: ''`): removing it deletes its folder and its shadow, and never touches git
// (worktree.ts removeWorktree). Apply, Undo and Discard work as for a worktree (finalize.ts reads snapshots only).
import { mkdir, readdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { homePaths } from '../home.ts'
import { freeBytes as volumeFreeBytes } from '../store/storage.ts'
import { withFolderLock } from './mutex.ts'
import type { Shadow } from './shadow.ts'
import {
  DISK_FACTOR,
  DISK_MARGIN_BYTES,
  WORKTREE_ADD_TIMEOUT_MS,
  WorktreeError,
  formatBytes,
  removeTree,
  unlinkLinksInside,
  worktreeKeys,
} from './worktree.ts'
import type { WorktreeInfo } from './worktree.ts'

const BIG_OUTPUT = 256 * 1024 * 1024
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** A copy made from a snapshot has no branch. */
export const SNAPSHOT_COPY_BRANCH = ''

/** Whether an isolated run's copy was made from a snapshot (no git worktree, no branch). */
export function isSnapshotCopy(w: { branch: string }): boolean {
  return w.branch === SNAPSHOT_COPY_BRANCH
}

export interface SnapshotCopyOptions {
  /** DIM_FACTORY_HOME: the copy is `<home>/worktrees/<runId>`. */
  home: string
  runId: string
  /** The folder's shadow, which holds `tree`. */
  source: Shadow
  /** The tree to write: a snapshot of the folder. */
  tree: string
  /**
   * Write-ahead: called right before anything is written, with what is about to exist. The caller records it, so a
   * crash part way leaves a folder the next attempt replaces. A throw aborts before any write.
   */
  onIntent?: (w: Omit<WorktreeInfo, 'folderKey'>) => Promise<void>
  /** Free bytes on the volume holding a folder (tests). */
  freeBytes?: (dir: string) => Promise<number | null>
  timeoutMs?: number
}

/** The files of a tree and their total size (`ls-tree -r -l`: blobs only; nested repositories have no size). */
export async function treeSize(source: Shadow, tree: string): Promise<{ files: number; bytes: number }> {
  const r = await source.git(['ls-tree', '-r', '-l', '-z', tree], { maxBytes: BIG_OUTPUT })
  let files = 0
  let bytes = 0
  for (const rec of r.stdout.split('\0')) {
    if (rec === '') continue
    // `<mode> <type> <sha> <size>\t<path>`; the size column is right-aligned, or `-` for a nested repository.
    const m = /^\d+ (\w+) [0-9a-f]+ +(\d+|-)\t/.exec(rec)
    if (m === null || m[1] !== 'blob') continue
    files += 1
    bytes += m[2] === '-' ? 0 : Number(m[2])
  }
  return { files, bytes }
}

async function isEmptyDir(dir: string): Promise<boolean> {
  return readdir(dir).then(
    (names) => names.length === 0,
    () => false,
  )
}

/**
 * Write `tree` to `<home>/worktrees/<runId>`. A folder already there is this run's own earlier attempt (the run id is
 * its name, and a run asks only before its copy exists): it is removed first, links unlinked and never followed.
 * Throws WorktreeError (`worktree_failed`, or `disk_full`) with UI copy.
 */
export async function createSnapshotCopy(o: SnapshotCopyOptions): Promise<WorktreeInfo & { files: number }> {
  const { source, tree } = o
  if (!SHA.test(tree)) throw new WorktreeError('git', 'The starting point of this copy is not a snapshot.')
  const keys = await worktreeKeys(o.home, o.runId)
  const paths = homePaths(o.home)
  const kind = await source.git(['cat-file', '-t', tree]).then(
    (r) => r.stdout.trim(),
    () => '',
  )
  if (kind !== 'tree') {
    throw new WorktreeError(
      'git',
      'The snapshot this copy starts from is not there any more, so the copy cannot be made. Start the match again.',
    )
  }
  const size = await treeSize(source, tree)
  const free = await (o.freeBytes ?? volumeFreeBytes)(paths.worktreesDir).catch(() => null)
  const needed = Math.ceil(size.bytes * DISK_FACTOR) + DISK_MARGIN_BYTES
  if (free !== null && free < needed) {
    throw new WorktreeError(
      'disk-full',
      `Not enough free space for the copy: it needs about ${formatBytes(needed)} and ${formatBytes(free)} is free.`,
      { category: 'disk_full' },
    )
  }
  const info: Omit<WorktreeInfo, 'folderKey'> = {
    path: keys.path,
    branch: SNAPSHOT_COPY_BRANCH,
    base: tree,
    commonDir: '',
    folder: source.scopeRoot,
  }
  await o.onIntent?.(info)
  if (!(await isEmptyDir(keys.path))) {
    await unlinkLinksInside(keys.path).catch(() => undefined)
    await removeTree(keys.path).catch(() => undefined)
    await rm(keys.path, { recursive: true, force: true })
  }
  await mkdir(keys.path, { recursive: true })
  const scratch = path.join(source.root, `copy-${process.pid}-${randomBytes(6).toString('hex')}.index`)
  const env = { GIT_INDEX_FILE: scratch }
  const timeoutMs = o.timeoutMs ?? WORKTREE_ADD_TIMEOUT_MS
  try {
    // Under the folder's mutex: the shadow's collection never runs while its objects are being read out.
    await withFolderLock(source.folderKey, async () => {
      await source.git(['read-tree', tree], { env, timeoutMs, category: 'worktree_failed' })
      // `--prefix` writes under the copy's folder whatever the shadow's work tree is; the trailing separator matters.
      const prefix = `${keys.path.replace(/\\/g, '/')}/`
      await source.git(['checkout-index', '-a', '-f', `--prefix=${prefix}`], {
        env,
        timeoutMs,
        maxBytes: BIG_OUTPUT,
        category: 'worktree_failed',
      })
    })
  } catch (err) {
    await removeTree(keys.path).catch(() => undefined)
    if (err instanceof WorktreeError) throw err
    const stderr = (err as { stderr?: string } | null)?.stderr ?? ''
    const full = /No space left|not enough space|disk full/i.test(stderr)
    throw new WorktreeError(
      full ? 'disk-full' : 'git',
      full
        ? 'The drive filled up while the copy was being made. Free some space, then retry.'
        : `The copy could not be written: ${(stderr.trim().split(/\r?\n/)[0] ?? '') || (err instanceof Error ? err.message : String(err))}`,
      { ...(full ? { category: 'disk_full' as const } : {}), stderr },
    )
  } finally {
    await rm(scratch, { force: true }).catch(() => undefined)
    await rm(`${scratch}.lock`, { force: true }).catch(() => undefined)
  }
  return { ...info, folderKey: keys.folderKey, files: size.files }
}
