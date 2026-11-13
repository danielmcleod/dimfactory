// Engine mechanics with synthetic defs: DAG order, skip propagation, spawn concurrency, cache + TTL + modes,
// timeouts, crash containment, report shape, and the vendor store (live never spawns a vendor).
import { describe, expect, it, vi } from 'vitest'
import type { CheckResult, CheckStatus, PreflightMode } from '@shared/preflight.ts'
import { AUTH_TTL_MS, PreflightCache } from '@core/preflight/cache.ts'
import {
  assertDag,
  buildReport,
  createPreflightEngine,
  runButtonReasons,
  runPreflight,
} from '@core/preflight/engine.ts'
import type { CheckContext, PreflightCheckDef } from '@core/preflight/engine.ts'
import {
  check,
  clock,
  fakeAdapter,
  fakeRegistry,
  healthyChecks,
  healthyDeps,
  probeResult,
} from './helpers.ts'

interface DefOpts extends Partial<Omit<PreflightCheckDef, 'run'>> {
  status?: CheckStatus
  blocking?: boolean
  delayMs?: number
  log?: string[]
  impl?: (ctx: CheckContext) => Promise<CheckResult | CheckResult[]>
}

function def(id: string, o: DefOpts = {}): PreflightCheckDef & { calls: number } {
  const d = {
    calls: 0,
    id,
    scope: 'app' as const,
    title: id,
    dependsOn: [],
    cost: 'cheap' as const,
    ttlMs: 0,
    modes: ['live', 'authoritative', 'passBoundary'] as PreflightMode[],
    appliesTo: () => true,
    subjectKey: () => 's',
    ...o,
    async run(ctx: CheckContext) {
      d.calls++
      o.log?.push(`start ${id}`)
      if (o.delayMs !== undefined) await new Promise((r) => setTimeout(r, o.delayMs))
      o.log?.push(`end ${id}`)
      if (o.impl) return o.impl(ctx)
      return ctx.result({
        status: o.status ?? 'pass',
        detail: id,
        ...(o.blocking !== undefined ? { blocking: o.blocking } : {}),
      })
    },
  }
  return d
}

const factory =
  (...defs: PreflightCheckDef[]) =>
  () =>
    defs
const ids = (rs: CheckResult[]): string[] => rs.map((r) => r.id)

describe('DAG', () => {
  it('runs dependencies first and reports in def order', async () => {
    const log: string[] = []
    const a = def('a', { dependsOn: ['b'], log })
    const b = def('b', { delayMs: 20, log })
    const report = await runPreflight('authoritative', {}, healthyDeps(), { checks: factory(a, b) })
    expect(log).toEqual(['start b', 'end b', 'start a', 'end a'])
    expect(ids(report.info)).toEqual(['a', 'b'])
    expect(report.ok).toBe(true)
  })

  it('a failed dependency turns dependents (and their dependents) into skip', async () => {
    const root = def('root', { status: 'fail' })
    const mid = def('mid', { dependsOn: ['root'] })
    const leaf = def('leaf', { dependsOn: ['mid'] })
    const free = def('free')
    const report = await runPreflight('live', {}, healthyDeps(), { checks: factory(root, mid, leaf, free) })
    expect(ids(report.blocking)).toEqual(['root'])
    const byId = Object.fromEntries(report.info.map((r) => [r.id, r]))
    expect(byId['mid']?.status).toBe('skip')
    expect(byId['mid']?.detail).toBe('Not checked: root')
    expect(byId['leaf']?.status).toBe('skip')
    expect(byId['free']?.status).toBe('pass')
    expect(mid.calls).toBe(0)
    expect(leaf.calls).toBe(0)
  })

  it('onDependencyFailure "run" still runs; a warning dependency does not skip', async () => {
    const root = def('root', { status: 'fail' })
    const reader = def('reader', { dependsOn: ['root'], onDependencyFailure: 'run' })
    const warned = def('warned', { status: 'warn' })
    const after = def('after', { dependsOn: ['warned'] })
    const report = await runPreflight('live', {}, healthyDeps(), {
      checks: factory(root, reader, warned, after),
    })
    expect(reader.calls).toBe(1)
    expect(after.calls).toBe(1)
    expect(ids(report.warnings)).toEqual(['warned'])
  })

  it('a non-applicable dependency does not skip its dependents; unknown dependency ids are ignored', async () => {
    const na = def('na', { appliesTo: () => false })
    const dep = def('dep', { dependsOn: ['na', 'not-selected'] })
    const report = await runPreflight('live', {}, healthyDeps(), { checks: factory(na, dep) })
    expect(ids(report.info)).toEqual(['dep'])
    expect(na.calls).toBe(0)
  })

  it('rejects cycles and duplicate ids', () => {
    expect(() => assertDag([def('a', { dependsOn: ['b'] }), def('b', { dependsOn: ['a'] })])).toThrow(/cycle/)
    expect(() => assertDag([def('a'), def('a')])).toThrow(/duplicate/)
  })

  it('selects defs by mode', async () => {
    const live = def('live-only', { modes: ['live'] })
    const boundary = def('boundary', { modes: ['passBoundary'] })
    const r = await runPreflight('passBoundary', {}, healthyDeps(), { checks: factory(live, boundary) })
    expect(ids(r.info)).toEqual(['boundary'])
    expect(r.mode).toBe('passBoundary')
  })
})

