// Project templates: the strict schema, every built-in template valid against its pack (each Brief group and option
// exists there), the user layer (a same-id file replaces the built-in, broken files and templates that no longer fit
// their pack are issues), the task text, and the new-project folder rules (new, empty, non-empty, a file, a root, the
// home folder, inside DIM_FACTORY_HOME, inside another repository, a relative path), checked before anything is made.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_PACK_IDS, readBuiltinPacks } from '../../../src/core/packs/load.ts'
import {
  BUILTIN_TEMPLATE_IDS,
  loadTemplates,
  parseTemplateText,
  readBuiltinTemplates,
  templatePackProblem,
} from '../../../src/core/templates/load.ts'
import { folderProblem, prepareProjectFolder } from '../../../src/core/templates/project.ts'
import type { CreateProjectDeps } from '../../../src/core/templates/project.ts'
import { isGuarded } from '../../../src/core/preflight/guard.ts'
import type { GuardResult } from '../../../src/core/preflight/guard.ts'
import type { RepoInfo } from '../../../src/core/git/repo.ts'
import { DimFactoryError } from '../../../src/core/errors.ts'
import {
  SCAFFOLD_EXISTING_NOTE,
  TemplateZ,
  projectTask,
  templateBrief,
} from '../../../src/shared/templates.ts'
import type { Template } from '../../../src/shared/templates.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-templates-'))
  dirs.push(d)
  return d
}

const VALID: Template = {
  id: 'my-app',
  version: 1,
  pack: 'software',
  label: 'My app',
  description: 'A thing.',
  brief: { fields: { projectType: { choices: ['spa'] } } },
  task: 'Scaffold it.',
  recipe: 'new-web-app',
}

/** The recipes the built-in templates may name (the recipe set). */
const RECIPES = [
  'new-web-app',
  'bug-fix',
  'add-feature',
  'refactor-safely',
  'write-docs',
  'data-report',
  'new-game',
]

describe('TemplateZ', () => {
  it('accepts a minimal and a full template', () => {
    expect(TemplateZ.parse(VALID)).toEqual(VALID)
    const full = {
      ...VALID,
      $schema: 'https://example.invalid/template.json',
      create: { command: 'npm create vite@latest .', shell: 'any', note: 'Optional.' },
      tags: ['web', 'react'],
    }
    expect(TemplateZ.parse(full)).toEqual(full)
  })

  it('is strict and checks ids, the version, the command and the Brief fields', () => {
    expect(TemplateZ.safeParse({ ...VALID, extra: 1 }).success).toBe(false)
    expect(TemplateZ.safeParse({ ...VALID, id: 'My App' }).success).toBe(false)
    expect(TemplateZ.safeParse({ ...VALID, version: 2 }).success).toBe(false)
    expect(TemplateZ.safeParse({ ...VALID, recipe: 'New Web App' }).success).toBe(false)
    expect(TemplateZ.safeParse({ ...VALID, task: '  ' }).success).toBe(false)
    expect(TemplateZ.safeParse({ ...VALID, create: { command: 'a\nb' } }).success).toBe(false)
    expect(TemplateZ.safeParse({ ...VALID, create: { command: 'x', shell: 'cmd' } }).success).toBe(false)
    expect(
      TemplateZ.safeParse({ ...VALID, brief: { fields: { projectType: { choices: ['spa'], x: 1 } } } })
        .success,
    ).toBe(false)
    expect(TemplateZ.safeParse({ ...VALID, brief: { category: 'software', fields: {} } }).success).toBe(false)
  })

  it('parseTemplateText wants the file name to match the id', () => {
    expect(parseTemplateText(JSON.stringify(VALID), 'my-app')).toMatchObject({ ok: true })
    expect(parseTemplateText(JSON.stringify(VALID), 'other')).toEqual({
      ok: false,
      message: 'The file name must match the template id ("my-app.json")',
    })
    expect(parseTemplateText('{', 'my-app')).toMatchObject({ ok: false })
  })
})

