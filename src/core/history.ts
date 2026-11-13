// The Runs history's Pin, Remove (undo) and retention (`storage` {keepRuns, keepDays, rawLogDays}; shadow GC; an
// isolated run's Cleanup: unfinalized worktrees are never auto-deleted).
//
// Remove hides runs at once (runs/history.json first, then index `del` lines) and deletes them for real after the undo
// window, or at the next start when the app quit. Deleting a run: its missing patch copies are saved, its
// snapshot refs go in one `update-ref --stdin` batch per shadow (under the folder mutex), its isolated copy goes only
// when finalized (applied or discarded) or when it changed nothing, then its folder and its index line. Retention
// (boot + daily while idle, and `dimf gc`) deletes the runs past keepRuns and keepDays the same way (pinned,
// unfinished and lock-holding runs, and runs whose copy has changes not in the folder, are exempt), removes the
// finalized copies of kept runs a day after they were finalized, deletes raw logs older than rawLogDays, and then
// collects the shadows refs went from (gcIfIdle).
//
// A copy goes only when nothing would be lost: every change of an applied run settled in the folder (no
// selection left files out, no open conflict, nothing skipped) and the copy still holds what the run left there (no
// edit made in it since), checked right before it is removed. A run's copy is removed before its refs go, so a copy
// that cannot be removed (in use) leaves the run, refs and all. Pins, locks and live states are checked again right
// before each run is deleted, and a pin asked for while a run is being deleted is refused. A damaged runs/history.json
// (HistoryState.degraded) makes retention delete no run.
import { randomBytes } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { RunSummary } from '../shared/run.ts'
import { DimFactoryError, errorMessage } from './errors.ts'
import {
  emptyJournal,
  fileJournal,
  journalFile,
  lastAppliedOp,
  summarizeJournal,
  unsettledPaths,
} from './git/finalize.ts'
import type { FinalizeJournal } from './git/finalize.ts'
import { detectRepo } from './git/repo.ts'
import { deleteRunRefs, gcIfIdle, listShadowKeys, readShadowGcState, shadowRepoExists } from './git/shadow.ts'
import type { ShadowGcResult } from './git/shadow.ts'
import {
  dropWorktreeShadow,
  isolatedCopyRun,
  openWorktreeShadow,
  removeWorktree,
  uncommittedPaths,
  worktreeKeys,
} from './git/worktree.ts'
import type { RemoveWorktreeOptions, RemoveWorktreeResult } from './git/worktree.ts'
import type { HomePaths } from './home.ts'
import type { Logger } from './log.ts'
import type { PersistResult } from './run-diffs.ts'
import { degradedText } from './store/history-state.ts'
import type { HistoryState } from './store/history-state.ts'
import type { IndexStore } from './store/index-store.ts'
import { EXEMPTION_TEXT, planRetention, pruneRawLogs, rowOf, unrefTimers } from './store/retention.ts'
import type { RetentionPolicy, RetentionReport, RetentionRunRow, SchedulerTimers } from './store/retention.ts'
import { listRunIds, removeRunDir } from './store/run-store.ts'
import { shadowScopeRoot } from './store/storage.ts'
import type { RunDoc } from './supervisor/controller.ts'
import { deriveStatus } from './supervisor/derive.ts'
import { runBaseSnap, segmentEnds } from './supervisor/diff-segments.ts'
import type { RunState } from './supervisor/types.ts'

/** Remove's undo window: the runs are deleted for real this long after (the toast offers Undo meanwhile). */
export const REMOVE_UNDO_MS = 10_000
/** Retention removes a kept run's finalized isolated copy (applied, or with no changes) this long after. */
export const COPY_KEEP_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** What history needs from the core (app-core.ts wires it). */
export interface HistoryDeps {
  paths: HomePaths
  log: Logger
  now(): number
  state: HistoryState
  /** The runs index (null on read-only cores: only a dry-run retention plan works there). */
  index: IndexStore | null
  /** Every listed run (the index plus loaded runs, removed ones left out). */
  summaries(): RunSummary[]
  /** run.json of a run (the live state when loaded). */
  readDoc(runId: string): Promise<RunDoc | null>
  /** RunSummary of a run.json (to list again a run folder the index lost). */
  summarizeDoc(doc: RunDoc): RunSummary
  /** The run's folder lock in this process: held (or leased) / queued; undefined when it has none. */
  lockOf(runId: string): 'held' | 'requested' | undefined
  /** Close a loaded run (its controller, events log, timers) before its folder is deleted. */
  detach(runId: string): Promise<void>
  /** Save each run's segments that have no patch copy yet. */
  persistRuns(runIds: readonly string[]): Promise<PersistResult>
  /**
   * A run holds, waits for or works in the folder whose shadow is `folderKey`. Not the shadow mutex: gcIfIdle checks
   * that itself before taking it, and asks this again while it holds it.
   */
  folderInUse(folderKey: string): boolean
  /** When a run last released a lock on the folder whose shadow is `folderKey` (this process). */
  lastLockAt(folderKey: string): number | undefined
  /** storage.{keepRuns, keepDays, rawLogDays} now. */
  policy(): RetentionPolicy
  /** Default git/worktree.ts removeWorktree (tests inject). */
  removeWorktree?: (o: RemoveWorktreeOptions) => Promise<RemoveWorktreeResult>
  /**
   * What a copy holds now against what the run left there (default: copyLoss over the copy's own shadow; tests inject):
   * a reason to keep it (UI copy), or undefined when removing it loses nothing.
   */
  copyLoss?: (c: CopyCheck) => Promise<string | undefined>
  /** The undo window's timer (default: real, unref'd). */
  timers?: SchedulerTimers
  /** Default REMOVE_UNDO_MS. */
  undoMs?: number
}

