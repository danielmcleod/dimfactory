// Re-run and Re-run from Fix in the renderer (Re-run loads resolved.json.config; the Run view's [Re-run ▾] and the
// Runs history row actions; R14). Core decides
// everything here: whether Re-run from Fix is available, whether its Fix would continue Implement's session and why
// not (RunSnapshot.rerunFromFix), which findings there are (findings.json). This words those facts, sends runs.rerun,
// and keeps which run's findings picker is open in the Run view (the picker itself is FixPicker.tsx).
import { useSyncExternalStore } from 'react'
import type { Finding } from '@shared/findings.ts'
import { FRESH_REASONS } from '@shared/run.ts'
import type { FreshReason, RunSnapshot, RunStatus, RunSummary } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'
import { navigate } from '../../lib/router.ts'
import { vendorName } from '../../lib/format.ts'
import { toast } from '../../state/toasts.ts'
import { followUp } from '../palette/followUp.ts'
import { freshReasonWhy } from './SessionLine.tsx'
import { FRESH_REASON_TEXT } from './text.ts'

export const RERUN_LABEL = 'Re-run with same config'
export const RERUN_SHORT_LABEL = 'Re-run'
export const RERUN_FROM_FIX_LABEL = 'Re-run from Fix'
export const RERUN_HINT = "A new run with this run's task and settings"

/** R14: the statuses a run is re-run from (a live run is stopped or left to end first). */
const RERUNNABLE: ReadonlySet<RunStatus> = new Set(['completed', 'cancelled', 'failed', 'paused'])

export const RERUN_WAIT_REASON = 'Available once the run has ended, paused or failed'
export const NO_FINDINGS_REASON = 'The run has no findings for Fix to work on'
export const NO_DIFF_REASON = 'The run made no changes for Fix to build on'
export const NOT_AVAILABLE_REASON = 'Not available for this run'
export const CHECKING_TEXT = 'Checking…'

/** Why Re-run with same config is not offered for this run now; null when it is. */
export function rerunStartReason(s: Pick<RunSummary, 'status'>): string | null {
  return RERUNNABLE.has(s.status) ? null : RERUN_WAIT_REASON
}

/**
 * Core's rerunFromFix (RunSnapshot.rerunFromFix), read defensively since its fields are optional on the wire: why
 * it is not available (`unavailable`, UI copy) and the findings Fix gets by default (`findingIds`: every must, plus the
 * shoulds selected at the run's gate before Fix, in the run's order). A summary may carry the same facts.
 */