describe('scheduling', () => {
  it('runs at most 4 spawn-cost checks at once; cheap checks are not limited', async () => {
    let active = 0
    let peak = 0
    const spawnDef = (id: string) =>
      def(id, {
        cost: 'spawn',
        impl: async (ctx) => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 15))
          active--
          return ctx.result({ status: 'pass', detail: '' })
        },
      })
    const spawns = Array.from({ length: 9 }, (_, i) => spawnDef(`s${i}`))
    let cheapActive = 0
    let cheapPeak = 0
    const cheap = Array.from({ length: 6 }, (_, i) =>
      def(`c${i}`, {
        impl: async (ctx) => {
          cheapActive++
          cheapPeak = Math.max(cheapPeak, cheapActive)
          await new Promise((r) => setTimeout(r, 15))
          cheapActive--
          return ctx.result({ status: 'pass', detail: '' })
        },
      }),
    )
    await runPreflight('authoritative', {}, healthyDeps(), { checks: factory(...spawns, ...cheap) })
    expect(peak).toBe(4)
    expect(cheapPeak).toBe(6)
  })

  it('a check over its per-mode budget reports skip and is not cached', async () => {
    const cache = new PreflightCache()
    const slow = def('slow', { delayMs: 200, timeoutMs: { live: 20 }, ttlMs: 60_000 })
    const r = await runPreflight('live', {}, healthyDeps(), { checks: factory(slow), cache })
    expect(r.info[0]).toMatchObject({ id: 'slow', status: 'skip' })
    expect(r.info[0]?.detail).toMatch(/Still checking/)
    expect(cache.size).toBe(0)
  })

  it('a check that throws becomes a non-blocking warn', async () => {
    const boom = def('boom', { impl: () => Promise.reject(new Error('kaput')) })
    const after = def('after', { dependsOn: ['boom'] })
    const r = await runPreflight('authoritative', {}, healthyDeps(), { checks: factory(boom, after) })
    expect(r.ok).toBe(true)
    expect(r.warnings[0]).toMatchObject({ id: 'boom', status: 'warn', category: 'unknown' })
    expect(r.warnings[0]?.detail).toContain('kaput')
    expect(after.calls).toBe(1)
  })
})

