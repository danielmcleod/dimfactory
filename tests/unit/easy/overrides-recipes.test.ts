// Easy runs as config: the Easy recipes are valid built-in recipes with the switches Easy promises (questions first,
// research only for apps, websites, research memos and games with three lenses, security for apps, websites, games and data reports, the
// acceptance review, Fix until green, Explain, the plan check, no Auto, no Deploy step, no Verify or Test-first in an
// empty folder), and every Easy recipe with Easy's overrides layer resolves under every built-in profile: no extensions
// on any pass, plain questions, the plan check unless the user turned it off, and the run's own limits (none by
// default). The plain Clarify prompt validates as Clarify's template. Every step of a run belongs to one milestone.
import { PLAYTEST_ARGV, PLAYTEST_COMMAND_NAME } from '@shared/playtest.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_PROFILE_NAMES } from '@core/config/defaults.ts'
import { resolve } from '@core/config/resolve.ts'
import { easyOverrides } from '@core/easy/overrides.ts'
import { readBuiltinRecipes } from '@core/recipes/load.ts'
import { BUILTIN_PROMPTS_DIR } from '@core/prompts/resolve.ts'
import { validateTemplate } from '@core/prompts/template.ts'
import { runConfigFromResolved } from '@core/supervisor/machine.ts'
import { CLARIFY_PLAIN_TEMPLATE } from '@core/supervisor/effects.ts'
import { builtinDir } from '@core/packs/load.ts'
import { RUN_LIMITS_NONE, RunOverridesZ } from '@shared/config-schema.ts'
import {
  EASY_CHANGE_RECIPE,
  EASY_KINDS,
  EASY_KIND_PACK,
  EASY_KIND_RECIPE,
  EASY_RESEARCH_KINDS,
  MILESTONES,
  STEP_MILESTONE,
} from '@shared/easy.ts'
import { recipeOverrides } from '@shared/recipes.ts'
import type { Recipe } from '@shared/recipes.ts'
import { PASS_NAMES, STEP_KEYS } from '@shared/run.ts'
import { milestoneSteps } from '@renderer/pages/easy/model.ts'

const recipes = readBuiltinRecipes().map((v) => v.recipe)
const recipe = (id: string): Recipe => {
  const r = recipes.find((x) => x.id === id)
  if (r === undefined) throw new Error(`no recipe ${id}`)
  return r
}
const EASY_RECIPES = [...EASY_KINDS.map((k) => EASY_KIND_RECIPE[k]), EASY_CHANGE_RECIPE]
const genericLenses = (
  JSON.parse(readFileSync(join(builtinDir(), 'research-lenses.json'), 'utf8')) as { lenses: { id: string }[] }
).lenses.map((l) => l.id)

describe('the Easy recipes', () => {
  it.each(EASY_KINDS.map((k) => [k]))('%s: the switches Easy promises', (kind) => {
    const r = recipe(EASY_KIND_RECIPE[kind])
    const research = EASY_RESEARCH_KINDS.includes(kind)
    expect(r.toggles).toEqual({
      clarify: true,
      research,
      testFirst: false,
      // A report from data is security-reviewed too: its page must not publish people's details.
      security: kind === 'app' || kind === 'website' || kind === 'game' || kind === 'data',
      acceptance: true,
      fixRounds: 3,
      deploy: false,
      explain: true,
    })
    expect(r.auto).toBe(false)
    expect(r.gates).toEqual({ afterPlan: true, beforeFix: false })
    // An empty folder has no verify command yet: Verify on would block the first run at preflight. A game is the one
    // exception: its Verify is Dim Factory's own play-test (no program, no grant), which plays its playtest.json.
    if (kind === 'game')
      expect(r.verify).toEqual({
        enabled: true,
        commands: [{ name: PLAYTEST_COMMAND_NAME, run: [...PLAYTEST_ARGV] }],
      })
    else expect(r.verify?.enabled).not.toBe(true)
    expect(r.brief?.category).toBe(EASY_KIND_PACK[kind])
    if (research) {
      expect(r.researchLenses).toHaveLength(3)
      // Generic lenses, or the kind's own pack's (a game researches comparable games and game feel).
      const packLenses =
        (
          JSON.parse(readFileSync(join(builtinDir(), `${EASY_KIND_PACK[kind]}.json`), 'utf8')) as {
            research?: { lenses?: { id: string }[] }
          }
        ).research?.lenses?.map((l) => l.id) ?? []
      for (const l of r.researchLenses ?? []) expect([...genericLenses, ...packLenses], l).toContain(l)
    } else expect(r.researchLenses).toBeUndefined()
    expect(RunOverridesZ.safeParse(recipeOverrides(r)).success).toBe(true)
  })

  it('a change: no research, the plan check kept, no brief of its own (the folder keeps its own)', () => {
    const r = recipe(EASY_CHANGE_RECIPE)
    expect(r.toggles).toMatchObject({ research: false, clarify: true, acceptance: true, explain: true })
    expect(r.gates?.afterPlan).toBe(true)
    expect(r.brief).toBeUndefined()
  })

  it('label every Easy recipe as Easy, in plain words without dashes', () => {
    for (const id of EASY_RECIPES) {
      const r = recipe(id)
      expect(r.label.startsWith('Easy: '), id).toBe(true)
      expect(`${r.label} ${r.description} ${r.taskHint ?? ''}`, id).not.toMatch(/[–—]/)
    }
  })
})

