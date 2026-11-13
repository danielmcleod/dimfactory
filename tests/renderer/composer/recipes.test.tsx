// The composer's Recipe picker: a one-line row (its place kept while recipes.list answers), None first, then the
// recipes with their layer; picking one sends its id with config.resolve, preflight.run, estimates.get and
// runs.start, fills the Brief's groups the user has not set (their own choices stay), uses its task hint as the
// placeholder and shows core's "recipe" badges; None clears it; selectComposerRecipe picks one by id from elsewhere.
// Also Settings > Recipes: the layers, what each turns on, where the files live and the files that could not be used.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BriefContext, Pack } from '@shared/brief.ts'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { RecipeView, RecipesList } from '@shared/recipes.ts'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import {
  DEFAULT_TASK_PLACEHOLDER,
  applyRecipeToDraft,
  resetRecipeIntentForTests,
  selectComposerRecipe,
} from '@renderer/pages/dashboard/composer/recipes.ts'
import { EMPTY_DRAFT } from '@renderer/pages/dashboard/composer/brief-model.ts'
import { RECIPE_NOTE_NONE } from '@renderer/pages/dashboard/composer/RecipeRow.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  GENERIC_LENSES,
  fakeResolve,
  FOLDER,
  mountComposer,
  probe,
  report,
  runEstimate,
} from './fixtures.tsx'

const SOFTWARE: Pack = {
  id: 'software',
  version: 1,
  label: 'Software',
  description: 'Apps, sites, services, tools and libraries: code that runs.',
  detect: { keywords: ['app'], files: ['package.json'] },
  groups: [
    {
      id: 'projectType',
      label: 'Project type',
      multi: false,
      other: true,
      options: [
        { id: 'cli', label: 'CLI or script' },
        { id: 'spa', label: 'Single-page app' },
      ],
    },
    {
      id: 'constraints',
      label: 'Constraints',
      multi: true,
      other: false,
      options: [
        { id: 'keep-style', label: 'Keep the style' },
        { id: 'no-new-deps', label: 'No new dependencies' },
      ],
    },
    {
      id: 'approach',
      label: 'Approach',
      multi: true,
      other: false,
      options: [
        { id: 'test-first', label: 'Test-first', effect: 'pipeline', guidance: 'Tests first.' },
        { id: 'milestones', label: 'Milestones', effect: 'plan', guidance: 'Milestones.' },
      ],
    },
  ],
}

const CONTEXT: BriefContext = {
  packs: [{ pack: SOFTWARE, layer: 'builtin', sha256: '0'.repeat(64) }],
  issues: [],
  category: { id: 'software', source: 'folder', reason: 'Found package.json in the folder' },
  facts: {},
  keywordFields: {},
  saved: null,
  suggest: { vendor: 'claude', model: 'sonnet', tokens: 4200, usd: 0.012 },
  research: GENERIC_LENSES,
}

const BUG_FIX: RecipeView = {
  recipe: {
    id: 'bug-fix',
    version: 1,
    label: 'Bug fix',
    description: 'Fix a bug: a failing test first.',
    toggles: { testFirst: true, fixRounds: 2, acceptance: true },
    brief: {
      category: 'software',
      fields: {
        projectType: { choices: ['spa'] },
        constraints: { choices: ['keep-style', 'no-new-deps'] },
      },
    },
    taskHint: 'What goes wrong, and what should happen instead',
  },
  layer: 'builtin',
  path: 'builtin/bug-fix.json',
  sha256: '1'.repeat(64),
}
const TEAM: RecipeView = {
  recipe: {
    id: 'team-flow',
    version: 1,
    label: 'Team flow',
    description: 'The way this team works.',
    toggles: { research: true },
  },
  layer: 'project',
  path: `${FOLDER}\\.dimfactory\\recipes\\team-flow.json`,
  sha256: '2'.repeat(64),
}
const MINE: RecipeView = {
  recipe: { id: 'mine', version: 1, label: 'Mine', description: 'Mine.', toggles: { explain: true } },
  layer: 'user',
  path: 'C:\\home\\recipes\\mine.json',
  sha256: '3'.repeat(64),
}

const LIST: RecipesList = {
  recipes: [BUG_FIX, MINE, TEAM],
  issues: [
    { file: 'C:\\home\\recipes\\broken.json', message: 'Not valid JSON: Unexpected end of JSON input' },
  ],
  dirs: { user: 'C:\\home\\recipes', project: `${FOLDER}\\.dimfactory\\recipes` },
}

