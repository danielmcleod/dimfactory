// The launch probe on every start (src/main/launch-probes.ts; boot "background probes", the
// launch probe): after first launch, main probes each built vendor `vendors.list` shows without a probe, and only
// those; failures are logged, never thrown.
import { describe, expect, it, vi } from 'vitest'
import { probeUnprobedVendors } from '../../../src/main/launch-probes.ts'
import type { ProbeInvoke } from '../../../src/main/launch-probes.ts'
import type { Cmd } from '../../../src/shared/ipc.ts'
import type { ProbeResult, ProbeView } from '../../../src/shared/vendors.ts'

const probed = { vendor: 'x', at: 1, ok: true, checks: [], models: [] } as unknown as ProbeResult

function view(vendor: string, built: boolean, probe: ProbeResult | null): ProbeView {
  return {
    vendor,
    displayName: vendor,
    built,
    experimental: false,
    health: built ? (probe === null ? 'checking' : 'ready') : 'not-built',
    healthDetail: '',
    checking: false,
    versionFloor: null,
    versionRecommended: null,
    testedUpTo: null,
    probe,
    candidates: [],
  }
}

function fakeCore(views: ProbeView[], o: { failProbe?: string; failList?: boolean } = {}) {
  const calls: [Cmd, unknown][] = []
  const invoke: ProbeInvoke = (cmd, req) => {
    calls.push([cmd, req])
    if (cmd === 'vendors.list')
      return Promise.resolve(
        o.failList === true
          ? { ok: false, error: { code: 'INTERNAL', message: 'boom' } }
          : { ok: true, value: views },
      )
    const vendor = (req as { vendor: string }).vendor
    return Promise.resolve(
      vendor === o.failProbe
        ? { ok: false, error: { code: 'INTERNAL', message: 'spawn failed' } }
        : { ok: true, value: [] },
    )
  }
  return { calls, invoke }
}

describe('probeUnprobedVendors', () => {
  it('probes built vendors without a probe, and nothing else', async () => {
    const core = fakeCore([
      view('claude', true, null),
      view('codex', false, null),
      view('gemini', true, probed),
      view('grok', true, null),
    ])
    expect(await probeUnprobedVendors(core.invoke)).toEqual(['claude', 'grok'])
    expect(core.calls).toEqual([
      ['vendors.list', undefined],
      ['vendors.probe', { vendor: 'claude' }],
      ['vendors.probe', { vendor: 'grok' }],
    ])
  })

  it('does nothing when every built vendor has a probe (first launch did it)', async () => {
    const core = fakeCore([view('claude', true, probed), view('codex', false, null)])
    expect(await probeUnprobedVendors(core.invoke)).toEqual([])
    expect(core.calls.map((c) => c[0])).toEqual(['vendors.list'])
  })

  it('logs a failed probe or listing instead of throwing', async () => {
    const warn = vi.fn()
    const failing = fakeCore([view('claude', true, null)], { failProbe: 'claude' })
    await expect(probeUnprobedVendors(failing.invoke, { warn })).resolves.toEqual(['claude'])
    expect(warn).toHaveBeenCalledWith('launch probe failed', {
      vendor: 'claude',
      code: 'INTERNAL',
      message: 'spawn failed',
    })
    const noList = fakeCore([], { failList: true })
    await expect(probeUnprobedVendors(noList.invoke, { warn })).resolves.toEqual([])
    expect(warn).toHaveBeenCalledWith('launch probe: vendors.list failed', { code: 'INTERNAL' })
  })
})
