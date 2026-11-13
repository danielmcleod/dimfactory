// Every git invocation Dim Factory makes. Spawns go through
// src/core/proc (execCapture: no shell, hidden window, process group on POSIX); the env is sanitizeEnv(purpose
// 'git') — every inherited GIT_* removed, GIT_TERMINAL_PROMPT=0, LC_ALL=C — plus the caller's own GIT_* additions
// (GIT_DIR/GIT_WORK_TREE for the shadow). Only commands available in git 2.17 are used.
import { stat } from 'node:fs/promises'
import type { FailureCategory } from '../../shared/failure.ts'
import type { ResultCode } from '../../shared/ipc.ts'
import { sanitizeEnv } from '../proc/env.ts'
import type { EnvInput } from '../proc/env.ts'
import { execCapture } from '../proc/spawn.ts'

/** Oldest git Dim Factory supports (the `app.git` check: below → block). */
export const GIT_MIN_VERSION = { major: 2, minor: 17, patch: 0 } as const
/** Below this, `app.git` warns (CVE-2022-24765 safe.directory fix). */
export const GIT_RECOMMENDED_VERSION = { major: 2, minor: 35, patch: 2 } as const

/** Default timeout for one git call; snapshots pass their own (a cold `add -A` can take minutes). */
export const GIT_DEFAULT_TIMEOUT_MS = 60_000
/** Per-stream capture cap; callers that list whole trees raise it. */
export const GIT_DEFAULT_MAX_BYTES = 32 * 1024 * 1024
/** Budget for the paths of one argv batch (the win32 command line caps at 32,000 chars). */
export const GIT_ARGV_BATCH_CHARS = 24_000

export interface GitSettings {
  /** The git binary: an absolute path, or a bare name looked up on the child's PATH. */
  executable: string
  /** Resolved PATH (proc/path-env) passed to every git child. */
  path?: string
  /** Base environment before sanitizing (default `process.env`). */
  baseEnv?: EnvInput
}

let settings: GitSettings = { executable: 'git' }
const versionCache = new Map<string, Promise<GitVersion>>()

/** Set the git binary / PATH / base env used by every later call (app boot, probe, tests via DIM_FACTORY_TEST_GIT). */
export function configureGit(next: {
  executable?: string
  path?: string | undefined
  baseEnv?: EnvInput | undefined
}): void {
  const merged: GitSettings = { executable: next.executable ?? settings.executable }
  const path = 'path' in next ? next.path : settings.path
  const baseEnv = 'baseEnv' in next ? next.baseEnv : settings.baseEnv
  if (path !== undefined) merged.path = path
  if (baseEnv !== undefined) merged.baseEnv = baseEnv
  settings = merged
}

export function gitSettings(): Readonly<GitSettings> {
  return settings
}

export interface GitRunOptions {
  cwd: string
  /** Added on top of the sanitized env (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, identity, …). */
  env?: Readonly<Record<string, string>>
  /** Written to stdin (path lists go here with -z, never in argv when they can be long). */
  stdin?: string
  timeoutMs?: number
  /** Per-stream capture cap (default 32 MB). */
  maxBytes?: number
  /** Exit codes treated as success (default `[0]`). */
  okCodes?: readonly number[]
  /** Reads of the user's repo: `git --no-optional-locks …` (never touches their index.lock). */
  noOptionalLocks?: boolean
  /** GIT_LITERAL_PATHSPECS=1 (pathspecs are plain paths: no globbing, no magic). */
  literalPathspecs?: boolean
  /** Category for a failure classifyGitFailure cannot place (default `unknown`). */
  category?: FailureCategory
  /** Keep stdout as bytes (`GitResult.stdoutBytes`, `stdout` ''): a blob for the Diff tab's image preview. */
  binary?: boolean
}

export interface GitResult {
  args: readonly string[]
  code: number
  stdout: string
  stderr: string
  ms: number
  /** stdout reached `maxBytes` and was cut. */
  truncated: boolean
  /** Stdout's bytes when the call asked for `binary`. */
  stdoutBytes?: Buffer
}

