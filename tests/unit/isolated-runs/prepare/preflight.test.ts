// Preflight run.isolation.worktree, run.deps and run.isolation.verifyReady (eligibility and
// deps detection; trust; worktree_failed, deps_missing). Eligibility blocks with its reasons and a link
// to run in place; the long-path case warns with the copyable core.longpaths command. run.deps: the program resolves
// (corepack counts for a pnpm/yarn packageManager), and a `deps` grant exists or install `ask` (the consent card asks
// at run time); otherwise blocking deps_missing (shell_copy install tool, settings_link installCommand, config_patch
// install=never). verifyReady runs only in prepare (authoritative, owner worktree), never in the live preflight.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { trustGrantsFor } from '@core/config/trust.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import type { PreflightDeps, PreflightInput } from '@core/preflight/engine.ts'
import { detectDeps } from '@core/prepare/detectDeps.ts'
import { readDepsFacts } from '@core/prepare/facts.ts'
import { grantDeps, readDepsBody } from '@core/prepare/trust.ts'
import type { DepsPlan } from '@core/prepare/detectDeps.ts'
import { healthyChecks, healthyDeps, probeResult } from '../../preflight/helpers.ts'

const isWin = process.platform === 'win32'
let root: string
let folder: string
let home: string
let bin: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-preflight-'))
  folder = join(root, 'project')
  home = join(root, 'home')
  bin = join(root, 'bin')
  for (const d of [folder, home, bin]) mkdirSync(d, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
const byPrefix = (r: PreflightReport, p: string): CheckResult[] => all(r).filter((x) => x.id.startsWith(p))
const one = (r: PreflightReport, id: string): CheckResult | undefined => all(r).find((x) => x.id === id)

function config(over: Record<string, unknown> = {}, auto = false): ResolvedConfig {
  return resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: { isolation: { mode: 'worktree' }, auto, ...over },
  })
}

const scope = { home: () => home, folderScope: () => ({ scopeRoot: folder }) }

async function preflight(
  cfg: ResolvedConfig,
  over: Partial<PreflightDeps> = {},
  mode: 'live' | 'authoritative' = 'authoritative',
  input: Partial<PreflightInput> = {},
): Promise<PreflightReport> {
  const engine = createPreflightEngine(
    healthyDeps({
      home,
      platform: process.platform,
      trustGrants: (f) => trustGrantsFor(f, { home, folderScope: { scopeRoot: f } }),
      ...over,
    }),
  )
  engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
  return engine.run(mode, { folder, config: cfg, ...input })
}

/** A program on the test PATH (`bin`): never run by preflight, only found. */
function fakeProgram(name: string): void {
  const file = join(bin, isWin ? `${name}.cmd` : name)
  writeFileSync(file, isWin ? '@echo off\r\n' : '#!/bin/sh\n')
  if (!isWin) chmodSync(file, 0o755)
}

/** depsFacts with PATH = `bin` only (so pnpm, npm and corepack are whatever the test put there). */
const factsOnBin: Partial<PreflightDeps> = {
  depsFacts: (f, c) =>
    readDepsFacts(f, c, {
      scopeRoot: f,
      pathEnv: bin,
      grants: () => trustGrantsFor(f, { home, folderScope: { scopeRoot: f } }),
    }),
}

