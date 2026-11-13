// "I ran it → Re-check" and the live-preflight guarantees in the engine (preflight modes and cache
// invalidation; "fake auth status exit 1 → Run disabled → copy → Re-check enables Run"):
//   - a check whose fix was handed out is re-run (not served from its cache) until it passes, warnings included
//   - the report lists each group by scope (app → vendor → folder → run → pass), then def order
//   - the authoritative preflight re-checks a failed login every time and re-probes an otherwise broken vendor
//   - live never probes a vendor, whatever its state
import { describe, expect, it, vi } from 'vitest'
import type { CheckResult, CheckScope, CheckStatus, PreflightMode } from '@shared/preflight.ts'
import { PreflightCache, RECHECK_WINDOW_MS } from '@core/preflight/cache.ts'
import { buildReport, createPreflightEngine, runButtonReasons, runPreflight } from '@core/preflight/engine.ts'
import type { CheckContext, PreflightCheckDef } from '@core/preflight/engine.ts'
import {
  check,
  clock,
  fakeAdapter,
  fakeRegistry,
  healthyChecks,
  healthyDeps,
  probeResult,
} from '../preflight/helpers.ts'

interface Def extends PreflightCheckDef {
  calls: number
  status: CheckStatus
  /** Result ids returned (default: the def id). */
  resultIds?: string[]
}

function def(id: string, o: Partial<PreflightCheckDef> & { status?: CheckStatus } = {}): Def {
  const d: Def = {
    calls: 0,
    status: o.status ?? 'pass',
    id,
    scope: 'app',
    title: id,
    dependsOn: [],
    cost: 'cheap',
    ttlMs: 60 * 60_000,
    modes: ['live', 'authoritative'] as PreflightMode[],
    appliesTo: () => true,
    subjectKey: () => 's',
    ...o,
    run(ctx: CheckContext): Promise<CheckResult[]> {
      d.calls++
      const ids = d.resultIds ?? [id]
      return Promise.resolve(ids.map((rid) => ctx.result({ id: rid, status: d.status, detail: rid })))
    },
  }
  return d
}

const factory =
  (...defs: PreflightCheckDef[]) =>
  () =>
    defs

describe('re-check after a fix was handed out', () => {
  it('re-runs a cached failing check until it passes, then serves the cache again', async () => {
    const c = clock()
    const git = def('app.git', { status: 'fail' })
    const engine = createPreflightEngine(healthyDeps({ now: c.now }), { checks: factory(git) })
    await engine.run('live', {})
    await engine.run('live', {})
    expect(git.calls).toBe(1) // cached for an hour

    engine.cache.awaitRecheck('app.git', c.now())
    const still = await engine.run('live', {})
    expect(git.calls).toBe(2)
    expect(still.ok).toBe(false)
    await engine.run('live', {})
    expect(git.calls).toBe(3) // still failing: still re-run

    git.status = 'pass'
    const fixed = await engine.run('live', {})
    expect(git.calls).toBe(4)
    expect(fixed.ok).toBe(true)
    expect(engine.cache.pendingRechecks).toEqual([])
    await engine.run('live', {})
    expect(git.calls).toBe(4) // passed: back to its cache
  })

  it('a result id (folder.git.ownership) re-checks its def, and a warning keeps the re-check open', async () => {
    const c = clock()
    const folderGit = def('folder.git', { status: 'warn', scope: 'folder' })
    folderGit.resultIds = ['folder.git.ownership']
    const engine = createPreflightEngine(healthyDeps({ now: c.now }), { checks: factory(folderGit) })
    await engine.run('live', {})
    engine.cache.awaitRecheck('folder.git.ownership', c.now())
    await engine.run('live', {})
    await engine.run('live', {})
    expect(folderGit.calls).toBe(3)
    expect(engine.cache.pendingRechecks).toEqual(['folder.git.ownership'])
    folderGit.status = 'pass'
    await engine.run('live', {})
    expect(engine.cache.pendingRechecks).toEqual([])
  })

  it('a re-check lapses after the window', async () => {
    const c = clock()
    const git = def('app.git', { status: 'fail' })
    const engine = createPreflightEngine(healthyDeps({ now: c.now }), { checks: factory(git) })
    engine.cache.awaitRecheck('app.git', c.now())
    await engine.run('live', {})
    c.advance(RECHECK_WINDOW_MS)
    await engine.run('live', {})
    expect(git.calls).toBe(1) // the re-run at the start was cached, the window has passed
    expect(engine.cache.pendingRechecks).toEqual([])
  })

  it('a vendor id marks the probe stale (authoritative re-probes it); live still never probes', async () => {
    const claude = fakeAdapter('claude')
    const cache = new PreflightCache()
    cache.setProbe(probeResult('claude', 1, healthyChecks('claude', 1)))
    cache.awaitRecheck('vendor.claude.auth', 2)
    expect(cache.isStale('claude')).toBe(true)
    const vendorDef: PreflightCheckDef = {
      id: 'vendor.claude',
      scope: 'vendor',
      title: 'claude',
      dependsOn: [],
      cost: 'spawn',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: () => true,
      subjectKey: () => 'claude',
      run: async (ctx) =>
        ctx.mode === 'authoritative'
          ? (await ctx.vendors.ensure('claude')).checks
          : (ctx.vendors.latest('claude')?.checks ?? []),
    }
    const deps = healthyDeps({ adapters: fakeRegistry(claude) })
    await runPreflight('live', {}, deps, { cache, checks: factory(vendorDef) })
    expect(claude.probeCalls).toEqual([])
    await runPreflight('authoritative', {}, deps, { cache, checks: factory(vendorDef) })
    expect(claude.probeCalls).toEqual([{ force: true }])
    expect(cache.pendingRechecks).toEqual([]) // the fresh probe's auth passed
  })
})

