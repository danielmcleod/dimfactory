// The acceptance checklist (RunSnapshot.acceptance, StepView.acceptance, acceptance.json) derived from the run state:
// each of the plan's criteria with the acceptance review's verdict and evidence, the tests mapped to it, and with
// Fix until green the [must] finding it became, read as met once a round's re-check confirmed that finding resolved.
// Pure; the reducer (machine.ts) writes acceptance.json from it and the views (derive.ts) show it.
import { acceptanceCounts } from '../../shared/acceptance.ts'
import type { AcceptanceItemView, AcceptanceView } from '../../shared/acceptance.ts'
import { acceptanceOn, fixLoopOn } from './step-use.ts'
import type { RunState } from './types.ts'

/** The criterion id an acceptance finding stands for (`acceptance-ac2` → AC2). */
export function criterionOfFinding(findingId: string): string | undefined {
  const m = /^acceptance-ac(\d{1,3})(?:-\d+)?$/i.exec(findingId)
  return m === null ? undefined : `AC${Number(m[1])}`
}

/** UI copy for a criterion a re-check confirmed (no em dashes). */
export const RECHECK_EVIDENCE = (round: number): string => `Re-check: resolved in round ${round}.`

/** The checklist, or undefined while the decided plan has no criteria. */
export function acceptanceView(s: RunState): AcceptanceView | undefined {
  const a = (s as Partial<RunState>).acceptance
  if (a === undefined || a.criteria.length === 0) return undefined
  const on = acceptanceOn(s)
  const numbers = new Map((s.findings?.list ?? []).map((f) => [f.id, f.n]))
  const findingOf = new Map<string, string>()
  for (const f of a.findings ?? []) {
    const id = criterionOfFinding(f.id)
    if (id !== undefined && !findingOf.has(id)) findingOf.set(id, f.id)
  }
  const items = a.criteria.map((c): AcceptanceItemView => {
    const item: AcceptanceItemView = { id: c.id, text: c.text, status: 'not-checked' }
    const r = a.results?.[c.id]
    if (r !== undefined) {
      item.status = r.status
      if (r.evidence !== undefined && r.evidence !== '') item.evidence = r.evidence
    }
    const tests = a.tests?.[c.id] ?? []
    if (tests.length > 0) item.tests = [...tests]
    const fid = findingOf.get(c.id)
    const n = fid !== undefined ? numbers.get(fid) : undefined
    if (n !== undefined && n > 0) {
      item.finding = n
      const round = s.fixLoop?.rounds.find((x) => x.status === 'done' && x.resolved.includes(n))
      if (round !== undefined && item.status === 'not-met') {
        item.status = 'met'
        item.evidence = RECHECK_EVIDENCE(round.n)
      }
    }
    return item
  })
  const v: AcceptanceView = {
    review: on ? (a.review ?? 'pending') : 'off',
    findings: on && fixLoopOn(s),
    items,
    counts: acceptanceCounts(items),
  }
  if (a.note !== undefined) v.note = a.note
  return v
}
