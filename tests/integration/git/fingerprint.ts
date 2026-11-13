// Helpers for the git suites (branch prep, reconciliation, revert to S0): a full fingerprint
// of a user repo's .git (every file hashed) and of its work tree, so a test can prove what Dim Factory did not touch.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { readHead } from '../../../src/core/git/branch.ts'
import type { HeadState } from '../../../src/core/git/branch.ts'
import type { RepoInfo } from '../../../src/core/git/repo.ts'
import { openShadow } from '../../../src/core/git/shadow.ts'
import type { Shadow, SnapshotRecord } from '../../../src/core/git/shadow.ts'
import { git, initRepo, listTree, tempDir, write } from './helpers.ts'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** sha256 of every file under `<repo>/.git` (paths `/`-separated) except those `skip` names, plus the index mtime. */
export function dotGitFingerprint(
  repo: string,
  skip: (rel: string) => boolean = () => false,
): Record<string, string> {
  const dotGit = join(repo, '.git')
  const out: Record<string, string> = {}
  for (const rel of listTree(dotGit)) {
    const posix = rel.split(sep).join('/')
    if (skip(posix)) continue
    out[posix] = sha(readFileSync(join(dotGit, rel)))
  }
  out['(index mtime)'] = String(statSync(join(dotGit, 'index')).mtimeMs)
  return out
}

/** The files the run-branch functions own: HEAD, its reflog, and the run branch refs under `prefix`. */
export function ownedByRunBranch(prefix = 'dim/'): (rel: string) => boolean {
  return (rel) =>
    rel === 'HEAD' ||
    rel === 'logs/HEAD' ||
    rel.startsWith(`refs/heads/${prefix}`) ||
    rel.startsWith(`logs/refs/heads/${prefix}`)
}

/** sha256 of every work-tree file outside `.git` (paths `/`-separated). */
export function workTreeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of listTree(dir)) {
    const posix = rel.split(sep).join('/')
    if (posix === '.git' || posix.startsWith('.git/')) continue
    out[posix] = sha(readFileSync(join(dir, rel)))
  }
  return out
}

/** Wait until `cond` holds (polling every 25 ms), or throw after `ms`. */
export async function waitFor(cond: () => boolean, ms = 30_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

export const RECONCILE_RUN = '20261008T120000Z-rcnl'

/** A repo with five committed files, its shadow, S0, the run's edit of a.txt, then S1 (the run's last snapshot). */
export async function reconcileScenario(prefix: string): Promise<{
  dir: string
  repo: RepoInfo
  shadow: Shadow
  expected: HeadState
  mainName: string
  s0: SnapshotRecord
  s1: SnapshotRecord
}> {
  const dir = tempDir(prefix)
  initRepo(dir)
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) write(dir, f, `${f} v1\n`)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'files'])
  const shadow = await openShadow(dir, { home: tempDir(`${prefix}-home`) })
  const repo = shadow.scope.repo
  const expected = await readHead(dir)
  const s0 = await shadow.snapshot(RECONCILE_RUN, 'S0')
  write(dir, 'a.txt', 'a.txt changed by the run\n')
  const s1 = await shadow.snapshot(RECONCILE_RUN, 'S1')
  const mainName = (expected.ref ?? '').replace('refs/heads/', '')
  return { dir, repo, shadow, expected, mainName, s0, s1 }
}