export interface RemoveResult {
  undoToken: string
  removed: string[]
}

export interface RetentionOptions {
  /** Report what would be done; change nothing. */
  dryRun?: boolean
  /** `dimf gc`: collect every shadow now (not only those refs went from, not only once a day). */
  force?: boolean
}

/** `Core.history` (app-core.ts): retention on demand (`dimf gc`) and the deferred deletes in flight. */
export interface CoreHistory {
  /** One retention pass now. A read-only core answers a dry run only (FORBIDDEN otherwise). */
  retention(o?: RetentionOptions): Promise<RetentionReport>
  /** Wait for the boot's checks and the deferred deletes in flight (tests, `dimf gc`). */
  settled(): Promise<void>
}

export interface History {
  /** runs.pin: RunSummary.pinned (runs/history.json, then the index). */
  pin(runId: string, pinned: boolean): Promise<void>
  /** runs.remove: hide now, delete for real after the undo window; CONFLICT with the reason when one cannot go. */
  remove(runIds: readonly string[]): Promise<RemoveResult>
  /** runs.undoRemove within the window: the runs are listed again. CONFLICT once they were deleted. */
  undoRemove(undoToken: string): Promise<void>
  /** Boot: pins and removals checked against the index, run folders the index lost listed again, leftovers deleted. */
  boot(): Promise<void>
  /** One retention pass (boot + daily, `dimf gc`). */
  retention(o?: RetentionOptions): Promise<RetentionReport>
  /** gcIfIdle over the shadows still marked (a pass's gc had to wait for an idle folder). */
  gcPending(): Promise<{ results: ShadowGcResult[]; gcPending: boolean }>
  /** Wait for deferred deletes in flight (tests, shutdown). */
  settled(): Promise<void>
  /** Clear the undo timers (shutdown): the removals stay recorded and are deleted at the next start. */
  close(): void
}

/**
 * What must still hold right before a copy is removed (copyLoss): an applied copy settled every change in the folder
 * and holds the apply's W.last; a copy of a run that changed nothing still holds `expect` (its last snapshot, or S0)
 * or, with no snapshot, has no uncommitted change. A discarded copy is the user's choice: nothing to check.
 */
export type CopyCheck = { runId: string; label: string; path: string; workKey?: string } & (
  | { kind: 'applied'; journal: FinalizeJournal; from: string; to: string }
  | { kind: 'unchanged'; expect?: string }
  | { kind: 'discarded' }
)

/** What retention and Remove may do with a run's isolated copy (`<home>/worktrees/<runId>`). */
type CopyVerdict =
  /** No copy on disk (an in-place run, or the copy is gone already). */
  | { kind: 'none' }
  /** Finalized (applied or discarded), or kept with no changes: it may go, from `since`, once `check` holds. */
  | { kind: 'remove'; worktree: RemoveWorktreeOptions['worktree']; since: number; check: CopyCheck }
  /** It stays: `reason` says why (UI copy). */
  | { kind: 'keep'; reason: string }

const runNo = (s: Pick<RunSummary, 'displayNo'>): string => `Run #${s.displayNo}`

/** Why a run cannot be deleted now (live, queued, holding its folder); undefined when it can. UI copy. */
export function busyReason(s: RunSummary, lock: 'held' | 'requested' | undefined): string | undefined {
  const n = runNo(s)
  switch (s.status) {
    case 'queued':
      return `${n} is waiting to start. Cancel it first, then remove it.`
    case 'running':
    case 'waiting':
      return `${n} is still running. Stop it first, then remove it.`
    case 'paused':
      return `${n} is paused. Stop it first, then remove it.`
    case 'failed':
      if (lock !== undefined || s.lock !== undefined) {
        return `${n} failed and still holds its folder. Close it first, then remove it.`
      }
      return undefined
    case 'completed':
    case 'cancelled':
      if (lock !== undefined || s.lock !== undefined) return `${n} is still finishing. Try again in a moment.`
      return undefined
  }
}

