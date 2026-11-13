// Run branch prep and the user-repo state it reads (the `run.branch` and
// `folder.git` checks). The only writes to a user repo: the opt-in run branch ref (`update-ref`, create-only)
// and HEAD's symbolic ref, both under the per `--git-common-dir` mutex. No checkout, no commit, no index write.
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { BranchActionResult } from '../../shared/ipc.ts'
import type { RunBranchInfo } from '../../shared/run.ts'
import { osFamily, repairCommand } from '../heal/commands.ts'
import type { OsFamily, ShellCommand } from '../heal/commands.ts'
import { GitError, isDubiousOwnership, isGitError, runGit, splitNul, tryGit } from './exec.ts'
import type { GitRunOptions } from './exec.ts'
import { retryOnLock, withCommonDirLock } from './mutex.ts'
import type { RepoInfo } from './repo.ts'
import { gitConfigPath } from './shadow.ts'
import { BRAND } from '../../shared/brand.ts'

/** `update-ref <ref> <new> <old>` with this old value creates the ref only if it does not exist. */
export const ZERO_OID = '0'.repeat(40)
/** Default `isolation.branchPrefix`. */
export const DEFAULT_BRANCH_PREFIX = BRAND.branchPrefix
/** The slug part of a run branch name is at most this long. */
export const RUN_BRANCH_SLUG_MAX = 40
/** How long an `index.lock` may exist before it blocks branch creation (3 s). */
export const INDEX_LOCK_WAIT_MS = 3000
/** `-2` … `-N`: candidates checked for a free run branch name. */
const NAME_CANDIDATES = 50

export type GitOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am' | 'bisect'

export interface HeadState {
  /** The symbolic ref HEAD names (`refs/heads/<name>`); null when HEAD is detached. */
  ref: string | null
  /** HEAD's commit; null when the branch is unborn (no commit yet). */
  commit: string | null
}

/** User-repo state for branch prep and reconciliation. Every read uses `--no-optional-locks`. */
export interface RepoState extends HeadState {
  /** git refused the repository (CVE-2022-24765); nothing else could be read. */
  dubiousOwnership: boolean
  /** HEAD names a branch that has no commit yet. */
  unborn: boolean
  /** merge, rebase, am, cherry-pick or revert in progress (bisect is reported on its own). */
  operation: Exclude<GitOp, 'bisect'> | null
  bisect: boolean
  /** Paths with conflict stages in the user's index (`ls-files -u`). */
  unmergedPaths: string[]
  /** `--git-path index.lock` exists right now. */
  indexLock: boolean
  /** Absolute `--git-path index.lock` (null when unknown). */
  indexLockPath: string | null
}

/** Where to run git for a user repo, and the common dir its writes serialize on. */
interface RepoTarget {
  cwd: string
  commonDir: string
}

function targetOf(repo: RepoInfo): RepoTarget | null {
  if (!repo.isRepo || repo.toplevel === undefined) return null
  const cwd = repo.toplevel
  return { cwd, commonDir: repo.commonDir ?? path.join(cwd, '.git') }
}

const readOpts = (cwd: string, extra: Partial<GitRunOptions> = {}): GitRunOptions => ({
  cwd,
  noOptionalLocks: true,
  timeoutMs: 30_000,
  category: 'git_state',
  ...extra,
})

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}

const shortSha = (sha: string): string => sha.slice(0, 7)

/** `refs/heads/x` → `x`; anything else unchanged. */
export function branchShortName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/** How a HEAD reads in UI copy: the branch name, or "detached HEAD at abc1234". */
export function headLabel(head: HeadState): string {
  if (head.ref !== null) return branchShortName(head.ref)
  return head.commit === null ? 'detached HEAD' : `detached HEAD at ${shortSha(head.commit)}`
}

// ---- reads -----------------------------------------------------------------------------------------------------

/**
 * HEAD's symbolic ref and commit: `symbolic-ref -q HEAD` (exit 1 = detached) and `rev-parse -q --verify
 * HEAD^{commit}` (exit 1 = unborn). Throws GitError on any other failure (dubious ownership included).
 */
export async function readHead(cwd: string): Promise<HeadState> {
  const [sym, commit] = await Promise.all([
    runGit(['symbolic-ref', '-q', 'HEAD'], readOpts(cwd, { okCodes: [0, 1] })),
    runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], readOpts(cwd, { okCodes: [0, 1] })),
  ])
  const ref = sym.code === 0 ? sym.stdout.trim() : ''
  const sha = commit.code === 0 ? commit.stdout.trim() : ''
  return { ref: ref === '' ? null : ref, commit: sha === '' ? null : sha }
}

