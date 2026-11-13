// decideSession for ACP sessions (sessions "decideSession(fix) reuses Implement's session iff …
// resume ≠ 'none', canResume ok, cwd unchanged, models equal or resumeModelSwitch"; "ACP: from the session/new
// response, before session/prompt"; ACP base "session/resume if advertised, else session/load"):
//   - Fix on Gemini after a Gemini Implement continues the ACP session when the agent advertised load or resume
//   - an agent that advertises neither: fresh, "the session cannot be resumed", decided by the capability
//   - canResume refusing, a changed folder, a model switch the agent cannot make: the FreshReason that applies
//   - another vendor on either side: "Fix vendor differs" (never another vendor's session)
//   - the composer's preview and `pass.fix.resume` read the same rules from the Gemini probe's capabilities
import { describe, expect, it } from 'vitest'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { composerSuggestions } from '@core/config/suggestions.ts'
import {
  decideSession,
  decidedByCapability,
  previewFixSession,
  previewOptions,
} from '@core/supervisor/sessions.ts'
import type { SessionInputs } from '@core/supervisor/sessions.ts'
import { GEMINI_MODE_COPY, geminiCaps } from './helpers.ts'

const SESSION = 'b6e6b0c1-7a0e-4f0c-9d5c-000000000001'
const CWD = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

function inputs(
  o: { resume?: 'load' | 'none'; fixVendor?: string; implVendor?: string; fixModel?: string | null } = {},
) {
  const caps = geminiCaps(o.resume ?? 'load')
  const i: SessionInputs = {
    fix: {
      vendor: o.fixVendor ?? 'gemini',
      model: o.fixModel !== undefined ? o.fixModel : null,
      reuseSession: true,
      cwd: CWD,
    },
    implement: {
      vendor: o.implVendor ?? 'gemini',
      model: null,
      status: 'done',
      sessionId: SESSION,
      cwd: CWD,
    },
    capabilities: { resume: caps.resume, resumeModelSwitch: caps.resumeModelSwitch },
  }
  return i
}

describe('decideSession for a Gemini (ACP) Implement', () => {
  it('load advertised: Fix continues the session Implement left', () => {
    expect(decideSession(inputs())).toEqual({ reuse: true, sessionId: SESSION })
  })

  it('neither load nor resume advertised: fresh, decided by the capability (the "Why?" says the vendor cannot)', () => {
    const i = inputs({ resume: 'none' })
    const d = decideSession(i)
    expect(d).toEqual({ reuse: false, reason: 'cannot-resume' })
    expect(decidedByCapability(i, d)).toBe(true)
  })

  it('canResume refusing (the agent no longer has that session): fresh with its reason', () => {
    const i = inputs()
    const d = decideSession(i, () => ({ ok: false, reason: 'cannot-resume' }))
    expect(d).toEqual({ reuse: false, reason: 'cannot-resume' })
    expect(decidedByCapability(i, d)).toBe(false)
  })

  it('a session is scoped to its folder: another folder starts fresh (cwd-changed)', () => {
    const i = inputs()
    i.fix.cwd = `${CWD}-other`
    expect(decideSession(i)).toEqual({ reuse: false, reason: 'cwd-changed' })
  })

  it('a model the agent cannot switch to on resume: fresh (model-differs)', () => {
    expect(decideSession(inputs({ fixModel: 'gemini-2.5-flash' }))).toEqual({
      reuse: false,
      reason: 'model-differs',
    })
  })

  it.each([
    ['claude', 'gemini'],
    ['gemini', 'codex'],
  ])('Fix on %s after Implement on %s: vendor-differs', (fixVendor, implVendor) => {
    expect(decideSession(inputs({ fixVendor, implVendor }))).toEqual({
      reuse: false,
      reason: 'vendor-differs',
    })
  })
})

describe('the preview (composer and pass.fix.resume) with Gemini', () => {
  const cfg = resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: {
      passes: { implement: { vendor: 'gemini', model: null }, fix: { vendor: 'gemini', model: null } },
    },
  })

  it('a ready Gemini that can load sessions: Fix will continue Implement', () => {
    const d = previewFixSession(cfg.passes, previewOptions({ ready: true, capabilities: geminiCaps('load') }))
    expect(d.reuse).toBe(true)
    const s = composerSuggestions(cfg, [
      {
        id: 'gemini',
        support: () => 'supported',
        capabilities: { resume: 'load', resumeModelSwitch: false },
      },
    ])
    expect(s.fixSession).toEqual({ choice: 'reuse' })
  })

  it('a ready Gemini that cannot: fresh, cannot-resume; a Gemini not ready says nothing about its capability', () => {
    const d = previewFixSession(cfg.passes, previewOptions({ ready: true, capabilities: geminiCaps('none') }))
    expect(d).toEqual({ reuse: false, reason: 'cannot-resume' })
    expect(
      previewFixSession(cfg.passes, previewOptions({ ready: false, capabilities: geminiCaps('none') })),
    ).toEqual({
      reuse: true,
      sessionId: 'implement-session',
    })
  })

  it('Gemini is a candidate for "Fresh, different vendor" and the Critic swap once it is ready', () => {
    const claudeOnly = resolveBuiltinConfig({ profile: 'claude-only' })
    const s = composerSuggestions(claudeOnly, [
      { id: 'claude', support: () => 'supported' },
      { id: 'gemini', support: (_p, mode) => GEMINI_MODE_COPY[mode].status },
    ])
    expect(s.otherFixVendor).toBe('gemini')
    expect(s.criticSwap).toEqual({ to: 'gemini' })
  })
})
