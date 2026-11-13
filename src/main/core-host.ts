// Main's narrow view of the core for notifications and timers: a core
// notification's facts in main's terms, answers from a desktop notification (deny at once, `via:'notification'`;
// stale → "already answered/expired"), the run's pending asks, sleep and the E2E clock. Electron-free.
import { basename } from 'node:path'
import type { Core, CoreNotification } from '@core/app-core.ts'
import { isStaleAsk } from '@core/app-core.ts'
import { unwrap } from '@core/errors.ts'
import type { AnswerDecision, NotificationFacts } from './notifications-model.ts'
import type { PowerState } from './power.ts'

export type AnswerOutcome = { kind: 'answered' } | { kind: 'stale' } | { kind: 'error'; message: string }

export interface CoreHostBridge {
  /** The facts of a core notification; null for kinds that never notify (stopped, non-gate cards) or a gone subject. */
  facts(n: CoreNotification): NotificationFacts | null
  answer(a: { runId: string; requestId: string; decision: AnswerDecision }): Promise<AnswerOutcome>
  /** Request ids of the run's asks still waiting for an answer. */
  pendingAsks(runId: string): string[]
  power(state: PowerState): Promise<void>
  /** E2E only: move the core clock; the new now. Throws the core's error (UNSUPPORTED outside E2E). */
  advanceClock(ms: number): Promise<number>
}

/** The last segment of a run's folder (`C:\src\my-app` → `my-app`), for "Plan ready · my-app". */
export function folderName(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || basename(folder) || folder
}

/** Core's facts (CoreNotification.run/ask/card/completed/failed) as the notification model's. */
export function factsOf(n: CoreNotification): NotificationFacts | null {
  const run = n.run
  if (run === undefined) return null
  const base = { runId: run.runId, folder: folderName(run.folder) }
  switch (n.kind) {
    case 'ask':
      if (n.ask === undefined) return null
      return {
        ...base,
        kind: 'ask',
        vendor: n.ask.vendorName,
        requestId: n.ask.requestId,
        detail: n.ask.detail,
        expiresAt: n.ask.expiresAt,
        allowSession: n.ask.allowSession,
      }
    case 'gate':
      return n.card?.kind === 'gate:beforeFix'
        ? { ...base, kind: 'gate', title: run.title, beforeFix: { cardTitle: n.card.title } }
        : { ...base, kind: 'gate', title: run.title }
    case 'completed':
      if (n.completed === undefined) return null
      return {
        ...base,
        kind: 'completed',
        title: run.title,
        outcome: n.completed.outcome,
        durationMs: n.completed.durationMs,
        costUsd: n.completed.costUsd,
        ...(n.completed.costEstimated === true ? { costEstimated: true } : {}),
      }
    case 'failed':
      if (n.failed === undefined) return null
      return { ...base, kind: 'failed', title: run.title, categoryTitle: n.failed.title }
    case 'card':
    case 'stopped':
      // Not a notification event: other cards and a user's Stop raise no desktop notification.
      return null
  }
}

type BridgeCore = Pick<Core, 'answerAsk' | 'attention' | 'power' | 'advanceClock'>

export function createCoreHostBridge(core: BridgeCore): CoreHostBridge {
  return {
    facts: factsOf,
    answer: async (a) => {
      const r = await core.answerAsk({ ...a, via: 'notification' })
      if (r.ok) return { kind: 'answered' }
      if (isStaleAsk(r)) return { kind: 'stale' }
      return { kind: 'error', message: r.error.message }
    },
    pendingAsks: (runId) =>
      core.attention().items.flatMap((i) => (i.kind === 'ask' && i.runId === runId ? [i.ask.requestId] : [])),
    power: (state) => core.power(state),
    advanceClock: async (ms) => unwrap(await core.advanceClock(ms)).now,
  }
}
