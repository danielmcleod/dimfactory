// The preflight checks against fake machine facts, fake adapters and a real temp folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import { FORMER_PROJECT_DIRNAME } from '@shared/brand.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { planImplementOverrides, resolveBuiltinConfig } from '@core/config/builtins.ts'
import { createClaudeAdapter } from '@core/adapters/claude/index.ts'
import { createPreflightEngine, runPreflight } from '@core/preflight/engine.ts'
import type { FolderGitFacts, PreflightDeps, PreflightInput } from '@core/preflight/engine.ts'
import { parseGitVersion } from '@core/preflight/checks/app.ts'
import { planNativeFor, readinessNeedFor } from '@core/preflight/checks/pass.ts'
import { GB, check, fakeAdapter, fakeRegistry, healthyChecks, healthyDeps, probeResult } from './helpers.ts'

const MB = 1024 * 1024

let root: string
let folder: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-preflight-'))
  folder = join(root, 'project')
  home = join(root, 'home')
  mkdirSync(folder, { recursive: true })
  mkdirSync(home, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
const byId = (r: PreflightReport, id: string): CheckResult | undefined => all(r).find((x) => x.id === id)
const ids = (r: PreflightReport): string[] => all(r).map((x) => x.id)

const claudeOnly = (overrides: object = {}): ResolvedConfig =>
  resolveBuiltinConfig({ profile: 'claude-only', overrides: { ...planImplementOverrides(), ...overrides } })

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return healthyDeps({ home, ...over })
}

/** Healthy claude in the probe store, then one preflight. */
async function preflight(
  mode: 'live' | 'authoritative' | 'passBoundary',
  input: PreflightInput,
  d: PreflightDeps = deps(),
): Promise<PreflightReport> {
  const engine = createPreflightEngine(d)
  engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
  return engine.run(mode, input)
}

describe('app.*', () => {
  it('parses git --version output', () => {
    expect(parseGitVersion('git version 2.17.1.windows.2\n')).toBe('2.17.1')
    expect(parseGitVersion('git version 2.45.0')).toBe('2.45.0')
    expect(parseGitVersion('nope')).toBeUndefined()
  })

  it.each([
    ['2.16.5', 'fail', true],
    ['2.17.0', 'warn', false],
    ['2.17.1', 'warn', false], // this dev machine
    ['2.35.1', 'warn', false],
    ['2.35.2', 'pass', false],
    ['2.47.0', 'pass', false],
  ] as const)('git %s → %s', async (version, status, blocking) => {
    const d = deps({
      gitVersion: () => Promise.resolve({ ok: true, version, raw: `git version ${version}` }),
    })
    const r = byId(await preflight('live', {}, d), 'app.git')
    expect(r).toMatchObject({ status, blocking })
    if (status !== 'pass') {
      expect(r?.recovery[0]).toMatchObject({
        kind: 'shell_copy',
        command: 'winget install --id Git.Git -e',
        shell: 'powershell',
        recheck: 'app.git',
      })
    }
  })

  it('missing git blocks with git_missing and an install command per OS', async () => {
    const missing = () =>
      Promise.resolve({ ok: false as const, reason: 'missing' as const, detail: 'ENOENT' })
    const win = byId(await preflight('live', {}, deps({ gitVersion: missing })), 'app.git')
    expect(win).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'git_missing',
      title: 'Git is not installed',
    })
    const mac = byId(
      await preflight('live', {}, deps({ gitVersion: missing, platform: 'darwin' })),
      'app.git',
    )
    expect(mac?.recovery[0]).toMatchObject({ command: 'xcode-select --install', shell: 'sh' })
  })

  it('live gives git a 2 s budget', async () => {
    const gitVersion = vi.fn(() => Promise.resolve({ ok: true as const, version: '2.40.0', raw: '' }))
    await preflight('live', {}, deps({ gitVersion }))
    expect(gitVersion).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 2000 }))
  })

  it.each([
    [400 * MB, 'fail'],
    [1.5 * GB, 'warn'],
    [3 * GB, 'pass'],
  ] as const)('home disk %d bytes free → %s', async (free, status) => {
    const r = byId(
      await preflight('live', {}, deps({ diskFree: () => Promise.resolve(free) })),
      'app.disk.home',
    )
    expect(r?.status).toBe(status)
    if (status !== 'pass') expect(r?.category).toBe('disk_full')
  })

  it('an unwritable home blocks and skips the disk check', async () => {
    const r = await preflight(
      'live',
      {},
      deps({ homeWritable: () => Promise.resolve({ ok: false, detail: 'EACCES' }) }),
    )
    expect(byId(r, 'app.home.writable')).toMatchObject({ status: 'fail', category: 'disk_full' })
    expect(byId(r, 'app.disk.home')?.status).toBe('skip')
  })

  it('the default home writability probe works on a temp home', async () => {
    const d = deps()
    delete d.homeWritable
    expect(byId(await preflight('live', {}, d), 'app.home.writable')?.status).toBe('pass')
  })
})