/** A ref's commit, or null when it does not exist. */
async function refCommit(cwd: string, ref: string): Promise<string | null> {
  const r = await runGit(
    ['rev-parse', '-q', '--verify', `${ref}^{commit}`],
    readOpts(cwd, { okCodes: [0, 1] }),
  )
  const sha = r.code === 0 ? r.stdout.trim() : ''
  return sha === '' ? null : sha
}

/** Marker files of an operation in progress, in the order `git status` reports them. */
const OP_MARKERS: readonly { marker: string; op: GitOp | 'sequencer' }[] = [
  { marker: 'rebase-merge', op: 'rebase' },
  { marker: 'rebase-apply/applying', op: 'am' },
  { marker: 'rebase-apply', op: 'rebase' },
  { marker: 'MERGE_HEAD', op: 'merge' },
  { marker: 'CHERRY_PICK_HEAD', op: 'cherry-pick' },
  { marker: 'REVERT_HEAD', op: 'revert' },
  // A multi-commit cherry-pick or revert between its stops: the todo's first command names which.
  { marker: 'sequencer/todo', op: 'sequencer' },
  { marker: 'BISECT_LOG', op: 'bisect' },
]

async function sequencerOp(todo: string): Promise<'cherry-pick' | 'revert'> {
  const text = await readFile(todo, 'utf8').catch(() => '')
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '' && !l.startsWith('#')) ?? ''
  return /^\s*(?:revert|r)\s/.test(first) ? 'revert' : 'cherry-pick'
}

/**
 * The repo state for branch prep and reconciliation, from reads only: HEAD, an operation in progress (marker files
 * located with `rev-parse --git-path`, so linked worktrees are right), unmerged paths, `index.lock`.
 */
export async function readRepoState(repo: RepoInfo): Promise<RepoState> {
  const empty: RepoState = {
    ref: null,
    commit: null,
    dubiousOwnership: repo.dubiousOwnership,
    unborn: false,
    operation: null,
    bisect: false,
    unmergedPaths: [],
    indexLock: false,
    indexLockPath: null,
  }
  const t = targetOf(repo)
  if (t === null || repo.dubiousOwnership) return empty
  const gitPathArgs = [...OP_MARKERS.map((m) => m.marker), 'index.lock'].flatMap((m) => ['--git-path', m])
  let head: HeadState
  let gitPaths: string[]
  let unmerged: string
  try {
    const [h, gp, u] = await Promise.all([
      readHead(t.cwd),
      runGit(['rev-parse', ...gitPathArgs], readOpts(t.cwd)),
      runGit(['ls-files', '-u', '-z'], readOpts(t.cwd, { maxBytes: 64 * 1024 * 1024 })),
    ])
    head = h
    gitPaths = gp.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')
    unmerged = u.stdout
  } catch (err) {
    if (isGitError(err) && isDubiousOwnership(err.stderr)) return { ...empty, dubiousOwnership: true }
    throw err
  }
  const abs = (p: string): string => path.resolve(t.cwd, p)
  const present = await Promise.all(
    OP_MARKERS.map((m, i) => {
      const p = gitPaths[i]
      return p === undefined ? Promise.resolve(false) : exists(abs(p))
    }),
  )
  let operation: RepoState['operation'] = null
  let bisect = false
  for (let i = 0; i < OP_MARKERS.length; i++) {
    if (present[i] !== true) continue
    const m = OP_MARKERS[i]
    if (m === undefined) continue
    if (m.op === 'bisect') bisect = true
    else if (operation === null) {
      operation = m.op === 'sequencer' ? await sequencerOp(abs(gitPaths[i] ?? '')) : m.op
    }
  }
  const lockRel = gitPaths[OP_MARKERS.length]
  const indexLockPath = lockRel === undefined ? null : abs(lockRel)
  const paths = new Set<string>()
  for (const rec of splitNul(unmerged)) {
    const tab = rec.indexOf('\t')
    if (tab !== -1) paths.add(rec.slice(tab + 1))
  }
  return {
    ...head,
    dubiousOwnership: false,
    unborn: head.ref !== null && head.commit === null,
    operation,
    bisect,
    unmergedPaths: [...paths].sort(),
    indexLock: indexLockPath !== null && (await exists(indexLockPath)),
    indexLockPath,
  }
}

