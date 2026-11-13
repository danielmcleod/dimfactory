// Config integration with Codex as a second vendor, through a real core (built-in profiles:
// first launch picks the profile from which vendors are ready, Codex ready only if support({mode:'autoedit'}) ≠
// unsupported ("This dev machine has no Codex sandbox, so it starts on claude-only"); "When Critic's vendor equals
// Implement's and another ready vendor exists, show [Swap Critic to X] as a run override. Never switch silently.";
// the Fix row's "Fresh, different vendor"):
//   - the first-launch matrix with the Codex adapter's own support() (sandbox ready / not set up / Claude signed out)
//   - the Critic swap is suggested (config.resolve), applied only as a run override (runs.start), never on its own
//   - the Fix row's "Fresh, different vendor" names Codex once Codex is ready
//   - estimates: Codex's CLI default is priced at the catalog's price for the probe's default model; a local
//     preset's pass is free
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedCodex, World, codexPlays, settled, value } from './helpers.ts'
import { codexHangs } from '../../../unit/balanced/engine/helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const userProfile = (home: string): unknown =>
  (JSON.parse(readFileSync(join(home, 'dimfactory.json'), 'utf8')) as { profile?: unknown }).profile

describe('first launch with Codex (the first-launch matrix; Codex needs autoedit support)', () => {
  it('Claude ready, Codex ready (sandbox set up): balanced', async () => {
    const codex = new ScriptedCodex(codexHangs, { sandbox: 'ready' })
    const t = await w.boot({}, codex, { probe: false })
    const out = await t.core.firstLaunch()
    expect(out).toMatchObject({
      status: 'completed',
      wroteProfile: true,
      selection: { profile: 'balanced', claudeReady: true, codexReady: true, runnable: true },
    })
    // First launch probed Codex itself (once) and stored it for preflight.
    expect(codex.probes).toBe(1)
    expect(userProfile(t.home)).toBe('balanced')
  }, 120_000)

  it('Claude ready, Codex without its Windows sandbox (autoedit unsupported): claude-only', async () => {
    const codex = new ScriptedCodex(codexHangs, { sandbox: 'notConfigured' })
    const t = await w.boot({}, codex, { probe: false })
    const out = await t.core.firstLaunch()
    expect(out).toMatchObject({
      status: 'completed',
      selection: { profile: 'claude-only', claudeReady: true, codexReady: false },
    })
    expect(userProfile(t.home)).toBe('claude-only')
  }, 120_000)

  // "Claude not ready" is the fake Claude signed out. A missing configured path made the resolver
  // fall back to the well-known locations and run the developer's own claude.exe (`--version`, `auth status`).
  it('Claude not ready (signed out), Codex ready: codex-only', async () => {
    const codex = new ScriptedCodex(codexHangs, { sandbox: 'ready' })
    const t = await w.boot({}, codex, { probe: false, claudeLoggedOut: true })
    const out = await t.core.firstLaunch()
    expect(out).toMatchObject({
      status: 'completed',
      selection: { profile: 'codex-only', claudeReady: false, codexReady: true },
    })
    expect(userProfile(t.home)).toBe('codex-only')
    // The fake answered the login check: no other Claude was looked for or run.
    const auth = t.sc
      .entries()
      .filter((e) => e.kind === 'start' && JSON.stringify(e['argv']).includes('"auth","status"'))
    expect(auth.length).toBeGreaterThan(0)
  }, 120_000)

  it('neither ready (Claude signed out, Codex logged out): nothing is written yet, Run stays disabled', async () => {
    const codex = new ScriptedCodex(codexHangs, { sandbox: 'ready', auth: 'fail' })
    const t = await w.boot({}, codex, { probe: false, claudeLoggedOut: true })
    const out = await t.core.firstLaunch()
    expect(out).toMatchObject({
      status: 'deferred',
      reason: 'no-vendor-ready',
      selection: { profile: 'balanced', runnable: false },
    })
    expect(userProfile(t.home)).toBeUndefined()
  }, 120_000)
})

