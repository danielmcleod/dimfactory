// The run branch (`isolation.branch: runBranch`; at the end of a run: [Return to <prev>] only
// if <prev> still points at HEAD, [Delete run branch] only if the branch isn't checked out and its tip still equals
// base, otherwise copyable commands). Core records the branch in RunSnapshot.branch {name, base, previous}
// (`previous` = `refs/heads/<branch>` or `detached:<sha>`) and decides every end-of-run action: runs.branch{action}
// answers done, or why not with the commands the user can run instead. Nothing here decides whether an action applies.
// What core answered is kept for the session per run, so a tab switch (the Flow tab remounts) keeps it in view.
import { useSyncExternalStore } from 'react'
import type { BranchActionResult } from '@shared/ipc.ts'
import type { RunBranchInfo } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { toast } from '../../state/toasts.ts'
import { LATER_VERSION } from '../ui/DisabledHint.tsx'

export type BranchAction = 'return' | 'delete'

/** `refs/heads/main` → `main`; `detached:<sha>` → `detached HEAD at abc1234`; anything else as core wrote it. */
export function previousLabel(previous: string): string {
  if (previous.startsWith('refs/heads/')) return previous.slice('refs/heads/'.length)
  const m = /^detached:([0-9a-f]{7,64})$/i.exec(previous)
  if (m?.[1] !== undefined) return `detached HEAD at ${m[1].slice(0, 7)}`
  return previous
}

/** "On dim/20261008-add-version-flag (from main)". */
export function branchLineText(b: RunBranchInfo): string {
  return `On ${b.name} (from ${previousLabel(b.previous)})`
}

/** [Return to main] / [Return to abc1234] (a detached start names its commit). */
export function returnLabel(b: RunBranchInfo): string {
  const m = /^detached:([0-9a-f]{7,64})$/i.exec(b.previous)
  return `Return to ${m?.[1] !== undefined ? m[1].slice(0, 7) : previousLabel(b.previous)}`
}

export const DELETE_LABEL = 'Delete run branch'

/** What the user sees after core acted: done, or why not (with commands), or not in this build. */
export type BranchOutcome =
  | { kind: 'done'; message: string }
  | { kind: 'refused'; reason: string; commands: string[] }
  | { kind: 'unsupported' }

type Outcomes = Partial<Record<BranchAction, BranchOutcome>>

const outcomes = new Map<string, Outcomes>()
const listeners = new Set<() => void>()
const EMPTY: Outcomes = {}

function setOutcome(runId: string, action: BranchAction, o: BranchOutcome): void {
  outcomes.set(runId, { ...outcomes.get(runId), [action]: o })
  for (const l of [...listeners]) l()
}

/** What core answered for this run's branch actions this session. */
export function useBranchOutcomes(runId: string): Outcomes {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => outcomes.get(runId) ?? EMPTY,
  )
}

/** Tests: forget every answer. */
export function resetBranchOutcomesForTests(): void {
  outcomes.clear()
  for (const l of [...listeners]) l()
}

/** The words for a done action: core's own reason when it gave one (the branch was already gone). */
export function doneMessage(action: BranchAction, b: RunBranchInfo, r: BranchActionResult): string {
  if (r.reason !== undefined && r.reason !== '') return r.reason
  return action === 'return' ? `Back on ${previousLabel(b.previous)}.` : `Deleted ${b.name}.`
}

/** runs.branch{action}: core acts, or says why not and what to run instead. */
export async function branchAction(runId: string, action: BranchAction, b: RunBranchInfo): Promise<void> {
  const r = await invoke('runs.branch', { runId, action })
  if (!r.ok) {
    if (r.error.code === 'UNSUPPORTED') {
      setOutcome(runId, action, { kind: 'unsupported' })
      toast({
        level: 'warn',
        message: `${action === 'return' ? returnLabel(b) : DELETE_LABEL}: ${LATER_VERSION.toLowerCase()}.`,
      })
      return
    }
    toast({ level: 'error', message: r.error.message })
    return
  }
  const res = r.value
  if (res.done) {
    const message = doneMessage(action, b, res)
    setOutcome(runId, action, { kind: 'done', message })
    toast({ level: 'info', message })
  } else {
    setOutcome(runId, action, {
      kind: 'refused',
      reason: res.reason ?? 'Dim Factory did not change the branch.',
      commands: res.commands,
    })
  }
  void fetchSnapshot(runId)
}
