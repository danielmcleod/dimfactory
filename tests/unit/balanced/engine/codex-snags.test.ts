// Codex failures through the classifier into their snag (the failure table's "X" detection with structured
// `codexErrorInfo` and "Recovery (primary first)"; executors vendor_setup, switch_vendor;
// switch_vendor goes live once a second vendor is ready). Each case is an app-server or exec frame the Codex adapter
// hands to `classify`, then the snag list the controller builds for it with a ready Claude as the switch target.
import { describe, expect, it } from 'vitest'
import type { Failure, RecoveryAction } from '@shared/failure.ts'
import type { Mode, PassName } from '@shared/run.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { classify } from '@core/heal/classify.ts'
import type { ClassifyInput } from '@core/heal/classify.ts'
import { snagActions } from '@core/recovery/snag-actions.ts'
import { switchTargetFor } from '@core/recovery/switch-vendor.ts'
import type { Readiness, VendorReadiness } from '@core/recovery/switch-vendor.ts'

const AT = 1_800_000_000_000
const EM_DASH = '—'

/** app-server `turn/completed` with a failed turn and its structured `codexErrorInfo`. */
const turnFailed = (codexErrorInfo: unknown, message: string): object => ({
  method: 'turn/completed',
  params: {
    threadId: 'thr_1',
    turn: {
      id: 'turn_1',
      items: [],
      status: 'failed',
      error: { message, codexErrorInfo, additionalDetails: null },
    },
  },
})

function failureOf(input: Omit<ClassifyInput, 'failed' | 'now'>): Failure {
  const f = classify({ ...input, failed: true, now: AT })
  if (f === null) throw new Error('no failure')
  return f
}

/** Claude built and ready for everything; Codex is the failing vendor. */
const vendors: VendorReadiness = {
  vendors: () => [
    { id: 'claude', displayName: 'Claude', built: true },
    { id: 'codex', displayName: 'Codex', built: true },
    { id: 'gemini', displayName: 'Gemini', built: false },
  ],
  readyFor: (): Readiness => ({ ok: true }),
}

function snag(f: Failure, o: { vendor?: string; step?: PassName; mode?: Mode; hasSession?: boolean } = {}) {
  const step = o.step ?? 'implement'
  const mode = o.mode ?? 'autoedit'
  const vendor = o.vendor ?? 'codex'
  return snagActions({
    step,
    failure: f,
    hasSession: o.hasSession ?? true,
    hints: [],
    at: AT,
    vendor,
    vendorName: 'Codex',
    platform: 'win32',
    config: resolveBuiltinConfig({ profile: 'balanced' }),
    testedUpTo: '0.160.1',
    mode,
    switchTarget: switchTargetFor(vendor, step, mode, vendors),
    clockText: () => '14:05',
  })
}

const kinds = (a: readonly RecoveryAction[]): string[] => a.map((x) => x.kind)

/** The category's own actions (before the default Resume / Retry / Close run set). */
const leading = (a: readonly RecoveryAction[], n: number): string[] => kinds(a).slice(0, n)

