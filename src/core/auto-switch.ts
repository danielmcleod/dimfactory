// Switch a run to Auto while it runs (`runs.switchToAuto`): the same settings Auto gives a run at its start (Implement
// and Fix approve everything, both gates off), applied to the run's resolved config as a resolved.json `patches[]`
// entry, so a reload and Re-run see the run as it last ran. The guardrails that hold before a run starts hold here
// too: a rule against full access refuses the switch.
import type { ResolvedConfig } from '../shared/config-schema.ts'
import { ResolvedConfigZ } from '../shared/config-schema.ts'
import type { JsonPatchOp } from '../shared/failure.ts'
import type { RunPlanFacts } from '../shared/guardrails.ts'
import { checkRunPlan, rulesInForce } from '../shared/guardrails.ts'
import { PASS_NAMES } from '../shared/run.ts'
import { DimFactoryError } from './errors.ts'
import { applyJsonPatch } from './recovery/json-patch.ts'

/** The run's label for the change (resolved.json `patches[]`, the run's notes). */
export const AUTO_SWITCH_LABEL = 'Switch to Auto'

/** What Auto changes in a resolved config (config/resolve.ts applies the same at a run's start). */
export const AUTO_SWITCH_OPS: readonly JsonPatchOp[] = [
  { op: 'replace', path: '/auto', value: true },
  { op: 'replace', path: '/passes/implement/mode', value: 'full' },
  { op: 'replace', path: '/passes/fix/mode', value: 'full' },
  { op: 'replace', path: '/gates/afterPlan', value: false },
  { op: 'replace', path: '/gates/beforeFix', value: false },
]

/** What a run with this config is about to do, for the guardrails that hold before anything starts. */
export function runPlanFactsOf(cfg: ResolvedConfig): RunPlanFacts {
  const enabled = PASS_NAMES.filter((p) => cfg.passes[p].enabled)
  return {
    vendors: [...new Set(enabled.map((p) => cfg.passes[p].vendor))],
    fullAccess: cfg.auto || enabled.some((p) => cfg.passes[p].mode === 'full'),
    isolated: cfg.isolation.mode === 'worktree',
    extensionsInUse: enabled.filter((p) => cfg.passes[p].extensions !== 'none'),
    passes: enabled.map((p) => ({
      vendor: cfg.passes[p].vendor,
      fullAccess: cfg.auto || cfg.passes[p].mode === 'full',
    })),
  }
}

/**
 * The run's config in Auto, with the ops that make it so. CONFLICT when the run is in Auto already; FORBIDDEN when a
 * guardrail stops a run that approves everything (its rule and why, as the preflight says it).
 */
export function autoSwitchConfig(config: ResolvedConfig): { config: ResolvedConfig; ops: JsonPatchOp[] } {
  if (config.auto) throw new DimFactoryError('CONFLICT', 'This run is in Auto already.')
  const ops = AUTO_SWITCH_OPS.map((o) => ({ ...o }))
  const parsed = ResolvedConfigZ.safeParse(applyJsonPatch(config, ops))
  if (!parsed.success) {
    throw new DimFactoryError(
      'VALIDATION',
      `This run cannot switch to Auto: ${parsed.error.issues[0]?.message ?? 'invalid settings'}.`,
    )
  }
  const blocks = checkRunPlan(rulesInForce(parsed.data.guardrails), runPlanFactsOf(parsed.data))
  if (blocks.length > 0) {
    throw new DimFactoryError(
      'FORBIDDEN',
      `A guardrail keeps this run out of Auto: ${blocks.map((b) => `${b.rule}. ${b.detail}`).join(' ')}`,
    )
  }
  return { config: parsed.data, ops }
}
