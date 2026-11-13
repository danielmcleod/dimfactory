// Git preflight: `run.branch` (check-ref-format, only with isolation.branch runBranch) and
// `folder.git` (a run branch needs a repository; its problems block only for runBranch/worktree, else warn).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { planImplementOverrides, resolveBuiltinConfig } from '@core/config/builtins.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import type { FolderGitFacts, PreflightDeps, PreflightInput } from '@core/preflight/engine.ts'
import { isValidBranchName } from '@core/git/branch.ts'
import { healthyChecks, healthyDeps, probeResult } from '../preflight/helpers.ts'

let root: string
let folder: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-preflight-'))
  folder = join(root, 'project')
  mkdirSync(folder, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
const byId = (r: PreflightReport, id: string): CheckResult | undefined => all(r).find((x) => x.id === id)

const config = (overrides: object = {}): ResolvedConfig =>
  resolveBuiltinConfig({ profile: 'claude-only', overrides: { ...planImplementOverrides(), ...overrides } })

async function preflight(
  mode: 'live' | 'authoritative',
  input: PreflightInput,
  over: Partial<PreflightDeps> = {},
): Promise<PreflightReport> {
  const engine = createPreflightEngine(healthyDeps({ home: join(root, 'home'), ...over }))
  engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
  return engine.run(mode, input)
}

describe('run.branch', () => {
  it('does not apply without a run branch', async () => {
    const branchNameValid = vi.fn(() => Promise.resolve(true))
    const r = await preflight('authoritative', { folder, config: config() }, { branchNameValid })
    expect(byId(r, 'run.branch')).toBeUndefined()
    expect(branchNameValid).not.toHaveBeenCalled()
  })

  it('a valid prefix passes and names the branch shape', async () => {
    const branchNameValid = vi.fn(() => Promise.resolve(true))
    const r = await preflight(
      'live',
      { folder, config: config({ isolation: { branch: 'runBranch' } }) },
      { branchNameValid, gitFacts: () => Promise.resolve({ isRepo: true, branch: 'main' }) },
    )
    expect(byId(r, 'run.branch')).toMatchObject({ status: 'pass', scope: 'run' })
    expect(byId(r, 'run.branch')?.detail).toMatch(
      /^The run works on a new branch named like dim\/\d{8}-<task>\.$/,
    )
    expect(branchNameValid).toHaveBeenCalledWith(folder, expect.stringMatching(/^dim\/\d{8}-task$/))
  })

  it('an invalid prefix blocks with a settings link (config_invalid)', async () => {
    const r = await preflight(
      'authoritative',
      { folder, config: config({ isolation: { branch: 'runBranch', branchPrefix: 'bad..prefix/' } }) },
      {
        branchNameValid: () => Promise.resolve(false),
        gitFacts: () => Promise.resolve({ isRepo: true, branch: 'main' }),
      },
    )
    expect(r.ok).toBe(false)
    const c = byId(r, 'run.branch')
    expect(c).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'config_invalid',
      title: 'The run branch prefix is not valid',
    })
    expect(c?.detail).toContain('"bad..prefix/"')
    expect(c?.recovery[0]).toMatchObject({ kind: 'settings_link', pointer: '/isolation/branchPrefix' })
  })

  it('the default check is git check-ref-format --branch', async () => {
    expect(await isValidBranchName(folder, 'dim/20261008-add-a-flag')).toBe(true)
    expect(await isValidBranchName(folder, 'dim/bad..name')).toBe(false)
    expect(await isValidBranchName(folder, '-x')).toBe(false)
  })
})

describe('folder.git with a run branch', () => {
  const run = (facts: FolderGitFacts, overrides: object): Promise<PreflightReport> =>
    preflight(
      'authoritative',
      { folder, config: config(overrides) },
      { gitFacts: () => Promise.resolve(facts), branchNameValid: () => Promise.resolve(true) },
    )

  it('not a repo: blocks a run branch (with a way out), info without one', async () => {
    const strict = byId(await run({ isRepo: false }, { isolation: { branch: 'runBranch' } }), 'folder.git')
    expect(strict).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'git_state',
      title: 'A run branch needs a git repository',
    })
    expect(strict?.recovery[0]).toMatchObject({ kind: 'settings_link', pointer: '/isolation/branch' })
    expect(byId(await run({ isRepo: false }, {}), 'folder.git')).toMatchObject({ status: 'pass' })
  })

  it('an operation in progress or an unborn HEAD blocks a run branch, warns otherwise', async () => {
    const op = { isRepo: true, operation: 'merge' as const }
    expect(byId(await run(op, { isolation: { branch: 'runBranch' } }), 'folder.git.operation')).toMatchObject(
      {
        status: 'fail',
        blocking: true,
      },
    )
    expect(byId(await run(op, {}), 'folder.git.operation')).toMatchObject({ status: 'warn', blocking: false })
    const unborn = { isRepo: true, unbornHead: true }
    expect(byId(await run(unborn, { isolation: { branch: 'runBranch' } }), 'folder.git.head')?.status).toBe(
      'fail',
    )
  })

  it('a detached HEAD is info even with a run branch ("Detached HEAD is info only")', async () => {
    const r = await run({ isRepo: true, detachedHead: true }, { isolation: { branch: 'runBranch' } })
    expect(byId(r, 'folder.git.detached')).toMatchObject({ status: 'pass' })
    expect(r.ok).toBe(true)
  })
})
