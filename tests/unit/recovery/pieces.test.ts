// The smaller recovery pieces (src/core/recovery/*): the per-folder action store, the vendor-failure sink (preflight's
// "a runtime failure scoped to a vendor"), vendors.setPath's path validation and git.init's refusals and argv.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { RunEnvelope } from '@shared/run.ts'
import { DimFactoryError } from '@core/errors.ts'
import type { GitResult } from '@core/git/exec.ts'
import { GitError } from '@core/git/exec.ts'
import type { CliSpec, ResolveResult } from '@core/proc/resolve-cli.ts'
import { initRepository } from '@core/recovery/git-init.ts'
import { RecoveryActionStore, reportActions } from '@core/recovery/store.ts'
import { vendorFailureSink } from '@core/recovery/vendor-failure.ts'
import { validateCliPath } from '@core/recovery/vendor-path.ts'

const action = (id: string): RecoveryAction => ({
  id,
  label: id,
  kind: 'shell_copy',
  command: `echo ${id}`,
  shell: 'sh',
  reason: '',
  recheck: id,
})
const res = (id: string, scope: CheckResult['scope'], recovery: RecoveryAction[]): CheckResult => ({
  id,
  scope,
  status: 'fail',
  blocking: true,
  title: id,
  detail: '',
  recovery,
  at: 0,
  ttlMs: 0,
})
const report = (...blocking: CheckResult[]): PreflightReport => ({
  mode: 'live',
  ok: false,
  blocking,
  warnings: [],
  info: [],
})

describe('RecoveryActionStore', () => {
  it('keeps one report per folder (least recently used dropped) and the latest app/vendor actions', () => {
    const store = new RecoveryActionStore({ maxFolders: 2 })
    store.record('/a', report(res('folder.git', 'folder', [action('a.fix')])))
    store.record('/b', report(res('app.git', 'app', [action('app.git.install')])))
    store.record('/c', report(res('folder.git', 'folder', [action('c.fix')])))
    expect(store.folderCount).toBe(2)
    expect(store.folder('/a', 'a.fix')).toBeUndefined()
    expect(store.folder('/c', 'c.fix')?.checkId).toBe('folder.git')
    // The latest report had no app action: the global one is replaced, not merged.
    expect(store.global('app.git.install')).toBeUndefined()
    store.record('/c', report(res('vendor.claude.auth', 'vendor', [action('claude.login')])))
    expect(store.global('claude.login')?.scope).toBe('vendor')
    store.forget('/c')
    expect(store.folder('/c', 'claude.login')).toBeUndefined()
  })

  it('a fix shared by several checks is listed once, under the first check', () => {
    const shared = action('claude.login')
    const out = reportActions(
      report(res('vendor.claude.auth', 'vendor', [shared]), res('pass.plan.vendor', 'pass', [shared])),
    )
    expect(out).toEqual([{ action: shared, checkId: 'vendor.claude.auth', scope: 'vendor' }])
  })
})

describe('vendorFailureSink', () => {
  const env = (body: RunEnvelope['body']): RunEnvelope => ({ runId: 'r1', seq: 1, ts: 1, body })
  const failure = (category: 'auth_expired' | 'network') => ({
    category,
    message: 'x',
    raw: '',
    classifiedBy: 'regex' as const,
  })

  it('invalidates the step vendor on a vendor-scoped snag only', () => {
    const invalidateVendor = vi.fn()
    const sink = vendorFailureSink({
      vendorOf: (_r, step) => (step === 'plan' ? 'local-x' : undefined),
      resolveId: (v) => (v.startsWith('local-') ? 'codex' : v),
      invalidateVendor,
    })
    sink.run?.(env({ t: 'snag', step: 'plan', failure: failure('network'), actions: [] }))
    sink.run?.(env({ t: 'run-status', status: 'failed', phase: 'needs-attention' }))
    expect(invalidateVendor).not.toHaveBeenCalled()
    sink.run?.(env({ t: 'snag', step: 'plan', failure: failure('auth_expired'), actions: [] }))
    expect(invalidateVendor).toHaveBeenCalledWith('codex')
    sink.run?.(env({ t: 'snag', step: 'review', failure: failure('auth_expired'), actions: [] }))
    expect(invalidateVendor).toHaveBeenCalledTimes(1)
  })
})