describe('folder.*', () => {
  it('a missing folder blocks and skips its dependents', async () => {
    const r = await preflight(
      'authoritative',
      {
        folder: join(root, 'nope'),
      },
      deps({
        gitFacts: () => Promise.resolve({ isRepo: true }),
        folderSize: () => Promise.resolve({ files: 0, bytes: 0 }),
      }),
    )
    expect(byId(r, 'folder.exists')).toMatchObject({
      status: 'fail',
      category: 'folder_guard',
      title: 'Folder not found',
    })
    for (const id of ['folder.guard', 'folder.size', 'folder.git', 'folder.disk'])
      expect(byId(r, id)?.status).toBe('skip')
  })

  it('a file is not a folder', async () => {
    const file = join(root, 'f.txt')
    writeFileSync(file, 'x')
    expect(byId(await preflight('live', { folder: file }), 'folder.exists')?.title).toBe('Not a folder')
  })

  it('guarded folders block with the guard detail', async () => {
    const isGuarded = vi.fn((path: string) => ({
      guarded: true,
      reason: 'home' as const,
      detail: 'is your home folder',
      path,
    }))
    const r = await preflight('live', { folder }, deps({ isGuarded }))
    expect(byId(r, 'folder.guard')).toMatchObject({
      status: 'fail',
      category: 'folder_guard',
      detail: 'is your home folder',
    })
    expect(isGuarded).toHaveBeenCalledWith(folder, { owner: 'run', dimFactoryHome: home, platform: 'win32' })
  })

  it('a folder inside a repository whose top level is guarded is refused (the scope root is checked too)', async () => {
    // e.g. a dotfiles repo at the home folder: the project folder passes, its scope root (~) does not.
    const top = join(root, 'home-repo')
    const isGuarded = vi.fn((path: string) =>
      path === top
        ? { guarded: true, reason: 'home' as const, detail: `${top} is your home folder.`, path }
        : { guarded: false, detail: 'ok', path },
    )
    const r = await preflight('live', { folder }, deps({ isGuarded, scopeRoot: () => Promise.resolve(top) }))
    const g = byId(r, 'folder.guard')
    expect(g).toMatchObject({ status: 'fail', blocking: true, category: 'folder_guard' })
    expect(g?.detail).toContain(`${folder} is inside the git repository at ${top}, which is your home folder`)
    expect(isGuarded).toHaveBeenCalledWith(top, { owner: 'run', dimFactoryHome: home, platform: 'win32' })
    // Same scope root as the folder (its own repository, or not a repository): one guard call, pass.
    isGuarded.mockClear()
    const own = await preflight(
      'live',
      { folder },
      deps({ isGuarded, scopeRoot: () => Promise.resolve(folder) }),
    )
    expect(byId(own, 'folder.guard')?.status).toBe('pass')
    expect(isGuarded).toHaveBeenCalledTimes(1)
    // The scope root cannot be read (git missing): the folder alone decides.
    const unknown = await preflight(
      'live',
      { folder },
      deps({ isGuarded, scopeRoot: () => Promise.reject(new Error('git missing')) }),
    )
    expect(byId(unknown, 'folder.guard')?.status).toBe('pass')
  })

  it('the real guard refuses the OS home folder', async () => {
    const d = deps({ platform: process.platform })
    delete d.isGuarded
    const r = await preflight('live', { folder: homedir() }, d)
    expect(byId(r, 'folder.guard')).toMatchObject({ status: 'fail', blocking: true })
    expect(byId(await preflight('live', { folder }, d), 'folder.guard')?.status).toBe('pass')
  })

  it('Dim Factory-owned cwds skip folder.* entirely', async () => {
    for (const owner of ['heal', 'catalog', 'probe'] as const) {
      const r = await preflight('live', { folder, owner })
      expect(ids(r).filter((id) => id.startsWith('folder.'))).toEqual([])
    }
    const wt = await preflight('live', { folder, owner: 'worktree' })
    expect(byId(wt, 'folder.exists')?.status).toBe('pass')
  })

  describe('folder.size', () => {
    it('more than 20k files or 1 GB blocks with a largeFolder grant action', async () => {
      const r = await preflight(
        'live',
        { folder },
        deps({ folderSize: () => Promise.resolve({ files: 25_000, bytes: 10 * MB }) }),
      )
      const size = byId(r, 'folder.size')
      expect(size).toMatchObject({ status: 'fail', category: 'folder_guard' })
      expect(size?.recovery[0]).toMatchObject({
        kind: 'grant',
        grant: 'largeFolder',
        detail: '25,000 new files, 10 MB',
      })
      const bytes = await preflight(
        'live',
        { folder },
        deps({ folderSize: () => Promise.resolve({ files: 3, bytes: 2 * GB }) }),
      )
      expect(byId(bytes, 'folder.size')?.status).toBe('fail')
    })

    it('the largeFolder grant clears the block', async () => {
      const r = await preflight(
        'live',
        { folder },
        deps({
          folderSize: () => Promise.resolve({ files: 25_000, bytes: 0 }),
          hasLargeFolderGrant: () => true,
        }),
      )
      expect(byId(r, 'folder.size')).toMatchObject({ status: 'pass' })
      expect(byId(r, 'folder.size')?.detail).toContain('(allowed)')
    })

    it('files over 100 MB are a warning', async () => {
      const r = await preflight(
        'live',
        { folder },
        deps({
          folderSize: () =>
            Promise.resolve({
              files: 2,
              bytes: 300 * MB,
              largeFiles: [{ path: 'big.bin', bytes: 250 * MB }],
            }),
        }),
      )
      expect(byId(r, 'folder.size')).toMatchObject({
        status: 'warn',
        title: '1 file over 100 MB left out of snapshots',
      })
    })
  })

  describe('folder.git', () => {
    const run = async (facts: FolderGitFacts, overrides: object = {}): Promise<PreflightReport> =>
      preflight(
        'authoritative',
        { folder, config: claudeOnly(overrides) },
        deps({ gitFacts: () => Promise.resolve(facts) }),
      )

    it('not a repo → info in place, blocking for isolated runs', async () => {
      expect(byId(await run({ isRepo: false }), 'folder.git')).toMatchObject({
        status: 'pass',
        title: 'Not a git repository',
      })
      expect(
        byId(await run({ isRepo: false }, { isolation: { mode: 'worktree' } }), 'folder.git'),
      ).toMatchObject({
        status: 'fail',
        category: 'git_state',
      })
    })

    it('dubious ownership: warn in place, block with runBranch; offers safe.directory', async () => {
      const inPlace = byId(await run({ isRepo: true, dubiousOwnership: true }), 'folder.git.ownership')
      expect(inPlace).toMatchObject({ status: 'warn', blocking: false, category: 'git_state' })
      expect(inPlace?.recovery[0]).toMatchObject({
        kind: 'shell_copy',
        command: `git config --global --add safe.directory "${folder.replace(/\\/g, '/')}"`,
        recheck: 'folder.git',
      })
      const strict = await run(
        { isRepo: true, dubiousOwnership: true },
        { isolation: { branch: 'runBranch' } },
      )
      expect(byId(strict, 'folder.git.ownership')).toMatchObject({ status: 'fail', blocking: true })
      expect(strict.ok).toBe(false)
    })

    it('an operation in progress offers the abort command', async () => {
      const r = byId(await run({ isRepo: true, operation: 'rebase' }), 'folder.git.operation')
      expect(r).toMatchObject({ status: 'warn', title: 'A git rebase is in progress' })
      expect(r?.recovery[0]).toMatchObject({ command: 'git rebase --abort' })
    })

    it('index.lock, unmerged paths and unborn HEAD', async () => {
      const r = await run({ isRepo: true, indexLock: true, unmergedPaths: true, unbornHead: true })
      expect(byId(r, 'folder.git.lock')?.status).toBe('warn')
      expect(byId(r, 'folder.git.unmerged')?.status).toBe('warn')
      expect(byId(r, 'folder.git.head')?.status).toBe('warn')
      expect(r.ok).toBe(true)
      const strict = await run({ isRepo: true, unbornHead: true }, { isolation: { mode: 'worktree' } })
      expect(byId(strict, 'folder.git.head')).toMatchObject({ status: 'fail', blocking: true })
    })

    it('a copy made from a snapshot needs no commit, unless a run branch is asked for', async () => {
      const copy = (isolation: object): Promise<PreflightReport> =>
        preflight(
          'authoritative',
          { folder, config: claudeOnly({ isolation }), snapshotCopy: true },
          deps({ gitFacts: () => Promise.resolve({ isRepo: true, unbornHead: true }) }),
        )
      const plain = await copy({ mode: 'worktree' })
      expect(byId(plain, 'folder.git.head')).toMatchObject({
        status: 'warn',
        detail: 'The copy is made from the folder as it is now, so no commit is needed.',
      })
      expect(plain.blocking.map((b) => b.id)).not.toContain('folder.git.head')
      const branch = await copy({ mode: 'worktree', branch: 'runBranch' })
      expect(byId(branch, 'folder.git.head')).toMatchObject({ status: 'fail', blocking: true })
    })

    it('detached HEAD is info; a clean repo names its branch', async () => {
      expect(byId(await run({ isRepo: true, detachedHead: true }), 'folder.git.detached')?.status).toBe(
        'pass',
      )
      expect(byId(await run({ isRepo: true, branch: 'main' }), 'folder.git')).toMatchObject({
        status: 'pass',
        detail: 'On main',
      })
    })

    it('is skipped when git is missing', async () => {
      const r = await preflight(
        'live',
        { folder },
        deps({
          gitVersion: () => Promise.resolve({ ok: false, reason: 'missing', detail: '' }),
          gitFacts: () => Promise.resolve({ isRepo: true }),
        }),
      )
      expect(byId(r, 'folder.git')?.status).toBe('skip')
    })
  })

  it('folder.lock is info: "queues behind #N"', async () => {
    const now = 1_000_000_000
    const r = await preflight(
      'live',
      { folder },
      deps({
        now: () => now,
        lockQuery: () => ({ runId: 'r', displayNo: 3, status: 'paused', since: now - 2 * 86_400_000 }),
      }),
    )
    expect(byId(r, 'folder.lock')).toMatchObject({
      status: 'pass',
      title: 'Queues behind run #3 (paused 2d)',
    })
    expect(r.ok).toBe(true)
    const free = await preflight('live', { folder }, deps({ lockQuery: () => null }))
    expect(byId(free, 'folder.lock')?.status).toBe('pass')
  })

  it.each([
    [100 * MB, 'fail'],
    [500 * MB, 'warn'],
    [2 * GB, 'pass'],
  ] as const)('folder disk %d bytes → %s', async (free, status) => {
    const diskFree = (p: string) => Promise.resolve(p === home ? 100 * GB : free)
    expect(byId(await preflight('live', { folder }, deps({ diskFree })), 'folder.disk')?.status).toBe(status)
  })

  it('folder.project.former: nothing without the former project folder', async () => {
    expect(byId(await preflight('live', { folder }, deps()), 'folder.project.former')).toBeUndefined()
  })

  it('folder.project.former: a notice that offers the rename, never a blocker', async () => {
    mkdirSync(join(folder, FORMER_PROJECT_DIRNAME), { recursive: true })
    const r = await preflight('live', { folder }, deps())
    const c = byId(r, 'folder.project.former')
    expect(c).toMatchObject({
      status: 'warn',
      blocking: false,
      title: 'Project folder from before the rename',
    })
    expect(c?.detail).toBe(
      `${FORMER_PROJECT_DIRNAME} is from before the rename to Dim Factory and is not read. Rename it to .dimfactory to keep its settings.`,
    )
    expect(c?.recovery).toEqual([
      expect.objectContaining({
        id: 'folder.project.former.rename',
        kind: 'shell_copy',
        // deps() is a win32 machine, whatever OS runs the test.
        command: `Rename-Item -LiteralPath '${FORMER_PROJECT_DIRNAME}' -NewName '.dimfactory'`,
      }),
    ])
    expect(r.blocking.map((x) => x.id)).not.toContain('folder.project.former')
  })

  it('folder.project.former: with both folders, says which one is read and offers nothing', async () => {
    mkdirSync(join(folder, FORMER_PROJECT_DIRNAME), { recursive: true })
    mkdirSync(join(folder, '.dimfactory'), { recursive: true })
    const c = byId(await preflight('live', { folder }, deps()), 'folder.project.former')
    expect(c).toMatchObject({ status: 'warn', blocking: false, recovery: [] })
    expect(c?.detail).toContain('.dimfactory is.')
  })
})

