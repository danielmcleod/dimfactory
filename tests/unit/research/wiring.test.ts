// Research wired through the rest of core: the vendor launches (Claude's confined tool set with and without the web;
// Codex's read-only ephemeral thread with web search live or off; ACP and Muse treat it as read-only; which vendors
// can search the web at all), the preflight check, the estimate, the config schema and profiles, and the templates.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlanConfigZ, ResolvedPlanPassZ } from '@shared/config-schema.ts'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { CATALOG_DISALLOWED } from '@core/adapters/claude/capabilities.ts'
import { claudeCapabilities } from '@core/adapters/claude/capabilities.ts'
import { buildArgv, claudeEnv, routeFor } from '@core/adapters/claude/launch.ts'
import { execArgv, sandboxFor, webSearchFor } from '@core/adapters/codex/launch.ts'
import { threadStartParams } from '@core/adapters/codex/params.ts'
import { effectiveMode as acpEffectiveMode } from '@core/adapters/acp-base/run.ts'
import { acpCapabilities } from '@core/adapters/acp-base/probe.ts'
import { geminiConfig } from '@core/adapters/gemini/config.ts'
import { grokConfig } from '@core/adapters/grok/config.ts'
import { museCapabilities, museEffectiveMode } from '@core/adapters/muse/capabilities.ts'
import { BUILTIN_PROFILES } from '@core/config/defaults.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { PRIOR_MS, PRIOR_USAGE } from '@core/estimates/defaults.ts'
import { EstimateAggregate } from '@core/estimates/aggregate.ts'
import { estimateRun, plannedSteps } from '@core/estimates/estimate.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import type { PreflightInput } from '@core/preflight/engine.ts'
import { readBuiltinTemplate } from '@core/prompts/resolve.ts'
import { TEMPLATE_SPECS, render, validateTemplate } from '@core/prompts/template.ts'
import { healthyChecks, healthyDeps, probeResult } from '../preflight/helpers.ts'

// ---- vendor launches ---------------------------------------------------------------------------------------------

describe('Claude: Research is confined like the catalog refresh', () => {
  const research = (webOpen: boolean): string[] =>
    buildArgv({ route: 'readonly', mode: 'readonly', step: 'research', model: 'opus', webOpen })
  const value = (a: string[], flag: string): string | undefined =>
    a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined

  it('runs on the read-only route under dontAsk, whatever the mode', () => {
    expect(routeFor({ step: 'research', mode: 'full', planNative: true })).toBe('readonly')
    expect(value(research(true), '--permission-mode')).toBe('dontAsk')
  })

  it('cuts edits, shell and agents, and lists its tools: the read tools plus the web when allowed', () => {
    const web = research(true)
    expect(value(web, '--disallowedTools')).toBe(CATALOG_DISALLOWED.join(','))
    expect(value(web, '--tools')).toBe('Read,Glob,Grep,WebSearch,WebFetch')
    expect(value(web, '--allowedTools')).toBe('WebSearch,WebFetch')
    expect(web).toContain('--strict-mcp-config')
    expect(web).toContain('--no-session-persistence')
    expect(web).not.toContain('--permission-prompt-tool')
    const repo = research(false)
    expect(value(repo, '--tools')).toBe('Read,Glob,Grep')
    expect(repo).not.toContain('--allowedTools')
    expect(value(repo, '--disallowedTools')).toBe(CATALOG_DISALLOWED.join(','))
  })

  it('a review pass gets neither --tools nor the web allow list', () => {
    const review = buildArgv({ route: 'readonly', mode: 'readonly', step: 'review', webOpen: true })
    expect(review).not.toContain('--tools')
    expect(review).not.toContain('--allowedTools')
  })

  it('its env is confined (only cliArg rules count, no preapproved hosts)', () => {
    const env = claudeEnv({ PATH: '/usr/bin' }, { route: 'readonly', confined: true, platform: 'linux' })
    expect(env['CLAUDE_CODE_EVAL_CONFINED']).toBe('1')
  })
})

