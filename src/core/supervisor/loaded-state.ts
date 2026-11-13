// wait_until timers load disarmed after a relaunch ("Crash relaunch: armed wait_until timers come back disarmed.
// Never auto-resume."): what a run state read back from run.json by a new process
// may no longer claim. Its timers lived in the old process, so an armed wait loads disarmed (the step then offers
// Retry now and Re-arm), and a diagnosis that was still running died with that process. So did a revert that
// was writing the folder (write-ahead `pending`), which loads interrupted with its Undo, and every request the old
// process had in flight (it can never answer them; a revert's would refuse the Undo as "already running"), also on a
// finished run, which boot recovery does not relaunch.
import { STEP_KEYS } from '../../shared/run.ts'
import type { StepKey } from '../../shared/run.ts'
import { timerId } from './timers.ts'
import type { RunState, StepState } from './types.ts'

export const HEAL_INTERRUPTED = 'Dim Factory closed before the diagnosis finished. Ask again.'

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** A step that never began (as a new run has it). */
function unstartedStep(key: StepKey): StepState {
  return {
    key,
    status: 'queued',
    attempt: 0,
    spawnNo: 0,
    activeMs: 0,
    inFlightTools: [],
    asks: [],
    snagOpen: false,
    autoRetryUsed: false,
    meta: {},
  }
}

/** The security advisor's steps; a run without its Security pass never uses them. */
const SECURITY_STEPS: readonly StepKey[] = ['scan', 'security', 'recheck']

/**
 * A run.json an earlier build wrote has no row for the steps added since (Test-first's `tests` and `verify:red`, the
 * security advisor's `scan`, `security` and `recheck`, Clarify's `clarify`, which such a run never uses since its
 * config has no Clarify): they are added unstarted (the security steps settled as not
 * used, since that run has no Security pass), so every step key has its state; its config gains a Security pass that
 * is off. The same object when nothing is missing.
 */
export function withAllSteps(s: RunState): RunState {
  const steps = s.steps as Partial<RunState['steps']>
  const missing = STEP_KEYS.filter((k) => steps[k] === undefined)
  const passes = s.config.passes as Partial<RunState['config']['passes']>
  const noSecurity = passes.security === undefined
  if (missing.length === 0 && !noSecurity) return s
  const step = (k: StepKey): StepState =>
    SECURITY_STEPS.includes(k)
      ? { ...unstartedStep(k), status: 'skipped', reason: 'not used' }
      : unstartedStep(k)
  return {
    ...s,
    ...(noSecurity
      ? {
          config: {
            ...s.config,
            passes: {
              ...s.config.passes,
              security: {
                enabled: false,
                vendor: 'claude',
                model: null,
                mode: 'readonly',
                extensions: 'none',
              },
            },
          },
        }
      : {}),
    steps: { ...s.steps, ...Object.fromEntries(missing.map((k) => [k, step(k)])) },
  }
}

/** True when `disarmOnLoad` would change the state. */
export function needsDisarm(s: RunState): boolean {
  return (
    STEP_KEYS.some((k) => s.steps[k].wait?.armed === true || s.steps[k].heal?.status === 'running') ||
    (s.git?.reverts ?? []).some((r) => r.pending === true) ||
    Object.keys(s.requests).length > 0
  )
}

/**
 * Write-ahead: a revert that was writing the folder when Dim Factory closed keeps its Undo (RunSnapshot.revertUndo
 * offers it). Marks each `pending` record of `s` interrupted, in place, and returns the notes saying so.
 */
export function interruptPendingReverts(s: RunState): string[] {
  const notes: string[] = []
  for (const rec of s.git?.reverts ?? []) {
    if (rec.pending !== true) continue
    delete rec.pending
    rec.interrupted = true
    if (rec.paths.length > 0) {
      notes.push(
        `${rec.label} was interrupted when Dim Factory closed, so ${plural(rec.paths.length, 'file')} may be only partly reverted. Undo puts back what it changed.`,
      )
    }
  }
  return notes
}

/**
 * The state with every armed wait disarmed (`disarmed: 'relaunch'`, its timer dropped), every running heal marked
 * failed, every pending revert interrupted and the old process's requests dropped (as the relaunch drops them). Returns
 * the same object when nothing applies; never mutates its input.
 */
export function disarmOnLoad(loaded: RunState, at: number): RunState {
  const s = withAllSteps(loaded)
  if (!needsDisarm(s)) return s
  const out = structuredClone(s)
  for (const k of STEP_KEYS) {
    const st = out.steps[k]
    if (st.wait?.armed === true) {
      st.wait.armed = false
      st.wait.disarmed = 'relaunch'
      delete st.wait.auto
      delete out.timers[timerId.wait(k)]
    }
    if (st.heal?.status === 'running') {
      st.heal.status = 'failed'
      st.heal.error = HEAL_INTERRUPTED
      st.heal.at = at
    }
  }
  out.notes.push(...interruptPendingReverts(out))
  out.requests = {}
  return out
}
