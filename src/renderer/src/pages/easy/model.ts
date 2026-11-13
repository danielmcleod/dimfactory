// Easy mode's presentation logic, pure: a run's five milestones and their one-line status (from core's snapshot: the
// renderer only groups and words core's step statuses), plain words and a safe-answer tier for an ask, plain titles
// and bodies for cards, the figures on the confirm and Done screens, the project's short title, and what Open it can
// open (the rendered document, the page, a trusted preview). Words come from text.ts.
import { parseCriteria } from '@shared/acceptance-criteria.ts'
import type { AskView, CardView, RunSnapshot, StepKey, StepView } from '@shared/run.ts'
import { STEP_KEYS } from '@shared/run.ts'
import type { Milestone } from '@shared/easy.ts'
import { EASY_CHANGE_MAX, MILESTONES, STEP_MILESTONE } from '@shared/easy.ts'
import type { PreviewInfo } from '@shared/preview.ts'
import { planChangedPaths, trustOf } from '../../components/cards/payload.ts'
import { depsOf } from '../../components/run/isolation.ts'
import { cardStep } from '../../components/run/steps.ts'
import {
  ANSWER_NEEDED_TITLE,
  ASK_OTHER,
  ASK_RUN_COMMAND,
  ASK_RUN_PROJECT,
  CARD_TITLE,
  DEPS_FAILED_BODY,
  EMPTY_FINDINGS_BODY,
  LINE,
  RECONCILE_BODY,
  STALL_BODY,
  VERIFY_ENV_BODY,
  depsBodyText,
  planMutatedBodyText,
  preflightText,
  trustBodyText,
  askEditInsideText,
  askInstallText,
  askNetworkText,
  askOutsideText,
  buildingText,
  builtText,
  roundText,
  toFixText,
} from './text.ts'
import type { MilestoneState } from './text.ts'

// ---- milestones -------------------------------------------------------------------------------------------------

export interface MilestoneView {
  id: Milestone
  state: MilestoneState
  line: string
}

/** The steps of each milestone, in run order. */
export function milestoneSteps(m: Milestone): StepKey[] {
  return STEP_KEYS.filter((k) => STEP_MILESTONE[k] === m)
}

const ran = (v: StepView): boolean => v.attempt > 0
const working = (v: StepView): boolean => v.status === 'running' || v.status === 'stalled'
const holding = (v: StepView): boolean => v.status === 'waiting' || v.status === 'paused'
const finished = (v: StepView): boolean =>
  v.status === 'done' || v.status === 'skipped' || v.status === 'cancelled'

/** The milestone a card belongs to (its step's; a card without one belongs to the milestone in progress). */
export function cardMilestone(card: CardView, current: Milestone): Milestone {
  const step = cardStep(card)
  return step !== null ? STEP_MILESTONE[step] : current
}

function needsYouLine(m: Milestone, cards: readonly CardView[]): string {
  if (m === 'understand') {
    if (cards.some((c) => c.kind === 'clarify')) return LINE.waitingAnswers
    if (cards.some((c) => c.kind === 'research')) return LINE.waitingResearch
    if (cards.some((c) => c.kind === 'gate:afterPlan')) return LINE.waitingPlan
  }
  return LINE.needsAnswer
}

function workingLine(m: Milestone, snap: RunSnapshot): string {
  const s = snap.steps
  switch (m) {
    case 'understand':
      if (working(s.clarify)) return LINE.thinkingQuestions
      if (working(s.research)) return LINE.lookingAround
      if (working(s.plan)) return LINE.writingPlan
      return LINE.gettingReady
    case 'build':
      return buildingText(snap.summary.progress.filesChanged)
    case 'check':
      return LINE.checking
    case 'fix': {
      const round = s.fix.round ?? s['verify:2'].round ?? s.recheck.round
      return round !== undefined ? roundText(round.n, round.of) : LINE.fixing
    }
    case 'wrap':
      return working(s.explain) ? LINE.writingHowTo : LINE.gettingReady
  }
}

