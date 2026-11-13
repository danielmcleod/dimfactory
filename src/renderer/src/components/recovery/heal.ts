// Self-heal in the renderer (the snag card and Settings → Self-heal). Core keeps a
// failed step's AI diagnosis on the step (StepView.heal: `running`, then the healer's answer) and announces each change
// with an `output` body for `heal`, which refetches the snapshot. This file words a HealView, remembers a diagnosis the
// user asked for until core's answer shows (the button's spinner covers the gap between the click and core's
// `running`), and lists the heals of the runs the renderer has loaded (Settings → Self-heal, newest first).
import { useSyncExternalStore } from 'react'
import type { FailureCategory, HealView, RecoveryAction } from '@shared/failure.ts'
import { hiddenSuggestionsText } from '@shared/failure.ts'
import { STEP_KEYS } from '@shared/run.ts'
import type { RunSnapshot, StepKey, StepView } from '@shared/run.ts'
import { coreNow } from '../../lib/coreClock.ts'
import type { StoreState } from '../../state/store.ts'
import { runCommand } from '../run/commands.ts'
import { patchGroups } from './ConfigPatchControl.tsx'
import { execute } from './execute.ts'

/** The snag card's diagnose button (primary only where core lists it first, e.g. for `unknown`). */
export const HEAL_LABEL = 'Ask AI to diagnose'
/** Core's generic labels for the same action, shown as {@link HEAL_LABEL}; a specific one ("Find the renamed flag") stays. */
const GENERIC_HEAL_LABELS: ReadonlySet<string> = new Set(['Diagnose with AI', HEAL_LABEL])

/** How long a requested diagnosis counts as on its way without core's word (the healer's 90 s timeout + margin). */
export const HEAL_WAIT_MS = 120_000

export const HEAL_RUNNING_TEXT =
  'Asking AI to diagnose this failure. It reads only the error output, never your code or task. This can take up to 90 seconds.'
export const HEAL_DISABLED_TEXT = 'AI diagnosis is turned off.'
export const HEAL_FAILED_TEXT = 'The AI diagnosis failed.'
export const HEAL_NOTHING_TEXT = 'The AI suggested nothing Dim Factory can apply.'
export const SELF_HEAL_ROUTE = '#/settings/self-heal'

/** The label a heal action shows. */
export function healLabel(a: RecoveryAction): string {
  return GENERIC_HEAL_LABELS.has(a.label.trim()) ? HEAL_LABEL : a.label
}

/** `Diagnosis (AI, medium confidence): …` (the snag card's one-line diagnosis). */
export function diagnosisText(h: Pick<HealView, 'status' | 'confidence' | 'diagnosis'>): string {
  const facts = ['AI']
  if (h.confidence !== undefined) facts.push(`${h.confidence} confidence`)
  if (h.status === 'cached') facts.push('from an earlier diagnosis')
  const said = h.diagnosis?.trim() ?? ''
  return `Diagnosis (${facts.join(', ')}): ${said !== '' ? said : 'the AI could not say what went wrong.'}`
}

/** "Dim Factory hid N unsafe suggestions", or null for none. */
export function hiddenText(h: Pick<HealView, 'hidden'>): string | null {
  const t = hiddenSuggestionsText(h.hidden)
  return t === '' ? null : t
}

/** What autoApplyConfigPatches did with this heal, or null. */
export function autoAppliedText(h: Pick<HealView, 'autoApplied' | 'actions'>): string | null {
  if (h.autoApplied === undefined) return null
  const a = h.actions.find((x) => x.id === h.autoApplied)
  return a !== undefined
    ? `Dim Factory applied "${a.label}" on its own and retried the pass.`
    : 'Dim Factory applied a suggested fix on its own and retried the pass.'
}

/** One word for a heal's state (Settings history). */
export function healResultText(h: HealView): string {
  switch (h.status) {
    case 'running':
      return 'Diagnosing'
    case 'disabled':
      return 'Self-heal off'
    case 'failed':
      return 'Failed'
    case 'ok':
    case 'cached': {
      // A config fix offered to this run and, with the same ops, saved too is one fix (ConfigPatchControl's block).
      const n = h.actions.filter((a) => a.kind !== 'config_patch').length + patchGroups(h.actions).size
      const parts = [n === 0 ? 'No fixes' : `${n} fix${n === 1 ? '' : 'es'} suggested`]
      if (h.hidden > 0) parts.push(`${h.hidden} hidden`)
      if (h.status === 'cached') parts.push('reused')
      return parts.join(' · ')
    }
  }
}

