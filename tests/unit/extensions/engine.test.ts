// Extensions through the engine: the run config carries each pass's level, startOptionsFor hands the adapter the level
// and (at Allowed list) the vendor's allow list and the run's scratch folder; and pass.<p>.extensions warns (never
// blocks) about a read-only pass at Pass through and about allowed servers that are gone, by count, never by name.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import { PASSTHROUGH_READONLY_WARNING } from '@shared/extensions.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import type { PreflightDeps } from '@core/preflight/engine.ts'
import { startOptionsFor } from '@core/supervisor/effects.ts'
import { runConfigFromResolved } from '@core/supervisor/machine.ts'
import type { EffectOf, RunState } from '@core/supervisor/types.ts'
import { fakeAdapter, fakeRegistry, healthyChecks, healthyDeps, probeResult } from '../preflight/helpers.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dim-factory-ext-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const cfgWith = (overrides: object): ResolvedConfig =>
  resolveBuiltinConfig({ profile: 'claude-only', overrides })

const allowed = (
  mcp: string[],
  skills: string[] = [],
  mcpWithoutAsking: string[] = [],
): ResolvedConfig['extensions'] => ({
  allowed: { claude: { mcp, skills, mcpWithoutAsking } },
})

describe('startOptionsFor', () => {
  const spawn = (step: 'review' | 'implement', vendor = 'claude'): EffectOf<'spawn'> =>
    ({
      t: 'spawn',
      step,
      spawnNo: 1,
      vendor,
      model: null,
      mode: step === 'review' ? 'readonly' : 'autoedit',
      launch: { planMode: 'emulated' },
    }) as unknown as EffectOf<'spawn'>
  const state = { allowRules: [] } as unknown as RunState

  it("today's levels by default, with no allow list", () => {
    const config = cfgWith({})
    const r = startOptionsFor({ runId: 'r', cwd: '/w', config, state, spawn: spawn('review'), prompt: 'p' })
    expect(r.extensions).toEqual({ level: 'none', mcp: [], skills: [] })
    const i = startOptionsFor({
      runId: 'r',
      cwd: '/w',
      config,
      state,
      spawn: spawn('implement'),
      prompt: 'p',
    })
    expect(i.extensions).toEqual({ level: 'passthrough', mcp: [], skills: [] })
  })

  it("Allowed list: the vendor's allow list and the run's scratch folder", () => {
    const config = {
      ...cfgWith({ passes: { review: { extensions: 'allowed' } } }),
      extensions: allowed(['alpha'], ['pdf']),
    }
    const r = startOptionsFor({
      runId: 'r',
      cwd: '/w',
      config,
      state,
      spawn: spawn('review'),
      prompt: 'p',
      scratchDir: '/runs/r/tmp',
    })
    expect(r.extensions).toEqual({
      level: 'allowed',
      mcp: ['alpha'],
      skills: ['pdf'],
      scratchDir: '/runs/r/tmp',
    })
    // Another vendor has its own list (none here).
    const other = startOptionsFor({
      runId: 'r',
      cwd: '/w',
      config,
      state,
      spawn: spawn('review', 'gemini'),
      prompt: 'p',
    })
    expect(other.extensions).toMatchObject({ level: 'allowed', mcp: [], skills: [] })
  })

  it('Run without asking reaches an Allowed list pass, only for servers that are also allowed', () => {
    const config = {
      ...cfgWith({ passes: { review: { extensions: 'allowed' } } }),
      extensions: allowed(['alpha', 'beta'], [], ['beta', 'gone']),
    }
    const r = startOptionsFor({ runId: 'r', cwd: '/w', config, state, spawn: spawn('review'), prompt: 'p' })
    expect(r.extensions).toEqual({
      level: 'allowed',
      mcp: ['alpha', 'beta'],
      skills: [],
      mcpWithoutAsking: ['beta'],
    })
    const none = startOptionsFor({
      runId: 'r',
      cwd: '/w',
      config: {
        ...config,
        ...cfgWith({ passes: { review: { extensions: 'none' } } }),
        extensions: config.extensions,
      },
      state,
      spawn: spawn('review'),
      prompt: 'p',
    })
    expect(none.extensions).toEqual({ level: 'none', mcp: [], skills: [] })
  })

  it('a level other than Allowed list never carries the list', () => {
    const config = {
      ...cfgWith({ passes: { review: { extensions: 'passthrough' } } }),
      extensions: allowed(['alpha']),
    }
    const r = startOptionsFor({ runId: 'r', cwd: '/w', config, state, spawn: spawn('review'), prompt: 'p' })
    expect(r.extensions).toEqual({ level: 'passthrough', mcp: [], skills: [] })
  })

  it('runConfigFromResolved carries each level', () => {
    const cfg = runConfigFromResolved(cfgWith({ passes: { critic: { extensions: 'allowed' } } }))
    expect(cfg.passes.critic.extensions).toBe('allowed')
    expect(cfg.passes.plan.extensions).toBe('none')
    expect(cfg.passes.fix.extensions).toBe('passthrough')
  })
})