function doneLine(m: Milestone, snap: RunSnapshot): string {
  switch (m) {
    case 'build':
      return builtText(snap.summary.progress.filesChanged)
    case 'check': {
      const must = snap.summary.findings.must
      return must > 0 ? toFixText(must) : LINE.nothingToFix
    }
    case 'fix':
      return LINE.fixed
    case 'understand':
    case 'wrap':
      return LINE.done
  }
}

/**
 * The five milestones of a run, always all five (nothing appears or disappears mid-run): each says whether it is still
 * to come, working, waiting for the user, done, not needed (nothing in it ran and the run moved past it), stopped or
 * failed, with one plain line.
 */
export function milestoneViews(snap: RunSnapshot): MilestoneView[] {
  const status = snap.summary.status
  const ended = status === 'completed' || status === 'failed' || status === 'cancelled'
  const steps = (m: Milestone): StepView[] => milestoneSteps(m).map((k) => snap.steps[k])
  const begun = MILESTONES.map((m) => steps(m).some(ran))
  const frontier = begun.lastIndexOf(true)
  const current: Milestone = MILESTONES[Math.max(0, frontier)] ?? 'understand'
  const cardsOf = (m: Milestone): CardView[] => snap.cards.filter((c) => cardMilestone(c, current) === m)
  const asksOf = (m: Milestone): AskView[] => snap.asks.filter((a) => STEP_MILESTONE[a.step] === m)
  let stoppedShown = false
  return MILESTONES.map((m, i) => {
    const vs = steps(m)
    const cards = cardsOf(m)
    if (vs.some((v) => v.status === 'failed')) return { id: m, state: 'failed', line: LINE.failed }
    if (!ended && (cards.some((c) => c.blocking) || asksOf(m).length > 0 || vs.some(holding)))
      return { id: m, state: 'needsYou', line: needsYouLine(m, cards) }
    if (!ended && vs.some(working)) return { id: m, state: 'working', line: workingLine(m, snap) }
    const any = begun[i] === true
    const later = i < frontier
    if (any && vs.filter(ran).every(finished) && (later || (ended && status !== 'cancelled')))
      return { id: m, state: 'done', line: doneLine(m, snap) }
    if (!any && (later || (ended && status === 'completed')))
      return { id: m, state: 'notNeeded', line: LINE.notNeeded }
    if (status === 'cancelled' || status === 'failed') {
      if (!stoppedShown && (any || i === frontier + 1)) {
        stoppedShown = true
        return { id: m, state: 'stopped', line: LINE.stopped }
      }
      if (any) return { id: m, state: 'done', line: doneLine(m, snap) }
      return { id: m, state: 'waiting', line: LINE.notStarted }
    }
    // Begun and at the frontier, between two steps: still this milestone's work.
    if (any) return { id: m, state: 'working', line: workingLine(m, snap) }
    return { id: m, state: 'waiting', line: LINE.notStarted }
  })
}

// ---- asks -------------------------------------------------------------------------------------------------------

export interface PlainAsk {
  /** `inside`: the project folder (Allow is the safe answer); `outside`: anything else (Don't allow is). */
  tier: 'inside' | 'outside'
  text: string
  recommended: 'allow' | 'deny'
}

const INSTALL =
  /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci)\b|(?:pip3?|python3?\s+-m\s+pip|py\s+-m\s+pip|poetry|uv)\s+(?:install|add|sync)\b)/i
const RUN_PROJECT =
  /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:test|run|start|exec)\b|(?:node|npx|python3?|py|pytest|deno|vite)\b)/i