/** The run changed files in its isolated copy (its combined segment's ends differ). */
export function copyHasChanges(state: RunState): boolean {
  const ends = segmentEnds(state, 'combined')
  return ends !== undefined && ends.from.tree !== ends.to.tree
}

/** `a, b and 3 more` (UI copy). */
function pathList(paths: readonly string[], max = 3): string {
  const shown = paths.slice(0, max).join(', ')
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown
}

/** UI copy: a copy with changes of the run that are not in the folder. */
export function copyUnappliedText(label: string): string {
  return `${label} still has its isolated copy with changes that are not in your folder. Apply or discard the copy in the run's Diff tab first.`
}

/** UI copy: a copy edited after the run (those edits exist only there). */
export function copyEditedText(label: string, paths: readonly string[]): string {
  return `${label}'s isolated copy was changed after the run (${pathList(paths)}), so Dim Factory leaves it alone. Discard the copy in the run's Diff tab once you no longer need those changes.`
}

/**
 * The default CopyCheck: reads the copy (`treeNow` in its own shadow, or `git status` with no snapshot) and the run's
 * changed paths. A reason to keep the copy (UI copy), or undefined when removing it loses nothing. Any failure keeps it.
 */
export async function copyLoss(home: string, c: CopyCheck): Promise<string | undefined> {
  if (c.kind === 'discarded') return undefined
  const cannot = `Dim Factory could not check what ${c.label}'s isolated copy holds now, so it leaves the copy alone.`
  try {
    if (c.kind === 'unchanged' && c.expect === undefined) {
      // `git status` of the copy (a git worktree). A copy git cannot read as one is left alone: uncommittedPaths
      // answers "nothing" for a folder that is not a repository.
      const repo = await detectRepo(c.path)
      if (!repo.isRepo || repo.dubiousOwnership || repo.toplevel === undefined) return cannot
      const left = await uncommittedPaths(c.path)
      return left.length > 0 ? copyEditedText(c.label, left) : undefined
    }
    const key = c.workKey ?? (await worktreeKeys(home, c.runId)).folderKey
    if (!(await shadowRepoExists(home, key))) return cannot
    const sh = await openWorktreeShadow(home, c.path)
    if (c.kind === 'applied') {
      const changed = (await sh.changes(c.from, c.to)).flatMap((f) =>
        f.oldPath !== undefined ? [f.path, f.oldPath] : [f.path],
      )
      if (unsettledPaths(c.journal, changed).paths.length > 0) return copyUnappliedText(c.label)
    }
    const expect = c.kind === 'applied' ? c.to : (c.expect ?? '')
    const now = await sh.treeNow()
    const edited = (await sh.changes(expect, now.tree)).map((f) => f.path)
    return edited.length > 0 ? copyEditedText(c.label, edited) : undefined
  } catch {
    return cannot
  }
}

const isDir = (p: string): Promise<boolean> =>
  lstat(p).then(
    (s) => s.isDirectory(),
    () => false,
  )

