// Finalize an Isolated run (Finalize, Apply, Cleanup): Apply by what
// the folder holds (new blob: no-op; old blob: write or delete; else a conflict), never through a link, only where
// snapshot P holds the folder's content, with a journal that makes [Finish apply] idempotent; Undo restores P;
// Discard is deferred 10 s and undoable.
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readlink, rename, rm, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import type {
  FileChange,
  WorktreeApplyAction,
  WorktreeApplyResult,
  WorktreeConflictChoice,
  WorktreeDiscardResult,
  WorktreePreview,
} from '../../shared/ipc.ts'
import { DimFactoryError, errnoCode, errorMessage } from '../errors.ts'
import { homePaths } from '../home.ts'
import { samePath } from '../real-path.ts'
import { nodeAtomicFs, readJsonFile, writeFileAtomic, writeJsonAtomic } from '../store/atomic.ts'
import { isPlainObject } from '../store/versions.ts'
import { ShadowReader } from './diff-view.ts'
import { MutexMap } from './mutex.ts'
import { parseRawZ } from './patch.ts'
import { resolveScope } from './repo.ts'
import {
  NO_SYMLINKS_REASON,
  UNREADABLE_REASON,
  blockedParent,
  blockedText,
  pruneEmptyParents,
  revertTo,
} from './revert.ts'
import type { Blocker } from './revert.ts'
import { shadowFor } from './shadow.ts'
import type { Shadow } from './shadow.ts'
import { removeWorktree } from './worktree.ts'
import type { RemoveWorktreeResult, WorktreeInfo } from './worktree.ts'

export const FINALIZE_JOURNAL_SCHEMA = 1
/** Discard deletes the worktree 10 s later; until then it can be undone. */
export const DISCARD_DELAY_MS = 10_000
/** Bytes of blobs read from the worktree's shadow per `cat-file --batch`. */
const BLOB_BATCH_BYTES = 64 * 1024 * 1024
const BIG_OUTPUT = 256 * 1024 * 1024
const GITLINK = '160000'
const SYMLINK = '120000'
const ABSENT_MODE = '000000'

export const GITLINK_REASON = 'nested repository (gitlink)'

// ---- the journal ---------------------------------------------------------------------------------------------------

/** What Apply does with one changed path. */
export type ApplyAction = WorktreeApplyAction
/** [Keep mine] keeps the folder's file; [Take run's] writes (or deletes) as the run did. */
export type ConflictResolution = WorktreeConflictChoice
/** What happened to an entry once the apply ran. */
export type ApplyOutcome = 'written' | 'deleted' | 'unchanged' | 'kept' | 'conflict' | 'skipped'

/**
 * What the folder held at a path when the apply was planned (after snapshot P): nothing, a file (its blob id) or a
 * symbolic link (the blob ids of its target's spellings).
 */
export type SeenState = { kind: 'absent' } | { kind: 'file'; sha: string } | { kind: 'link'; shas: string[] }

export interface ApplyEntry {
  /** Scope-relative, `/`-separated. */
  path: string
  /** The run's change (a rename is a delete plus an add). */
  change: 'A' | 'M' | 'D' | 'T'
  oldMode: string
  oldSha: string
  newMode: string
  newSha: string
  /** Decided against the folder before anything was written. */
  action: ApplyAction
  /** Why it is a conflict or is skipped (UI copy). */
  reason?: string
  resolution?: ConflictResolution
  /**
   * The folder's content the decision (and a [Take run's] resolution) was made against; P holds it. A [Take run's]
   * entry is written only while the folder still holds it, so [Finish apply] never overwrites a later edit.
   */
  seen?: SeenState
  outcome?: ApplyOutcome
}

export type ApplyOpState = 'started' | 'planned' | 'applied' | 'undone'

/** One Apply (its own pre-apply snapshot P and Undo token). `started` / `planned` = interrupted. */
export interface ApplyOp {
  token: string
  state: ApplyOpState
  startedAt: number
  endedAt?: number
  /** W.S0 and W.last (commits in the worktree's shadow). */
  from: string
  to: string
  /** The paths the request asked for (absent: every changed path). */
  paths?: string[]
  resolutions?: Record<string, ConflictResolution>
  /** Snapshot P of the folder (`pre-apply`), taken before any write. */
  preApply?: { commit: string; tree: string; unreadable: string[] }
  entries?: ApplyEntry[]
  undo?: { at: number; restored: string[]; deleted: string[]; skipped: { path: string; reason: string }[] }
}

export interface DiscardRecord {
  token: string
  requestedAt: number
  deleteAt: number
  state: 'pending' | 'undone' | 'removed' | 'failed'
  /** What the removal left (notes, copyable commands), or why it failed. */
  notes?: string[]
  at?: number
}

/** The worktree as the journal knows it: `pending` = recorded before `worktree add` (write-ahead). */
export interface WorktreeRecord extends Omit<WorktreeInfo, 'folderKey'> {
  folderKey?: string
  state: 'pending' | 'created' | 'removed'
  at: number
}

/** `runs/<id>/finalize.json`: written only by this module. */
export interface FinalizeJournal {
  schemaVersion: typeof FINALIZE_JOURNAL_SCHEMA
  worktree?: WorktreeRecord
  ops: ApplyOp[]
  discard?: DiscardRecord
}

/** Where a run's journal is read and written. Writes must be durable before they resolve. */
export interface JournalIO {
  read(): Promise<FinalizeJournal>
  write(j: FinalizeJournal): Promise<void>
}

export const emptyJournal = (): FinalizeJournal => ({ schemaVersion: FINALIZE_JOURNAL_SCHEMA, ops: [] })

/** `runs/<runId>/finalize.json` under a home. */
export function journalFile(home: string, runId: string): string {
  return path.join(homePaths(home).run(runId).dir, 'finalize.json')
}

/** A parsed journal, or an empty one for anything that is not one (missing, unreadable, another shape). */
export function parseJournal(v: unknown): FinalizeJournal {
  if (!isPlainObject(v) || v['schemaVersion'] !== FINALIZE_JOURNAL_SCHEMA || !Array.isArray(v['ops'])) {
    return emptyJournal()
  }
  return v as unknown as FinalizeJournal
}

/** The journal as an atomic JSON file (the default for a run: journalFile(home, runId)). */
export function fileJournal(file: string): JournalIO {
  return {
    read: async () => {
      const r = await readJsonFile(file)
      if (r.kind === 'ok') {
        if (isPlainObject(r.value) && typeof r.value['schemaVersion'] === 'number') {
          if (r.value['schemaVersion'] > FINALIZE_JOURNAL_SCHEMA) {
            throw new DimFactoryError('NEWER_SCHEMA', `${file} was written by a newer Dim Factory.`)
          }
        }
        return parseJournal(r.value)
      }
      return emptyJournal()
    },
    write: async (j) => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeJsonAtomic(file, j)
    },
  }
}

/** The op an apply left part way (state `started` or `planned`): the interruptedApply card's subject. */
export function interruptedOp(j: FinalizeJournal): ApplyOp | undefined {
  const last = j.ops[j.ops.length - 1]
  return last !== undefined && (last.state === 'started' || last.state === 'planned') ? last : undefined
}

/** The latest apply that is still in the folder (applied, not undone). */
export function lastAppliedOp(j: FinalizeJournal): ApplyOp | undefined {
  for (let i = j.ops.length - 1; i >= 0; i--) {
    const op = j.ops[i]
    if (op?.state === 'applied') return op
    if (op?.state === 'undone') continue
    return undefined
  }
  return undefined
}

const appliedPathsOf = (op: ApplyOp): string[] =>
  (op.entries ?? []).filter((e) => e.outcome === 'written' || e.outcome === 'deleted').map((e) => e.path)

