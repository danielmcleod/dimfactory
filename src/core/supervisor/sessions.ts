// Session reuse for Fix (R10, P19/P20, readiness `pass.fix.resume`). Pure: no I/O,
// no clock.
//
// decideSession v1: Fix reuses Implement's session iff every rule holds. The rules are checked in this order
// and the first failing one names the FreshReason (the session line: "fresh session: Fix vendor differs"):
//   1. reuseSession, and the Fix row's choice   Fresh → override-fresh · Fresh, different vendor → override-other-vendor
//   2. same vendor                              vendor-differs
//   3. Implement done with a session id         implement-skipped (Implement was skipped) · no-session
//   3b. Implement's session not heavy             context-heavy (it ended nearly full or summarised itself often)
//   4. the adapter's capabilities.resume ≠ none cannot-resume
//   5. adapter.canResume ok                     its reason (the Claude adapter: cannot-resume)
//   6. cwd unchanged                            cwd-changed
//   7. models equal, or resumeModelSwitch       model-differs
// The newer inputs are optional; an absent one is unknown and never fails its rule, so every v0 case keeps
// its answer. canResume is async in the adapter and the reducer cannot await: the controller asks it before Fix's
// pass-boundary preflight is answered and sends the answer in as a `session-check` event (machine.ts, R10).
import type { FixSessionChoice } from '../../shared/ipc.ts'
import type { FreshReason, PassStatus } from '../../shared/run.ts'
import type { Capabilities } from '../../shared/vendors.ts'
import type { RunState } from './types.ts'
import { contextHealthOf, sessionHeavy } from '../context/policy.ts'

/** What decideSession needs of the Fix vendor's adapter capabilities (Implement's continuity: the mode switch too). */
export type SessionCapabilities = Pick<Capabilities, 'resume' | 'resumeModelSwitch' | 'resumeModeSwitch'>

export interface SessionInputs {
  fix: {
    vendor: string
    /** The resolved model; null = the CLI's default model. */
    model: string | null
    /** `passes.fix.reuseSession`; false = the user chose a fresh Fix session. */
    reuseSession: boolean
    /**
     * The Fix row's choice the config expresses (`fixSessionChoice`). Absent: `reuseSession` alone decides
     * (v0: off → override-fresh).
     */
    override?: FixSessionChoice
    /** The folder Fix will run in; absent = unknown. */
    cwd?: string
  }
  implement: {
    vendor: string
    model: string | null
    status: PassStatus
    /** The session Implement ran in (absent when it never reported one). */
    sessionId?: string
    /** The folder Implement's session ran in; absent = unknown. */
    cwd?: string
    /**
     * The session ended heavy (context health: at least the heavy share of its window, or compacted that often), so
     * Fix starts clean rather than inherit a summarised context. Absent: not known to be heavy.
     */
    heavy?: boolean
  }
  /** The Fix vendor's capabilities; absent = unknown (rules 4 and 7 pass). */
  capabilities?: SessionCapabilities
}

export type SessionDecision = { reuse: true; sessionId: string } | { reuse: false; reason: FreshReason }

/** `adapter.canResume(sessionId, cwd)`, answered beforehand (the reducer cannot await). */
export type CanResume = (sessionId: string) => { ok: boolean; reason?: FreshReason }

export const CAN_RESUME_OK: CanResume = () => ({ ok: true })

const fresh = (reason: FreshReason): SessionDecision => ({ reuse: false, reason })

/**
 * Rules 1–3: the session Fix could continue, from the config and Implement's outcome alone (what the controller
 * asks the adapter about), or the reason Fix starts fresh before any adapter fact matters.
 */
export function sessionCandidate(i: SessionInputs): SessionDecision {
  const choice = i.fix.override ?? (i.fix.reuseSession ? 'reuse' : 'fresh')
  if (choice === 'fresh-other') return fresh('override-other-vendor')
  if (choice === 'fresh' || !i.fix.reuseSession) return fresh('override-fresh')
  if (i.fix.vendor !== i.implement.vendor) return fresh('vendor-differs')
  if (i.implement.status === 'skipped') return fresh('implement-skipped')
  const id = i.implement.sessionId
  if (i.implement.status !== 'done' || id === undefined || id === '') return fresh('no-session')
  if (i.implement.heavy === true) return fresh('context-heavy')
  return { reuse: true, sessionId: id }
}