export type GitErrorKind = 'missing' | 'cwd' | 'spawn' | 'timeout' | 'exit'

export class GitError extends Error {
  readonly kind: GitErrorKind
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly stderr: string
  readonly category: FailureCategory
  /** The Result code a handler should report (`GIT`, or `TIMEOUT`). */
  readonly resultCode: ResultCode

  constructor(
    kind: GitErrorKind,
    message: string,
    extra: { args: readonly string[]; exitCode?: number | null; stderr?: string; category: FailureCategory },
  ) {
    super(message)
    this.name = 'GitError'
    this.kind = kind
    this.args = extra.args
    this.exitCode = extra.exitCode ?? null
    this.stderr = extra.stderr ?? ''
    this.category = extra.category
    this.resultCode = kind === 'timeout' ? 'TIMEOUT' : 'GIT'
  }
}

export function isGitError(err: unknown): err is GitError {
  return err instanceof GitError
}

/** git refused a repository owned by another user (CVE-2022-24765, git ≥ 2.35.2 and backports). */
export function isDubiousOwnership(stderr: string): boolean {
  return /dubious ownership/i.test(stderr)
}

/** Another git process holds a `*.lock` (index.lock, HEAD.lock, a ref lock). */
export function isLockContention(stderr: string): boolean {
  return /\.lock'?:? File exists|Unable to create '[^']*\.lock'|cannot lock ref/i.test(stderr)
}

/**
 * Failure category for a git error text. Precedence: disk full → dubious ownership (git_state) →
 * a held `*.lock` (git_state in the user's repo; a shadow lock stays `snapshot_failed`, which retries) → the
 * caller's fallback (`snapshot_failed` for shadow work, `git_state` for user-repo reads).
 */
export function classifyGitFailure(stderr: string, fallback: FailureCategory = 'unknown'): FailureCategory {
  if (/No space left on device|not enough space|ENOSPC|Disk quota exceeded/i.test(stderr)) return 'disk_full'
  if (isDubiousOwnership(stderr)) return 'git_state'
  if (isLockContention(stderr)) return fallback === 'snapshot_failed' ? 'snapshot_failed' : 'git_state'
  return fallback
}

function buildEnv(opts: GitRunOptions): Record<string, string> {
  const extra: Record<string, string> = { ...opts.env }
  if (opts.literalPathspecs === true) extra['GIT_LITERAL_PATHSPECS'] = '1'
  return sanitizeEnv(settings.baseEnv ?? process.env, {
    purpose: 'git',
    ...(settings.path !== undefined ? { path: settings.path } : {}),
    extra,
  })
}

const firstLines = (text: string, n = 4): string =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, n)
    .join(' | ')

async function dirExists(dir: string): Promise<boolean> {
  return stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  )
}