/** A compact view of the journal for the engine's views (RunSnapshot.finalize, the Dashboard chip). */
export interface FinalizeSummary {
  /**
   * `none`: nothing applied or discarded yet; `interrupted`: an apply stopped part way ([Finish apply]); `applied`: the
   * latest apply is in the folder; `discard-pending`: deleted at `deleteAt` unless undone; `discarded`: the worktree is
   * gone.
   */
  state: 'none' | 'interrupted' | 'applied' | 'discard-pending' | 'discarded'
  worktree?: Pick<WorktreeRecord, 'path' | 'branch' | 'base' | 'state'>
  /** The latest applied (or interrupted) op's token, its applied files and its open conflicts. */
  undoToken?: string
  applied?: number
  conflicts?: string[]
  deleteAt?: number
  discardToken?: string
}

export function summarizeJournal(j: FinalizeJournal): FinalizeSummary {
  const worktree =
    j.worktree !== undefined
      ? { path: j.worktree.path, branch: j.worktree.branch, base: j.worktree.base, state: j.worktree.state }
      : undefined
  const base = worktree !== undefined ? { worktree } : {}
  if (j.discard?.state === 'removed' || j.worktree?.state === 'removed')
    return { state: 'discarded', ...base }
  if (j.discard?.state === 'pending') {
    return { state: 'discard-pending', ...base, deleteAt: j.discard.deleteAt, discardToken: j.discard.token }
  }
  const open = interruptedOp(j)
  if (open !== undefined) return { state: 'interrupted', ...base, undoToken: open.token }
  const done = lastAppliedOp(j)
  if (done !== undefined) {
    const conflicts = (done.entries ?? []).filter((e) => e.outcome === 'conflict').map((e) => e.path)
    return {
      state: 'applied',
      ...base,
      undoToken: done.token,
      applied: appliedPathsOf(done).length,
      conflicts,
    }
  }
  return { state: 'none', ...base }
}

/** Finalized for retention: applied (and not undone) or discarded. */
export function isFinalized(j: FinalizeJournal): boolean {
  const s = summarizeJournal(j).state
  return s === 'applied' || s === 'discarded'
}

/** An apply outcome that leaves nothing of the run's change only in its copy ([Keep mine] is the user's choice). */
const SETTLED: ReadonlySet<ApplyOutcome | undefined> = new Set(['written', 'deleted', 'unchanged', 'kept'])

/**
 * Retention may remove an applied copy only when nothing of the run is left only there: the run's changed
 * paths the applies still in the folder (state `applied`, not undone) did not settle: left out by a selection (`paths`,
 * "Reviewed files only"), an open conflict, or skipped. `changed` is the run's changed paths (W.S0..W.last, renames as
 * a delete and an add, as Apply plans them); absent, the entries of the full applies (no `paths`) stand for them, and
 * `partial` says no full apply is in effect (so the set is not known). Sorted.
 */
export function unsettledPaths(
  j: FinalizeJournal,
  changed?: readonly string[],
): { paths: string[]; partial: boolean } {
  const inEffect = j.ops.filter((o) => o.state === 'applied')
  const latest = new Map<string, ApplyOutcome | undefined>()
  for (const op of inEffect) for (const e of op.entries ?? []) latest.set(e.path, e.outcome)
  const full = inEffect.filter((o) => o.paths === undefined)
  const wanted =
    changed !== undefined
      ? [...new Set(changed)]
      : [...new Set(full.flatMap((o) => (o.entries ?? []).map((e) => e.path)))]
  return {
    paths: wanted.filter((p) => !SETTLED.has(latest.get(p))).sort(),
    partial: changed === undefined && full.length === 0,
  }
}

// ---- targets ---------------------------------------------------------------------------------------------------

/**
 * The worktree as finalize needs it: RunState's `{path, branch, base}` or createWorktree's WorktreeInfo. `folderKey`
 * (its shadow) is read from the path when absent; `commonDir` from the worktree when a removal needs it.
 */
export interface FinalizeWorktree {
  path: string
  branch: string
  base: string
  folderKey?: string
  commonDir?: string
}

/** An Isolated run as finalize sees it. */
export interface FinalizeTarget {
  /** DIM_FACTORY_HOME. */
  home: string
  runId: string
  /** The user's folder the run came from (any folder of the repository): Apply writes the repository's top level. */
  folder: string
  worktree: FinalizeWorktree
  /** W.S0 and W.last: commits in the worktree's shadow (the combined segment's ends). */
  from: string
  to: string
  /** Where the journal lives; default fileJournal(journalFile(home, runId)). */
  journal?: JournalIO
  now?: () => number
  platform?: NodeJS.Platform
}

const ioOf = (t: FinalizeTarget): JournalIO => t.journal ?? fileJournal(journalFile(t.home, t.runId))
const nowOf = (t: FinalizeTarget): number => (t.now ?? Date.now)()

const runLocks = new MutexMap()
/** One finalize operation per run at a time (apply, undo, discard). */
function withRunLock<T>(t: FinalizeTarget, fn: () => Promise<T>): Promise<T> {
  return runLocks.run(`${path.resolve(t.home)}\0${t.runId}`, fn)
}

/** Record the worktree in the journal (createWorktree's `onIntent` with `pending`, its result with `created`). */
export async function recordWorktree(
  io: JournalIO,
  w: Omit<WorktreeInfo, 'folderKey'> & { folderKey?: string },
  state: WorktreeRecord['state'],
  at: number = Date.now(),
): Promise<FinalizeJournal> {
  const j = await io.read()
  const next: FinalizeJournal = { ...j, worktree: { ...w, state, at } }
  await io.write(next)
  return next
}

/** The target's worktree with its shadow key; CONFLICT once the journal says it was discarded. */
interface ResolvedWorktree extends FinalizeWorktree {
  folderKey: string
}

function assertNotDiscarded(j: FinalizeJournal): void {
  if (j.discard?.state === 'removed' || j.worktree?.state === 'removed') {
    throw new DimFactoryError(
      'CONFLICT',
      "This run's worktree was discarded, so there is nothing left to apply.",
    )
  }
}