const ABS_PATH = /(?:[A-Za-z]:[\\/]|\\\\|(?<![\w.])\/(?!\/))[^\s"'`]*/g

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Whether an absolute path is inside the folder (case and slash direction ignored). */
export function insideFolder(path: string, folder: string): boolean {
  const p = norm(path)
  const f = norm(folder)
  return f !== '' && (p === f || p.startsWith(`${f}/`))
}

function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
}

/** The path relative to the folder ("index.html"), or the path as it is. */
function relative(path: string, folder: string): string {
  if (!isAbsolute(path) || !insideFolder(path, folder)) return path
  const rest = path.replace(/\\/g, '/').slice(norm(folder).length)
  return rest.replace(/^\/+/, '') || '.'
}

function hostOf(detail: string): string {
  const m = /https?:\/\/([^/\s:?#]+)/i.exec(detail)
  if (m?.[1] !== undefined) return m[1]
  const word = detail.trim().split(/\s+/)[0] ?? detail
  return word.replace(/^[a-z]+:\/\//i, '').replace(/[/:?#].*$/, '') || detail.trim()
}

/** The first line of a command, shortened for a sentence. */
function shortCommand(cmd: string): string {
  const one = cmd.trim().split(/\r?\n/)[0] ?? ''
  return one.length > 60 ? `${one.slice(0, 57)}...` : one
}

/** An ask in plain words, with which answer is the safe one. */
export function plainAsk(ask: Pick<AskView, 'kind' | 'detail' | 'defaultToNo'>, folder: string): PlainAsk {
  const detail = ask.detail
  switch (ask.kind) {
    case 'shell': {
      // The vendor names its tool first ("Bash: npm install"): the command is what follows.
      const cmd = detail.replace(/^\s*[A-Za-z]+:\s+/, '')
      const outside = [...cmd.matchAll(ABS_PATH)].map((m) => m[0]).find((p) => !insideFolder(p, folder))
      if (outside !== undefined) return { tier: 'outside', text: ASK_RUN_COMMAND, recommended: 'deny' }
      if (INSTALL.test(cmd))
        return { tier: 'inside', text: askInstallText(shortCommand(cmd)), recommended: 'allow' }
      if (RUN_PROJECT.test(cmd)) return { tier: 'inside', text: ASK_RUN_PROJECT, recommended: 'allow' }
      return { tier: 'inside', text: ASK_RUN_COMMAND, recommended: 'allow' }
    }
    case 'edit': {
      // The vendor names its tool first ("Write: C:\\p\\a.txt") and may add lines (its reason): the path is what
      // follows the tool on the first line (a drive letter's colon has no space after it).
      const path = (detail.trim().split(/\r?\n/)[0] ?? '').replace(/^\s*[A-Za-z]+:\s+/, '').trim()
      if (isAbsolute(path) && !insideFolder(path, folder))
        return { tier: 'outside', text: askOutsideText(path), recommended: 'deny' }
      if (/(^|[\\/])\.\.([\\/]|$)/.test(path))
        return { tier: 'outside', text: askOutsideText(path), recommended: 'deny' }
      return { tier: 'inside', text: askEditInsideText(relative(path, folder)), recommended: 'allow' }
    }
    case 'network':
      return { tier: 'outside', text: askNetworkText(hostOf(detail)), recommended: 'deny' }
    case 'other':
      return ask.defaultToNo === true
        ? { tier: 'outside', text: ASK_OTHER, recommended: 'deny' }
        : { tier: 'inside', text: ASK_OTHER, recommended: 'allow' }
  }
}

// ---- cards ------------------------------------------------------------------------------------------------------

/** A card's plain title (the questions, plan and research cards have their own Easy bodies). */
export function plainCardTitle(card: CardView): string {
  return CARD_TITLE[card.kind] ?? ANSWER_NEEDED_TITLE
}

/**
 * A card's body in Easy's words, for the cards whose core text is about scripts, logs or steps (core's own text stays
 * one click away, behind "Show what will run"); null: core's body is shown as it is.
 */
export function plainCardBody(card: CardView): string | null {
  if (card.kind === 'trust') {
    const t = trustOf(card)
    return trustBodyText(t.command !== '' ? [t.command] : [])
  }
  if (card.kind === 'depsConsent') {
    const d = depsOf(card)
    return depsBodyText(d.command !== '' ? d.command : null)
  }
  if (card.kind === 'preflight') return preflightBody(card)
  if (card.kind === 'planMutated') return planMutatedBodyText(planChangedPaths(card).length)
  return FIXED_BODY[card.kind] ?? null
}

/** The preflight card's blocking checks in plain words: one line per kind of problem (core's failure category). */
function preflightBody(card: CardView): string {
  const p = card.payload as { blocking?: { id?: unknown; category?: unknown }[] } | undefined
  const lines = (p?.blocking ?? []).map((c) => {
    const id = typeof c.id === 'string' ? c.id : ''
    const vendor = /^vendor\.([a-z0-9-]+)\./.exec(id)?.[1]
    return preflightText(typeof c.category === 'string' ? c.category : undefined, vendor)
  })
  const unique = [...new Set(lines)]
  return unique.length > 0 ? unique.join(' ') : preflightText(undefined)
}

/** The cards whose Easy body says the same whatever core sent. */
const FIXED_BODY: Readonly<Partial<Record<CardView['kind'], string>>> = {
  depsFailed: DEPS_FAILED_BODY,
  verifyEnv: VERIFY_ENV_BODY,
  stall: STALL_BODY,
  reconcile: RECONCILE_BODY,
  emptyFindings: EMPTY_FINDINGS_BODY,
}

/** What the plan says the user will be able to do (its acceptance criteria), as plain lines. */
export function planCriteria(plan: string): string[] {
  return parseCriteria(plan).criteria.map((c) => c.text)
}

/** The plan with the user's change written in, as Plan's edited version (Implement reads it; the user's words win). */
export function planWithChange(plan: string, change: string, heading: string): string {
  return `${plan.replace(/\s+$/, '')}\n\n## ${heading}\n\n${change.trim()}\n`
}

// ---- figures ----------------------------------------------------------------------------------------------------

/** The amount the confirm screen suggests raising a limit to: the estimate's high end, in whole dollars. */
export function raiseTo(p80Usd: number): number {
  return Math.max(1, Math.ceil(p80Usd))
}

/** "Continue with $Y more": about three fifths of the limit that stopped it, in whole dollars. */
export function continueAmount(limitUsd: number): number {
  return Math.max(1, Math.ceil(limitUsd * 0.6))
}

/** How full the cost bar is (0 to 1); 0 without a limit or a price. */
export function costFraction(costUsd: number | null, limit: number | null): number {
  if (costUsd === null || limit === null || limit <= 0) return 0
  return Math.min(1, Math.max(0, costUsd / limit))
}

/** A folder's own name: the last part of its path. */
export function baseName(folder: string): string {
  return (
    folder
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? folder
  )
}

/** "bakery-landing-page" reads "bakery landing page". */
export function projectName(folder: string): string {
  const base = baseName(folder)
  return base.replace(/[-_]+/g, ' ').trim() || base
}

/** The line under the run and Done headings: the project's short title from its idea, else its folder's name. */
export function projectTitle(folder: string, title: string | undefined): string {
  return title !== undefined && title.trim() !== '' ? title : projectName(folder)
}

/** A typed limit: a positive amount, or null for an empty box. Undefined: not a usable number. */
export function parseLimit(text: string): number | null | undefined {
  const t = text.trim().replace(/^\$/, '')
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n) || n > 10_000) return undefined
  const cents = Math.round(n * 100) / 100
  return cents > 0 ? cents : undefined
}

/** A typed number of minutes: a whole number from 1 to 1440, or null for an empty box. Undefined: not usable. */
export function parseMinutes(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isInteger(n) || n < 1 || n > 1440) return undefined
  return n
}

