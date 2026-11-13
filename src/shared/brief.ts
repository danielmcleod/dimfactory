// The Brief: use-case categories ("packs"), the choices a user makes for a run, what Dim Factory detects in the folder,
// and the "Suggest choices" answer. Packs are data (src/core/packs/*.json, overridable per user and per project);
// core validates them with PackZ, detects, renders and records the brief, and the renderer only shows it.
import { z } from 'zod'
import { PackDeployZ } from './deploy.ts'
import { PackResearchZ } from './research.ts'
import type { GenericLenses } from './research.ts'

// ---- ids and limits --------------------------------------------------------------------------------------------

/** A pack, group or option id: lower camel or kebab case. */
export const BRIEF_ID_PATTERN = /^[a-z][a-zA-Z0-9-]{0,39}$/
export const BRIEF_LABEL_MAX = 60
export const BRIEF_HINT_MAX = 200
/** The "Other" free text of one group. */
export const BRIEF_OTHER_MAX = 200
/** A method option's plan guidance. */
export const BRIEF_GUIDANCE_MAX = 600
export const BRIEF_GROUPS_MAX = 20
export const BRIEF_OPTIONS_MAX = 30
export const BRIEF_KEYWORDS_MAX = 40

/** The approach group of a pack: methodology patterns (Test-first, Walking skeleton, …). */
export const APPROACH_GROUP = 'approach'
/** The Test-first pattern's option id: it adds the `tests` step and its red check to the pipeline. */
export const TEST_FIRST = 'test-first'
/** The category a brief falls back to when nothing points elsewhere. */
export const DEFAULT_CATEGORY = 'software'
/** The Games category (light web games): its runs' summary says how to play, and Easy makes "A game" in it. */
export const GAMES_CATEGORY = 'games'

const IdZ = z.string().regex(BRIEF_ID_PATTERN, 'Not a brief id (letters, digits and dashes, up to 40)')
const LabelZ = z.string().trim().min(1).max(BRIEF_LABEL_MAX)
const HintZ = z.string().trim().min(1).max(BRIEF_HINT_MAX)
/** A keyword or phrase matched in the task text (whole words, any case). */
const KeywordZ = z.string().trim().min(2).max(60)

// ---- packs ------------------------------------------------------------------------------------------------------

/**
 * What choosing a method option does: `pipeline` changes the run's steps (Test-first adds the `tests` step); `plan`
 * only guides the plan (its guidance goes into the brief).
 */
export const METHOD_EFFECTS = ['pipeline', 'plan'] as const
export type MethodEffect = (typeof METHOD_EFFECTS)[number]

export const PackOptionZ = z.strictObject({
  id: IdZ,
  label: LabelZ,
  hint: HintZ.optional(),
  /** Task-text phrases that point at this option (the local keyword rules). */
  keywords: z.array(KeywordZ).max(BRIEF_KEYWORDS_MAX).optional(),
  /** Method options (the approach group) only. */
  effect: z.enum(METHOD_EFFECTS).optional(),
  /** What the brief tells the planner when this option is chosen (method options). */
  guidance: z.string().trim().min(1).max(BRIEF_GUIDANCE_MAX).optional(),
})
export type PackOption = z.infer<typeof PackOptionZ>

export const PackGroupZ = z
  .strictObject({
    id: IdZ,
    label: LabelZ,
    hint: HintZ.optional(),
    /** Several options at once (checkboxes) or one (chips). Every group defaults to "Let Dim Factory decide". */
    multi: z.boolean(),
    /** An "Other" free-text choice. */
    other: z.boolean(),
    options: z.array(PackOptionZ).min(1).max(BRIEF_OPTIONS_MAX),
  })
  .superRefine((g, ctx) => {
    const seen = new Set<string>()
    g.options.forEach((o, i) => {
      if (seen.has(o.id))
        ctx.addIssue({ code: 'custom', path: ['options', i, 'id'], message: `Duplicate option "${o.id}"` })
      seen.add(o.id)
      const method = g.id === APPROACH_GROUP
      if (!method && (o.effect !== undefined || o.guidance !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', i],
          message: `Only options of the "${APPROACH_GROUP}" group may set effect or guidance`,
        })
      }
      if (method && o.effect === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', i, 'effect'],
          message: 'A method option says whether it changes the pipeline or guides the plan',
        })
      }
      if (o.effect === 'pipeline' && o.id !== TEST_FIRST) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', i, 'effect'],
          message: `Only "${TEST_FIRST}" changes the pipeline in this version; use "plan"`,
        })
      }
    })
  })
export type PackGroup = z.infer<typeof PackGroupZ>

/** The kinds a pack's run strategy may have (the static server is Dim Factory's own, never a pack's). */
export const PACK_PREVIEW_KINDS = ['server', 'command', 'app'] as const

