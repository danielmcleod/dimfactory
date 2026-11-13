// Isolated runs' worktree: eligibility, create, remove (the worktree and its branch are the only writes to the
// user's repo, under the common-dir mutex with hooks off). The worktree's snapshots live in its own shadow, keyed by
// its path and dropped with it.
import { chmod, lstat, mkdir, readFile, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { FailureCategory } from '../../shared/failure.ts'
import { errnoCode, errorMessage } from '../errors.ts'
import { osFamily, repairCommand } from '../heal/commands.ts'
import type { OsFamily, ShellCommand } from '../heal/commands.ts'
import { homePaths, resolveHome } from '../home.ts'
import { freeBytes as volumeFreeBytes, removeShadow } from '../store/storage.ts'
import { checkedOutAnywhere, isValidBranchName, readHead } from './branch.ts'
import { forgetDiffView } from './diff-view.ts'
import { classifyGitFailure, isLockContention, runGit, splitNul, tryGit } from './exec.ts'
import type { GitError, GitRunOptions } from './exec.ts'
import { withCommonDirLock, withFolderLock } from './mutex.ts'
import {
  detectRepo,
  folderKeyOf,
  normalizeLockPath,
  probeCaseInsensitive,
  resolveScope,
  stripLongPathPrefix,
} from './repo.ts'
import type { RepoInfo } from './repo.ts'
import { forgetShadows, gitConfigPath, shadowFor } from './shadow.ts'
import type { Shadow, ShadowOpenOptions } from './shadow.ts'

/** Warn when a worktree path would pass this many characters (win32, core.longpaths off). */
export const LONG_PATH_LIMIT = 240
/** Free disk must be at least 1.2 x the HEAD tree ... */
export const DISK_FACTOR = 1.2
/** ... plus 500 MB. */
export const DISK_MARGIN_BYTES = 500 * 1024 ** 2
/** A checkout of a large repository (LFS smudge included) can take minutes. */
export const WORKTREE_ADD_TIMEOUT_MS = 15 * 60_000
/** A run id of the usual length, for path estimates made before the run exists (`newRunId`). */
const SAMPLE_RUN_ID = '20260101T000000Z-0000'
const BIG_OUTPUT = 256 * 1024 * 1024

// ---- small helpers ---------------------------------------------------------------------------------------------

const exists = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false,
  )

const readOpts = (cwd: string, extra: Partial<GitRunOptions> = {}): GitRunOptions => ({
  cwd,
  noOptionalLocks: true,
  timeoutMs: 120_000,
  category: 'git_state',
  ...extra,
})

/** A ref's commit, or null when it does not exist. */
async function refCommit(cwd: string, ref: string, env?: Record<string, string>): Promise<string | null> {
  const r = await runGit(
    ['rev-parse', '-q', '--verify', `${ref}^{commit}`],
    readOpts(cwd, { okCodes: [0, 1], ...(env !== undefined ? { env } : {}) }),
  )
  const sha = r.code === 0 ? r.stdout.trim() : ''
  return sha === '' ? null : sha
}

/** "1.4 GB", "820 MB", "12 KB" (UI copy). */
export function formatBytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return i === 0
    ? `${Math.round(v)} bytes`
    : `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`
}

/** The folder itself when it exists, else its nearest existing parent (statfs needs an existing path). */
async function nearestExisting(dir: string): Promise<string> {
  let cur = path.resolve(dir)
  for (;;) {
    if (await exists(cur)) return cur
    const parent = path.dirname(cur)
    if (parent === cur) return cur
    cur = parent
  }
}

/** Same path, compared the way the platform does (case-folded on win32 and macOS). */
function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(stripLongPathPrefix(p)).replace(/[\\/]+$/, '')
    return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

// ---- eligibility -----------------------------------------------------------------------------------------------

export type EligibilityBlockerKind = 'not-repo' | 'dubious-ownership' | 'no-commit' | 'disk-space' | 'git'

/** Why an isolated run cannot start in this folder, as UI copy plus the copyable commands that fix it. */
export interface EligibilityBlocker {
  kind: EligibilityBlockerKind
  title: string
  detail: string
  /** Copied to the clipboard (`shell_copy`), never run by Dim Factory. */
  commands: ShellCommand[]
}

/** win32: a path in the worktree would pass LONG_PATH_LIMIT while core.longpaths is off (a warning, not a block). */
export interface LongPathWarning {
  title: string
  detail: string
  /** Characters of the longest path the worktree would have. */
  longest: number
  limit: number
  /** `git config --global core.longpaths true`. */
  command: ShellCommand
}

export interface WorktreeEligibility {
  ok: boolean
  /** One line of UI copy per blocker ("title. detail"). */
  reasons: string[]
  blockers: EligibilityBlocker[]
  longPathWarning?: LongPathWarning
  /** HEAD's commit, when the repository has one. */
  head?: string
  /** Bytes of the HEAD tree's files. */
  treeBytes?: number
  /** What the worktree needs free: 1.2 x treeBytes + 500 MB. */
  neededBytes?: number
  /** Free bytes on the volume holding `<home>/worktrees` (null when the platform cannot say). */
  freeBytes?: number | null
}