describe('[Swap Critic to Codex] (a run override, never silent)', () => {
  const IMPLEMENT = {
    recording: 'C08a-session-id-implement',
    write: { path: 'src/version.ts', content: 'x\n' },
  }
  // The second case starts two runs: a Plan and an Implement script for each.
  const SPEC = {
    plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
    implement: [IMPLEMENT, { ...IMPLEMENT, write: { path: 'src/version.ts', content: 'y\n' } }],
  }

  it('suggested while Critic shares Implement’s vendor and Codex is ready; gone when it is not', async () => {
    const codex = new ScriptedCodex(codexHangs)
    const t = await w.boot(SPEC, codex)
    const view = value(
      await t.core.invoke('config.resolve', { folder: t.folder, overrides: { profile: 'claude-only' } }),
    )
    expect(view.config.passes.critic.vendor).toBe('claude')
    expect(view.suggestions?.criticSwap).toEqual({ to: 'codex' })
    // The Fix row's "Fresh, different vendor" is Codex too.
    expect(view.suggestions?.otherFixVendor).toBe('codex')
    // balanced: Critic (Claude) already differs from Implement (Codex): nothing to suggest.
    const balanced = value(
      await t.core.invoke('config.resolve', { folder: t.folder, overrides: { profile: 'balanced' } }),
    )
    expect(balanced.suggestions?.criticSwap).toBeNull()

    // A Codex that is logged out is not ready: no suggestion.
    codex.auth = 'fail'
    value(await t.core.invoke('vendors.probe', { vendor: 'codex', force: true }))
    const off = value(
      await t.core.invoke('config.resolve', { folder: t.folder, overrides: { profile: 'claude-only' } }),
    )
    expect(off.suggestions?.criticSwap).toBeNull()
  }, 120_000)

  it('without the override Critic stays on Claude; with it Critic runs on Codex read-only for this run only', async () => {
    const codex = new ScriptedCodex(codexPlays([{ kind: 'ok', text: 'NO FINDINGS' }]))
    const t = await w.boot(SPEC, codex)
    const plain = await w.start(t, { profile: 'claude-only', gates: { afterPlan: false } })
    const a = await plain.c.waitFor(settled, 120_000)
    expect(a.steps.critic).toMatchObject({ status: 'done', vendor: 'claude' })
    expect(codex.starts).toEqual([])

    const swapped = await w.start(t, {
      profile: 'claude-only',
      gates: { afterPlan: false },
      passes: { critic: { vendor: 'codex', model: null } },
    })
    const b = await swapped.c.waitFor(settled, 120_000)
    expect(b.status).toBe('completed')
    expect(b.config.passes.critic).toMatchObject({ vendor: 'codex', model: null, mode: 'readonly' })
    expect(b.steps.critic).toMatchObject({ status: 'done', vendor: 'codex' })
    expect(codex.starts.map((s) => [s.step, s.mode])).toEqual([['critic', 'readonly']])
    // Read-only: no session id made up and none resumed.
    expect(codex.starts[0]?.sessionId).toBeUndefined()
    expect(codex.starts[0]?.resume).toBeUndefined()
    // The override stayed in the run: the user's file still has no Critic vendor.
    const user = JSON.parse(readFileSync(join(t.home, 'dimfactory.json'), 'utf8')) as Record<string, unknown>
    expect((user['passes'] as Record<string, unknown> | undefined)?.['critic']).toBeUndefined()
  }, 240_000)
})

describe('estimates with Codex ("model:null resolves to the probe’s isDefault model")', () => {
  it('a balanced composer estimate prices Codex’s CLI default from the catalog; a local preset costs nothing', async () => {
    const codex = new ScriptedCodex(codexHangs)
    const preset = { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' }
    const t = await w.boot({}, codex, { user: { local: { presets: [preset] } } })
    const est = value(
      await t.core.invoke('estimates.get', { folder: t.folder, overrides: { profile: 'balanced' } }),
    )
    expect(est.total.missingPricing).toEqual([])
    expect(est.total.costUsd?.p80 ?? 0).toBeGreaterThan(0)
    const impl = est.steps.implement
    expect(impl?.missingPricing).toEqual([])
    expect(impl?.costUsd?.p50 ?? 0).toBeGreaterThan(0)
    // Implement on a local preset: same tokens, zero dollars (a local preset's pricing is 0).
    const local = value(
      await t.core.invoke('estimates.get', {
        folder: t.folder,
        overrides: {
          profile: 'balanced',
          passes: { implement: { vendor: 'local-ollama', model: null } },
        },
      }),
    )
    expect(local.steps.implement?.costUsd).toEqual({ p50: 0, p80: 0 })
    expect(local.steps.implement?.missingPricing).toEqual([])
  }, 120_000)
})
