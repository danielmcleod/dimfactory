// Recipes: the schema, the built-in recipes checked against the built-in packs, the switches mapped onto config keys,
// the brief defaults, the file layers (built in, user, project; same id replaces; a bad file is an issue) and an unknown
// recipe id (VALIDATION with a did-you-mean).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPROACH_GROUP, TEST_FIRST } from '@shared/brief.ts'
import { RunOverridesZ } from '@shared/config-schema.ts'
import {
  BUILTIN_RECIPE_IDS,
  RECIPE_FILE_MAX_BYTES,
  RecipeZ,
  briefWithRecipe,
  recipeBrief,
  recipeOverrides,
  recipeSummary,
  recipeTurnsOff,
  recipeTurnsOn,
  runRecipeOf,
} from '@shared/recipes.ts'
import type { Recipe } from '@shared/recipes.ts'
import { FIX_ROUNDS_MAX } from '@shared/run.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'
import {
  loadRecipes,
  parseRecipeText,
  projectRecipeSha,
  readBuiltinRecipes,
  recipeById,
  resolveRecipe,
} from '@core/recipes/load.ts'
import { DimFactoryError } from '@core/errors.ts'

const RECIPES_DIR = fileURLToPath(new URL('../../../src/core/recipes/', import.meta.url))
/** The en dash and the em dash (from their code points). */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)

const minimal = (over: Partial<Recipe> = {}): Recipe => ({
  id: 'mine',
  version: 1,
  label: 'Mine',
  description: 'A recipe of my own.',
  toggles: {},
  ...over,
})

describe('RecipeZ', () => {
  it('accepts a minimal recipe and every key', () => {
    expect(RecipeZ.safeParse(minimal()).success).toBe(true)
    const full = minimal({
      $schema: 'https://example.org/recipe.schema.json',
      toggles: {
        research: true,
        clarify: true,
        security: false,
        testFirst: true,
        fixRounds: FIX_ROUNDS_MAX,
        deploy: true,
        explain: true,
        acceptance: true,
      },
      passes: { review: { enabled: true }, critic: { enabled: false }, fix: { enabled: true } },
      auto: false,
      gates: { afterPlan: false, beforeFix: true },
      verify: { enabled: true, commands: [{ name: 'test', run: ['npm', 'test'] }] },
      researchLenses: ['comparable', 'standards'],
      brief: { category: 'software', fields: { approach: { choices: ['test-first'] } } },
      taskHint: 'What to build',
    })
    expect(RecipeZ.safeParse(full).success).toBe(true)
  })

  it.each([
    ['an unknown top-level key', { ...minimal(), extra: true }],
    ['an unknown switch', minimal({ toggles: { turbo: true } as never })],
    ['too many fix rounds', minimal({ toggles: { fixRounds: FIX_ROUNDS_MAX + 1 } })],
    ['zero fix rounds', minimal({ toggles: { fixRounds: 0 } })],
    ['a pass a recipe cannot switch', minimal({ passes: { plan: { enabled: false } } as never })],
    ['a pass key that is not "enabled"', minimal({ passes: { review: { vendor: 'codex' } } as never })],
    ['an id with capitals', minimal({ id: 'Mine' })],
    ['an id that is a path', minimal({ id: '../mine' })],
    ['version 2', { ...minimal(), version: 2 }],
    ['an empty label', minimal({ label: ' ' })],
    ['a verify command without a name', minimal({ verify: { commands: [{ run: ['x'] }] as never } })],
    ['a lens that is not an id', minimal({ researchLenses: ['Bad Lens'] })],
    ['a brief without fields', minimal({ brief: { category: 'software' } as never })],
  ])('rejects %s', (_name, value) => {
    expect(RecipeZ.safeParse(value).success).toBe(false)
  })
})