// ---- looking at the page ----------------------------------------------------------------------------------------

/** "Fix these": the change a look's findings ask for, as a change run's request (within the change's length). */
export function fixLooksChange(findings: readonly { title: string; detail: string }[]): string {
  const lines = ['Fix these things about how the page looks, and keep everything else as it is:']
  for (const f of findings) {
    const line = `- ${f.title}${f.detail !== '' ? ` ${f.detail}` : ''}`
    if ([...lines, line].join('\n').length > EASY_CHANGE_MAX) break
    lines.push(line)
  }
  return lines.join('\n')
}

// ---- open it ----------------------------------------------------------------------------------------------------

/**
 * What Open it opens: the rendered document (a document, memo or checklist, with Save as PDF), a page served by Dim
 * Factory's own static server (no command runs, so no trust is needed), the project's own preview server when it is
 * trusted (by the project permission or a grant), a command the user must check first (Show details), or nothing.
 */
export type OpenTarget =
  | { kind: 'document'; commandId: string }
  | { kind: 'static'; commandId: string }
  | { kind: 'server'; commandId: string }
  | { kind: 'command' }
  | { kind: 'none' }

export function openTargetOf(info: PreviewInfo, preferDocument = false): OpenTarget {
  const doc = info.commands.find((c) => c.kind === 'document' && c.error === undefined)
  if (preferDocument && doc !== undefined) return { kind: 'document', commandId: doc.id }
  const stat = info.commands.find((c) => c.kind === 'static' && c.error === undefined)
  if (stat !== undefined) return { kind: 'static', commandId: stat.id }
  const server = info.commands.find(
    (c) => c.kind === 'server' && c.trust === 'trusted' && c.error === undefined,
  )
  if (server !== undefined) return { kind: 'server', commandId: server.id }
  if (info.commands.some((c) => c.kind === 'server' || c.kind === 'app')) return { kind: 'command' }
  if (doc !== undefined) return { kind: 'document', commandId: doc.id }
  return { kind: 'none' }
}

