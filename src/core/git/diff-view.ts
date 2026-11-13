// The Diff tab's reads: a run's segment rows, one file's patch and one
// blob, read from a folder's shadow repository by commit and blob id. Reads only: `ShadowReader` runs plumbing with
// GIT_DIR set and never opens (or creates) the shadow the way Shadow.open does, so a cleared shadow stays cleared and
// a history run whose folder is gone still reads. Rows carry what the viewer's special rows need (binary, EOL-only,
// gitlink, mode change, rename similarity, large, edited after the run).
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DiffFilePatch, FileChange } from '../../shared/ipc.ts'
import { DIFF_BLOB_MAX_BYTES, LARGE_DIFF_LINES } from '../../shared/ipc.ts'
import { isGitError, runGit } from './exec.ts'
import type { GitResult, GitRunOptions } from './exec.ts'
import { mergeDiff, parseRawZ } from './patch.ts'

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const BIG_OUTPUT = 256 * 1024 * 1024
/** One file's patch in the viewer is cut here (DiffFilePatch.truncated). */
export const DIFF_FILE_MAX_BYTES = 4 * 1024 * 1024
/**
 * Changed-file rows kept per segment and work tree (commit pairs are immutable; an edit of the project's
 * .gitattributes afterwards is seen once the pair leaves the cache).
 */
const CHANGES_CACHE_MAX = 64

/** A git failure that means the shadow no longer has the object (cleared, gc'd after retention, a new shadow). */
export function isMissingObject(err: unknown): boolean {
  if (!isGitError(err)) return false
  return /bad object|not a valid object|unknown revision|invalid object|could not read|missing|not a git repository|does not exist/i.test(
    `${err.stderr}\n${err.message}`,
  )
}

function assertSha(rev: string): string {
  if (!SHA.test(rev)) throw new Error(`not an object id: ${JSON.stringify(rev)}`)
  return rev
}

const zeroSha = (sha: string): boolean => /^0+$/.test(sha)

/** The viewer's facts beyond mergeDiff's: rename similarity, a mode change, a large file. */
export function withRowFacts(change: FileChange, similarity?: number): FileChange {
  const out: FileChange = { ...change }
  if (change.status === 'R' && similarity !== undefined && Number.isFinite(similarity)) {
    out.similarity = similarity
  }
  if (
    !zeroSha(change.oldMode) &&
    !zeroSha(change.newMode) &&
    change.oldMode !== '' &&
    change.newMode !== '' &&
    change.oldMode !== change.newMode
  ) {
    out.modeChanged = true
  }
  if ((change.added ?? 0) + (change.deleted ?? 0) > LARGE_DIFF_LINES) out.large = true
  return out
}

// ---- image bytes ----------------------------------------------------------------------------------------------

/**
 * The image type of `bytes` by its signature (png, jpeg, gif, webp, bmp, ico), else null. Text formats (SVG) are
 * never images here: their markup could run in a preview.
 */
export function imageMime(bytes: Uint8Array): string | null {
  const b = (i: number): number => bytes[i] ?? -1
  const ascii = (from: number, s: string): boolean =>
    [...s].every((ch, k) => b(from + k) === ch.charCodeAt(0))
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b(i) === v)) return 'image/png'
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(0, 'BM') && bytes.length >= 26) return 'image/bmp'
  if (b(0) === 0 && b(1) === 0 && b(2) === 1 && b(3) === 0 && bytes.length >= 6) return 'image/x-icon'
  return null
}

// ---- edited after the run --------------------------------------------------------------------------------------

/** Bytes hashed at most per request for `editedAfterRun`; past it, the rest stay unchecked. */
export const EDITED_HASH_BUDGET_BYTES = 256 * 1024 * 1024
const HASH_CONCURRENCY = 16
const HASH_CACHE_MAX = 20_000

interface HashEntry {
  size: number
  mtimeMs: number
  ino: number
  kind: 'file' | 'link'
  algo: 'sha1' | 'sha256'
  sha: string
}

/** A folder file's blob id by its stat: a file seen unchanged since the last request is not read again. */
const hashCache = new Map<string, HashEntry>()

function remember(abs: string, e: HashEntry): void {
  hashCache.delete(abs)
  hashCache.set(abs, e)
  if (hashCache.size > HASH_CACHE_MAX) {
    const first = hashCache.keys().next()
    if (first.done !== true) hashCache.delete(first.value)
  }
}

/**
 * git's blob id of a file or link at `abs` (sha1, or sha256 for 64-hex ids); null when it is gone or something else;
 * undefined when hashing it would pass the budget (left unchecked).
 */