async function worktreeOf(t: FinalizeTarget, j: FinalizeJournal): Promise<ResolvedWorktree> {
  assertNotDiscarded(j)
  const w = t.worktree
  if (w.folderKey !== undefined) return { ...w, folderKey: w.folderKey }
  const there = await lstat(w.path).then(
    (s) => s.isDirectory(),
    () => false,
  )
  if (!there) throw new DimFactoryError('NOT_FOUND', `This run's worktree (${w.path}) is gone.`)
  return { ...w, folderKey: (await resolveScope(w.path, t.platform)).folderKey }
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
function assertCommit(sha: string, what: string): string {
  if (!SHA_RE.test(sha)) throw new DimFactoryError('VALIDATION', `invalid ${what}: ${JSON.stringify(sha)}`)
  return sha
}

/** The worktree's shadow (by folder key; read with GIT_DIR, the worktree as work tree while it exists). */
async function runReader(t: FinalizeTarget, wt: ResolvedWorktree): Promise<ShadowReader> {
  const reader = await ShadowReader.open(homePaths(t.home).shadowRepo(wt.folderKey), wt.path)
  if (reader === null || !(await reader.has([assertCommit(t.from, 'start'), assertCommit(t.to, 'end')]))) {
    throw new DimFactoryError('NOT_FOUND', "This run's snapshots are gone, so its changes cannot be applied.")
  }
  return reader
}

// ---- the folder ----------------------------------------------------------------------------------------------------

type FolderState =
  | { kind: 'absent' }
  | { kind: 'file'; sha: string; exec: boolean }
  | { kind: 'link'; shas: string[] }
  | { kind: 'dir' }
  | { kind: 'other' }
  | { kind: 'unreadable'; error: string }
  | { kind: 'blocked'; reason: string }

const algoOf = (sha: string): 'sha1' | 'sha256' => (sha.length === 64 ? 'sha256' : 'sha1')

function blobId(algo: 'sha1' | 'sha256', bytes: Buffer): string {
  return createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** What is at `abs` now, as git would see it (a blob id of the exact bytes; a link's target). */
async function folderState(
  abs: string,
  algo: 'sha1' | 'sha256',
  platform: NodeJS.Platform,
): Promise<FolderState> {
  let s: Stats
  try {
    s = await lstat(abs)
  } catch (err) {
    // ENOTDIR: a parent is a file (the blocked check reports it first).
    const code = errnoCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'unreadable', error: errorMessage(err) }
  }
  if (s.isSymbolicLink()) {
    const target = await readlink(abs).catch(() => null)
    if (target === null) return { kind: 'unreadable', error: 'the link could not be read' }
    const spellings = platform === 'win32' ? [target, target.replace(/\\/g, '/')] : [target]
    return { kind: 'link', shas: spellings.map((x) => blobId(algo, Buffer.from(x, 'utf8'))) }
  }
  if (s.isDirectory()) return { kind: 'dir' }
  if (!s.isFile()) return { kind: 'other' }
  const h = createHash(algo).update(`blob ${s.size}\0`)
  try {
    for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer)
  } catch (err) {
    return { kind: 'unreadable', error: errorMessage(err) }
  }
  return { kind: 'file', sha: h.digest('hex'), exec: (s.mode & 0o100) !== 0 }
}

/** Does the folder hold this side (mode + blob; absent for mode 000000)? The exec bit counts on POSIX only. */
function holds(st: FolderState, mode: string, sha: string, platform: NodeJS.Platform): boolean {
  if (mode === ABSENT_MODE || /^0+$/.test(sha)) return st.kind === 'absent'
  if (mode === SYMLINK) return st.kind === 'link' && st.shas.includes(sha)
  if (st.kind !== 'file' || st.sha !== sha) return false
  return platform === 'win32' || st.exec === (mode === '100755')
}

/** The folder's state as an entry records it (undefined for anything Apply never writes over). */
function seenOf(st: FolderState): SeenState | undefined {
  if (st.kind === 'absent') return { kind: 'absent' }
  if (st.kind === 'file') return { kind: 'file', sha: st.sha }
  if (st.kind === 'link') return { kind: 'link', shas: [...st.shas] }
  return undefined
}

/** Does the folder still hold what the entry was decided against? */
function stillSeen(st: FolderState, seen: SeenState | undefined): boolean {
  if (seen === undefined) return false
  switch (seen.kind) {
    case 'absent':
      return st.kind === 'absent'
    case 'file':
      return st.kind === 'file' && st.sha === seen.sha
    case 'link':
      return st.kind === 'link' && st.shas.some((x) => seen.shas.includes(x))
  }
}

/** Why a path from the run's tree must not be written in the user's folder (undefined when it may). */
export function unsafeRunPath(rel: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const bad = 'it is not a plain path inside the folder'
  if (rel === '' || rel.startsWith('/') || rel.includes('\0') || /^[A-Za-z]:/.test(rel)) return bad
  if (platform === 'win32' && /[\\:*?"<>|]/.test(rel)) return bad
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return bad
    // NTFS drops trailing dots and spaces: `.git.` is `.git`.
    const name = platform === 'win32' ? seg.replace(/[. ]+$/, '') : seg
    if (/^\.git$/i.test(name) || (platform === 'win32' && /^git~\d+$/i.test(name))) {
      return 'it is inside a .git folder, which Dim Factory never writes'
    }
  }
  return undefined
}

const fold = (p: string, on: boolean): string => (on ? p.toLowerCase() : p)

/** A conflict's reason (UI copy): what the folder holds instead of the run's starting point. */
function conflictReason(e: Pick<ApplyEntry, 'change'>, st: FolderState): string {
  if (st.kind === 'absent') return 'It was deleted in the folder after the run started.'
  if (e.change === 'A') return 'The folder has a different file at this path.'
  if (e.change === 'D') return 'It was changed in the folder after the run started; the run deleted it.'
  return 'It was changed in the folder after the run started.'
}

interface PlanContext {
  root: string
  platform: NodeJS.Platform
  caseInsensitive: boolean
  /** Folded paths the apply deletes first: an add there sees no file; a file there is no blocker for a path under it. */
  deleting: Set<string>
  parents: Map<string, Blocker | null>
  /**
   * The run's worktree (while it exists): a path its snapshot reached through a link there (git for Windows reads a
   * junction's target as a folder) is a file outside the project, never copied into the folder.
   */
  worktree?: { root: string; parents: Map<string, Blocker | null> }
}

async function blockerFor(ctx: PlanContext, rel: string): Promise<string | undefined> {
  const b = await blockedParent(ctx.root, rel, ctx.parents)
  if (b === undefined) return undefined
  if (!b.link && ctx.deleting.has(fold(b.prefix, ctx.caseInsensitive))) return undefined
  return blockedText(b)
}

/** Decide one change against the folder as it is (and the deletes this apply makes first). */
async function decide(ctx: PlanContext, e: ApplyEntry): Promise<ApplyEntry> {
  const out: ApplyEntry = { ...e }
  delete out.reason
  delete out.outcome
  if (e.oldMode === GITLINK || e.newMode === GITLINK)
    return { ...out, action: 'skip', reason: GITLINK_REASON }
  const unsafe = unsafeRunPath(e.path, ctx.platform)
  if (unsafe !== undefined) return { ...out, action: 'skip', reason: `Dim Factory leaves it: ${unsafe}.` }
  const blocked = await blockerFor(ctx, e.path)
  if (blocked !== undefined) return { ...out, action: 'skip', reason: blocked }
  if (ctx.worktree !== undefined) {
    const w = await blockedParent(ctx.worktree.root, e.path, ctx.worktree.parents)
    if (w?.link === true) {
      return {
        ...out,
        action: 'skip',
        reason: `in the run's copy a link is in the place of its folder ${w.prefix}`,
      }
    }
  }
  const abs = path.join(ctx.root, ...e.path.split('/'))
  let st = await folderState(abs, algoOf(e.newSha === '' ? e.oldSha : e.newSha), ctx.platform)
  // A case-only rename on a case-insensitive volume: the add finds the file the delete removes first.
  if (e.change === 'A' && st.kind !== 'absent' && ctx.deleting.has(fold(e.path, ctx.caseInsensitive))) {
    st = { kind: 'absent' }
  }
  const seen = seenOf(st)
  if (seen !== undefined) out.seen = seen
  if (st.kind === 'unreadable') {
    return { ...out, action: 'skip', reason: `Dim Factory could not read it in the folder: ${st.error}` }
  }
  if (st.kind === 'dir') return { ...out, action: 'skip', reason: 'a folder is in its place' }
  if (st.kind === 'other')
    return { ...out, action: 'skip', reason: 'something other than a file is in its place' }
  if (holds(st, e.newMode, e.newSha, ctx.platform)) return { ...out, action: 'noop' }
  if (holds(st, e.oldMode, e.oldSha, ctx.platform))
    return { ...out, action: e.change === 'D' ? 'delete' : 'write' }
  return { ...out, action: 'conflict', reason: conflictReason(e, st) }
}

/** `under(paths)`: a path listed, or inside a listed folder. */
function selector(paths: readonly string[] | undefined, ci: boolean): (p: string) => boolean {
  if (paths === undefined) return () => true
  const set = new Set(paths.map((x) => fold(x.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), ci)))
  return (p) => {
    const n = fold(p, ci)
    if (set.has(n)) return true
    for (let i = n.indexOf('/'); i !== -1; i = n.indexOf('/', i + 1)) if (set.has(n.slice(0, i))) return true
    return false
  }
}

/**
 * A selection with both sides of every rename it names (the Diff tab lists a rename once, by its new path): applying
 * only the add of a rename would copy the file, only the delete would lose it.
 */
async function withRenamePartners(
  reader: ShadowReader,
  t: Pick<FinalizeTarget, 'from' | 'to'>,
  paths: readonly string[] | undefined,
  ci: boolean,
): Promise<readonly string[] | undefined> {
  if (paths === undefined) return undefined
  const picked = selector(paths, ci)
  const out = [...paths]
  for (const row of await reader.changes(t.from, t.to)) {
    if (row.oldPath === undefined) continue
    if (picked(row.path) && !picked(row.oldPath)) out.push(row.oldPath)
    else if (picked(row.oldPath) && !picked(row.path)) out.push(row.path)
  }
  return out
}

/** The run's changes, one entry per path (`diff-tree -r --no-renames`: a rename is a delete and an add). */
async function runChanges(reader: ShadowReader, from: string, to: string): Promise<ApplyEntry[]> {
  const r = await reader.git(['diff-tree', '-r', '-z', '--no-renames', '--raw', '--no-ext-diff', from, to], {
    maxBytes: BIG_OUTPUT,
  })
  return parseRawZ(r.stdout).map((c): ApplyEntry => ({
    path: c.path,
    change: c.status === 'A' || c.status === 'D' || c.status === 'T' ? c.status : 'M',
    oldMode: c.oldMode,
    oldSha: c.oldSha,
    newMode: c.newMode,
    newSha: c.newSha,
    action: 'noop',
  }))
}

/** The folder Apply writes: the repository's top level, and whether its volume folds case. */
interface FolderRoot {
  root: string
  caseInsensitive: boolean
}

async function folderRoot(t: FinalizeTarget): Promise<FolderRoot> {
  const scope = await resolveScope(t.folder, t.platform).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT')
      throw new DimFactoryError('NOT_FOUND', `The folder ${t.folder} no longer exists.`)
    throw err
  })
  // A copy made from a snapshot (no branch) may come from a folder that is not a repository. What must still hold is
  // that the folder's root is the one the snapshot was taken of: a repository made or removed around the folder since
  // then moves that root, and the copy's paths would land somewhere else.
  if (t.worktree.branch === '') {
    const made = (await ioOf(t).read()).worktree?.folder
    if (made !== undefined && made !== '' && !samePath(made, scope.scopeRoot)) {
      throw new DimFactoryError(
        'CONFLICT',
        `A git repository was made or removed around ${t.folder} since this copy was made, so its changes cannot be applied there.`,
      )
    }
    return { root: scope.scopeRoot, caseInsensitive: scope.caseInsensitive }
  }
  if (!scope.isRepo) throw new DimFactoryError('CONFLICT', `${t.folder} is no longer a git repository.`)
  return { root: scope.scopeRoot, caseInsensitive: scope.caseInsensitive }
}

