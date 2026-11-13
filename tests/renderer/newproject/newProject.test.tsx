// New project: the Dashboard's New project… button opens the dialog; it lists the templates grouped by category
// (templates.list), shows the chosen template's official starter command with a Copy button that keeps its width
// (Copy and Copied both reserved), says why Create is not ready, shows project.create's errors inline, and on success
// hands the folder, the task and the template's Brief to the composer: the folder is chosen, the task filled, the Brief
// panel shows the template's choices (even before core has saved them), Run has the focus, and Run sends them.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BriefContext, Pack } from '@shared/brief.ts'
import type { RecipesList } from '@shared/recipes.ts'
import type { ProjectCreated, TemplatesList } from '@shared/templates.ts'
import { NewProjectDialog } from '@renderer/components/newproject/NewProjectDialog.tsx'
import { COPIED_LABEL, COPY_LABELS } from '@renderer/components/newproject/model.ts'
import { resetNewProjectForTests } from '@renderer/components/newproject/open.ts'
import { actionItems } from '@renderer/components/palette/items.ts'
import type { PaletteContext } from '@renderer/components/palette/items.ts'
import { requestComposer, resetComposerIntentForTests } from '@renderer/components/palette/composerIntent.ts'
import { QuickComposer } from '@renderer/pages/dashboard/QuickComposer.tsx'
import { LAST_FOLDER_KEY } from '@renderer/pages/dashboard/composer-model.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, GENERIC_LENSES, report, runEstimate } from '../composer/fixtures.tsx'

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
        { id: 'spa', label: 'Single-page app' },
        { id: 'api', label: 'API or backend service' },
      ],
    },
    {
      id: 'uiFramework',
      label: 'UI framework',
      multi: false,
      other: false,
      options: [
        { id: 'react', label: 'React' },
        { id: 'vue', label: 'Vue' },
      ],
    },
  ],
}

const TEMPLATES: TemplatesList = {
  packs: [
    { id: 'software', label: 'Software' },
    { id: 'documents', label: 'Documents' },
  ],
  templates: [
    {
      layer: 'builtin',
      template: {
        id: 'vite-react',
        version: 1,
        pack: 'software',
        label: 'Vite + React + TypeScript',
        description: 'A single-page web app.',
        brief: { fields: { projectType: { choices: ['spa'] }, uiFramework: { choices: ['react'] } } },
        task: 'Scaffold a Vite + React + TypeScript app.',
        recipe: 'new-web-app',
        create: { command: 'npm create vite@latest . -- --template react-ts', shell: 'any' },
      },
    },
    {
      layer: 'builtin',
      template: {
        id: 'fastapi',
        version: 1,
        pack: 'software',
        label: 'FastAPI service',
        description: 'A Python web API.',
        brief: { fields: { projectType: { choices: ['api'] } } },
        task: 'Scaffold a FastAPI service.',
        recipe: 'new-web-app',
      },
    },
    {
      layer: 'builtin',
      template: {
        id: 'docs-site',
        version: 1,
        pack: 'documents',
        label: 'Documentation site',
        description: 'Markdown docs.',
        brief: { fields: {} },
        task: 'Set up docs.',
        recipe: 'write-docs',
      },
    },
  ],
  issues: [],
}

const NEW_FOLDER = 'C:\\code\\tips'
const CREATED: ProjectCreated = {
  folder: NEW_FOLDER,
  template: { id: 'vite-react', label: 'Vite + React + TypeScript' },
  brief: {
    category: 'software',
    fields: {
      projectType: { choices: ['spa'], source: 'user' },
      uiFramework: { choices: ['react'], source: 'user' },
    },
  },
  task: 'Scaffold a Vite + React + TypeScript app.\n\nWhat it should do: A tip calculator',
  recipe: 'new-web-app',
  create: { command: 'npm create vite@latest . -- --template react-ts', shell: 'any' },
}

function context(): BriefContext {
  return {
    packs: [{ pack: SOFTWARE, layer: 'builtin', sha256: '0'.repeat(64) }],
    issues: [],
    category: { id: 'software', source: 'default', reason: 'Software is the default' },
    facts: { software: [] },
    keywordFields: {},
    // Core has not said it saved the brief: the composer shows the template's choices all the same.
    saved: null,
    suggest: { vendor: 'claude', model: 'sonnet', tokens: 4200, usd: 0.012 },
    research: GENERIC_LENSES,
  }
}

let mock: MockDimFactory
let createAnswer: () => ProjectCreated
const writeText = vi.fn((_: string) => Promise.resolve())