/** core's config.resolve with the recipe layer: Bug fix sets Fix's rounds (provenance `recipe`). */
function resolveWithRecipe() {
  const base = fakeResolve()
  return (req: { folder?: string; overrides?: RunOverrides; recipe?: string }) => {
    const r = base(req)
    if (req.recipe === 'bug-fix' && req.overrides?.passes?.fix?.rounds === undefined) {
      r.config.passes.fix.rounds = 2
      r.provenance['/passes/fix/rounds'] = { source: 'recipe', via: 'recipe:bug-fix' }
      r.config.gates.beforeFix = true
      r.provenance['/gates/beforeFix'] = { source: 'recipe', via: 'recipe:bug-fix' }
    }
    return r
  }
}

let mock: MockDimFactory
let listAnswer: () => RecipesList | Promise<RecipesList>

beforeEach(() => {
  resetRecipeIntentForTests()
  setLiveSupportForTests()
  listAnswer = () => LIST
  mock = setUp({
    handlers: {
      'config.resolve': resolveWithRecipe(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'runs.start': () => ({ runId: 'r9', displayNo: 9 }),
      'brief.detect': () => CONTEXT,
      'brief.save': () => undefined,
      'recipes.list': () => listAnswer(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

const el = (id: string): HTMLElement => screen.getByTestId(id)

async function ready(): Promise<void> {
  await mountComposer()
  await settle(300)
}

async function pick(label: string): Promise<void> {
  act(() => {
    fireEvent.keyDown(el('composer-recipe'), { key: 'Enter' })
  })
  await settle()
  act(() => {
    fireEvent.keyDown(screen.getByRole('option', { name: label }), { key: 'Enter' })
  })
  await settle(300)
}

describe('the Recipe row', () => {
  it('is one line with None, then the recipes with their layer, in the order core lists them', async () => {
    await ready()
    expect(el('composer-recipe-row').className).toContain('min-h-7')
    expect(el('composer-recipe').textContent).toContain('None')
    expect(el('composer-recipe-note').textContent).toBe(RECIPE_NOTE_NONE)
    expect(mock.callsOf('recipes.list')[0]).toEqual({ folder: FOLDER })
    act(() => {
      fireEvent.keyDown(el('composer-recipe'), { key: 'Enter' })
    })
    await settle()
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'None',
      'Bug fix',
      'Mine (User)',
      'Team flow (Project)',
    ])
  })

  it('keeps its place and width while recipes.list is on its way', async () => {
    let answer: (l: RecipesList) => void = () => undefined
    listAnswer = () =>
      new Promise<RecipesList>((r) => {
        answer = r
      })
    await ready()
    const shape = (): string[] => [el('composer-recipe-row').className, el('composer-recipe').className]
    const before = shape()
    expect(
      el('composer-recipe').hasAttribute('disabled') ||
        el('composer-recipe').dataset['disabled'] !== undefined,
    ).toBe(true)
    await act(async () => {
      answer(LIST)
      await Promise.resolve()
    })
    await settle()
    expect(shape()).toEqual(before)
  })

  it('picking a recipe sends its id everywhere, fills the Brief and shows the hint and the recipe badge', async () => {
    await ready()
    expect(el('composer-task').getAttribute('placeholder')).toBe(DEFAULT_TASK_PLACEHOLDER)
    // The user's own choice in a group the recipe also fills.
    fireEvent.click(el('brief-toggle'))
    await settle()
    fireEvent.click(el('brief-option-projectType-cli'))
    await settle(300)

    await pick('Bug fix')
    expect(mock.callsOf('config.resolve').at(-1)).toEqual({ folder: FOLDER, recipe: 'bug-fix' })
    const pre = mock.callsOf('preflight.run').at(-1)
    expect(pre?.recipe).toBe('bug-fix')
    expect(mock.callsOf('estimates.get').at(-1)?.recipe).toBe('bug-fix')
    // The user's projectType stays; the recipe fills constraints and Test-first (its testFirst switch).
    expect(pre?.brief).toEqual({
      category: 'software',
      fields: {
        projectType: { choices: ['cli'], source: 'user' },
        constraints: { choices: ['keep-style', 'no-new-deps'], source: 'suggested' },
        approach: { choices: ['test-first'], source: 'suggested' },
      },
    })
    expect(el('composer-task').getAttribute('placeholder')).toBe(
      'What goes wrong, and what should happen instead',
    )
    expect(el('composer-recipe-note').textContent).toContain('Turns on Test-first, Acceptance review')
    fireEvent.click(el('composer-passes-toggle'))
    await settle()
    const badge = el('gate-provenance-beforeFix')
    expect(badge.dataset['source']).toBe('recipe')
    expect(badge.getAttribute('aria-label')).toBe('recipe: From the recipe bug-fix')
    // Saved for the folder like an accepted suggestion (debounced).
    await settle(500)
    expect(mock.callsOf('brief.save').at(-1)?.brief?.fields['constraints']?.source).toBe('suggested')

    fireEvent.change(el('composer-task'), { target: { value: 'The date shows in UTC' } })
    await settle()
    await act(async () => {
      fireEvent.click(el('composer-run'))
      await settle()
    })
    const started = mock.callsOf('runs.start').at(-1)
    expect(started?.recipe).toBe('bug-fix')
    expect(started?.brief?.fields['approach']?.choices).toEqual(['test-first'])
  })

  it('None clears the recipe from every request', async () => {
    await ready()
    await pick('Team flow (Project)')
    expect(mock.callsOf('config.resolve').at(-1)?.recipe).toBe('team-flow')
    await pick('None')
    expect(mock.callsOf('config.resolve').at(-1)).toEqual({ folder: FOLDER })
    expect(mock.callsOf('preflight.run').at(-1)?.recipe).toBeUndefined()
    expect(el('composer-recipe-note').textContent).toBe(RECIPE_NOTE_NONE)
  })

  it('selectComposerRecipe picks one by id (an id the folder has not is dropped)', async () => {
    selectComposerRecipe('mine')
    await ready()
    expect(el('composer-recipe').textContent).toContain('Mine')
    expect(mock.callsOf('config.resolve').at(-1)?.recipe).toBe('mine')
    act(() => selectComposerRecipe('nowhere'))
    await settle(300)
    expect(el('composer-recipe').textContent).toContain('None')
    expect(mock.callsOf('preflight.run').at(-1)?.recipe).toBeUndefined()
  })
})

describe('applyRecipeToDraft', () => {
  it('chooses the category and fills only groups the user has not set, as suggested values with a reason', () => {
    const draft = {
      ...EMPTY_DRAFT,
      own: { software: { constraints: { choices: [], source: 'user' as const } } },
    }
    const out = applyRecipeToDraft(CONTEXT, draft, BUG_FIX.recipe)
    expect(out.category).toBe('software')
    expect(out.draft.category).toBe('software')
    expect(out.draft.own['software']?.['constraints']).toEqual({ choices: [], source: 'user' })
    expect(out.draft.own['software']?.['projectType']).toEqual({ choices: ['spa'], source: 'suggested' })
    expect(out.draft.reasons['software']?.['projectType']).toBe('From the recipe Bug fix')
    expect(out.applied).toBe(2)
    // A recipe without a brief, or for a pack this folder does not offer, changes nothing.
    expect(applyRecipeToDraft(CONTEXT, EMPTY_DRAFT, MINE.recipe).draft).toBe(EMPTY_DRAFT)
    const elsewhere = { ...BUG_FIX.recipe, brief: { category: 'data', fields: {} } }
    expect(applyRecipeToDraft(CONTEXT, EMPTY_DRAFT, elsewhere).category).toBeNull()
  })
})

describe('Settings > Recipes', () => {
  it('lists the recipes with their layer and what they turn on, the folders and the problems', async () => {
    render(
      <Providers>
        <SettingsPage section="recipes" />
      </Providers>,
    )
    await settle(300)
    const content = el('settings-content')
    const items = within(content)
      .getAllByRole('listitem')
      .filter((li) => li.dataset['layer'] !== undefined)
    expect(
      items.map((li) => [li.dataset['testid'] ?? li.getAttribute('data-testid'), li.dataset['layer']]),
    ).toEqual([
      ['recipe-bug-fix', 'builtin'],
      ['recipe-mine', 'user'],
      ['recipe-team-flow', 'project'],
    ])
    expect(el('recipe-bug-fix-layer').textContent).toBe('Built in')
    expect(el('recipe-mine-layer').textContent).toBe('User')
    expect(el('recipe-team-flow-layer').textContent).toBe('Project')
    expect(el('recipe-bug-fix-summary').textContent).toBe(
      'Turns on Test-first, Acceptance review, Fix until green (2 rounds).',
    )
    expect(el('recipes-user-dir').textContent).toBe('C:\\home\\recipes')
    expect(el('recipes-issues').textContent).toContain('broken.json')
    expect(content.textContent).not.toMatch(/[\u2013\u2014]/)
  })
})
