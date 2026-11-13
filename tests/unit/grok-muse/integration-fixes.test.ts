// Integration fixes (Muse runs as exec, no relay, Experimental; Readiness `trust`; the Muse
// protocol check "schema hash vs pinned (warn)"), one test each:
//   1. A pass Muse cannot run (Plan, Review, Critic) gets the mode check alone: no folder grant is offered for it, since
//      trusting the folder would not let it run.
//   2. Muse's protocol warning offers "Update Muse" only when Muse could not print its options or schema; shapes not
//      pinned yet (or a schema that differs from the pin) are Dim Factory's to follow.
//   3. An Experimental vendor (Muse) is never suggested on its own: not as a switch_vendor target, not as the switch
//      a failed mode check offers, not as the Critic swap or Fix's "Fresh, different vendor".
//   4. Grok's unsupported autoedit says why in words only: no reason code beside the copy, so the composer's mode line
//      and the strip never read "(mode-unsupported)".
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MUSE_REQUIRED_EXEC_FLAGS } from '@core/adapters/muse/capabilities.ts'
import { createMuseAdapter } from '@core/adapters/muse/index.ts'
import { museProtocolCheck } from '@core/adapters/muse/probe.ts'
import { MUSE_PIN, schemaHash } from '@core/adapters/muse/protocol.ts'
import { GROK_COPY } from '@core/adapters/grok/config.ts'
import { createGrokAdapter } from '@core/adapters/grok/index.ts'
import { AdapterRegistry } from '@core/adapters/registry.ts'
import { planImplementOverrides, resolveBuiltinConfig } from '@core/config/builtins.ts'
import { composerSuggestions } from '@core/config/suggestions.ts'
import type { ReadyVendorInfo } from '@core/config/suggestions.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import { switchTargetFor } from '@core/recovery/switch-vendor.ts'
import type { VendorReadiness } from '@core/recovery/switch-vendor.ts'
import type { Mode, PassName } from '@shared/run.ts'
import type { SupportStatus } from '@shared/vendors.ts'
import {
  check,
  fakeAdapter,
  fakeRegistry,
  healthyChecks,
  healthyDeps,
  probeResult,
} from '../preflight/helpers.ts'