export function createHistory(d: HistoryDeps): History {
  const timers = d.timers ?? unrefTimers
  const removeWt = d.removeWorktree ?? removeWorktree
  const lossOf = d.copyLoss ?? ((c: CopyCheck) => copyLoss(d.paths.home, c))
  const armed = new Map<string, unknown>()
  /** Tokens whose runs are being deleted (an Undo now is too late). */
  const purging = new Set<string>()
  /** Runs a purge is deleting now: a pin is refused (CONFLICT) until it is done. */
  const deleting = new Set<string>()
  /** Runs whose pin is being written: a purge that reaches them keeps them. */
  const pinning = new Set<string>()
  /** Tokens deleted in this process, with the runs' numbers (an Undo's refusal names them). */
  const purged = new Map<string, number[]>()
  const inFlight = new Set<Promise<unknown>>()
  let closed = false

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p)
    void p.finally(() => inFlight.delete(p)).catch(() => undefined)
    return p
  }
  const writable = (): IndexStore => {
    if (d.index === null) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
    return d.index
  }
  const listed = (): Map<string, RunSummary> => new Map(d.summaries().map((s) => [s.runId, s]))

  // ---- isolated copies -----------------------------------------------------------------------------------------

  const copyVerdict = async (runId: string, s: RunSummary | undefined): Promise<CopyVerdict> => {
    let wtPath: string
    try {
      wtPath = d.paths.worktree(runId)
    } catch {
      return { kind: 'none' }
    }
    if (!(await isDir(wtPath))) return { kind: 'none' }
    const n = s !== undefined ? runNo(s) : 'This run'
    const j = await fileJournal(journalFile(d.paths.home, runId))
      .read()
      .catch(() => emptyJournal())
    const rec = j.worktree
    if (rec === undefined) {
      return {
        kind: 'keep',
        reason: `Dim Factory has no record of how ${n}'s isolated copy was made, so it leaves the copy alone.`,
      }
    }
    const worktree: RemoveWorktreeOptions['worktree'] = {
      path: rec.path,
      branch: rec.branch,
      base: rec.base,
      ...(rec.folderKey !== undefined ? { folderKey: rec.folderKey } : {}),
      ...(rec.commonDir !== undefined ? { commonDir: rec.commonDir } : {}),
      ...(rec.folder !== undefined ? { folder: rec.folder } : {}),
    }
    const base = {
      runId,
      label: n,
      path: wtPath,
      ...(rec.folderKey !== undefined ? { workKey: rec.folderKey } : {}),
    }
    const sum = summarizeJournal(j)
    switch (sum.state) {
      case 'applied': {
        const op = lastAppliedOp(j)
        // The journal alone tells a full apply's open conflicts and skips; a selection is checked against the run's
        // changed paths right before removal (copyLoss).
        if (op === undefined || unsettledPaths(j).paths.length > 0) {
          return { kind: 'keep', reason: copyUnappliedText(n) }
        }
        return {
          kind: 'remove',
          worktree,
          since: op.endedAt ?? op.startedAt,
          check: { ...base, kind: 'applied', journal: j, from: op.from, to: op.to },
        }
      }
      case 'discarded':
        return { kind: 'remove', worktree, since: j.discard?.at ?? 0, check: { ...base, kind: 'discarded' } }
      case 'discard-pending':
        return { kind: 'keep', reason: `${n}'s isolated copy is being discarded. Try again in a moment.` }
      case 'interrupted':
        return {
          kind: 'keep',
          reason: `An apply of ${n}'s isolated copy to your folder stopped part way. Finish it in the run first.`,
        }
      case 'none':
        break
    }
    const doc = await d.readDoc(runId)
    if (doc === null) {
      return { kind: 'keep', reason: `Dim Factory cannot read ${n}, so it leaves its isolated copy alone.` }
    }
    const status = deriveStatus(doc.state)
    if (status !== 'completed' && status !== 'cancelled' && status !== 'failed') {
      return { kind: 'keep', reason: `${n} has not finished, so its isolated copy stays.` }
    }
    if (!copyHasChanges(doc.state)) {
      const last = segmentEnds(doc.state, 'combined')?.to ?? runBaseSnap(doc.state)
      return {
        kind: 'remove',
        worktree,
        since: doc.state.endedAt ?? s?.endedAt ?? 0,
        check: { ...base, kind: 'unchanged', ...(last !== undefined ? { expect: last.commit } : {}) },
      }
    }
    return { kind: 'keep', reason: copyUnappliedText(n) }
  }

  /** Why a run that was to be deleted must stay now (pinned, or live / holding its folder); undefined: it may go. */
  const stays = (runId: string, s: RunSummary | undefined): string | undefined => {
    if (d.state.isPinned(runId) || pinning.has(runId)) return EXEMPTION_TEXT.pinned
    const now = listed().get(runId) ?? s
    const lock = d.lockOf(runId)
    if (now === undefined) return lock !== undefined ? EXEMPTION_TEXT.lock : undefined
    return busyReason(now, lock)
  }

  // ---- deleting runs -------------------------------------------------------------------------------------------

  interface PurgeOutcome {
    removed: string[]
    failed: { runId: string; reason: string }[]
    /** Runs that must stay after all (pinned, or busy, since they were chosen; a copy that would lose work). */
    kept: { runId: string; reason: string }[]
    /** Shadows refs went from. */
    touched: Set<string>
  }

  /**
   * Delete runs for real: patch copies saved; then per run, checked again (pinned, live, holding its folder), closed,
   * and its finalized copy removed once copyLoss says nothing would be lost; then the refs of the runs still going (one
   * batch per shadow), their folders, index lines and history records. A run that fails any step keeps its folder and
   * its refs (tried again later). A pin asked for meanwhile is refused (`deleting`).
   */
  const purge = async (runIds: readonly string[]): Promise<PurgeOutcome> => {
    const out: PurgeOutcome = { removed: [], failed: [], kept: [], touched: new Set() }
    if (runIds.length === 0) return out
    const index = writable()
    const mine = [...new Set(runIds)].filter((id) => !deleting.has(id))
    for (const id of mine) deleting.add(id)
    try {
      const known = new Map([
        ...listed(),
        ...d.state.removals().flatMap((r) => r.summaries.map((s) => [s.runId, s] as const)),
      ])
      const fail = (runId: string, reason: string): void => {
        out.failed.push({ runId, reason })
      }
      const keep = (runId: string, reason: string): void => {
        out.kept.push({ runId, reason })
      }
      interface Target {
        runId: string
        folderKeys: Set<string>
        copy: CopyVerdict
        workKey?: string
      }
      const targets: Target[] = []
      for (const runId of mine) {
        const s = known.get(runId)
        const why = stays(runId, s)
        if (why !== undefined) {
          keep(runId, why)
          continue
        }
        const doc = await d.readDoc(runId)
        const copy = await copyVerdict(runId, s)
        if (copy.kind === 'keep') {
          keep(runId, copy.reason)
          continue
        }
        const folderKeys = new Set<string>()
        const key = doc?.scope.folderKey ?? s?.folderKey
        if (key !== undefined && key !== '') folderKeys.add(key)
        const isolated = doc?.scope.runLockKey !== undefined || s?.isolation === 'worktree'
        const workKey =
          doc?.work?.folderKey ??
          (isolated ? (await worktreeKeys(d.paths.home, runId).catch(() => null))?.folderKey : undefined)
        targets.push({ runId, folderKeys, copy, ...(workKey !== undefined ? { workKey } : {}) })
      }
      if (targets.length === 0) return out
      // The diffs of these runs are saved before their snapshot refs go (best effort: their folders go too).
      const saved = await d.persistRuns(targets.map((t) => t.runId)).catch((err: unknown) => {
        d.log.warn('saving patch copies before a delete failed', { err: errorMessage(err) })
        return null
      })
      for (const f of saved?.failed ?? []) {
        d.log.warn('a patch copy could not be saved before its run was deleted', {
          runId: f.runId,
          reason: f.reason,
        })
      }
      // Per run: checked again, closed, its copy removed first (a copy that cannot go leaves the run and its refs).
      const going: Target[] = []
      for (const t of targets) {
        const why = stays(t.runId, known.get(t.runId))
        if (why !== undefined) {
          keep(t.runId, why)
          continue
        }
        if (t.copy.kind === 'remove') {
          const loss = await lossOf(t.copy.check)
          if (loss !== undefined) {
            keep(t.runId, loss)
            continue
          }
        }
        await d.detach(t.runId)
        if (t.copy.kind === 'remove') {
          try {
            const r = await removeWt({ home: d.paths.home, worktree: t.copy.worktree })
            if (r.notes.length > 0)
              d.log.info('isolated copy removed with notes', { runId: t.runId, notes: r.notes })
            if (!r.removed) {
              fail(t.runId, r.notes[0] ?? 'its isolated copy could not be removed')
              continue
            }
          } catch (err) {
            fail(t.runId, `its isolated copy could not be removed: ${errorMessage(err)}`)
            continue
          }
        } else if (t.workKey !== undefined && (await shadowRepoExists(d.paths.home, t.workKey))) {
          // The copy is gone already; its shadow goes with it (worktree shadows are dropped with their worktree).
          await dropWorktreeShadow(d.paths.home, t.workKey).catch((err: unknown) =>
            d.log.warn('could not drop an isolated copy shadow', { runId: t.runId, err: errorMessage(err) }),
          )
        }
        going.push(t)
      }
      // Refs: one update-ref --stdin batch per shadow. (An isolated copy's own shadow went whole with the copy.)
      const byKey = new Map<string, string[]>()
      for (const t of going) {
        for (const k of t.folderKeys) if (k !== t.workKey) byKey.set(k, [...(byKey.get(k) ?? []), t.runId])
      }
      const bad = new Set<string>()
      for (const [key, ids] of byKey) {
        try {
          const deleted = await deleteRunRefs(d.paths.home, key, ids, { now: d.now() })
          if (deleted.length > 0) out.touched.add(key)
        } catch (err) {
          for (const id of ids) {
            bad.add(id)
            fail(id, `its snapshots could not be deleted: ${errorMessage(err)}`)
          }
        }
      }
      for (const t of going) {
        if (bad.has(t.runId)) continue
        try {
          await removeRunDir(d.paths, t.runId)
        } catch (err) {
          fail(t.runId, errorMessage(err))
          continue
        }
        out.removed.push(t.runId)
      }
      for (const id of out.removed) if (index.get(id) !== undefined) await index.del(id)
      if (out.removed.length > 0) await d.state.forget(out.removed)
      return out
    } finally {
      for (const id of mine) deleting.delete(id)
    }
  }

  /** The deferred delete of one Remove (its timer, the boot, or a retention pass past its window). */
  const purgeRemoval = async (token: string): Promise<void> => {
    const t = armed.get(token)
    if (t !== undefined) timers.clear(t)
    armed.delete(token)
    const rec = d.state.removal(token)
    if (rec === undefined || purging.has(token)) return
    purging.add(token)
    try {
      const r = await purge(rec.runIds)
      const nos = rec.summaries.filter((s) => r.removed.includes(s.runId)).map((s) => s.displayNo)
      if (r.removed.length > 0) purged.set(token, nos)
      for (const f of [...r.failed, ...r.kept]) d.log.warn('a removed run could not be deleted yet', f)
    } finally {
      purging.delete(token)
    }
  }

  const armRemoval = (token: string, ms: number): void => {
    if (closed) return
    const prev = armed.get(token)
    if (prev !== undefined) timers.clear(prev)
    armed.set(
      token,
      timers.set(() => {
        armed.delete(token)
        void track(purgeRemoval(token)).catch((err: unknown) =>
          d.log.error('deleting removed runs failed', { err: errorMessage(err) }),
        )
      }, ms),
    )
  }

  /** Every removal whose window has passed (or all, at boot: the toasts are gone). */
  const purgeDue = async (all: boolean): Promise<number> => {
    let n = 0
    const now = d.now()
    for (const r of [...d.state.removals()]) {
      if (!all && r.deleteAt > now) continue
      const before = r.runIds.length
      await purgeRemoval(r.token)
      n += before - (d.state.removal(r.token)?.runIds.length ?? 0)
    }
    return n
  }

  // ---- gc --------------------------------------------------------------------------------------------------------

  /** Shadows marked since their last gc (refs went), or every shadow with `all`. */
  const markedShadows = async (all: boolean): Promise<string[]> => {
    const keys = await listShadowKeys(d.paths.home)
    if (all) return keys
    const out: string[] = []
    for (const k of keys) {
      const s = await readShadowGcState(d.paths.home, k)
      if ((s.refsDeletedAt ?? 0) > (s.lastGcAt ?? 0)) out.push(k)
    }
    return out
  }

  const gcPass = async (
    keys: Iterable<string>,
    o: RetentionOptions,
  ): Promise<{ results: ShadowGcResult[]; gcPending: boolean }> => {
    const results: ShadowGcResult[] = []
    let gcPending = false
    for (const folderKey of [...new Set(keys)].sort()) {
      // An isolated copy's shadow stays while the copy exists (it holds what Apply and the Diff tab read).
      const root = await shadowScopeRoot(d.paths, folderKey)
      const copyRun = root !== null ? await isolatedCopyRun(d.paths.home, root) : undefined
      if (copyRun !== undefined) {
        results.push({ folderKey, action: 'skipped', reason: 'an isolated copy still uses these snapshots' })
        continue
      }
      try {
        const r = await gcIfIdle({
          home: d.paths.home,
          folderKey,
          now: d.now(),
          inUse: () => d.folderInUse(folderKey),
          lastLockAt: d.lastLockAt(folderKey),
          ...(o.force === true ? { force: true } : {}),
          ...(o.dryRun === true ? { dryRun: true } : {}),
        })
        results.push(r)
        if (r.action === 'skipped' && /using|used/.test(r.reason ?? '')) gcPending = true
      } catch (err) {
        d.log.warn('shadow gc failed', { folderKey, err: errorMessage(err) })
        results.push({ folderKey, action: 'skipped', reason: `git gc failed: ${errorMessage(err)}` })
      }
    }
    return { results, gcPending }
  }

  // ---- the API -------------------------------------------------------------------------------------------------

  return {
    pin: async (runId, pinned) => {
      const index = writable()
      const s = listed().get(runId)
      if (s === undefined) throw new DimFactoryError('NOT_FOUND', `Run ${runId} is not in the history.`)
      // A run being deleted now cannot be pinned (the pin would be dropped with the run).
      if (deleting.has(runId)) {
        throw new DimFactoryError('CONFLICT', `${runNo(s)} is being deleted. Try again in a moment.`)
      }
      pinning.add(runId)
      try {
        await d.state.setPinned(runId, pinned, d.now())
        await index.put({ ...s, pinned })
      } finally {
        pinning.delete(runId)
      }
    },

    remove: async (runIds) => {
      const index = writable()
      const all = listed()
      const want = [...new Set(runIds)]
      const found = want.map((id) => all.get(id)).filter((s): s is RunSummary => s !== undefined)
      if (found.length === 0) {
        throw new DimFactoryError('NOT_FOUND', 'That run is no longer in the history.')
      }
      const refused: { runId: string; reason: string }[] = []
      for (const s of found) {
        const reason = s.pinned
          ? `${runNo(s)} is pinned. Unpin it first, then remove it.`
          : deleting.has(s.runId)
            ? `${runNo(s)} is being deleted already.`
            : (busyReason(s, d.lockOf(s.runId)) ??
              (s.isolation === 'worktree'
                ? await copyVerdict(s.runId, s).then((v) =>
                    v.kind === 'keep' ? v.reason : v.kind === 'remove' ? lossOf(v.check) : undefined,
                  )
                : undefined))
        if (reason !== undefined) refused.push({ runId: s.runId, reason })
      }
      const [first] = refused
      if (first !== undefined) {
        const message =
          refused.length === 1
            ? first.reason
            : `${refused.length} of these runs cannot be removed now. ${first.reason}`
        throw new DimFactoryError('CONFLICT', message, { details: { refused } })
      }
      const now = d.now()
      const undoMs = d.undoMs ?? REMOVE_UNDO_MS
      const token = `remove-${randomBytes(9).toString('hex')}`
      const ids = found.map((s) => s.runId)
      await d.state.addRemoval({
        token,
        runIds: ids,
        requestedAt: now,
        deleteAt: now + undoMs,
        summaries: found,
      })
      for (const id of ids) await index.del(id)
      armRemoval(token, undoMs)
      return { undoToken: token, removed: ids }
    },

    undoRemove: async (undoToken) => {
      const index = writable()
      const rec = d.state.removal(undoToken)
      if (rec === undefined || purging.has(undoToken)) {
        const nos = purged.get(undoToken) ?? []
        const which =
          nos.length === 1 ? `Run #${nos[0] ?? ''} was` : nos.length > 1 ? 'The runs were' : 'The run was'
        throw new DimFactoryError('CONFLICT', `It is too late to undo: ${which} already deleted.`)
      }
      const t = armed.get(undoToken)
      if (t !== undefined) timers.clear(t)
      armed.delete(undoToken)
      // The record goes first, so the index takes the runs in again (a crash in between lists the run folders again at
      // the next start: boot()).
      await d.state.dropRemoval(undoToken)
      for (const s of rec.summaries) await index.put(s)
    },

    boot: async () => {
      const index = writable()
      const degraded = d.state.degraded
      // Pins: runs/history.json is the record (an index line may predate a pin or a rebuild may have lost it). A
      // degraded record took its pins from the index (adoptPins) and never unpins from it.
      for (const s of index.list()) {
        const want = d.state.isPinned(s.runId)
        if (s.pinned === want || (degraded !== undefined && !want)) continue
        await index.put({ ...s, pinned: want })
      }
      // A damaged file (kept as history.json.bad) is written again with the pins the index held.
      if (degraded?.kind === 'corrupt' && !d.state.readOnly) {
        await d.state
          .repair()
          .catch((err: unknown) =>
            d.log.warn('runs/history.json could not be written again', { err: errorMessage(err) }),
          )
      }
      // A removal whose runs the index still lists never finished hiding them (or an Undo listed them again before the
      // app stopped): those runs stay.
      for (const r of [...d.state.removals()]) {
        const back = r.runIds.filter((id) => index.get(id) !== undefined)
        if (back.length === 0) continue
        if (back.length === r.runIds.length) await d.state.dropRemoval(r.token)
        else {
          await d.state.addRemoval({
            ...r,
            runIds: r.runIds.filter((id) => !back.includes(id)),
            summaries: r.summaries.filter((s) => !back.includes(s.runId)),
          })
        }
      }
      // Run folders the index does not list and no removal hides (an Undo cut short) are listed again.
      for (const id of await listRunIds(d.paths)) {
        if (index.get(id) !== undefined || d.state.isHidden(id)) continue
        const doc = await d.readDoc(id)
        if (doc === null) continue
        await index.put(d.summarizeDoc(doc))
      }
      // Removals the app quit before deleting: their undo toasts are gone, so they go now.
      await track(purgeDue(true))
    },

    retention: async (o = {}) => {
      const dryRun = o.dryRun === true
      const now = d.now()
      const policy = d.policy()
      const pendingRemoved = dryRun ? 0 : await track(purgeDue(false))
      const all = d.summaries()
      const byId = new Map(all.map((s) => [s.runId, s]))
      const lockHeld = new Set(
        all.filter((s) => s.lock !== undefined || d.lockOf(s.runId) !== undefined).map((s) => s.runId),
      )
      const plan = planRetention(all, policy, { now, lockHeld })
      const kept: (RetentionRunRow & { reason: string })[] = plan.exempt.flatMap((e) => {
        const s = byId.get(e.runId)
        return s !== undefined ? [{ ...rowOf(s), reason: EXEMPTION_TEXT[e.reason] }] : []
      })
      const remove: string[] = []
      // With runs/history.json damaged or unreadable, no run is deleted (a pin may be missing).
      const degraded = d.state.degraded
      for (const id of plan.remove) {
        const s = byId.get(id)
        if (s === undefined) continue
        if (degraded !== undefined) {
          kept.push({ ...rowOf(s), reason: degradedText(degraded) })
          continue
        }
        const v = s.isolation === 'worktree' ? await copyVerdict(id, s) : ({ kind: 'none' } as const)
        if (v.kind === 'keep') kept.push({ ...rowOf(s), reason: v.reason })
        else remove.push(id)
      }
      const removing = new Set(remove)
      // Kept runs whose isolated copy was finalized (or changed nothing) more than a day ago.
      const copies: { s: RunSummary; v: Extract<CopyVerdict, { kind: 'remove' }> }[] = []
      for (const s of all) {
        if (removing.has(s.runId) || s.isolation !== 'worktree' || lockHeld.has(s.runId)) continue
        if (s.status !== 'completed' && s.status !== 'cancelled' && s.status !== 'failed') continue
        const v = await copyVerdict(s.runId, s)
        if (v.kind === 'remove' && now - v.since >= COPY_KEEP_MS) copies.push({ s, v })
      }
      // Raw logs older than rawLogDays, also for kept runs (finished, lock-free ones).
      const rawIds = all
        .filter(
          (s) =>
            !removing.has(s.runId) &&
            !lockHeld.has(s.runId) &&
            (s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'),
        )
        .map((s) => s.runId)
      // File times are on the wall clock (the core's clock may run scaled under E2E).
      const rawLogs = await pruneRawLogs(d.paths, rawIds, Date.now() - policy.rawLogDays * DAY_MS, { dryRun })
      const report: RetentionReport = {
        dryRun,
        at: now,
        policy,
        removed: [],
        kept,
        failed: [],
        copies: [],
        rawLogs,
        pendingRemoved,
        gc: [],
        gcPending: false,
      }
      if (dryRun) {
        report.removed = remove
          .map((id) => byId.get(id))
          .filter((s) => s !== undefined)
          .map(rowOf)
        report.copies = copies.map((c) => rowOf(c.s))
        // The shadows the deletes would mark are collected as if marked; the others by their own marks.
        const touched = new Set<string>()
        for (const id of remove) {
          const k = byId.get(id)?.folderKey
          if (k !== undefined && k !== '') touched.add(k)
        }
        const marked = (await markedShadows(o.force === true)).filter((k) => !touched.has(k))
        const a = await gcPass(touched, { dryRun: true, force: true })
        const b = await gcPass(marked, o)
        report.gc = [...a.results, ...b.results].sort((x, y) => x.folderKey.localeCompare(y.folderKey))
        return report
      }
      const r = await track(purge(remove))
      report.removed = r.removed
        .map((id) => byId.get(id))
        .filter((s) => s !== undefined)
        .map(rowOf)
      report.failed = r.failed.flatMap((f) => {
        const s = byId.get(f.runId)
        return s !== undefined ? [{ ...rowOf(s), reason: f.reason }] : []
      })
      for (const k of r.kept) {
        const s = byId.get(k.runId)
        if (s !== undefined) report.kept.push({ ...rowOf(s), reason: k.reason })
      }
      // A kept run's copy goes only once its diffs are saved (they stay in the run's history) and nothing of it
      // would be lost (copyLoss).
      for (const c of copies) {
        const loss = await lossOf(c.v.check)
        if (loss !== undefined) {
          d.log.info('kept an isolated copy', { runId: c.s.runId, reason: loss })
          continue
        }
        const saved = await d.persistRuns([c.s.runId]).catch(() => null)
        if (saved === null || saved.failed.length > 0) {
          d.log.warn('kept an isolated copy: its diff could not be saved first', { runId: c.s.runId })
          continue
        }
        try {
          const res = await removeWt({ home: d.paths.home, worktree: c.v.worktree })
          if (res.removed) report.copies.push(rowOf(c.s))
          if (res.notes.length > 0)
            d.log.info('isolated copy removed with notes', { runId: c.s.runId, notes: res.notes })
        } catch (err) {
          d.log.warn('could not remove a finalized isolated copy', {
            runId: c.s.runId,
            err: errorMessage(err),
          })
        }
      }
      const marked = await markedShadows(o.force === true)
      const gc = await gcPass([...r.touched, ...marked], o)
      report.gc = gc.results
      report.gcPending = gc.gcPending
      return report
    },

    gcPending: async () => gcPass(await markedShadows(false), {}),

    settled: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },

    close: () => {
      closed = true
      for (const t of armed.values()) timers.clear(t)
      armed.clear()
    },
  }
}