/**
 * A pack's way to run a folder (Run & Preview): when every `when.files` entry is at the folder's root (a file name, or
 * `*.ext`), `run` is offered as a command. `run` is argv: no shell ever reads it, and it runs only once the user
 * trusts it. `url`: where the page is when the output does not say (a loopback http URL).
 */
export const PackPreviewZ = z.strictObject({
  id: IdZ,
  when: z.strictObject({ files: z.array(z.string().trim().min(1).max(80)).min(1).max(10) }),
  run: z
    .array(
      z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\0\r\n]*$/, 'An argument may not hold a line break'),
    )
    .min(1)
    .max(32),
  kind: z.enum(PACK_PREVIEW_KINDS),
  note: HintZ.optional(),
  url: z
    .string()
    .max(200)
    .regex(/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\/[^\s]*$/, 'A loopback http URL')
    .optional(),
})
export type PackPreview = z.infer<typeof PackPreviewZ>

/** The most security focus lines a pack may have, and the longest line. */
export const PACK_FOCUS_MAX = 12
export const PACK_FOCUS_LINE_MAX = 240

/** The most extra focus sets a pack may have for Brief choices. */
export const PACK_FOCUS_WHEN_MAX = 8

const FocusLinesZ = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(PACK_FOCUS_LINE_MAX)
      .regex(/^[^\r\n]*$/, 'One line each'),
  )
  .min(1)
  .max(PACK_FOCUS_MAX)

/**
 * A pack's security focus: what the security reviewer and the critic look at first for this category (one line each,
 * rendered as `{{focus}}` in their prompts), on top of their general checklist. `when` adds lines for one Brief choice
 * (a game server's rules when the deliverable is a game server you host).
 */
export const PackSecurityZ = z.strictObject({
  focus: FocusLinesZ,
  when: z
    .array(z.strictObject({ group: IdZ, option: IdZ, focus: FocusLinesZ }))
    .max(PACK_FOCUS_WHEN_MAX)
    .optional(),
})
export type PackSecurity = z.infer<typeof PackSecurityZ>

/**
 * `{{focus}}`: a pack's security focus as a bullet list (empty: none), with the lines its `when` sets add for the
 * choices the Brief made.
 */
export function renderSecurityFocus(pack: Pack | undefined, brief?: Pick<BriefInput, 'fields'>): string {
  const lines = [...(pack?.security?.focus ?? [])]
  for (const w of pack?.security?.when ?? []) {
    if (brief?.fields[w.group]?.choices.includes(w.option) !== true) continue
    for (const l of w.focus) if (!lines.includes(l)) lines.push(l)
  }
  return lines.map((l) => `- ${l}`).join('\n')
}

/** The most names a pack's `namesToAvoid` may list. */
export const PACK_NAMES_MAX = 100

export const PackZ = z
  .strictObject({
    $schema: z.string().max(2048).optional(),
    id: IdZ,
    version: z.literal(1),
    label: LabelZ,
    description: z.string().trim().min(1).max(300),
    /** Category detection: task-text keywords, and folder signals (file names or `*.ext` patterns at the root). */
    detect: z.strictObject({
      keywords: z.array(KeywordZ).max(80),
      files: z.array(z.string().trim().min(1).max(80)).max(80),
    }),
    groups: z.array(PackGroupZ).min(1).max(BRIEF_GROUPS_MAX),
    /** Run & Preview: more ways to run a folder of this category (data, checked like the rest of the pack). */
    preview: z.array(PackPreviewZ).max(20).optional(),
    /** Research: this category's own lenses, its default lenses, and whether its runs research by default. */
    research: PackResearchZ.optional(),
    /** The Deploy helper: where this category's deliverables can go, with trade-offs and copyable steps (data). */
    deploy: PackDeployZ.optional(),
    /** Security: what the security reviewer and the critic look at first for this category (data). */
    security: PackSecurityZ.optional(),
    /**
     * Names a project of this category must not take as its own (famous games' names: wording only). The Games pack's
     * built-in name check compares a game's title, README title and file names with them.
     */
    namesToAvoid: z.array(z.string().trim().min(2).max(40)).max(PACK_NAMES_MAX).optional(),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>()
    p.groups.forEach((g, i) => {
      if (seen.has(g.id))
        ctx.addIssue({ code: 'custom', path: ['groups', i, 'id'], message: `Duplicate group "${g.id}"` })
      seen.add(g.id)
    })
    p.security?.when?.forEach((w, i) => {
      const g = p.groups.find((x) => x.id === w.group)
      if (g === undefined || !g.options.some((o) => o.id === w.option))
        ctx.addIssue({
          code: 'custom',
          path: ['security', 'when', i],
          message: `"${w.group}" has no option "${w.option}"`,
        })
    })
  })