/** R10 `decideSession(fix)`. Checks the rules in order; the first failing rule names the FreshReason. */
export function decideSession(i: SessionInputs, canResume: CanResume = CAN_RESUME_OK): SessionDecision {
  const candidate = sessionCandidate(i)
  if (!candidate.reuse) return candidate
  const id = candidate.sessionId
  if (i.capabilities?.resume === 'none') return fresh('cannot-resume')
  const c = canResume(id)
  if (!c.ok) return fresh(c.reason ?? 'cannot-resume')
  if (!sameCwd(i.fix.cwd, i.implement.cwd)) return fresh('cwd-changed')
  if (!sameModel(i.fix.model, i.implement.model) && i.capabilities?.resumeModelSwitch === false) {
    return fresh('model-differs')
  }
  return { reuse: true, sessionId: id }
}

/**
 * Whether rule 4 (the vendor's capabilities say resume 'none') is what made `d` cannot-resume, rather than
 * canResume (rule 5): rules 1–3 passed and rule 4 comes first. The session line's "Why?" then says the vendor cannot
 * continue a session at all (shared FreshDetail `vendor-cannot-resume`).
 */
export function decidedByCapability(i: SessionInputs, d: SessionDecision): boolean {
  return (
    !d.reuse && d.reason === 'cannot-resume' && i.capabilities?.resume === 'none' && sessionCandidate(i).reuse
  )
}

/**
 * Model equality for rule 7, over the RESOLVED models (after `inherit` and `defaultModel`): null means "the CLI's
 * default model", so two nulls are equal, a null and an explicit id are not (Dim Factory cannot know which model the
 * CLI defaults to), and two ids are equal when they are the same string (aliases are not resolved: `sonnet` and a
 * full `claude-sonnet-…` id differ). An empty or blank id counts as null.
 */
export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  return normModel(a) === normModel(b)
}

const normModel = (m: string | null | undefined): string | null =>
  m === null || m === undefined || m.trim() === '' ? null : m.trim()

/**
 * Rule 6: the folders compare equal ignoring trailing separators; an unknown folder (absent) passes. Both come from
 * the controller, which spawns every pass of a run in the same resolved folder (an isolated run's worktree copy).
 */
export function sameCwd(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true
  const norm = (p: string): string => p.replace(/[\\/]+$/, '')
  return norm(a) === norm(b)
}

/**
 * The Fix row's choice a config expresses ("Fresh, different vendor", the Fix row): Reuse = `reuseSession`
 * on; Fresh = off; "Fresh, different vendor" = off with Fix on a vendor other than Implement's that is ready
 * (`otherVendorReady`). In a run it always is (the authoritative preflight passed Fix's vendor); before one, a vendor
 * that is not ready makes the row read as plain Fresh.
 */
export function fixSessionChoice(
  fix: { vendor: string; reuseSession: boolean },
  implementVendor: string,
  otherVendorReady = true,
): FixSessionChoice {
  if (fix.reuseSession) return 'reuse'
  return fix.vendor !== implementVendor && otherVendorReady ? 'fresh-other' : 'fresh'
}

// ---- in a run (the reducer and the controller read the same inputs) ----------------------------------------------

/** R10: what the controller learned for Fix's session decision (`session-check` event). */
export interface SessionCheck {
  /** The session asked about: Implement's (rules 1–3 passed). */
  sessionId: string
  /** `adapter.canResume(sessionId, <the folder the session ran in>)`. */
  ok: boolean
  reason?: FreshReason
  /** The folder Fix will run in. */
  cwd?: string
  /** The Fix vendor's capabilities as the run recorded them at start (resolved.json `vendors`). */
  capabilities?: SessionCapabilities
}

/**
 * decideSession's inputs for Fix in a run: the run's config, Implement's step and session (its folder from the
 * `spawned` event), and the controller's `check` when it sent one for that session.
 */
export function fixSessionInputs(s: RunState, check?: SessionCheck): SessionInputs {
  const impl = s.steps.implement
  const ic = s.config.passes.implement
  const fc = s.config.passes.fix
  const implVendor = impl.vendor ?? ic.vendor
  const reuseSession = fc.reuseSession ?? true
  const sessionCwd = impl.sessionId !== undefined ? s.sessions[impl.sessionId]?.cwd : undefined
  const current = check !== undefined && check.sessionId === impl.sessionId ? check : undefined
  // Re-run from Fix: Implement is carried from the source run (skipped "carried from run #N"), where it was done
  // with the session the run carries in sessions[].
  const carried = s.rerunOf?.from === 'fix' && impl.status === 'skipped'
  const i: SessionInputs = {
    fix: {
      vendor: fc.vendor,
      model: fc.model,
      reuseSession,
      override: fixSessionChoice({ vendor: fc.vendor, reuseSession }, implVendor),
    },
    implement: {
      vendor: implVendor,
      model: impl.model !== undefined ? impl.model : ic.model,
      status: carried ? 'done' : impl.status,
    },
  }
  if (impl.sessionId !== undefined) i.implement.sessionId = impl.sessionId
  if (sessionCwd !== undefined) i.implement.cwd = sessionCwd
  if (current?.cwd !== undefined) i.fix.cwd = current.cwd
  if (current?.capabilities !== undefined) i.capabilities = current.capabilities
  // Context health: Implement's session ended nearly full or summarised itself often (a carried Implement: unknown).
  if (!carried && sessionHeavy(impl.context, contextHealthOf(s))) i.implement.heavy = true
  return i
}