/** Run git; resolves with the result or a GitError (never throws). */
export async function tryGit(
  args: readonly string[],
  opts: GitRunOptions,
): Promise<{ ok: true; result: GitResult } | { ok: false; error: GitError; result?: GitResult }> {
  const argv = [...(opts.noOptionalLocks === true ? ['--no-optional-locks'] : []), ...args]
  const maxBytes = opts.maxBytes ?? GIT_DEFAULT_MAX_BYTES
  const fallback = opts.category ?? 'unknown'
  const cap = await execCapture(settings.executable, argv, {
    cwd: opts.cwd,
    env: buildEnv(opts),
    timeoutMs: opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
    maxBytes,
    // A timed-out git dies with its whole tree (Git for Windows' cmd/git.exe runs mingw64's git.exe): no orphan
    // keeps writing a lock file after the timeout.
    killTree: true,
    ...(opts.stdin !== undefined ? { input: opts.stdin } : {}),
    ...(opts.binary === true ? { binary: true } : {}),
  })
  const label = `git ${args.slice(0, 3).join(' ')}`
  if (cap.error !== undefined) {
    const code = cap.error.code
    if (code === 'ENOENT' && !(await dirExists(opts.cwd))) {
      return {
        ok: false,
        error: new GitError('cwd', `The folder ${opts.cwd} does not exist`, {
          args: argv,
          category: 'folder_guard',
        }),
      }
    }
    const missing = code === 'ENOENT' || code === 'EACCES' || code === 'EINVAL'
    return {
      ok: false,
      error: new GitError(
        missing ? 'missing' : 'spawn',
        missing
          ? `git was not found (${settings.executable}): ${cap.error.message}`
          : `${label} could not start: ${cap.error.message}`,
        { args: argv, category: missing ? 'git_missing' : fallback },
      ),
    }
  }
  const result: GitResult = {
    args: argv,
    code: cap.code ?? -1,
    stdout: cap.stdout,
    stderr: cap.stderr,
    ms: cap.ms,
    truncated:
      cap.stdoutBytes !== undefined
        ? cap.stdoutBytes.length >= maxBytes
        : Buffer.byteLength(cap.stdout, 'utf8') >= maxBytes,
  }
  if (cap.stdoutBytes !== undefined) result.stdoutBytes = cap.stdoutBytes
  if (cap.timedOut) {
    return {
      ok: false,
      result,
      error: new GitError('timeout', `${label} timed out after ${cap.ms} ms`, {
        args: argv,
        stderr: cap.stderr,
        category: fallback,
      }),
    }
  }
  const okCodes = opts.okCodes ?? [0]
  if (cap.code === null || !okCodes.includes(cap.code)) {
    const why = cap.code === null ? `signal ${cap.signal ?? '?'}` : `exit ${cap.code}`
    const detail = firstLines(cap.stderr)
    return {
      ok: false,
      result,
      error: new GitError('exit', `${label} failed (${why})${detail === '' ? '' : `: ${detail}`}`, {
        args: argv,
        exitCode: cap.code,
        stderr: cap.stderr,
        category: classifyGitFailure(cap.stderr, fallback),
      }),
    }
  }
  return { ok: true, result }
}

/** Run git; throws GitError on a spawn failure, a timeout or an exit code outside `okCodes`. */
export async function runGit(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
  const r = await tryGit(args, opts)
  if (!r.ok) throw r.error
  return r.result
}

/** NUL-separated output (`-z`) → records; the trailing empty record is dropped. */
export function splitNul(out: string): string[] {
  if (out === '') return []
  const parts = out.split('\0')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Split a path list into argv batches whose joined length stays under `maxChars`. */
export function chunkPaths(paths: readonly string[], maxChars: number = GIT_ARGV_BATCH_CHARS): string[][] {
  const batches: string[][] = []
  let cur: string[] = []
  let len = 0
  for (const p of paths) {
    const cost = p.length + 3
    if (cur.length > 0 && len + cost > maxChars) {
      batches.push(cur)
      cur = []
      len = 0
    }
    cur.push(p)
    len += cost
  }
  if (cur.length > 0) batches.push(cur)
  return batches
}

export interface GitVersion {
  major: number
  minor: number
  patch: number
  /** The full `git --version` line, e.g. `git version 2.17.1.windows.2`. */
  raw: string
}

export function parseGitVersion(text: string): GitVersion | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] ?? '0'),
    raw: text.trim().split(/\r?\n/)[0] ?? text.trim(),
  }
}

export function compareGitVersion(
  a: Pick<GitVersion, 'major' | 'minor' | 'patch'>,
  b: Pick<GitVersion, 'major' | 'minor' | 'patch'>,
): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** `git --version` of the configured binary (cached per executable). Throws GitError when git is missing. */
export function gitVersion(cwd: string = process.cwd()): Promise<GitVersion> {
  const key = settings.executable
  let p = versionCache.get(key)
  if (p === undefined) {
    p = runGit(['--version'], { cwd, timeoutMs: 10_000, category: 'git_missing' }).then((r) => {
      const v = parseGitVersion(r.stdout)
      if (v === null) {
        throw new GitError('exit', `unrecognized git --version output: ${firstLines(r.stdout)}`, {
          args: ['--version'],
          category: 'git_missing',
        })
      }
      return v
    })
    void p.catch(() => versionCache.delete(key))
    versionCache.set(key, p)
  }
  return p
}