export interface EligibilityOptions {
  /** DIM_FACTORY_HOME (default: resolveHome()). The worktree would be `<home>/worktrees/<runId>`. */
  home?: string
  /** The run's id, for the path length estimate (default: a run id of the usual length). */
  runId?: string
  platform?: NodeJS.Platform
  /** Free bytes on the volume holding a folder (tests). */
  freeBytes?: (dir: string) => Promise<number | null>
}

const reasonText = (b: EligibilityBlocker): string => `${b.title}. ${b.detail}`

interface TreeFacts {
  bytes: number
  /** Characters of the longest path (as Windows counts them). */
  longest: number
}

/** `ls-tree -r -l -z <commit>`: the files' total size and the longest path. */
async function headTreeFacts(cwd: string, commit: string): Promise<TreeFacts> {
  const r = await runGit(
    ['ls-tree', '-r', '-l', '-z', '--full-tree', commit],
    readOpts(cwd, { maxBytes: BIG_OUTPUT }),
  )
  let bytes = 0
  let longest = 0
  for (const rec of splitNul(r.stdout)) {
    const m = /^(\d{6}) (\w+) [0-9a-f]+\s+(-|\d+)\t([\s\S]*)$/.exec(rec)
    if (m === null) continue
    const size = m[3] ?? '-'
    if (m[2] === 'blob' && size !== '-') bytes += Number(size)
    longest = Math.max(longest, (m[4] ?? '').length)
  }
  return { bytes, longest }
}

/** `git config --bool --get <key>` in the repo (system, global and local): true, false, or null when unset. */
async function configBool(cwd: string, key: string): Promise<boolean | null> {
  const r = await tryGit(
    ['config', '--bool', '--get', key],
    readOpts(cwd, { okCodes: [0, 1], timeoutMs: 15_000 }),
  )
  if (!r.ok || r.result.code !== 0) return null
  const v = r.result.stdout.trim()
  return v === 'true' ? true : v === 'false' ? false : null
}

/**
 * Can an Isolated run start from `folder`? Reads only (`--no-optional-locks`): a git repo
 * with at least one commit; free disk on the worktrees volume of at least 1.2 x the HEAD tree + 500 MB (unknown free
 * space never blocks); on win32 a warning when the worktree's longest path would pass 240 characters and git's
 * core.longpaths is off.
 */
export async function checkEligibility(
  folder: string,
  opts: EligibilityOptions = {},
): Promise<WorktreeEligibility> {
  const platform = opts.platform ?? process.platform
  const os = osFamily(platform)
  const home = path.resolve(opts.home ?? resolveHome())
  const paths = homePaths(home)
  const blockers: EligibilityBlocker[] = []
  const result = (extra: Partial<WorktreeEligibility> = {}): WorktreeEligibility => ({
    ok: blockers.length === 0,
    reasons: blockers.map(reasonText),
    blockers,
    ...extra,
  })
  let repo: RepoInfo
  try {
    repo = await detectRepo(folder)
  } catch (err) {
    blockers.push({
      kind: 'git',
      title: 'Dim Factory could not read the folder',
      detail: errorMessage(err),
      commands: [],
    })
    return result()
  }
  if (repo.dubiousOwnership) {
    const fix = repairCommand('safeDirectory', os, repo.toplevel ?? repo.realFolder)
    blockers.push({
      kind: 'dubious-ownership',
      title: 'Git does not trust this folder (dubious ownership)',
      detail: 'The folder belongs to another user account, so git refuses to use it.',
      commands: fix === null ? [] : [fix],
    })
    return result()
  }
  if (!repo.isRepo || repo.toplevel === undefined) {
    blockers.push({
      kind: 'not-repo',
      title: 'Not a git repository',
      detail:
        'An isolated run works in a git worktree, so the folder must be a git repository with at least one commit. Run in place instead, or initialize git and commit first.',
      commands: [],
    })
    return result()
  }
  const cwd = repo.toplevel
  let head: string | null
  try {
    head = (await readHead(cwd)).commit
  } catch (err) {
    blockers.push({ kind: 'git', title: 'Git could not read HEAD', detail: errorMessage(err), commands: [] })
    return result()
  }
  if (head === null) {
    blockers.push({
      kind: 'no-commit',
      title: 'The repository has no commits yet',
      detail: 'An isolated run starts from the last commit. Commit once first, or run in place.',
      commands: [],
    })
    return result()
  }
  let facts: TreeFacts
  try {
    facts = await headTreeFacts(cwd, head)
  } catch (err) {
    blockers.push({
      kind: 'git',
      title: 'Git could not list the last commit',
      detail: errorMessage(err),
      commands: [],
    })
    return result({ head })
  }
  const neededBytes = Math.ceil(DISK_FACTOR * facts.bytes + DISK_MARGIN_BYTES)
  const free = await (opts.freeBytes ?? volumeFreeBytes)(await nearestExisting(paths.worktreesDir)).catch(
    () => null,
  )
  if (free !== null && free < neededBytes) {
    blockers.push({
      kind: 'disk-space',
      title: 'Not enough free disk space for an isolated run',
      detail: `Its worktree needs about ${formatBytes(neededBytes)} free (1.2 times the repository's files plus 500 MB); the drive has ${formatBytes(free)}. Free some space, or run in place.`,
      commands: [],
    })
  }
  const out = result({ head, treeBytes: facts.bytes, neededBytes, freeBytes: free })
  if (platform === 'win32' && facts.longest > 0) {
    const wt = path.win32.join(paths.worktreesDir, opts.runId ?? SAMPLE_RUN_ID)
    const longest = wt.length + 1 + facts.longest
    if (longest > LONG_PATH_LIMIT && (await configBool(cwd, 'core.longpaths')) !== true) {
      const command = repairCommand('longPaths', os) ?? {
        command: 'git config --global core.longpaths true',
        shell: 'powershell' as const,
      }
      out.longPathWarning = {
        title: 'Some paths in the worktree may be too long for Windows',
        detail: `The worktree's longest path would be ${longest} characters (over ${LONG_PATH_LIMIT}) and git's core.longpaths is off, so git and other tools may fail on it there. Turn long paths on with the command, or run in place.`,
        longest,
        limit: LONG_PATH_LIMIT,
        command,
      }
    }
  }
  return out
}