/** Wait up to `waitMs` for a lock file to go; true when it is still there (it "persists"). */
export async function lockPersists(lockPath: string, waitMs: number = INDEX_LOCK_WAIT_MS): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    if (!(await exists(lockPath))) return false
    if (Date.now() - t0 >= waitMs) return true
    await delay(Math.min(250, Math.max(10, waitMs - (Date.now() - t0))))
  }
}

// ---- names -----------------------------------------------------------------------------------------------------

/** The task as a branch slug: ASCII, lowercase, `-` separated, at most 40 chars (cut at a word end when it can). */
export function runBranchSlug(task: string, max: number = RUN_BRANCH_SLUG_MAX): string {
  const ascii = task.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const words = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (words.length <= max) return words === '' ? 'run' : words
  let cut = words.slice(0, max)
  const lastDash = cut.lastIndexOf('-')
  // Mid-word: drop the partial word when that still leaves half the room.
  if (words.charAt(max) !== '-' && lastDash >= Math.floor(max / 2)) cut = cut.slice(0, lastDash)
  return cut.replace(/-+$/, '') || 'run'
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `<prefix><YYYYMMDD>-<slug≤40>` (local date). Collision suffixes come from pickRunBranchName. */
export function runBranchBaseName(prefix: string, date: Date, task: string): string {
  const ymd = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
  return `${prefix}${ymd}-${runBranchSlug(task)}`
}

/** `git check-ref-format --branch <name>` (the `run.branch` check). */
export async function isValidBranchName(cwd: string, name: string): Promise<boolean> {
  if (name === '' || name.startsWith('-')) return false
  const r = await tryGit(['check-ref-format', '--branch', name], {
    cwd,
    timeoutMs: 15_000,
    category: 'git_state',
  })
  return r.ok
}

export type BranchBlockerKind =
  | 'not-repo'
  | 'dubious-ownership'
  | 'unborn-head'
  | 'operation'
  | 'unmerged'
  | 'index-lock'
  | 'invalid-name'
  | 'name-taken'
  | 'ref-locked'
  | 'head-moved'
  | 'ref-left'

/** Why the run branch cannot be made now, as UI copy plus the copyable commands that fix it. */
export interface BranchBlocker {
  kind: BranchBlockerKind
  title: string
  detail: string
  op?: GitOp
  /** Copied to the clipboard (`shell_copy`), never run by Dim Factory. */
  commands: ShellCommand[]
}

export interface BranchOptions {
  /** `<home>/empty-hooks`: the writes run with `-c core.hooksPath=<it>`, so no user hook fires. */
  hooksPath?: string
  /** How long `index.lock` may exist before it blocks (default 3 s). */
  lockWaitMs?: number
  /** Retries of each write while a `*.lock` is held (default 3 attempts, 500 ms apart). */
  retry?: { attempts?: number; delayMs?: number }
  /** For the copyable commands (default: this platform). */
  os?: OsFamily
  /**
   * Write-ahead (createRunBranch): called inside the common-dir lock right before the ref is written, with the
   * branch about to exist. The caller records it (run.json), so a crash between the ref writes and the result that
   * reports them leaves a branch the run can adopt (prepareRunBranch `pending`). A throw aborts before any write.
   */
  onIntent?: (branch: RunBranchInfo) => Promise<void>
}

const invalidName = (name: string): BranchBlocker => ({
  kind: 'invalid-name',
  title: 'The run branch name is not valid',
  detail: `git does not accept "${name}" as a branch name. Change the branch prefix in Settings.`,
  commands: [],
})

/**
 * A free run branch name: the base name, else `-2`, `-3`, … (one `cat-file --batch-check` over the candidates).
 * The base name must pass `check-ref-format --branch`.
 */
export async function pickRunBranchName(
  repo: RepoInfo,
  o: { prefix: string; date: Date; task: string },
): Promise<{ ok: true; name: string } | { ok: false; blocker: BranchBlocker }> {
  const t = targetOf(repo)
  if (t === null) return { ok: false, blocker: notRepo() }
  const base = runBranchBaseName(o.prefix, o.date, o.task)
  if (!(await isValidBranchName(t.cwd, base))) return { ok: false, blocker: invalidName(base) }
  const candidates = [base, ...Array.from({ length: NAME_CANDIDATES - 1 }, (_, i) => `${base}-${i + 2}`)]
  const r = await runGit(['cat-file', '--batch-check'], {
    ...readOpts(t.cwd),
    stdin: candidates.map((c) => `refs/heads/${c}\n`).join(''),
  })
  const lines = r.stdout.split(/\r?\n/)
  for (let i = 0; i < candidates.length; i++) {
    if (/ missing$/.test(lines[i] ?? '')) return { ok: true, name: candidates[i] ?? base }
  }
  return {
    ok: false,
    blocker: {
      kind: 'name-taken',
      title: 'No free run branch name',
      detail: `${base} and ${NAME_CANDIDATES - 1} numbered variants already exist. Delete old run branches.`,
      commands: [],
    },
  }
}

// ---- blockers --------------------------------------------------------------------------------------------------

const unbornBlocker = (): BranchBlocker => ({
  kind: 'unborn-head',
  title: 'The repository has no commits yet',
  detail: 'A run branch starts at a commit. Commit once first, or run without a run branch.',
  commands: [],
})

const notRepo = (): BranchBlocker => ({
  kind: 'not-repo',
  title: 'Not a git repository',
  detail: 'A run branch needs a git repository. Run without one, or initialize git first.',
  commands: [],
})

/** The blocking conditions from a state read; `indexLockPersists` is the 3 s check's answer. */
function blockersOf(
  repo: RepoInfo,
  state: RepoState,
  indexLockPersists: boolean,
  os: OsFamily,
): BranchBlocker[] {
  const out: BranchBlocker[] = []
  if (state.dubiousOwnership) {
    const fix = repairCommand('safeDirectory', os, repo.toplevel ?? repo.realFolder)
    out.push({
      kind: 'dubious-ownership',
      title: 'Git does not trust this folder (dubious ownership)',
      detail: 'The folder belongs to another user account, so git refuses to use it.',
      commands: fix === null ? [] : [fix],
    })
    return out
  }
  if (state.unborn) out.push(unbornBlocker())
  const op = state.operation ?? (state.bisect ? 'bisect' : null)
  if (op !== null) {
    const fix = repairCommand('abort', os, op)
    out.push({
      kind: 'operation',
      op,
      title: `A git ${op} is in progress`,
      detail: `Finish or abort the ${op} first, then check again.`,
      commands: fix === null ? [] : [fix],
    })
  }
  if (state.unmergedPaths.length > 0) {
    const n = state.unmergedPaths.length
    out.push({
      kind: 'unmerged',
      title: 'The folder has unresolved merge conflicts',
      detail: `${n} file${n === 1 ? ' has' : 's have'} conflicts. Resolve them first, then check again.`,
      commands: [],
    })
  }
  if (indexLockPersists) {
    out.push({
      kind: 'index-lock',
      title: 'Another git process holds the index lock',
      detail:
        'index.lock has existed for more than 3 seconds. Wait for the other git command to finish; if none is running, delete the index.lock file in the .git folder.',
      commands: [],
    })
  }
  return out
}

/**
 * Branch-prep blockers: unborn HEAD, an operation in progress (bisect included), unmerged paths, dubious
 * ownership, or `index.lock` persisting for 3 s. Reads only.
 */
export async function branchBlockers(
  repo: RepoInfo,
  opts: BranchOptions = {},
): Promise<{ blockers: BranchBlocker[]; state: RepoState | null }> {
  if (targetOf(repo) === null && !repo.dubiousOwnership) return { blockers: [notRepo()], state: null }
  const state = await readRepoState(repo)
  const persists =
    state.indexLock && state.indexLockPath !== null
      ? await lockPersists(state.indexLockPath, opts.lockWaitMs ?? INDEX_LOCK_WAIT_MS)
      : false
  return { blockers: blockersOf(repo, state, persists, opts.os ?? osFamily()), state }
}

// ---- writes ----------------------------------------------------------------------------------------------------

/** Another git process holds a `*.lock` (not "reference already exists" or a stale old value). */
const HELD_LOCK = /Unable to create '[^']*\.lock'|\.lock'?:? File exists/i

