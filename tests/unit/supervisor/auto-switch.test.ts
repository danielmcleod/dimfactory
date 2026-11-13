// Switching a running run to Auto (runs.switchToAuto): the resolved-config change and its guardrail check
// (core/auto-switch.ts), and the reducer's `auto-on` (pending and later asks of a spawn launched before the switch are
// approved by Auto; spawns after it launch in full mode; the gates ahead are skipped).
import { describe, expect, it } from 'vitest'
import { AUTO_SWITCH_OPS, autoSwitchConfig } from '@core/auto-switch.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { DimFactoryError } from '@core/errors.ts'
import type { ConfigPatchRecord, RunConfig, UserCommand } from '@core/supervisor/types.ts'
import { Harness, makeConfig } from './helpers.ts'

const ENTRY: ConfigPatchRecord = { at: 1, ops: [...AUTO_SWITCH_OPS], label: 'Switch to Auto', source: 'auto' }

/** The run's config as the controller hands it to the reducer after autoSwitchConfig. */
function autoOf(c: RunConfig): RunConfig {
  return {
    ...c,
    auto: true,
    gates: { afterPlan: false, beforeFix: false },
    passes: {
      ...c.passes,
      implement: { ...c.passes.implement, mode: 'full' },
      fix: { ...c.passes.fix, mode: 'full' },
    },
  }
}

function autoOn(h: Harness, patchId = 'auto-1'): UserCommand {
  const cmd: UserCommand = { kind: 'auto-on', config: autoOf(h.state.config), patchId, entry: ENTRY }
  h.user(cmd)
  return cmd
}

describe('autoSwitchConfig', () => {
  it('turns Auto on: full Implement and Fix, both gates off', () => {
    const before = resolveBuiltinConfig({ profile: 'claude-only' })
    expect(before.auto).toBe(false)
    const { config, ops } = autoSwitchConfig(before)
    expect(ops).toEqual(AUTO_SWITCH_OPS)
    expect(config.auto).toBe(true)
    expect(config.passes.implement.mode).toBe('full')
    expect(config.passes.fix.mode).toBe('full')
    expect(config.gates).toEqual({ afterPlan: false, beforeFix: false })
    // Nothing else changes.
    expect({ ...config, auto: false, passes: before.passes, gates: before.gates }).toEqual(before)
  })

  it('refuses a run already in Auto (CONFLICT)', () => {
    const { config } = autoSwitchConfig(resolveBuiltinConfig({ profile: 'claude-only' }))
    expect(() => autoSwitchConfig(config)).toThrow(DimFactoryError)
    try {
      autoSwitchConfig(config)
    } catch (err) {
      expect((err as DimFactoryError).code).toBe('CONFLICT')
    }
  })

  it('refuses when a guardrail forbids full access (FORBIDDEN, with the rule)', () => {
    const base = resolveBuiltinConfig({ profile: 'claude-only' })
    const guarded = {
      ...base,
      guardrails: { ...base.guardrails, rules: [{ kind: 'noFullAccess' as const }] },
    }
    try {
      autoSwitchConfig(guarded)
      expect.unreachable('the switch should be refused')
    } catch (err) {
      expect(err).toBeInstanceOf(DimFactoryError)
      expect((err as DimFactoryError).code).toBe('FORBIDDEN')
      expect((err as DimFactoryError).message).toMatch(/guardrail/i)
    }
  })
})

describe('auto-on (the reducer)', () => {
  it('during Plan: records the patch, skips the plan gate, and Implement launches in full mode', () => {
    const h = new Harness().toPlanRunning()
    autoOn(h)
    expect(h.fx('apply-patch')).toEqual([{ t: 'apply-patch', patchId: 'auto-1' }])
    expect(h.state.config.auto).toBe(true)
    expect(h.state.configPatches).toEqual([ENTRY])
    expect(h.state.notes.some((n) => /Switched to Auto/.test(n))).toBe(true)
    h.ev('plan', { type: 'session', id: 'plan-session' })
    h.ev('plan', { type: 'done', result: '## Goal\nAdd a flag.\n\n## Steps\n1. Edit `src/cli.ts` (edit)' })
    h.exit('plan')
    expect(h.state.cards.some((c) => c.view.kind === 'gate:afterPlan')).toBe(false)
    h.reconcile()
    h.snapshot('S0', 'tree-base')
    h.passPreflight('implement')
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'implement', mode: 'full' })])
  })

  it('during Implement: approves the pending ask and every later one of the running spawn', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    expect(h.step('implement').status).toBe('waiting')
    autoOn(h)
    expect(h.fx('answer')).toEqual([
      expect.objectContaining({ step: 'implement', requestId: 'q1', decision: 'allow' }),
    ])
    expect(h.bodies('ask-resolved')).toEqual([
      expect.objectContaining({ step: 'implement', requestId: 'q1', by: 'auto', decision: 'allow' }),
    ])
    expect(h.step('implement')).toMatchObject({ status: 'running', asks: [] })
    expect(h.step('implement').autoAnswered).toEqual({ approved: 1, denied: 0 })
    // A later ask of the same spawn (still in its earlier mode) is approved as it comes.
    h.ask('implement', 'q2')
    expect(h.fx('answer')).toEqual([expect.objectContaining({ requestId: 'q2', decision: 'allow' })])
    expect(h.bodies('ask-resolved')).toEqual([expect.objectContaining({ requestId: 'q2', by: 'auto' })])
    expect(h.fx('notify')).toEqual([])
    expect(h.step('implement')).toMatchObject({ status: 'running', asks: [] })
    expect(h.step('implement').autoAnswered).toEqual({ approved: 2, denied: 0 })
  })

  it('leaves a Deny in its undo grace alone', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app', graceMs: 3000 })
    autoOn(h)
    expect(h.fx('answer')).toEqual([])
    expect(h.step('implement').asks.map((a) => a.requestId)).toEqual(['q1'])
  })

  it('is refused once in Auto, and once the run has finished', () => {
    const h = new Harness().toImplementRunning()
    autoOn(h)
    autoOn(h, 'auto-2')
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    expect(h.fx('apply-patch')).toEqual([])
    const done = new Harness().toImplementRunning()
    done.user({ kind: 'stop' })
    autoOn(done)
    expect(done.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    expect(done.state.config.auto).toBe(false)
  })

  it('a run that started in Auto still shows the asks its full-mode spawn raises', () => {
    const h = new Harness(autoOf(makeConfig()))
    h.toPlanRunning()
    h.ev('plan', { type: 'session', id: 'plan-session' })
    h.ev('plan', { type: 'done', result: '## Goal\nAdd a flag.\n\n## Steps\n1. Edit `src/cli.ts` (edit)' })
    h.exit('plan')
    h.reconcile()
    h.snapshot('S0', 'tree-base')
    h.passPreflight('implement')
    h.ask('implement', 'q1')
    expect(h.fx('answer')).toEqual([])
    expect(h.step('implement').asks.map((a) => a.requestId)).toEqual(['q1'])
  })
})
