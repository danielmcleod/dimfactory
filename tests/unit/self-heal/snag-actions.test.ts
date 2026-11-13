// Snag recovery lists (the failure table's "Recovery (primary first)"; a Snag card's Ask AI is primary only
// for unknown) and switch_vendor gating ("switch_vendor is built but renders disabled until a
// second vendor is ready"; a fake ready vendor stands
// in here).
import { describe, expect, it } from 'vitest'
import type { Failure, RecoveryAction } from '@shared/failure.ts'
import { FAILURE_CATEGORIES } from '@shared/failure.ts'
import type { PassName, StepKey } from '@shared/run.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { LATER_VERSION_MESSAGE } from '@core/recovery/dispatcher.ts'
import { FRESH_SESSION_LABEL, snagActions, waitUntilFor } from '@core/recovery/snag-actions.ts'
import type { SnagActionInput } from '@core/recovery/snag-actions.ts'
import { switchTargetFor } from '@core/recovery/switch-vendor.ts'
import type { Readiness, VendorChoice, VendorReadiness } from '@core/recovery/switch-vendor.ts'

const AT = 1_800_000_000_000

const failure = (category: Failure['category'], o: Partial<Failure> = {}): Failure => ({
  category,
  message: 'x',
  raw: '',
  classifiedBy: 'structured',
  ...o,
})

function actions(category: Failure['category'], o: Partial<SnagActionInput> = {}): RecoveryAction[] {
  return snagActions({
    step: 'implement',
    failure: failure(category),
    hasSession: true,
    hints: [],
    at: AT,
    vendor: 'claude',
    vendorName: 'Claude',
    platform: 'win32',
    config: resolveBuiltinConfig({ profile: 'claude-only' }),
    testedUpTo: '2.1.290',
    clockText: () => '14:05',
    ...o,
  })
}

const kinds = (a: readonly RecoveryAction[]): string[] => a.map((x) => x.kind)

/** Registry with Claude built and ready plus the given vendors. */
function readiness(vendors: VendorChoice[], ready: Record<string, Readiness> = {}): VendorReadiness {
  return {
    vendors: () => [{ id: 'claude', displayName: 'Claude', built: true }, ...vendors],
    readyFor: (v) => ready[v] ?? { ok: false, reason: `${v} is not ready: not logged in.` },
  }
}

