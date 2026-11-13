// Review fix (`pass.fix.resume`, sessions, the Fix row): the check and the composer's fixSession
// suggestion read the Fix vendor alike (sessions.ts previewOptions): it counts only when it is ready — built and
// probed with no blocking failure, as ConfigService.readyVendors says — and only then do its capabilities. A stub's
// static `resume:'none'` or a probe with a failing login changes nothing. The check runs after the Fix vendor's own
// check, so in the authoritative preflight it reads the probe that check has just stored.
import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { Capabilities, ProbeResult } from '@shared/vendors.ts'
import { stubProbeResult } from '@core/adapters/registry.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { composerSuggestions } from '@core/config/suggestions.ts'
import type { ReadyVendorInfo } from '@core/config/suggestions.ts'
import { passCheckDefs } from '@core/preflight/checks/pass.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import { FRESH_REASON_TEXT, previewOptions } from '@core/supervisor/sessions.ts'
import {
  check,
  fakeAdapter,
  fakeRegistry,
  healthyChecks,
  healthyDeps,
  probeResult,
} from '../preflight/helpers.ts'

type Caps = Pick<Capabilities, 'resume' | 'resumeModelSwitch'>

/** How a vendor stands in the probe store. `stub`: not in this build (codex), its static probe stored. */
type VendorState = 'unprobed' | 'ready' | 'auth-failed' | 'stub'

const AT = 1_000_000

function config(profile: 'claude-only' | 'codex-only', fix: Record<string, unknown> = {}): ResolvedConfig {
  return resolveBuiltinConfig({ profile, overrides: { passes: { fix } } })
}

function probeFor(id: string, state: VendorState, caps: Caps): ProbeResult | undefined {
  if (state === 'unprobed') return undefined
  if (state === 'stub') return stubProbeResult('codex', AT)
  const checks =
    state === 'ready'
      ? healthyChecks(id, AT)
      : healthyChecks(id, AT).map((c) =>
          c.id === `vendor.${id}.auth` ? check(c.id, 'fail', { at: AT, category: 'auth_required' }) : c,
        )
  const p = probeResult(id, AT, checks)
  p.capabilities = { ...p.capabilities, ...caps }
  return p
}

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]

/**
 * The check (live preflight) and config.resolve's suggestion for one world. `ready` is built the way
 * ConfigService.readyVendors builds it: built adapters whose effective probe is ok, with their resume capabilities.
 */
async function world(
  cfg: ResolvedConfig,
  states: { claude: Exclude<VendorState, 'stub'>; codex: VendorState },
  caps: Caps,
): Promise<{
  check: CheckResult | undefined
  suggestion: ReturnType<typeof composerSuggestions>['fixSession']
}> {
  const adapters = fakeRegistry(
    fakeAdapter('claude'),
    ...(states.codex === 'stub' ? [] : [fakeAdapter('codex')]),
  )
  const engine = createPreflightEngine(healthyDeps({ adapters }))
  for (const id of ['claude', 'codex'] as const) {
    const p = probeFor(id, states[id], caps)
    if (p !== undefined) engine.recordProbe(p)
  }
  const report = await engine.run('live', { config: cfg })
  const ready: ReadyVendorInfo[] = adapters
    .list()
    .filter((e) => e.built && engine.cache.effectiveProbe(e.id)?.ok === true)
    .map((e) => {
      const c = engine.cache.effectiveProbe(e.id)?.capabilities
      return {
        id: e.id,
        support: () => 'supported' as const,
        ...(c !== undefined
          ? { capabilities: { resume: c.resume, resumeModelSwitch: c.resumeModelSwitch } }
          : {}),
      }
    })
  return {
    check: all(report).find((c) => c.id === 'pass.fix.resume'),
    suggestion: composerSuggestions(cfg, ready).fixSession,
  }
}

const words = (s: { reason?: keyof typeof FRESH_REASON_TEXT }): string =>
  s.reason === undefined
    ? "Fix will continue Implement's session"
    : `Fix will start fresh: ${FRESH_REASON_TEXT[s.reason]}`

const NO_RESUME: Caps = { resume: 'none', resumeModelSwitch: false }