describe('Codex errors → category (structured codexErrorInfo first, failure table X column)', () => {
  it.each([
    ['sandboxError', 'sandbox_unavailable'],
    ['unauthorized', 'auth_expired'],
    ['usageLimitExceeded', 'quota_exceeded'],
    ['sessionBudgetExceeded', 'quota_exceeded'],
    ['rateLimitExceeded', 'rate_limited'],
    ['contextWindowExceeded', 'context_exceeded'],
    ['cyberPolicy', 'content_policy'],
    ['serverOverloaded', 'vendor_internal'],
    ['tooManyDenials', 'permission_denied'],
    ['threadRollbackFailed', 'resume_failed'],
    [{ httpConnectionFailed: { httpStatusCode: null } }, 'network'],
  ] as const)('%j → %s', (info, category) => {
    const f = failureOf({ vendor: 'codex', structured: [turnFailed(info, 'The turn failed.')] })
    expect(f.category).toBe(category)
    expect(f.classifiedBy).toBe('structured')
  })

  it('a loopback preset: the server not answering is local_server, not a network problem', () => {
    const frame = turnFailed({ httpConnectionFailed: { httpStatusCode: null } }, 'error sending request')
    expect(failureOf({ vendor: 'local-ollama', structured: [frame] }).category).toBe('local_server')
  })

  it('exec route: the startup banner reporting read-only after autoedit was asked for is sandbox_unavailable', () => {
    const tail = ['sandbox: read-only']
    expect(failureOf({ vendor: 'codex', stderrTail: tail, exitCode: 1, mode: 'autoedit' }).category).toBe(
      'sandbox_unavailable',
    )
    // The same banner on a read-only pass is what was asked for: not a sandbox failure.
    expect(failureOf({ vendor: 'codex', stderrTail: tail, exitCode: 1, mode: 'readonly' }).category).not.toBe(
      'sandbox_unavailable',
    )
  })

  it('a refused thread/resume is resume_failed (retried fresh without spending the budget)', () => {
    const f = failureOf({
      vendor: 'codex',
      rpcError: { method: 'thread/resume', code: -32600, message: 'no rollout' },
    })
    expect(f.category).toBe('resume_failed')
  })
})

