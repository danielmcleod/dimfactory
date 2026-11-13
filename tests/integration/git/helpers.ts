// Real-git helpers for the shadow suites. DIM_FACTORY_TEST_GIT selects an alternate git (CI: a 2.17.1 build or
// MinGit 2.17.1); otherwise `git` from PATH. The user-side setup (init, commit, config) runs git directly here;
// everything under test goes through src/core/git.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { configureGit, gitVersion } from '../../../src/core/git/exec.ts'
import type { GitVersion } from '../../../src/core/git/exec.ts'

export const TEST_GIT = process.env['DIM_FACTORY_TEST_GIT']?.trim() || 'git'
configureGit({ executable: TEST_GIT })

export const isWin = process.platform === 'win32'

/** `git --version` of the git under test (also printed once so CI logs show which git ran). */
export async function testGitVersion(): Promise<GitVersion> {
  const v = await gitVersion()
  return v
}

/** Child env for user-side git: inherited GIT_* removed, fixed identity, no prompts. */
export function userEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...extra,
  }
}

export interface RunOpts {
  env?: Record<string, string>
  input?: string | Buffer
  allowFail?: boolean
}

/** Run the git under test; returns stdout as a Buffer. Throws on a non-zero exit unless allowFail. */
export function gitBuf(cwd: string, args: string[], opts: RunOpts = {}): Buffer {
  const r = spawnSync(TEST_GIT, args, {
    cwd,
    env: userEnv(opts.env),
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  })
  if (r.error !== undefined) throw r.error
  if (r.status !== 0 && opts.allowFail !== true) {
    throw new Error(`git ${args.join(' ')} → ${r.status}: ${r.stderr.toString('utf8')}`)
  }
  return r.stdout
}

export function git(cwd: string, args: string[], opts: RunOpts = {}): string {
  return gitBuf(cwd, args, opts).toString('utf8')
}

/** Shadow-side reads for assertions (GIT_DIR = the shadow). */
export function shadowBuf(gitDir: string, args: string[]): Buffer {
  return gitBuf(tmpdir(), args, { env: { GIT_DIR: gitDir } })
}

export function shadowGit(gitDir: string, args: string[]): string {
  return shadowBuf(gitDir, args).toString('utf8')
}

/** Blob bytes of `<commit>:<path>` in the shadow. */
export function shadowBlob(gitDir: string, commit: string, path: string): Buffer {
  return shadowBuf(gitDir, ['cat-file', 'blob', `${commit}:${path}`])
}

export function shadowTreePaths(gitDir: string, commit: string): string[] {
  return shadowGit(gitDir, ['ls-tree', '-r', '-z', '--name-only', commit])
    .split('\0')
    .filter((p) => p !== '')
    .sort()
}

const made: string[] = []

export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `dim-factory-${prefix}-`))
  made.push(d)
  return d
}

export function cleanupTemps(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export function write(root: string, rel: string, data: string | Buffer): string {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, data)
  return p
}

/** A fresh repo with one commit (`README.md`). */
export function initRepo(dir: string, opts: { autocrlf?: boolean } = {}): void {
  git(dir, ['init', '-q'])
  git(dir, ['config', 'core.autocrlf', opts.autocrlf === true ? 'true' : 'false'])
  write(dir, 'README.md', '# test\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

/** Every file under `dir` (relative, sorted), skipping nothing. */
export function listTree(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(dir, p))
    }
  }
  walk(dir)
  return out.sort()
}

export function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

export function mtimeMs(p: string): number {
  return statSync(p).mtimeMs
}