describe('cache', () => {
  it('reuses results within the TTL, keyed by (id, subjectKey, inputsHash)', async () => {
    const c = clock()
    const cache = new PreflightCache()
    let subject = 'x'
    let hash = 'h1'
    const d = def('d', { ttlMs: 1000, subjectKey: () => subject, inputsHash: () => hash })
    const deps = healthyDeps({ now: c.now })
    const run = () => runPreflight('live', {}, deps, { checks: factory(d), cache })
    await run()
    await run()
    expect(d.calls).toBe(1)
    c.advance(999)
    await run()
    expect(d.calls).toBe(1)
    c.advance(1)
    await run()
    expect(d.calls).toBe(2)
    subject = 'y'
    await run()
    expect(d.calls).toBe(3)
    hash = 'h2'
    await run()
    expect(d.calls).toBe(4)
  })

  it('authoritativeTtlMs 0 forces a re-run in the authoritative mode only', async () => {
    const cache = new PreflightCache()
    const d = def('folder.x', { ttlMs: 60_000, authoritativeTtlMs: 0 })
    const deps = healthyDeps()
    await runPreflight('live', {}, deps, { checks: factory(d), cache })
    await runPreflight('live', {}, deps, { checks: factory(d), cache })
    expect(d.calls).toBe(1)
    await runPreflight('authoritative', {}, deps, { checks: factory(d), cache })
    expect(d.calls).toBe(2)
  })

  it('failed outcomes are cached with their state, so dependents still skip on a hit', async () => {
    const cache = new PreflightCache()
    const root = def('root', { status: 'fail', ttlMs: 60_000 })
    const dep = def('dep', { dependsOn: ['root'] })
    await runPreflight('live', {}, healthyDeps(), { checks: factory(root, dep), cache })
    const r = await runPreflight('live', {}, healthyDeps(), { checks: factory(root, dep), cache })
    expect(root.calls).toBe(1)
    expect(r.info.find((x) => x.id === 'dep')?.status).toBe('skip')
  })

  it('invalidation: check id (and its parent def), config, vendor', () => {
    const cache = new PreflightCache()
    const put = (id: string) => cache.set(id, 's', '', { results: [], state: 'ok', at: 0 })
    for (const id of ['app.git', 'folder.git', 'run.templates', 'pass.plan.mode', 'vendor.claude']) put(id)
    cache.invalidateCheck('folder.git.lock')
    expect(cache.get('folder.git', 's', '', 1, 10)).toBeUndefined()
    expect(cache.get('app.git', 's', '', 1, 10)).toBeDefined()
    cache.invalidateConfig()
    expect(cache.get('run.templates', 's', '', 1, 10)).toBeUndefined()
    expect(cache.get('pass.plan.mode', 's', '', 1, 10)).toBeUndefined()
    expect(cache.get('app.git', 's', '', 1, 10)).toBeDefined()
    expect(cache.get('vendor.claude', 's', '', 1, 10)).toBeDefined()
    cache.invalidateVendor('claude')
    expect(cache.get('vendor.claude', 's', '', 1, 10)).toBeUndefined()
  })
})

describe('report', () => {
  it('blocking = fail ∧ blocking; warnings = warn or non-blocking fail; info = pass and skip', () => {
    const r = buildReport('live', [
      check('a', 'fail'),
      check('b', 'fail', { blocking: false }),
      check('c', 'warn'),
      check('d', 'pass'),
      check('e', 'skip'),
    ])
    expect(ids(r.blocking)).toEqual(['a'])
    expect(ids(r.warnings)).toEqual(['b', 'c'])
    expect(ids(r.info)).toEqual(['d', 'e'])
    expect(r.ok).toBe(false)
    expect(runButtonReasons(r)).toEqual(['a fail'])
  })

  it('results carry scope, at, ttl and default blocking from the def', async () => {
    const d = def('x', { status: 'fail', ttlMs: 1234, scope: 'run' })
    const r = await runPreflight('live', {}, healthyDeps({ now: () => 42 }), { checks: factory(d) })
    expect(r.blocking[0]).toMatchObject({
      id: 'x',
      scope: 'run',
      blocking: true,
      at: 42,
      ttlMs: 1234,
      recovery: [],
    })
  })
})

