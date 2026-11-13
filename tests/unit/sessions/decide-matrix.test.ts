// decideSession v1 matrix: every combination of the
// boolean / enum inputs — the Fix row's choice × reuseSession × vendor × Implement's status × its session id ×
// the Fix vendor's capabilities (resume kind × model switch, or unknown) × canResume × cwd × models — against the
// session rules, in order; the first failing rule names the FreshReason.
import { describe, expect, it } from 'vitest'
import type { FixSessionChoice } from '@shared/ipc.ts'
import { FRESH_REASONS, PASS_STATUSES } from '@shared/run.ts'
import type { FreshReason, PassStatus } from '@shared/run.ts'
import {
  FRESH_REASON_TEXT,
  IMPLEMENT_ONLY_REASONS,
  SESSION_NOTE,
  decideSession,
  fixSessionChoice,
  sameCwd,
  sameModel,
  sessionCandidate,
} from '@core/supervisor/sessions.ts'
import type { SessionCapabilities, SessionDecision, SessionInputs } from '@core/supervisor/sessions.ts'

type Can = { ok: boolean; reason?: FreshReason }

interface Case {
  override: FixSessionChoice | undefined
  reuseSession: boolean
  sameVendor: boolean
  status: PassStatus
  sessionId: string | undefined
  caps: SessionCapabilities | undefined
  can: Can
  cwd: [string | undefined, string | undefined]
  models: [string | null, string | null]
  /** Implement's session ended heavy (context health). */
  heavy: boolean
}

const OVERRIDES: (FixSessionChoice | undefined)[] = [undefined, 'reuse', 'fresh', 'fresh-other']
const SESSION_IDS: (string | undefined)[] = ['impl-session', undefined, '']
const CAPS: (SessionCapabilities | undefined)[] = [
  undefined,
  ...(['id', 'load', 'none'] as const).flatMap((resume) =>
    [true, false].map((resumeModelSwitch) => ({ resume, resumeModelSwitch })),
  ),
]
const CANS: Can[] = [{ ok: true }, { ok: false }, { ok: false, reason: 'resume-failed' }]
/** Fix's folder, then the folder Implement's session ran in (undefined = unknown). */
const CWDS: [string | undefined, string | undefined][] = [
  [undefined, undefined],
  ['C:\\work\\repo', 'C:\\work\\repo'],
  ['C:\\work\\repo\\', 'C:\\work\\repo'],
  ['C:\\work\\wt-1', 'C:\\work\\repo'],
  ['C:\\work\\wt-1', undefined],
]
/** Fix's resolved model, then Implement's (null = the CLI default). */
const MODELS: [string | null, string | null][] = [
  [null, null],
  ['opus', 'opus'],
  [null, 'opus'],
  ['opus', 'sonnet'],
]

function* cases(): Generator<Case> {
  for (const override of OVERRIDES)
    for (const reuseSession of [true, false])
      for (const sameVendor of [true, false])
        for (const status of PASS_STATUSES)
          for (const sessionId of SESSION_IDS)
            for (const caps of CAPS)
              for (const can of CANS)
                for (const cwd of CWDS)
                  for (const models of MODELS)
                    for (const heavy of [false, true])
                      yield {
                        override,
                        reuseSession,
                        sameVendor,
                        status,
                        sessionId,
                        caps,
                        can,
                        cwd,
                        models,
                        heavy,
                      }
}

function inputsOf(c: Case): SessionInputs {
  const i: SessionInputs = {
    fix: { vendor: c.sameVendor ? 'claude' : 'codex', model: c.models[0], reuseSession: c.reuseSession },
    implement: { vendor: 'claude', model: c.models[1], status: c.status },
  }
  if (c.override !== undefined) i.fix.override = c.override
  if (c.cwd[0] !== undefined) i.fix.cwd = c.cwd[0]
  if (c.sessionId !== undefined) i.implement.sessionId = c.sessionId
  if (c.cwd[1] !== undefined) i.implement.cwd = c.cwd[1]
  if (c.caps !== undefined) i.capabilities = c.caps
  if (c.heavy) i.implement.heavy = true
  return i
}

const fresh = (reason: FreshReason): SessionDecision => ({ reuse: false, reason })

