// Config and recovery with a third vendor, through a real core (built-in profiles and first launch's Claude ×
// Codex matrix; the probe's "'More' list"; `switch_vendor` "the first other built vendor that is ready for the
// pass's mode (Claude and Codex first)"; the cost's `catalog` basis, "Subscription auth shows API-equiv.",
// estimates "model:null resolves to the probe's isDefault model"; "pricing.seed.json holds prices for the
// built-in profile models"):
//   - Gemini sits under "More": first launch still decides between Claude and Codex only, and a ready Gemini never
//     makes a profile; the built-in profiles name no Gemini pass
//   - a logged-out Claude Implement offers the first ready other vendor: Codex while it is ready, else Gemini; the
//     click moves Implement to Gemini and the run finishes
//   - estimates and a Gemini pass's cost come from the catalog (the seed has no Gemini price), API-equivalent on a
//     Google login; without a price the estimate names the missing model
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_PROFILES } from '../../../../src/core/config/defaults.ts'
import { codexHangs, ScriptedCodex } from '../../../unit/balanced/engine/helpers.ts'
import { GEMINI_DEFAULT_MODEL } from '../../../unit/gemini/engine/helpers.ts'
import { claudeLoggedOutScript } from '../../balanced/engine/helpers.ts'
import {
  IMPLEMENT_MATCH,
  ScriptedGemini,
  World,
  failedWithSnag,
  geminiPlays,
  settled,
  snagOf,
  value,
} from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const PLAN = { plan: { recording: 'C06-plan-native-host' } }
const userProfile = (home: string): unknown =>
  (JSON.parse(readFileSync(join(home, 'dimfactory.json'), 'utf8')) as { profile?: unknown }).profile

describe('Gemini under "More" (not in built-in profiles, not in the first-launch matrix)', () => {
  it('no built-in profile names Gemini', () => {
    for (const [name, p] of Object.entries(BUILTIN_PROFILES)) {
      expect(JSON.stringify(p), name).not.toContain('gemini')
    }
  })

  it('the registry lists Gemini built, under More; Claude and Codex stay the primary section', async () => {
    const t = await w.boot({}, new ScriptedGemini(geminiPlays([{}])))
    const gemini = t.core.adapters.list().find((e) => e.id === 'gemini')
    expect(gemini).toMatchObject({ built: true, section: 'more', experimental: false })
    expect(t.core.adapters.primary().map((e) => e.id)).toEqual(['claude', 'codex'])
  }, 120_000)

  it('Claude ready and Gemini ready: claude-only (Gemini does not make it balanced)', async () => {
    const t = await w.boot({}, new ScriptedGemini(geminiPlays([{}])), {
      codex: new ScriptedCodex(codexHangs, { auth: 'fail' }),
    })
    const out = await t.core.firstLaunch()
    expect(out).toMatchObject({
      status: 'completed',
      selection: { profile: 'claude-only', claudeReady: true, codexReady: false },
    })
    expect(userProfile(t.home)).toBe('claude-only')
  }, 120_000)

  it('only Gemini ready: first launch waits (nothing written); Gemini is chosen per pass in the composer', async () => {
    // Claude signed out on the fake (hermetic: never the developer's own, possibly signed-in, Claude CLI).
    const t = await w.boot({}, new ScriptedGemini(geminiPlays([{}])), {
      codex: new ScriptedCodex(codexHangs, { auth: 'fail' }),
      claudeLoggedOut: true,
    })
    const out = await t.core.firstLaunch()
    expect(out).toMatchObject({
      status: 'deferred',
      reason: 'no-vendor-ready',
      selection: { claudeReady: false, codexReady: false },
    })
    expect(userProfile(t.home)).toBeUndefined()
  }, 120_000)
})