const pnpmProject = (extra: Record<string, unknown> = {}): void => {
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'p', ...extra }))
  writeFileSync(join(folder, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
}

async function grant(plan: DepsPlan): Promise<void> {
  const body = (await readDepsBody(folder, plan)).body ?? ''
  await grantDeps(folder, plan, body, { home: scope.home(), folderScope: scope.folderScope() })
}

describe('run.isolation.worktree', () => {
  it('in place: none of the isolated-run checks apply', async () => {
    const r = await preflight(config({ isolation: { mode: 'inPlace' } }), {
      worktreeEligibility: () => Promise.resolve({ ok: false, reasons: ['no'] }),
    })
    expect(byPrefix(r, 'run.isolation')).toEqual([])
    expect(byPrefix(r, 'run.deps')).toEqual([])
  })

  it('runs only with the eligibility check wired', async () => {
    expect(byPrefix(await preflight(config()), 'run.isolation.worktree')).toEqual([])
  })

  it('eligible: passes', async () => {
    const r = await preflight(config(), {
      worktreeEligibility: () => Promise.resolve({ ok: true, reasons: [] }),
    })
    expect(one(r, 'run.isolation.worktree')).toMatchObject({ status: 'pass', blocking: false })
  })

  it('not eligible: blocks with the reasons, their copyable fixes and a way to run in place', async () => {
    const r = await preflight(config(), {
      worktreeEligibility: () =>
        Promise.resolve({
          ok: false,
          reasons: [
            'Not enough free disk space for an isolated run. It needs about 1.7 GB; the drive has 900 MB.',
            'Git does not trust this folder (dubious ownership). The folder belongs to another user account.',
          ],
          blockers: [
            { title: 'Not enough free disk space for an isolated run', detail: '…', commands: [] },
            {
              title: 'Git does not trust this folder (dubious ownership)',
              detail: '…',
              commands: [{ command: 'git config --global --add safe.directory "C:/x"', shell: 'powershell' }],
            },
          ],
        }),
    })
    const res = one(r, 'run.isolation.worktree')
    expect(r.ok).toBe(false)
    expect(res).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'worktree_failed',
      title: 'This folder cannot run isolated',
    })
    expect(res?.detail.split('\n')).toEqual([
      'Not enough free disk space for an isolated run. It needs about 1.7 GB; the drive has 900 MB.',
      'Git does not trust this folder (dubious ownership). The folder belongs to another user account.',
    ])
    expect(res?.recovery).toEqual([
      expect.objectContaining({
        kind: 'shell_copy',
        command: 'git config --global --add safe.directory "C:/x"',
        recheck: 'run.isolation.worktree',
        reason: 'Git does not trust this folder (dubious ownership)',
      }),
      expect.objectContaining({
        kind: 'settings_link',
        label: 'Run in place instead',
        pointer: '/isolation/mode',
      }),
    ])
  })

  it('long paths on Windows: a warning with the copyable core.longpaths command', async () => {
    const detail =
      "The worktree's longest path would be 251 characters (over 240) and git's core.longpaths is off."
    const r = await preflight(config(), {
      worktreeEligibility: () => Promise.resolve({ ok: true, reasons: [], longPathWarning: { detail } }),
    })
    expect(r.ok).toBe(true)
    const warn = one(r, 'run.isolation.worktree.longPaths')
    expect(warn).toMatchObject({
      status: 'warn',
      blocking: false,
      detail,
      title: 'Some paths in the worktree may be too long for Windows',
    })
    expect(warn?.recovery[0]).toMatchObject({
      kind: 'shell_copy',
      command: 'git config --global core.longpaths true',
      recheck: 'run.isolation.worktree',
    })
  })

  it('waits for folder.git: a folder that is not a repository is reported once', async () => {
    const r = await preflight(config(), {
      gitFacts: () => Promise.resolve({ isRepo: false }),
      worktreeEligibility: () => Promise.resolve({ ok: false, reasons: ['Not a git repository'] }),
    })
    expect(one(r, 'folder.git')).toMatchObject({ status: 'fail' })
    expect(one(r, 'run.isolation.worktree')).toMatchObject({ status: 'skip' })
  })
})