export function isHeldLockError(err: unknown): boolean {
  return isGitError(err) && HELD_LOCK.test(err.stderr)
}

const hookArgs = (opts: BranchOptions): string[] =>
  opts.hooksPath !== undefined ? ['-c', `core.hooksPath=${gitConfigPath(opts.hooksPath)}`] : []

/** One user-repo write, retried while a `*.lock` is held (3 × 500 ms by default). */
function write(t: RepoTarget, args: readonly string[], opts: BranchOptions): Promise<unknown> {
  return retryOnLock(
    () => runGit([...hookArgs(opts), ...args], { cwd: t.cwd, timeoutMs: 30_000, category: 'git_state' }),
    {
      isRetryable: isHeldLockError,
      ...(opts.retry?.attempts !== undefined ? { attempts: opts.retry.attempts } : {}),
      ...(opts.retry?.delayMs !== undefined ? { delayMs: opts.retry.delayMs } : {}),
    },
  )
}

const refLocked = (what: string): BranchBlocker => ({
  kind: 'ref-locked',
  title: 'Another git process holds a lock',
  detail: `git could not lock ${what} after 3 tries. Wait for the other git command to finish, then check again.`,
  commands: [],
})

/**
 * Undo a just-created run branch ref (old-value guarded, so nothing else is ever deleted). False when git could not
 * delete it (a held lock after the retries) and the ref is still there.
 */
