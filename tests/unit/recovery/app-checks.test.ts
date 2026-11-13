// Git on the setup card ("the setup card probes vendors and git"; recovery actions):
// dashboard.get carries the app-scope checks of a folder-less live preflight, and their fixes (the git install
// command) are executable through recovery.execute without a folder, like the vendor rows' are.
import { describe, expect, it, vi } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import type { DashboardDeps } from '@core/handlers-dashboard.ts'
import { executeAction, findAction } from '@core/recovery/dispatcher.ts'
import type { LookupDeps } from '@core/recovery/dispatcher.ts'
import { RecoveryActionStore } from '@core/recovery/store.ts'
import type { CatalogStatus } from '@shared/catalog.ts'

const gitInstall: RecoveryAction = {
  id: 'app.git.install',
  label: 'Copy the git install command',
  kind: 'shell_copy',
  command: 'winget install --id Git.Git -e',
  shell: 'powershell',
  reason: 'Git is not installed',
  recheck: 'app.git',
}

const gitMissing: CheckResult = {
  id: 'app.git',
  scope: 'app',
  status: 'fail',
  blocking: true,
  category: 'git_missing',
  title: 'Git is not installed',
  detail: 'Dim Factory uses git to snapshot and diff every run. Install git, then re-check.',
  recovery: [gitInstall],
  at: 0,
  ttlMs: 0,
}

const lookup = (store: RecoveryActionStore): LookupDeps => ({
  runState: () => Promise.resolve(null),
  snagActions: () => Promise.resolve(new Map()),
  store,
  vendorChecks: () => [],
})

describe('app-scope actions without a folder', () => {
  it('are found once recorded from the folder-less check, and copying awaits a re-check of app.git', async () => {
    const store = new RecoveryActionStore()
    await expect(findAction({ actionId: 'app.git.install' }, lookup(store))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    store.recordApp([gitMissing])
    const found = await findAction({ actionId: 'app.git.install' }, lookup(store))
    expect(found.source).toEqual({ kind: 'app', checkId: 'app.git' })
    const awaitRecheck = vi.fn()
    const r = await executeAction(found, {
      run: {
        retryPass: vi.fn(),
        skipPass: vi.fn(),
        closeRun: vi.fn(),
        resumeRun: vi.fn(),
      },
      awaitRecheck,
    })
    expect(r).toMatchObject({ kind: 'shell_copy', copied: 'winget install --id Git.Git -e' })
    expect(awaitRecheck).toHaveBeenCalledWith('app.git')
  })

  it('a passing check replaces the app-scope actions; vendor ones and folders stay', () => {
    const store = new RecoveryActionStore()
    const login: RecoveryAction = { ...gitInstall, id: 'claude.login', recheck: 'vendor.claude.auth' }
    const report: PreflightReport = {
      mode: 'live',
      ok: false,
      blocking: [{ ...gitMissing, id: 'vendor.claude.auth', scope: 'vendor', recovery: [login] }],
      warnings: [],
      info: [],
    }
    store.record('C:\\work\\app', report)
    store.recordApp([gitMissing])
    expect(store.global('app.git.install')).toBeDefined()
    store.recordApp([{ ...gitMissing, status: 'pass', blocking: false, recovery: [] }])
    expect(store.global('app.git.install')).toBeUndefined()
    expect(store.global('claude.login')).toBeDefined()
    expect(store.folder('C:\\work\\app', 'claude.login')).toBeDefined()
  })
})

describe('dashboard.get', () => {
  const base = (over: Partial<DashboardDeps>): HandlerContext =>
    ({
      now: () => 0,
      summaries: () => [],
      dashboard: {
        attention: () => ({ needsYou: 0, items: [] }),
        vendorHealth: () => [],
        catalogStatus: () => Promise.resolve({ refreshDue: false } as CatalogStatus),
        pricing: { stepUsd: () => null, apiEquivalent: () => false },
        estimate: () => Promise.reject(new Error('unused')),
        ...over,
      },
    }) as unknown as HandlerContext

  it('carries core’s app checks when the core has them, and none otherwise', async () => {
    const withApp = await dispatch(
      createHandlers(base({ appChecks: () => Promise.resolve([gitMissing]) })),
      'dashboard.get',
      undefined,
    )
    expect(withApp.ok && withApp.value.appChecks).toEqual([gitMissing])
    const without = await dispatch(createHandlers(base({})), 'dashboard.get', undefined)
    expect(without.ok && 'appChecks' in without.value).toBe(false)
  })
})
