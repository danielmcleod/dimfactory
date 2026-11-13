// Fallback on a rate limit: which vendor a pass moves to (factory/fallback.ts fallbackTarget).
import { describe, expect, it } from 'vitest'
import { fallbackTarget } from '@core/factory/fallback.ts'
import type { VendorChoice, VendorReadiness } from '@core/recovery/switch-vendor.ts'

function vendors(list: VendorChoice[], ready: string[]): VendorReadiness {
  return {
    vendors: () => list,
    readyFor: (v) => (ready.includes(v) ? { ok: true } : { ok: false, reason: `${v} is not ready.` }),
  }
}

const ALL: VendorChoice[] = [
  { id: 'claude', displayName: 'Claude', built: true },
  { id: 'codex', displayName: 'Codex', built: true },
  { id: 'gemini', displayName: 'Gemini', built: true },
  { id: 'grok', displayName: 'Grok', built: false },
  { id: 'muse', displayName: 'Muse', built: true, experimental: true },
]

const base = { current: 'claude', pass: 'implement' as const, mode: 'autoedit' as const }

describe('fallbackTarget', () => {
  it('takes the preferred vendors in order, skipping the current one and those not ready', () => {
    const v = vendors(ALL, ['claude', 'codex', 'gemini'])
    expect(fallbackTarget({ ...base, preferred: ['gemini', 'codex'], vendors: v })).toEqual({
      id: 'gemini',
      displayName: 'Gemini',
    })
    expect(fallbackTarget({ ...base, preferred: ['claude', 'codex'], vendors: v })).toEqual({
      id: 'codex',
      displayName: 'Codex',
    })
    expect(
      fallbackTarget({ ...base, preferred: ['gemini', 'codex'], vendors: vendors(ALL, ['codex']) }),
    ).toEqual({ id: 'codex', displayName: 'Codex' })
  })

  it('never an unbuilt, experimental or unknown vendor', () => {
    const v = vendors(ALL, ['grok', 'muse', 'nobody'])
    expect(fallbackTarget({ ...base, preferred: ['grok', 'muse', 'nobody'], vendors: v })).toBeUndefined()
  })

  it('no preference: the usual order (Claude, then Codex), else nothing when none is ready', () => {
    expect(
      fallbackTarget({
        ...base,
        current: 'gemini',
        preferred: [],
        vendors: vendors(ALL, ['claude', 'codex']),
      }),
    ).toEqual({
      id: 'claude',
      displayName: 'Claude',
    })
    expect(fallbackTarget({ ...base, preferred: [], vendors: vendors(ALL, ['gemini']) })).toEqual({
      id: 'gemini',
      displayName: 'Gemini',
    })
    // Only a disabled switch target (none ready): no fallback.
    expect(fallbackTarget({ ...base, preferred: [], vendors: vendors(ALL, []) })).toBeUndefined()
  })
})
