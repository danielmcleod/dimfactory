// Which optional steps a run uses, read from its config: the security advisor, Clarify before Plan, Fix until green,
// the re-check after Fix, the Deploy step, the acceptance review and Explain it to me. Pure; the reducer (machine.ts) and the views (derive.ts) share these rules.
import type { AgentStep, PassName } from '../../shared/run.ts'
import { configPassOf, isRoutedStep } from '../../shared/run.ts'
import type { RunConfig, RunPassConfig, RunState } from './types.ts'

type WithConfig = Pick<RunState, 'config'>

/**
 * The security advisor is on for this run: its Security pass is enabled (the scan, the third reviewer and, unless
 * turned off, the re-check after Fix). A run.json from before it existed has no Security pass: off.
 */
export function securityOn(s: WithConfig): boolean {
  return (s.config.passes as Partial<RunConfig['passes']>).security?.enabled === true
}

/** Clarify runs before Plan in this run (an earlier build's run.json has none). */
export function clarifyOn(s: WithConfig): boolean {
  return s.config.clarify !== undefined
}

/** Research runs before Plan in this run (an earlier build's run.json has none). */
export function researchOn(s: WithConfig): boolean {
  return s.config.research !== undefined
}

/** The Deploy step runs at the end of this run (an earlier build's run.json has none). */
export function deployOn(s: WithConfig): boolean {
  return s.config.deploy !== undefined
}

/** The acceptance review runs in this run (an earlier build's run.json has none). */
export function acceptanceOn(s: WithConfig): boolean {
  return s.config.acceptance === true
}

/** Explain it to me runs at the end of this run (an earlier build's run.json has none). */
export function explainOn(s: WithConfig): boolean {
  return s.config.explain === true
}

/** Fix until green is on for this run: more than one Fix round may run. */
export function fixLoopOn(s: WithConfig): boolean {
  return (s.config.fixLoop?.rounds ?? 1) > 1
}

/** The most Fix rounds this run may take (1 without Fix until green). */
export function fixRoundsMax(s: WithConfig): number {
  return fixLoopOn(s) ? (s.config.fixLoop?.rounds ?? 1) : 1
}

/** Fix until green re-checks every [must] of a round (not only the security ones). */
export function recheckAll(s: WithConfig): boolean {
  return fixLoopOn(s) && s.config.fixLoop?.recheck !== false
}

/**
 * The re-check after Fix runs in this run: the security advisor's (on, and its `recheck` not off), or Fix until
 * green's (its `recheck` on).
 */
export function recheckOn(s: WithConfig): boolean {
  if (recheckAll(s)) return true
  return securityOn(s) && s.config.passes.security.recheck !== false
}

/** The configured pass the re-check runs on: the Security pass's when the advisor is on, else Review's (or Critic's). */
export function recheckPass(s: WithConfig): PassName {
  return configPassOf('recheck', s.config.passes)
}

/**
 * The config a step of this run spawns with: its pass's, with model routing applied (a routed step runs the model and
 * effort its profile names for it, on its pass's vendor).
 */
export function stepPassConfig(s: WithConfig, k: AgentStep): RunPassConfig {
  const pc = s.config.passes[configPassOf(k, s.config.passes)]
  const route = isRoutedStep(k) ? (s.config as Partial<RunConfig>).routing?.[k] : undefined
  if (route === undefined) return pc
  return {
    ...pc,
    ...(route.model !== undefined ? { model: route.model } : {}),
    ...(route.effort !== undefined ? { effort: route.effort } : {}),
  }
}

/** The configured pass a step of this run runs on (the re-check placed by the run's passes). */
export function runPassOf(s: WithConfig, k: Parameters<typeof configPassOf>[0]): PassName {
  return configPassOf(k, s.config.passes)
}