// ---- the worktree's keys and shadow ----------------------------------------------------------------------------

/** Where an Isolated run's worktree lives, and the keys its lock and shadow use (computable before it exists). */
export interface WorktreeKeys {
  /** `<home>/worktrees/<runId>` */
  path: string
  /** normalize(realpath(path)), case folded per volume (the scheduler's lock key for the worktree). */
  lockKey: string
  /** sha256(lockKey).slice(0, 16): the worktree's shadow `<home>/shadow/<folderKey>`. */
  folderKey: string
}

/**
 * The worktree's path and keys. `<home>/worktrees` is created so its real path can be read; the worktree itself
 * need not exist yet (once it does, resolveScope(path) gives the same keys).
 */
export async function worktreeKeys(
  home: string,
  runId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<WorktreeKeys> {
  const paths = homePaths(home)
  const wt = paths.worktree(runId)
  await mkdir(paths.worktreesDir, { recursive: true })
  const realParent = stripLongPathPrefix(await realpath(paths.worktreesDir))
  const real = (await exists(wt)) ? stripLongPathPrefix(await realpath(wt)) : path.join(realParent, runId)
  const lockKey = normalizeLockPath(real, await probeCaseInsensitive(realParent, platform), platform)
  return { path: wt, lockKey, folderKey: folderKeyOf(lockKey) }
}

/** The worktree's own shadow (snapshots of an Isolated run), shared like every Shadow (shadowFor). */
export async function openWorktreeShadow(
  home: string,
  worktreePath: string,
  opts: Omit<ShadowOpenOptions, 'home'> = {},
): Promise<Shadow> {
  return shadowFor(await resolveScope(worktreePath, opts.platform), { ...opts, home })
}

/**
 * A worktree's shadow goes with its worktree: the run whose isolated copy `folder`
 * is, while that copy (`<home>/worktrees/<runId>`) still exists; undefined for any other folder. Reads only.
 */
export async function isolatedCopyRun(home: string, folder: string): Promise<string | undefined> {
  const paths = homePaths(home)
  const bases = [paths.worktreesDir]
  const real = await realpath(paths.worktreesDir).catch(() => null)
  if (real !== null) bases.push(stripLongPathPrefix(real))
  for (const base of bases) {
    // path.relative compares without case on win32, as the volume does.
    const rel = path.relative(base, stripLongPathPrefix(folder))
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue
    const id = rel.split(/[\\/]/)[0] ?? ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue
    const there = await lstat(path.join(paths.worktreesDir, id)).then(
      (s) => s.isDirectory(),
      () => false,
    )
    if (there) return id
  }
  return undefined
}

/** Drop a worktree's shadow (worktree shadows go with their worktree). */
export async function dropWorktreeShadow(home: string, folderKey: string): Promise<boolean> {
  const paths = homePaths(home)
  const dropped = await withFolderLock(folderKey, () => removeShadow(paths, folderKey))
  forgetShadows(folderKey)
  forgetDiffView(paths.shadowRepo(folderKey))
  return dropped
}

// ---- create ----------------------------------------------------------------------------------------------------

/** An Isolated run's worktree (createWorktree's result; the finalize journal keeps it). */
export interface WorktreeInfo {
  /** `<home>/worktrees/<runId>` */
  path: string
  /** The run's branch (`refs/heads/<branch>`), made by `worktree add -b`. */
  branch: string
  /** The commit the worktree started at (HEAD's commit when it was made). */
  base: string
  /** The worktree's folder key: its shadow is `<home>/shadow/<folderKey>`. */
  folderKey: string
  /** The user repository's common git dir (its writes serialize on it). */
  commonDir: string
  /** The user's folder the run came from: the repository's top level, where Apply writes. */
  folder: string
}

export type WorktreeErrorKind =
  | 'not-repo'
  | 'dubious-ownership'
  | 'no-commit'
  | 'invalid-name'
  | 'branch-exists'
  | 'path-exists'
  | 'path-too-long'
  | 'lfs'
  | 'locked'
  | 'disk-full'
  | 'outside-home'
  | 'git'

/** Why a worktree could not be made or removed (`worktree_failed`), with the commands that fix it. */
export class WorktreeError extends Error {
  readonly kind: WorktreeErrorKind
  readonly category: FailureCategory
  readonly commands: ShellCommand[]
  readonly stderr: string

  constructor(
    kind: WorktreeErrorKind,
    message: string,
    o: { category?: FailureCategory; commands?: ShellCommand[]; stderr?: string } = {},
  ) {
    super(message)
    this.name = 'WorktreeError'
    this.kind = kind
    this.category = o.category ?? 'worktree_failed'
    this.commands = o.commands ?? []
    this.stderr = o.stderr ?? ''
  }
}

export function isWorktreeError(err: unknown): err is WorktreeError {
  return err instanceof WorktreeError
}

const commandsOf = (...cmds: (ShellCommand | null)[]): ShellCommand[] =>
  cmds.filter((c): c is ShellCommand => c !== null)

/** A failed `worktree add` as `worktree_failed` words it: branch exists, path too long, LFS smudge, a held lock. */
export function worktreeErrorOf(err: GitError, os: OsFamily = osFamily()): WorktreeError {
  const stderr = err.stderr
  const first =
    stderr
      .split(/\r?\n/)
      .map((l) => l.replace(/^(?:fatal|error):\s*/, '').trim())
      .find((l) => l !== '') ?? err.message
  const category = classifyGitFailure(stderr, 'worktree_failed')
  if (category === 'disk_full')
    return new WorktreeError('disk-full', `The drive is full: ${first}`, { category, stderr })
  if (/branch named .* already exists|already exists/i.test(stderr) && /branch/i.test(stderr)) {
    return new WorktreeError('branch-exists', `The run's branch already exists: ${first}`, { stderr })
  }
  if (/Filename too long|path too long|name too long/i.test(stderr)) {
    return new WorktreeError('path-too-long', `A path in the worktree is too long: ${first}`, {
      stderr,
      commands: commandsOf(repairCommand('longPaths', os)),
    })
  }
  if (/smudge|git-lfs|\blfs\b/i.test(stderr)) {
    return new WorktreeError('lfs', `Git LFS could not check out a file: ${first}`, {
      stderr,
      commands: commandsOf(repairCommand('lfsInstall', os)),
    })
  }
  if (isLockContention(stderr)) {
    return new WorktreeError('locked', `Another git process holds a lock: ${first}`, {
      category: 'git_state',
      stderr,
      commands: commandsOf(repairCommand('worktreePrune', os)),
    })
  }
  if (err.kind === 'missing')
    return new WorktreeError('git', err.message, { category: 'git_missing', stderr })
  return new WorktreeError('git', `git worktree add failed: ${first}`, {
    stderr,
    commands: commandsOf(repairCommand('worktreePrune', os)),
  })
}

export interface CreateWorktreeOptions {
  /** DIM_FACTORY_HOME: the worktree is `<home>/worktrees/<runId>`, hooks off with `<home>/empty-hooks`. */
  home: string
  runId: string
  /** The user's folder (any folder inside the repository). */
  folder: string
  /** The run branch to create (`worktree add -b`). */
  branch: string
  /**
   * Write-ahead: called inside the common-dir lock right before `worktree add`, with what is about to exist. The
   * caller records it, so a crash between the add and its result leaves a worktree the run can adopt (a second
   * createWorktree with the same run id and branch adopts it). A throw aborts before any write.
   */
  onIntent?: (w: Omit<WorktreeInfo, 'folderKey'>) => Promise<void>
  /** Attempts while a `*.lock` is held (default 3, 500 ms apart). */
  retry?: { attempts?: number; delayMs?: number }
  timeoutMs?: number
  os?: OsFamily
}

const hooksArgs = (hooksDir: string): string[] => ['-c', `core.hooksPath=${gitConfigPath(hooksDir)}`]

/** `<worktree>/.git` names a registration under `<commonDir>/worktrees/` whose HEAD is `refs/heads/<branch>`. */
async function registeredOn(wtPath: string, commonDir: string, ref: string): Promise<boolean> {
  const dotGit = await readFile(path.join(wtPath, '.git'), 'utf8').catch(() => null)
  const m = dotGit === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(dotGit)
  if (m === null) return false
  const gitDir = path.resolve(wtPath, m[1] ?? '')
  const realCommon = stripLongPathPrefix(await realpath(commonDir).catch(() => commonDir))
  const realGitDir = stripLongPathPrefix(await realpath(gitDir).catch(() => gitDir))
  if (!samePath(path.dirname(path.dirname(realGitDir)), realCommon)) return false
  const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => '')
  return head.trim() === `ref: ${ref}`
}