export interface RerunFromFixFacts {
  available: boolean
  fresh: boolean
  reason?: FreshReason
  /** Core's words for why it is not available, without a closing full stop. */
  disabledReason?: string
  /** Core's default selection for the picker; absent: every finding, as the gate before Fix starts. */
  findingIds?: readonly string[]
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** A reason to embed in a sentence: trimmed, without its closing full stop. */
function clause(text: string): string {
  return text.trim().replace(/\.+$/, '')
}

export function readRerunFromFix(v: unknown): RerunFromFixFacts | null {
  const r = rec(v)
  if (typeof r['available'] !== 'boolean') return null
  const reason = r['reason']
  const why = [r['unavailable'], r['disabledReason']].find(
    (x): x is string => typeof x === 'string' && clause(x) !== '',
  )
  const ids = r['findingIds']
  return {
    available: r['available'],
    fresh: r['fresh'] === true,
    ...(typeof reason === 'string' && (FRESH_REASONS as readonly string[]).includes(reason)
      ? { reason: reason as FreshReason }
      : {}),
    ...(why !== undefined ? { disabledReason: clause(why) } : {}),
    ...(Array.isArray(ids) ? { findingIds: ids.filter((x): x is string => typeof x === 'string') } : {}),
  }
}

/** The facts for a run: its summary's (when core sends them there), else its loaded snapshot's; null = not known. */
export function rerunFromFixOf(
  summary: RunSummary | undefined,
  snap: RunSnapshot | null | undefined,
): RerunFromFixFacts | null {
  const fromSummary = readRerunFromFix(rec(summary)['rerunFromFix'])
  if (fromSummary !== null) return fromSummary
  return snap != null ? readRerunFromFix(snap.rerunFromFix) : null
}

/** Why Re-run from Fix is not available: core's own words when it sends them, else the rule its facts break. */
export function rerunFromFixUnavailableReason(
  facts: RerunFromFixFacts,
  s: Pick<RunSummary, 'status' | 'findings' | 'progress'>,
): string {
  if (facts.disabledReason !== undefined) return facts.disabledReason
  if (!RERUNNABLE.has(s.status)) return RERUN_WAIT_REASON
  if (s.findings.must + s.findings.should === 0) return NO_FINDINGS_REASON
  if (s.progress.filesChanged === 0) return NO_DIFF_REASON
  return NOT_AVAILABLE_REASON
}

/** Whether its Fix would continue Implement's session, as core says it ("Fix would start a fresh session: …"). */
export function rerunFromFixSessionText(facts: Pick<RerunFromFixFacts, 'fresh' | 'reason'>): string {
  if (!facts.fresh) return 'Fix would continue the Implement session'
  return facts.reason !== undefined
    ? `Fix would start a fresh session: ${FRESH_REASON_TEXT[facts.reason]}`
    : 'Fix would start a fresh session'
}

/** The vendors the "Why?" names: the run's Fix and Implement steps. */
export interface RerunVendors {
  fix?: string | undefined
  implement?: string | undefined
}

export function vendorsOfSummary(s: Pick<RunSummary, 'steps'>): RerunVendors {
  return {
    fix: s.steps.find((x) => x.key === 'fix')?.vendor,
    implement: s.steps.find((x) => x.key === 'implement')?.vendor,
  }
}

export function vendorsOfSnapshot(snap: RunSnapshot): RerunVendors {
  return { fix: snap.steps.fix.vendor, implement: snap.steps.implement.vendor }
}

/**
 * Why Re-run from Fix would start fresh: the "Why?" sentence of the Fix card's session line (SessionLine.tsx), so
 * the card, the composer and Re-run say it in one wording; null when it would continue or is not available.
 */
export function rerunFromFixWhyOf(facts: RerunFromFixFacts | null, vendors: RerunVendors): string | null {
  if (facts === null || !facts.available || !facts.fresh || facts.reason === undefined) return null
  return freshReasonWhy(facts.reason, {
    step: 'fix',
    vendor: vendors.fix !== undefined ? vendorName(vendors.fix) : undefined,
    implementVendor: vendors.implement !== undefined ? vendorName(vendors.implement) : undefined,
  })
}

/** What Re-run from Fix would do for this run (or why it cannot), from core's rerunFromFix. */
export function rerunFromFixText(snap: RunSnapshot): string {
  const facts = readRerunFromFix(snap.rerunFromFix) ?? { available: false, fresh: false }
  return facts.available ? rerunFromFixSessionText(facts) : rerunFromFixUnavailableReason(facts, snap.summary)
}

/** Why Re-run from Fix would start fresh (see rerunFromFixWhyOf). */
export function rerunFromFixWhy(snap: RunSnapshot): string | null {
  return rerunFromFixWhyOf(readRerunFromFix(snap.rerunFromFix), vendorsOfSnapshot(snap))
}

/**
 * A source that still holds its folder lock (paused, or failed with its snag open) is cancelled when the
 * new run is queued, atomically. Core's summary says whether it holds the lock.
 */
export function stopsSourceFirst(s: Pick<RunSummary, 'lock' | 'status'>): boolean {
  return s.lock === 'held' && (s.status === 'paused' || s.status === 'failed')
}

export function stopsSourceText(displayNo: number): string {
  return `Run #${displayNo} still holds its folder, so it is stopped when the new run starts.`
}

/**
 * The line under Re-run with same config: why it waits; else, for a source still holding its folder, that it is
 * stopped when the new run starts (core does so for both forms of re-run, R14); else what it does.
 */
export function rerunStartHint(s: Pick<RunSummary, 'status' | 'lock' | 'displayNo'>): string {
  return rerunStartReason(s) ?? (stopsSourceFirst(s) ? stopsSourceText(s.displayNo) : RERUN_HINT)
}

// ---- commands -------------------------------------------------------------------------------------------------------

/** Re-run with same config: runs.rerun{from:'start'}, then the new run's view. Errors are toasts with core's words. */
export async function rerunStart(runId: string): Promise<boolean> {
  const r = await invoke('runs.rerun', { runId, from: 'start' })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  navigate({ name: 'run', runId: r.value.runId })
  return true
}

/** Re-run from Fix with the ticked findings (in core's order), then the new run's view. */
export async function rerunFix(runId: string, findingIds: readonly string[]): Promise<boolean> {
  const r = await invoke('runs.rerun', { runId, from: 'fix', findingIds: [...findingIds] })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  closeFixPicker(runId)
  navigate({ name: 'run', runId: r.value.runId })
  return true
}

// ---- findings ---------------------------------------------------------------------------------------------------------

function isFinding(v: unknown): v is Finding {
  const f = rec(v)
  return (
    typeof f['id'] === 'string' &&
    typeof f['n'] === 'number' &&
    (f['severity'] === 'must' || f['severity'] === 'should') &&
    typeof f['source'] === 'string' &&
    typeof f['title'] === 'string'
  )
}

/** A findings list as core sends it, must first (core numbers them so; kept in its order within each severity). */
function findingsOf(list: unknown): Finding[] | null {
  if (!Array.isArray(list)) return null
  const findings = list.filter(isFinding).map((f): Finding => ({
    ...f,
    body: typeof f.body === 'string' ? f.body : '',
    flags: Array.isArray(f.flags) ? f.flags : [],
  }))
  const must = findings.filter((f) => f.severity === 'must')
  return [...must, ...findings.filter((f) => f.severity !== 'must')]
}

/** findings.json's findings, must first (core numbers them so; kept in its order within each severity). */
export function parseFindingsFile(text: string): Finding[] | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  return findingsOf(rec(doc)['findings'])
}