describe('snagActions (failure table)', () => {
  it('every category: unique ids, no placeholder, no em dash; Close run last', () => {
    for (const category of FAILURE_CATEGORIES) {
      for (const step of ['plan', 'implement', 'review', 'fix', 'preflight'] as StepKey[]) {
        const a = actions(category, { step, hints: ['claude-env-key'] })
        const ids = a.map((x) => x.id)
        expect(new Set(ids).size, `${category} ${step}`).toBe(ids.length)
        for (const x of a) {
          const text = JSON.stringify(x)
          expect(text, `${category} ${x.id}`).not.toMatch(/\{\{\w+\}\}/)
          expect(text, `${category} ${x.id}`).not.toContain('\u2014')
        }
        expect(a.at(-1)?.kind, `${category} ${step}`).toBe('close_run')
      }
    }
  })

  it('unknown: Diagnose with AI first; a known category offers it after its own fixes; never for content_policy', () => {
    expect(kinds(actions('unknown')).slice(0, 2)).toEqual(['heal', 'retry'])
    const auth = actions('auth_required')
    expect(auth[0]).toMatchObject({ id: 'implement:login', kind: 'shell_copy', command: 'claude auth login' })
    expect(auth.findIndex((x) => x.kind === 'heal')).toBeGreaterThan(0)
    expect(kinds(actions('content_policy'))).not.toContain('heal')
    expect(kinds(actions('ask_timeout'))).not.toContain('heal')
    // flag_drift keeps its own wording.
    expect(actions('flag_drift')[0]).toMatchObject({ kind: 'heal', label: 'Find the renamed flag' })
  })

  it("flag_drift copies the pinned install of the tested version; auth's login reason names the vendor", () => {
    const pin = actions('flag_drift').find((x) => x.id === 'implement:pin')
    expect(pin).toMatchObject({
      kind: 'shell_copy',
      command: 'npm install -g @anthropic-ai/claude-code@2.1.290',
    })
    const login = actions('auth_expired').find((x) => x.id === 'implement:login')
    expect(login?.kind === 'shell_copy' && login.reason).toBe(
      'Sign in to Claude in a terminal, then re-check.',
    )
    expect(login?.kind === 'shell_copy' && login.recheck).toBe('vendor.claude.auth')
  })

  it("model_unavailable: the default-model config_patch on the run's config, with its diff", () => {
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const a = actions('model_unavailable', { step: 'plan', config: cfg }).find(
      (x) => x.kind === 'config_patch',
    )
    expect(a).toEqual({
      id: 'plan:default-model',
      label: "Use Claude's default model",
      kind: 'config_patch',
      target: 'resolved',
      ops: [{ op: 'replace', path: '/passes/plan/model', value: null }],
      preview: '- passes.plan.model: "opus"\n+ passes.plan.model: null',
    })
    // Already on the default model: nothing to drop.
    expect(kinds(actions('model_unavailable', { step: 'implement', config: cfg }))).not.toContain(
      'config_patch',
    )
  })

  it('turn_limit: Continue (resume) with a session, and the limit dropped from extraArgs when it is there', () => {
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const withLimit = {
      ...cfg,
      vendors: {
        claude: {
          path: null,
          defaultModel: null,
          defaultEffort: null,
          extraArgs: ['--max-turns', '5', '--debug'],
          env: {},
          flagMap: {},
        },
      },
    }
    const a = actions('turn_limit', { config: withLimit })
    expect(a[0]).toMatchObject({ id: 'implement:continue', kind: 'resume', continuation: 'continue' })
    expect(a.find((x) => x.id === 'implement:drop-limit')).toMatchObject({
      kind: 'config_patch',
      ops: [{ op: 'replace', path: '/vendors/claude/extraArgs', value: ['--debug'] }],
    })
    // The default resume retry is replaced by the category's own Resume.
    expect(a.filter((x) => x.id === 'implement:resume')).toEqual([])
    expect(kinds(actions('turn_limit', { hasSession: false }))).not.toContain('resume')
    expect(kinds(actions('turn_limit', { step: 'review' }))).not.toContain('resume')
  })

  it('rate_limited / quota_exceeded: a wait_until at the reset (armed for a rate limit only)', () => {
    const rl = actions('rate_limited', { failure: failure('rate_limited', { resetsAt: AT + 600_000 }) })
    expect(rl[0]).toEqual({
      id: 'implement:wait',
      label: 'Retry at 14:05',
      kind: 'wait_until',
      until: AT + 600_000,
      armed: true,
    })
    const q = actions('quota_exceeded', { failure: failure('quota_exceeded', { resetsAt: AT + 7_200_000 }) })
    expect(q[0]).toMatchObject({
      kind: 'wait_until',
      armed: false,
      label: 'Retry when the limit resets (14:05)',
    })
    expect(q.some((x) => x.kind === 'open_docs')).toBe(true)
    // No reset time: no wait (Dim Factory never invents a reset time); Retry and switch_vendor remain.
    expect(kinds(actions('quota_exceeded'))).not.toContain('wait_until')
    expect(kinds(actions('rate_limited'))).not.toContain('wait_until')
    expect(kinds(actions('rate_limited'))).toContain('retry')
    expect(waitUntilFor(failure('rate_limited'), AT)).toBeNull()
    expect(waitUntilFor(failure('rate_limited', { retryAfterMs: 5_000 }), AT)).toBe(AT + 5_000)
    expect(waitUntilFor(failure('network'), AT)).toBeNull()
  })

  it('context_exceeded: Review, Critic and Fix retry with a trimmed diff; Plan and Implement in a fresh session', () => {
    for (const step of ['review', 'critic', 'fix'] as const) {
      expect(actions('context_exceeded', { step })[0]).toMatchObject({
        id: `${step}:retry-fresh`,
        label: 'Retry fresh with a trimmed diff',
        kind: 'retry',
        strategy: 'fresh',
      })
    }
    for (const step of ['plan', 'implement'] as const) {
      expect(actions('context_exceeded', { step })[0]).toMatchObject({
        id: `${step}:retry-fresh`,
        label: FRESH_SESSION_LABEL,
        strategy: 'fresh',
      })
    }
  })

  it('the Codex sandbox setup and the folder trust grant are live', () => {
    const sb = actions('sandbox_unavailable', { vendor: 'codex', vendorName: 'Codex' })
    // The vendor_setup executor is built: the unelevated setup runs on its click (tests/unit/balanced/engine).
    expect(sb[0]).toMatchObject({ kind: 'vendor_setup', params: { mode: 'unelevated' } })
    expect(sb[0]?.disabledReason).toBeUndefined()
    expect(sb.find((x) => x.kind === 'shell_copy')).toMatchObject({ elevated: true })
    // The vendorFolder grant executor is built: the grant writes trust.json, then Retry (tests/unit/gemini/engine).
    const trust = actions('trust_required', { vendor: 'gemini', vendorName: 'Gemini' })
    expect(trust[0]).toMatchObject({
      kind: 'grant',
      grant: 'vendorFolder',
      vendor: 'gemini',
    })
    expect(trust[0]?.disabledReason).toBeUndefined()
    expect(JSON.stringify(trust)).not.toContain(LATER_VERSION_MESSAGE)
  })

  it('a large-folder snapshot failure offers the largeFolder grant; git state its copyable commands', () => {
    const snap = actions('snapshot_failed', {
      failure: failure('snapshot_failed', {
        message: 'The folder is very large (limit: 20,000 files or 1 GB)',
      }),
    })
    expect(snap.find((x) => x.kind === 'grant')).toMatchObject({ grant: 'largeFolder' })
    expect(kinds(actions('snapshot_failed'))).not.toContain('grant')
    const git = actions('git_state', {
      failure: failure('git_state', {
        message: 'fatal: detected dubious ownership in repository; a merge is in progress',
      }),
      folder: 'C:\\work\\app',
    })
    expect(git.find((x) => x.id === 'implement:safeDirectory')).toMatchObject({
      command: 'git config --global --add safe.directory "C:/work/app"',
    })
    expect(git.find((x) => x.id === 'implement:abort')).toMatchObject({ command: 'git merge --abort' })
  })
})

