// decideSession v0 (sessions): reuse iff reuseSession ∧ same vendor ∧ Implement done with
// a session id (∧ canResume, injected, default ok); otherwise fresh with the first failing rule's FreshReason.
import { describe, expect, it } from 'vitest'
import { FRESH_REASONS } from '@shared/run.ts'
import { CAN_RESUME_OK, FRESH_REASON_TEXT, SESSION_NOTE, decideSession } from '@core/supervisor/sessions.ts'
import type { SessionInputs } from '@core/supervisor/sessions.ts'

function inputs(o: {
  reuse?: boolean
  fixVendor?: string
  implVendor?: string
  status?: SessionInputs['implement']['status']
  sessionId?: string | null
}): SessionInputs {
  const implement: SessionInputs['implement'] = {
    vendor: o.implVendor ?? 'claude',
    model: null,
    status: o.status ?? 'done',
  }
  if (o.sessionId !== null) implement.sessionId = o.sessionId ?? 'impl-session'
  return {
    fix: { vendor: o.fixVendor ?? 'claude', model: null, reuseSession: o.reuse ?? true },
    implement,
  }
}

describe('decideSession v0', () => {
  it('reuses Implement’s session when every rule holds', () => {
    expect(decideSession(inputs({}))).toEqual({ reuse: true, sessionId: 'impl-session' })
  })

  it.each([
    ['reuseSession off', { reuse: false }, 'override-fresh'],
    ['Fix vendor differs', { fixVendor: 'codex' }, 'vendor-differs'],
    ['Implement skipped', { status: 'skipped' as const }, 'implement-skipped'],
    ['Implement reported no session', { sessionId: null }, 'no-session'],
    ['Implement not done', { status: 'failed' as const }, 'no-session'],
    ['empty session id', { sessionId: '' }, 'no-session'],
  ])('%s → fresh (%s)', (_name, o, reason) => {
    expect(decideSession(inputs(o))).toEqual({ reuse: false, reason })
  })

  it('the first failing rule names the reason (override before vendor before session)', () => {
    expect(decideSession(inputs({ reuse: false, fixVendor: 'codex', sessionId: null }))).toEqual({
      reuse: false,
      reason: 'override-fresh',
    })
    expect(decideSession(inputs({ fixVendor: 'codex', sessionId: null }))).toEqual({
      reuse: false,
      reason: 'vendor-differs',
    })
  })

  it('canResume is injected; the default answers ok', () => {
    expect(CAN_RESUME_OK('x')).toEqual({ ok: true })
    const seen: string[] = []
    const no = (id: string): { ok: boolean } => {
      seen.push(id)
      return { ok: false }
    }
    expect(decideSession(inputs({}), no)).toEqual({ reuse: false, reason: 'cannot-resume' })
    expect(seen).toEqual(['impl-session'])
    expect(decideSession(inputs({}), () => ({ ok: false, reason: 'cwd-changed' }))).toEqual({
      reuse: false,
      reason: 'cwd-changed',
    })
    // Not consulted when an earlier rule already decided.
    seen.length = 0
    decideSession(inputs({ reuse: false }), no)
    expect(seen).toEqual([])
  })

  it('every FreshReason has session-line text', () => {
    for (const r of FRESH_REASONS) expect(FRESH_REASON_TEXT[r].length).toBeGreaterThan(0)
    expect(SESSION_NOTE.fresh('vendor-differs')).toBe('fresh session: Fix vendor differs')
  })
})