describe('run.*', () => {
  it('run.profile: unknown profile blocks with a suggestion', async () => {
    const cfg = { ...claudeOnly(), profile: 'claude-onyl' }
    const r = byId(await preflight('live', { config: cfg }), 'run.profile')
    expect(r).toMatchObject({
      status: 'fail',
      category: 'config_invalid',
      title: 'Unknown profile "claude-onyl"',
    })
    expect(r?.detail).toContain('Did you mean "claude-only"?')
    expect(byId(await preflight('live', { config: claudeOnly() }), 'run.profile')?.status).toBe('pass')
  })

  it('run.passes: nothing enabled blocks; Fix without Implement is info', async () => {
    const off = claudeOnly({
      passes: {
        plan: { enabled: false },
        implement: { enabled: false },
        review: { enabled: false },
        critic: { enabled: false },
        fix: { enabled: false },
      },
    })
    expect(byId(await preflight('live', { config: off }), 'run.passes')).toMatchObject({
      status: 'fail',
      category: 'config_invalid',
    })
    const fixOnly = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: { passes: { implement: { enabled: false } } },
    })
    expect(byId(await preflight('live', { config: fixOnly }), 'run.passes')).toMatchObject({
      status: 'pass',
      detail: 'Implement is off, so Fix will be skipped.',
    })
    expect(byId(await preflight('live', { config: claudeOnly() }), 'run.passes')?.title).toBe(
      'Plan → Implement',
    )
  })

  describe('run.templates', () => {
    const withProjectPrompt = (name: string, text: string, pass: string): ResolvedConfig => {
      mkdirSync(join(folder, '.dimfactory', 'prompts'), { recursive: true })
      writeFileSync(join(folder, '.dimfactory', 'prompts', `${name}.md`), text)
      return resolveBuiltinConfig({
        profile: 'claude-only',
        overrides: { passes: { [pass]: { promptTemplate: name } } },
        folder,
        home,
      })
    }

    it('builtin templates pass', async () => {
      const r = await preflight('authoritative', { config: claudeOnly() })
      expect(byId(r, 'run.templates')).toMatchObject({ status: 'pass' })
    })

    it('an unknown placeholder blocks with file:line:col', async () => {
      const cfg = withProjectPrompt('my-plan', 'Plan this:\n  {{tsk}}\n', 'plan')
      const r = byId(await preflight('authoritative', { config: cfg }), 'run.templates.plan')
      expect(r).toMatchObject({ status: 'fail', blocking: true, category: 'config_invalid' })
      expect(r?.detail).toContain(
        `${join(folder, '.dimfactory', 'prompts', 'my-plan.md')}:2:3: Unknown placeholder {{tsk}}`,
      )
      expect(r?.recovery[0]).toMatchObject({ kind: 'settings_link', pointer: '/passes/plan/promptTemplate' })
    })

    it('a missing required placeholder warns', async () => {
      const cfg = withProjectPrompt('my-review', 'Review it.\n', 'review')
      const r = byId(await preflight('authoritative', { config: cfg }), 'run.templates.review')
      expect(r).toMatchObject({ status: 'warn', title: 'Review prompt is missing {{diff}}' })
    })

    it('implement without {{plan}} warns only while Plan is enabled', async () => {
      const cfg = withProjectPrompt('my-impl', 'Do {{task}}\n', 'implement')
      expect(byId(await preflight('live', { config: cfg }), 'run.templates.implement')?.status).toBe('warn')
      const noPlan = { ...cfg, passes: { ...cfg.passes, plan: { ...cfg.passes.plan, enabled: false } } }
      expect(byId(await preflight('live', { config: noPlan }), 'run.templates.implement')).toBeUndefined()
    })

    it('a template file deleted after resolve blocks', async () => {
      const cfg = withProjectPrompt('gone', '{{task}}', 'plan')
      rmSync(join(folder, '.dimfactory', 'prompts', 'gone.md'))
      expect(byId(await preflight('authoritative', { config: cfg }), 'run.templates.plan')).toMatchObject({
        status: 'fail',
        title: 'Plan prompt template is missing',
      })
    })
  })
})

