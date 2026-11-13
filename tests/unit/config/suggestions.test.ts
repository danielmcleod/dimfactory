// Composer suggestions in core (src/core/config/suggestions.ts; the Critic swap, R10
// decideSession, the Fix row): the [Swap Critic to X] target, how Fix's session will start and the vendor "Fresh,
// different vendor" would use, from the vendors' readiness. One rule, in core; config.resolve carries the answer.
import { describe, expect, it } from 'vitest'
import { composerSuggestions } from '@core/config/suggestions.ts'
import type { ReadyVendorInfo } from '@core/config/suggestions.ts'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { Mode, PassName } from '@shared/run.ts'
import type { SupportStatus } from '@shared/vendors.ts'

type Passes = Pick<ResolvedConfig, 'passes'>

const tpl = { name: 'x', path: 'builtin/x.md', layer: 'builtin' as const, sha256: '0'.repeat(64) }
const pass = (vendor: string, mode: Mode, model: string | null = null) => ({
  vendor,
  model,
  effort: null,
  mode,
  enabled: true,
  promptTemplate: tpl,
  extensions: mode === 'readonly' ? ('none' as const) : ('passthrough' as const),
})

function cfg(edit?: (c: Passes) => void): Passes {
  const c: Passes = {
    passes: {
      plan: {
        ...pass('claude', 'readonly', 'opus'),
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
      review: { ...pass('claude', 'readonly', 'sonnet'), acceptance: false },
      critic: pass('claude', 'readonly', 'opus'),
      security: { ...pass('claude', 'readonly', 'opus'), enabled: false, recheck: true },
      fix: {
        ...pass('claude', 'autoedit'),
        inherit: 'implement',
        reuseSession: true,
        rounds: 1,
        recheck: true,
        maxCostUsd: null,
        maxMinutes: null,
      },
    },
  }
  edit?.(c)
  return c
}

/** A ready vendor; `unsupported` lists the (pass, mode) pairs it cannot run. */
function ready(id: string, unsupported: [PassName, Mode][] = []): ReadyVendorInfo {
  return {
    id,
    support: (p, m): SupportStatus =>
      unsupported.some(([up, um]) => up === p && um === m) ? 'unsupported' : 'supported',
  }
}

/** Registry ids: a local preset runs on Codex. */
const resolveId = (v: string): string => (v.startsWith('local-') ? 'codex' : v)

describe('Critic swap', () => {
  it('offers the first other ready vendor when Critic runs on Implement’s', () => {
    expect(composerSuggestions(cfg(), [ready('claude'), ready('codex')], resolveId).criticSwap).toEqual({
      to: 'codex',
    })
  })

  it('offers nothing when Critic already differs, is off, or no other vendor is ready', () => {
    const differs = cfg((c) => void (c.passes.critic.vendor = 'codex'))
    expect(composerSuggestions(differs, [ready('claude'), ready('codex')], resolveId).criticSwap).toBeNull()
    const off = cfg((c) => void (c.passes.critic.enabled = false))
    expect(composerSuggestions(off, [ready('claude'), ready('codex')], resolveId).criticSwap).toBeNull()
    expect(composerSuggestions(cfg(), [ready('claude')], resolveId).criticSwap).toBeNull()
  })

  it('never offers a vendor that cannot review read-only; a local preset counts as Codex', () => {
    const noReadonly = ready('codex', [['critic', 'readonly']])
    expect(composerSuggestions(cfg(), [ready('claude'), noReadonly], resolveId).criticSwap).toBeNull()
    const local = cfg((c) => {
      c.passes.implement.vendor = 'local-qwen'
      c.passes.critic.vendor = 'codex'
    })
    expect(composerSuggestions(local, [ready('claude'), ready('codex')], resolveId).criticSwap).toEqual({
      to: 'claude',
    })
  })
})

describe('Fix session (decideSession before the run)', () => {
  it('reuses Implement’s session on the same vendor with reuseSession on', () => {
    expect(composerSuggestions(cfg(), [], resolveId).fixSession).toEqual({ choice: 'reuse' })
  })

  it('starts fresh when set to (override-fresh), on the same or another vendor', () => {
    const fresh = cfg((c) => void (c.passes.fix.reuseSession = false))
    expect(composerSuggestions(fresh, [], resolveId).fixSession).toEqual({
      choice: 'fresh',
      reason: 'override-fresh',
    })
    const other = cfg((c) => {
      c.passes.fix.reuseSession = false
      c.passes.fix.vendor = 'codex'
    })
    expect(composerSuggestions(other, [], resolveId).fixSession).toEqual({
      choice: 'fresh-other',
      reason: 'override-fresh',
    })
  })

  it('a Fix vendor override starts fresh even with reuseSession on (vendor-differs), never "Reuse"', () => {
    const vendorOnly = cfg((c) => void (c.passes.fix.vendor = 'codex'))
    expect(composerSuggestions(vendorOnly, [], resolveId).fixSession).toEqual({
      choice: 'fresh-other',
      reason: 'vendor-differs',
    })
  })
})

describe('"Fresh, different vendor"', () => {
  it('is the first ready vendor other than Implement’s that can run Fix’s mode', () => {
    const s = composerSuggestions(cfg(), [ready('claude'), ready('codex'), ready('gemini')], resolveId)
    expect(s.otherFixVendor).toBe('codex')
    const noEdit = ready('codex', [['fix', 'autoedit']])
    expect(
      composerSuggestions(cfg(), [ready('claude'), noEdit, ready('gemini')], resolveId).otherFixVendor,
    ).toBe('gemini')
    expect(composerSuggestions(cfg(), [ready('claude')], resolveId).otherFixVendor).toBeNull()
  })

  it('follows Fix’s own mode (Approve everything under Auto)', () => {
    const auto = cfg((c) => void (c.passes.fix.mode = 'full'))
    const noFull = ready('codex', [['fix', 'full']])
    expect(composerSuggestions(auto, [ready('claude'), noFull], resolveId).otherFixVendor).toBeNull()
  })
})
