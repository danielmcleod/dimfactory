// pass.<p>.effort: a warning, never a block. The pass asks for an effort level its model does not list, or its vendor
// has no effort setting; it offers "Use the default effort" (a run override). Nothing when the level is listed, when
// no effort is set, or when the model list does not describe the model's levels.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { ModelInfo } from '@shared/vendors.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import { fakeAdapter, fakeRegistry, healthyChecks, healthyDeps, probeResult } from './helpers.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dim-factory-effort-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const MODELS: ModelInfo[] = [
  { id: 'default', isDefault: true, efforts: ['low', 'medium', 'high'], source: 'cli' },
  { id: 'opus', efforts: ['low', 'medium', 'high', 'max'], source: 'cli' },
  { id: 'haiku', source: 'cli' },
]

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
const effortOf = (r: PreflightReport, pass = 'plan'): CheckResult | undefined =>
  all(r).find((c) => c.id === `pass.${pass}.effort`)

async function run(overrides: object, vendors: string[] = ['claude']): Promise<PreflightReport> {
  const adapters = vendors.map((v) => {
    const probe = probeResult(v, 1_000_000, healthyChecks(v, 1_000_000))
    probe.models = MODELS
    return fakeAdapter(v, { probe })
  })
  const engine = createPreflightEngine(healthyDeps({ home, adapters: fakeRegistry(...adapters) }))
  for (const a of adapters) engine.recordProbe(await a.probe())
  const config = resolveBuiltinConfig({ profile: 'claude-only', overrides })
  return engine.run('live', { config })
}

describe('pass.<p>.effort', () => {
  it('a level the model does not list warns (not a block) and offers the default effort', async () => {
    const r = await run({ passes: { plan: { model: 'default', effort: 'max' } } })
    const c = effortOf(r)
    expect(c).toMatchObject({
      status: 'warn',
      blocking: false,
      title: 'Plan: default does not list max effort',
    })
    expect(c?.detail).toContain('low, medium, high')
    expect(r.blocking.some((b) => b.id.startsWith('pass.plan.effort'))).toBe(false)
    expect(c?.recovery[0]).toMatchObject({
      kind: 'config_patch',
      target: 'runOverrides',
      ops: [{ op: 'add', path: '/passes/plan/effort', value: null }],
    })
  })

  it('a null model is checked against the default model', async () => {
    const r = await run({ passes: { implement: { model: null, effort: 'max' } } })
    expect(effortOf(r, 'implement')).toMatchObject({ status: 'warn' })
  })

  it('nothing for a listed level, no effort, or a model whose levels are not listed', async () => {
    expect(effortOf(await run({ passes: { plan: { model: 'opus', effort: 'max' } } }))).toBeUndefined()
    expect(effortOf(await run({ passes: { plan: { model: 'opus' } } }))).toBeUndefined()
    expect(effortOf(await run({ passes: { plan: { model: 'haiku', effort: 'max' } } }))).toBeUndefined()
    expect(effortOf(await run({ passes: { plan: { model: 'gpt-x', effort: 'max' } } }))).toBeUndefined()
  })

  it('a vendor without an effort setting warns that the pass runs at its default', async () => {
    const r = await run({ passes: { review: { vendor: 'gemini', model: null, effort: 'high' } } }, [
      'claude',
      'gemini',
    ])
    expect(effortOf(r, 'review')).toMatchObject({
      status: 'warn',
      blocking: false,
      title: 'Review: gemini has no effort setting',
    })
  })
})