describe('built-in templates', () => {
  const templates = readBuiltinTemplates()
  const packs = readBuiltinPacks().map((v) => v.pack)

  it('are the listed ones, each with a recipe from the recipe set', () => {
    expect(templates.map((t) => t.id)).toEqual([...BUILTIN_TEMPLATE_IDS])
    for (const t of templates) expect(RECIPES, t.id).toContain(t.recipe)
  })

  it('cover every built-in pack', () => {
    for (const id of BUILTIN_PACK_IDS)
      expect(
        templates.some((t) => t.pack === id),
        id,
      ).toBe(true)
  })

  it('fit their pack: every Brief group and option exists there', () => {
    for (const t of templates) {
      expect(templatePackProblem(t, packs), t.id).toBeNull()
      const pack = packs.find((p) => p.id === t.pack)
      expect(pack, t.id).toBeDefined()
      for (const [groupId, field] of Object.entries(t.brief.fields)) {
        const group = pack?.groups.find((g) => g.id === groupId)
        expect(group, `${t.id}: ${groupId}`).toBeDefined()
        for (const c of field.choices)
          expect(
            group?.options.map((o) => o.id),
            `${t.id}: ${groupId}.${c}`,
          ).toContain(c)
        if (group?.multi === false) expect(field.choices.length, `${t.id}: ${groupId}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('use no em dash in anything the UI or the CLI shows', () => {
    for (const t of templates) {
      const shown = [t.label, t.description, t.task, t.create?.command ?? '', t.create?.note ?? ''].join(' ')
      expect(shown.includes('—'), t.id).toBe(false)
    }
  })

  it('templateBrief marks the fields as the user own; projectTask adds the note and the goal', () => {
    const t = templates.find((x) => x.id === 'vite-react') as Template
    const brief = templateBrief(t)
    expect(brief.category).toBe('software')
    expect(Object.values(brief.fields).every((f) => f.source === 'user')).toBe(true)
    expect(projectTask(t)).toBe(`${t.task}\n\n${SCAFFOLD_EXISTING_NOTE}`)
    expect(projectTask(t, '  A tip calculator ')).toBe(
      `${t.task}\n\n${SCAFFOLD_EXISTING_NOTE}\n\nWhat it should do: A tip calculator`,
    )
  })
})

describe('loadTemplates (the user layer)', () => {
  it('a same-id user file replaces the built-in; a new id is added after the built-ins of its pack', async () => {
    const home = temp()
    mkdirSync(join(home, 'templates'))
    writeFileSync(
      join(home, 'templates', 'nextjs.json'),
      JSON.stringify({ ...VALID, id: 'nextjs', label: 'Ours' }),
    )
    writeFileSync(join(home, 'templates', 'my-app.json'), JSON.stringify(VALID))
    const list = await loadTemplates({ home })
    expect(list.issues).toEqual([])
    const software = list.templates.filter((v) => v.template.pack === 'software').map((v) => v.template.id)
    expect(software).toEqual([
      'vite-react',
      'nextjs',
      'fastapi',
      'static-site',
      'react-site',
      'electron',
      'node-cli',
      'my-app',
    ])
    expect(list.templates.find((v) => v.template.id === 'nextjs')).toMatchObject({
      layer: 'user',
      template: { label: 'Ours' },
    })
    expect(list.packs[0]).toEqual({ id: 'software', label: 'Software' })
  })

  it('reports broken files and templates that do not fit their pack, and keeps the rest', async () => {
    const home = temp()
    mkdirSync(join(home, 'templates'))
    writeFileSync(join(home, 'templates', 'broken.json'), '{ not json')
    writeFileSync(join(home, 'templates', 'misnamed.json'), JSON.stringify(VALID))
    writeFileSync(
      join(home, 'templates', 'bad-option.json'),
      JSON.stringify({
        ...VALID,
        id: 'bad-option',
        brief: { fields: { projectType: { choices: ['spaceship'] } } },
      }),
    )
    writeFileSync(
      join(home, 'templates', 'no-pack.json'),
      JSON.stringify({ ...VALID, id: 'no-pack', pack: 'cooking' }),
    )
    // A user pack that drops an option a built-in template uses: that template is left out, with an issue.
    mkdirSync(join(home, 'packs'))
    const software = readBuiltinPacks().find((v) => v.pack.id === 'software')?.pack
    const trimmed = {
      ...software,
      groups: software?.groups.map((g) =>
        g.id === 'uiFramework' ? { ...g, options: g.options.filter((o) => o.id !== 'react') } : g,
      ),
    }
    writeFileSync(join(home, 'packs', 'software.json'), JSON.stringify(trimmed))
    const list = await loadTemplates({ home })
    const ids = list.templates.map((v) => v.template.id)
    expect(ids).not.toContain('bad-option')
    expect(ids).not.toContain('no-pack')
    expect(ids).not.toContain('vite-react')
    expect(ids).toContain('fastapi')
    const byFile = Object.fromEntries(list.issues.map((i) => [parse(i.file).name, i.message]))
    expect(byFile['broken']).toMatch(/^Not valid JSON/)
    expect(byFile['misnamed']).toBe('The file name must match the template id ("my-app.json")')
    expect(byFile['bad-option']).toContain('has no option "spaceship"')
    expect(byFile['no-pack']).toBe('There is no "cooking" category for this template.')
    expect(byFile['vite-react']).toContain('has no option "react"')
  })
})

describe('new project folder rules', () => {
  const ok: GuardResult = { guarded: false, detail: 'ok', path: '' }

  it('folderProblem: new and empty are fine; a file, a non-empty folder and a folder in a repository are not', () => {
    expect(folderProblem('/p/new', { kind: 'missing' }, ok, null)).toBeNull()
    expect(folderProblem('/p/empty', { kind: 'dir', entries: [] }, ok, null)).toBeNull()
    expect(
      folderProblem('/p/empty', { kind: 'dir', entries: ['.DS_Store', 'Thumbs.db'] }, ok, null),
    ).toBeNull()
    expect(folderProblem('/p/f', { kind: 'file' }, ok, null)).toBe(
      '/p/f is a file. Pick an empty or new folder.',
    )
    expect(folderProblem('/p/full', { kind: 'dir', entries: ['a.txt'] }, ok, null)).toBe(
      '/p/full is not empty. Pick an empty or new folder.',
    )
    expect(folderProblem('/p/full', { kind: 'dir', entries: ['.git'] }, ok, null)).toContain('is not empty')
    expect(folderProblem('/r/app', { kind: 'missing' }, ok, '/r')).toBe(
      '/r/app is inside the git repository at /r. Pick a folder outside it, so the new project gets a repository of its own.',
    )
    const guard = (reason: NonNullable<GuardResult['reason']>): GuardResult => ({
      guarded: true,
      reason,
      detail: 'D.',
      path: '',
    })
    expect(folderProblem('/', { kind: 'dir', entries: ['x'] }, guard('root'), null)).toBe(
      '/ is a drive or volume root. Pick an empty or new folder inside it.',
    )
    expect(folderProblem('/h', { kind: 'dir', entries: [] }, guard('home'), null)).toContain(
      'is your home folder',
    )
    expect(folderProblem('/d/x', { kind: 'missing' }, guard('dimFactoryHome'), null)).toBe(
      "/d/x is inside Dim Factory's own data folder. Pick a folder somewhere else.",
    )
    expect(folderProblem('/usr/x', { kind: 'missing' }, guard('system'), null)).toBe(
      'D. Pick an empty or new folder.',
    )
  })

  /** Real guard (with a fake OS home), no git: detect says "no repository", init writes a .git folder. */
  function deps(home: string, userHome: string, inits: string[]): CreateProjectDeps {
    return {
      home,
      emptyHooksDir: join(home, 'empty-hooks'),
      guard: (f, o) => isGuarded(f, { ...o, home: userHome }),
      detect: (f): Promise<RepoInfo> =>
        Promise.resolve({ folder: f, realFolder: f, isRepo: false, dubiousOwnership: false }),
      init: (f) => {
        inits.push(f)
        mkdirSync(join(f, '.git'))
        return Promise.resolve()
      },
    }
  }

  async function refused(p: Promise<unknown>): Promise<string> {
    try {
      await p
    } catch (err) {
      expect(err).toBeInstanceOf(DimFactoryError)
      expect((err as DimFactoryError).code).toBe('VALIDATION')
      return (err as Error).message
    }
    throw new Error('expected a refusal')
  }

  it('prepareProjectFolder creates a new folder (and its parents) or takes an empty one, then initializes git', async () => {
    const root = temp()
    const inits: string[] = []
    const d = deps(join(root, 'dimf-home'), join(root, 'me'), inits)
    const made = await prepareProjectFolder(join(root, 'work', 'a', 'b'), d)
    expect(made).toBe(join(root, 'work', 'a', 'b'))
    expect(readdirSync(made)).toEqual(['.git'])
    mkdirSync(join(root, 'empty'))
    await prepareProjectFolder(join(root, 'empty'), d)
    expect(inits).toEqual([join(root, 'work', 'a', 'b'), join(root, 'empty')])
  })

  it('refuses a non-empty folder, a root, the home folder, DIM_FACTORY_HOME and a relative path, creating nothing', async () => {
    const root = temp()
    const inits: string[] = []
    const dimHome = join(root, 'dimf-home')
    const userHome = join(root, 'me')
    mkdirSync(userHome)
    const d = deps(dimHome, userHome, inits)
    mkdirSync(join(root, 'full'))
    writeFileSync(join(root, 'full', 'a.txt'), 'x')
    expect(await refused(prepareProjectFolder(join(root, 'full'), d))).toBe(
      `${join(root, 'full')} is not empty. Pick an empty or new folder.`,
    )
    expect(await refused(prepareProjectFolder(join(root, 'full', 'a.txt'), d))).toContain('is a file.')
    expect(await refused(prepareProjectFolder(parse(root).root, d))).toContain('is a drive or volume root')
    expect(await refused(prepareProjectFolder(userHome, d))).toContain('is your home folder')
    expect(await refused(prepareProjectFolder(join(dimHome, 'projects', 'x'), d))).toContain(
      "inside Dim Factory's own data folder",
    )
    expect(existsSync(dimHome)).toBe(false)
    expect(await refused(prepareProjectFolder('relative/x', d))).toBe(
      'Enter the full path of the new project folder.',
    )
    expect(inits).toEqual([])
  })

  it('refuses a folder inside another repository, and removes a folder it made when git init fails', async () => {
    const root = temp()
    const d: CreateProjectDeps = {
      ...deps(join(root, 'h'), join(root, 'me'), []),
      detect: (f) =>
        Promise.resolve({ folder: f, realFolder: f, isRepo: true, toplevel: root, dubiousOwnership: false }),
    }
    expect(await refused(prepareProjectFolder(join(root, 'pkg', 'app'), d))).toContain(
      `is inside the git repository at ${root}`,
    )
    expect(existsSync(join(root, 'pkg'))).toBe(false)

    const failing: CreateProjectDeps = {
      ...deps(join(root, 'h'), join(root, 'me'), []),
      init: () => Promise.reject(new DimFactoryError('GIT', 'git init failed')),
    }
    await expect(prepareProjectFolder(join(root, 'new', 'app'), failing)).rejects.toMatchObject({
      code: 'GIT',
    })
    expect(existsSync(join(root, 'new'))).toBe(false)
  })
})