/** Remove what a failed `worktree add` left: the folder it made, its registration, the branch at `base`. */
async function cleanupFailedAdd(o: {
  cwd: string
  commonDir: string
  wtPath: string
  ref: string
  base: string
  hooksDir: string
}): Promise<void> {
  if (await exists(o.wtPath)) {
    await unlinkLinksInside(o.wtPath).catch(() => undefined)
    const r = await tryGit([...hooksArgs(o.hooksDir), 'worktree', 'remove', '--force', o.wtPath], {
      cwd: o.cwd,
      timeoutMs: 120_000,
      category: 'worktree_failed',
    })
    if (!r.ok) await removeTree(o.wtPath).catch(() => undefined)
  }
  await tryGit([...hooksArgs(o.hooksDir), 'worktree', 'prune'], {
    cwd: o.cwd,
    timeoutMs: 60_000,
    category: 'worktree_failed',
  })
  const tip = await refCommit(o.cwd, o.ref).catch(() => null)
  if (tip === o.base && !(await checkedOutAnywhere(o.commonDir, o.ref))) {
    await tryGit([...hooksArgs(o.hooksDir), 'update-ref', '-d', o.ref, o.base], {
      cwd: o.cwd,
      timeoutMs: 30_000,
      category: 'worktree_failed',
    })
  }
}