async function dropRef(t: RepoTarget, ref: string, base: string, opts: BranchOptions): Promise<boolean> {
  try {
    await write(t, ['update-ref', '-d', ref, base], opts)
    return true
  } catch {
    return (await refCommit(t.cwd, ref).catch(() => base)) === null
  }
}

/** A run branch ref Dim Factory made and could not remove again: named, with the command that removes it. */
function refLeft(name: string, os: OsFamily): BranchBlocker {
  const fix = repairCommand('deleteBranch', os, name)
  return {
    kind: 'ref-left',
    title: `The branch ${name} was left behind`,
    detail: `Dim Factory made ${name} and could not remove it again. Recheck uses it for this run; to remove it yourself, run the command.`,
    commands: fix === null ? [] : [fix],
  }
}

/**
 * `leftover`: the run branch ref Dim Factory made exists but HEAD is not on it (the rollback could not delete it); the
 * caller keeps it as the run's pending branch, so a Recheck adopts it (prepareRunBranch `pending`) and a stopped run
 * can still delete it.
 */
export type CreateBranchResult =
  | { ok: true; branch: RunBranchInfo; notes: string[] }
  | { ok: false; blockers: BranchBlocker[]; leftover?: RunBranchInfo }

/**
 * Create the run branch at HEAD's commit and point HEAD at it: `update-ref refs/heads/<name>
 * <HEAD> 0…0` (create-only), then `symbolic-ref HEAD refs/heads/<name>`, under the common-dir mutex. The working tree
 * and the index are not touched: the branch points at the commit HEAD already has. A detached HEAD is info only
 * (`previous` = `detached:<sha>`). Blockers come back as data; unexpected git failures throw GitError.
 */
export async function createRunBranch(
  repo: RepoInfo,
  name: string,
  opts: BranchOptions = {},
): Promise<CreateBranchResult> {
  const { blockers } = await branchBlockers(repo, opts)
  if (blockers.length > 0) return { ok: false, blockers }
  const t = targetOf(repo)
  if (t === null) return { ok: false, blockers: [notRepo()] }
  if (!(await isValidBranchName(t.cwd, name))) return { ok: false, blockers: [invalidName(name)] }
  const ref = `refs/heads/${name}`
  return withCommonDirLock(
    t.commonDir,
    async (): Promise<CreateBranchResult> => {
      const head = await readHead(t.cwd)
      if (head.commit === null) return { ok: false, blockers: [unbornBlocker()] }
      const base = head.commit
      const branch: RunBranchInfo = { name, base, previous: head.ref ?? `detached:${base}` }
      await opts.onIntent?.(branch)
      try {
        await write(
          t,
          ['update-ref', '-m', `dim-factory: create run branch ${name}`, ref, base, ZERO_OID],
          opts,
        )
      } catch (err) {
        if (isHeldLockError(err)) return { ok: false, blockers: [refLocked(ref)] }
        if (isGitError(err) && /already exists|exists; cannot create|but expected/i.test(err.stderr)) {
          return {
            ok: false,
            blockers: [
              {
                kind: 'name-taken',
                title: 'The run branch name is taken',
                detail: `A branch named ${name} (or a folder of branches with that name) already exists.`,
                commands: [],
              },
            ],
          }
        }
        throw err
      }
      // HEAD must not have moved between the read and the ref write (a commit or checkout by the user).
      const os = opts.os ?? osFamily()
      // A read that fails counts as moved: the ref is rolled back (or named as left) rather than left unreported.
      const again = await readHead(t.cwd).catch(() => null)
      if (again === null || again.ref !== head.ref || again.commit !== head.commit) {
        const moved: BranchBlocker = {
          kind: 'head-moved',
          title: 'HEAD moved while the run branch was being made',
          detail: 'Another git command changed HEAD. Check again.',
          commands: [],
        }
        if (await dropRef(t, ref, base, opts)) return { ok: false, blockers: [moved] }
        return { ok: false, blockers: [moved, refLeft(name, os)], leftover: branch }
      }
      try {
        await write(t, ['symbolic-ref', '-m', `dim-factory: switch to run branch ${name}`, 'HEAD', ref], opts)
      } catch (err) {
        if (!(await dropRef(t, ref, base, opts))) {
          const why = isHeldLockError(err) ? refLocked('HEAD') : gitWriteBlocker(err)
          return { ok: false, blockers: [why, refLeft(name, os)], leftover: branch }
        }
        if (isHeldLockError(err)) return { ok: false, blockers: [refLocked('HEAD')] }
        throw err
      }
      return { ok: true, branch, notes: detachedNotes(branch) }
    },
    { attempts: 1 },
  )
}