describe('pass.*', () => {
  it('pass.<p>.vendor blocks with the vendor check’s category and recovery', async () => {
    const login = {
      id: 'claude.login',
      label: 'Copy',
      kind: 'shell_copy' as const,
      command: 'claude auth login',
      shell: 'powershell' as const,
      reason: 'x',
      recheck: 'vendor.claude.auth',
    }
    const checks = healthyChecks('claude', 0).map((c) =>
      c.id === 'vendor.claude.auth'
        ? check(c.id, 'fail', {
            category: 'auth_required',
            title: 'Claude Code is not logged in',
            recovery: [login],
          })
        : c,
    )
    const engine = createPreflightEngine(deps())
    engine.recordProbe(probeResult('claude', 0, checks))
    const r = await engine.run('live', { folder, config: claudeOnly() })
    const plan = byId(r, 'pass.plan.vendor')
    expect(plan).toMatchObject({
      status: 'fail',
      category: 'auth_required',
      title: 'Plan: Claude Code is not logged in',
    })
    expect(plan?.recovery).toEqual([login])
    expect(byId(r, 'pass.implement.vendor')?.status).toBe('fail')
    expect(byId(r, 'pass.plan.mode')?.status).toBe('skip')
    expect(byId(r, 'pass.plan.readiness')?.status).toBe('skip')
    expect(r.blocking.map((x) => x.id)).toEqual([
      'vendor.claude.auth',
      'pass.plan.vendor',
      'pass.implement.vendor',
    ])
  })

  it('an unbuilt vendor (registry stub) blocks its passes with capability_missing', async () => {
    const cfg = resolveBuiltinConfig({ profile: 'balanced', overrides: planImplementOverrides() })
    const r = await preflight('authoritative', { folder, config: cfg })
    expect(byId(r, 'vendor.codex.protocol')).toMatchObject({ status: 'fail', category: 'capability_missing' })
    const impl = byId(r, 'pass.implement.vendor')
    expect(impl).toMatchObject({ status: 'fail', category: 'capability_missing' })
    expect(impl?.recovery[0]).toMatchObject({ kind: 'switch_vendor', to: 'claude' })
    expect(byId(r, 'pass.plan.vendor')?.status).toBe('pass')
  })

  it('an unknown vendor blocks with config_invalid', async () => {
    const cfg = claudeOnly()
    const bad = { ...cfg, passes: { ...cfg.passes, plan: { ...cfg.passes.plan, vendor: 'nope' } } }
    const r = await preflight('authoritative', { folder, config: bad })
    expect(byId(r, 'pass.plan.vendor')).toMatchObject({ status: 'fail', category: 'config_invalid' })
    expect(byId(r, 'vendor.nope.bin')).toMatchObject({ status: 'fail', category: 'config_invalid' })
  })

  it('pass.<p>.mode: unsupported blocks (switch vendor; read-only passes can be turned off), degraded warns', async () => {
    const claude = fakeAdapter('claude', {
      support: (need) =>
        need.pass === 'plan'
          ? { status: 'unsupported', copy: 'Not in this mode', reason: 'no-plan' }
          : need.pass === 'implement'
            ? { status: 'degraded', copy: 'asks auto-denied' }
            : { status: 'supported', copy: 'ok' },
    })
    const r = await preflight(
      'live',
      { folder, config: claudeOnly() },
      deps({ adapters: fakeRegistry(claude) }),
    )
    const plan = byId(r, 'pass.plan.mode')
    expect(plan).toMatchObject({
      status: 'fail',
      category: 'capability_missing',
      detail: 'Not in this mode (no-plan)',
    })
    expect(plan?.recovery.map((a) => a.kind)).toEqual(['switch_vendor', 'config_patch'])
    expect(plan?.recovery[1]).toMatchObject({
      target: 'runOverrides',
      ops: [{ op: 'add', path: '/passes/plan/enabled', value: false }],
    })
    expect(byId(r, 'pass.implement.mode')).toMatchObject({ status: 'warn', detail: 'asks auto-denied' })
  })

  it('readiness results pass through with their own ids; the need carries planNative and the resume id', async () => {
    const claude = fakeAdapter('claude', {
      readiness: (_cwd, need) => [
        check(`pass.${need.pass}.readiness.claude-allow-rules`, 'warn', { blocking: false }),
      ],
    })
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const r = await preflight(
      'live',
      { folder, config: cfg, resumeSessionId: 'sess-1' },
      deps({ adapters: fakeRegistry(claude) }),
    )
    expect(byId(r, 'pass.review.readiness.claude-allow-rules')?.status).toBe('warn')
    const needs = Object.fromEntries(claude.readinessCalls.map((c) => [c.need.pass, c.need]))
    expect(needs['plan']).toMatchObject({ mode: 'readonly', planNative: true, trustFolder: false })
    expect(needs['implement']).toMatchObject({ mode: 'autoedit', planNative: false })
    expect(needs['fix']?.resumeSessionId).toBe('sess-1')
    expect(needs['implement']?.resumeSessionId).toBeUndefined()
    expect(claude.readinessCalls.every((c) => c.cwd === folder)).toBe(true)
  })

  it('planNativeFor: native auto + native capability + passing plan check', () => {
    const cfg = claudeOnly()
    const native = probeResult('claude', 0, healthyChecks('claude', 0))
    const snap = { probe: native, checks: native.checks, authAt: 0, stale: false }
    expect(planNativeFor(cfg, snap)).toBe(true)
    expect(planNativeFor({ planning: { native: 'off' } }, snap)).toBe(false)
    expect(planNativeFor(cfg, undefined)).toBe(false)
    const old = { ...snap, checks: [check('vendor.claude.plan', 'skip')] }
    expect(planNativeFor(cfg, old)).toBe(false)
    const emulated = probeResult('claude', 0, [], false)
    expect(planNativeFor(cfg, { probe: emulated, checks: [], authAt: 0, stale: false })).toBe(false)
    expect(readinessNeedFor(cfg, 'plan', snap)).toEqual({
      pass: 'plan',
      mode: 'readonly',
      planNative: true,
      trustFolder: false,
      // The pass's Extensions level (copy that depends on it, Codex's MCP note).
      extensions: 'none',
    })
  })

  it('pass.plan.native is info', async () => {
    const r = await preflight('live', { folder, config: claudeOnly() })
    expect(byId(r, 'pass.plan.native')).toMatchObject({ status: 'pass', title: 'Native plan mode (Claude)' })
    const off = await preflight('live', { folder, config: claudeOnly({ planning: { native: 'off' } }) })
    expect(byId(off, 'pass.plan.native')?.title).toBe('Plan uses the plan template')
  })

  it('passBoundary checks only the boundary pass and never probes', async () => {
    const claude = fakeAdapter('claude')
    const d = deps({ adapters: fakeRegistry(claude) })
    const r = await preflight('passBoundary', { folder, config: claudeOnly(), pass: 'implement' }, d)
    expect(ids(r)).toEqual(['pass.implement.vendor', 'pass.implement.mode', 'pass.implement.readiness.mode'])
    expect(r.ok).toBe(true)
    expect(claude.probeCalls).toEqual([])
    expect(d.gitVersion).not.toHaveBeenCalled()
  })

  it('works with the real Claude adapter’s support() and readiness()', async () => {
    const claude = createClaudeAdapter({ home, env: { PATH: '' } })
    const d = deps({ adapters: fakeRegistry(claude) })
    const r = await preflight('live', { folder, config: claudeOnly() }, d)
    expect(byId(r, 'pass.plan.mode')).toMatchObject({ status: 'pass' })
    expect(byId(r, 'pass.plan.readiness.claude-allow-rules')?.status).toBe('pass')
    expect(byId(r, 'pass.implement.readiness.mode')?.status).toBe('pass')
    expect(r.ok).toBe(true)
  })
})

