// What a side built, for the comparison (pure): the numbers the Match page puts next to each other, read from the
// run's state. Nothing here ranks the sides.
import { MATCH_BUILD_PASSES } from '../../shared/match.ts'
import type { MatchSideDetail } from '../../shared/match.ts'
import type { StepKey } from '../../shared/run.ts'
import { closingMessage, stepSpend } from '../supervisor/derive.ts'
import type { RunState, StepState } from '../supervisor/types.ts'

/** The closing message is shown whole up to this many characters. */
export const CLOSING_MAX = 8000

const ran = (st: StepState | undefined): st is StepState =>
  st !== undefined && st.status !== 'queued' && st.status !== 'skipped'

/** The last Verify round that ran: verify:2 after a Fix, else verify:1. */
function lastVerify(s: RunState): StepState | undefined {
  const keys: StepKey[] = ['verify:2', 'verify:1']
  for (const k of keys) {
    const st = s.steps[k] as StepState | undefined
    if (st?.verify !== undefined && st.verify.commands.length > 0) return st
  }
  return undefined
}

export function sideDetail(
  s: RunState,
  o: { thumbnail?: string | null; shared?: boolean } = {},
): MatchSideDetail {
  const out: MatchSideDetail = {}
  const said = closingMessage(s)
  if (said !== undefined && said.trim() !== '') {
    out.closing = said.length > CLOSING_MAX ? `${said.slice(0, CLOSING_MAX)}\n…` : said
  }
  if (s.diffStats !== undefined) out.lines = { added: s.diffStats.added, deleted: s.diffStats.deleted }
  const verify = lastVerify(s)
  if (verify?.verify !== undefined) {
    const cmds = verify.verify.commands
    out.checks = {
      passed: cmds.filter((c) => c.status === 'pass').length,
      failed: cmds.filter((c) => c.status === 'fail').length,
    }
  }
  if (s.grounding !== undefined) {
    out.grounding = Object.values(s.grounding.checks).reduce((n, c) => n + c.findings.length, 0)
  }
  let buildMs = 0
  for (const k of MATCH_BUILD_PASSES) {
    const st = s.steps[k] as StepState | undefined
    if (ran(st)) buildMs += st.activeMs
  }
  if (buildMs > 0) out.buildMs = buildMs
  if (o.shared === true) {
    let usd: number | null = null
    let any = false
    for (const k of ['clarify', 'research'] as const) {
      const st = s.steps[k] as StepState | undefined
      if (!ran(st)) continue
      any = true
      const c = stepSpend(st)?.usd ?? null
      if (c !== null) usd = (usd ?? 0) + c
    }
    if (any) out.sharedCostUsd = usd
  }
  const reviewers: string[] = []
  for (const k of ['review', 'critic'] as const) {
    const st = s.steps[k] as StepState | undefined
    if (ran(st) && st.vendor !== undefined && !reviewers.includes(st.vendor)) reviewers.push(st.vendor)
  }
  if (reviewers.length > 0) {
    out.reviewers = reviewers
    const builder = (s.steps.implement as StepState | undefined)?.vendor
    if (builder !== undefined && reviewers.includes(builder)) out.selfReviewed = true
  }
  if (typeof o.thumbnail === 'string' && o.thumbnail !== '') out.thumbnail = o.thumbnail
  return out
}
