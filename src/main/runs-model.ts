// Main's view of the runs that matter to the shell (the attention count; close and
// quit): active runs for the tray count and tooltip, needsYou from the core's `attention` event, and the runs a
// quit would interrupt. Pure; fed from runs.list at boot and from bus `run-summary` / `attention` traffic.
import type { AttentionItem } from '@shared/estimates.ts'
import type { RunStatus, RunSummary } from '@shared/run.ts'

/** Tray "active" = not finished: queued, running, waiting or paused. */
export const ACTIVE_RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'paused',
] as const satisfies readonly RunStatus[]
/** A quit interrupts these; a paused run has already stopped, so quitting loses nothing of it. */
export const INTERRUPTIBLE_RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
] as const satisfies readonly RunStatus[]

const ACTIVE: ReadonlySet<RunStatus> = new Set(ACTIVE_RUN_STATUSES)
const INTERRUPTIBLE: ReadonlySet<RunStatus> = new Set(INTERRUPTIBLE_RUN_STATUSES)

/** Structurally the tray module's TrayState. */
export interface TraySnapshot {
  activeRuns: number
  needsYou: number
  runs: { runId: string; title: string; needsYou: boolean }[]
}

interface RunRow {
  runId: string
  displayNo: number
  title: string
  status: RunStatus
}

export class RunsModel {
  readonly #runs = new Map<string, RunRow>()
  #needsYou = 0
  #attentionRuns = new Set<string>()

  /** Replace the active set (boot: runs.list of the active statuses). */
  reset(summaries: readonly RunSummary[]): void {
    this.#runs.clear()
    for (const s of summaries) this.upsert(s)
  }

  /** Returns true when the active set or a title changed. */
  upsert(s: RunSummary): boolean {
    const prev = this.#runs.get(s.runId)
    if (!ACTIVE.has(s.status)) {
      if (prev === undefined) return false
      this.#runs.delete(s.runId)
      return true
    }
    if (prev !== undefined && prev.status === s.status && prev.title === s.title) return false
    this.#runs.set(s.runId, { runId: s.runId, displayNo: s.displayNo, title: s.title, status: s.status })
    return true
  }

  setAttention(needsYou: number, items: readonly AttentionItem[]): boolean {
    const runs = new Set(items.map((i) => i.runId))
    const same =
      needsYou === this.#needsYou &&
      runs.size === this.#attentionRuns.size &&
      [...runs].every((id) => this.#attentionRuns.has(id))
    this.#needsYou = needsYou
    this.#attentionRuns = runs
    return !same
  }

  get activeCount(): number {
    return this.#runs.size
  }

  get needsYou(): number {
    return this.#needsYou
  }

  activeRunIds(): string[] {
    return this.#sorted().map((r) => r.runId)
  }

  /** Runs a quit would interrupt (queued, running, waiting). */
  interruptibleRunIds(): string[] {
    return this.#sorted()
      .filter((r) => INTERRUPTIBLE.has(r.status))
      .map((r) => r.runId)
  }

  trayState(): TraySnapshot {
    return {
      activeRuns: this.#runs.size,
      needsYou: this.#needsYou,
      runs: this.#sorted().map((r) => ({
        runId: r.runId,
        title: r.title,
        needsYou: this.#attentionRuns.has(r.runId),
      })),
    }
  }

  #sorted(): RunRow[] {
    return [...this.#runs.values()].sort((a, b) => a.displayNo - b.displayNo)
  }
}

/** Stable key of a tray state, to skip identical updates. */
export function trayKey(s: TraySnapshot): string {
  return JSON.stringify(s)
}
