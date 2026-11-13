// Folder trust from trust.json to the Gemini adapter (Readiness `trust` "Gemini/Muse without a
// grant → fail, with a grant vendorFolder action", Gemini launch "--skip-trust only with the vendorFolder grant or
// for Dim Factory-owned cwds", trust.json, pass.<p>.readiness.*):
//   - the readiness check hands Gemini `ReadinessNeed.trustFolder` from the folder's vendorFolder grant (no grant, an
//     unreadable trust.json or no grant reader: false; fail closed)
//   - a vendor that never asks for folder trust (Claude) gets false and Dim Factory reads no grant for it
//   - StartOptions.trustFolder carries the controller's answer (default false)
//   - a mode failure's switch names the first other vendor that is ready for the mode (three vendors now)
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { ReadinessNeed } from '@shared/vendors.ts'
import { FOLDER_TRUST_VENDORS, needsFolderTrust } from '@shared/vendors.ts'
import type { TrustGrants } from '@shared/ipc.ts'
import { planImplementOverrides, resolveBuiltinConfig } from '@core/config/builtins.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import type { PreflightDeps } from '@core/preflight/engine.ts'
import { startOptionsFor } from '@core/supervisor/effects.ts'
import type { EffectOf } from '@core/supervisor/types.ts'
import {
  check,
  fakeAdapter,
  fakeRegistry,
  healthyChecks,
  healthyDeps,
  probeResult,
} from '../../preflight/helpers.ts'
import { makeRun } from '../../supervisor/helpers.ts'
import { trustCheck } from './helpers.ts'

let root: string
let folder: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trust-plumbing-'))
  folder = join(root, 'project')
  home = join(root, 'home')
  mkdirSync(folder, { recursive: true })
  mkdirSync(home, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
const byId = (r: PreflightReport, id: string): CheckResult | undefined => all(r).find((x) => x.id === id)

/** Review on Gemini, everything else on Claude (claude-only); Gemini's readiness reads need.trustFolder. */
function world(o: { grants?: () => Promise<TrustGrants>; noReader?: boolean } = {}) {
  const gemini = fakeAdapter('gemini', { readiness: (cwd, need) => [trustCheck(need, cwd)] })
  const claude = fakeAdapter('claude')
  const trustGrants = vi.fn(o.grants ?? (() => Promise.resolve({})))
  const deps: PreflightDeps = healthyDeps({
    home,
    adapters: fakeRegistry(claude, gemini),
    ...(o.noReader === true ? {} : { trustGrants }),
  })
  const engine = createPreflightEngine(deps)
  engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
  engine.recordProbe(probeResult('gemini', 1_000_000, healthyChecks('gemini', 1_000_000)))
  const config = resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: { ...planImplementOverrides(), passes: { review: { vendor: 'gemini', model: null } } },
  })
  return { gemini, claude, trustGrants, engine, config }
}

const needOf = (calls: { need: ReadinessNeed }[], pass: string): ReadinessNeed | undefined =>
  calls.filter((c) => c.need.pass === pass).at(-1)?.need

describe('ReadinessNeed.trustFolder from trust.json (vendorFolder)', () => {
  it('no grant: Gemini hears trustFolder:false and its trust check blocks with the grant action', async () => {
    const w = world()
    const r = await w.engine.run('live', { folder, config: w.config })
    expect(needOf(w.gemini.readinessCalls, 'review')?.trustFolder).toBe(false)
    const trust = byId(r, 'pass.review.readiness.trust')
    expect(trust).toMatchObject({ status: 'fail', blocking: true, category: 'trust_required' })
    expect(trust?.recovery[0]).toMatchObject({ kind: 'grant', grant: 'vendorFolder', vendor: 'gemini' })
    expect(r.ok).toBe(false)
  })

  it('a vendorFolder grant for Gemini: trustFolder:true and the check passes (a grant for another vendor does not)', async () => {
    const granted = world({ grants: () => Promise.resolve({ vendorFolder: { gemini: { at: 1 } } }) })
    const ok = await granted.engine.run('live', { folder, config: granted.config })
    expect(needOf(granted.gemini.readinessCalls, 'review')?.trustFolder).toBe(true)
    expect(byId(ok, 'pass.review.readiness.trust')?.status).toBe('pass')
    expect(granted.trustGrants).toHaveBeenCalledWith(folder)

    const other = world({ grants: () => Promise.resolve({ vendorFolder: { muse: { at: 1 } } }) })
    await other.engine.run('live', { folder, config: other.config })
    expect(needOf(other.gemini.readinessCalls, 'review')?.trustFolder).toBe(false)
  })

  it('fails closed: an unreadable trust.json or no grant reader grants nothing', async () => {
    const broken = world({ grants: () => Promise.reject(new Error('EACCES')) })
    const r = await broken.engine.run('live', { folder, config: broken.config })
    expect(needOf(broken.gemini.readinessCalls, 'review')?.trustFolder).toBe(false)
    expect(byId(r, 'pass.review.readiness.trust')?.status).toBe('fail')
    const none = world({ noReader: true })
    await none.engine.run('live', { folder, config: none.config })
    expect(needOf(none.gemini.readinessCalls, 'review')?.trustFolder).toBe(false)
  })

  it('Claude never asks for folder trust: its need says false and no grant is read for it', async () => {
    const w = world({ grants: () => Promise.resolve({ vendorFolder: { claude: { at: 1 } } }) })
    await w.engine.run('live', {
      folder,
      config: resolveBuiltinConfig({ profile: 'claude-only', overrides: planImplementOverrides() }),
    })
    expect(w.claude.readinessCalls.length).toBeGreaterThan(0)
    expect(w.claude.readinessCalls.every((c) => !c.need.trustFolder)).toBe(true)
    expect(w.trustGrants).not.toHaveBeenCalled()
    expect(needsFolderTrust('claude')).toBe(false)
    expect(needsFolderTrust('codex')).toBe(false)
    expect(needsFolderTrust('local-ollama')).toBe(false)
    expect(needsFolderTrust('gemini')).toBe(true)
    // Readiness `trust`: "Gemini/Muse without a grant → fail": Muse joined with its adapter.
    expect(needsFolderTrust('muse')).toBe(true)
    expect(FOLDER_TRUST_VENDORS).toEqual(['gemini', 'muse'])
  })

  it('the pass-boundary guard asks too (nothing is spawned for an untrusted Gemini pass)', async () => {
    const w = world()
    const r = await w.engine.run('passBoundary', { folder, config: w.config, pass: 'review' })
    expect(r.ok).toBe(false)
    expect(r.blocking[0]).toMatchObject({ id: 'pass.review.readiness.trust', category: 'trust_required' })
  })
})

