// The Match page's words (pure): what a side is called, who built it, the facts put next to each other, and where the
// match stands. While the names are hidden a side is "First result" or "Second result", and everything that would
// give the builder away (its name, its model, tokens, cost, who reviewed it) reads as hidden.
import {
  MATCH_BLIND_LABEL,
  MATCH_COPY_KEEP_DAYS,
  MATCH_SIDE_LABEL,
  blindNow,
  shownOrder,
} from '@shared/match.ts'
import type { MatchContestant, MatchSide, MatchSideView, MatchView } from '@shared/match.ts'
import { formatDuration, formatTokens, formatUsd, vendorName } from '../../lib/format.ts'

export const HIDDEN = 'Hidden until you pick'
export const KEEP_LABEL = 'Keep this result'
export const KEEP_NEITHER_LABEL = 'Keep neither'
export const PICK_LABEL = 'Pick this result'
export const PICK_NEITHER_LABEL = 'Pick neither'
export const SAVE_PATCH_LABEL = 'Save as a patch'
export const OPEN_TASK_LABEL = 'Open task'

/** What the page calls things for each kind of match: a Head to head keeps a result, a rematch only picks one. */
export function matchWords(kind: MatchView['kind']): {
  title: string
  keep: string
  neither: string
  marked: string
  help: string
} {
  return kind === 'rematch'
    ? {
        title: 'Rematch',
        keep: PICK_LABEL,
        neither: PICK_NEITHER_LABEL,
        marked: 'Your pick',
        help: 'A pick is your judgement. Nothing is written to the folder; a result can be saved as a patch.',
      }
    : {
        title: 'Head to head',
        keep: KEEP_LABEL,
        neither: KEEP_NEITHER_LABEL,
        marked: 'In the folder',
        help: 'Keeping a result writes its changes to the folder. Undo takes them out again.',
      }
}
export const UNDO_LABEL = 'Undo'
export const OPEN_BOTH_LABEL = 'Open both side by side'
export const OPEN_BOTH_REASON = 'Start the preview on both sides first (Run it, under each result).'
export const NO_SHOT = 'No page-load screenshot yet'
export const NOTHING_SAID = 'Nothing yet'
export const BLIND_SWITCH = 'Hide names until I pick'

/** What each side is called on the page right now. */
export function sideNames(view: Pick<MatchView, 'blind'>): Record<MatchSide, string> {
  if (!blindNow(view)) return { ...MATCH_SIDE_LABEL }
  const [first, second] = shownOrder(view)
  return { [first]: MATCH_BLIND_LABEL[0], [second]: MATCH_BLIND_LABEL[1] } as Record<MatchSide, string>
}