/**
 * Decide every selected change against the folder: deletes first (an add or a path under a deleted file depends on
 * them), then the rest. Resolutions apply to conflicts only.
 */
async function plan(
  t: FinalizeTarget,
  fr: FolderRoot,
  reader: ShadowReader,
  sel: { paths?: readonly string[]; resolutions?: Readonly<Record<string, ConflictResolution>> },
): Promise<ApplyEntry[]> {
  const platform = t.platform ?? process.platform
  const ci = fr.caseInsensitive
  const picked = selector(await withRenamePartners(reader, t, sel.paths, ci), ci)
  const all = (await runChanges(reader, t.from, t.to)).filter((e) => picked(e.path))
  const wtThere = await lstat(t.worktree.path).then(
    (st) => st.isDirectory(),
    () => false,
  )
  const ctx: PlanContext = {
    root: fr.root,
    platform,
    caseInsensitive: ci,
    deleting: new Set(),
    parents: new Map(),
    ...(wtThere ? { worktree: { root: t.worktree.path, parents: new Map() } } : {}),
  }
  const resolution = (p: string): ConflictResolution | undefined => {
    const r = sel.resolutions
    if (r === undefined) return undefined
    const hit = r[p] ?? Object.entries(r).find(([k]) => fold(k, ci) === fold(p, ci))?.[1]
    return hit === 'mine' || hit === 'theirs' ? hit : undefined
  }
  const decided = new Map<ApplyEntry, ApplyEntry>()
  for (const e of all.filter((x) => x.change === 'D')) {
    const d = await decide(ctx, e)
    const r = d.action === 'conflict' ? resolution(e.path) : undefined
    if (r !== undefined) d.resolution = r
    if (d.action === 'delete' || (d.action === 'conflict' && r === 'theirs'))
      ctx.deleting.add(fold(e.path, ci))
    decided.set(e, d)
  }
  ctx.parents.clear()
  for (const e of all.filter((x) => x.change !== 'D')) {
    const d = await decide(ctx, e)
    const r = d.action === 'conflict' ? resolution(e.path) : undefined
    if (r !== undefined) d.resolution = r
    decided.set(e, d)
  }
  return all.map((e) => decided.get(e) ?? e)
}

// ---- preview -------------------------------------------------------------------------------------------------------

/** One file's action in a preview (WorktreePreview.actions). */
export interface PreviewAction {
  path: string
  action: ApplyAction
  reason?: string
}

/**
 * What Apply would do now, writing nothing: the run's files (with renames, as the Diff tab shows
 * them), the paths that conflict, and each changed path's action (noop | write | delete | conflict | skip, with its
 * reason). `paths` limits it as applyRun's would.
 */
export async function previewApply(
  t: FinalizeTarget,
  opts: { paths?: readonly string[] } = {},
): Promise<WorktreePreview & { actions: PreviewAction[] }> {
  const j = await ioOf(t).read()
  const wt = await worktreeOf(t, j)
  const reader = await runReader(t, wt)
  const fr = await folderRoot(t)
  const [files, entries] = await Promise.all([
    reader.changes(t.from, t.to),
    plan(t, fr, reader, opts.paths !== undefined ? { paths: opts.paths } : {}),
  ])
  const actions = entries.map((e) => ({
    path: e.path,
    action: e.action,
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
  }))
  const picked = selector(opts.paths, fr.caseInsensitive)
  const shown: FileChange[] =
    opts.paths === undefined
      ? files
      : files.filter((f) => picked(f.path) || (f.oldPath !== undefined && picked(f.oldPath)))
  return {
    files: shown,
    conflicts: actions.filter((a) => a.action === 'conflict').map((a) => a.path),
    actions,
  }
}

// ---- apply ---------------------------------------------------------------------------------------------------------

export interface ApplyOptions {
  /** Scope-relative paths (files, or folders meaning everything under them); absent: every changed path. */
  paths?: readonly string[]
  /** Per conflicting path: keep the folder's file (`mine`) or take the run's (`theirs`). */
  resolutions?: Readonly<Record<string, ConflictResolution>>
  /**
   * Test hook: called after each journaled step (`started`, `snapshot`, `planned`, `deleted`, `written`), so a test
   * can stop the apply there as a crash would (a throw aborts it with the journal as it is). `file` comes after each
   * file the apply itself deleted or wrote (between files: the E2E hook pauses there, so the app can be killed with
   * part of the folder written). `temp` comes when a file's new bytes are in their temp file next to it, just before
   * the rename that puts them in place (a kill there leaves the temp file, which [Finish apply] removes).
   */
  onStep?: (step: ApplyStep) => Promise<void> | void
}

export type ApplyStep = 'started' | 'snapshot' | 'planned' | 'deleted' | 'written' | 'file' | 'temp'

