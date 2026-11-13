// The approved plan and whether it was edited at the gate (the Plan PassCard and the SummaryBar; R4: an edited plan is written to plan.md with the original kept in plan.original.md). Core exposes the edit only
// as that second file, so "edited" means plan.original.md exists; the counts come from lib/linediff. Whether the
// gate ran at all, and how it closed, is core's `card` envelope for gate:afterPlan (no gate under Auto or with
// gates.afterPlan off), read from the log once per Plan attempt.
import { useEffect, useMemo, useState } from 'react'
import type { RunSnapshot } from '@shared/run.ts'
import { STEP_KEYS } from '@shared/run.ts'
import { diffLines } from '../../lib/linediff.ts'
import type { LineDiff } from '../../lib/linediff.ts'
import { CHOICE } from '../cards/payload.ts'
import { useRunOutput } from './outputs.ts'
import type { OutputState } from './outputs.ts'
import { findFirstEnvelope } from './runLog.ts'

export interface PlanInfo {
  /** plan.md once the Plan step is done. */
  plan: OutputState
  /** plan.original.md: `missing` when the plan was not edited. */
  original: OutputState
  /** The edit, when the plan was edited and both texts are loaded. */
  edit: LineDiff | null
  /** The plan gate is open (its card shows the plan; nothing was approved yet). */
  gateOpen: boolean
}

/** `enabled` false reads nothing (the hook is called unconditionally by every PassCard). */
export function usePlanInfo(runId: string, snap: RunSnapshot, enabled = true): PlanInfo {
  const step = snap.steps.plan
  const gateOpen = snap.cards.some((c) => c.kind === 'gate:afterPlan')
  const done = enabled && step.status === 'done'
  // plan.md is rewritten (and plan.original.md written) when the gate closes with an edit, so the gate is part of the
  // version key: open, or how it closed once the log says (usePlanGate). Plan can be done before its gate opens
  // (core's plan-end guard runs in between), so what was read then ("not known yet") is never what the key names
  // once the gate has closed.
  const gate = usePlanGate(runId, snap, enabled)
  const key = `${step.attempt}:${step.status}:${gateOpen ? 'gate' : `closed:${gate ?? 'unknown'}`}`
  const plan = useRunOutput(runId, 'plan', key, done)
  const original = useRunOutput(runId, 'plan.original', key, done && !gateOpen)
  const planText = plan.status === 'ready' ? plan.output.text : null
  const originalText = original.status === 'ready' ? original.output.text : null
  const edit = useMemo(
    () => (planText !== null && originalText !== null ? diffLines(originalText, planText) : null),
    [planText, originalText],
  )
  return { plan, original, edit, gateOpen }
}

/** How the gate after Plan closed: approved, cancelled, or `none` when no gate ran. */
export type PlanGate = 'approved' | 'cancelled' | 'none'

const PLAN_INDEX = STEP_KEYS.indexOf('plan')
const GATE_CACHE_MAX = 40
const gates = new Map<string, Promise<PlanGate | null>>()

/**
 * The gate's outcome from the log: its resolved card, looked for until a later step reports. null: not known (the log
 * is unreadable, or it ends before either: the gate may still open, since the plan-end guard runs between Plan's end
 * and the gate). Only a settled answer is kept, so the next read (the gate opening and closing re-enables usePlanGate)
 * asks again.
 */
function loadPlanGate(runId: string, attempt: number): Promise<PlanGate | null> {
  const id = `${runId}\u0000${attempt}`
  let p = gates.get(id)
  if (p === undefined) {
    let laterStep = false
    const mine: Promise<PlanGate | null> = findFirstEnvelope(
      runId,
      (b) => b.t === 'card' && b.card.kind === 'gate:afterPlan' && b.state === 'resolved',
      {
        until: (b) => {
          laterStep = b.t === 'step-status' && STEP_KEYS.indexOf(b.step) > PLAN_INDEX
          return laterStep
        },
      },
    ).then((env): PlanGate | null => {
      // Unreadable, or not settled yet (null: not known): not cached, so the next mount or re-enable asks again.
      if (env === undefined || (env === null && !laterStep)) {
        if (gates.get(id) === mine) gates.delete(id)
        return null
      }
      if (env === null || env.body.t !== 'card') return 'none'
      return env.body.choiceId === CHOICE.approve ? 'approved' : 'cancelled'
    })
    p = mine
    gates.set(id, p)
    while (gates.size > GATE_CACHE_MAX) {
      const oldest = gates.keys().next().value
      if (oldest === undefined) break
      gates.delete(oldest)
    }
  }
  return p
}

/**
 * The plan gate's outcome once Plan is done and no gate is open; undefined while unknown (also while the log has
 * neither the gate nor a later step yet). `on` false reads nothing.
 */
export function usePlanGate(runId: string, snap: RunSnapshot, on = true): PlanGate | undefined {
  const step = snap.steps.plan
  const gateOpen = snap.cards.some((c) => c.kind === 'gate:afterPlan')
  const enabled = on && step.status === 'done' && !gateOpen
  const id = `${runId}\u0000${step.attempt}`
  const [state, setState] = useState<{ id: string; gate: PlanGate | undefined }>({ id: '', gate: undefined })
  useEffect(() => {
    if (!enabled) return
    let live = true
    void loadPlanGate(runId, step.attempt).then((gate) => {
      if (live) setState({ id, gate: gate ?? undefined })
    })
    return () => {
      live = false
    }
  }, [runId, step.attempt, enabled, id])
  return enabled && state.id === id ? state.gate : undefined
}

/** Tests: forget every cached gate outcome. */
export function clearPlanGateCache(): void {
  gates.clear()
}