describe('Codex snags in failure-table order (switch_vendor live: Claude is ready)', () => {
  it('sandbox_unavailable: the unelevated setup first, then the elevated command, then another vendor', () => {
    const f = failureOf({
      vendor: 'codex',
      structured: [turnFailed('sandboxError', 'CreateRestrictedToken failed')],
    })
    const a = snag(f)
    expect(leading(a, 3)).toEqual(['vendor_setup', 'shell_copy', 'switch_vendor'])
    expect(a[0]).toMatchObject({
      kind: 'vendor_setup',
      vendor: 'codex',
      call: 'windowsSandbox/setupStart',
      params: { mode: 'unelevated' },
    })
    expect(a[0]?.disabledReason).toBeUndefined()
    expect(a[1]).toMatchObject({
      kind: 'shell_copy',
      command: 'codex sandbox setup --elevated --current-user',
      elevated: true,
      recheck: 'vendor.codex.winSandbox',
    })
    expect(a[2]).toMatchObject({ kind: 'switch_vendor', to: 'claude', pass: 'implement', model: null })
    expect(a[2]?.disabledReason).toBeUndefined()
    expect(kinds(a).at(-1)).toBe('close_run')
  })

  it('a local preset’s sandbox is Codex’s: the same setup, elevated command and re-check', () => {
    const f: Failure = { category: 'sandbox_unavailable', message: 'x', raw: '', classifiedBy: 'structured' }
    const a = snag(f, { vendor: 'local-ollama' })
    expect(a[0]).toMatchObject({ kind: 'vendor_setup', vendor: 'codex' })
    expect(a[1]).toMatchObject({
      kind: 'shell_copy',
      command: 'codex sandbox setup --elevated --current-user',
      recheck: 'vendor.codex.winSandbox',
    })
  })

  it('auth_expired (unauthorized mid-run): copy `codex login`, re-check its auth, else another vendor', () => {
    const a = snag(
      failureOf({ vendor: 'codex', structured: [turnFailed('unauthorized', '401 Unauthorized')] }),
    )
    expect(leading(a, 2)).toEqual(['shell_copy', 'switch_vendor'])
    expect(a[0]).toMatchObject({ command: 'codex login', recheck: 'vendor.codex.auth' })
  })

  it('quota_exceeded with a reset: the wait is offered disarmed, then another vendor, then the docs', () => {
    const f = failureOf({
      vendor: 'codex',
      structured: [turnFailed('usageLimitExceeded', "You've hit your usage limit. Try again in 2 hours.")],
    })
    expect(f).toMatchObject({ category: 'quota_exceeded', resetsAt: AT + 7_200_000 })
    const a = snag(f)
    expect(leading(a, 3)).toEqual(['wait_until', 'switch_vendor', 'open_docs'])
    expect(a[0]).toMatchObject({ until: AT + 7_200_000, armed: false })
  })

  it('rate_limited with a reset: the wait is armed, then another vendor', () => {
    const f = failureOf({
      vendor: 'codex',
      structured: [turnFailed('rateLimitExceeded', 'Rate limit reached. Please try again in 30s.')],
    })
    expect(f).toMatchObject({ category: 'rate_limited', retryAfterMs: 30_000 })
    const a = snag(f)
    expect(leading(a, 2)).toEqual(['wait_until', 'switch_vendor'])
    expect(a[0]).toMatchObject({ armed: true })
  })

  it('context_exceeded on Implement: a fresh session first (no diff to trim), then another vendor', () => {
    const a = snag(
      failureOf({
        vendor: 'codex',
        structured: [turnFailed('contextWindowExceeded', 'context window exceeded')],
      }),
    )
    expect(a[0]).toMatchObject({ kind: 'retry', strategy: 'fresh', label: 'Retry in a fresh session' })
    expect(kinds(a)).toContain('switch_vendor')
  })

  it('content_policy: another vendor and never "Diagnose with AI"', () => {
    const a = snag(failureOf({ vendor: 'codex', structured: [turnFailed('cyberPolicy', 'refused')] }))
    expect(a[0]?.kind).toBe('switch_vendor')
    expect(kinds(a)).not.toContain('heal')
  })

  it('local_server: start the server, the presets, another vendor', () => {
    const frame = turnFailed(
      { responseStreamConnectionFailed: { httpStatusCode: null } },
      'connection refused',
    )
    const a = snag(failureOf({ vendor: 'local-ollama', structured: [frame] }), { vendor: 'local-ollama' })
    expect(leading(a, 3)).toEqual(['shell_copy', 'settings_link', 'switch_vendor'])
    expect(a[0]).toMatchObject({ command: 'ollama serve' })
    expect(a[1]).toMatchObject({ pointer: '/local/presets' })
    // A local preset's switch goes to a hosted vendor (Claude first).
    expect(a[2]).toMatchObject({ to: 'claude' })
  })

  it('a Claude failure now offers Codex once Codex is ready, and names why when it is not', () => {
    const f: Failure = { category: 'auth_required', message: 'Not logged in', raw: '', classifiedBy: 'regex' }
    const ready = switchTargetFor('claude', 'implement', 'autoedit', vendors)
    expect(ready).toEqual({ to: 'codex', displayName: 'Codex', model: null })
    const noSandbox: VendorReadiness = {
      vendors: () => vendors.vendors(),
      readyFor: (v, _p, mode) =>
        v === 'codex' && mode === 'autoedit'
          ? { ok: false, reason: 'Codex cannot run Implement this way: Needs the Codex Windows sandbox.' }
          : { ok: true },
    }
    const blocked = switchTargetFor('claude', 'implement', 'autoedit', noSandbox)
    expect(blocked).toMatchObject({
      to: 'codex',
      disabledReason: 'Codex cannot run Implement this way: Needs the Codex Windows sandbox.',
    })
    // Read-only passes do not need the sandbox: Review can switch.
    expect(switchTargetFor('claude', 'review', 'readonly', noSandbox)).toEqual({
      to: 'codex',
      displayName: 'Codex',
      model: null,
    })
    const a = snagActions({
      step: 'implement',
      failure: f,
      hasSession: false,
      hints: [],
      at: AT,
      vendor: 'claude',
      vendorName: 'Claude',
      platform: 'win32',
      mode: 'autoedit',
      switchTarget: blocked,
    })
    expect(a.find((x) => x.kind === 'switch_vendor')).toMatchObject({
      to: 'codex',
      disabledReason: 'Codex cannot run Implement this way: Needs the Codex Windows sandbox.',
    })
  })

  it('no snag text carries an em dash', () => {
    for (const info of ['sandboxError', 'unauthorized', 'usageLimitExceeded', 'cyberPolicy']) {
      for (const x of snag(failureOf({ vendor: 'codex', structured: [turnFailed(info, 'failed')] }))) {
        expect(x.label).not.toContain(EM_DASH)
        if ('reason' in x && typeof x.reason === 'string') expect(x.reason).not.toContain(EM_DASH)
        if (x.disabledReason !== undefined) expect(x.disabledReason).not.toContain(EM_DASH)
      }
    }
  })
})
