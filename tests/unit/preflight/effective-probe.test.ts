// The vendor's probe as it stands (src/core/preflight/cache.ts `effectiveProbe`; auth re-check,
// Dashboard vendor health): when the authoritative preflight re-checks a failed login and it passes, the
// vendor views (vendors.list, dashboard.get, the `probe` push) read the re-check, not the launch probe's failure;
// the probe listeners hear it once, when the auth result changes.
import { describe, expect, it } from 'vitest'
import type { ProbeResult } from '@shared/vendors.ts'
import { PreflightCache } from '@core/preflight/cache.ts'
import { check, healthyChecks, probeResult } from './helpers.ts'

const loggedOut = (at: number): ProbeResult =>
  probeResult('claude', at, [
    ...healthyChecks('claude', at).filter((c) => c.id !== 'vendor.claude.auth'),
    check('vendor.claude.auth', 'fail', { at, category: 'auth_required' }),
  ])

describe('PreflightCache.effectiveProbe', () => {
  it('is the launch probe until an auth re-check, then the probe with the re-check swapped in', () => {
    const c = new PreflightCache()
    expect(c.effectiveProbe('claude')).toBeUndefined()
    const probe = loggedOut(100)
    c.setProbe(probe)
    expect(c.effectiveProbe('claude')).toBe(probe)
    expect(probe.ok).toBe(false)

    c.setAuth('claude', [check('vendor.claude.auth', 'pass', { at: 500 })], 500)
    const now = c.effectiveProbe('claude')
    expect(now?.ok).toBe(true)
    expect(now?.at).toBe(500)
    expect(now?.checks.find((x) => x.id === 'vendor.claude.auth')?.status).toBe('pass')
    // Same checks, same order as the probe's; the stored launch probe is untouched.
    expect(now?.checks.map((x) => x.id)).toEqual(probe.checks.map((x) => x.id))
    expect(c.probe('claude')).toBe(probe)
    expect(c.probe('claude')?.ok).toBe(false)
  })

  it('a re-check that fails keeps the vendor not ok; a new probe drops the re-check', () => {
    const c = new PreflightCache()
    c.setProbe(probeResult('claude', 100, healthyChecks('claude', 100)))
    c.setAuth('claude', [check('vendor.claude.auth', 'fail', { at: 200 })], 200)
    expect(c.effectiveProbe('claude')?.ok).toBe(false)
    const fresh = probeResult('claude', 300, healthyChecks('claude', 300))
    c.setProbe(fresh)
    expect(c.effectiveProbe('claude')).toBe(fresh)
  })

  it('the probe listeners hear the effective probe when a re-check changes the auth result, once', () => {
    const c = new PreflightCache()
    const heard: ProbeResult[] = []
    c.onProbe((p) => heard.push(p))
    c.setProbe(loggedOut(100))
    expect(heard.map((p) => p.ok)).toEqual([false])
    c.setAuth('claude', [check('vendor.claude.auth', 'pass', { at: 500 })], 500)
    expect(heard.map((p) => p.ok)).toEqual([false, true])
    expect(heard[1]?.checks.find((x) => x.id === 'vendor.claude.auth')?.status).toBe('pass')
    // The 10-minute re-check that finds the same state says nothing new.
    c.setAuth('claude', [check('vendor.claude.auth', 'pass', { at: 900 })], 900)
    expect(heard).toHaveLength(2)
    // Logged out again: heard.
    c.setAuth('claude', [check('vendor.claude.auth', 'fail', { at: 990 })], 990)
    expect(heard.map((p) => p.ok)).toEqual([false, true, false])
  })
})