describe('the built-in recipes', () => {
  const builtins = readBuiltinRecipes()
  const packs = readBuiltinPacks().map((v) => v.pack)

  it('are the built-in recipes, in order, one file each, every file valid and named by its id', () => {
    expect(builtins.map((v) => v.recipe.id)).toEqual([...BUILTIN_RECIPE_IDS])
    expect(builtins.map((v) => v.recipe.label)).toEqual([
      'New web app',
      'Bug fix',
      'Add feature',
      'Refactor safely',
      'Write docs',
      'Data report',
      'New game',
      'Game jam',
      'Easy: an app',
      'Easy: a website',
      'Easy: a document or guide',
      'Easy: a report from data',
      'Easy: a research memo',
      'Easy: a checklist or how-to',
      'Easy: a game',
      'Easy: make a change',
      'Easy: work on a folder you have',
    ])
    const files = readdirSync(RECIPES_DIR).filter((f) => f.endsWith('.json'))
    expect(files.sort()).toEqual(BUILTIN_RECIPE_IDS.map((id) => `${id}.json`).sort())
    for (const v of builtins) {
      expect(v.layer).toBe('builtin')
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/)
      const text = readFileSync(join(RECIPES_DIR, `${v.recipe.id}.json`), 'utf8')
      expect(text, v.recipe.id).not.toMatch(DASHES)
      expect(text.includes('\r'), v.recipe.id).toBe(false)
    }
  })

  it.each(BUILTIN_RECIPE_IDS.map((id) => [id]))('%s: its brief names real pack groups and options', (id) => {
    const r = builtins.find((v) => v.recipe.id === id)?.recipe
    if (r === undefined) throw new Error(`no ${id}`)
    const brief = recipeBrief(r)
    if (brief === undefined) return
    const pack = packs.find((p) => p.id === brief.category)
    expect(pack, `${id}: pack ${brief.category}`).toBeDefined()
    for (const [groupId, field] of Object.entries(brief.fields)) {
      const group = pack?.groups.find((g) => g.id === groupId)
      expect(group, `${id}: group ${groupId}`).toBeDefined()
      for (const c of field.choices) {
        expect(
          group?.options.some((o) => o.id === c),
          `${id}: option ${groupId}.${c}`,
        ).toBe(true)
      }
      if (group?.multi === false) expect(field.choices.length, `${id}: ${groupId}`).toBeLessThanOrEqual(1)
    }
    // Test-first on only where the pack offers it as a pipeline change.
    if (r.toggles.testFirst === true) {
      const approach = pack?.groups.find((g) => g.id === APPROACH_GROUP)
      expect(approach?.options.find((o) => o.id === TEST_FIRST)?.effect, id).toBe('pipeline')
    }
  })

  it.each(BUILTIN_RECIPE_IDS.map((id) => [id]))('%s: its config layer is a valid run layer', (id) => {
    const r = builtins.find((v) => v.recipe.id === id)?.recipe
    if (r === undefined) throw new Error(`no ${id}`)
    expect(RunOverridesZ.safeParse(recipeOverrides(r)).success).toBe(true)
    // A recipe that writes tests first turns Verify on (Test-first needs it).
    if (r.toggles.testFirst === true) expect(r.verify?.enabled, id).toBe(true)
    // Built-in recipes never turn Auto on.
    expect(r.auto, id).not.toBe(true)
    expect(recipeSummary(r), id).not.toMatch(DASHES)
  })

  it('pick the documented defaults', () => {
    const get = (id: string): Recipe => {
      const r = builtins.find((v) => v.recipe.id === id)?.recipe
      if (r === undefined) throw new Error(id)
      return r
    }
    // A new web app starts in an empty folder: no test runner and no verify command exist before the scaffold, so the
    // recipe turns neither Test-first nor Verify on (both would block the first run at preflight).
    expect(get('new-web-app').toggles).toEqual({
      clarify: true,
      research: true,
      testFirst: false,
      security: true,
      acceptance: true,
      fixRounds: 3,
      explain: true,
    })
    expect(get('new-web-app').verify?.enabled).not.toBe(true)
    expect(get('new-web-app').brief?.category).toBe('software')
    expect(get('new-web-app').brief?.fields['projectType']?.choices).toEqual(['spa'])
    expect(get('bug-fix').toggles).toMatchObject({
      research: false,
      clarify: false,
      testFirst: true,
      fixRounds: 2,
      acceptance: true,
      explain: false,
    })
    // Characterization tests pass on today's code, so Test-first's red check is off and the approach guides the plan.
    expect(get('refactor-safely').toggles).toMatchObject({ testFirst: false, security: false, fixRounds: 2 })
    expect(get('refactor-safely').brief?.fields[APPROACH_GROUP]?.choices).toEqual(['characterization-tests'])
    expect(get('write-docs').brief?.category).toBe('documents')
    expect(get('write-docs').toggles.explain).toBe(true)
    expect(get('data-report').brief?.category).toBe('data')
    expect(get('data-report').toggles).toMatchObject({ research: true, explain: true })
    expect(get('add-feature').toggles).toMatchObject({ clarify: true, acceptance: true, fixRounds: 2 })
  })
})