describe('switch_vendor among Claude, Codex and Gemini (per readiness)', () => {
  const LOGGED_OUT = [{ name: 'implement-logged-out', match: IMPLEMENT_MATCH, ops: claudeLoggedOutScript() }]
  const CLAUDE_ONLY = { profile: 'claude-only', gates: { afterPlan: false } }

  it('Codex not ready: a logged-out Claude Implement offers Gemini; the click moves Implement there', async () => {
    const gemini = new ScriptedGemini(geminiPlays([{ file: 'src/version.ts', text: 'Added --version.' }]))
    const t = await w.boot(PLAN, gemini, {
      codex: new ScriptedCodex(codexHangs, { auth: 'fail' }),
      trust: true,
      first: LOGGED_OUT,
    })
    const { runId, c } = await w.start(t, CLAUDE_ONLY)
    const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
    expect(failed.steps.implement.failure).toMatchObject({ category: 'auth_required' })
    const sw = snagOf(t.events, 'implement')?.actions.find((a) => a.kind === 'switch_vendor')
    expect(sw).toMatchObject({ to: 'gemini', pass: 'implement', model: null, label: 'Use Gemini instead' })
    expect(sw?.disabledReason).toBeUndefined()

    const r = value(await t.core.invoke('recovery.execute', { actionId: sw?.id ?? '', runId }))
    expect(r.message).toBe('Switched to Gemini. Retrying Implement.')
    const done = await c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
    expect(done.steps.implement).toMatchObject({ status: 'done', vendor: 'gemini' })
    expect(gemini.starts.map((s) => [s.step, s.mode, s.trustFolder])).toEqual([
      ['implement', 'autoedit', true],
    ])
  }, 180_000)

  it('Codex ready too: Codex is offered first (Claude and Codex first)', async () => {
    const t = await w.boot(PLAN, new ScriptedGemini(geminiPlays([{}])), {
      codex: new ScriptedCodex(codexHangs),
      trust: true,
      first: LOGGED_OUT,
    })
    const { c } = await w.start(t, CLAUDE_ONLY)
    await c.waitFor(failedWithSnag('implement'), 90_000)
    const sw = snagOf(t.events, 'implement')?.actions.find((a) => a.kind === 'switch_vendor')
    expect(sw).toMatchObject({ to: 'codex' })
  }, 180_000)
})

describe('Gemini prices and estimates (catalog basis)', () => {
  const ON_GEMINI = {
    profile: 'claude-only',
    gates: { afterPlan: false },
    passes: { implement: { vendor: 'gemini', model: null } },
  }

  it('no seed price: the estimate names the missing model; with a catalog price it is costed', async () => {
    const t = await w.boot(PLAN, new ScriptedGemini(geminiPlays([{}])), { trust: true })
    const before = value(await t.core.invoke('estimates.get', { folder: t.folder, overrides: ON_GEMINI }))
    expect(before.steps.implement?.missingPricing).toEqual([`gemini/${GEMINI_DEFAULT_MODEL}`])
    expect(before.steps.implement?.costUsd).toBeNull()

    value(
      await t.core.invoke('catalog.savePrice', {
        entry: {
          vendor: 'gemini',
          model: GEMINI_DEFAULT_MODEL,
          inputPerMTok: 2,
          outputPerMTok: 12,
          cacheReadPerMTok: 0.2,
          cacheWritePerMTok: null,
          sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        },
      }),
    )
    const after = value(await t.core.invoke('estimates.get', { folder: t.folder, overrides: ON_GEMINI }))
    expect(after.steps.implement?.missingPricing).toEqual([])
    expect(after.steps.implement?.costUsd?.p50 ?? 0).toBeGreaterThan(0)
    expect(after.total.missingPricing).not.toContain(`gemini/${GEMINI_DEFAULT_MODEL}`)
  }, 120_000)

  it('a Gemini pass is costed from the catalog, reasoning at the output rate, API-equivalent on a Google login', async () => {
    const usage = { input: 100_000, output: 10_000, cacheRead: 50_000, reasoning: 5_000 }
    const gemini = new ScriptedGemini(geminiPlays([{ file: 'src/version.ts', usage }]))
    const t = await w.boot(PLAN, gemini, { trust: true })
    value(
      await t.core.invoke('catalog.savePrice', {
        entry: {
          vendor: 'gemini',
          model: GEMINI_DEFAULT_MODEL,
          inputPerMTok: 2,
          outputPerMTok: 12,
          cacheReadPerMTok: 0.2,
          cacheWritePerMTok: null,
        },
      }),
    )
    const { runId, c } = await w.start(t, ON_GEMINI)
    const done = await c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
    const cost = value(await t.core.invoke('runs.get', { runId })).steps.implement.cost
    // 0.1 M × $2 + 0.01 M × $12 + 0.05 M × $0.20 + 0.005 M reasoning × $12 = 0.20 + 0.12 + 0.01 + 0.06
    expect(cost?.basis).toBe('catalog')
    expect(cost?.usd).toBeCloseTo(0.39, 6)
    expect(cost?.apiEquivalent).toBe(true)
  }, 180_000)
})