describe('StartOptions.trustFolder', () => {
  const spawn = (vendor: string): EffectOf<'spawn'> => ({
    t: 'spawn',
    step: 'review',
    attempt: 1,
    spawnNo: 1,
    launch: { cause: 'initial' } as EffectOf<'spawn'>['launch'],
    vendor,
    model: null,
    mode: 'readonly',
  })
  const input = (vendor: string) => {
    const config = resolveBuiltinConfig({ profile: 'claude-only' })
    return { runId: 'r1', cwd: folder, config, state: makeRun(), spawn: spawn(vendor), prompt: 'p' }
  }

  it('carries the controller answer; absent means not trusted', () => {
    expect(startOptionsFor(input('gemini')).trustFolder).toBe(false)
    expect(startOptionsFor({ ...input('gemini'), trustFolder: true }).trustFolder).toBe(true)
    expect(startOptionsFor({ ...input('gemini'), trustFolder: false }).trustFolder).toBe(false)
  })
})

describe('pass.<p>.mode switch with three vendors (per readiness)', () => {
  /** Implement on Claude whose autoedit is unsupported; Codex and Gemini as given. */
  async function modeSwitch(o: { codexReady: boolean; geminiReady: boolean }): Promise<string | undefined> {
    const claude = fakeAdapter('claude', {
      support: (need) =>
        need.mode === 'autoedit'
          ? { status: 'unsupported', copy: 'no edits here' }
          : { status: 'supported', copy: 'ok' },
    })
    const codex = fakeAdapter('codex')
    const gemini = fakeAdapter('gemini', { readiness: (cwd, need) => [trustCheck(need, cwd)] })
    const engine = createPreflightEngine(
      healthyDeps({
        home,
        adapters: fakeRegistry(claude, codex, gemini),
        trustGrants: () => Promise.resolve({}),
      }),
    )
    const ready = (id: string, ok: boolean) =>
      probeResult(
        id,
        1_000_000,
        ok
          ? healthyChecks(id, 1_000_000)
          : [check(`vendor.${id}.auth`, 'fail', { category: 'auth_required' })],
      )
    engine.recordProbe(ready('claude', true))
    engine.recordProbe(ready('codex', o.codexReady))
    engine.recordProbe(ready('gemini', o.geminiReady))
    const r = await engine.run('live', {
      folder,
      config: resolveBuiltinConfig({ profile: 'claude-only', overrides: planImplementOverrides() }),
    })
    const mode = byId(r, 'pass.implement.mode')
    expect(mode?.status).toBe('fail')
    const sw = mode?.recovery.find((a) => a.kind === 'switch_vendor')
    return sw?.kind === 'switch_vendor' ? sw.to : undefined
  }

  it('Codex first while it is ready ("preferring claude/codex")', async () => {
    expect(await modeSwitch({ codexReady: true, geminiReady: true })).toBe('codex')
  })
  it('Gemini when Codex is not ready and Gemini is', async () => {
    expect(await modeSwitch({ codexReady: false, geminiReady: true })).toBe('gemini')
  })
  it('none ready: the other primary vendor (core says why at the click)', async () => {
    expect(await modeSwitch({ codexReady: false, geminiReady: false })).toBe('codex')
  })
})