/**
 * decideSession's inputs for the Fix launch now: fixSessionInputs in round 1. In a later round of Fix until green the
 * previous round's Fix session stands in for Implement's, under the same rules (the Fix row's choice, the vendor's
 * resume capability, canResume, the folder, the model).
 */
export function fixLaunchSessionInputs(s: RunState, check?: SessionCheck): SessionInputs {
  if ((s.fixLoop?.round ?? 1) <= 1) return fixSessionInputs(s, check)
  const fix = s.steps.fix
  const fc = s.config.passes.fix
  const reuseSession = fc.reuseSession ?? true
  const sessionCwd = fix.sessionId !== undefined ? s.sessions[fix.sessionId]?.cwd : undefined
  const current = check !== undefined && check.sessionId === fix.sessionId ? check : undefined
  const i: SessionInputs = {
    fix: { vendor: fc.vendor, model: fc.model, reuseSession, override: reuseSession ? 'reuse' : 'fresh' },
    implement: {
      vendor: fix.vendor ?? fc.vendor,
      model: fix.model !== undefined ? fix.model : fc.model,
      status: 'done',
    },
  }
  if (fix.sessionId !== undefined) i.implement.sessionId = fix.sessionId
  if (sessionCwd !== undefined) i.implement.cwd = sessionCwd
  if (current?.cwd !== undefined) i.fix.cwd = current.cwd
  if (current?.capabilities !== undefined) i.capabilities = current.capabilities
  // The previous round's session ended heavy: the next round starts clean too.
  if (sessionHeavy(fix.context, contextHealthOf(s))) i.implement.heavy = true
  return i
}

// ---- continuity: Implement continues Plan's session ---------------------------------------------------------------

/**
 * Continuity is on and Plan's session could be continued by Implement as the config stands: both run on the same
 * vendor and Implement runs. Plan then keeps its session (it is not thrown away when Plan ends); the rest of the rules
 * are checked when Implement starts (decideImplementSession).
 */
export function planKeepsSession(s: Pick<RunState, 'config'>): boolean {
  const c = s.config
  return (
    c.continuity === true &&
    c.passes.plan.enabled &&
    c.passes.implement.enabled &&
    c.passes.plan.vendor === c.passes.implement.vendor
  )
}

/**
 * Implement continues Plan's session (continuity) under decideSession's rules, Plan standing in for Implement and
 * Implement for Fix: the same vendor, Plan done with a session it kept, the vendor can resume it (canResume, the
 * folder), the models are equal or the vendor switches models on resume, and the vendor can change the permission
 * mode on resume (Plan ran read-only, Implement edits). A fresh start names its reason in Plan's terms.
 */
export function implementSessionInputs(s: RunState, check?: SessionCheck): SessionInputs {
  const plan = s.steps.plan
  const pc = s.config.passes.plan
  const ic = s.config.passes.implement
  const sessionCwd = plan.sessionId !== undefined ? s.sessions[plan.sessionId]?.cwd : undefined
  const current = check !== undefined && check.sessionId === plan.sessionId ? check : undefined
  const i: SessionInputs = {
    fix: { vendor: ic.vendor, model: ic.model, reuseSession: true, override: 'reuse' },
    implement: {
      vendor: plan.vendor ?? pc.vendor,
      model: plan.model !== undefined ? plan.model : pc.model,
      status: plan.status,
    },
  }
  if (plan.sessionId !== undefined) i.implement.sessionId = plan.sessionId
  if (sessionCwd !== undefined) i.implement.cwd = sessionCwd
  if (current?.cwd !== undefined) i.fix.cwd = current.cwd
  if (current?.capabilities !== undefined) i.capabilities = current.capabilities
  return i
}

/** The reasons only Implement's decision gives (continuity); Fix's decideSession never does. */
export const IMPLEMENT_ONLY_REASONS: readonly FreshReason[] = [
  'plan-skipped',
  'plan-vendor-differs',
  'mode-switch-unsupported',
]

/** decideSession's reasons in Plan's terms (the session line says which pass's session it could not continue). */
const PLAN_REASON: Partial<Record<FreshReason, FreshReason>> = {
  'vendor-differs': 'plan-vendor-differs',
  'implement-skipped': 'plan-skipped',
}