describe('run.deps', () => {
  it('nothing to install, or install off: passes', async () => {
    expect(one(await preflight(config()), 'run.deps')).toMatchObject({
      status: 'pass',
      title: 'No dependencies to install',
    })
    pnpmProject()
    expect(
      one(
        await preflight(config({ isolation: { mode: 'worktree', worktree: { install: 'never' } } })),
        'run.deps',
      ),
    ).toMatchObject({ status: 'pass', title: 'Dependencies are not installed' })
  })

  it('an install command with shell syntax blocks (config_invalid) with the settings link and install=never', async () => {
    const r = await preflight(
      config({ isolation: { mode: 'worktree', worktree: { installCommand: 'npm ci && npm run build' } } }),
    )
    const res = one(r, 'run.deps')
    expect(res).toMatchObject({ status: 'fail', blocking: true, category: 'config_invalid' })
    expect(res?.recovery.map((a) => a.kind)).toEqual(['settings_link', 'config_patch'])
  })

  it('the program is missing: blocking deps_missing with its recoveries', async () => {
    pnpmProject()
    fakeProgram('npm')
    const r = await preflight(config(), factsOnBin)
    const res = one(r, 'run.deps')
    expect(res).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'deps_missing',
      title: 'Installing dependencies needs pnpm',
    })
    expect(res?.recovery).toEqual([
      expect.objectContaining({ kind: 'shell_copy', command: 'npm install -g pnpm', recheck: 'run.deps' }),
      expect.objectContaining({ kind: 'settings_link', pointer: '/isolation/worktree/installCommand' }),
      expect.objectContaining({
        kind: 'config_patch',
        label: 'Skip dependency install',
        target: 'runOverrides',
        ops: [{ op: 'replace', path: '/isolation/worktree/install', value: 'never' }],
      }),
    ])
    fakeProgram('corepack')
    const withCorepack = one(await preflight(config(), factsOnBin), 'run.deps')
    expect(withCorepack?.recovery[0]).toMatchObject({ kind: 'shell_copy', command: 'corepack enable' })
  })

  it('corepack counts for a pnpm packageManager', async () => {
    pnpmProject({ packageManager: 'pnpm@10.28.0' })
    fakeProgram('corepack')
    const plan = (await detectDeps(folder)) as DepsPlan
    await grant(plan)
    const res = one(await preflight(config(), factsOnBin), 'run.deps')
    expect(res).toMatchObject({ status: 'pass', title: 'Installs with pnpm install --frozen-lockfile' })
    expect(res?.detail).toContain('through corepack')
  })

  it('install ask without a grant: the consent card will ask (a warning in Auto); with a grant: passes', async () => {
    pnpmProject()
    fakeProgram('pnpm')
    const ask = one(await preflight(config(), factsOnBin), 'run.deps')
    expect(ask).toMatchObject({ status: 'pass', title: 'Dim Factory asks before installing dependencies' })
    const auto = await preflight(config({}, true), factsOnBin)
    expect(one(auto, 'run.deps')).toMatchObject({ status: 'warn', blocking: false })
    expect(one(auto, 'run.deps')?.detail).toContain(
      'skips `pnpm install --frozen-lockfile` and goes on without dependencies',
    )

    await grant((await detectDeps(folder)) as DepsPlan)
    expect(one(await preflight(config(), factsOnBin), 'run.deps')).toMatchObject({
      status: 'pass',
      title: 'Installs with pnpm install --frozen-lockfile',
    })
  })

  it('install auto without a grant blocks (deps_missing): ask me, or skip the install', async () => {
    pnpmProject()
    fakeProgram('pnpm')
    const res = one(
      await preflight(config({ isolation: { mode: 'worktree', worktree: { install: 'auto' } } }), factsOnBin),
      'run.deps',
    )
    expect(res).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'deps_missing',
      title: 'Installing dependencies needs your approval',
    })
    expect(res?.recovery.map((a) => a.label)).toEqual([
      'Ask me before installing',
      'Skip dependency install',
      'Set the install command',
    ])
  })

  it('a lockfile change since the grant asks again and names the file', async () => {
    pnpmProject()
    fakeProgram('pnpm')
    await grant((await detectDeps(folder)) as DepsPlan)
    writeFileSync(join(folder, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages: {}\n")
    const res = one(await preflight(config(), factsOnBin), 'run.deps')
    expect(res).toMatchObject({ status: 'pass', title: 'The install’s files changed since you allowed it' })
    expect(res?.detail).toContain('pnpm-lock.yaml changed since you allowed the install')
  })

  it('the default facts: installCommand with the real PATH (node), grants from trust.json', async () => {
    const cfg = config({
      isolation: { mode: 'worktree', worktree: { installCommand: ['node', 'setup.js'] } },
    })
    expect(one(await preflight(cfg), 'run.deps')).toMatchObject({
      status: 'pass',
      title: 'Dim Factory asks before installing dependencies',
    })
    await grant({
      manager: 'custom',
      argv: ['node', 'setup.js'],
      cwdRel: '.',
      lockfile: null,
      sources: [],
      via: 'config',
      tools: ['node'],
    })
    expect(one(await preflight(cfg, {}, 'live'), 'run.deps')).toMatchObject({
      status: 'pass',
      title: 'Installs with node setup.js',
    })
  })
})

describe('run.isolation.verifyReady', () => {
  const cfg = () =>
    config({ verify: { enabled: true, commands: [{ name: 'test', run: ['vitest', 'run'] }] } })
  const report = {
    ok: false,
    commands: [],
    missing: [{ name: 'test', argv: ['vitest', 'run'], cwdRel: '.', resolved: null }],
    reason: 'x',
  }

  it('never in the live preflight, nor for the run’s own folder', async () => {
    const deps = { verifyReady: () => Promise.resolve(report) }
    expect(
      byPrefix(await preflight(cfg(), deps, 'live', { owner: 'worktree' }), 'run.isolation.verifyReady'),
    ).toEqual([])
    expect(byPrefix(await preflight(cfg(), deps), 'run.isolation.verifyReady')).toEqual([])
  })

  it('in prepare (authoritative, owner worktree): blocking deps_missing when a program is missing', async () => {
    const r = await preflight(cfg(), { verifyReady: () => Promise.resolve(report) }, 'authoritative', {
      owner: 'worktree',
    })
    expect(one(r, 'run.isolation.verifyReady')).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'deps_missing',
      scope: 'run',
    })
    // The worktree's own preflight does not re-check eligibility or the deps decision.
    expect(byPrefix(r, 'run.deps')).toEqual([])
  })

  it('the default reads the worktree (node resolves)', async () => {
    const ok = config({ verify: { enabled: true, commands: [{ name: 'c', run: ['node', 'c.js'] }] } })
    const r = await preflight(ok, {}, 'authoritative', { owner: 'worktree' })
    expect(one(r, 'run.isolation.verifyReady')).toMatchObject({ status: 'pass' })
  })
})