/** The session rules, read rule by rule. */
function expected(c: Case): SessionDecision {
  const choice = c.override ?? (c.reuseSession ? 'reuse' : 'fresh')
  // 1. reuseSession and the three overrides
  if (choice === 'fresh-other') return fresh('override-other-vendor')
  if (choice === 'fresh' || !c.reuseSession) return fresh('override-fresh')
  // 2. same vendor
  if (!c.sameVendor) return fresh('vendor-differs')
  // 3. Implement done with a session id
  if (c.status === 'skipped') return fresh('implement-skipped')
  if (c.status !== 'done' || c.sessionId === undefined || c.sessionId === '') return fresh('no-session')
  // 3b. the session did not end heavy
  if (c.heavy) return fresh('context-heavy')
  // 4. resume ≠ 'none'
  if (c.caps?.resume === 'none') return fresh('cannot-resume')
  // 5. canResume ok
  if (!c.can.ok) return fresh(c.can.reason ?? 'cannot-resume')
  // 6. cwd unchanged (unknown passes; trailing separators do not count)
  const [fixCwd, implCwd] = c.cwd
  if (fixCwd !== undefined && implCwd !== undefined && fixCwd.replace(/\\$/, '') !== implCwd) {
    return fresh('cwd-changed')
  }
  // 7. models equal or resumeModelSwitch (unknown passes)
  if (c.models[0] !== c.models[1] && c.caps?.resumeModelSwitch === false) return fresh('model-differs')
  return { reuse: true, sessionId: c.sessionId }
}