beforeEach(() => {
  resetComposerIntentForTests()
  resetNewProjectForTests()
  createAnswer = () => CREATED
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'runs.start': () => ({ runId: 'r9', displayNo: 9 }),
      'brief.detect': () => context(),
      'brief.save': () => undefined,
      'templates.list': () => TEMPLATES,
      'project.create': () => createAnswer(),
    },
  })
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  resetComposerIntentForTests()
  resetNewProjectForTests()
  tearDown(mock)
})

async function mountAll(): Promise<void> {
  window.localStorage.setItem(LAST_FOLDER_KEY, 'C:\\code\\old-app')
  render(
    <Providers>
      <QuickComposer />
      <NewProjectDialog />
    </Providers>,
  )
  await settle(300)
}

const el = (id: string): HTMLElement => screen.getByTestId(id)

async function openDialog(): Promise<void> {
  fireEvent.click(el('composer-new-project'))
  await settle()
}

describe('New project dialog', () => {
  it('lists the templates by category and shows the starter command with a Copy button that keeps its width', async () => {
    await mountAll()
    expect(screen.queryByTestId('new-project')).toBeNull()
    await openDialog()
    expect(el('new-project-group-software').textContent).toContain('Vite + React + TypeScript')
    expect(el('new-project-group-software').textContent).toContain('FastAPI service')
    expect(el('new-project-group-documents').textContent).toContain('Documentation site')
    // The first template is chosen; its official command is shown, copyable.
    expect(el('new-project-command').textContent).toBe('npm create vite@latest . -- --template react-ts')
    const copy = el('new-project-copy')
    const reserved = [...copy.querySelectorAll('[data-label]')].map((x) => x.getAttribute('data-label'))
    expect(reserved).toEqual([...COPY_LABELS])
    fireEvent.click(copy)
    await settle()
    expect(writeText).toHaveBeenCalledWith('npm create vite@latest . -- --template react-ts')
    expect(el('new-project-copy').textContent).toContain(COPIED_LABEL)
    // A template without one says so, in the same row.
    const fastapi = el('new-project-template-fastapi').querySelector('input') as HTMLInputElement
    fireEvent.click(fastapi)
    await settle()
    expect(screen.queryByTestId('new-project-command')).toBeNull()
    expect(el('new-project-starter').textContent).toContain('No official starter command')
  })

  it('says why Create is not ready, and shows project.create errors inline', async () => {
    await mountAll()
    await openDialog()
    // The parent folder starts at the last folder's parent.
    expect((el('new-project-parent') as HTMLInputElement).value).toBe('C:\\code')
    expect((el('new-project-create') as HTMLButtonElement).disabled).toBe(true)
    expect(el('new-project-error').textContent).toBe('Name the project')
    fireEvent.change(el('new-project-name'), { target: { value: 'a/b' } })
    await settle()
    expect(el('new-project-error').textContent).toBe('The name is one folder name, without slashes')
    fireEvent.change(el('new-project-name'), { target: { value: 'tips' } })
    await settle()
    expect(el('new-project-path').textContent).toBe(`Creates ${NEW_FOLDER}`)
    createAnswer = () => {
      throw mockError('VALIDATION', `${NEW_FOLDER} is not empty. Pick an empty or new folder.`)
    }
    fireEvent.click(el('new-project-create'))
    await settle()
    expect(el('new-project-error').textContent).toBe(
      `${NEW_FOLDER} is not empty. Pick an empty or new folder.`,
    )
    expect(el('new-project-error').getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('new-project')).toBeTruthy()
  })

  it('creates the project and hands the folder, the task and the Brief to the composer, focusing Run', async () => {
    await mountAll()
    await openDialog()
    fireEvent.change(el('new-project-name'), { target: { value: 'tips' } })
    fireEvent.change(el('new-project-goal'), { target: { value: 'A tip calculator' } })
    await settle()
    fireEvent.click(el('new-project-create'))
    await settle(300)
    expect(mock.callsOf('project.create')).toEqual([
      { folder: NEW_FOLDER, templateId: 'vite-react', goal: 'A tip calculator' },
    ])
    expect(screen.queryByTestId('new-project')).toBeNull()
    expect((el('composer-folder-input') as HTMLInputElement).value).toBe(NEW_FOLDER)
    expect((el('composer-task') as HTMLTextAreaElement).value).toBe(CREATED.task)
    expect(document.activeElement).toBe(el('composer-run'))
    // The Brief panel shows the template's choices.
    fireEvent.click(el('brief-toggle'))
    await settle()
    expect(
      el('brief-option-projectType-spa').getAttribute('aria-pressed') ??
        el('brief-option-projectType-spa').getAttribute('aria-checked'),
    ).toBe('true')
    expect(
      el('brief-option-uiFramework-react').getAttribute('aria-pressed') ??
        el('brief-option-uiFramework-react').getAttribute('aria-checked'),
    ).toBe('true')
    // Run sends them.
    await act(async () => {
      fireEvent.click(el('composer-run'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('runs.start')).toEqual([
      { folder: NEW_FOLDER, task: CREATED.task, brief: CREATED.brief },
    ])
  })
})

describe('the palette', () => {
  it('New project opens the dialog', async () => {
    await mountAll()
    const item = actionItems({
      route: { name: 'dashboard' },
      summaries: [],
      attention: [],
      probes: [],
      folders: [],
      theme: { theme: 'system', accent: 'slate', resolved: 'light' },
    } as unknown as PaletteContext).find((i) => i.id === 'action:new-project')
    expect(item?.label).toBe('New project')
    act(() => item?.run())
    await settle()
    expect(el('new-project-group-software')).toBeTruthy()
  })
})

describe('composer intent with a task, a Brief and a recipe', () => {
  it('made before the composer mounts: the folder, the task and the Brief are applied and Run has the focus', async () => {
    requestComposer({ folder: NEW_FOLDER, task: CREATED.task, brief: CREATED.brief, recipe: 'new-web-app' })
    window.localStorage.setItem(LAST_FOLDER_KEY, 'C:\\code\\old-app')
    render(
      <Providers>
        <QuickComposer />
      </Providers>,
    )
    await settle(300)
    expect((el('composer-folder-input') as HTMLInputElement).value).toBe(NEW_FOLDER)
    expect((el('composer-task') as HTMLTextAreaElement).value).toBe(CREATED.task)
    expect(document.activeElement).toBe(el('composer-run'))
    expect(el('brief-summary').textContent).toContain('2 choices')
    // The template's Brief is kept for the folder like a user's change.
    expect(mock.callsOf('brief.save')).toEqual([{ folder: NEW_FOLDER, brief: CREATED.brief }])
  })

  it("chooses the template's recipe, which adds nothing to the template's Brief; Run sends both", async () => {
    // A FastAPI-like template: its Brief says API; the recipe's own brief defaults (a single-page React app) must not
    // be added to it.
    const brief = {
      category: 'software',
      fields: { projectType: { choices: ['api'], source: 'user' as const } },
    }
    const recipes: RecipesList = {
      recipes: [
        {
          layer: 'builtin',
          path: 'builtin/new-web-app.json',
          sha256: '1'.repeat(64),
          recipe: {
            id: 'new-web-app',
            version: 1,
            label: 'New web app',
            description: 'Start a web app.',
            toggles: { explain: true },
            brief: {
              category: 'software',
              fields: { projectType: { choices: ['spa'] }, uiFramework: { choices: ['react'] } },
            },
          },
        },
      ],
      issues: [],
      dirs: { user: 'C:\\home\\recipes', project: `${NEW_FOLDER}\\.dimfactory\\recipes` },
    }
    mock.on('recipes.list', () => recipes)
    // The composer already shows the folder (its Brief context is in), so the template's Brief is applied at once and
    // the recipe's defaults would land on top of it unless they are left out.
    window.localStorage.setItem(LAST_FOLDER_KEY, NEW_FOLDER)
    render(
      <Providers>
        <QuickComposer />
      </Providers>,
    )
    await settle(300)
    act(() =>
      requestComposer({
        folder: NEW_FOLDER,
        task: 'Scaffold a FastAPI service.',
        brief,
        recipe: 'new-web-app',
      }),
    )
    await settle(300)
    expect(el('composer-recipe').textContent).toContain('New web app')
    await act(async () => {
      fireEvent.click(el('composer-run'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('runs.start')).toEqual([
      { folder: NEW_FOLDER, task: 'Scaffold a FastAPI service.', brief, recipe: 'new-web-app' },
    ])
  })

  it('a folder-only intent still focuses the task box (New run, Folders)', async () => {
    window.localStorage.setItem(LAST_FOLDER_KEY, 'C:\\code\\old-app')
    render(
      <Providers>
        <QuickComposer />
      </Providers>,
    )
    await settle(300)
    act(() => requestComposer({ folder: NEW_FOLDER }))
    await settle(300)
    expect(document.activeElement).toBe(el('composer-task'))
    expect((el('composer-task') as HTMLTextAreaElement).value).toBe('')
  })
})
