// The composer's Brief, as pure logic: what the panel shows and what the composer sends, from core's brief.detect
// answer (packs, the detected category, the folder's facts, the task text's keyword choices, the saved brief) and the
// user's own edits (the draft). Core validates and renders the brief; this only keeps the user's choices apart from
// what Dim Factory filled in, so that:
// - a value the user set (or an accepted "Suggest choices" answer) always wins over the task text's keywords, and a
//   keyword value the user unticked stays unticked (the user's "Let Dim Factory decide" is remembered as a choice);
// - facts from the folder lock their group: a single-choice group to the fact's option, a multi-choice group's fact
//   options on (others may be added); locked values are never sent (core adds the facts itself);
// - every category keeps its own fields, so switching back restores them;
// - nothing is sent unless the brief says something (a set field, or a category the user chose).
import type {
  BriefContext,
  BriefFact,
  BriefField,
  BriefInput,
  BriefSuggestResult,
  Pack,
  PackGroup,
  PackView,
} from '@shared/brief.ts'
import { APPROACH_GROUP, BRIEF_OTHER_MAX, briefTestFirst, fieldIsSet } from '@shared/brief.ts'

/** The user's side of the brief: what they chose (and accepted from Suggest), per category. */
export interface BriefDraft {
  /** The category the user chose; null follows detection. */
  category: string | null
  /**
   * Per pack id, per group id: the user's field (source `user`, possibly empty: an explicit "Let Dim Factory decide")
   * or an accepted suggestion (source `suggested`). A group with an entry here is touched: keywords leave it alone.
   */
  own: Readonly<Record<string, Readonly<Record<string, BriefField>>>>
  /** Per pack id, per group id: why "Suggest choices" chose it (the chip's tooltip). */
  reasons: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export const EMPTY_DRAFT: BriefDraft = { category: null, own: {}, reasons: {} }

/** The group's lock from the folder's facts. */
export interface GroupLock {
  /** Option ids the facts fix on. */
  options: ReadonlySet<string>
  facts: readonly BriefFact[]
  /** A single-choice group: the whole group is fixed. */
  whole: boolean
}

export interface PackLocks {
  byGroup: ReadonlyMap<string, GroupLock>
  /** Facts that lock a group of this pack. */
  locked: readonly BriefFact[]
  /** Facts about groups this pack does not have (package manager, test runner): shown for information. */
  info: readonly BriefFact[]
}

/** How a chip in a group reads. */
export interface OptionState {
  on: boolean
  locked: boolean
  /** The option is off because a fact fixed the single-choice group to another option. */
  blocked: boolean
  source: BriefField['source'] | 'locked' | null
}

export function packOf(ctx: BriefContext | null, id: string | null | undefined): PackView | undefined {
  if (ctx === null || id === null || id === undefined) return undefined
  return ctx.packs.find((p) => p.pack.id === id)
}

/** The category shown: the user's, else the detected one (when there is such a pack), else the first pack. */
export function categoryOf(
  ctx: BriefContext | null,
  draft: BriefDraft,
  detected?: string | null,
): string | null {
  if (ctx === null || ctx.packs.length === 0) return null
  if (draft.category !== null && packOf(ctx, draft.category) !== undefined) return draft.category
  const d = detected ?? ctx.category.id
  if (packOf(ctx, d) !== undefined) return d
  return ctx.packs[0]?.pack.id ?? null
}

export function locksOf(ctx: BriefContext | null, pack: Pack | undefined): PackLocks {
  const byGroup = new Map<string, GroupLock>()
  const locked: BriefFact[] = []
  const info: BriefFact[] = []
  if (ctx === null || pack === undefined) return { byGroup, locked, info }
  for (const f of ctx.facts[pack.id] ?? []) {
    const group = pack.groups.find((g) => g.id === f.group)
    if (group === undefined) {
      info.push(f)
      continue
    }
    locked.push(f)
    const cur = byGroup.get(group.id)
    const options = new Set(cur?.options ?? [])
    if (f.option !== undefined && group.options.some((o) => o.id === f.option)) options.add(f.option)
    byGroup.set(group.id, {
      options,
      facts: [...(cur?.facts ?? []), f],
      whole: !group.multi,
    })
  }
  return { byGroup, locked, info }
}

function ownOf(draft: BriefDraft, packId: string): Readonly<Record<string, BriefField>> {
  return draft.own[packId] ?? {}
}

/** The group's field as the panel shows it and the composer sends it (locked options left out), or undefined. */
export function fieldOf(
  ctx: BriefContext | null,
  draft: BriefDraft,
  pack: Pack,
  group: PackGroup,
  locks: PackLocks = locksOf(ctx, pack),
): BriefField | undefined {
  const lock = locks.byGroup.get(group.id)
  if (lock?.whole === true) return undefined
  const own = ownOf(draft, pack.id)[group.id]
  const raw =
    own !== undefined
      ? own
      : group.id === APPROACH_GROUP
        ? undefined
        : ctx?.keywordFields[pack.id]?.[group.id]
  if (raw === undefined) return undefined
  const known = new Set(group.options.map((o) => o.id))
  const choices = raw.choices.filter((c) => known.has(c) && lock?.options.has(c) !== true)
  const one = group.multi ? choices : choices.slice(0, 1)
  const other = group.other && raw.other !== undefined && raw.other.trim() !== '' ? raw.other : undefined
  const field: BriefField = {
    choices: one,
    ...(other !== undefined && (group.multi || one.length === 0) ? { other } : {}),
    source: raw.source ?? (own !== undefined ? 'user' : 'keyword'),
  }
  return fieldIsSet(field) ? field : undefined
}

/** Every set field of the pack (the brief's fields). */
export function fieldsOf(
  ctx: BriefContext | null,
  draft: BriefDraft,
  pack: Pack,
): Record<string, BriefField> {
  const locks = locksOf(ctx, pack)
  const out: Record<string, BriefField> = {}
  for (const g of pack.groups) {
    const f = fieldOf(ctx, draft, pack, g, locks)
    if (f !== undefined) out[g.id] = f
  }
  return out
}

/**
 * What the composer sends (runs.start, preflight.run, estimates.get): the category and the set fields; undefined when
 * the brief says nothing (no set field and no category the user chose), so a run without a brief is unaffected.
 */
export function briefInputOf(
  ctx: BriefContext | null,
  draft: BriefDraft,
  detected?: string | null,
): BriefInput | undefined {
  const category = categoryOf(ctx, draft, detected)
  const pack = packOf(ctx, category)?.pack
  if (category === null || pack === undefined) return undefined
  const fields = fieldsOf(ctx, draft, pack)
  if (Object.keys(fields).length === 0 && draft.category === null) return undefined
  return { category, fields }
}

export interface BriefSummary {
  /** Set fields (user, suggested, keyword). */
  choices: number
  /** Facts that lock a group. */
  fromRepo: number
  testFirst: boolean
}

export function summaryOf(
  ctx: BriefContext | null,
  draft: BriefDraft,
  detected?: string | null,
): BriefSummary {
  const category = categoryOf(ctx, draft, detected)
  const pack = packOf(ctx, category)?.pack
  if (pack === undefined) return { choices: 0, fromRepo: 0, testFirst: false }
  const fields = fieldsOf(ctx, draft, pack)
  return {
    choices: Object.keys(fields).length,
    fromRepo: locksOf(ctx, pack).locked.length,
    testFirst: briefTestFirst({ category: pack.id, fields }, pack),
  }
}

/** One option chip's state. */
export function optionState(
  field: BriefField | undefined,
  lock: GroupLock | undefined,
  optionId: string,
): OptionState {
  if (lock?.options.has(optionId) === true)
    return { on: true, locked: true, blocked: false, source: 'locked' }
  if (lock?.whole === true) return { on: false, locked: false, blocked: true, source: null }
  const on = field?.choices.includes(optionId) === true
  return { on, locked: false, blocked: false, source: on ? (field?.source ?? 'user') : null }
}

function withOwn(draft: BriefDraft, packId: string, groupId: string, field: BriefField): BriefDraft {
  const reasons = { ...(draft.reasons[packId] ?? {}) }
  delete reasons[groupId]
  return {
    ...draft,
    own: { ...draft.own, [packId]: { ...ownOf(draft, packId), [groupId]: field } },
    reasons: { ...draft.reasons, [packId]: reasons },
  }
}

/** A click on an option chip: radio for a single-choice group, checkbox for a multi-choice one. */
export function toggleOption(
  ctx: BriefContext | null,
  draft: BriefDraft,
  pack: Pack,
  group: PackGroup,
  optionId: string,
): BriefDraft {
  const locks = locksOf(ctx, pack)
  const lock = locks.byGroup.get(group.id)
  if (lock?.whole === true || lock?.options.has(optionId) === true) return draft
  const cur = fieldOf(ctx, draft, pack, group, locks)
  const choices = cur?.choices ?? []
  if (!group.multi) {
    const next = choices.includes(optionId) ? [] : [optionId]
    return withOwn(draft, pack.id, group.id, { choices: next, source: 'user' })
  }
  const next = choices.includes(optionId) ? choices.filter((c) => c !== optionId) : [...choices, optionId]
  const other = cur?.other
  return withOwn(draft, pack.id, group.id, {
    choices: next,
    ...(other !== undefined ? { other } : {}),
    source: 'user',
  })
}

/** "Let Dim Factory decide": the group says nothing, and the task text's keywords leave it so. */
export function decide(draft: BriefDraft, pack: Pack, group: PackGroup): BriefDraft {
  return withOwn(draft, pack.id, group.id, { choices: [], source: 'user' })
}

/** The group's "Other" text (empty: none). A single-choice group's Other replaces its option. */
export function setOther(
  ctx: BriefContext | null,
  draft: BriefDraft,
  pack: Pack,
  group: PackGroup,
  text: string,
): BriefDraft {
  if (!group.other) return draft
  const lock = locksOf(ctx, pack).byGroup.get(group.id)
  if (lock?.whole === true) return draft
  const t = text.trim().slice(0, BRIEF_OTHER_MAX)
  const cur = fieldOf(ctx, draft, pack, group)
  const choices = group.multi ? (cur?.choices ?? []) : t !== '' ? [] : (cur?.choices ?? [])
  return withOwn(draft, pack.id, group.id, { choices, ...(t !== '' ? { other: t } : {}), source: 'user' })
}

export function chooseCategory(draft: BriefDraft, id: string): BriefDraft {
  return { ...draft, category: id }
}

/**
 * "Suggest choices": core's answers become fields with source `suggested`, for groups the user has not set (and
 * that no fact fixes); unknown options are dropped. Returns the new draft, how many groups it filled and the
 * category it filled them in (core's answer's, when the user has not chosen another).
 */
export function applySuggestions(
  ctx: BriefContext | null,
  draft: BriefDraft,
  result: BriefSuggestResult,
  current: string | null,
): { draft: BriefDraft; applied: number; category: string | null } {
  const target =
    packOf(ctx, result.category) !== undefined &&
    (draft.category === null || draft.category === result.category)
      ? result.category
      : current
  const pack = packOf(ctx, target)?.pack
  if (pack === undefined) return { draft, applied: 0, category: current }
  const locks = locksOf(ctx, pack)
  // Core answered for another category than the one shown: the answer's category is taken with its choices.
  let next = target !== current && target !== null ? chooseCategory(draft, target) : draft
  let applied = 0
  for (const s of result.suggestions) {
    const group = pack.groups.find((g) => g.id === s.group)
    if (group === undefined) continue
    const lock = locks.byGroup.get(group.id)
    if (lock?.whole === true) continue
    if (ownOf(next, pack.id)[group.id]?.source === 'user') continue
    const known = new Set(group.options.map((o) => o.id))
    const choices = s.choices.filter((c) => known.has(c) && lock?.options.has(c) !== true)
    const one = group.multi ? choices : choices.slice(0, 1)
    const other =
      group.other && s.other !== undefined && s.other.trim() !== '' && (group.multi || one.length === 0)
        ? s.other.trim().slice(0, BRIEF_OTHER_MAX)
        : undefined
    const field: BriefField = { choices: one, ...(other !== undefined ? { other } : {}), source: 'suggested' }
    if (!fieldIsSet(field)) continue
    const own = { ...ownOf(next, pack.id), [group.id]: field }
    const reasons = { ...(next.reasons[pack.id] ?? {}), [group.id]: s.reason }
    next = { ...next, own: { ...next.own, [pack.id]: own }, reasons: { ...next.reasons, [pack.id]: reasons } }
    applied++
  }
  if (applied === 0) return { draft, applied, category: current }
  return { draft: next, applied, category: target }
}

/** The folder's saved brief as the draft it was made from. */
export function draftFromSaved(ctx: BriefContext, saved: BriefInput | null): BriefDraft {
  if (saved === null || packOf(ctx, saved.category) === undefined) return EMPTY_DRAFT
  const own: Record<string, BriefField> = {}
  for (const [g, f] of Object.entries(saved.fields)) {
    // Keyword values are the task text's, not the user's: they come again from detection.
    if (f.source === 'keyword') continue
    own[g] = { ...f, source: f.source ?? 'user' }
  }
  return { category: saved.category, own: { [saved.category]: own }, reasons: {} }
}

/** What brief.save keeps for the folder: the shown category and the user's own fields there (touched groups too). */
export function savedBriefOf(draft: BriefDraft, category: string | null): BriefInput | null {
  if (category === null) return null
  const own = ownOf(draft, category)
  const fields: Record<string, BriefField> = {}
  for (const [g, f] of Object.entries(own)) fields[g] = f
  return { category, fields }
}

/** The suggestion's reason for a group, when the field came from "Suggest choices". */
export function reasonOf(draft: BriefDraft, packId: string, groupId: string): string | undefined {
  return draft.reasons[packId]?.[groupId]
}

// ---- words ----------------------------------------------------------------------------------------------------------

export const DECIDE_LABEL = 'Let Dim Factory decide'
export const OTHER_LABEL = 'Other…'
export const KEYWORD_TIP = 'From your task text'
export const SUGGESTED_TIP = 'Suggested by Dim Factory'
export const PIPELINE_TAG = 'Adds a Tests step'
export const PLAN_TAG = 'Guides the plan'
export const NO_FACTS = 'Nothing detected in this folder'
export const NO_FOLDER_FACTS = 'Choose a folder to see what it already uses'

export function factTip(f: BriefFact): string {
  return `${f.label} (from ${f.evidence})`
}

/** "3 choices", "1 choice". */
export function choicesText(n: number): string {
  return `${n} ${n === 1 ? 'choice' : 'choices'}`
}

export function fromRepoText(n: number): string {
  return `${n} from this repo`
}

/** About how many tokens, in a word: `about 900 tokens`, `about 4k tokens`. */
function aboutTokens(n: number): string {
  if (n < 1000) return `about ${Math.max(0, Math.round(n))} tokens`
  return `about ${Math.round(n / 1000)}k tokens`
}

function aboutUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return 'under $0.01'
  return `about $${usd.toFixed(2)}`
}

/**
 * The Suggest button's cost hint: "One read-only call to Claude (sonnet), about 4k tokens (about $0.01)", or core's
 * reason when no vendor can answer.
 */
export function suggestHint(ctx: BriefContext | null, vendorLabel: (v: string) => string): string {
  if (ctx === null) return ''
  const s = ctx.suggest
  if (s.vendor === null) return s.reason ?? 'No vendor can answer this.'
  const who = s.model !== null ? `${vendorLabel(s.vendor)} (${s.model})` : vendorLabel(s.vendor)
  const cost = s.usd !== null ? ` (${aboutUsd(s.usd)})` : ''
  return `One read-only call to ${who}, ${aboutTokens(s.tokens)}${cost}`
}

export function suggestedText(n: number): string {
  if (n === 0) return 'No new choices to suggest. Your own choices stay as they are.'
  return `Suggested ${n} ${n === 1 ? 'choice' : 'choices'}. Hover a chip to see why.`
}

/** A stable key for a brief (the live checks ask again only when it changes). */
export function briefKey(b: BriefInput | undefined): string {
  return b === undefined ? '' : JSON.stringify(b)
}