describe('Codex: a read-only, ephemeral thread with web search live or off', () => {
  it('thread/start: read-only sandbox, never asks, ephemeral, web_search live or disabled', () => {
    for (const web of [true, false]) {
      const p = threadStartParams({ step: 'research', mode: 'autoedit', cwd: 'C:/w', web })
      expect(p).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true })
      // Research runs at None: Codex's apps, plugins and hooks are off too.
      expect(p.config).toEqual({
        web_search: web ? 'live' : 'disabled',
        'features.apps': false,
        'features.plugins': false,
        'features.hooks': false,
      })
    }
    expect(sandboxFor('research', 'full')).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' })
  })

  it('exec: the same in -c, plus --ephemeral', () => {
    const a = execArgv({ step: 'research', mode: 'readonly', cwd: 'C:/w', outFile: 'o', web: true })
    expect(a).toEqual(expect.arrayContaining(['-c', 'web_search="live"', '--ephemeral']))
    const b = execArgv({ step: 'research', mode: 'readonly', cwd: 'C:/w', outFile: 'o' })
    expect(b).toEqual(expect.arrayContaining(['-c', 'web_search="disabled"']))
  })

  it('only the catalog refresh and Research set web_search', () => {
    expect(webSearchFor('catalog', undefined)).toBe('live')
    expect(webSearchFor('research', true)).toBe('live')
    expect(webSearchFor('research', false)).toBe('disabled')
    expect(webSearchFor('plan', true)).toBeUndefined()
    expect(
      threadStartParams({ step: 'plan', mode: 'readonly', cwd: 'C:/w', web: true }).config,
    ).not.toHaveProperty('web_search')
  })
})

describe('ACP vendors and Muse', () => {
  it('run Research read-only whatever the mode', () => {
    expect(acpEffectiveMode('research', 'full')).toBe('readonly')
    expect(museEffectiveMode('research', 'autoedit')).toBe('readonly')
  })

  it('cannot search the web from Dim Factory (Research reads the repository only); Claude can', () => {
    const facts = { probed: true, loadSession: true, resume: false, plan: true }
    expect(acpCapabilities(geminiConfig, facts, 0).web).toBe(false)
    expect(acpCapabilities(grokConfig, facts, 0).web).toBe(false)
    expect(museCapabilities().web).toBe(false)
    expect(claudeCapabilities('linux').web).toBe(true)
  })
})

// ---- preflight --------------------------------------------------------------------------------------------------

describe('preflight run.research', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dim-factory-research-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function run(
    config: ResolvedConfig,
    research?: PreflightInput['research'],
  ): Promise<PreflightReport> {
    const folder = join(root, 'project')
    const home = join(root, 'home')
    mkdirSync(folder, { recursive: true })
    mkdirSync(home, { recursive: true })
    const engine = createPreflightEngine(healthyDeps({ home, platform: process.platform }))
    engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
    return engine.run('authoritative', { folder, config, ...(research !== undefined ? { research } : {}) })
  }
  const check = (r: PreflightReport): CheckResult | undefined =>
    [...r.blocking, ...r.warnings, ...r.info].find((c) => c.id === 'run.research')
  const on = resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: { passes: { plan: { research: true } } },
  })

  it('an unknown lens blocks the run, linking to Settings', async () => {
    const r = await run(on, { vendor: 'Claude', web: true, unknown: ['nope'], offWeb: [] })
    expect(r.ok).toBe(false)
    expect(check(r)).toMatchObject({
      status: 'fail',
      title: 'Unknown research lens',
      category: 'config_invalid',
    })
    expect(check(r)?.detail).toContain('"nope"')
    expect(check(r)?.recovery).toEqual([
      expect.objectContaining({ kind: 'settings_link', pointer: '/passes/plan/researchLenses' }),
    ])
  })

  it('a vendor without web search warns, naming the lenses left out', async () => {
    const r = await run(on, {
      vendor: 'Gemini',
      web: false,
      unknown: [],
      offWeb: ['Comparable products', 'Pitfalls'],
    })
    expect(r.ok).toBe(true)
    expect(check(r)).toMatchObject({
      status: 'warn',
      title: 'Gemini cannot search the web',
      category: 'capability_missing',
    })
    expect(check(r)?.detail).toContain('left out: Comparable products, Pitfalls')
    expect(check(r)?.detail).not.toContain('—')
  })

  it('passes with web search, and does not apply with Research off', async () => {
    expect(check(await run(on, { vendor: 'Claude', web: true, unknown: [], offWeb: [] }))).toMatchObject({
      status: 'pass',
    })
    const off = resolveBuiltinConfig({ profile: 'claude-only' })
    expect(check(await run(off, { vendor: 'Claude', web: true, unknown: ['x'], offWeb: [] }))).toBeUndefined()
  })
})

// ---- estimates ----------------------------------------------------------------------------------------------------

