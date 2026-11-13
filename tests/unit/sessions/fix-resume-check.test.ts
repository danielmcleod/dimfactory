// `pass.fix.resume` (info) and the composer's fixSession suggestion (sessions, the Fix row):
// one static decision (sessions.ts previewFixSession) — the Fix row's choice, the vendors, the Fix vendor's resume
// capability and model switch — worded by the check and returned by config.resolve's suggestions alike. Live and
// authoritative only; it never asks the adapter (canResume is a runtime fact).
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { Capabilities } from '@shared/vendors.ts'
import { claudeCapabilities } from '@core/adapters/claude/capabilities.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { composerSuggestions } from '@core/config/suggestions.ts'
import type { ReadyVendorInfo } from '@core/config/suggestions.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import { FRESH_REASON_TEXT, PREVIEW_SESSION_ID, previewFixSession } from '@core/supervisor/sessions.ts'
import { fakeAdapter, fakeRegistry, healthyChecks, healthyDeps, probeResult } from '../preflight/helpers.ts'

type Caps = Pick<Capabilities, 'resume' | 'resumeModelSwitch'>

const CLAUDE_CAPS: Caps = { resume: 'id', resumeModelSwitch: true }

function config(fix: Record<string, unknown> = {}): ResolvedConfig {
  return resolveBuiltinConfig({ profile: 'claude-only', overrides: { passes: { fix } } })
}

interface World {
  /** Vendors in the probe store (healthy), with their resume capabilities. */
  probed: Partial<Record<'claude' | 'codex', Caps>>
}

async function fixResume(cfg: ResolvedConfig, w: World, mode: 'live' | 'authoritative' = 'live') {
  const claude = fakeAdapter('claude')
  const codex = fakeAdapter('codex')
  const canResume = vi.fn(() => Promise.resolve({ ok: true }))
  claude.canResume = canResume
  codex.canResume = canResume
  const engine = createPreflightEngine(healthyDeps({ adapters: fakeRegistry(claude, codex) }))
  for (const [id, caps] of Object.entries(w.probed)) {
    const p = probeResult(id, 1_000_000, healthyChecks(id, 1_000_000))
    p.capabilities = { ...p.capabilities, ...caps }
    engine.recordProbe(p)
  }
  const report = await engine.run(mode, { config: cfg })
  expect(canResume).not.toHaveBeenCalled()
  return { report, check: find(report, 'pass.fix.resume') }
}

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
const find = (r: PreflightReport, id: string): CheckResult | undefined => all(r).find((c) => c.id === id)

/** What config.resolve would suggest for the same world (ConfigService.readyVendors' shape). */
function suggestion(cfg: ResolvedConfig, w: World): ReturnType<typeof composerSuggestions>['fixSession'] {
  const ready: ReadyVendorInfo[] = Object.entries(w.probed).map(([id, capabilities]) => ({
    id,
    support: () => 'supported',
    capabilities,
  }))
  return composerSuggestions(cfg, ready).fixSession
}