describe('vendor store (live never spawns a vendor)', () => {
  const vendorDef = (id = 'vendor.claude') =>
    def(id, {
      scope: 'vendor',
      impl: async (ctx) => {
        const snap =
          ctx.mode === 'authoritative' ? await ctx.vendors.ensure('claude') : ctx.vendors.latest('claude')
        return snap?.checks ?? [ctx.result({ status: 'skip', detail: 'none' })]
      },
    })

  it('live reads only the store and never probes', async () => {
    const claude = fakeAdapter('claude')
    const recheckAuth = vi.fn(() => Promise.resolve([]))
    const deps = healthyDeps({ adapters: fakeRegistry(claude), recheckAuth })
    const engine = createPreflightEngine(deps, { checks: factory(vendorDef()) })
    const empty = await engine.run('live', {})
    expect(empty.info[0]?.status).toBe('skip')
    engine.recordProbe(probeResult('claude', 1, healthyChecks('claude', 1)))
    const filled = await engine.run('live', {})
    expect(ids(filled.info)).toContain('vendor.claude.auth')
    expect(claude.probeCalls).toEqual([])
    expect(recheckAuth).not.toHaveBeenCalled()
  })

  it('ensure() refuses outside the authoritative mode', async () => {
    const d = def('v', { impl: async (ctx) => (await ctx.vendors.ensure('claude')).checks })
    const r = await runPreflight('live', {}, healthyDeps(), { checks: factory(d) })
    expect(r.warnings[0]?.detail).toMatch(/only in the authoritative preflight/)
  })

  it('authoritative probes once when the store is empty, then re-runs only auth after 10 min', async () => {
    const c = clock(10_000)
    const claude = fakeAdapter('claude', {
      probe: probeResult('claude', 10_000, healthyChecks('claude', 10_000)),
    })
    const recheckAuth = vi.fn(() =>
      Promise.resolve([
        check('vendor.claude.auth', 'fail', { category: 'auth_required', title: 'Not logged in' }),
      ]),
    )
    const deps = healthyDeps({ adapters: fakeRegistry(claude), recheckAuth, now: c.now })
    const engine = createPreflightEngine(deps, {
      checks: factory(vendorDef(), vendorDef('vendor.claude.again')),
    })
    const first = await engine.run('authoritative', {})
    expect(claude.probeCalls).toEqual([{ force: false }])
    expect(recheckAuth).not.toHaveBeenCalled()
    expect(first.ok).toBe(true)

    c.advance(AUTH_TTL_MS - 1)
    await engine.run('authoritative', {})
    expect(recheckAuth).not.toHaveBeenCalled()

    c.advance(1)
    const later = await engine.run('authoritative', {})
    expect(recheckAuth).toHaveBeenCalledTimes(1)
    expect(recheckAuth).toHaveBeenCalledWith('claude', { timeoutMs: 2000 })
    expect(claude.probeCalls).toHaveLength(1)
    expect(later.blocking.map((r) => r.id)).toEqual(['vendor.claude.auth', 'vendor.claude.auth'])
    // The re-check is stored: live now shows it too, in probe order.
    const live = await engine.run('live', {})
    expect(live.blocking[0]?.title).toBe('Not logged in')
    expect(engine.cache.vendor('claude')?.checks.map((x) => x.id)).toEqual(
      healthyChecks('claude', 0).map((x) => x.id),
    )
  })

  it('an invalidated vendor is re-probed with force; live keeps showing the last probe meanwhile', async () => {
    const claude = fakeAdapter('claude')
    const deps = healthyDeps({ adapters: fakeRegistry(claude) })
    const engine = createPreflightEngine(deps, { checks: factory(vendorDef()) })
    engine.recordProbe(probeResult('claude', 1, healthyChecks('claude', 1)))
    engine.cache.invalidateVendor('claude')
    expect(engine.cache.vendor('claude')?.stale).toBe(true)
    await engine.run('live', {})
    expect(claude.probeCalls).toEqual([])
    await engine.run('authoritative', {})
    expect(claude.probeCalls).toEqual([{ force: true }])
    expect(engine.cache.vendor('claude')?.stale).toBe(false)
  })

  it('no auth re-check when the binary itself is missing', async () => {
    const c = clock(0)
    const checks = [check('vendor.claude.bin', 'fail', { category: 'cli_missing' })]
    const claude = fakeAdapter('claude', { probe: probeResult('claude', 0, checks) })
    const recheckAuth = vi.fn(() => Promise.resolve([]))
    const deps = healthyDeps({ adapters: fakeRegistry(claude), recheckAuth, now: c.now })
    c.advance(AUTH_TTL_MS * 2)
    const r = await runPreflight('authoritative', {}, deps, { checks: factory(vendorDef()) })
    expect(recheckAuth).not.toHaveBeenCalled()
    expect(r.blocking[0]).toMatchObject({ id: 'vendor.claude.bin', category: 'cli_missing' })
  })
})
