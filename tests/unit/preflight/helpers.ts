// Fakes for preflight tests: a scriptable adapter, probe results and a deps builder.
import { vi } from 'vitest'
import type { CheckResult, CheckStatus } from '@shared/preflight.ts'
import type { ProbeResult, ReadinessNeed, Support } from '@shared/vendors.ts'
import { AdapterRegistry, unsupportedCapabilities } from '@core/adapters/registry.ts'
import type { Adapter, RunHandle } from '@core/adapters/types.ts'
import { failedRunHandle, makeFailure } from '@core/adapters/errors.ts'
import type { PreflightDeps } from '@core/preflight/engine.ts'

export const GB = 1024 * 1024 * 1024

export function check(id: string, status: CheckStatus, extra: Partial<CheckResult> = {}): CheckResult {
  return {
    id,
    scope: id.startsWith('pass.') ? 'pass' : 'vendor',
    status,
    blocking: status === 'fail',
    title: `${id} ${status}`,
    detail: '',
    recovery: [],
    at: 0,
    ttlMs: 3_600_000,
    ...extra,
  }
}

export function probeResult(
  vendor: string,
  at: number,
  checks: CheckResult[],
  planNative = true,
): ProbeResult {
  const caps = unsupportedCapabilities({ status: 'supported', copy: 'ok' })
  caps.planMode = planNative ? 'native' : 'emulated'
  return {
    vendor,
    at,
    ok: !checks.some((c) => c.status === 'fail' && c.blocking),
    version: '2.1.289',
    checks,
    capabilities: caps,
    models: [],
  }
}

export function healthyChecks(vendor: string, at: number): CheckResult[] {
  return ['bin', 'version', 'auth', 'env', 'protocol', 'plan'].map((c) =>
    check(`vendor.${vendor}.${c}`, 'pass', { at }),
  )
}

export interface FakeAdapter extends Adapter {
  probeCalls: { force?: boolean }[]
  readinessCalls: { cwd: string; need: ReadinessNeed }[]
  supportCalls: ReadinessNeed[]
  setProbe(p: ProbeResult): void
}

export function fakeAdapter(
  id: string,
  o: {
    probe?: ProbeResult
    support?: (need: ReadinessNeed) => Support
    readiness?: (cwd: string, need: ReadinessNeed) => CheckResult[] | Promise<CheckResult[]>
  } = {},
): FakeAdapter {
  let probe = o.probe ?? probeResult(id, 0, healthyChecks(id, 0))
  const a: FakeAdapter = {
    id,
    displayName: id === 'claude' ? 'Claude' : id === 'codex' ? 'Codex' : id,
    transport: 'claude-stdio',
    managedFlags: [],
    testedUpTo: '',
    versionFloor: '',
    versionRecommended: '',
    probeCalls: [],
    readinessCalls: [],
    supportCalls: [],
    setProbe(p) {
      probe = p
    },
    probe(po = {}) {
      a.probeCalls.push(po)
      return Promise.resolve(probe)
    },
    readiness(cwd, need) {
      a.readinessCalls.push({ cwd, need })
      return Promise.resolve(o.readiness?.(cwd, need) ?? [check(`pass.${need.pass}.readiness.mode`, 'pass')])
    },
    support(need) {
      a.supportCalls.push(need)
      return o.support?.(need) ?? { status: 'supported', copy: `${need.mode} copy` }
    },
    canResume: () => Promise.resolve({ ok: false, reason: 'cannot-resume' }),
    start(): RunHandle {
      return failedRunHandle({ vendor: id, route: 'stdio', failure: makeFailure('unknown', 'fake') })
    },
    answer: () => {},
    stop: () => Promise.resolve(),
    listModels: () => Promise.resolve([]),
  }
  return a
}

export function fakeRegistry(...adapters: Adapter[]): AdapterRegistry {
  const r = new AdapterRegistry({ stubs: true, now: () => 0 })
  for (const a of adapters) r.register(a)
  return r
}

export interface Clock {
  now: () => number
  advance(ms: number): void
  set(ms: number): void
}

export function clock(start = 1_000_000): Clock {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
    set: (ms) => {
      t = ms
    },
  }
}

/** Deps with every machine fact healthy (git 2.40, plenty of disk, writable home, unguarded folder). */
export function healthyDeps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    adapters: fakeRegistry(fakeAdapter('claude')),
    home: 'C:/dim-factory-home',
    platform: 'win32',
    now: () => 1_000_000,
    gitVersion: vi.fn(() =>
      Promise.resolve({ ok: true as const, version: '2.40.1', raw: 'git version 2.40.1' }),
    ),
    homeWritable: () => Promise.resolve({ ok: true as const }),
    diskFree: () => Promise.resolve(100 * GB),
    isGuarded: (path) => ({ guarded: false, detail: 'ok', path }),
    ...over,
  }
}