describe('Plan → Implement end to end (claude-only, git 2.17.1)', () => {
  const dev = (): PreflightDeps =>
    deps({
      gitVersion: () => Promise.resolve({ ok: true, version: '2.17.1', raw: 'git version 2.17.1.windows.2' }),
      gitFacts: () => Promise.resolve({ isRepo: true, branch: 'main' }),
      folderSize: () => Promise.resolve({ files: 12, bytes: 40_000 }),
      lockQuery: () => null,
    })

  it('authoritative: ok, git 2.17.1 is the only warning', async () => {
    const r = await runPreflight(
      'authoritative',
      { folder, config: claudeOnly() },
      {
        ...dev(),
        adapters: fakeRegistry(fakeAdapter('claude')),
      },
    )
    expect(r.ok).toBe(true)
    expect(r.warnings.map((x) => x.id)).toEqual(['app.git'])
    expect(ids(r)).toEqual(
      expect.arrayContaining([
        'app.home.writable',
        'app.disk.home',
        'app.git',
        'vendor.claude.bin',
        'vendor.claude.auth',
        'folder.exists',
        'folder.guard',
        'folder.size',
        'folder.git',
        'folder.lock',
        'folder.disk',
        'run.profile',
        'run.passes',
        'run.templates',
        'pass.plan.vendor',
        'pass.plan.mode',
        'pass.plan.readiness.mode',
        'pass.plan.native',
        'pass.implement.vendor',
        'pass.implement.mode',
        'pass.implement.readiness.mode',
      ]),
    )
    expect(ids(r).some((id) => id.startsWith('pass.review'))).toBe(false)
  })

  it('live: same verdict from the probe store, no vendor spawn', async () => {
    const claude = fakeAdapter('claude')
    const recheckAuth = vi.fn(() => Promise.resolve([]))
    const d = { ...dev(), adapters: fakeRegistry(claude), recheckAuth }
    const engine = createPreflightEngine(d)
    engine.recordProbe(probeResult('claude', 1, healthyChecks('claude', 1)))
    const r = await engine.run('live', { folder, config: claudeOnly() })
    expect(r.ok).toBe(true)
    expect(claude.probeCalls).toEqual([])
    expect(recheckAuth).not.toHaveBeenCalled()
  })
})
