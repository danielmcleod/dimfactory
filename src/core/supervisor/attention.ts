// Attention aggregation: needsYou = pending asks + open blocking cards (gates
// included) + stalled steps + paused steps + failed steps with an open snag. Computed only here.
import type { AttentionItem } from '../../shared/estimates.ts'
import { STEP_KEYS } from '../../shared/run.ts'
import { toAskViews } from './derive.ts'
import type { RunState } from './types.ts'

export interface Attention {
  needsYou: number
  items: AttentionItem[]
}

/** Items for one run; finished runs need nobody. Asks whose Deny is in its undo grace are already answered. */
export function runAttention(s: RunState): AttentionItem[] {
  if (s.status === 'completed' || s.status === 'cancelled' || s.stop) return []
  const base = { runId: s.runId, displayNo: s.displayNo, title: s.title, folder: s.folder }
  const items: AttentionItem[] = []
  for (const ask of toAskViews(s)) {
    if (ask.pendingDenyUntil !== undefined) continue
    const raisedAt =
      s.steps[ask.step].asks.find((a) => a.requestId === ask.requestId)?.raisedAt ?? s.createdAt
    items.push({ ...base, id: `ask:${ask.requestId}`, since: raisedAt, kind: 'ask', ask })
  }
  for (const c of s.cards) {
    if (!c.view.blocking) continue
    items.push({
      ...base,
      id: `card:${c.view.id}`,
      since: c.openedAt,
      kind: 'card',
      cardId: c.view.id,
      cardKind: c.view.kind,
      cardTitle: c.view.title,
      blocking: true,
    })
  }
  for (const k of STEP_KEYS) {
    const st = s.steps[k]
    const since = st.endedAt ?? st.lastEventAt ?? st.startedAt ?? s.createdAt
    if (st.status === 'stalled') {
      items.push({ ...base, id: `stalled:${k}`, since: st.lastEventAt ?? since, kind: 'stalled', step: k })
    } else if (st.status === 'paused' && st.pause !== undefined) {
      items.push({ ...base, id: `paused:${k}`, since, kind: 'paused', step: k, pause: st.pause })
    } else if (st.status === 'failed' && st.snagOpen && st.failure !== undefined) {
      items.push({
        ...base,
        id: `failed:${k}`,
        since,
        kind: 'failed',
        step: k,
        category: st.failure.category,
      })
    }
  }
  return items
}

/** Across runs, oldest first. */
export function aggregateAttention(runs: Iterable<RunState>): Attention {
  const items: AttentionItem[] = []
  for (const s of runs) items.push(...runAttention(s))
  items.sort((a, b) => a.since - b.since || a.displayNo - b.displayNo || a.id.localeCompare(b.id))
  return { needsYou: items.length, items }
}