describe('recipeOverrides: the switches as config keys', () => {
  it.each([
    ['research', { research: true }, { passes: { plan: { research: true } } }],
    ['clarify', { clarify: false }, { passes: { plan: { clarify: false } } }],
    ['security', { security: true }, { passes: { security: { enabled: true } } }],
    ['fixRounds', { fixRounds: 3 }, { passes: { fix: { rounds: 3 } } }],
    ['deploy', { deploy: true }, { passes: { implement: { deploy: true } } }],
    ['explain', { explain: true }, { passes: { plan: { explain: true } } }],
    ['acceptance', { acceptance: true }, { passes: { review: { acceptance: true } } }],
  ] as const)('%s', (_k, toggles, expected) => {
    expect(recipeOverrides(minimal({ toggles }))).toEqual(expected)
  })

  it('testFirst is not a config key (it is the brief), and an empty recipe sets nothing', () => {
    expect(recipeOverrides(minimal({ toggles: { testFirst: true } }))).toEqual({})
    expect(recipeOverrides(minimal())).toEqual({})
  })

  it('passes, Auto, gates, Verify and lenses', () => {
    const r = minimal({
      toggles: { acceptance: false, fixRounds: 2 },
      passes: { review: { enabled: true }, critic: { enabled: false }, fix: { enabled: false } },
      auto: true,
      gates: { beforeFix: false },
      verify: { enabled: true, commands: [{ name: 'unit', run: 'npm test' }] },
      researchLenses: ['standards'],
    })
    expect(recipeOverrides(r)).toEqual({
      passes: {
        plan: { researchLenses: ['standards'] },
        review: { enabled: true, acceptance: false },
        critic: { enabled: false },
        fix: { enabled: false, rounds: 2 },
      },
      auto: true,
      gates: { beforeFix: false },
      verify: { enabled: true, commands: [{ name: 'unit', run: 'npm test' }] },
    })
    // A copy: changing the layer never changes the recipe.
    const out = recipeOverrides(r)
    out.verify?.commands?.splice(0)
    expect(r.verify?.commands).toHaveLength(1)
  })
})

describe('recipeBrief and briefWithRecipe', () => {
  it('adds test-first to the approach group, first; testFirst off takes it out', () => {
    const on = recipeBrief(
      minimal({
        toggles: { testFirst: true },
        brief: { category: 'software', fields: { approach: { choices: ['milestones'] } } },
      }),
    )
    expect(on?.fields[APPROACH_GROUP]?.choices).toEqual([TEST_FIRST, 'milestones'])
    const off = recipeBrief(
      minimal({
        toggles: { testFirst: false },
        brief: { category: 'software', fields: { approach: { choices: [TEST_FIRST] } } },
      }),
    )
    expect(off?.fields[APPROACH_GROUP]).toBeUndefined()
  })

  it('testFirst alone is a Software brief; no brief and no testFirst is none', () => {
    expect(recipeBrief(minimal({ toggles: { testFirst: true } }))).toEqual({
      category: 'software',
      fields: { approach: { choices: [TEST_FIRST] } },
    })
    expect(recipeBrief(minimal())).toBeUndefined()
  })

  it("a run's own brief wins over the recipe's defaults", () => {
    const r = minimal({ brief: { category: 'data', fields: {} } })
    const own = { category: 'software', fields: {} }
    expect(briefWithRecipe(own, r)).toBe(own)
    expect(briefWithRecipe(undefined, r)).toEqual({ category: 'data', fields: {} })
    expect(briefWithRecipe(undefined, undefined)).toBeUndefined()
  })
})

describe('the words', () => {
  it('says what a recipe turns on and off', () => {
    const r = minimal({
      toggles: { research: true, fixRounds: 3, security: false, testFirst: true },
      passes: { critic: { enabled: false } },
      verify: { enabled: true },
      auto: true,
    })
    expect(recipeTurnsOn(r)).toEqual([
      'Research',
      'Test-first',
      'Fix until green (3 rounds)',
      'Verify',
      'Auto mode',
    ])
    expect(recipeTurnsOff(r)).toEqual(['Security review', 'Critic'])
    expect(recipeSummary(r)).toBe(
      'Turns on Research, Test-first, Fix until green (3 rounds), Verify, Auto mode. Turns off Security review, Critic.',
    )
    expect(recipeSummary(minimal())).toBe('Changes no switches.')
  })
})