describe('estimates', () => {
  const priced = (): {
    rates: {
      inputPerMTok: number
      outputPerMTok: number
      cacheReadPerMTok: number
      cacheWritePerMTok: number
    }
    reasoningIncludedInOutput: boolean
  } => ({
    rates: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    reasoningIncludedInOutput: true,
  })

  it('plans Research before Plan only with Research and Plan on, and counts it in the run total', () => {
    const off = resolveBuiltinConfig({ profile: 'claude-only' })
    expect(plannedSteps(off).map((q) => q.key)).not.toContain('research')
    const on = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: { passes: { plan: { research: true } } },
    })
    const keys = plannedSteps(on).map((q) => q.key)
    expect(keys.indexOf('research')).toBe(keys.indexOf('plan') - 1)
    expect(plannedSteps(on).find((q) => q.key === 'research')).toMatchObject({
      vendor: 'claude',
      model: 'opus',
    })
    const noPlan = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: { passes: { plan: { research: true, enabled: false } } },
    })
    expect(plannedSteps(noPlan).map((q) => q.key)).not.toContain('research')
    const a = estimateRun(new EstimateAggregate(), { config: off, folderKey: null, price: priced })
    const b = estimateRun(new EstimateAggregate(), { config: on, folderKey: null, price: priced })
    expect(b.steps.research?.durationMs.p80).toBe(PRIOR_MS.research)
    expect(b.total.durationMs.p80).toBeGreaterThan(a.total.durationMs.p80)
    expect(b.total.costUsd?.p80 ?? 0).toBeGreaterThan(a.total.costUsd?.p80 ?? 0)
  })

  it('its token prior is the heaviest read-only pass (web pages come back on every turn)', () => {
    const read = (k: 'plan' | 'review' | 'critic' | 'security' | 'research'): number =>
      PRIOR_USAGE[k]?.cacheRead ?? 0
    for (const k of ['plan', 'review', 'critic', 'security'] as const)
      expect(read('research')).toBeGreaterThan(read(k))
  })
})

// ---- config -----------------------------------------------------------------------------------------------------

describe('config', () => {
  it('the Plan pass takes research and researchLenses, and refuses bad ids or too many lenses', () => {
    expect(PlanConfigZ.safeParse({ research: true, researchLenses: ['comparable', 'seo'] }).success).toBe(
      true,
    )
    expect(PlanConfigZ.safeParse({ researchLenses: ['Not An Id'] }).success).toBe(false)
    expect(
      PlanConfigZ.safeParse({ researchLenses: Array.from({ length: 17 }, (_, i) => `l${i}`) }).success,
    ).toBe(false)
    expect(PlanConfigZ.safeParse({ research: 'yes' }).success).toBe(false)
  })

  it('resolves to off with no lenses; an older resolved.json without the keys reads as off', () => {
    const c = resolveBuiltinConfig({ profile: 'balanced' })
    expect(c.passes.plan).toMatchObject({ research: false, researchLenses: [] })
    const { research: _r, researchLenses: _l, ...older } = c.passes.plan
    expect(ResolvedPlanPassZ.parse(older)).toMatchObject({ research: false, researchLenses: [] })
  })

  it('only the thorough profile turns Research on', () => {
    expect(BUILTIN_PROFILES.thorough.plan?.research).toBe(true)
    for (const p of ['balanced', 'claude-only', 'codex-only', 'fast'] as const)
      expect(BUILTIN_PROFILES[p].plan?.research).toBeUndefined()
    expect(resolveBuiltinConfig({ profile: 'thorough' }).passes.plan.research).toBe(true)
  })
})

// ---- templates --------------------------------------------------------------------------------------------------

describe('templates', () => {
  it('research.md validates for its spec and may be overridden (Settings › Prompts)', () => {
    const v = validateTemplate(readBuiltinTemplate('research'), 'research')
    expect(v.ok).toBe(true)
    expect(v.missingRequired).toEqual([])
    expect(TEMPLATE_SPECS.research).toMatchObject({ internal: false, required: ['task', 'lenses', 'access'] })
    // The re-check's template stays Dim Factory-internal.
    expect(TEMPLATE_SPECS.recheck.internal).toBe(true)
    expect(readBuiltinTemplate('research')).toMatch(/untrusted data/)
  })

  it('plan.md renders the research section only when given', () => {
    const plan = readBuiltinTemplate('plan')
    const without = render(plan, { task: 'Do X' }, { template: 'plan' }).text
    expect(without).not.toContain('Research the user reviewed')
    const withIt = render(
      plan,
      { task: 'Do X', research: 'Features to include:\n- [must] A' },
      { template: 'plan' },
    )
    expect(withIt.text).toContain('Research the user reviewed for this run')
    expect(withIt.text).toContain('- [must] A')
  })

  it('a user plan template may use {{research}}; other passes may not', () => {
    expect(validateTemplate('{{task}}\n{{research}}', 'plan').ok).toBe(true)
    expect(validateTemplate('{{diff}}\n{{research}}', 'review').ok).toBe(false)
  })
})