export interface ApplyResult extends WorktreeApplyResult {
  /** Written from the run's version (a conflict taken as the run's included). */
  written: string[]
  /** Deleted as the run did. */
  deleted: string[]
  /** Already as the run left them. */
  unchanged: string[]
  /** Conflicts resolved [Keep mine]. */
  kept: string[]
  /** Left alone, with why: gitlinks, a link or file in the place of a folder, unreadable, unsafe paths. */
  skipped: { path: string; reason: string }[]
  /** This call finished an apply a crash had stopped (its own request, P and token). */
  resumed: boolean
  /** The pre-apply snapshot P (a commit in the folder's shadow). */
  preApply: string
  /** The open conflicts with why each is one (UI copy). */
  conflictDetails: { path: string; reason: string }[]
}

const randomToken = (prefix: string): string => `${prefix}-${randomBytes(9).toString('hex')}`

async function folderShadow(t: FinalizeTarget): Promise<Shadow> {
  return shadowFor(await resolveScope(t.folder, t.platform), { home: t.home })
}

/** Blob bytes from the worktree's shadow, in batches (`cat-file --batch`), as `use(sha, bytes)` per blob. */
async function forEachBlob(
  reader: ShadowReader,
  shas: readonly string[],
  use: (sha: string, bytes: Buffer) => Promise<void>,
): Promise<void> {
  const unique = [...new Set(shas)]
  if (unique.length === 0) return
  const check = await reader.git(['cat-file', '--batch-check'], {
    stdin: `${unique.join('\n')}\n`,
    maxBytes: BIG_OUTPUT,
  })
  const sizes = new Map<string, number>()
  for (const line of check.stdout.split(/\r?\n/)) {
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(line)
    if (m !== null) sizes.set(m[1] ?? '', Number(m[2]))
  }
  const missing = unique.filter((s) => !sizes.has(s))
  if (missing.length > 0) {
    throw new DimFactoryError(
      'NOT_FOUND',
      `The run's snapshot is missing ${missing.length} file(s), so it cannot be applied.`,
    )
  }
  let batch: string[] = []
  let bytes = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const r = await reader.git(['cat-file', '--batch'], {
      stdin: `${batch.join('\n')}\n`,
      binary: true,
      maxBytes: bytes + batch.length * 128 + 1024,
    })
    const out = r.stdoutBytes ?? Buffer.alloc(0)
    let at = 0
    for (const sha of batch) {
      const nl = out.indexOf(0x0a, at)
      const header = out.subarray(at, nl).toString('utf8')
      const m = /^([0-9a-f]+) blob (\d+)$/.exec(header)
      if (nl < 0 || m === null || m[1] !== sha)
        throw new DimFactoryError('GIT', `git cat-file returned an unexpected record for ${sha}.`)
      const size = Number(m[2])
      await use(sha, out.subarray(nl + 1, nl + 1 + size))
      at = nl + 1 + size + 1
    }
    batch = []
    bytes = 0
  }
  for (const sha of unique) {
    const size = sizes.get(sha) ?? 0
    if (batch.length > 0 && bytes + size > BLOB_BATCH_BYTES) await flush()
    batch.push(sha)
    bytes += size
  }
  await flush()
}

/** A temp name next to `abs`, as writeFileAtomic makes them (`<name>.<pid>.<8 hex>.tmp`; see removeLeftoverTemps). */
const tempNextTo = (abs: string): string => `${abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`

/** The folder's file was removed for a link that could then not be put in its place: Undo restores it from P. */
class RemovedForLink extends Error {
  constructor(why: unknown) {
    super(`the file was removed, but the link could not be made: ${errorMessage(why)}`)
  }
}

/**
 * Write one blob into the folder: an atomic file write (umask applies; exec as the mode says) or a link. A link is
 * made under a temp name first and renamed over the path, so a volume that cannot hold links (or an account that may
 * not make them) leaves the folder's file untouched. Only where a rename cannot replace the file (a directory link on
 * Windows) is the file removed first; if the link still cannot be put there, RemovedForLink says so.
 */