describe('loadRecipes: the layers', () => {
  let tmp: string
  let home: string
  let folder: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'df-recipes-'))
    home = join(tmp, 'home')
    folder = join(tmp, 'repo')
    mkdirSync(join(home, 'recipes'), { recursive: true })
    mkdirSync(join(folder, '.dimfactory', 'recipes'), { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const write = (dir: string, name: string, value: unknown): string => {
    const file = join(dir, name)
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    return file
  }
  const userDir = (): string => join(home, 'recipes')
  const projectDir = (): string => join(folder, '.dimfactory', 'recipes')

  it('built-ins only, with no files', async () => {
    const r = await loadRecipes({ home, folder })
    expect(r.recipes.map((v) => v.recipe.id)).toEqual([...BUILTIN_RECIPE_IDS])
    expect(r.issues).toEqual([])
    expect(r.dirs).toEqual({ user: userDir(), project: projectDir() })
    expect((await loadRecipes({ home })).dirs.project).toBeNull()
  })

  it('a user file replaces the built-in of its id in place; a project file replaces the user one', async () => {
    const userFile = write(userDir(), 'bug-fix.json', { ...minimal({ id: 'bug-fix', label: 'My bug fix' }) })
    const a = await loadRecipes({ home, folder })
    const mine = a.recipes[1]
    expect(mine?.recipe.label).toBe('My bug fix')
    expect(mine?.layer).toBe('user')
    expect(mine?.path).toBe(userFile)
    const projectFile = write(projectDir(), 'bug-fix.json', minimal({ id: 'bug-fix', label: 'Team bug fix' }))
    const b = await loadRecipes({ home, folder })
    expect(b.recipes.map((v) => v.recipe.id)).toEqual([...BUILTIN_RECIPE_IDS])
    expect(b.recipes[1]).toMatchObject({ layer: 'project', path: projectFile })
    expect(b.recipes[1]?.recipe.label).toBe('Team bug fix')
    // Without the folder, the user layer stands.
    expect((await loadRecipes({ home })).recipes[1]?.layer).toBe('user')
  })

  it('a new id adds a recipe after the built-ins, sorted', async () => {
    write(projectDir(), 'zeta.json', minimal({ id: 'zeta', label: 'Zeta' }))
    write(userDir(), 'alpha.json', minimal({ id: 'alpha', label: 'Alpha' }))
    const r = await loadRecipes({ home, folder })
    expect(r.recipes.map((v) => v.recipe.id)).toEqual([...BUILTIN_RECIPE_IDS, 'alpha', 'zeta'])
  })

  it('a bad file is an issue and is skipped (the lower layer stays); nothing throws', async () => {
    const broken = write(userDir(), 'bug-fix.json', '{ "id": "bug-fix", ')
    const invalid = write(projectDir(), 'add-feature.json', {
      ...minimal({ id: 'add-feature' }),
      turbo: true,
    })
    const misnamed = write(projectDir(), 'other.json', minimal({ id: 'not-other' }))
    write(projectDir(), 'notes.txt', 'not a recipe')
    const big = write(userDir(), 'huge.json', ' '.repeat(RECIPE_FILE_MAX_BYTES + 1))
    const r = await loadRecipes({ home, folder })
    expect(r.recipes.find((v) => v.recipe.id === 'bug-fix')?.layer).toBe('builtin')
    expect(r.recipes.find((v) => v.recipe.id === 'add-feature')?.layer).toBe('builtin')
    expect(r.recipes.map((v) => v.recipe.id)).toEqual([...BUILTIN_RECIPE_IDS])
    const byFile = Object.fromEntries(r.issues.map((i) => [i.file, i.message]))
    expect(byFile[broken]).toMatch(/^Not valid JSON/)
    expect(byFile[invalid]).toMatch(/^Not a valid recipe/)
    expect(byFile[misnamed]).toBe('The file name must match the recipe id ("not-other.json")')
    expect(byFile[big]).toMatch(/^Too large/)
    expect(r.issues).toHaveLength(4)
  })

  it('records the sha256 of the text (line endings normalized), and the project sha for a grant', async () => {
    const text = JSON.stringify(minimal({ id: 'ship', auto: true }))
    write(projectDir(), 'ship.json', text)
    const r = await loadRecipes({ home, folder })
    const v = r.recipes.find((x) => x.recipe.id === 'ship')
    const parsed = parseRecipeText(text, 'ship')
    expect(parsed.ok && parsed.sha256).toBe(v?.sha256)
    expect(await projectRecipeSha(folder, 'ship')).toBe(v?.sha256)
    expect(await projectRecipeSha(folder, 'none-here')).toBeNull()
    write(projectDir(), 'ship.json', text.replace('"auto":true', '"auto":false'))
    expect(await projectRecipeSha(folder, 'ship')).not.toBe(v?.sha256)
    expect(runRecipeOf(v as NonNullable<typeof v>)).toEqual({
      id: 'ship',
      label: 'Mine',
      layer: 'project',
      sha256: v?.sha256,
    })
  })

  it('an unknown recipe id is VALIDATION with a did-you-mean', async () => {
    const list = await loadRecipes({ home, folder })
    expect(recipeById(list, 'bug-fix').recipe.label).toBe('Bug fix')
    let err: unknown
    try {
      recipeById(list, 'bug-fx')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DimFactoryError)
    expect((err as DimFactoryError).code).toBe('VALIDATION')
    expect((err as Error).message).toContain('Unknown recipe "bug-fx" (did you mean "bug-fix"?)')
    expect((err as Error).message).toContain('Recipes: new-web-app, bug-fix,')
    await expect(resolveRecipe({ home, folder, id: 'nothing-like-it' })).rejects.toThrow(
      /^Unknown recipe "nothing-like-it"\. Recipes:/,
    )
  })
})