/**
 * Make the run's worktree (Prepare step 1): `git -c core.hooksPath=<home>/empty-hooks -c core.longpaths=true
 * worktree add -b <branch> <home>/worktrees/<runId> <HEAD's commit>` under the common-dir mutex. HEAD is read once
 * under the mutex and passed as its commit, so `base` is exactly where the branch starts. A worktree this run already
 * made (the same path, registered, on the same branch) is adopted, so Resume repeats the step without a second one; so
 * is the branch alone (at HEAD's commit, in no worktree: what a crash inside `worktree add` leaves).
 * The user's index, HEAD and other refs are not written. Throws WorktreeError (worktree_failed) with the
 * copyable fixes; a held `*.lock` is retried 3 x 500 ms, each failed attempt cleaned up first.
 */
export async function createWorktree(o: CreateWorktreeOptions): Promise<WorktreeInfo> {
  const os = o.os ?? osFamily()
  const paths = homePaths(o.home)
  const wtPath = paths.worktree(o.runId)
  const repo = await detectRepo(o.folder)
  if (repo.dubiousOwnership) {
    throw new WorktreeError('dubious-ownership', 'Git does not trust this folder (dubious ownership).', {
      category: 'git_state',
      commands: commandsOf(repairCommand('safeDirectory', os, repo.toplevel ?? repo.realFolder)),
    })
  }
  if (!repo.isRepo || repo.toplevel === undefined) {
    throw new WorktreeError('not-repo', 'An isolated run needs a git repository.')
  }
  const cwd = repo.toplevel
  const commonDir = repo.commonDir ?? path.join(cwd, '.git')
  await mkdir(paths.worktreesDir, { recursive: true })
  await mkdir(paths.emptyHooksDir, { recursive: true })
  if (!(await isValidBranchName(cwd, o.branch))) {
    throw new WorktreeError('invalid-name', `git does not accept "${o.branch}" as a branch name.`)
  }
  const ref = `refs/heads/${o.branch}`
  const hooksDir = paths.emptyHooksDir
  const finish = async (base: string): Promise<WorktreeInfo> => {
    const scope = await resolveScope(wtPath)
    return { path: wtPath, branch: o.branch, base, folderKey: scope.folderKey, commonDir, folder: cwd }
  }
  return withCommonDirLock(
    commonDir,
    async (): Promise<WorktreeInfo> => {
      if (await exists(wtPath)) {
        if (await registeredOn(wtPath, commonDir, ref)) {
          const tip = await refCommit(cwd, ref)
          if (tip !== null) return finish(tip)
        }
        throw new WorktreeError(
          'path-exists',
          `${wtPath} already exists and is not this run's worktree, so Dim Factory leaves it.`,
        )
      }
      const head = await readHead(cwd)
      if (head.commit === null) {
        throw new WorktreeError(
          'no-commit',
          'The repository has no commits yet, so there is nothing to start from.',
        )
      }
      const base = head.commit
      // A branch of this name at HEAD's commit that no worktree has is what a crash inside `worktree add` (it makes
      // the branch first) leaves of this run (the caller's names are the run's own): used, not made again.
      const leftover = async (): Promise<boolean> => {
        const tip = await refCommit(cwd, ref)
        if (tip === null) return false
        if (tip !== base || (await checkedOutAnywhere(commonDir, ref))) {
          throw new WorktreeError('branch-exists', `A branch named ${o.branch} already exists.`)
        }
        return true
      }
      await leftover()
      await o.onIntent?.({ path: wtPath, branch: o.branch, base, commonDir, folder: cwd })
      const attempts = Math.max(1, o.retry?.attempts ?? 3)
      for (let i = 1; ; i++) {
        const add = (await leftover()) ? [wtPath, o.branch] : ['-b', o.branch, wtPath, base]
        const r = await tryGit(
          [...hooksArgs(hooksDir), '-c', 'core.longpaths=true', 'worktree', 'add', ...add],
          { cwd, timeoutMs: o.timeoutMs ?? WORKTREE_ADD_TIMEOUT_MS, category: 'worktree_failed' },
        )
        if (r.ok) break
        await cleanupFailedAdd({ cwd, commonDir, wtPath, ref, base, hooksDir })
        if (i < attempts && isLockContention(r.error.stderr)) {
          await delay(o.retry?.delayMs ?? 500)
          continue
        }
        throw worktreeErrorOf(r.error, os)
      }
      return finish(base)
    },
    { attempts: 1 },
  )
}