/** `Claude`, `Claude (opus)`, `Codex (default model, high)`. */
export function builderText(c: MatchContestant): string {
  const parts = [
    ...(typeof c.model === 'string' ? [c.model] : c.effort !== undefined ? ['default model'] : []),
    ...(c.effort !== undefined ? [c.effort] : []),
  ]
  return parts.length > 0 ? `${vendorName(c.vendor)} (${parts.join(', ')})` : vendorName(c.vendor)
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export interface Fact {
  key: string
  label: string
  value: string
}

/** The rows of a side's card: always the same rows in the same order, so the two cards line up. */
export function sideFacts(
  s: MatchSideView,
  o: { hide: boolean; tokens?: number | undefined; costUsd?: number | null | undefined } = { hide: false },
): Fact[] {
  const d = s.detail
  const started = s.runId !== undefined
  // A run that has ended will not get what it does not have: "yet" is only for one still going.
  const yet = s.endedAt === undefined ? ' yet' : ''
  const tokens = o.tokens ?? s.tokens
  const cost = o.costUsd !== undefined ? o.costUsd : s.costUsd
  const shared =
    d?.sharedCostUsd !== undefined && d.sharedCostUsd !== null
      ? ` (${formatUsd(d.sharedCostUsd)} of it for the questions and research both sides share)`
      : ''
  return [
    {
      key: 'checks',
      label: 'Checks',
      value:
        d?.checks !== undefined
          ? `${d.checks.passed} passed, ${d.checks.failed} failed`
          : `No checks ran${yet}`,
    },
    {
      key: 'findings',
      label: 'Review findings',
      value:
        s.findings !== undefined
          ? `${s.findings.must} must fix, ${s.findings.should} should fix`
          : 'None yet',
    },
    {
      key: 'grounding',
      label: 'Grounding',
      value:
        d?.grounding === undefined
          ? `Not checked${yet}`
          : d.grounding === 0
            ? 'No flags'
            : plural(d.grounding, 'flag'),
    },
    {
      key: 'changes',
      label: 'Changes',
      value: !started
        ? 'Not started'
        : `${plural(s.filesChanged ?? 0, 'file')}${
            d?.lines !== undefined ? `, +${d.lines.added} -${d.lines.deleted}` : ''
          }`,
    },
    {
      key: 'time',
      label: 'Time building',
      value: d?.buildMs !== undefined ? formatDuration(d.buildMs) : 'Not yet',
    },
    {
      key: 'tokens',
      label: 'Tokens',
      value: o.hide ? HIDDEN : tokens !== undefined ? formatTokens(tokens) : 'None yet',
    },
    {
      key: 'cost',
      label: 'Cost',
      value: o.hide
        ? HIDDEN
        : cost === undefined
          ? 'None yet'
          : cost === null
            ? 'No price'
            : `${formatUsd(cost)}${shared}`,
    },
    {
      key: 'reviewers',
      label: 'Reviewed by',
      value: o.hide
        ? HIDDEN
        : d?.reviewers === undefined
          ? `No review ran${yet}`
          : `${d.reviewers.map(vendorName).join(', ')}${
              d.selfReviewed === true ? ' (the same vendor that built it)' : ''
            }`,
    },
  ]
}

const LOSER = `The other copy is kept for ${MATCH_COPY_KEEP_DAYS} days, then removed. Its changes stay readable.`

/** Where the match stands, in one line. */
export function matchStatus(view: MatchView): string {
  const names = sideNames(view)
  if (view.kind === 'rematch') {
    if (view.pick !== undefined) {
      return view.pick.side === 'none'
        ? 'You picked neither. Nothing was applied.'
        : `You picked ${names[view.pick.side]}. Nothing was applied: a rematch is compared, not written to the folder.`
    }
    if (!view.ready) {
      return `Building from where run #${view.source?.displayNo ?? ''} began. The folder is not touched.`
    }
    return 'Both results are in. Pick the one you prefer, or neither.'
  }
  if (view.waiting) {
    return 'Side A is on its questions and research. Side B starts from the same answers when they are done.'
  }
  if (view.pick !== undefined) {
    if (view.pick.side === 'none') {
      return `You kept neither. Both copies are kept for ${MATCH_COPY_KEEP_DAYS} days, then removed. Their changes stay readable.`
    }
    return `${names[view.pick.side]} is in the folder. ${LOSER}`
  }
  if (view.kept !== undefined) return `${names[view.kept]} is in the folder.`
  const unstarted = view.sides.find((s) => s.runId === undefined && s.notStarted !== undefined)
  if (unstarted !== undefined) return unstarted.notStarted ?? ''
  if (!view.ready) return 'Building. Both sides have to finish before one is kept.'
  return 'Both sides are built. Keep one, or neither.'
}

/** Why "Keep this result" is off for a side, or null when it can be kept. */
export function keepBlocked(view: MatchView, s: MatchSideView): string | null {
  if (view.pick !== undefined) return 'This match has a pick. Undo it to choose again.'
  if (view.kind === 'rematch') return view.ready ? null : 'The new build has to finish first.'
  if (view.kept !== undefined) return 'A result is already in the folder.'
  if (!view.ready) return 'Both sides have to finish building first.'
  if (s.runId === undefined || s.notApplied !== true) return 'This side has no changes to keep.'
  return null
}
