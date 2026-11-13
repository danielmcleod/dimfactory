// The Research phase: an optional read-only pass before Plan that studies the problem space through "lenses" (short
// questions, generic or from the run's pack) and hands Plan a cited brief. Lenses are data (src/core/packs/); core
// resolves them, parses the answer (dropping every claim without a source), keeps what the user chose at the research
// review card and renders it as `{{research}}` in the Plan prompt. The renderer only shows these.
import { z } from 'zod'
import type { Pack } from './brief.ts'

// ---- lenses ------------------------------------------------------------------------------------------------------

/** A lens id: lower camel or kebab case, like the Brief's ids. */
export const RESEARCH_LENS_ID = /^[a-z][a-zA-Z0-9-]{0,39}$/
/** The "This repository" lens: read-only code reading, never the web. Every vendor can run it. */
export const REPOSITORY_LENS = 'repository'
/** The most lenses one run may tick. */
export const RESEARCH_LENSES_MAX = 16
export const RESEARCH_LENS_ASK_MAX = 600

export const ResearchLensZ = z.strictObject({
  id: z.string().regex(RESEARCH_LENS_ID, 'Not a lens id (letters, digits and dashes, up to 40)'),
  label: z.string().trim().min(1).max(60),
  /** The question the lens asks, as a prompt fragment. */
  ask: z.string().trim().min(1).max(RESEARCH_LENS_ASK_MAX),
  /** The lens searches the web (false: it reads the repository only). */
  web: z.boolean(),
})
export type ResearchLens = z.infer<typeof ResearchLensZ>

/**
 * A pack's research part: its own lenses, the lenses ticked when the user ticks none (`defaults`), and `on` (a run whose
 * brief picks this pack runs Research unless the run turns it off).
 */
export const PackResearchZ = z.strictObject({
  lenses: z.array(ResearchLensZ).max(12).optional(),
  defaults: z.array(z.string().regex(RESEARCH_LENS_ID)).max(RESEARCH_LENSES_MAX).optional(),
  on: z.boolean().optional(),
})
export type PackResearch = z.infer<typeof PackResearchZ>

/** The generic lenses file (src/core/packs/research-lenses.json). */
export const GenericLensesZ = z.strictObject({
  $schema: z.string().max(2048).optional(),
  version: z.literal(1),
  lenses: z.array(ResearchLensZ).min(1).max(20),
  /** Ticked when neither the run nor the pack names any. */
  defaults: z.array(z.string().regex(RESEARCH_LENS_ID)).min(1).max(RESEARCH_LENSES_MAX),
})
export type GenericLenses = z.infer<typeof GenericLensesZ>

/**
 * A run's Research (RunConfig.research): the lenses it researches (resolved to their questions when the run starts)
 * and whether it may search the web. `offWeb`: the labels of lenses it was asked for that need the web its vendor
 * cannot reach (left out; the repository lens runs instead).
 */
export interface ResearchRunConfig {
  lenses: ResearchLens[]
  web: boolean
  offWeb?: string[]
}

/** A lens as the composer lists it: where it comes from (`generic`, or the pack id). */
export interface ResearchLensOption extends ResearchLens {
  source: string
}

/** ResearchLensOption.source for a generic lens. */
export const GENERIC_SOURCE = 'generic'

/** Every lens a run of `pack` may tick: the generic ones, then the pack's (a pack lens with a generic id replaces it). */
export function lensOptions(generic: GenericLenses, pack?: Pack): ResearchLensOption[] {
  const own = pack?.research?.lenses ?? []
  const ownIds = new Set(own.map((l) => l.id))
  return [
    ...generic.lenses.filter((l) => !ownIds.has(l.id)).map((l) => ({ ...l, source: GENERIC_SOURCE })),
    ...own.map((l) => ({ ...l, source: pack?.id ?? GENERIC_SOURCE })),
  ]
}

/** The lenses ticked when the run names none: the pack's defaults, else the generic ones (unknown ids left out). */
export function defaultLensIds(generic: GenericLenses, pack?: Pack): string[] {
  const known = new Set(lensOptions(generic, pack).map((l) => l.id))
  const ids = pack?.research?.defaults ?? generic.defaults
  return ids.filter((id) => known.has(id))
}

// ---- the answer --------------------------------------------------------------------------------------------------