// ---- remove ----------------------------------------------------------------------------------------------------

async function retryBusy<T>(op: () => Promise<T>): Promise<T> {
  const waits = [100, 250, 500, 1000]
  for (let i = 0; ; i++) {
    try {
      return await op()
    } catch (err) {
      const code = errnoCode(err)
      const wait = waits[i]
      if (
        wait === undefined ||
        (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOTEMPTY')
      )
        throw err
      await delay(wait)
    }
  }
}

/** Remove a link itself (a symbolic link or a Windows junction), never what it points at. */
async function removeLink(abs: string): Promise<void> {
  try {
    await unlink(abs)
  } catch (err) {
    // win32: a directory link or junction is removed with rmdir (which removes the link, not its target).
    if (errnoCode(err) === 'EPERM' || errnoCode(err) === 'EISDIR') await rmdir(abs)
    else throw err
  }
}

/**
 * Unlink every link inside `dir` (symbolic links and Windows junctions; lstat reads both as links) without
 * following any, so a later recursive removal (git's or ours) can never reach a folder outside the worktree.
 */
export async function unlinkLinksInside(dir: string): Promise<number> {
  let n = 0
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(d, e.name)
      const st = await lstat(abs).catch(() => null)
      if (st === null) continue
      if (st.isSymbolicLink()) {
        await retryBusy(() => removeLink(abs))
        n++
      } else if (st.isDirectory()) await walk(abs)
    }
  }
  await walk(dir)
  return n
}

/** Recursive removal that never follows a link: links are unlinked, read-only files made writable first (win32). */
export async function removeTree(abs: string): Promise<void> {
  const st = await lstat(abs).catch(() => null)
  if (st === null) return
  if (st.isSymbolicLink()) return retryBusy(() => removeLink(abs))
  if (st.isDirectory()) {
    for (const name of await readdir(abs)) await removeTree(path.join(abs, name))
    await retryBusy(() => rmdir(abs))
    return
  }
  await retryBusy(async () => {
    try {
      await unlink(abs)
    } catch (err) {
      if (errnoCode(err) !== 'EPERM' && errnoCode(err) !== 'EACCES') throw err
      await chmod(abs, 0o666).catch(() => undefined)
      await unlink(abs)
    }
  })
}

export interface RemoveWorktreeOptions {
  home: string
  /** The worktree (its record in the finalize journal). `commonDir`, `folder` and `folderKey` are read when absent. */
  worktree: Pick<WorktreeInfo, 'path' | 'branch' | 'base'> &
    Partial<Omit<WorktreeInfo, 'path' | 'branch' | 'base'>>
  os?: OsFamily
}

export interface RemoveWorktreeResult {
  /** The worktree's folder is gone (it was removed now, or was already gone). */
  removed: boolean
  /** The run branch is gone (deleted now, or already gone). False: kept, `notes` say why. */
  branchDeleted: boolean
  /** The worktree's shadow was dropped (it goes with the worktree). */
  shadowDropped: boolean
  /** UI copy for what was left and why. */
  notes: string[]
  /** Copyable commands for what Dim Factory left. */
  commands: ShellCommand[]
}

/**
 * Is `ref` checked out by a worktree other than `wtPath` (the main one, or another registration)? The registration of
 * `wtPath` itself is left out: after its folder was deleted by hand it stays until `worktree prune`.
 */
