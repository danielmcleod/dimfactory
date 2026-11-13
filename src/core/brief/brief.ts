// A run's Brief as core takes it: checked against its pack and the folder's facts (what is already in the repository
// locks its groups), rendered into `{{brief}}` for the passes, and recorded in resolved.json. Only fields that say
// something (the user's choices, accepted suggestions, the task text's keyword choices) and the facts are rendered;
// everything else is left to the planner, which lists what it decided for the user to approve at the plan gate.
import { APPROACH_GROUP, briefTestFirst, fieldIsSet, renderSecurityFocus } from '../../shared/brief.ts'
import type { BriefFact, BriefField, BriefInput, Pack, PackGroup, PackView } from '../../shared/brief.ts'
import { designBarSection } from './design-bar.ts'

/** UI copy for the groups an informational fact names (groups no pack has). */
const INFO_GROUP_LABEL: Readonly<Record<string, string>> = {
  packageManager: 'Package manager',
  testRunner: 'Test runner',
  scripts: 'Scripts',
  ci: 'CI',
  notebooks: 'Notebooks',
}

export type BriefCheck = { ok: true; brief: BriefInput } | { ok: false; problems: string[] }

/** The groups a fact locks (facts naming one of the pack's groups). */
export function lockedGroups(pack: Pack, facts: readonly BriefFact[]): Set<string> {
  const ids = new Set(pack.groups.map((g) => g.id))
  return new Set(facts.filter((f) => ids.has(f.group)).map((f) => f.group))
}

/**
 * Check a brief against its pack: every group and option must exist, a single-choice group takes one value (a choice
 * or Other text), Other text only where the group allows it. Then the facts win: a single-choice group a fact locks
 * keeps the fact's value (the user's own value is dropped), and a locked multi-choice group keeps the user's
 * additions beside the facts. Fields that say nothing ("Let Dim Factory decide") are dropped.
 */
export function checkBrief(input: BriefInput, pack: Pack, facts: readonly BriefFact[]): BriefCheck {
  const problems: string[] = []
  if (input.category !== pack.id) problems.push(`The brief is for "${input.category}", not "${pack.id}".`)
  const locked = lockedGroups(pack, facts)
  const fields: Record<string, BriefField> = {}
  for (const [groupId, field] of Object.entries(input.fields)) {
    const group = pack.groups.find((g) => g.id === groupId)
    if (group === undefined) {
      problems.push(`The ${pack.label} brief has no group "${groupId}".`)
      continue
    }
    const unknown = field.choices.filter((c) => !group.options.some((o) => o.id === c))
    if (unknown.length > 0) {
      problems.push(`${group.label} has no option ${unknown.map((u) => `"${u}"`).join(', ')}.`)
      continue
    }
    if (field.other !== undefined && !group.other) {
      problems.push(`${group.label} takes no "Other" text.`)
      continue
    }
    const choices = [...new Set(field.choices)]
    const values = choices.length + (field.other !== undefined && field.other.trim() !== '' ? 1 : 0)
    if (!group.multi && values > 1) {
      problems.push(`${group.label} takes one choice.`)
      continue
    }
    if (!fieldIsSet({ ...field, choices })) continue
    if (locked.has(groupId) && !group.multi) continue
    const kept: BriefField = { choices }
    if (field.other !== undefined && field.other.trim() !== '') kept.other = field.other.trim()
    if (field.source !== undefined) kept.source = field.source
    fields[groupId] = kept
  }
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, brief: { category: pack.id, fields } }
}

const optionLabel = (group: PackGroup, id: string): string =>
  group.options.find((o) => o.id === id)?.label ?? id

function factLine(pack: Pack, f: BriefFact): string {
  const group = pack.groups.find((g) => g.id === f.group)
  const name = group?.label ?? INFO_GROUP_LABEL[f.group]
  const label = name === undefined || f.label.includes(':') ? f.label : `${name}: ${f.label}`
  return `- ${label} (${f.evidence})`
}

function sourceNote(field: BriefField): string {
  if (field.source === 'suggested') return ' (suggested by Dim Factory, accepted by the user)'
  if (field.source === 'keyword') return ' (from the task text)'
  return ''
}

/**
 * `{{brief}}`: the category, what is already in the repository, the choices for this run and the chosen approach
 * (method guidance), then the default look-and-feel bar when the run makes something people look at and its `task`
 * does not say how it should look (design-bar.ts). Empty when the brief says nothing and the folder has no facts.
 */
export function renderBrief(
  pack: Pack,
  brief: BriefInput,
  facts: readonly BriefFact[],
  o: { task?: string } = {},
): string {
  const choices: string[] = []
  const methods: string[] = []
  for (const group of pack.groups) {
    const field = brief.fields[group.id]
    if (!fieldIsSet(field)) continue
    if (group.id === APPROACH_GROUP) {
      for (const id of field.choices) {
        const o = group.options.find((x) => x.id === id)
        if (o === undefined) continue
        const how = o.effect === 'plan' ? ' (guides the plan)' : ''
        methods.push(`- ${o.label}${how}${o.guidance !== undefined ? `: ${o.guidance}` : ''}`)
      }
      if (field.other !== undefined) methods.push(`- Other: ${field.other}`)
      continue
    }
    const values = field.choices.map((c) => optionLabel(group, c))
    if (field.other !== undefined) values.push(`Other: ${field.other}`)
    choices.push(`- ${group.label}: ${values.join(', ')}${sourceNote(field)}`)
  }
  if (choices.length === 0 && methods.length === 0 && facts.length === 0) return ''
  const out: string[] = [`Category: ${pack.label}`]
  if (facts.length > 0) {
    out.push(
      '',
      'Already in this repository (build on these; do not replace them):',
      ...facts.map((f) => factLine(pack, f)),
    )
  }
  if (choices.length > 0) out.push('', 'Chosen for this run:', ...choices)
  if (methods.length > 0) out.push('', 'Approach:', ...methods)
  const look = o.task !== undefined ? designBarSection(brief, o.task) : ''
  if (look !== '') out.push('', look)
  return out.join('\n')
}

/** What resolved.json records about the brief (`brief`). */
export interface BriefRecord {
  input: BriefInput
  facts: BriefFact[]
  text: string
  testFirst: boolean
  pack: { id: string; layer: PackView['layer']; sha256: string }
  /** The pack's security focus as `{{focus}}` renders it (absent: the pack has none). */
  focus?: string
}

export function briefRecord(
  view: PackView,
  brief: BriefInput,
  facts: readonly BriefFact[],
  o: { task?: string } = {},
): BriefRecord {
  const focus = renderSecurityFocus(view.pack, brief)
  return {
    input: structuredClone(brief),
    facts: facts.map((f) => ({ ...f })),
    text: renderBrief(view.pack, brief, facts, o),
    testFirst: briefTestFirst(brief, view.pack),
    pack: { id: view.pack.id, layer: view.layer, sha256: view.sha256 },
    ...(focus !== '' ? { focus } : {}),
  }
}