describe('switch_vendor gating', () => {
  const pass: PassName = 'implement'

  it('with Claude the only built vendor: offered, disabled with the reason', () => {
    const r = readiness([
      { id: 'codex', displayName: 'Codex', built: false },
      { id: 'gemini', displayName: 'Gemini', built: false },
    ])
    const t = switchTargetFor('claude', pass, 'autoedit', r)
    expect(t).toEqual({
      to: 'codex',
      displayName: 'Codex',
      model: null,
      disabledReason: 'Codex is not available in this build.',
    })
    const a = actions('vendor_internal', { switchTarget: t })
    expect(a.find((x) => x.kind === 'switch_vendor')).toEqual({
      id: 'implement:switch',
      label: 'Use Codex instead',
      kind: 'switch_vendor',
      pass: 'implement',
      to: 'codex',
      model: null,
      disabledReason: 'Codex is not available in this build.',
    })
    // No other vendor at all: no switch.
    expect(switchTargetFor('claude', pass, 'autoedit', readiness([]))).toBeNull()
  })

  it('a built vendor that is not ready: disabled with its readiness reason', () => {
    const r = readiness([{ id: 'codex', displayName: 'Codex', built: true }])
    expect(switchTargetFor('claude', pass, 'autoedit', r)?.disabledReason).toBe(
      'codex is not ready: not logged in.',
    )
  })

  it('a ready vendor (a fake one here) is offered enabled, preferring Claude and Codex', () => {
    const r = readiness(
      [
        { id: 'gemini', displayName: 'Gemini', built: true },
        { id: 'codex', displayName: 'Codex', built: true },
      ],
      { gemini: { ok: true }, codex: { ok: true } },
    )
    expect(switchTargetFor('claude', pass, 'autoedit', r)).toEqual({
      to: 'codex',
      displayName: 'Codex',
      model: null,
    })
    const onlyGemini = readiness([{ id: 'gemini', displayName: 'Gemini', built: true }], {
      gemini: { ok: true },
    })
    expect(switchTargetFor('claude', pass, 'readonly', onlyGemini)?.to).toBe('gemini')
    // From another vendor, Claude comes first.
    expect(switchTargetFor('codex', pass, 'autoedit', readiness([], { claude: { ok: true } }))).toEqual({
      to: 'claude',
      displayName: 'Claude',
      model: null,
    })
    const a = actions('vendor_internal', { switchTarget: switchTargetFor('claude', pass, 'autoedit', r) })
    expect(a.find((x) => x.kind === 'switch_vendor')?.disabledReason).toBeUndefined()
  })
})