/** Implement's session decision (continuity), with Implement's own reasons. */
export function decideImplementSession(
  i: SessionInputs,
  canResume: CanResume = CAN_RESUME_OK,
): SessionDecision {
  const d = decideSession(i, canResume)
  if (!d.reuse) return fresh(PLAN_REASON[d.reason] ?? d.reason)
  // Plan ran read-only; Implement edits. A vendor that cannot change the mode of a session it resumes starts fresh.
  if (i.capabilities?.resumeModeSwitch === false) return fresh('mode-switch-unsupported')
  return d
}

/** The controller's canResume answer as decideSession's callback (no answer for that session: assumed ok). */
export function canResumeFrom(check: SessionCheck | undefined): CanResume {
  return (id) => {
    if (check === undefined || check.sessionId !== id || check.ok) return { ok: true }
    return { ok: false, reason: check.reason ?? 'cannot-resume' }
  }
}

// ---- before a run (composer suggestions, `pass.fix.resume`) ------------------------------------------------------

/** Before a run, Implement has no session yet: decideSession is asked as if Implement finished with this one. */
export const PREVIEW_SESSION_ID = 'implement-session'

export interface SessionPreviewInput {
  implement: { vendor: string; model: string | null }
  fix: { vendor: string; model: string | null; reuseSession: boolean }
}

/**
 * How Fix's session will start for a resolved config, from the static rules (choice, vendor, the Fix vendor's resume
 * capability and model switch) — what Fix meets when Implement finishes with a session. canResume and the folder are
 * runtime facts and count as ok here. One function for the composer (config/suggestions.ts) and `pass.fix.resume`.
 */
export function previewFixSession(
  p: SessionPreviewInput,
  o: { capabilities?: SessionCapabilities | undefined; otherVendorReady?: boolean } = {},
): SessionDecision {
  const i: SessionInputs = {
    fix: {
      vendor: p.fix.vendor,
      model: p.fix.model,
      reuseSession: p.fix.reuseSession,
      override: fixSessionChoice(p.fix, p.implement.vendor, o.otherVendorReady ?? true),
    },
    implement: {
      vendor: p.implement.vendor,
      model: p.implement.model,
      status: 'done',
      sessionId: PREVIEW_SESSION_ID,
    },
  }
  if (o.capabilities !== undefined) i.capabilities = o.capabilities
  return decideSession(i)
}

/** The Fix vendor as the preview reads it. */
export interface PreviewVendor {
  /** Built and probed with no blocking failure (ConfigService.readyVendors: built and the effective probe ok). */
  ready: boolean
  /** The probe's capabilities. */
  capabilities?: SessionCapabilities | undefined
}

/**
 * previewFixSession's options for the Fix vendor, the one rule the composer (config/suggestions.ts) and
 * `pass.fix.resume` share: "Fresh, different vendor" needs the vendor ready, and only a ready vendor's capabilities
 * count — a stub's static `resume:'none'` or a broken CLI's probe says nothing about what the CLI can resume, so for
 * a vendor that is not ready (or not probed) rules 4 and 7 stay unknown.
 */
export function previewOptions(fixVendor: PreviewVendor | undefined): {
  otherVendorReady: boolean
  capabilities?: SessionCapabilities
} {
  if (fixVendor?.ready !== true) return { otherVendorReady: false }
  return fixVendor.capabilities !== undefined
    ? { otherVendorReady: true, capabilities: fixVendor.capabilities }
    : { otherVendorReady: true }
}

/** The human half of the session line: "fresh session: <text>". */
export const FRESH_REASON_TEXT: Record<FreshReason, string> = {
  'vendor-differs': 'Fix vendor differs',
  'no-session': 'no session to continue',
  'cannot-resume': 'the session cannot be resumed',
  'cwd-changed': 'the folder changed',
  'model-differs': 'the model differs',
  'override-fresh': 'set to start fresh',
  'override-other-vendor': 'set to a different vendor',
  'resume-failed': 'resuming failed',
  'implement-skipped': 'Implement was skipped',
  'context-heavy': 'the Implement session was nearly full',
  'plan-skipped': 'Plan was skipped',
  'plan-vendor-differs': 'Plan ran on another vendor',
  'mode-switch-unsupported': 'the vendor cannot change the mode of a resumed session',
}

export const SESSION_NOTE = {
  reusedImplement: 'reused the Implement session',
  /** Continuity: Implement continued Plan's session. */
  reusedPlan: 'continued the Plan session',
  /** Fix until green: a later round continues the previous round's Fix session. */
  reusedRound: "continued the previous round's session",
  resumed: 'resumed the previous session',
  fresh: (reason: FreshReason): string => `fresh session: ${FRESH_REASON_TEXT[reason]}`,
} as const
