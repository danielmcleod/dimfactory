// A pass's effort level through the engine: the run config carries it from the resolved config, the spawn effect and
// the step state record it (Claude and Codex only), and the views show it: the queued card, the running card, the
// Config tab (StepView.effort) and the run summary's steps.
import { describe, expect, it } from 'vitest'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { toRunSnapshot, toRunSummary } from '@core/supervisor/derive.ts'
import { runConfigFromResolved } from '@core/supervisor/machine.ts'
import type { EffectOf } from '@core/supervisor/types.ts'
import { Harness, makeConfig } from './helpers.ts'

const spawnOf = (h: Harness): EffectOf<'spawn'> | undefined =>
  h.log.filter((e): e is EffectOf<'spawn'> => e.t === 'spawn').at(-1)

describe('effort through the engine', () => {
  it('runConfigFromResolved carries each pass effort', () => {
    const cfg = runConfigFromResolved(
      resolveBuiltinConfig({ profile: 'claude-only', overrides: { passes: { plan: { effort: 'high' } } } }),
    )
    expect(cfg.passes.plan.effort).toBe('high')
    expect(cfg.passes.implement.effort).toBeNull()
  })

  it('a Claude pass spawns with its effort, records it and shows it', () => {
    const base = makeConfig()
    const h = new Harness({
      ...base,
      passes: { ...base.passes, plan: { ...base.passes.plan, effort: 'max' } },
    })
    // Queued: the card already names it (from the run config), so nothing appears later.
    expect(toRunSnapshot(h.state, 0, 0).steps.plan.effort).toBe('max')
    h.toPlanRunning()
    expect(spawnOf(h)).toMatchObject({ t: 'spawn', step: 'plan', effort: 'max' })
    expect(h.step('plan').effort).toBe('max')
    expect(toRunSnapshot(h.state, 0, h.now).steps.plan.effort).toBe('max')
    expect(toRunSummary(h.state, h.now).steps.find((s) => s.key === 'plan')?.effort).toBe('max')
  })

  it('no effort: the spawn and the views say nothing (the vendor default)', () => {
    const h = new Harness().toPlanRunning()
    expect(spawnOf(h)).not.toHaveProperty('effort')
    expect(h.step('plan')).not.toHaveProperty('effort')
    expect(toRunSnapshot(h.state, 0, h.now).steps.plan).not.toHaveProperty('effort')
  })

  it('a vendor without an effort setting neither sends nor shows one', () => {
    const base = makeConfig()
    const h = new Harness({
      ...base,
      passes: {
        ...base.passes,
        plan: { ...base.passes.plan, vendor: 'gemini', model: null, effort: 'high' },
      },
    })
    expect(toRunSnapshot(h.state, 0, 0).steps.plan).not.toHaveProperty('effort')
    h.toPlanRunning()
    expect(spawnOf(h)).not.toHaveProperty('effort')
    expect(h.step('plan')).not.toHaveProperty('effort')
  })
})