async function checkedOutElsewhere(commonDir: string, ref: string, wtPath: string): Promise<boolean> {
  const main = await readFile(path.join(commonDir, 'HEAD'), 'utf8').catch(() => '')
  if (main.trim() === `ref: ${ref}`) return true
  // Its spellings: as given, and under its parent's real path (8.3 names, links in the home's path).
  const parent = await realpath(path.dirname(wtPath)).catch(() => path.dirname(wtPath))
  const own = [wtPath, path.join(stripLongPathPrefix(parent), path.basename(wtPath))]
  for (const n of await readdir(path.join(commonDir, 'worktrees')).catch(() => [] as string[])) {
    const dir = path.join(commonDir, 'worktrees', n)
    const gitdir = (await readFile(path.join(dir, 'gitdir'), 'utf8').catch(() => '')).trim()
    const at = gitdir !== '' ? path.dirname(path.resolve(dir, gitdir)) : ''
    if (at !== '' && own.some((p) => samePath(at, p))) continue
    const head = await readFile(path.join(dir, 'HEAD'), 'utf8').catch(() => '')
    if (head.trim() === `ref: ${ref}`) return true
  }
  return false
}

/** The common dir of a worktree that still exists (`rev-parse --git-common-dir` inside it). */
async function commonDirOf(wtPath: string): Promise<string | undefined> {
  const r = await tryGit(['rev-parse', '--git-common-dir'], readOpts(wtPath, { timeoutMs: 15_000 }))
  if (!r.ok) return undefined
  const v = r.result.stdout.trim()
  return v === '' ? undefined : path.resolve(wtPath, v)
}

/**
 * Clean up an Isolated run's worktree, under the common-dir mutex: every link inside it unlinked
 * (never followed), then `worktree remove --force` (our own link-safe removal when git cannot, e.g. git 2.17 with
 * submodules), then `update-ref -d refs/heads/<branch> <base>` (only while the branch still points at base and no
 * worktree has it; a branch with commits is kept, with the copyable command), then `worktree prune`. Once the folder
 * is gone its shadow is dropped. Only a folder directly under `<home>/worktrees` is ever removed. Callers decide when:
 * never for an unfinalized worktree on their own.
 */