describe('report order', () => {
  const at = (id: string, scope: CheckScope, status: CheckStatus): CheckResult =>
    check(id, status, { scope, title: id })

  it('groups by scope app → vendor → folder → run → pass, keeping def order within a scope', () => {
    const r = buildReport('live', [
      at('pass.plan.vendor', 'pass', 'fail'),
      at('run.profile', 'run', 'fail'),
      at('folder.guard', 'folder', 'fail'),
      at('vendor.claude.auth', 'vendor', 'fail'),
      at('app.git', 'app', 'fail'),
      at('folder.exists', 'folder', 'fail'),
      at('folder.size', 'folder', 'warn'),
      at('app.disk.home', 'app', 'warn'),
      at('pass.plan.native', 'pass', 'pass'),
      at('app.home.writable', 'app', 'pass'),
    ])
    expect(r.blocking.map((x) => x.id)).toEqual([
      'app.git',
      'vendor.claude.auth',
      'folder.guard',
      'folder.exists',
      'run.profile',
      'pass.plan.vendor',
    ])
    expect(r.warnings.map((x) => x.id)).toEqual(['app.disk.home', 'folder.size'])
    expect(r.info.map((x) => x.id)).toEqual(['app.home.writable', 'pass.plan.native'])
    expect(runButtonReasons(r)).toEqual(['app.git', 'vendor.claude.auth', 'folder.guard'])
  })
})

describe('authoritative vendor re-checks', () => {
  const vendorDef: PreflightCheckDef = {
    id: 'vendor.claude',
    scope: 'vendor',
    title: 'claude',
    dependsOn: [],
    cost: 'spawn',
    ttlMs: 0,
    modes: ['live', 'authoritative'],
    appliesTo: () => true,
    subjectKey: () => 'claude',
    run: async (ctx) =>
      ctx.mode === 'authoritative'
        ? (await ctx.vendors.ensure('claude')).checks
        : (ctx.vendors.latest('claude')?.checks ?? []),
  }
  const loggedOut = (at: number): CheckResult[] =>
    healthyChecks('claude', at).map((c) =>
      c.id === 'vendor.claude.auth'
        ? check(c.id, 'fail', { at, category: 'auth_required', title: 'Not logged in' })
        : c,
    )

  it('a failed login is re-checked on every authoritative preflight, without a new probe', async () => {
    const c = clock()
    const claude = fakeAdapter('claude', { probe: probeResult('claude', c.now(), loggedOut(c.now())) })
    let loggedIn = false
    const recheckAuth = vi.fn(() =>
      Promise.resolve([
        loggedIn
          ? check('vendor.claude.auth', 'pass', { title: 'Logged in' })
          : check('vendor.claude.auth', 'fail', { category: 'auth_required', title: 'Not logged in' }),
      ]),
    )
    const engine = createPreflightEngine(
      healthyDeps({ adapters: fakeRegistry(claude), recheckAuth, now: c.now }),
      { checks: factory(vendorDef) },
    )
    const first = await engine.run('authoritative', {})
    // The store was empty: one probe, whose own auth result stands (no second auth status right after it).
    expect(claude.probeCalls).toEqual([{ force: false }])
    expect(recheckAuth).not.toHaveBeenCalled()
    expect(first.ok).toBe(false)

    const again = await engine.run('authoritative', {})
    expect(recheckAuth).toHaveBeenCalledTimes(1)
    expect(again.ok).toBe(false)

    loggedIn = true
    const after = await engine.run('authoritative', {})
    expect(recheckAuth).toHaveBeenCalledTimes(2)
    expect(after.ok).toBe(true)
    expect(claude.probeCalls).toHaveLength(1)
    // Logged in now: back to the 10-minute rule.
    await engine.run('authoritative', {})
    expect(recheckAuth).toHaveBeenCalledTimes(2)
    // Live shows the stored re-check, never probing.
    expect((await engine.run('live', {})).ok).toBe(true)
    expect(claude.probeCalls).toHaveLength(1)
  })

  it('a vendor broken beyond its login (missing, too old) is probed again with force', async () => {
    const missing = [check('vendor.claude.bin', 'fail', { category: 'cli_missing', title: 'Not installed' })]
    const claude = fakeAdapter('claude', { probe: probeResult('claude', 0, missing) })
    const recheckAuth = vi.fn(() => Promise.resolve([]))
    const engine = createPreflightEngine(healthyDeps({ adapters: fakeRegistry(claude), recheckAuth }), {
      checks: factory(vendorDef),
    })
    expect((await engine.run('authoritative', {})).ok).toBe(false)
    expect(claude.probeCalls).toEqual([{ force: false }])
    claude.setProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
    // Live keeps the stored probe: nothing spawns.
    expect((await engine.run('live', {})).ok).toBe(false)
    expect(claude.probeCalls).toHaveLength(1)
    // The run's Recheck (authoritative) installs-then-rechecks: a forced probe.
    expect((await engine.run('authoritative', {})).ok).toBe(true)
    expect(claude.probeCalls).toEqual([{ force: false }, { force: true }])
    expect(recheckAuth).not.toHaveBeenCalled()
    // Healthy now: the launch probe is kept.
    await engine.run('authoritative', {})
    expect(claude.probeCalls).toHaveLength(2)
  })
})