describe('pass.<p>.extensions', () => {
  const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
  const extOf = (r: PreflightReport, pass: string): CheckResult | undefined =>
    all(r).find((c) => c.id === `pass.${pass}.extensions`)

  async function run(
    config: ResolvedConfig,
    names?: PreflightDeps['extensionNames'],
  ): Promise<PreflightReport> {
    const adapter = fakeAdapter('claude', {
      probe: probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)),
    })
    const engine = createPreflightEngine(
      healthyDeps({
        home,
        adapters: fakeRegistry(adapter),
        ...(names !== undefined ? { extensionNames: names } : {}),
      }),
    )
    engine.recordProbe(await adapter.probe())
    return engine.run('live', { config, folder: home })
  }

  it('nothing at the default levels', async () => {
    const r = await run(cfgWith({}))
    for (const p of ['plan', 'implement', 'review', 'critic', 'fix']) expect(extOf(r, p)).toBeUndefined()
  })

  it('a read-only pass at Pass through warns (never blocks) and offers to run it with none', async () => {
    const r = await run(cfgWith({ passes: { review: { extensions: 'passthrough' } } }))
    const c = extOf(r, 'review')
    expect(c).toMatchObject({ status: 'warn', blocking: false, title: 'Review uses every extension' })
    expect(c?.detail).toContain(PASSTHROUGH_READONLY_WARNING)
    expect(c?.recovery[0]).toMatchObject({
      kind: 'config_patch',
      target: 'runOverrides',
      ops: [{ op: 'add', path: '/passes/review/extensions', value: 'none' }],
    })
    // Implement at Pass through is its default: nothing to say.
    expect(extOf(r, 'implement')).toBeUndefined()
  })

  it('allowed servers that are gone: a warning that counts them and never names them', async () => {
    const config = {
      ...cfgWith({ passes: { critic: { extensions: 'allowed' } } }),
      extensions: allowed(['secret-alpha', 'secret-beta', 'kept']),
    }
    const asked: (string | undefined)[][] = []
    const r = await run(config, (vendor, folder) => {
      asked.push([vendor, folder])
      return Promise.resolve({ mcp: ['kept', 'other'], complete: true })
    })
    const c = extOf(r, 'critic')
    expect(asked).toEqual([['claude', home]])
    expect(c).toMatchObject({
      status: 'warn',
      blocking: false,
      title: 'Critic: 2 allowed MCP servers are gone',
    })
    expect(JSON.stringify(c)).not.toMatch(/secret-alpha|secret-beta|kept/)
    expect(c?.recovery.map((a) => a.kind)).toEqual(['settings_link', 'config_patch'])
    expect(c?.recovery[0]).toMatchObject({
      route: 'settings/extensions',
      pointer: '/extensions/allowed/claude/mcp',
    })
    expect(`${c?.title} ${c?.detail}`).not.toMatch(/—/)
  })

  it('one gone server reads in the singular; none gone, an incomplete read or no reader: nothing', async () => {
    const config = {
      ...cfgWith({ passes: { critic: { extensions: 'allowed' } } }),
      extensions: allowed(['a']),
    }
    const one = await run(config, () => Promise.resolve({ mcp: [], complete: true }))
    expect(extOf(one, 'critic')?.title).toBe('Critic: an allowed MCP server is gone')
    expect(
      extOf(await run(config, () => Promise.resolve({ mcp: ['a'], complete: true })), 'critic'),
    ).toBeUndefined()
    expect(
      extOf(await run(config, () => Promise.resolve({ mcp: [], complete: false })), 'critic'),
    ).toBeUndefined()
    expect(extOf(await run(config), 'critic')).toBeUndefined()
    expect(extOf(await run(config, () => Promise.reject(new Error('x'))), 'critic')).toBeUndefined()
  })
})