function detachedNotes(b: RunBranchInfo): string[] {
  const sha = detachedSha(b.previous)
  return sha !== null ? [`HEAD was detached at ${shortSha(sha)}. The run branch starts there.`] : []
}

/** An unexpected git failure of a user-repo write, as a blocker (only used when a ref is left to name too). */
function gitWriteBlocker(err: unknown): BranchBlocker {
  return {
    kind: 'ref-locked',
    title: 'git could not switch to the run branch',
    detail: err instanceof Error ? err.message : String(err),
    commands: [],
  }
}

export type SettleResult =
  /** The pending branch is the run's: HEAD is on it (or was just pointed at it, `finish`). */
  | { state: 'adopted'; branch: RunBranchInfo; notes: string[] }
  /** Nothing of it is left to use: the ref never got written, or a stale one was removed or left alone. */
  | { state: 'gone'; notes: string[] }
  /** It is still there and was not finished (`finish` false) or could not be finished or removed now. */
  | { state: 'kept'; blockers: BranchBlocker[] }

/**
 * A run branch recorded before its ref writes (BranchOptions.onIntent) whose result never arrived (a crash) or whose
 * rollback failed (CreateBranchResult.leftover). Under the common-dir mutex:
 * - the ref is missing: gone (it was never written);
 * - HEAD is on it: adopted, whatever its tip (the user may have committed on it since);
 * - it has other commits and HEAD is elsewhere: no longer the run's, left alone (gone);
 * - it points at `base` and HEAD is where the run started (`previous` at `base`): with `finish`, HEAD is pointed at
 *   it (the write that never happened) and it is adopted; without, it is kept pending;
 * - it points at `base` but HEAD moved on: stale; removed (old-value guarded) unless a worktree has it checked out.
 */
export async function settlePendingBranch(
  repo: RepoInfo,
  pending: RunBranchInfo,
  opts: BranchOptions & { finish: boolean },
): Promise<SettleResult> {
  assertBranchInfo(pending)
  const t = targetOf(repo)
  if (t === null || repo.dubiousOwnership) return { state: 'gone', notes: [] }
  const os = opts.os ?? osFamily()
  const ref = `refs/heads/${pending.name}`
  return withCommonDirLock(
    t.commonDir,
    async (): Promise<SettleResult> => {
      const [head, tip] = await Promise.all([readHead(t.cwd), refCommit(t.cwd, ref)])
      if (tip === null) return { state: 'gone', notes: [] }
      if (head.ref === ref) return { state: 'adopted', branch: { ...pending }, notes: detachedNotes(pending) }
      if (tip !== pending.base) {
        return {
          state: 'gone',
          notes: [
            `${pending.name} has commits Dim Factory did not make, so Dim Factory leaves it and makes a new run branch.`,
          ],
        }
      }
      const startedHere =
        head.commit === pending.base &&
        (detachedSha(pending.previous) !== null ? head.ref === null : head.ref === pending.previous)
      if (startedHere) {
        if (!opts.finish) return { state: 'kept', blockers: [] }
        try {
          await write(
            t,
            ['symbolic-ref', '-m', `dim-factory: switch to run branch ${pending.name}`, 'HEAD', ref],
            opts,
          )
        } catch (err) {
          if (isHeldLockError(err))
            return { state: 'kept', blockers: [refLocked('HEAD'), refLeft(pending.name, os)] }
          throw err
        }
        return { state: 'adopted', branch: { ...pending }, notes: detachedNotes(pending) }
      }
      if (await checkedOutAnywhere(t.commonDir, ref)) {
        return {
          state: 'gone',
          notes: [`${pending.name} is checked out in another worktree, so Dim Factory leaves it.`],
        }
      }
      if (await dropRef(t, ref, pending.base, opts)) return { state: 'gone', notes: [] }
      return { state: 'kept', blockers: [refLocked(ref), refLeft(pending.name, os)] }
    },
    { attempts: 1 },
  )
}