async function blobIdOf(
  abs: string,
  algo: 'sha1' | 'sha256',
  budget: { left: number },
): Promise<string | null | undefined> {
  const st = await lstat(abs).catch(() => null)
  if (st === null) return null
  const kind = st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : null
  if (kind === null) return null
  const hit = hashCache.get(abs)
  if (
    hit !== undefined &&
    hit.kind === kind &&
    hit.algo === algo &&
    hit.size === st.size &&
    hit.mtimeMs === st.mtimeMs &&
    hit.ino === st.ino
  ) {
    return hit.sha
  }
  let sha: string
  if (kind === 'link') {
    const target = await readlink(abs).catch(() => null)
    if (target === null) return null
    // Git for Windows reads a link's target with `\`; the blob has the `/` spelling (revert.ts does the same).
    const b = Buffer.from(process.platform === 'win32' ? target.replace(/\\/g, '/') : target, 'utf8')
    sha = createHash(algo).update(`blob ${b.length}\0`).update(b).digest('hex')
  } else {
    if (st.size > budget.left) return undefined
    budget.left -= st.size
    const h = createHash(algo).update(`blob ${st.size}\0`)
    try {
      for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer)
    } catch {
      return null
    }
    sha = h.digest('hex')
  }
  remember(abs, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, kind, algo, sha })
  return sha
}

