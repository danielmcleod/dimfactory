// The preflight check run.isolation.worktree wired to the real git/worktree.ts checkEligibility (worktree
// eligibility): the contract between the two (its WorktreeEligibility is what the check
// reads), a repository with a commit passes, a folder that is not one and a drive without room for the worktree block
// with the reasons (DIM_FACTORY_TEST_GIT selects 2.17.1 in CI).
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { checkEligibility } from '@core/git/worktree.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import type { PreflightDeps } from '@core/preflight/engine.ts'
import { healthyChecks, healthyDeps, probeResult } from '../../../unit/preflight/helpers.ts'
import { cleanupTemps, initRepo, tempDir, write } from '../../git/helpers.ts'

afterEach(() => cleanupTemps())

const GB = 1024 ** 3

async function preflight(folder: string, freeBytes: number): Promise<CheckResult | undefined> {
  const home = tempDir('elig-home')
  const eligibility: NonNullable<PreflightDeps['worktreeEligibility']> = (f) =>
    checkEligibility(f, { home, freeBytes: () => Promise.resolve(freeBytes) })
  const engine = createPreflightEngine(
    healthyDeps({ home, platform: process.platform, worktreeEligibility: eligibility }),
  )
  engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
  const r: PreflightReport = await engine.run('authoritative', {
    folder,
    config: resolveBuiltinConfig({ profile: 'claude-only', overrides: { isolation: { mode: 'worktree' } } }),
  })
  return [...r.blocking, ...r.warnings, ...r.info].find((x) => x.id === 'run.isolation.worktree')
}

describe('run.isolation.worktree with checkEligibility', () => {
  it('a repository with a commit and room: passes', async () => {
    const repo = tempDir('elig-repo')
    initRepo(repo)
    expect(await preflight(repo, 100 * GB)).toMatchObject({ status: 'pass' })
  })

  it('not a repository: blocks (worktree_failed) with its reason', async () => {
    const plain = tempDir('elig-plain')
    write(plain, 'a.txt', 'a\n')
    const res = await preflight(plain, 100 * GB)
    expect(res).toMatchObject({ status: 'fail', blocking: true, category: 'worktree_failed' })
    expect(res?.detail).toMatch(/^Not a git repository\./)
    expect(res?.recovery.at(-1)).toMatchObject({ kind: 'settings_link', pointer: '/isolation/mode' })
  })

  it('no room for the worktree: blocks with the disk reason', async () => {
    const repo = tempDir('elig-disk')
    initRepo(repo)
    write(join(repo, 'src'), 'big.txt', 'x'.repeat(1000))
    const res = await preflight(repo, 10)
    expect(res).toMatchObject({ status: 'fail', category: 'worktree_failed' })
    expect(res?.detail).toMatch(/free disk space/i)
  })
})