/**
 * pickRunBranchName + createRunBranch, picking the next free name if another process took the chosen one in
 * between (a `-2…` suffix on collision). A `pending` branch (recorded before its writes, see
 * settlePendingBranch) is settled first: adopted, finished, or cleared before a new name is picked.
 */
export async function prepareRunBranch(
  repo: RepoInfo,
  o: { prefix: string; date: Date; task: string },
  opts: BranchOptions & { pending?: RunBranchInfo } = {},
): Promise<CreateBranchResult> {
  const notes: string[] = []
  if (opts.pending !== undefined) {
    const { blockers } = await branchBlockers(repo, opts)
    if (blockers.length > 0) return { ok: false, blockers, leftover: opts.pending }
    const settled = await settlePendingBranch(repo, opts.pending, { ...opts, finish: true })
    if (settled.state === 'adopted') return { ok: true, branch: settled.branch, notes: settled.notes }
    if (settled.state === 'kept') return { ok: false, blockers: settled.blockers, leftover: opts.pending }
    notes.push(...settled.notes)
  }
  for (let i = 0; ; i++) {
    const picked = await pickRunBranchName(repo, o)
    if (!picked.ok) return { ok: false, blockers: [picked.blocker] }
    const r = await createRunBranch(repo, picked.name, opts)
    if (r.ok) return notes.length > 0 ? { ...r, notes: [...notes, ...r.notes] } : r
    if (i >= 2 || !r.blockers.some((b) => b.kind === 'name-taken')) return r
  }
}

// ---- end of run ------------------------------------------------------------------------------------------------

/** `detached:<sha>` → the sha; else null. */
function detachedSha(previous: string): string | null {
  const m = /^detached:([0-9a-f]{7,64})$/.exec(previous)
  return m?.[1] ?? null
}

const commandsOf = (...cmds: (ShellCommand | null)[]): string[] =>
  cmds.filter((c): c is ShellCommand => c !== null).map((c) => c.command)

/**
 * [Return to `<prev>`] (end of run): only while HEAD still is `refs/heads/<name>`, `<prev>` still exists
 * and still points at HEAD's commit; then `symbolic-ref HEAD <prev>` (the tree and index stay as they are). A
 * detached `<prev>` is refused with the copyable `git checkout --detach <sha>`; any other case returns copyable
 * commands instead of acting.
 */
export async function returnToPrevious(
  repo: RepoInfo,
  branch: RunBranchInfo,
  opts: BranchOptions = {},
): Promise<BranchActionResult> {
  assertBranchInfo(branch)
  const t = targetOf(repo)
  if (t === null || repo.dubiousOwnership)
    return { done: false, reason: 'Git cannot read this repository.', commands: [] }
  const os = opts.os ?? osFamily()
  const ref = `refs/heads/${branch.name}`
  return withCommonDirLock(
    t.commonDir,
    async (): Promise<BranchActionResult> => {
      const head = await readHead(t.cwd)
      if (head.ref !== ref) {
        return {
          done: false,
          reason: `HEAD is no longer on ${branch.name}, so Dim Factory leaves it where it is.`,
          commands: [],
        }
      }
      const sha = detachedSha(branch.previous)
      if (sha !== null) {
        return {
          done: false,
          reason: `The run started on a detached HEAD at ${shortSha(sha)}. Dim Factory only moves HEAD between branches; run the command to go back.`,
          commands: commandsOf(repairCommand('checkoutDetach', os, sha)),
        }
      }
      const prev = branch.previous
      const prevName = branchShortName(prev)
      if (!prev.startsWith('refs/heads/')) {
        return { done: false, reason: `${prev} is not a branch.`, commands: [] }
      }
      const prevCommit = await refCommit(t.cwd, prev)
      if (prevCommit === null) {
        return { done: false, reason: `${prevName} no longer exists.`, commands: [] }
      }
      if (prevCommit !== head.commit) {
        return {
          done: false,
          reason: `${prevName} and ${branch.name} now point at different commits, so going back needs a checkout.`,
          commands: commandsOf(repairCommand('checkoutBranch', os, prev)),
        }
      }
      try {
        await write(t, ['symbolic-ref', '-m', `dim-factory: return to ${prevName}`, 'HEAD', prev], opts)
      } catch (err) {
        if (isHeldLockError(err)) {
          return {
            done: false,
            reason: 'Another git process holds the HEAD lock. Try again in a moment.',
            commands: commandsOf(repairCommand('checkoutBranch', os, prev)),
          }
        }
        throw err
      }
      return { done: true, commands: [] }
    },
    { attempts: 1 },
  )
}