async function writeEntry(
  abs: string,
  e: ApplyEntry,
  bytes: Buffer,
  platform: NodeJS.Platform,
  onStep: ApplyOptions['onStep'],
): Promise<void> {
  if (e.newMode === SYMLINK) {
    const target = bytes.toString('utf8')
    let type: 'file' | 'dir' | undefined
    if (platform === 'win32') {
      const dest = path.resolve(path.dirname(abs), target)
      type = (await stat(dest).then(
        (s) => s.isDirectory(),
        () => false,
      ))
        ? 'dir'
        : 'file'
    }
    await mkdir(path.dirname(abs), { recursive: true, mode: 0o777 })
    const tmp = tempNextTo(abs)
    await symlink(target, tmp, type)
    try {
      await onStep?.('temp')
      try {
        await rename(tmp, abs)
        return
      } catch (err) {
        const here = await lstat(abs).catch(() => null)
        if (here === null || here.isDirectory()) throw err
      }
      await rm(abs, { force: true })
      try {
        await rename(tmp, abs)
      } catch (err) {
        throw new RemovedForLink(err)
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
    return
  }
  const exec = e.newMode === '100755'
  await writeFileAtomic(abs, bytes, {
    mode: exec ? 0o777 : 0o666,
    dirMode: 0o777,
    ...(onStep !== undefined
      ? {
          fs: {
            ...nodeAtomicFs,
            rename: async (from: string, to: string) => {
              await onStep('temp')
              await nodeAtomicFs.rename(from, to)
            },
          },
        }
      : {}),
  })
}

/**
 * [Finish apply]: temp files a killed apply left next to the files it was writing (`<name>.<digits>.<8 hex>.tmp`,
 * regular files or links only, never under a link or junction) are removed before it carries on.
 */
async function removeLeftoverTemps(fr: FolderRoot, entries: readonly ApplyEntry[]): Promise<void> {
  const dirs = new Map<string, Set<string>>()
  const parents = new Map<string, Blocker | null>()
  for (const e of entries) {
    if (e.change === 'D' || e.newMode === ABSENT_MODE) continue
    if (!(e.action === 'write' || (e.action === 'conflict' && e.resolution === 'theirs'))) continue
    if ((await blockedParent(fr.root, e.path, parents)) !== undefined) continue
    const parts = e.path.split('/')
    const dirRel = parts.slice(0, -1).join('/')
    const names = dirs.get(dirRel) ?? new Set<string>()
    names.add(parts[parts.length - 1] ?? '')
    dirs.set(dirRel, names)
  }
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const [dirRel, names] of dirs) {
    const dir = path.join(fr.root, ...dirRel.split('/').filter((x) => x !== ''))
    const listing = await readdir(dir).catch(() => [] as string[])
    const res = [...names].map(
      (n) => new RegExp(`^${esc(n)}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`, fr.caseInsensitive ? 'i' : ''),
    )
    for (const name of listing) {
      if (!res.some((re) => re.test(name))) continue
      const abs = path.join(dir, name)
      const st = await lstat(abs).catch(() => null)
      if (st === null || !(st.isFile() || st.isSymbolicLink())) continue
      await rm(abs, { force: true }).catch(() => undefined)
    }
  }
}

/**
 * Carry out the decisions, checking each path against the folder again first (so a resumed apply, or a file the user
 * changed since the plan, is handled the same way: already the run's -> done; still the run's start -> do it; else a
 * conflict). Deletes first (emptied folders pruned up to the first link), then writes.
 */
async function execute(
  t: FinalizeTarget,
  reader: ShadowReader,
  fr: FolderRoot,
  entries: readonly ApplyEntry[],
  onStep: ApplyOptions['onStep'],
): Promise<ApplyEntry[]> {
  const platform = t.platform ?? process.platform
  const root = fr.root
  const ci = fr.caseInsensitive
  const ctx: PlanContext = { root, platform, caseInsensitive: ci, deleting: new Set(), parents: new Map() }
  const out = entries.map((e) => ({ ...e }))
  const take = (e: ApplyEntry): boolean =>
    e.action === 'write' || e.action === 'delete' || (e.action === 'conflict' && e.resolution === 'theirs')
  for (const e of out) {
    if (e.action === 'noop') e.outcome = 'unchanged'
    else if (e.action === 'skip') e.outcome = 'skipped'
    else if (e.action === 'conflict' && e.resolution === 'mine') e.outcome = 'kept'
    else if (e.action === 'conflict' && e.resolution !== 'theirs') e.outcome = 'conflict'
    if (take(e) && (e.change === 'D' || e.newMode === ABSENT_MODE)) ctx.deleting.add(fold(e.path, ci))
  }
  /**
   * Now: done already, still to do, or changed since the plan (a conflict; a [Take run's] still holds only while the
   * folder has what it was chosen against).
   */
  const recheck = async (e: ApplyEntry): Promise<'done' | 'do' | FolderState> => {
    const blocked = await blockerFor({ ...ctx, parents: new Map() }, e.path)
    if (blocked !== undefined) return { kind: 'blocked', reason: blocked }
    const st = await folderState(
      path.join(root, ...e.path.split('/')),
      algoOf(e.newSha === '' || /^0+$/.test(e.newSha) ? e.oldSha : e.newSha),
      platform,
    )
    if (holds(st, e.newMode, e.newSha, platform)) return 'done'
    if (st.kind === 'unreadable' || st.kind === 'dir' || st.kind === 'other') return st
    // [Take run's] was chosen against what the folder held then (P holds it): a later edit is asked about again.
    if (e.action === 'conflict') return stillSeen(st, e.seen) ? 'do' : st
    if (holds(st, e.oldMode, e.oldSha, platform)) return 'do'
    return st
  }
  const settle = (e: ApplyEntry, st: FolderState): void => {
    if (st.kind === 'blocked') {
      e.outcome = 'skipped'
      e.reason = st.reason
    } else if (st.kind === 'dir') {
      e.outcome = 'skipped'
      e.reason = 'a folder is in its place'
    } else if (st.kind === 'unreadable') {
      e.outcome = 'skipped'
      e.reason = `Dim Factory could not read it in the folder: ${st.error}`
    } else if (st.kind === 'other') {
      e.outcome = 'skipped'
      e.reason = 'something other than a file is in its place'
    } else {
      e.outcome = 'conflict'
      e.reason = conflictReason(e, st)
    }
  }
  // 1. deletes
  for (const e of out) {
    if (!take(e) || !(e.change === 'D' || e.newMode === ABSENT_MODE)) continue
    const now = await recheck(e)
    if (now === 'done') {
      e.outcome = 'deleted'
      continue
    }
    if (now !== 'do') {
      settle(e, now)
      continue
    }
    const abs = path.join(root, ...e.path.split('/'))
    try {
      await rm(abs, { force: true })
      e.outcome = 'deleted'
      await pruneEmptyParents(root, e.path)
    } catch (err) {
      e.outcome = 'skipped'
      e.reason = `could not delete: ${errorMessage(err)}`
    }
    if (e.outcome === 'deleted') await onStep?.('file')
  }
  await onStep?.('deleted')
  // 2. writes (blob bytes read in batches from the worktree's shadow)
  const writes = out.filter((e) => take(e) && !(e.change === 'D' || e.newMode === ABSENT_MODE))
  const bySha = new Map<string, ApplyEntry[]>()
  for (const e of writes) bySha.set(e.newSha, [...(bySha.get(e.newSha) ?? []), e])
  await forEachBlob(reader, [...bySha.keys()], async (sha, bytes) => {
    for (const e of bySha.get(sha) ?? []) {
      const now = await recheck(e)
      if (now === 'done') {
        e.outcome = 'written'
        continue
      }
      if (now !== 'do') {
        settle(e, now)
        continue
      }
      const abs = path.join(root, ...e.path.split('/'))
      try {
        // Only the exec bit changed (POSIX): the bytes are already the run's.
        const st = await folderState(abs, algoOf(e.newSha), platform)
        if (e.newMode !== SYMLINK && st.kind === 'file' && st.sha === e.newSha && platform !== 'win32') {
          const cur = (await lstat(abs)).mode & 0o777
          const want = e.newMode === '100755' ? cur | ((cur & 0o444) >> 2) : cur & ~0o111
          await chmod(abs, want)
        } else {
          await writeEntry(abs, e, bytes, platform, onStep)
        }
        e.outcome = 'written'
      } catch (err) {
        if (err instanceof RemovedForLink) {
          // The file is gone and P holds it: recorded as deleted, so Undo puts it back.
          e.outcome = 'deleted'
          e.reason = err.message
          continue
        }
        e.outcome = 'skipped'
        const code = errnoCode(err)
        e.reason =
          e.newMode === SYMLINK && (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS')
            ? NO_SYMLINKS_REASON
            : `could not write: ${errorMessage(err)}`
      }
      if (e.outcome === 'written') await onStep?.('file')
    }
  })
  await onStep?.('written')
  return out
}

function resultOf(op: ApplyOp, resumed: boolean): ApplyResult {
  const entries = op.entries ?? []
  const pick = (o: ApplyOutcome): string[] => entries.filter((e) => e.outcome === o).map((e) => e.path)
  return {
    applied: appliedPathsOf(op),
    conflicts: pick('conflict'),
    undoToken: op.token,
    written: pick('written'),
    deleted: pick('deleted'),
    unchanged: pick('unchanged'),
    kept: pick('kept'),
    skipped: entries
      .filter((e) => e.outcome === 'skipped')
      .map((e) => ({ path: e.path, reason: e.reason ?? 'left alone' })),
    resumed,
    preApply: op.preApply?.commit ?? '',
    conflictDetails: entries
      .filter((e) => e.outcome === 'conflict')
      .map((e) => ({
        path: e.path,
        reason: e.reason ?? 'It was changed in the folder after the run started.',
      })),
  }
}

async function replaceOp(io: JournalIO, j: FinalizeJournal, op: ApplyOp): Promise<FinalizeJournal> {
  const ops = j.ops.some((o) => o.token === op.token)
    ? j.ops.map((o) => (o.token === op.token ? op : o))
    : [...j.ops, op]
  const next = { ...j, ops }
  await io.write(next)
  return next
}

/** `ls-tree -r` of a tree in a shadow: each path (case-folded when `ci`) with its mode and blob. */
async function treeEntries(
  sh: Shadow,
  tree: string,
  ci: boolean,
): Promise<Map<string, { mode: string; sha: string }>> {
  const ls = await sh.git(['ls-tree', '-r', '-z', '--full-tree', tree], { maxBytes: BIG_OUTPUT })
  const out = new Map<string, { mode: string; sha: string }>()
  for (const rec of ls.stdout.split('\0')) {
    const m = /^(\d{6}) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(rec)
    if (m !== null) out.set(fold(m[3] ?? '', ci), { mode: m[1] ?? '', sha: m[2] ?? '' })
  }
  return out
}

export const NOT_SAVED_REASON =
  'its current content could not be saved first (too large or unreadable), so Undo could not bring it back'

/**
 * The paths an op may write or delete in the folder (its selection of the run's changes, gitlinks and unsafe paths
 * left out): snapshot P adds them even when the folder's own ignore rules leave them out.
 */
async function opPaths(
  t: FinalizeTarget,
  fr: FolderRoot,
  reader: ShadowReader,
  paths: readonly string[] | undefined,
): Promise<string[]> {
  const platform = t.platform ?? process.platform
  const picked = selector(await withRenamePartners(reader, t, paths, fr.caseInsensitive), fr.caseInsensitive)
  return (await runChanges(reader, t.from, t.to))
    .filter(
      (e) =>
        picked(e.path) &&
        e.oldMode !== GITLINK &&
        e.newMode !== GITLINK &&
        unsafeRunPath(e.path, platform) === undefined,
    )
    .map((e) => e.path)
}

/**
 * Does P hold what the folder holds at the entry's path (so Undo can put it back)? Only for entries the op may write
 * or delete over an existing file or link; an add to an empty path needs nothing saved.
 */
function savedInP(
  e: ApplyEntry,
  saved: ReadonlyMap<string, { mode: string; sha: string }>,
  ci: boolean,
): boolean {
  const takes =
    e.action === 'write' || e.action === 'delete' || (e.action === 'conflict' && e.resolution !== 'mine')
  if (!takes) return true
  const seen = e.seen
  if (seen === undefined) return false
  if (seen.kind === 'absent') return true
  const p = saved.get(fold(e.path, ci))
  if (p === undefined) return false
  if (seen.kind === 'link') return p.mode === SYMLINK && seen.shas.includes(p.sha)
  return p.mode !== SYMLINK && p.mode !== GITLINK && p.sha === seen.sha
}

/**
 * Carry an op from wherever it stopped to `applied`: P (with every path the op may touch, ignored ones included),
 * then the plan (an entry whose folder content P does not hold is left alone, since Undo could not restore it), then
 * the writes (each journaled first). A resumed op first removes the temp files a kill left beside its writes.
 */
async function runOp(
  t: FinalizeTarget,
  io: JournalIO,
  j0: FinalizeJournal,
  wt: ResolvedWorktree,
  start: ApplyOp,
  onStep: ApplyOptions['onStep'],
  opened?: ShadowReader,
): Promise<ApplyOp> {
  let j = j0
  let op = start
  const target = { ...t, from: op.from, to: op.to }
  const reader = opened ?? (await runReader(target, wt))
  const fr = await folderRoot(t)
  const sh = await folderShadow(t)
  if (op.preApply === undefined) {
    const force = await opPaths(target, fr, reader, op.paths)
    const p = await sh.snapshot(t.runId, 'pre-apply', { force })
    op = { ...op, preApply: { commit: p.commit, tree: p.tree, unreadable: p.unreadable } }
    j = await replaceOp(io, j, op)
    await onStep?.('snapshot')
  }
  if (op.entries === undefined) {
    const sel = {
      ...(op.paths !== undefined ? { paths: op.paths } : {}),
      ...(op.resolutions !== undefined ? { resolutions: op.resolutions } : {}),
    }
    // Paths the snapshot could not read are left alone: their bytes are in no snapshot, so Undo could not restore them.
    const notRead = op.preApply?.unreadable ?? []
    const unreadable = selector(notRead, fr.caseInsensitive)
    const saved = await treeEntries(sh, op.preApply?.tree ?? '', fr.caseInsensitive)
    const entries = (await plan(target, fr, reader, sel)).map((e): ApplyEntry => {
      const touches = e.action === 'write' || e.action === 'delete' || e.action === 'conflict'
      if (touches && unreadable(e.path)) return { ...e, action: 'skip', reason: UNREADABLE_REASON }
      if (!savedInP(e, saved, fr.caseInsensitive)) return { ...e, action: 'skip', reason: NOT_SAVED_REASON }
      return e
    })
    op = { ...op, state: 'planned', entries }
    j = await replaceOp(io, j, op)
    await onStep?.('planned')
  } else {
    await removeLeftoverTemps(fr, op.entries)
  }
  const done = await execute(target, reader, fr, op.entries ?? [], onStep)
  op = { ...op, state: 'applied', entries: done, endedAt: nowOf(t) }
  await replaceOp(io, j, op)
  return op
}

/**
 * Apply the run's changes to the folder. The caller holds the folder's lock (lease) for it. First
 * the journal records the op, then snapshot P (`pre-apply`), then the plan (every path's decision), then the deletes
 * and writes. An apply a crash interrupted is finished first, with its own request, P and token (`resumed`), and
 * that is what this call returns; call again for anything else. Conflicts are left untouched unless resolved; skipped
 * paths say why.
 */
export async function applyRun(t: FinalizeTarget, opts: ApplyOptions = {}): Promise<ApplyResult> {
  return withRunLock(t, async () => {
    const io = ioOf(t)
    const j = await io.read()
    const wt = await worktreeOf(t, j)
    if (j.discard?.state === 'pending') {
      throw new DimFactoryError('CONFLICT', 'The worktree is about to be discarded. Undo the discard first.')
    }
    const open = interruptedOp(j)
    if (open !== undefined) return resultOf(await runOp(t, io, j, wt, open, opts.onStep), true)
    // The run's snapshots are checked before the op is journaled: an apply that cannot read them leaves no op behind.
    const reader = await runReader(t, wt)
    const op: ApplyOp = {
      token: randomToken('apply'),
      state: 'started',
      startedAt: nowOf(t),
      from: t.from,
      to: t.to,
      ...(opts.paths !== undefined ? { paths: [...opts.paths] } : {}),
      ...(opts.resolutions !== undefined ? { resolutions: { ...opts.resolutions } } : {}),
    }
    const j1 = await replaceOp(io, j, op)
    await opts.onStep?.('started')
    return resultOf(await runOp(t, io, j1, wt, op, opts.onStep, reader), false)
  })
}

/** [Finish apply] (interruptedApply card): finish the apply a crash stopped; null when none is open. */
export async function finishApply(
  t: FinalizeTarget,
  opts: Pick<ApplyOptions, 'onStep'> = {},
): Promise<ApplyResult | null> {
  return withRunLock(t, async () => {
    const io = ioOf(t)
    const j = await io.read()
    const open = interruptedOp(j)
    if (open === undefined) return null
    return resultOf(await runOp(t, io, j, await worktreeOf(t, j), open, opts.onStep), true)
  })
}

// ---- undo ------------------------------------------------------------------------------------------------------------

export interface UndoApplyResult {
  restored: string[]
  deleted: string[]
  skipped: { path: string; reason: string }[]
}

class UndoConflict extends Error {
  readonly paths: string[]
  constructor(paths: string[]) {
    super('changed since the apply')
    this.paths = paths
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
function listText(paths: readonly string[], max = 10): string {
  const shown = paths.slice(0, max).join(', ')
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown
}

/**
 * Undo an apply (Undo = restore(applied, P)): the paths it wrote or deleted go back to snapshot P, through
 * revert.ts (its own undo point, the link guard, on-disk checks). Refused with CONFLICT (`details.paths`, nothing
 * written) when one of them no longer holds what the apply left: checked against the undo's own pre-revert snapshot,
 * so a change made at any moment before it is seen. A path already back as P holds it counts as done, so an undo a
 * crash stopped part way can be asked again. NOT_FOUND for an unknown token; CONFLICT when already undone or the apply
 * never finished.
 */
export async function undoApply(t: FinalizeTarget, token: string): Promise<UndoApplyResult> {
  return withRunLock(t, async () => {
    const io = ioOf(t)
    const j = await io.read()
    const op = j.ops.find((o) => o.token === token)
    if (op === undefined) throw new DimFactoryError('NOT_FOUND', 'There is no such apply to undo.')
    if (op.state === 'undone') throw new DimFactoryError('CONFLICT', 'This apply was already undone.')
    if (op.state !== 'applied' || op.preApply === undefined) {
      throw new DimFactoryError('CONFLICT', 'This apply did not finish. Finish it first, then undo it.')
    }
    const entries = (op.entries ?? []).filter((e) => e.outcome === 'written' || e.outcome === 'deleted')
    const at = nowOf(t)
    if (entries.length === 0) {
      await replaceOp(io, j, { ...op, state: 'undone', undo: { at, restored: [], deleted: [], skipped: [] } })
      return { restored: [], deleted: [], skipped: [] }
    }
    const sh = await folderShadow(t)
    const ci = sh.scope.caseInsensitive
    const paths = entries.map((e) => e.path)
    const inP = await treeEntries(sh, op.preApply.tree, ci)
    let outcome
    try {
      const r = await revertTo(sh, op.preApply.commit, {
        runId: t.runId,
        paths,
        // The undo point holds every applied path, ignored or not (P does too), so each is seen as it is now.
        force: paths,
        onPlanned: async ({ preRevert }) => {
          const now = await treeEntries(sh, preRevert.tree, ci)
          const notRead = selector(preRevert.unreadable, ci)
          const changed: string[] = []
          for (const e of entries) {
            const k = fold(e.path, ci)
            const here = now.get(k)
            // Something the undo point could not hold (unreadable, too large, a folder): never overwritten.
            const unseen =
              notRead(e.path) ||
              (here === undefined &&
                (await lstat(path.join(sh.scopeRoot, ...e.path.split('/'))).then(
                  () => true,
                  () => false,
                )))
            if (unseen) {
              changed.push(e.path)
              continue
            }
            // Already as P has it (an undo that a crash stopped part way restored it): nothing to do, nothing lost.
            const was = inP.get(k)
            const back =
              was === undefined
                ? here === undefined
                : here !== undefined && here.sha === was.sha && here.mode === was.mode
            if (back) continue
            const asApplied = e.outcome === 'deleted' ? here === undefined : here?.sha === e.newSha
            if (!asApplied) changed.push(e.path)
          }
          if (changed.length > 0) throw new UndoConflict(changed.sort())
        },
      })
      if (!r.ok) throw new DimFactoryError(r.refused === 'conflict' ? 'CONFLICT' : 'FOLDER_BUSY', r.message)
      outcome = r.outcome
    } catch (err) {
      if (err instanceof UndoConflict) {
        throw new DimFactoryError(
          'CONFLICT',
          `${plural(err.paths.length, 'file')} changed after the apply (${listText(err.paths)}), so undoing it would overwrite that work. Nothing was undone.`,
          { details: { paths: err.paths } },
        )
      }
      throw err
    }
    const undo = { at, restored: outcome.restored, deleted: outcome.deleted, skipped: outcome.skipped }
    await replaceOp(io, j, { ...op, state: 'undone', undo })
    return { restored: undo.restored, deleted: undo.deleted, skipped: undo.skipped }
  })
}

// ---- discard ---------------------------------------------------------------------------------------------------------

export interface DiscardTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const defaultTimers: DiscardTimers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms)
    h.unref?.()
    return h
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const armed = new Map<string, { token: string; handle: unknown; timers: DiscardTimers }>()
const armKey = (t: FinalizeTarget): string => `${path.resolve(t.home)}\0${t.runId}`

export interface DiscardOptions {
  /** Default DISCARD_DELAY_MS (10 s). */
  delayMs?: number
  timers?: DiscardTimers
  /** The deferred removal ran (its result), or failed (the error). */
  onSettled?: (r: RemoveWorktreeResult | null, err?: unknown) => void
}

function arm(t: FinalizeTarget, token: string, ms: number, opts: DiscardOptions): void {
  const key = armKey(t)
  const prev = armed.get(key)
  if (prev !== undefined) prev.timers.clear(prev.handle)
  const timers = opts.timers ?? defaultTimers
  const handle = timers.set(
    () => {
      armed.delete(key)
      completeDiscard(t, token).then(
        (r) => opts.onSettled?.(r),
        (err: unknown) => opts.onSettled?.(null, err),
      )
    },
    Math.max(0, ms),
  )
  armed.set(key, { token, handle, timers })
}

/**
 * [Discard]: the worktree is deleted `delayMs` (10 s) from now unless undoDiscard comes first. The
 * folder is never touched. Refused while an apply is interrupted (finish it first). A second Discard while one is
 * pending answers the same token.
 */
export async function discardRun(
  t: FinalizeTarget,
  opts: DiscardOptions = {},
): Promise<WorktreeDiscardResult> {
  return withRunLock(t, async () => {
    const io = ioOf(t)
    const j = await io.read()
    // The worktree folder itself may be gone already (the user deleted it): its branch and shadow still go.
    assertNotDiscarded(j)
    if (interruptedOp(j) !== undefined) {
      throw new DimFactoryError(
        'CONFLICT',
        'An apply to the folder stopped part way. Finish it before discarding.',
      )
    }
    const now = nowOf(t)
    if (j.discard?.state === 'pending') {
      if (!armed.has(armKey(t))) arm(t, j.discard.token, j.discard.deleteAt - now, opts)
      return { undoToken: j.discard.token, deleteAt: j.discard.deleteAt }
    }
    const delayMs = opts.delayMs ?? DISCARD_DELAY_MS
    const discard: DiscardRecord = {
      token: randomToken('discard'),
      requestedAt: now,
      deleteAt: now + delayMs,
      state: 'pending',
    }
    await io.write({ ...j, discard })
    arm(t, discard.token, delayMs, opts)
    return { undoToken: discard.token, deleteAt: discard.deleteAt }
  })
}

/** Undo a pending Discard. CONFLICT once the worktree is gone; NOT_FOUND for another token. */
export async function undoDiscard(t: FinalizeTarget, token: string): Promise<void> {
  return withRunLock(t, async () => {
    const io = ioOf(t)
    const j = await io.read()
    const d = j.discard
    if (d === undefined || d.token !== token)
      throw new DimFactoryError('NOT_FOUND', 'There is no such discard to undo.')
    if (d.state === 'undone') return
    if (d.state !== 'pending') {
      throw new DimFactoryError(
        'CONFLICT',
        "The run's worktree was already deleted, so the discard cannot be undone.",
      )
    }
    const key = armKey(t)
    const a = armed.get(key)
    if (a !== undefined && a.token === token) {
      a.timers.clear(a.handle)
      armed.delete(key)
    }
    await io.write({ ...j, discard: { ...d, state: 'undone', at: nowOf(t) } })
  })
}

/**
 * The deferred removal of a Discard (its timer, or a relaunch past `deleteAt`): only while the discard with this
 * token (any pending one when absent) is still pending. Null when there was nothing to do.
 */
export async function completeDiscard(
  t: FinalizeTarget,
  token?: string,
): Promise<RemoveWorktreeResult | null> {
  return withRunLock(t, async () => {
    const io = ioOf(t)
    const j = await io.read()
    const d = j.discard
    if (d === undefined || d.state !== 'pending' || (token !== undefined && d.token !== token)) return null
    const r = await removeWorktree({ home: t.home, worktree: { ...t.worktree, folder: t.folder } })
    const at = nowOf(t)
    await io.write({
      ...j,
      ...(j.worktree !== undefined
        ? { worktree: r.removed ? { ...j.worktree, state: 'removed', at } : j.worktree }
        : {}),
      discard: {
        ...d,
        state: r.removed ? 'removed' : 'failed',
        at,
        ...(r.notes.length > 0 ? { notes: r.notes } : {}),
      },
    })
    return r
  })
}

/**
 * Relaunch: a Discard still pending in the journal is carried out when its time has passed, else armed again for the
 * time left. Returns what it did.
 */
export async function resumeDiscard(
  t: FinalizeTarget,
  opts: DiscardOptions = {},
): Promise<'none' | 'armed' | 'removed' | 'failed'> {
  const j = await ioOf(t).read()
  const d = j.discard
  if (d === undefined || d.state !== 'pending') return 'none'
  const left = d.deleteAt - nowOf(t)
  if (left > 0) {
    arm(t, d.token, left, opts)
    return 'armed'
  }
  const r = await completeDiscard(t, d.token)
  return r === null ? 'none' : r.removed ? 'removed' : 'failed'
}

/** Test hook: forget armed discard timers (they are cleared, not run). */
export function clearDiscardTimers(): void {
  for (const a of armed.values()) a.timers.clear(a.handle)
  armed.clear()
}