describe('decideSession v1: the full matrix', () => {
  it('every combination matches the session rules rule by rule, and canResume is asked only once rules 1–4 pass', () => {
    let n = 0
    const wrong: string[] = []
    const seen = new Set<string>()
    for (const c of cases()) {
      n++
      const asked: string[] = []
      const got = decideSession(inputsOf(c), (id) => {
        asked.push(id)
        return c.can
      })
      const want = expected(c)
      seen.add(want.reuse ? 'reuse' : want.reason)
      const askedOk =
        asked.length === (sessionCandidate(inputsOf(c)).reuse && c.caps?.resume !== 'none' ? 1 : 0)
      if (JSON.stringify(got) !== JSON.stringify(want) || !askedOk) {
        if (wrong.length < 10)
          wrong.push(`${JSON.stringify(c)} → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
      }
    }
    expect(wrong).toEqual([])
    expect(n).toBe(4 * 2 * 2 * PASS_STATUSES.length * 3 * 7 * 3 * 5 * 4 * 2)
    // Every FreshReason is reachable (resume-failed through an adapter's canResume answer here; the reducer's
    // resume_failed fallback is the other way, see machine-sessions.test.ts). Continuity's own reasons come from
    // Implement's decision (decideImplementSession), never Fix's: tests/unit/depth/continuity.test.ts covers them.
    const fixReasons = FRESH_REASONS.filter((r) => !IMPLEMENT_ONLY_REASONS.includes(r))
    expect([...seen].sort()).toEqual([...fixReasons, 'reuse'].sort())
  })

  it('the first failing rule names the reason (one row per rule, every later rule failing too)', () => {
    const allBad: Case = {
      override: 'fresh-other',
      reuseSession: false,
      sameVendor: false,
      status: 'skipped',
      sessionId: undefined,
      caps: { resume: 'none', resumeModelSwitch: false },
      can: { ok: false },
      cwd: ['C:\\a', 'C:\\b'],
      models: ['opus', 'sonnet'],
      heavy: true,
    }
    const fixes: [Partial<Case>, string][] = [
      [{}, 'override-other-vendor'],
      [{ override: 'fresh' }, 'override-fresh'],
      [{ override: 'reuse', reuseSession: true }, 'vendor-differs'],
      [{ override: 'reuse', reuseSession: true, sameVendor: true }, 'implement-skipped'],
      [{ override: 'reuse', reuseSession: true, sameVendor: true, status: 'done' }, 'no-session'],
    ]
    let c = allBad
    for (const [fix, reason] of fixes) {
      c = { ...c, ...fix }
      expect(decideSession(inputsOf(c), () => c.can)).toEqual({ reuse: false, reason })
    }
    c = { ...c, sessionId: 'impl-session' }
    expect(decideSession(inputsOf(c), () => c.can)).toEqual(fresh('context-heavy'))
    c = { ...c, heavy: false }
    expect(decideSession(inputsOf(c), () => c.can)).toEqual(fresh('cannot-resume'))
    c = { ...c, caps: { resume: 'id', resumeModelSwitch: false } }
    expect(decideSession(inputsOf(c), () => ({ ok: false, reason: 'resume-failed' }))).toEqual(
      fresh('resume-failed'),
    )
    c = { ...c, can: { ok: true } }
    expect(decideSession(inputsOf(c), () => c.can)).toEqual(fresh('cwd-changed'))
    c = { ...c, cwd: ['C:\\a', 'C:\\a'] }
    expect(decideSession(inputsOf(c), () => c.can)).toEqual(fresh('model-differs'))
    c = { ...c, caps: { resume: 'id', resumeModelSwitch: true } }
    expect(decideSession(inputsOf(c), () => c.can)).toEqual({ reuse: true, sessionId: 'impl-session' })
  })
})

describe('the overrides and the comparisons', () => {
  it('Reuse / Fresh / Fresh, different vendor from reuseSession + vendor (+ readiness before a run)', () => {
    expect(fixSessionChoice({ vendor: 'claude', reuseSession: true }, 'claude')).toBe('reuse')
    expect(fixSessionChoice({ vendor: 'codex', reuseSession: true }, 'claude')).toBe('reuse')
    expect(fixSessionChoice({ vendor: 'claude', reuseSession: false }, 'claude')).toBe('fresh')
    expect(fixSessionChoice({ vendor: 'codex', reuseSession: false }, 'claude')).toBe('fresh-other')
    // Before a run: off on a vendor that is not ready reads as plain Fresh.
    expect(fixSessionChoice({ vendor: 'codex', reuseSession: false }, 'claude', false)).toBe('fresh')
  })

  it('models: both null equal; null vs an id differ; ids compare as strings (aliases are not resolved)', () => {
    expect(sameModel(null, null)).toBe(true)
    expect(sameModel(null, undefined)).toBe(true)
    expect(sameModel('', null)).toBe(true)
    expect(sameModel('opus', 'opus')).toBe(true)
    expect(sameModel(' opus ', 'opus')).toBe(true)
    expect(sameModel(null, 'opus')).toBe(false)
    expect(sameModel('sonnet', 'claude-sonnet-4-5')).toBe(false)
  })

  it('folders: unknown passes; trailing separators do not count', () => {
    expect(sameCwd(undefined, 'C:\\x')).toBe(true)
    expect(sameCwd('C:\\x\\', 'C:\\x')).toBe(true)
    expect(sameCwd('/tmp/x/', '/tmp/x')).toBe(true)
    expect(sameCwd('/tmp/x', '/tmp/y')).toBe(false)
  })

  it('v0 inputs (no override, folder or capabilities) keep their v0 answers', () => {
    const v0 = (
      o: Partial<SessionInputs['fix']> & { status?: PassStatus; sessionId?: string },
    ): SessionInputs => ({
      fix: { vendor: o.vendor ?? 'claude', model: null, reuseSession: o.reuseSession ?? true },
      implement: {
        vendor: 'claude',
        model: null,
        status: o.status ?? 'done',
        ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
      },
    })
    expect(decideSession(v0({ sessionId: 's' }))).toEqual({ reuse: true, sessionId: 's' })
    // reuseSession off on another vendor stays override-fresh without the override input.
    expect(decideSession(v0({ reuseSession: false, vendor: 'codex' }))).toEqual(fresh('override-fresh'))
    expect(decideSession(v0({ vendor: 'codex', sessionId: 's' }))).toEqual(fresh('vendor-differs'))
    // Models differ with no capabilities known: v0 ignored models, so does an unknown model switch.
    const m = v0({ sessionId: 's' })
    m.fix.model = 'opus'
    expect(decideSession(m)).toEqual({ reuse: true, sessionId: 's' })
  })

  it('every FreshReason has session-line text (SESSION_NOTE wording kept)', () => {
    for (const r of FRESH_REASONS) {
      expect(FRESH_REASON_TEXT[r].length).toBeGreaterThan(0)
      expect(SESSION_NOTE.fresh(r)).toBe(`fresh session: ${FRESH_REASON_TEXT[r]}`)
    }
    expect(new Set(Object.values(FRESH_REASON_TEXT)).size).toBe(FRESH_REASONS.length)
    expect(SESSION_NOTE.reusedImplement).toBe('reused the Implement session')
    expect(SESSION_NOTE.resumed).toBe('resumed the previous session')
    expect(SESSION_NOTE.fresh('resume-failed')).toBe('fresh session: resuming failed')
    expect(SESSION_NOTE.fresh('override-other-vendor')).toBe('fresh session: set to a different vendor')
  })
})