/** Is `ref` checked out by any worktree of the repository (`<common>/HEAD`, `<common>/worktrees/*\/HEAD`)? */
export async function checkedOutAnywhere(commonDir: string, ref: string): Promise<boolean> {
  const heads = [path.join(commonDir, 'HEAD')]
  const names = await readdir(path.join(commonDir, 'worktrees')).catch(() => [] as string[])
  for (const n of names) heads.push(path.join(commonDir, 'worktrees', n, 'HEAD'))
  for (const h of heads) {
    const text = await readFile(h, 'utf8').catch(() => '')
    if (text.trim() === `ref: ${ref}`) return true
  }
  return false
}

/**
 * [Delete run branch] (end of run): only when the branch is not checked out (in any worktree) and its tip
 * still equals `base`; then `update-ref -d refs/heads/<name> <base>` (old-value guarded). Otherwise copyable
 * commands. A branch that is already gone counts as done.
 */
export async function deleteRunBranch(
  repo: RepoInfo,
  branch: RunBranchInfo,
  opts: BranchOptions = {},
): Promise<BranchActionResult> {
  assertBranchInfo(branch)
  const t = targetOf(repo)
  if (t === null || repo.dubiousOwnership)
    return { done: false, reason: 'Git cannot read this repository.', commands: [] }
  const os = opts.os ?? osFamily()
  const ref = `refs/heads/${branch.name}`
  return withCommonDirLock(
    t.commonDir,
    async (): Promise<BranchActionResult> => {
      const [head, tip] = await Promise.all([readHead(t.cwd), refCommit(t.cwd, ref)])
      if (tip === null) return { done: true, reason: `${branch.name} no longer exists.`, commands: [] }
      if (head.ref === ref) {
        const sha = detachedSha(branch.previous)
        const back =
          sha !== null
            ? repairCommand('checkoutDetach', os, sha)
            : repairCommand('checkoutBranch', os, branch.previous)
        return {
          done: false,
          reason: `${branch.name} is checked out. Go back to ${sha !== null ? 'the previous commit' : branchShortName(branch.previous)} first.`,
          commands: commandsOf(back, repairCommand('deleteBranch', os, branch.name)),
        }
      }
      if (await checkedOutAnywhere(t.commonDir, ref)) {
        return { done: false, reason: `${branch.name} is checked out in another worktree.`, commands: [] }
      }
      if (tip !== branch.base) {
        return {
          done: false,
          reason: `${branch.name} has commits the run did not make, so Dim Factory keeps it.`,
          commands: commandsOf(repairCommand('deleteBranch', os, branch.name)),
        }
      }
      try {
        await write(t, ['update-ref', '-d', ref, branch.base], opts)
      } catch (err) {
        if (isHeldLockError(err) || (isGitError(err) && /but expected/i.test(err.stderr))) {
          return {
            done: false,
            reason: `git could not delete ${branch.name} right now.`,
            commands: commandsOf(repairCommand('deleteBranch', os, branch.name)),
          }
        }
        throw err
      }
      return { done: true, commands: [] }
    },
    { attempts: 1 },
  )
}

/** A run.json branch record Dim Factory can act on (a programming error otherwise; git failures are GitError). */
function assertBranchInfo(b: RunBranchInfo): void {
  if (!/^[0-9a-f]{40,64}$/.test(b.base) || b.name === '' || b.name.startsWith('-')) {
    throw new GitError('exit', `invalid run branch record: ${JSON.stringify(b)}`, {
      args: [],
      category: 'git_state',
    })
  }
}
