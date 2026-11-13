// Which past runs a batch of rematches replays (pure). Up to five, chosen from the runs that can be replayed, newest
// first: one of each kind of task where there is one, then the newest of what is left. They are queued smallest first
// (by what the original cost), so a day's budget that runs out stops the batch after the cheap ones, not before them.
import { BATCH_MAX } from '../../shared/match.ts'
import type { BatchPlanItem } from '../../shared/match.ts'

/** `candidates` newest first. The chosen ones, cheapest first (unpriced last, then as they came). */
export function chooseBatch(candidates: readonly BatchPlanItem[], max: number = BATCH_MAX): BatchPlanItem[] {
  const chosen: BatchPlanItem[] = []
  const kinds = new Set<string>()
  for (const c of candidates) {
    if (chosen.length >= max) break
    if (kinds.has(c.category)) continue
    kinds.add(c.category)
    chosen.push(c)
  }
  for (const c of candidates) {
    if (chosen.length >= max) break
    if (!chosen.includes(c)) chosen.push(c)
  }
  const order = new Map(candidates.map((c, i) => [c.runId, i]))
  return chosen.sort((a, b) => {
    const [ca, cb] = [a.costUsd ?? Infinity, b.costUsd ?? Infinity]
    return ca !== cb ? ca - cb : (order.get(a.runId) ?? 0) - (order.get(b.runId) ?? 0)
  })
}

/** What the batch is expected to cost: what its originals cost; null when none was priced. */
export function batchTotal(items: readonly BatchPlanItem[]): number | null {
  const priced = items.filter((i) => typeof i.costUsd === 'number')
  if (priced.length === 0) return null
  return Math.round(priced.reduce((n, i) => n + (i.costUsd ?? 0), 0) * 100) / 100
}
