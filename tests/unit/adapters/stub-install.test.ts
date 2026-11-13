// A vendor not in this build offers its install command (src/core/adapters/registry.ts stubs, src/core/handlers.ts
// probeView; the first-run script's "Claude ready · Codex not installed [copy]", first-launch.spec.ts "Codex greyed with
// install tooltip", the install commands table): the stub's probe check carries a `<v>.install` shell_copy after its switch_vendor
// action (vendors with an install command only), its pass readiness check does not, and a not-built vendor's view
// carries the stub's probe without anything being probed (one result per vendor, so repeated views are equal).
import { describe, expect, it } from 'vitest'
import { AdapterRegistry, createStubAdapter, stubProbeResult } from '@core/adapters/registry.ts'
import { commandFor, osFamily } from '@core/heal/commands.ts'
import { probeView } from '@core/handlers.ts'
import type { KnownVendor } from '@shared/vendors.ts'

const STUBS: readonly KnownVendor[] = ['codex', 'gemini', 'grok', 'muse']

describe('stub install action', () => {
  it.each(STUBS)('%s: the probe check offers the install command when there is one', async (v) => {
    const stub = createStubAdapter(v, () => 42)
    const p = await stub.probe()
    expect(p).toEqual(stubProbeResult(v, 42))
    const recovery = p.checks[0]?.recovery ?? []
    expect(recovery[0]?.kind).toBe('switch_vendor')
    const install = commandFor('install', v, osFamily())
    if (install === null) {
      expect(recovery).toHaveLength(1)
      return
    }
    expect(recovery[1]).toEqual({
      id: `${v}.install`,
      label: 'Copy the install command',
      kind: 'shell_copy',
      command: install.command,
      shell: install.shell,
      reason: expect.stringMatching(/^Install it now to use it once Dim Factory supports /) as unknown,
      recheck: `vendor.${v}.bin`,
    })
    // A pass using the vendor is told to switch, not to install.
    const ready = await stub.readiness('/tmp', {
      pass: 'review',
      mode: 'readonly',
      planNative: false,
      trustFolder: false,
    })
    expect(ready[0]?.recovery.map((a) => a.kind)).toEqual(['switch_vendor'])
  })

  it('Codex, Gemini and (their official installers) Grok and Muse have one', () => {
    const ids = (v: KnownVendor) => stubProbeResult(v, 0).checks[0]?.recovery.map((a) => a.id)
    expect(ids('codex')).toEqual(['codex.switch-vendor', 'codex.install'])
    expect(ids('gemini')).toEqual(['gemini.switch-vendor', 'gemini.install'])
    expect(ids('grok')).toEqual(['grok.switch-vendor', 'grok.install'])
    expect(ids('muse')).toEqual(['muse.switch-vendor', 'muse.install'])
  })
})

describe("a not-built vendor's view", () => {
  it("carries the stub's probe without probing, the same one every time", () => {
    const registry = new AdapterRegistry()
    const a = probeView(registry, 'codex', null)
    const b = probeView(registry, 'codex', null)
    expect(a).toMatchObject({ vendor: 'codex', built: false, health: 'not-built' })
    expect(a.probe?.checks.map((c) => c.id)).toEqual(['vendor.codex.protocol'])
    expect(a.probe?.checks[0]?.recovery.some((r) => r.id === 'codex.install')).toBe(true)
    expect(b).toEqual(a)
  })

  it('keeps a recorded probe of the stub, and has none for an unknown vendor', () => {
    const registry = new AdapterRegistry()
    const recorded = stubProbeResult('codex', 7)
    expect(probeView(registry, 'codex', recorded).probe).toBe(recorded)
    registry.register({ ...createStubAdapter('codex'), id: 'acme' })
    registry.unregister('acme')
    expect(probeView(registry, 'acme', null)).toMatchObject({ built: false, probe: null })
  })
})