let root: string
let folder: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-grok-muse-'))
  folder = join(root, 'project')
  home = join(root, 'home')
  mkdirSync(folder, { recursive: true })
  mkdirSync(home, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('1. Muse readiness: no folder grant for a pass Muse cannot run', () => {
  const adapter = () => createMuseAdapter({ env: {}, dimFactoryHome: home, search: 'configured' })

  it.each(['plan', 'review', 'critic'] as const)(
    '%s: the mode check fails with the honest copy, and no trust check offers a grant',
    async (pass) => {
      const checks = await adapter().readiness(folder, {
        pass,
        mode: 'readonly',
        planNative: false,
        trustFolder: false,
      })
      expect(checks.map((c) => c.id)).toEqual([`pass.${pass}.readiness.mode`])
      expect(checks[0]).toMatchObject({ status: 'fail', blocking: true, category: 'capability_missing' })
      expect(checks.flatMap((c) => c.recovery).some((a) => a.kind === 'grant')).toBe(false)
    },
  )

  it('Implement without the grant still fails `trust` with the grant (Readiness)', async () => {
    const checks = await adapter().readiness(folder, {
      pass: 'implement',
      mode: 'autoedit',
      planNative: false,
      trustFolder: false,
    })
    const trust = checks.find((c) => c.id === 'pass.implement.readiness.trust')
    expect(trust).toMatchObject({ status: 'fail', blocking: true, category: 'trust_required' })
    expect(trust?.recovery).toEqual([
      expect.objectContaining({ kind: 'grant', grant: 'vendorFolder', vendor: 'muse' }),
    ])
  })
})

describe('2. Muse protocol warning: "Update Muse" only when an update can help', () => {
  const HELP = {
    text: `Options:\n${MUSE_REQUIRED_EXEC_FLAGS.map((f) => `  ${f}   x`).join('\n')}`,
  }
  const SCHEMA = {
    args: ['schema'],
    text: '{"run.output.delta":1,"run.terminal":1,"task.lifecycle":1,"tool.result":1}',
  }
  const kinds = (c: { recovery: readonly { id: string }[] }): string[] => c.recovery.map((a) => a.id)

  it('shapes not pinned yet: a warning that names it, with no update action', () => {
    const c = museProtocolCheck(HELP, SCHEMA, MUSE_PIN, 1)
    expect(c).toMatchObject({ status: 'warn', title: "Muse's event shapes are not pinned yet" })
    expect(c.recovery).toEqual([])
  })

  it('a schema that differs from the pin: the detail says to update Dim Factory, no "Update Muse"', () => {
    const c = museProtocolCheck(HELP, SCHEMA, { ...MUSE_PIN, liveSchemaSha256: 'f'.repeat(64) }, 1)
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('update Dim Factory')
    expect(c.recovery).toEqual([])
  })

  it('options or schema not printed: the update command is offered', () => {
    const pinned = { ...MUSE_PIN, liveSchemaSha256: schemaHash(SCHEMA.text) }
    expect(kinds(museProtocolCheck({ error: 'ENOENT' }, SCHEMA, pinned, 1))).toEqual(['muse.update'])
    expect(kinds(museProtocolCheck(HELP, { error: 'timed out' }, pinned, 1))).toEqual(['muse.update'])
  })
})

describe('3. an Experimental vendor is never suggested', () => {
  it('the registry says which vendors are Experimental (Muse)', () => {
    const r = new AdapterRegistry({ stubs: true, now: () => 0 })
    expect(r.isExperimental('muse')).toBe(true)
    expect(r.isExperimental('grok')).toBe(false)
    expect(r.isExperimental('claude')).toBe(false)
  })

  it('switch_vendor: Muse ready and every other vendor not ready → never Muse', () => {
    const vendors: VendorReadiness = {
      vendors: () => [
        { id: 'claude', displayName: 'Claude', built: true },
        { id: 'codex', displayName: 'Codex', built: true },
        { id: 'grok', displayName: 'Grok', built: true },
        { id: 'muse', displayName: 'Muse', built: true, experimental: true },
      ],
      readyFor: (v) => (v === 'muse' ? { ok: true } : { ok: false, reason: `${v} is not ready.` }),
    }
    const t = switchTargetFor('claude', 'implement', 'autoedit', vendors)
    expect(t).toMatchObject({ to: 'codex', disabledReason: 'codex is not ready.' })
    // Only Muse besides the failing vendor: no switch at all.
    const onlyMuse: VendorReadiness = {
      vendors: () => [
        { id: 'claude', displayName: 'Claude', built: true },
        { id: 'muse', displayName: 'Muse', built: true, experimental: true },
      ],
      readyFor: () => ({ ok: true }),
    }
    expect(switchTargetFor('claude', 'implement', 'autoedit', onlyMuse)).toBeNull()
  })

  it("composer suggestions: Muse is never the Critic swap or Fix's other vendor", () => {
    const tpl = { name: 'x', path: 'builtin/x.md', layer: 'builtin' as const, sha256: '0'.repeat(64) }
    const pass = (vendor: string, mode: Mode) => ({
      vendor,
      model: null,
      effort: null,
      mode,
      enabled: true,
      promptTemplate: tpl,
      extensions: mode === 'readonly' ? ('none' as const) : ('passthrough' as const),
    })
    const cfg = {
      passes: {
        plan: {
          ...pass('claude', 'readonly'),
          clarify: false,
          clarifyQuestions: 4,
          clarifyInAuto: false,
          clarifyPlain: false,
          research: false,
          researchLenses: [],
          explain: false,
          explainPlain: false,
        },
        implement: { ...pass('claude', 'autoedit'), deploy: false, deployTarget: null },
        review: { ...pass('claude', 'readonly'), acceptance: false },
        critic: pass('claude', 'readonly'),
        security: { ...pass('claude', 'readonly'), enabled: false, recheck: true },
        fix: {
          ...pass('claude', 'autoedit'),
          inherit: 'implement' as const,
          reuseSession: true,
          rounds: 1,
          recheck: true,
          maxCostUsd: null,
          maxMinutes: null,
        },
      },
    }
    const ready = (id: string, experimental = false): ReadyVendorInfo => ({
      id,
      // Supports everything: only the Experimental flag can keep it out.
      support: (_p: PassName, _m: Mode): SupportStatus => 'supported',
      ...(experimental ? { experimental: true } : {}),
    })
    const s = composerSuggestions(cfg, [ready('claude'), ready('muse', true)])
    expect(s.criticSwap).toBeNull()
    expect(s.otherFixVendor).toBeNull()
    // A non-Experimental vendor is still suggested.
    const g = composerSuggestions(cfg, [ready('claude'), ready('grok'), ready('muse', true)])
    expect(g.criticSwap).toEqual({ to: 'grok' })
    expect(g.otherFixVendor).toBe('grok')
  })

  it("preflight: a failed mode check's switch never names Muse, even when only Muse is ready", async () => {
    const claude = fakeAdapter('claude', {
      support: (need) =>
        need.mode === 'autoedit'
          ? { status: 'unsupported', copy: 'no edits here' }
          : { status: 'supported', copy: 'ok' },
    })
    const muse = fakeAdapter('muse')
    const engine = createPreflightEngine(
      healthyDeps({ home, adapters: fakeRegistry(claude, fakeAdapter('codex'), muse) }),
    )
    engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
    engine.recordProbe(
      probeResult('codex', 1_000_000, [check('vendor.codex.auth', 'fail', { category: 'auth_required' })]),
    )
    engine.recordProbe(probeResult('muse', 1_000_000, healthyChecks('muse', 1_000_000)))
    const r = await engine.run('live', {
      folder,
      config: resolveBuiltinConfig({ profile: 'claude-only', overrides: planImplementOverrides() }),
    })
    const mode = [...r.blocking, ...r.warnings, ...r.info].find((c) => c.id === 'pass.implement.mode')
    expect(mode?.status).toBe('fail')
    const sw = mode?.recovery.find((a) => a.kind === 'switch_vendor')
    expect(sw).toMatchObject({ kind: 'switch_vendor', to: 'codex' })
  })
})

describe("4. Grok's unsupported autoedit: the copy, never a reason code", () => {
  it('support() carries no reason, and pass.implement.mode says the copy alone', async () => {
    const grok = createGrokAdapter({ env: {}, dimFactoryHome: home, search: 'configured' })
    const need = { pass: 'implement', mode: 'autoedit', planNative: false, trustFolder: false } as const
    const s = grok.support(need)
    expect(s).toEqual({ status: 'unsupported', copy: GROK_COPY.autoedit })
    const engine = createPreflightEngine(
      healthyDeps({ home, adapters: fakeRegistry(fakeAdapter('claude'), grok) }),
    )
    engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
    engine.recordProbe(probeResult('grok', 1_000_000, healthyChecks('grok', 1_000_000), false))
    const cfg = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: { ...planImplementOverrides(), passes: { implement: { vendor: 'grok', model: null } } },
    })
    const r = await engine.run('live', { folder, config: cfg })
    const mode = [...r.blocking, ...r.warnings, ...r.info].find((c) => c.id === 'pass.implement.mode')
    expect(mode).toMatchObject({
      status: 'fail',
      title: 'Grok cannot run Implement in autoedit mode',
      detail: GROK_COPY.autoedit,
    })
    expect(mode?.detail).not.toContain('(')
  })
})