export async function removeWorktree(o: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
  const os = o.os ?? osFamily()
  const paths = homePaths(o.home)
  const wt = o.worktree
  const wtPath = path.resolve(wt.path)
  if (!samePath(path.dirname(wtPath), paths.worktreesDir) || path.basename(wtPath) === '') {
    throw new WorktreeError(
      'outside-home',
      `${wt.path} is not a Dim Factory worktree, so Dim Factory does not remove it.`,
    )
  }
  const ref = `refs/heads/${wt.branch}`
  const notes: string[] = []
  const commands: ShellCommand[] = []
  const present = await exists(wtPath)
  const folderKey =
    wt.folderKey ??
    (present ? (await resolveScope(wtPath).catch(() => null))?.folderKey : undefined) ??
    (await worktreeKeys(o.home, path.basename(wtPath)).catch(() => null))?.folderKey
  // A copy made from a snapshot (no branch) is a plain folder: it is no git worktree and has no branch, so its
  // folder and its shadow go and git never runs in the user's repository.
  if (wt.branch === '') {
    let gone = !present
    if (present) {
      await unlinkLinksInside(wtPath)
      try {
        await removeTree(wtPath)
      } catch (err) {
        notes.push(
          `Dim Factory could not remove the copy's folder ${wtPath}: ${errorMessage(err)}. Close any program using it, then discard again.`,
        )
      }
      gone = !(await exists(wtPath))
    }
    let dropped = false
    if (gone && folderKey !== undefined) {
      try {
        await dropWorktreeShadow(o.home, folderKey)
        dropped = true
      } catch (err) {
        notes.push(`Dim Factory could not remove the copy's snapshots: ${errorMessage(err)}.`)
      }
    }
    return { removed: gone, branchDeleted: true, shadowDropped: dropped, notes, commands }
  }
  // The worktree's own answer while it exists; else the user's folder's (a worktree folder deleted by hand).
  const commonDir =
    wt.commonDir ??
    (present ? await commonDirOf(wtPath) : undefined) ??
    (wt.folder !== undefined ? (await detectRepo(wt.folder).catch(() => null))?.commonDir : undefined)
  const hooksDir = paths.emptyHooksDir
  await mkdir(hooksDir, { recursive: true })
  let removed = !present
  let branchDeleted = false
  const work = async (): Promise<void> => {
    const folderOk =
      wt.folder !== undefined &&
      (await stat(wt.folder).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    // git runs in the user's folder; when that is gone, against the common dir alone.
    const git = (args: string[], timeoutMs = 120_000) =>
      tryGit([...hooksArgs(hooksDir), ...args], {
        cwd: folderOk ? (wt.folder as string) : (commonDir as string),
        ...(folderOk ? {} : { env: { GIT_DIR: commonDir as string } }),
        timeoutMs,
        category: 'worktree_failed',
      })
    if (present) {
      await unlinkLinksInside(wtPath)
      const r = commonDir !== undefined ? await git(['worktree', 'remove', '--force', wtPath]) : undefined
      if (r === undefined || !r.ok || (await exists(wtPath))) {
        try {
          await removeTree(wtPath)
        } catch (err) {
          notes.push(
            `Dim Factory could not remove the worktree folder ${wtPath}: ${errorMessage(err)}. Close any program using it, then discard again.`,
          )
        }
      }
      removed = !(await exists(wtPath))
    }
    if (commonDir === undefined) return
    const cwd = folderOk ? (wt.folder as string) : commonDir
    const env = folderOk ? undefined : { GIT_DIR: commonDir }
    const tip = await refCommit(cwd, ref, env).catch(() => undefined)
    if (tip === null) branchDeleted = true
    else if (tip === undefined)
      notes.push(`Dim Factory could not read the branch ${wt.branch}, so it was kept.`)
    else if (tip !== wt.base) {
      notes.push(`The branch ${wt.branch} has commits the run made, so Dim Factory keeps it.`)
      commands.push(...commandsOf(repairCommand('deleteBranch', os, wt.branch)))
    } else if (await checkedOutElsewhere(commonDir, ref, wtPath)) {
      notes.push(`The branch ${wt.branch} is checked out in another worktree, so Dim Factory keeps it.`)
    } else {
      let d = await git(['update-ref', '-d', ref, wt.base], 30_000)
      for (let i = 0; i < 2 && !d.ok && isLockContention(d.error.stderr); i++) {
        await delay(500)
        d = await git(['update-ref', '-d', ref, wt.base], 30_000)
      }
      if (d.ok) branchDeleted = true
      else {
        notes.push(`git could not delete the branch ${wt.branch} right now, so it was kept.`)
        commands.push(...commandsOf(repairCommand('deleteBranch', os, wt.branch)))
      }
    }
    if (removed) {
      const p = await git(['worktree', 'prune'], 60_000)
      if (!p.ok) commands.push(...commandsOf(repairCommand('worktreePrune', os)))
    }
  }
  if (commonDir !== undefined) await withCommonDirLock(commonDir, work, { attempts: 1 })
  else await work()
  let shadowDropped = false
  if (removed && folderKey !== undefined) {
    try {
      await dropWorktreeShadow(o.home, folderKey)
      shadowDropped = true
    } catch (err) {
      notes.push(`Dim Factory could not remove the worktree's snapshots: ${errorMessage(err)}.`)
    }
  }
  return { removed, branchDeleted, shadowDropped, notes, commands }
}

// ---- uncommitted changes (the composer's "N uncommitted changes not included") -----------------------------------

/**
 * Paths of the user's uncommitted work an Isolated run leaves out (it starts from HEAD): staged changes (index
 * entries that differ from HEAD's tree), modified or deleted tracked files (`ls-files -m -d`, which compares content
 * when only the stat changed) and untracked files that are not ignored. Reads only (`--no-optional-locks`), so the
 * user's index is never refreshed or written. Empty for a folder that is not a repository or has no commit.
 */
export async function uncommittedPaths(folder: string): Promise<string[]> {
  const repo = await detectRepo(folder).catch(() => null)
  if (repo === null || !repo.isRepo || repo.toplevel === undefined || repo.dubiousOwnership) return []
  const cwd = repo.toplevel
  const head = (await readHead(cwd).catch(() => null))?.commit ?? null
  const big = { maxBytes: BIG_OUTPUT }
  const [staged, tree, worktree, untracked] = await Promise.all([
    runGit(['ls-files', '-z', '-s'], readOpts(cwd, big)),
    head !== null
      ? runGit(['ls-tree', '-r', '-z', '--full-tree', head], readOpts(cwd, big))
      : Promise.resolve({ stdout: '' }),
    runGit(['ls-files', '-z', '-m', '-d'], readOpts(cwd, big)),
    runGit(['ls-files', '-z', '-o', '--exclude-standard'], readOpts(cwd, big)),
  ])
  const inHead = new Map<string, string>()
  for (const rec of splitNul(tree.stdout)) {
    const m = /^(\d{6}) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(rec)
    if (m !== null) inHead.set(m[3] ?? '', `${m[1] ?? ''} ${m[2] ?? ''}`)
  }
  const out = new Set<string>()
  const indexed = new Set<string>()
  for (const rec of splitNul(staged.stdout)) {
    const m = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(rec)
    if (m === null) continue
    const p = m[4] ?? ''
    indexed.add(p)
    if (m[3] !== '0' || inHead.get(p) !== `${m[1] ?? ''} ${m[2] ?? ''}`) out.add(p)
  }
  for (const p of inHead.keys()) if (!indexed.has(p)) out.add(p)
  for (const p of splitNul(worktree.stdout)) out.add(p)
  for (const p of splitNul(untracked.stdout)) out.add(p)
  return [...out].sort()
}

/** How many uncommitted changes an Isolated run started now would leave out (see uncommittedPaths). */
export async function uncommittedCount(folder: string): Promise<number> {
  return (await uncommittedPaths(folder)).length
}