/** Same blob: equal ids, or one an abbreviation (≥ 7 hex) of the other (a persisted patch's `index` line). */
export function sameBlobId(a: string, b: string): boolean {
  if (a === '' || b === '') return false
  if (a.length === b.length) return a === b
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  return short.length >= 7 && long.startsWith(short)
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

/**
 * Mark each row `editedAfterRun` (the viewer's special row): the file in `root` no longer holds the segment's new side
 * (other content, gone, or back after the run deleted it). Gitlinks and files past the hash budget stay unchecked;
 * nothing is checked when `root` is gone. Each file is read at most once per change of its stat.
 */
export async function markEditedAfterRun(
  root: string,
  rows: readonly FileChange[],
  budgetBytes: number = EDITED_HASH_BUDGET_BYTES,
): Promise<FileChange[]> {
  const rootOk = await stat(root).then(
    (s) => s.isDirectory(),
    () => false,
  )
  if (!rootOk) return [...rows]
  const budget = { left: budgetBytes }
  return mapLimit(rows, HASH_CONCURRENCY, async (row) => {
    // A saved patch names no blob for a pure rename or a mode change (no `index` line): nothing to compare with.
    if (row.gitlink || row.newSha === '') return row
    const abs = path.join(root, ...row.path.split('/'))
    if (zeroSha(row.newSha) || row.status === 'D') {
      const back = await lstat(abs).then(
        () => true,
        () => false,
      )
      return { ...row, editedAfterRun: back }
    }
    const algo = row.newSha.length === 64 ? 'sha256' : 'sha1'
    const now = await blobIdOf(abs, algo, budget)
    if (now === undefined) return row
    return { ...row, editedAfterRun: now === null || !sameBlobId(now, row.newSha) }
  })
}

// ---- the reader --------------------------------------------------------------------------------------------------

const changesCache = new Map<string, FileChange[]>()

/**
 * Read-only plumbing against `<home>/shadow/<folderKey>/repo.git` (never creates or configures it). With the project
 * folder as its work tree (GIT_WORK_TREE, as Shadow.gitEnv gives the controller), git reads the project's
 * .gitattributes the way the run's saved patches and diff stats were made (`-diff` and `binary` files read as
 * binary); a history run whose folder is gone reads with GIT_DIR alone.
 */
export class ShadowReader {
  readonly gitDir: string
  /** The project folder, when it still exists; null reads without a work tree. */
  readonly workTree: string | null

  constructor(gitDir: string, workTree: string | null = null) {
    this.gitDir = path.resolve(gitDir)
    this.workTree = workTree !== null ? path.resolve(workTree) : null
  }

  /**
   * The reader for a shadow that exists (its HEAD is there); null when there is none (cleared, never made).
   * `workTree` is used only while it is a folder.
   */
  static async open(gitDir: string, workTree?: string | null): Promise<ShadowReader | null> {
    const head = await stat(path.join(gitDir, 'HEAD')).catch(() => null)
    if (head?.isFile() !== true) return null
    const tree =
      workTree !== undefined && workTree !== null
        ? await stat(workTree).then(
            (s) => (s.isDirectory() ? workTree : null),
            () => null,
          )
        : null
    return new ShadowReader(gitDir, tree)
  }

  git(args: readonly string[], extra: Omit<GitRunOptions, 'cwd'> = {}): Promise<GitResult> {
    return runGit(args, {
      category: 'snapshot_failed',
      ...extra,
      cwd: this.workTree ?? path.dirname(this.gitDir),
      env: {
        ...extra.env,
        GIT_DIR: this.gitDir,
        ...(this.workTree !== null ? { GIT_WORK_TREE: this.workTree } : {}),
      },
    })
  }

  /** Every id is an object this shadow holds (`cat-file --batch-check`). */
  async has(ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return true
    const r = await this.git(['cat-file', '--batch-check'], {
      stdin: `${ids.map(assertSha).join('\n')}\n`,
    })
    const lines = r.stdout.split(/\r?\n/).filter((l) => l !== '')
    return lines.length === ids.length && lines.every((l) => !/ missing$/.test(l))
  }

  /**
   * The rows of `from..to`: `diff-tree -r -z -M` --raw + --numstat (+ --ignore-cr-at-eol for EOL-only), merged
   * (patch.ts mergeDiff) and given the viewer's facts, in diff-tree order. Cached per commit pair.
   */
  async changes(from: string, to: string): Promise<FileChange[]> {
    const key = `${this.gitDir}\0${this.workTree ?? ''}\0${assertSha(from)}..${assertSha(to)}`
    const hit = changesCache.get(key)
    if (hit !== undefined) return hit
    const base = ['diff-tree', '-r', '-z', '-M', '--no-ext-diff', '--no-textconv']
    const opts = { maxBytes: BIG_OUTPUT }
    const [raw, num, numCr] = await Promise.all([
      this.git([...base, '--raw', from, to], opts),
      this.git([...base, '--numstat', from, to], opts),
      this.git([...base, '--numstat', '--ignore-cr-at-eol', from, to], opts),
    ])
    const scores = new Map(parseRawZ(raw.stdout).map((r) => [r.path, r.score]))
    const rows = mergeDiff(raw.stdout, num.stdout, numCr.stdout).changes.map((c) =>
      withRowFacts(c, scores.get(c.path)),
    )
    changesCache.set(key, rows)
    if (changesCache.size > CHANGES_CACHE_MAX) {
      const first = changesCache.keys().next()
      if (first.done !== true) changesCache.delete(first.value)
    }
    return rows
  }

  /**
   * One file's patch: `diff-tree -r -p -M` limited to its path (both paths of a rename, so the pair is kept), cut at
   * `maxBytes` on a line end (`truncated`). `ignoreEol` is the viewer's "Ignore line endings".
   */
  async filePatch(
    from: string,
    to: string,
    change: Pick<FileChange, 'path' | 'oldPath'>,
    o: { ignoreEol?: boolean; maxBytes?: number } = {},
  ): Promise<DiffFilePatch> {
    const maxBytes = o.maxBytes ?? DIFF_FILE_MAX_BYTES
    const paths = change.oldPath !== undefined ? [change.oldPath, change.path] : [change.path]
    const r = await this.git(
      [
        'diff-tree',
        '-r',
        '-p',
        '-M',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        ...(o.ignoreEol === true ? ['--ignore-cr-at-eol'] : []),
        assertSha(from),
        assertSha(to),
        '--',
        ...paths,
      ],
      { maxBytes, literalPathspecs: true },
    )
    if (!r.truncated) return { patch: r.stdout, truncated: false }
    const nl = r.stdout.lastIndexOf('\n')
    return { patch: nl === -1 ? '' : r.stdout.slice(0, nl + 1), truncated: true }
  }

  /**
   * The whole segment's UI patch (what the controller persists as `diffs/<a>..<b>.patch`), and whether it reached
   * the output cap (`truncated`: not a whole copy).
   */
  async patch(from: string, to: string): Promise<{ text: string; truncated: boolean }> {
    const r = await this.git(
      [
        'diff-tree',
        '-r',
        '-p',
        '-M',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        assertSha(from),
        assertSha(to),
      ],
      { maxBytes: BIG_OUTPUT },
    )
    return { text: r.stdout, truncated: r.truncated }
  }

  /** A blob's size (`cat-file -s`). */
  async blobSize(sha: string): Promise<number> {
    const r = await this.git(['cat-file', '-s', assertSha(sha)])
    const n = Number(r.stdout.trim())
    if (!Number.isFinite(n)) throw new Error(`git cat-file -s printed ${JSON.stringify(r.stdout.trim())}`)
    return n
  }

  /** A blob's bytes (`cat-file blob`), at most `maxBytes` (default the image cap) read. */
  async blob(sha: string, maxBytes: number = DIFF_BLOB_MAX_BYTES): Promise<Buffer> {
    const r = await this.git(['cat-file', 'blob', assertSha(sha)], { binary: true, maxBytes: maxBytes + 1 })
    return r.stdoutBytes ?? Buffer.alloc(0)
  }
}

/** Forget the rows cached for a shadow (Clear snapshots: a shadow made later has other objects). */
export function forgetDiffView(gitDir: string): void {
  const prefix = `${path.resolve(gitDir)}\0`
  for (const key of [...changesCache.keys()]) if (key.startsWith(prefix)) changesCache.delete(key)
}

/** Forget every cached row and file hash (tests). */
export function clearDiffViewCaches(): void {
  changesCache.clear()
  hashCache.clear()
}
