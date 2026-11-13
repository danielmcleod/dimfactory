// Folder guard (`folder.guard`): scope roots Dim Factory refuses to snapshot or run in.
// The Codex #19588 lesson: `git add -A` over a home folder filled 200 GB. Refused: the home folder (and any folder
// containing it), a drive or volume root, `/`, `/usr`, `/System`, `/Applications`, `~/Library`, `%WINDIR%`,
// `Program Files*`, and anything inside DIM_FACTORY_HOME. Also refused: anything inside a `.git`
// folder. Owners `worktree`, `heal`, `catalog` and `probe` are exempt (their working folders live inside
// DIM_FACTORY_HOME by design).
import { homedir } from 'node:os'
import path from 'node:path'
import type { CheckResult } from '../../shared/preflight.ts'
import { BRAND, HOME_ENV } from '../../shared/brand.ts'
import { realPath } from '../real-path.ts'

export const GUARD_OWNERS = ['run', 'worktree', 'heal', 'catalog', 'probe'] as const
export type GuardOwner = (typeof GUARD_OWNERS)[number]
/** Owners that skip the guard (and every other `folder.*` check except for worktrees' own). */
export const GUARD_EXEMPT_OWNERS: readonly GuardOwner[] = ['worktree', 'heal', 'catalog', 'probe']

export type GuardReason = 'home' | 'root' | 'system' | 'dimFactoryHome' | 'gitDir'

export interface GuardResult {
  guarded: boolean
  reason?: GuardReason
  /** One sentence for the preflight chip. */
  detail: string
  /** The path that was checked (realpath when it exists). */
  path: string
}

export interface GuardContext {
  platform: NodeJS.Platform
  /** The OS user's home folder. */
  home: string
  dimFactoryHome: string
  /** Fold case when comparing (win32/darwin defaults). */
  caseInsensitive?: boolean
  /** win32: WINDIR / SystemRoot / ProgramFiles / ProgramFiles(x86) / ProgramW6432. */
  env?: Readonly<Record<string, string | undefined>>
}

/**
 * Path handling: an administrative share (`\\<host>\C$\Users\me`, also as `\\?\UNC\…` or with
 * `/`) is the drive path it names (`C:\Users\me`), so the guard judges that path. realpath keeps the share form, and a
 * drive mapped to such a share resolves to it, so without this the home folder, a drive root and the system folders
 * could be reached past every rule below. This holds whatever the host: this machine answers to more names than a
 * list can hold (each LAN address, all of 127.0.0.0/8, its FQDN, a name with a trailing dot), and another machine's
 * drive root or system folder is no project folder either. Anything else is returned as it is.
 */
export function adminShareDrivePath(p: string): string {
  const m = /^[\\/]{2}(?:[?.][\\/]UNC[\\/])?[^\\/]+[\\/]([A-Za-z])\$(?:[\\/](.*))?$/i.exec(p)
  if (m === null) return p
  return `${(m[1] ?? '').toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

function envGet(env: GuardContext['env'], key: string): string | undefined {
  if (env === undefined) return undefined
  const upper = key.toUpperCase()
  for (const [k, v] of Object.entries(env))
    if (k.toUpperCase() === upper && v !== undefined && v !== '') return v
  return undefined
}

/** Pure guard decision for an absolute, already-resolved path. */
export function checkGuard(target: string, ctx: GuardContext): GuardResult {
  const P = pathFor(ctx.platform)
  const fold = ctx.caseInsensitive ?? (ctx.platform === 'win32' || ctx.platform === 'darwin')
  const norm = (p: string): string => {
    let out = P.resolve(p)
    const root = P.parse(out).root
    while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1)
    return fold ? out.toLowerCase() : out
  }
  const t = norm(ctx.platform === 'win32' ? adminShareDrivePath(target) : target)
  const same = (other: string): boolean => t === norm(other)
  const inside = (parent: string): boolean => {
    const p = norm(parent)
    if (t === p) return true
    return t.startsWith(p.endsWith(P.sep) ? p : p + P.sep)
  }
  const refuse = (reason: GuardReason, detail: string): GuardResult => ({
    guarded: true,
    reason,
    detail,
    path: target,
  })

  if (inside(ctx.dimFactoryHome)) {
    return refuse(
      'dimFactoryHome',
      `${target} is inside Dim Factory's own data folder (${ctx.dimFactoryHome}).`,
    )
  }
  if (t.split(/[\\/]/).includes('.git')) {
    return refuse('gitDir', `${target} is inside a .git folder. Choose the project folder itself.`)
  }
  if (P.parse(t).root === t || t === '/' || (ctx.platform === 'win32' && /^\\\\[^\\]+\\[^\\]+$/.test(t))) {
    return refuse('root', `${target} is a drive or volume root. Choose a project folder instead.`)
  }
  if (same(ctx.home)) {
    return refuse('home', `${target} is your home folder. Choose a project folder inside it.`)
  }
  if (norm(ctx.home).startsWith(t.endsWith(P.sep) ? t : t + P.sep)) {
    return refuse('home', `${target} contains your home folder. Choose a project folder instead.`)
  }

  const system: string[] = []
  if (ctx.platform === 'win32') {
    system.push(envGet(ctx.env, 'WINDIR') ?? envGet(ctx.env, 'SystemRoot') ?? 'C:\\Windows')
    for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
      const v = envGet(ctx.env, k)
      if (v !== undefined) system.push(v)
    }
    // `Program Files*` directly under any drive root
    const parts = t.split(P.sep)
    if (parts.length >= 2 && /^program files/i.test(parts[1] ?? '')) {
      return refuse('system', `${target} is a system folder (Program Files).`)
    }
  } else {
    system.push('/usr', '/System', '/Applications', P.join(ctx.home, 'Library'))
    // volume roots: /Volumes/<name> (macOS), /mnt/<x>, /media/<user>/<x>, /run/media/<user>/<x>
    const vol =
      /^\/volumes\/[^/]+$/i.test(t) ||
      /^\/mnt\/[^/]+$/.test(t) ||
      /^\/media\/[^/]+\/[^/]+$/.test(t) ||
      /^\/run\/media\/[^/]+\/[^/]+$/.test(t)
    if (vol) return refuse('root', `${target} is a drive or volume root. Choose a project folder instead.`)
  }
  for (const dir of system) {
    if (inside(dir)) return refuse('system', `${target} is a system folder (${dir}).`)
  }
  return { guarded: false, detail: 'ok', path: target }
}