describe("Easy's overrides layer", () => {
  it.each(BUILTIN_PROFILE_NAMES.map((p) => [p]))('resolves with every Easy recipe under %s', (profile) => {
    for (const id of EASY_RECIPES) {
      const run = easyOverrides({ profile, skipPlanCheck: false, limits: RUN_LIMITS_NONE })
      expect(RunOverridesZ.safeParse(run).success, id).toBe(true)
      const { config } = resolve({ recipe: { id, value: recipeOverrides(recipe(id)) }, run })
      expect(config.profile, id).toBe(profile)
      expect(config.auto, id).toBe(false)
      // The passes that build run at the user's own level (pass through by default); the read-only ones at none.
      for (const p of PASS_NAMES)
        expect(config.passes[p].extensions, `${id} ${p}`).toBe(
          p === 'implement' || p === 'fix' ? 'passthrough' : 'none',
        )
      expect(config.passes.plan.clarify, id).toBe(true)
      expect(config.passes.plan.clarifyPlain, id).toBe(true)
      expect(config.passes.plan.explain, id).toBe(true)
      expect(config.passes.review.acceptance, id).toBe(true)
      expect(config.passes.fix.rounds, id).toBe(3)
      expect(config.gates, id).toEqual({ afterPlan: true, beforeFix: false })
      expect(config.limits, id).toEqual({ maxCostUsd: null, maxMinutes: null })
      // Only a game's recipe turns Verify on, with Dim Factory's own play-test.
      expect(config.verify.enabled, id).toBe(id === EASY_KIND_RECIPE.game)
      // The run asks plain questions.
      expect(runConfigFromResolved(config).clarify, id).toMatchObject({ plain: true })
    }
  })

  it('"Don\'t ask me next time" turns the plan check off; a limit set by the user is the run\'s', () => {
    const run = easyOverrides({
      profile: 'claude-only',
      skipPlanCheck: true,
      limits: { maxCostUsd: 5, maxMinutes: 45 },
    })
    const { config } = resolve({
      recipe: { id: 'easy-software', value: recipeOverrides(recipe('easy-software')) },
      run,
    })
    expect(config.gates.afterPlan).toBe(false)
    expect(config.limits).toEqual({ maxCostUsd: 5, maxMinutes: 45 })
  })

  it('a Full run keeps the standard questions and no limits', () => {
    const { config } = resolve({ run: { profile: 'balanced', passes: { plan: { clarify: true } } } })
    expect(config.passes.plan.clarifyPlain).toBe(false)
    expect(runConfigFromResolved(config).clarify).toEqual({ questions: 4, inAuto: false })
    expect(config.limits).toEqual({ maxCostUsd: null, maxMinutes: null })
    expect(config.ui.experience).toBeNull()
  })
})

describe('the plain Clarify prompt', () => {
  it("validates as Clarify's template and asks about the outcome, never the technology", () => {
    const text = readFileSync(join(BUILTIN_PROMPTS_DIR, `${CLARIFY_PLAIN_TEMPLATE}.md`), 'utf8').replace(
      /\r\n/g,
      '\n',
    )
    const v = validateTemplate(text, 'clarify')
    expect(v.issues).toEqual([])
    expect(v.ok).toBe(true)
    expect(text).toContain('Never ask about technology')
    expect(text).toContain('{"questions": []}')
  })
})

describe('milestones', () => {
  it('every step of a run belongs to exactly one milestone', () => {
    expect(Object.keys(STEP_MILESTONE).sort()).toEqual([...STEP_KEYS].sort())
    for (const k of STEP_KEYS) expect(MILESTONES, k).toContain(STEP_MILESTONE[k])
    const all = MILESTONES.flatMap((m) => milestoneSteps(m))
    expect(all.sort()).toEqual([...STEP_KEYS].sort())
    expect(new Set(all).size).toBe(STEP_KEYS.length)
  })

  it('in run order: understanding, building, checking, fixing, wrapping up', () => {
    expect(MILESTONES).toEqual(['understand', 'build', 'check', 'fix', 'wrap'])
    const order = STEP_KEYS.map((k) => MILESTONES.indexOf(STEP_MILESTONE[k]))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})