describe('validateCliPath', () => {
  const spec = { vendor: 'claude' } as CliSpec
  const dir = mkdtempSync(join(tmpdir(), 'dim-factory-cli-path-'))
  const file = join(dir, 'claude.exe')
  writeFileSync(file, 'x')

  it('refuses relative, missing and folder paths before resolving anything', async () => {
    const resolve = vi.fn()
    expect(await validateCliPath(spec, 'claude', { resolve })).toEqual({
      ok: false,
      reason: 'claude is not an absolute path.',
    })
    expect(await validateCliPath(spec, join(dir, 'nope.exe'), { resolve })).toMatchObject({ ok: false })
    expect(await validateCliPath(spec, dir, { resolve })).toEqual({
      ok: false,
      reason: `${dir} is not a file.`,
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("resolves the configured candidate only and answers the resolver's reason", async () => {
    const calls: unknown[] = []
    const rejected: ResolveResult = {
      ok: false,
      candidates: [file],
      rejected: [
        {
          path: file,
          source: 'config',
          reason: 'version-unrecognized',
          detail: `${file} answered "hi"; not claude`,
        },
      ],
    }
    const bad = await validateCliPath(spec, file, {
      resolve: (_s, o) => {
        calls.push(o)
        return Promise.resolve(rejected)
      },
    })
    expect(bad).toEqual({ ok: false, reason: `${file} answered "hi"; not claude` })
    expect(calls).toEqual([expect.objectContaining({ configuredPath: file, candidates: 'configured' })])
  })
})

describe('initRepository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dim-factory-git-init-'))
  const base = { dimFactoryHome: join(dir, 'home'), emptyHooksDir: join(dir, 'home', 'empty-hooks') }
  const plain = () =>
    Promise.resolve({ folder: dir, realFolder: dir, isRepo: false, dubiousOwnership: false })
  const ok = (): Promise<GitResult> =>
    Promise.resolve({ args: [], code: 0, stdout: '', stderr: '', ms: 1, truncated: false })

  it('runs `git init -q` with no hooks, in the real folder', async () => {
    const git = vi.fn(ok)
    await initRepository(dir, {
      ...base,
      guard: (p) => Promise.resolve({ guarded: false, detail: '', path: p }),
      detect: plain,
      git,
    })
    const hooks = process.platform === 'win32' ? base.emptyHooksDir.replace(/\\/g, '/') : base.emptyHooksDir
    expect(git).toHaveBeenCalledWith(
      ['-c', `core.hooksPath=${hooks}`, 'init', '-q'],
      expect.objectContaining({ cwd: dir }),
    )
  })

  it('a guarded folder never reaches git', async () => {
    const git = vi.fn(ok)
    const e = await initRepository(dir, {
      ...base,
      guard: (p) =>
        Promise.resolve({ guarded: true, reason: 'home', detail: 'This is your home folder.', path: p }),
      detect: plain,
      git,
    }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DimFactoryError)
    expect(e).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Dim Factory does not initialize git here: This is your home folder.',
    })
    expect(git).not.toHaveBeenCalled()
  })

  it('git missing or failing is a GIT error with its message', async () => {
    const e = await initRepository(dir, {
      ...base,
      guard: (p) => Promise.resolve({ guarded: false, detail: '', path: p }),
      detect: () =>
        Promise.reject(
          new GitError('missing', 'git was not found (git): spawn git ENOENT', {
            args: [],
            category: 'git_missing',
          }),
        ),
    }).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'GIT', message: 'git was not found (git): spawn git ENOENT' })
  })
})
