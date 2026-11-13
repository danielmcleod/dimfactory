// What a host needs to present a notification (attention surfaces, events, notification
// rules). Core states the facts from the run state at the `notify` effect; main decides the surface (toast,
// in-app toast, tray), the wording and the rate rules, and only formats these.
import type { AskKind } from '../../shared/events.ts'
import type { FailureCategory } from '../../shared/failure.ts'
import type { AgentStep, CardKind, RunOutcome, StepKey } from '../../shared/run.ts'
import { AGENT_STEPS, STEP_KEYS, configPassOf, isAgentStep } from '../../shared/run.ts'
import { categoryTitle } from '../heal/categories.ts'
import { stepSpend, totalCost } from './derive.ts'
import type { NotifyKind, RunState } from './types.ts'

/** The longest ask detail a notification carries (its first line). */
export const NOTIFY_DETAIL_MAX = 120

export interface NotificationRunFacts {
  runId: string
  displayNo: number
  title: string
  /** The folder the run works in (absolute path; the host shows its last segment). */
  folder: string
  auto: boolean
}

export interface NotificationAskFacts {
  requestId: string
  step: AgentStep
  /** Vendor id and display name ("Codex needs approval"). */
  vendor: string
  vendorName: string
  kind: AskKind
  /** The first line of the ask's detail, at most NOTIFY_DETAIL_MAX characters ("Bash: npm --version"). */
  detail: string
  reason?: string
  /** When the ask times out (the countdown: "9:58 left"); moved by a sleep (`ask-extended`). */
  expiresAt: number
  /** False: the toast offers no "Allow for this run". */
  allowSession: boolean
  /** Deny is the safer default for this ask. */
  defaultToNo?: boolean
  /** Asks of this run still waiting for an answer, this one included (bursts: "N approvals waiting"). */
  waiting: number
}

export interface NotificationCardFacts {
  id: string
  kind: CardKind
  title: string
  blocking: boolean
  step?: StepKey
}

export interface NotificationCompletedFacts {
  outcome: RunOutcome
  /** Created → ended, wall time (waits on the user included). */
  durationMs: number
  /** Every priced attempt's cost; null when nothing was priced. */
  costUsd: number | null
  /**
   * Live balanced run: part of costUsd is a catalog estimate (a Codex pass), so the host words it as the Run view
   * does ("$0.41 est."), not as a vendor-reported figure. Absent when every priced attempt's cost is the vendor's.
   */
  costEstimated?: boolean
}

export interface NotificationFailedFacts {
  step: StepKey
  category: FailureCategory
  /** The category's UI title with the vendor's name ("Claude needs you to log in"). */
  title: string
}

export interface NotificationFacts {
  run: NotificationRunFacts
  ask?: NotificationAskFacts
  card?: NotificationCardFacts
  completed?: NotificationCompletedFacts
  failed?: NotificationFailedFacts
}

export interface NotifyInput {
  kind: NotifyKind
  step?: StepKey
  requestId?: string
  cardId?: string
}

/** The first non-empty line of an ask's detail, clipped. */
export function shortDetail(detail: string, max: number = NOTIFY_DETAIL_MAX): string {
  const line =
    detail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The facts for one `notify` effect, read from the state right after the reduction that produced it. */
export function notificationFacts(
  n: NotifyInput,
  s: RunState,
  o: { vendorName: (vendor: string) => string; at: number },
): NotificationFacts {
  const facts: NotificationFacts = {
    run: { runId: s.runId, displayNo: s.displayNo, title: s.title, folder: s.folder, auto: s.config.auto },
  }
  switch (n.kind) {
    case 'ask': {
      for (const step of [n.step, ...AGENT_STEPS]) {
        if (!isAgentStep(step)) continue
        const st = s.steps[step]
        const ask = st.asks.find((a) => a.requestId === n.requestId)
        if (ask === undefined) continue
        const vendor = st.vendor ?? s.config.passes[configPassOf(step, s.config.passes)].vendor
        const f: NotificationAskFacts = {
          requestId: ask.requestId,
          step,
          vendor,
          vendorName: o.vendorName(vendor),
          kind: ask.kind,
          detail: shortDetail(ask.detail),
          expiresAt: ask.expiresAt,
          allowSession: ask.allowSession,
          waiting: Object.values(s.steps).reduce(
            (sum, x) => sum + x.asks.filter((a) => a.pendingDeny === undefined).length,
            0,
          ),
        }
        if (ask.reason !== undefined) f.reason = ask.reason
        if (ask.defaultToNo !== undefined) f.defaultToNo = ask.defaultToNo
        facts.ask = f
        break
      }
      break
    }
    case 'gate':
    case 'card': {
      const c = s.cards.find((x) => x.view.id === n.cardId)
      if (c !== undefined) {
        const f: NotificationCardFacts = {
          id: c.view.id,
          kind: c.view.kind,
          title: c.view.title,
          blocking: c.view.blocking,
        }
        if (c.step !== undefined) f.step = c.step
        facts.card = f
      }
      break
    }
    case 'completed':
      if (s.outcome !== undefined) {
        facts.completed = {
          outcome: s.outcome,
          durationMs: Math.max(0, (s.endedAt ?? o.at) - s.createdAt),
          costUsd: totalCost(s),
        }
        if (STEP_KEYS.some((k) => stepSpend(s.steps[k])?.bases.includes('catalog') === true))
          facts.completed.costEstimated = true
      }
      break
    case 'failed': {
      const step = n.step ?? s.failure?.step
      if (step === undefined) break
      const st = s.steps[step]
      const category = st.failure?.category ?? s.failure?.category
      if (category === undefined) break
      const vendor =
        st.vendor ??
        (isAgentStep(step) ? s.config.passes[configPassOf(step, s.config.passes)].vendor : undefined)
      facts.failed = {
        step,
        category,
        title: categoryTitle(category, vendor !== undefined ? { vendor: o.vendorName(vendor) } : {}),
      }
      break
    }
    case 'stopped':
      break
  }
  return facts
}