export const FINDINGS_UNREADABLE = "Dim Factory could not read this run's findings."

/**
 * The findings Re-run from Fix offers for a run: core's own list (RunSnapshot.rerunFromFix.findings, with the ids
 * runs.rerun takes; there also when the run's Review/Critic join never ran, so it has no findings.json), else
 * findings.json (runs.output) from a core that does not send it. A string is why they could not be read.
 */
export async function loadFindings(runId: string): Promise<Finding[] | string> {
  const snap = await invoke('runs.get', { runId })
  if (snap.ok) {
    const offered = findingsOf(rec(snap.value.rerunFromFix)['findings'])
    if (offered !== null && offered.length > 0) return offered
  }
  const r = await invoke('runs.output', { runId, file: 'findings' })
  if (!r.ok) return snap.ok ? r.error.message : snap.error.message
  return parseFindingsFile(r.value.text) ?? FINDINGS_UNREADABLE
}

// ---- the Run view's picker ----------------------------------------------------------------------------------------------

/** The Run view's open picker of a run: the findings it offers (read once, when it opened). */
export interface FixPickerEntry {
  findings: readonly Finding[]
}

const pickers = new Map<string, FixPickerEntry>()
const loading = new Set<string>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The picker of a run in the Run view; null while it is closed (or its findings are being read). */
export function useFixPicker(runId: string): FixPickerEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => pickers.get(runId) ?? null,
    () => null,
  )
}

/** Whether the picker's findings are being read (the control that opens it shows it busy). */
export function useFixPickerLoading(runId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => loading.has(runId),
    () => false,
  )
}

/** The picker's section, for the reveal that follows the user's click. */
export function fixPickerTestId(runId: string): string {
  return `fix-picker-${runId}`
}

/**
 * Bring a picker (by its test id) into view once it is on the page, and focus it: the direct result of the user's
 * click (palette/followUp.ts; it gives up on the user's next input).
 */
export function revealPickerById(testId: string): void {
  followUp(() => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    return el !== null ? { focus: el } : null
  })
}

function revealPicker(runId: string): void {
  revealPickerById(fixPickerTestId(runId))
}

/**
 * Open the Run view's findings picker for a run: read its findings first, so the picker appears whole at the end of
 * the Flow tab (nothing it holds arrives after it is on the page), then bring it into view and focus it. Both are the
 * direct result of the user's click. Already open: brought into view again. Resolves to whether it is open.
 */
export async function openFixPicker(runId: string): Promise<boolean> {
  if (pickers.has(runId)) {
    revealPicker(runId)
    return true
  }
  if (loading.has(runId)) return false
  loading.add(runId)
  changed()
  const found = await loadFindings(runId)
  loading.delete(runId)
  if (typeof found === 'string') {
    changed()
    toast({ level: 'error', message: found })
    return false
  }
  pickers.set(runId, { findings: found })
  changed()
  revealPicker(runId)
  return true
}

export function closeFixPicker(runId: string): void {
  if (pickers.delete(runId)) changed()
}

/** Tests: close every picker. */
export function resetFixPickersForTests(): void {
  pickers.clear()
  loading.clear()
  changed()
}