// ---- a game's controls ------------------------------------------------------------------------------------------

/**
 * The controls a game's How to play names: the summary's first "Controls:" line (Markdown emphasis and a list marker
 * around it allowed), as plain text; null when it has none.
 */
export function controlsLine(summary: string): string | null {
  for (const raw of summary.split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/^[*_]{1,2}(controls)\s*:?\s*[*_]{1,2}\s*:?/i, '$1:')
    const m = /^controls\s*:\s*(.+)$/i.exec(line)
    if (m?.[1] !== undefined) {
      const text = m[1].replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
      if (text !== '') return text
    }
  }
  return null
}

// ---- the summary's Things to fill in ------------------------------------------------------------------------------

/** The summary's heading for the facts left as marked spaces (explain.md and explain-easy.md). */
export const FILL_IN_HEADING = 'Things to fill in'

/**
 * The summary split for the Done screen: its Things to fill in section as plain lines (each list item; "Nothing to
 * fill in." and an empty section give none), and the rest of the summary without that section. `fillIns` is null
 * when the summary has no such section.
 */
export function splitFillIns(summary: string): { rest: string; fillIns: string[] | null } {
  const lines = summary.split(/\r?\n/)
  const start = lines.findIndex((l) => /^#{1,3}\s+things to fill in\s*:?\s*$/i.test(l.trim()))
  if (start < 0) return { rest: summary, fillIns: null }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  const fillIns = lines
    .slice(start + 1, end)
    .map((l) => l.trim())
    .filter((l) => /^(?:[-*+]|\d+[.)])\s+/.test(l))
    .map((l) =>
      l
        .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/\*\*|__/g, '')
        .trim(),
    )
    .filter((l) => l !== '' && !/^nothing to fill in\.?$/i.test(l))
  const rest = [...lines.slice(0, start), ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { rest, fillIns }
}