/**
 * The path's real name; for a path that does not exist yet (a project folder about to be made), its nearest existing
 * parent's real name with the rest joined on, so it compares with the real names of the folders it is checked against.
 */
function realOrResolved(p: string): Promise<string> {
  return realPath(p)
}

export interface GuardOptions {
  owner?: GuardOwner
  /** DIM_FACTORY_HOME (default: env DIM_FACTORY_HOME, else ~/.dimfactory). */
  dimFactoryHome?: string
  /** The OS user's home (default os.homedir()). */
  home?: string
  caseInsensitive?: boolean
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
}

/** `isGuarded(path, {owner})` — realpaths the inputs, then applies checkGuard (exempt owners always pass). */
export async function isGuarded(target: string, opts: GuardOptions = {}): Promise<GuardResult> {
  const owner = opts.owner ?? 'run'
  const real = await realOrResolved(target)
  if (GUARD_EXEMPT_OWNERS.includes(owner))
    return { guarded: false, detail: `exempt owner ${owner}`, path: real }
  const env = opts.env ?? process.env
  const userHome = opts.home ?? homedir()
  const envHome = env[HOME_ENV]?.trim()
  const dimFactoryHome =
    opts.dimFactoryHome ??
    (envHome !== undefined && envHome !== '' ? envHome : path.join(userHome, BRAND.homeDirName))
  const ctx: GuardContext = {
    platform: opts.platform ?? process.platform,
    home: await realOrResolved(userHome),
    dimFactoryHome: await realOrResolved(dimFactoryHome),
    env,
  }
  if (opts.caseInsensitive !== undefined) ctx.caseInsensitive = opts.caseInsensitive
  return checkGuard(real, ctx)
}

const SCOPE_WHY: Record<GuardReason, string> = {
  home: 'your home folder (or a folder containing it)',
  root: 'a drive or volume root',
  system: 'a system folder',
  dimFactoryHome: 'inside Dim Factory’s own data folder',
  gitDir: 'inside a .git folder',
}

/**
 * The guard detail when the chosen folder passes but its scope root (the git top level that snapshots, the size
 * check and the folder lock cover) is refused: e.g. a project folder inside a dotfiles repository at `~`.
 */
export function scopeRootGuardDetail(folder: string, scopeRoot: string, r: GuardResult): string {
  return (
    `${folder} is inside the git repository at ${scopeRoot}, which is ${SCOPE_WHY[r.reason ?? 'system']}. ` +
    'Dim Factory snapshots and locks the whole repository, so it will not run here. Give the project its own ' +
    'repository (git init in the project folder), or choose a folder outside that repository.'
  )
}

/** Same path, compared the way the guard compares (case folded on win32/darwin, no trailing separator). */
export function sameGuardPath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const P = pathFor(platform)
  const fold = platform === 'win32' || platform === 'darwin'
  const norm = (p: string): string => {
    let out = P.resolve(p)
    const root = P.parse(out).root
    while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1)
    return fold ? out.toLowerCase() : out
  }
  return norm(a) === norm(b)
}

/** The `folder.guard` CheckResult (blocking `folder_guard` when refused; "choose another folder" is the fix). */
export function guardCheckResult(result: GuardResult, at: number = Date.now()): CheckResult {
  return {
    id: 'folder.guard',
    scope: 'folder',
    status: result.guarded ? 'fail' : 'pass',
    blocking: result.guarded,
    ...(result.guarded ? { category: 'folder_guard' as const } : {}),
    title: result.guarded ? 'Dim Factory will not run in this folder' : 'Folder allowed',
    detail: result.detail,
    recovery: [],
    at,
    ttlMs: 0,
  }
}