export type Pack = z.infer<typeof PackZ>

/** Where a pack came from: built in, or a user / project override file (which replaces the built-in of its id). */
export const PACK_LAYERS = ['builtin', 'user', 'project'] as const
export type PackLayer = (typeof PACK_LAYERS)[number]

export interface PackView {
  pack: Pack
  layer: PackLayer
  /** sha256 of the file's text (resolved.json records it). */
  sha256: string
}

/** An override file that could not be used (its built-in, if any, stays). */
export interface PackIssue {
  file: string
  message: string
}

// ---- the brief a user makes -------------------------------------------------------------------------------------

/**
 * Where a field's value came from: the user's own click, an accepted "Suggest choices" answer, or the local
 * keyword rules over the task text. All three are sent to Plan (a field still on "Let Dim Factory decide" is not).
 */
export const BRIEF_SOURCES = ['user', 'suggested', 'keyword'] as const
export type BriefSource = (typeof BRIEF_SOURCES)[number]

export const BriefFieldZ = z.strictObject({
  /** Option ids of the group (at most one for a single-choice group). */
  choices: z.array(IdZ).max(BRIEF_OPTIONS_MAX),
  /** The "Other" free text (only where the group allows it). */
  other: z.string().trim().min(1).max(BRIEF_OTHER_MAX).optional(),
  source: z.enum(BRIEF_SOURCES).optional(),
})
export type BriefField = z.infer<typeof BriefFieldZ>

/** A run's brief as the composer sends it (runs.start) and saves it per folder. Groups left out: Dim Factory decides. */
export const BriefInputZ = z.strictObject({
  category: IdZ,
  fields: z.record(IdZ, BriefFieldZ),
})
export type BriefInput = z.infer<typeof BriefInputZ>

// ---- detection (no tokens) --------------------------------------------------------------------------------------

/**
 * Something already in this repository (a manifest, a lockfile, a config file). A fact whose `group` is one of the
 * pack's groups locks it ("in this repo"): the brief cannot contradict it. A fact for a group the pack does not
 * have (the package manager, the test runner) is shown for information.
 */
export interface BriefFact {
  group: string
  /** The pack option it matches, when the pack has one. */
  option?: string
  label: string
  /** The file (or files) it was read from, as UI copy. */
  evidence: string
}

export interface BriefCategoryGuess {
  id: string
  source: 'task' | 'folder' | 'default'
  /** One line of UI copy: why this category. */
  reason: string
}

/** `brief.detect`: the packs, the detected category, what the folder says and the task text suggests. */
export interface BriefContext {
  packs: PackView[]
  issues: PackIssue[]
  category: BriefCategoryGuess
  /** Locked facts per pack id. */
  facts: Record<string, BriefFact[]>
  /** The keyword rules' choices per pack id (fields with source `keyword`), for groups no fact locks. */
  keywordFields: Record<string, Record<string, BriefField>>
  /** The brief saved for this folder (null: none). */
  saved: BriefInput | null
  /** "Suggest choices": the read-only call it would make, or why it cannot (UI copy). */
  suggest: BriefSuggestTarget
  /** Research's generic lenses (each pack adds its own, `pack.research`); the composer's lens picker lists both. */
  research: GenericLenses
}

export interface BriefSuggestTarget {
  /** null: no vendor can answer (the reason says why). */
  vendor: string | null
  model: string | null
  /** About how many tokens one call takes (the cost hint). */
  tokens: number
  /** The call's cost at the catalog's price, when known. */
  usd: number | null
  reason?: string
}

// ---- Suggest choices --------------------------------------------------------------------------------------------

export interface BriefSuggestion {
  group: string
  choices: string[]
  other?: string
  /** One line: why. */
  reason: string
}

export interface BriefSuggestResult {
  category: string
  suggestions: BriefSuggestion[]
  vendor: string
  model: string | null
}

// ---- helpers shared by core and the renderer -------------------------------------------------------------------

/** A field that says something (a choice or Other text); one that says nothing means "Let Dim Factory decide". */
export function fieldIsSet(f: BriefField | undefined): f is BriefField {
  return f !== undefined && (f.choices.length > 0 || (f.other !== undefined && f.other.trim() !== ''))
}

/** The brief chooses Test-first (its pack's approach group offers it with a pipeline effect). */
export function briefTestFirst(brief: BriefInput | null | undefined, pack: Pack | undefined): boolean {
  if (brief === null || brief === undefined || pack === undefined || pack.id !== brief.category) return false
  const group = pack.groups.find((g) => g.id === APPROACH_GROUP)
  const opt = group?.options.find((o) => o.id === TEST_FIRST)
  return opt?.effect === 'pipeline' && (brief.fields[APPROACH_GROUP]?.choices.includes(TEST_FIRST) ?? false)
}