// ---- a diagnosis the user asked for -----------------------------------------------------------------------------

export interface HealRequest {
  /** Core time of the click. */
  at: number
  /** The step's heal when the user asked (status + time), so a new answer is told apart from the old one. */
  baseline: string | null
  /** The command is still in flight. */
  inFlight: boolean
}

const requests = new Map<string, HealRequest>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of [...listeners]) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

const requestKey = (runId: string, step: StepKey): string => `${runId}\u0000${step}`

/** Identifies one heal answer. */
export function healKey(h: HealView | undefined): string | null {
  return h === undefined ? null : `${h.status}|${h.at}`
}

/** The diagnosis the user asked for on this step, while the renderer remembers one. */
export function useHealRequest(runId: string, step: StepKey): HealRequest | undefined {
  return useSyncExternalStore(subscribe, () => requests.get(requestKey(runId, step)))
}

/**
 * Whether a diagnosis is on its way: core says it runs, or the user asked and core has not answered yet (the
 * command is in flight, or core's heal is still the one from before the click, for at most HEAL_WAIT_MS).
 */
export function healPending(h: HealView | undefined, req: HealRequest | undefined, now: number): boolean {
  if (h?.status === 'running') return true
  if (req === undefined) return false
  if (req.inFlight) return true
  return healKey(h) === req.baseline && now - req.at < HEAL_WAIT_MS
}

/**
 * Ask for a diagnosis of a failed step: core's own heal action when the snag lists one (recovery.execute), else
 * `heal.diagnose{runId, step}`. Either way the answer arrives as StepView.heal.
 */
export async function requestHeal(
  runId: string,
  step: StepKey,
  current: HealView | undefined,
  action: RecoveryAction | undefined,
): Promise<void> {
  const key = requestKey(runId, step)
  if (requests.get(key)?.inFlight === true) return
  const req: HealRequest = { at: coreNow(), baseline: healKey(current), inFlight: true }
  requests.set(key, req)
  emit()
  let ok = false
  try {
    if (action !== undefined) ok = (await execute(action, { runId, step })).outcome === 'done'
    else ok = (await runCommand(runId, 'heal.diagnose', { runId, step })).ok
  } finally {
    if (requests.get(key) === req) {
      if (ok) requests.set(key, { ...req, inFlight: false })
      else requests.delete(key)
      emit()
    }
  }
}

/** Tests: forget every request. */
export function resetHealForTests(): void {
  requests.clear()
  emit()
}

// ---- history (Settings → Self-heal) ---------------------------------------------------------------------------

export interface HealEntry {
  runId: string
  displayNo: number
  title: string
  step: StepKey
  /** The step's failure (core's classification), else the category the AI named. */
  category?: FailureCategory
  heal: HealView
}

function entriesOf(snap: RunSnapshot): HealEntry[] {
  const out: HealEntry[] = []
  for (const step of STEP_KEYS) {
    // A snapshot from an older core may lack a step.
    const view = snap.steps[step] as StepView | undefined
    const heal = view?.heal
    if (view === undefined || heal === undefined) continue
    const category = view.failure?.category ?? heal.category
    out.push({
      runId: snap.summary.runId,
      displayNo: snap.summary.displayNo,
      title: snap.summary.title,
      step,
      ...(category !== undefined ? { category } : {}),
      heal,
    })
  }
  return out
}

/** The newest heals of the runs the renderer has loaded, newest first. */
export function collectHeals(runs: StoreState['runs']['byId'], limit = 10): HealEntry[] {
  const all: HealEntry[] = []
  for (const entry of Object.values(runs)) {
    if (entry.snapshot !== null) all.push(...entriesOf(entry.snapshot))
  }
  all.sort((a, b) => b.heal.at - a.heal.at || b.displayNo - a.displayNo)
  return all.slice(0, limit)
}