describe('pass.fix.resume', () => {
  it('claude-only: info "Fix will continue Implement’s session" — the composer says Reuse', async () => {
    const cfg = config()
    const { report, check } = await fixResume(cfg, { probed: { claude: CLAUDE_CAPS } })
    expect(check).toMatchObject({
      scope: 'pass',
      status: 'pass',
      blocking: false,
      title: "Fix will continue Implement's session",
      detail: "Claude resumes the session Implement leaves, so Fix keeps Implement's context.",
    })
    expect(report.info.map((c) => c.id)).toContain('pass.fix.resume')
    expect(report.warnings.map((c) => c.id)).not.toContain('pass.fix.resume')
    expect(suggestion(cfg, { probed: { claude: CLAUDE_CAPS } })).toEqual({ choice: 'reuse' })
  })

  it.each([
    [
      'Fresh session',
      { reuseSession: false },
      { claude: CLAUDE_CAPS },
      'override-fresh',
      'The Fix session is set to start fresh: it gets the task, the plan and the changes so far instead of ' +
        "continuing Implement's conversation.",
      'fresh',
    ],
    [
      'Fresh, different vendor (Codex ready)',
      { reuseSession: false, vendor: 'codex', model: null },
      { claude: CLAUDE_CAPS, codex: { resume: 'id', resumeModelSwitch: true } },
      'override-other-vendor',
      'Fix is set to start fresh on Codex: it gets the task, the plan and the changes so far instead of ' +
        "continuing Implement's conversation.",
      'fresh-other',
    ],
    [
      'a Fix vendor override with reuseSession on',
      { vendor: 'codex', model: null },
      { claude: CLAUDE_CAPS, codex: { resume: 'id', resumeModelSwitch: true } },
      'vendor-differs',
      'Fix runs on Codex and Implement on Claude; a session cannot move between vendors.',
      'fresh-other',
    ],
    [
      'a vendor that cannot resume',
      {},
      { claude: { resume: 'none', resumeModelSwitch: true } },
      'cannot-resume',
      'Claude cannot continue a session, so Fix starts a new one.',
      'fresh',
    ],
    [
      'another model on a vendor that cannot switch',
      { model: 'opus' },
      { claude: { resume: 'id', resumeModelSwitch: false } },
      'model-differs',
      "Fix uses opus and Implement the CLI's default model; Claude cannot switch models when it resumes a session.",
      'fresh',
    ],
  ] as const)('%s → "Fix will start fresh: …" (%s)', async (_n, fix, probed, reason, detail, choice) => {
    const cfg = config(fix)
    const { check } = await fixResume(cfg, { probed })
    expect(check).toMatchObject({
      status: 'pass',
      title: `Fix will start fresh: ${FRESH_REASON_TEXT[reason]}`,
      detail,
    })
    expect(suggestion(cfg, { probed })).toEqual({ choice, reason })
  })

  it('a model switch the vendor supports still continues the session, and says so', async () => {
    const { check } = await fixResume(config({ model: 'opus' }), { probed: { claude: CLAUDE_CAPS } })
    expect(check).toMatchObject({
      title: "Fix will continue Implement's session",
      detail:
        "Claude resumes the session Implement leaves, so Fix keeps Implement's context. It switches the " +
        'session to opus.',
    })
  })

  it('"Fresh, different vendor" needs that vendor ready; otherwise it reads as plain Fresh, here and in the composer', async () => {
    const cfg = config({ reuseSession: false, vendor: 'codex', model: null })
    const { check } = await fixResume(cfg, { probed: { claude: CLAUDE_CAPS } })
    expect(check?.title).toBe('Fix will start fresh: set to start fresh')
    expect(suggestion(cfg, { probed: { claude: CLAUDE_CAPS } })).toEqual({
      choice: 'fresh-other',
      reason: 'override-fresh',
    })
  })

  it('runs in live and authoritative preflight, never at the pass boundary, and only with Fix enabled', async () => {
    expect(
      (await fixResume(config(), { probed: { claude: CLAUDE_CAPS } }, 'authoritative')).check,
    ).toBeDefined()
    const claude = fakeAdapter('claude')
    const engine = createPreflightEngine(healthyDeps({ adapters: fakeRegistry(claude) }))
    engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
    const boundary = await engine.run('passBoundary', { config: config(), pass: 'fix' })
    expect(find(boundary, 'pass.fix.resume')).toBeUndefined()
    const off = await engine.run('live', { config: config({ enabled: false }) })
    expect(find(off, 'pass.fix.resume')).toBeUndefined()
  })
})

describe('one decision for the check and the composer', () => {
  it('over vendors × reuseSession × models × capabilities × readiness, the check words what the composer returns', async () => {
    const capsList: Caps[] = [
      CLAUDE_CAPS,
      { resume: 'id', resumeModelSwitch: false },
      { resume: 'none', resumeModelSwitch: true },
    ]
    for (const vendor of ['claude', 'codex'] as const)
      for (const reuseSession of [true, false])
        for (const model of [null, 'opus'])
          for (const caps of capsList)
            for (const codexReady of [true, false]) {
              const cfg = config({ vendor, model, reuseSession })
              const probed: World['probed'] = codexReady ? { claude: caps, codex: caps } : { claude: caps }
              const { check } = await fixResume(cfg, { probed })
              const s = suggestion(cfg, { probed })
              const words =
                s.reason === undefined
                  ? "Fix will continue Implement's session"
                  : `Fix will start fresh: ${FRESH_REASON_TEXT[s.reason]}`
              expect(check?.title, JSON.stringify({ vendor, reuseSession, model, caps, codexReady })).toBe(
                words,
              )
            }
  })

  it('previewFixSession is decideSession with Implement done in a placeholder session', () => {
    const p = {
      implement: { vendor: 'claude', model: null },
      fix: { vendor: 'claude', model: null, reuseSession: true },
    }
    expect(previewFixSession(p)).toEqual({ reuse: true, sessionId: PREVIEW_SESSION_ID })
    expect(previewFixSession(p, { capabilities: claudeCapabilities() })).toEqual({
      reuse: true,
      sessionId: PREVIEW_SESSION_ID,
    })
    expect(previewFixSession({ ...p, fix: { ...p.fix, reuseSession: false, vendor: 'codex' } })).toEqual({
      reuse: false,
      reason: 'override-other-vendor',
    })
    expect(
      previewFixSession(
        { ...p, fix: { ...p.fix, reuseSession: false, vendor: 'codex' } },
        { otherVendorReady: false },
      ),
    ).toEqual({ reuse: false, reason: 'override-fresh' })
  })
})
