// Words for asks (accessibility: an assertive live region announces each new ask
// once, a polite one says when an ask left without an answer from this window). Presentation only: who answered,
// how and when is core's (`ask-resolved` bodies); the time left is counted on core's clock.
import type { AskDecision, AskKind } from '@shared/events.ts'
import type { AskView } from '@shared/run.ts'
import { stepLabel, vendorName } from '../../lib/format.ts'
import type { AskResolution } from '../../lib/streamBuffer.ts'

/** Panel heading after the vendor's name: "Claude wants to run a command". */
export const ASK_TITLE: Readonly<Record<AskKind, string>> = {
  shell: 'wants to run a command',
  edit: 'wants to change a file',
  network: 'wants to use the network',
  other: 'asks for permission',
}

/** Before the detail in the announcement: "Claude asks to run: npm test". */
export const ASK_VERB: Readonly<Record<AskKind, string>> = {
  shell: 'asks to run',
  edit: 'asks to change',
  network: 'asks to reach',
  other: 'asks for',
}

export const DECISION_TEXT: Readonly<Record<AskDecision, string>> = {
  allow: 'Allowed once',
  'allow-session': 'Allowed for this run',
  deny: 'Denied',
  cancel: 'Denied',
}

/** Longest detail read out by the screen reader; the panel shows all of it. */
const SPOKEN_DETAIL_MAX = 200

function spoken(detail: string): string {
  const one = detail.replace(/\s+/g, ' ').trim()
  return one.length > SPOKEN_DETAIL_MAX ? `${one.slice(0, SPOKEN_DETAIL_MAX)}…` : one
}

/** "9 minutes left", "1 minute left", "45 seconds left", "no time left" (core ms). */
export function timeLeftText(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000)
    return `${m} ${m === 1 ? 'minute' : 'minutes'} left`
  }
  const s = Math.ceil(ms / 1000)
  if (s <= 0) return 'no time left'
  return `${s} ${s === 1 ? 'second' : 'seconds'} left`
}

/** The heading: "Implement · Claude wants to run a command". */
export function askHeading(ask: Pick<AskView, 'step' | 'vendor' | 'kind'>): string {
  return `${stepLabel(ask.step)} · ${vendorName(ask.vendor)} ${ASK_TITLE[ask.kind]}`
}

/**
 * The assertive announcement of a new ask: "Implement: Claude wants to run a command. Claude asks to run: npm test.
 * 9 minutes left." `others` asks arrived with it.
 */
export function announcement(ask: AskView, remainingMs: number, others = 0): string {
  const who = vendorName(ask.vendor)
  const parts = [
    `${stepLabel(ask.step)}: ${who} ${ASK_TITLE[ask.kind]}.`,
    `${who} ${ASK_VERB[ask.kind]}: ${spoken(ask.detail)}.`,
    `${timeLeftText(remainingMs).replace(/^./, (c) => c.toUpperCase())}.`,
  ]
  if (others > 0) parts.push(`${others} more ${others === 1 ? 'question is' : 'questions are'} waiting.`)
  return parts.join(' ')
}

/** Why an ask left the queue without an answer from this window, or null when there is nothing to say. */
export interface AskNote {
  requestId: string
  /** "Answered from a notification", "Withdrawn by Claude", … */
  title: string
  /** What was asked, and what became of it: "Allowed once · npm test". */
  detail: string
}

export function noteFor(
  ask: Pick<AskView, 'requestId' | 'vendor' | 'detail'>,
  resolved: AskResolution | undefined,
): AskNote | null {
  if (resolved === undefined) return null
  const decided = resolved.decision !== undefined ? `${DECISION_TEXT[resolved.decision]} · ` : ''
  const make = (title: string): AskNote => ({
    requestId: ask.requestId,
    title,
    detail: `${decided}${ask.detail}`,
  })
  switch (resolved.by) {
    case 'user':
      if (resolved.via === 'notification') return make('Answered from a notification')
      if (resolved.via === 'cli') return make('Answered from the command line')
      // Answered in this window: nothing to explain.
      return null
    case 'vendor-cancel':
      return make(`Withdrawn by ${vendorName(ask.vendor)}`)
    case 'timeout':
      return make('Nobody answered in time')
    case 'auto':
      return make('Approved by Auto')
    case 'stop':
      return null
  }
}