export const RESEARCH_PRIORITIES = ['must', 'should', 'could'] as const
export type ResearchPriority = (typeof RESEARCH_PRIORITIES)[number]

/** Kept per section (more are dropped, with a note). */
export const RESEARCH_SECTION_MAX = 20
export const RESEARCH_SUMMARY_LINES = 5
export const RESEARCH_TEXT_MAX = 300
export const RESEARCH_SOURCES_MAX = 60
/** The longest answer the research card takes for one open question. */
export const RESEARCH_ANSWER_MAX = 500

/**
 * A citation: an http(s) URL, or `repo:<path>` for a file of the repository (the "This repository" lens). Every
 * feature, standard, option and risk cites at least one; the parser drops one that cites none.
 */
export type ResearchCitation = string

export interface ResearchFeature {
  /** `f1`, `f2`… (the card's tick ids). */
  id: string
  feature: string
  priority: ResearchPriority
  sources: ResearchCitation[]
}

export interface ResearchStandard {
  id: string
  standard: string
  why?: string
  sources: ResearchCitation[]
}

/** One decision with the options weighed and the one recommended. */
export interface ResearchOption {
  id: string
  topic: string
  options: string[]
  recommendation: string
  rationale: string
  sources: ResearchCitation[]
}

export interface ResearchRisk {
  id: string
  risk: string
  sources: ResearchCitation[]
}

export interface ResearchQuestion {
  id: string
  question: string
}

export interface ResearchSource {
  url: ResearchCitation
  title?: string
}

/** The parsed answer (research.json). `dropped`: the claims left out because they cited no source. */
export interface ResearchResult {
  summary: string[]
  features: ResearchFeature[]
  standards: ResearchStandard[]
  options: ResearchOption[]
  risks: ResearchRisk[]
  questions: ResearchQuestion[]
  sources: ResearchSource[]
  dropped: number
}

/**
 * StepView.research. `status`: `pending` (it has not answered yet) · `reviewing` (the research card is open) · `chosen` (the user, or Auto, kept some items
 * for Plan) · `skipped` (the user went on without it) · `none` (nothing usable: no cited claim, or an unreadable
 * answer; `note` says which). `web`: the run searched the web (false: the repository lens only).
 */
export interface ResearchView {
  status: 'pending' | 'reviewing' | 'chosen' | 'skipped' | 'none'
  lenses: { id: string; label: string; web: boolean }[]
  web: boolean
  result?: ResearchResult
  /** The item ids kept for Plan (features, standards, options), once chosen. */
  chosen?: string[]
  /** Answers to the open questions by question id (only the answered ones). */
  answers?: Record<string, string>
  /** Auto chose (must-haves and recommendations, no answers). */
  auto?: boolean
  note?: string
}

/** The research card's payload. */
export interface ResearchPayload {
  step: 'research'
  result: ResearchResult
  /** The ids Auto would keep (must-have features and every recommendation): the card's initial ticks. */
  suggested: string[]
  web: boolean
}

/**
 * The research card's `cards.resolve` input for [Use selected]: the kept item ids, and `q<n>=<answer>` for each
 * answered open question.
 */
export const RESEARCH_INPUT_MAX = 4 * RESEARCH_SECTION_MAX + 20

export function researchAnswerEntry(questionId: string, answer: string): string {
  return `${questionId}=${answer}`
}

/** Splits a research card input entry: an item id, or `{question, answer}`. */
export function parseResearchEntry(e: string): { id: string } | { question: string; answer: string } {
  const at = e.indexOf('=')
  if (at < 0) return { id: e }
  return { question: e.slice(0, at), answer: e.slice(at + 1) }
}

/** The ids Auto keeps: must-have features and every option's recommendation (never the open questions). */
export function autoResearchChoice(r: Pick<ResearchResult, 'features' | 'options'>): string[] {
  return [...r.features.filter((f) => f.priority === 'must').map((f) => f.id), ...r.options.map((o) => o.id)]
}

/** A citation the parser keeps: http(s) or `repo:<relative path>`. */
export function isCitation(v: string): boolean {
  if (/^repo:\S+$/.test(v)) return !/(^repo:[/\\]|^repo:[a-zA-Z]:|\.\.)/.test(v)
  return /^https?:\/\/[^\s/?#]+\.[^\s/?#]+([/?#]\S*)?$/i.test(v)
}