describe('a Fix vendor that is probed but not ready', () => {
  it.each(['codex-only', 'claude-only'] as const)(
    '%s with the Codex stub probed (resume none): the check and the composer both say Reuse',
    async (profile) => {
      const cfg = config(profile, profile === 'claude-only' ? { vendor: 'codex', model: null } : {})
      const { check: c, suggestion } = await world(cfg, { claude: 'ready', codex: 'stub' }, NO_RESUME)
      expect(c?.title).toBe(words(suggestion))
      if (profile === 'codex-only') {
        // Implement and Fix both on the stub: no capability counts, so the static rules say Reuse.
        expect(suggestion).toEqual({ choice: 'reuse' })
        expect(c?.title).toBe("Fix will continue Implement's session")
      }
    },
  )

  it('a built vendor whose login fails: its capabilities do not count, in the check or the composer', async () => {
    const cfg = config('claude-only')
    const failed = await world(cfg, { claude: 'auth-failed', codex: 'unprobed' }, NO_RESUME)
    expect(failed.suggestion).toEqual({ choice: 'reuse' })
    expect(failed.check?.title).toBe("Fix will continue Implement's session")
    // The same vendor, ready: now its resume 'none' decides it, on both sides.
    const ready = await world(cfg, { claude: 'ready', codex: 'unprobed' }, NO_RESUME)
    expect(ready.suggestion).toEqual({ choice: 'fresh', reason: 'cannot-resume' })
    expect(ready.check?.title).toBe('Fix will start fresh: the session cannot be resumed')
  })

  it('agree over profiles × Fix vendor × reuseSession × model × capabilities × every vendor state', async () => {
    const capsList: Caps[] = [
      { resume: 'id', resumeModelSwitch: true },
      { resume: 'id', resumeModelSwitch: false },
      NO_RESUME,
    ]
    const claudeStates = ['unprobed', 'ready', 'auth-failed'] as const
    const codexStates = ['unprobed', 'ready', 'auth-failed', 'stub'] as const
    let n = 0
    for (const profile of ['claude-only', 'codex-only'] as const)
      for (const vendor of ['claude', 'codex'] as const)
        for (const reuseSession of [true, false])
          for (const model of [null, 'opus'])
            for (const caps of capsList)
              for (const claude of claudeStates)
                for (const codex of codexStates) {
                  const cfg = config(profile, { vendor, model, reuseSession })
                  const w = await world(cfg, { claude, codex }, caps)
                  const ctx = JSON.stringify({ profile, vendor, reuseSession, model, caps, claude, codex })
                  expect(w.check?.title, ctx).toBe(words(w.suggestion))
                  n++
                }
    expect(n).toBe(2 * 2 * 2 * 2 * 3 * 3 * 4)
  }, 120_000)
})

describe('previewOptions', () => {
  it('is the one rule: unprobed or not ready → no capabilities and no other-vendor fresh; ready → its capabilities', () => {
    expect(previewOptions(undefined)).toEqual({ otherVendorReady: false })
    expect(previewOptions({ ready: false, capabilities: NO_RESUME })).toEqual({ otherVendorReady: false })
    expect(previewOptions({ ready: true })).toEqual({ otherVendorReady: true })
    expect(previewOptions({ ready: true, capabilities: NO_RESUME })).toEqual({
      otherVendorReady: true,
      capabilities: NO_RESUME,
    })
  })
})

describe('the check waits for the Fix vendor’s own check', () => {
  it('depends on that vendor’s def, and runs when it fails', () => {
    for (const [profile, fixVendor] of [
      ['claude-only', 'claude'],
      ['codex-only', 'codex'],
    ] as const) {
      const def = passCheckDefs({ config: config(profile) }).find((d) => d.id === 'pass.fix.resume')
      expect(def?.dependsOn).toEqual([`vendor.${fixVendor}`])
      expect(def?.onDependencyFailure).toBe('run')
    }
    const other = passCheckDefs({ config: config('claude-only', { vendor: 'codex', model: null }) }).find(
      (d) => d.id === 'pass.fix.resume',
    )
    expect(other?.dependsOn).toEqual(['vendor.codex'])
  })

  it('authoritative, nothing probed yet: it reads the probe the vendor check stores (resume none → fresh)', async () => {
    const claude = fakeAdapter('claude')
    const p = probeResult('claude', AT, healthyChecks('claude', AT))
    p.capabilities = { ...p.capabilities, ...NO_RESUME }
    claude.setProbe(p)
    const engine = createPreflightEngine(healthyDeps({ adapters: fakeRegistry(claude) }))
    const report = await engine.run('authoritative', { config: config('claude-only') })
    expect(claude.probeCalls.length).toBeGreaterThan(0)
    expect(all(report).find((c) => c.id === 'pass.fix.resume')).toMatchObject({
      status: 'pass',
      title: 'Fix will start fresh: the session cannot be resumed',
      detail: 'Claude cannot continue a session, so Fix starts a new one.',
    })
  })

  it('authoritative with the Codex stub as Fix vendor: the stub’s failing check does not stop it, and Reuse stands', async () => {
    const engine = createPreflightEngine(healthyDeps({ adapters: fakeRegistry(fakeAdapter('claude')) }))
    const report = await engine.run('authoritative', { config: config('codex-only') })
    expect(report.blocking.some((c) => c.id.startsWith('vendor.codex.'))).toBe(true)
    expect(all(report).find((c) => c.id === 'pass.fix.resume')).toMatchObject({
      status: 'pass',
      title: "Fix will continue Implement's session",
    })
  })
})
