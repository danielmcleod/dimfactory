import { describe, expect, it } from 'vitest'
import {
  AdapterRegistry,
  NOT_BUILT_COPY,
  adapterRegistry,
  createStubAdapter,
  getAdapter,
  unsupportedCapabilities,
} from '@core/adapters/registry.ts'
import type { Adapter, NormalizedEvent, ReadinessNeed } from '@core/adapters/types.ts'
import { KNOWN_VENDORS } from '@shared/vendors.ts'

const need: ReadinessNeed = { pass: 'review', mode: 'readonly', planNative: false, trustFolder: false }

function fakeAdapter(id: string, managedFlags: string[] = []): Adapter {
  const stub = createStubAdapter('claude')
  return { ...stub, id, displayName: id.toUpperCase(), managedFlags }
}

describe('registry stubs', () => {
  it('has a stub for every known vendor, in picker order', () => {
    const r = new AdapterRegistry()
    expect(r.list().map((e) => e.id)).toEqual([...KNOWN_VENDORS])
    expect(r.primary().map((e) => e.id)).toEqual(['claude', 'codex'])
    expect(r.more().map((e) => e.id)).toEqual(['gemini', 'grok', 'muse'])
    for (const e of r.list()) expect(e.built).toBe(false)
    expect(r.list().find((e) => e.id === 'muse')!.experimental).toBe(true)
    expect(r.list().find((e) => e.id === 'gemini')!.experimental).toBe(false)
  })

  it.each([...KNOWN_VENDORS])(
    '%s stub: unsupported support() and a blocking capability_missing probe',
    async (v) => {
      const stub = new AdapterRegistry().get(v)!
      expect(stub.support(need)).toEqual({ status: 'unsupported', copy: NOT_BUILT_COPY, reason: 'not-built' })
      const p = await stub.probe()
      expect(p.vendor).toBe(v)
      expect(p.ok).toBe(false)
      expect(p.models).toEqual([])
      expect(Object.values(p.capabilities.modes).every((m) => m.status === 'unsupported')).toBe(true)
      expect(p.checks).toHaveLength(1)
      const c = p.checks[0]!
      expect(c).toMatchObject({
        id: `vendor.${v}.protocol`,
        scope: 'vendor',
        status: 'fail',
        blocking: true,
        category: 'capability_missing',
      })
      expect(c.recovery[0]).toMatchObject({
        kind: 'switch_vendor',
        to: v === 'claude' ? 'codex' : 'claude',
        pass: 'all',
      })
      const ready = await stub.readiness('/tmp', need)
      expect(ready[0]).toMatchObject({ id: 'pass.review.readiness.mode', status: 'fail', blocking: true })
      expect(await stub.canResume('id', '/tmp')).toEqual({ ok: false, reason: 'cannot-resume' })
      expect(await stub.listModels()).toEqual([])
    },
  )

  it('stub start() yields one fatal capability_missing error and exits', async () => {
    const h = createStubAdapter('grok').start({
      runId: 'r',
      step: 'review',
      cwd: '/tmp',
      prompt: 'x',
      mode: 'readonly',
      planNative: false,
      allowRules: [],
      trustFolder: false,
      askTimeoutMs: 1000,
    })
    const events: NormalizedEvent[] = []
    h.onEvent((e) => events.push(e))
    const exit = await h.exited
    await Promise.resolve()
    expect(events).toEqual([
      {
        type: 'error',
        fatal: true,
        category: 'capability_missing',
        message: expect.stringContaining('Grok') as string,
        raw: '',
      },
    ])
    expect(exit.sawTerminal).toBe(true)
    expect(h.route).toBe('acp')
    expect(h.pendingAsks()).toEqual([])
  })

  it('unsupportedCapabilities marks every mode with the given support', () => {
    const caps = unsupportedCapabilities()
    expect(Object.keys(caps.modes).sort()).toEqual(['autoedit', 'full', 'readonly'])
    expect(caps.askRelay).toBe(false)
  })
})

describe('registration', () => {
  it('a built adapter replaces its stub and keeps its slot', () => {
    const r = new AdapterRegistry()
    const claude = fakeAdapter('claude', ['--model'])
    r.register(claude)
    expect(r.get('claude')).toBe(claude)
    expect(r.isBuilt('claude')).toBe(true)
    expect(r.isBuilt('codex')).toBe(false)
    expect(r.list()[0]!.id).toBe('claude')
    expect(r.managedFlags()['claude']).toEqual(['--model'])
    r.unregister('claude')
    expect(r.isBuilt('claude')).toBe(false)
    expect(r.get('claude')!.support(need).copy).toBe(NOT_BUILT_COPY)
  })

  it('unknown vendors go under More after the known ones, alphabetically', () => {
    const r = new AdapterRegistry()
    r.register(fakeAdapter('opencode'))
    r.register(fakeAdapter('cursor'), { experimental: true })
    expect(r.more().map((e) => e.id)).toEqual(['gemini', 'grok', 'muse', 'cursor', 'opencode'])
    expect(r.list().find((e) => e.id === 'cursor')!.experimental).toBe(true)
    r.unregister('cursor')
    expect(r.has('cursor')).toBe(false)
  })

  it('local-<preset> resolves to the Codex adapter', () => {
    const r = new AdapterRegistry()
    const codex = fakeAdapter('codex')
    r.register(codex)
    expect(r.get('local-ollama')).toBe(codex)
    expect(r.isBuilt('local-ollama')).toBe(true)
    expect(r.resolveId('local-')).toBe('local-')
  })

  it('can start empty', () => {
    expect(new AdapterRegistry({ stubs: false }).list()).toEqual([])
  })

  it('exposes a process-wide registry', () => {
    expect(getAdapter('gemini')).toBe(adapterRegistry.get('gemini'))
  })
})
