// Easy mode's idea resolver: idea to kind (Easy's words, then the Brief's detection, else an app), kind to template
// (one that needs nothing installed unless the idea asks for a toolchain that is there, else the no-toolchain one with
// the reason), the folder name from the idea and a free folder beside existing ones, the run's task, and the kind to
// recipe and pack tables against the built-in templates and recipes.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { BUILTIN_TEMPLATE_IDS, readBuiltinTemplates } from '@core/templates/load.ts'
import {
  KIND_TEMPLATE,
  changeTask,
  chooseTemplate,
  continueTask,
  detectKind,
  easyTask,
  freeFolder,
  slugOf,
} from '@core/easy/resolve.ts'
import { BUILTIN_RECIPE_IDS } from '@shared/recipes.ts'
import {
  EASY_KINDS,
  EASY_KIND_PACK,
  EASY_KIND_RECIPE,
  EASY_CHANGE_RECIPE,
  EASY_SLUG_MAX,
} from '@shared/easy.ts'
import type { EasyKind } from '@shared/easy.ts'
import { SCAFFOLD_EXISTING_NOTE } from '@shared/templates.ts'
import { EXAMPLES } from '@renderer/pages/easy/text.ts'

const packs = readBuiltinPacks().map((v) => v.pack)
const NONE = { node: false, python: false }
const BOTH = { node: true, python: true }

describe('detectKind', () => {
  it('reads every gallery example as its own kind', () => {
    for (const ex of EXAMPLES)
      expect(detectKind(ex.text, packs), ex.text).toEqual({ kind: ex.kind, source: 'words' })
  })

  it.each([
    ['A tip splitter my friends can open on their phones', 'app'],
    ['A help site for my knitting shop', 'document'],
    ['A 10-page grant report', 'document'],
    ['A report from this sales CSV with monthly trends', 'data'],
    ['A landing page for my bakery with a sign-up form', 'website'],
    ['Which CRM should my team use?', 'research'],
    ['A checklist for closing the shop at night', 'checklist'],
    ['A portfolio for my photos', 'website'],
    ['A quiz about birds for my class', 'game'],
    ['A snake game I can play on my phone', 'game'],
  ] as const)('%s → %s', (idea, kind) => {
    expect(detectKind(idea, packs).kind).toBe(kind)
  })

  it("falls back to the Brief's category detection, then to an app as a guess", () => {
    // No Easy word, but the data pack's keyword "kpi" decides it.
    expect(detectKind('Weekly KPI numbers for the team', packs)).toEqual({ kind: 'data', source: 'words' })
    expect(detectKind('Something lovely', packs)).toEqual({ kind: 'app', source: 'default' })
  })

  it('matches whole words only', () => {
    // "apple" is not "app"; "site" inside "website" counts once as a website.
    expect(detectKind('Apples and pears', packs).source).toBe('default')
  })
})

describe('chooseTemplate', () => {
  it('maps each kind to a template that needs nothing installed', () => {
    for (const k of EASY_KINDS)
      expect(chooseTemplate(k, 'something', NONE)).toEqual({ templateId: KIND_TEMPLATE[k] })
    expect(chooseTemplate('website', 'A landing page for my bakery', NONE)).toEqual({
      templateId: 'landing-page',
    })
    expect(chooseTemplate('website', 'A website with a sign-up form', NONE).templateId).toBe('landing-page')
    expect(chooseTemplate('website', 'A website with three pages', NONE).templateId).toBe('static-site')
  })

  it('uses a toolchain template only when the idea asks for it and the toolchain is there', () => {
    // A website or app is React whenever Node.js is ready (beginners-a.test.ts has the rest).
    expect(chooseTemplate('app', 'A React app for my notes', BOTH)).toEqual({ templateId: 'react-site' })
    expect(chooseTemplate('document', 'A VitePress docs site', BOTH)).toEqual({ templateId: 'docs-site' })
    expect(chooseTemplate('data', 'A pandas report from my CSV', BOTH)).toEqual({ templateId: 'data-report' })
    // Asked for, but not installed: the no-toolchain template, and why.
    expect(chooseTemplate('app', 'A React app for my notes', NONE)).toEqual({
      templateId: 'static-site',
      fallback: { wanted: 'react-site', needs: 'node' },
    })
    expect(chooseTemplate('data', 'A pandas report', { node: true, python: false })).toEqual({
      templateId: 'data-report-web',
      fallback: { wanted: 'data-report', needs: 'python' },
    })
    expect(chooseTemplate('document', 'A docs site', { node: false, python: true })).toEqual({
      templateId: 'docs-simple',
      fallback: { wanted: 'docs-site', needs: 'node' },
    })
    // Installed but not asked for: still the no-toolchain one, except a website or app (React by default).
    expect(chooseTemplate('document', 'A guide to my shop', BOTH)).toEqual({ templateId: 'docs-simple' })
    expect(chooseTemplate('app', 'A tip splitter', BOTH)).toEqual({ templateId: 'react-site' })
    expect(chooseTemplate('app', 'A tip splitter', BOTH, 'html')).toEqual({ templateId: 'static-site' })
  })

  it('names only built-in templates, each in the pack of its kind (a website may start from a software page)', () => {
    const templates = readBuiltinTemplates()
    for (const k of EASY_KINDS) {
      const t = templates.find((x) => x.id === KIND_TEMPLATE[k])
      expect(t, k).toBeDefined()
      if (k !== 'website') expect(t?.pack, k).toBe(EASY_KIND_PACK[k])
    }
    expect(BUILTIN_TEMPLATE_IDS).toContain('docs-simple')
    expect(BUILTIN_TEMPLATE_IDS).toContain('data-report-web')
  })

  it('every kind runs with a built-in Easy recipe, and changes with easy-change', () => {
    for (const k of EASY_KINDS) expect(BUILTIN_RECIPE_IDS, k).toContain(EASY_KIND_RECIPE[k])
    expect(BUILTIN_RECIPE_IDS).toContain(EASY_CHANGE_RECIPE)
    // Every pack an Easy kind uses is a built-in pack.
    for (const k of EASY_KINDS)
      expect(
        packs.map((p) => p.id),
        k,
      ).toContain(EASY_KIND_PACK[k])
  })
})

describe('the folder', () => {
  it.each([
    ['A landing page for my bakery with a sign-up form', 'landing-page-bakery'],
    ['A tip splitter my friends can open on their phones', 'tip-splitter-friends'],
    ['  Café menu  ', 'cafe-menu'],
    ['¿¡!?', 'my-project'],
    ['A con', 'con-project'],
  ])('slugOf(%j) = %s', (idea, slug) => {
    expect(slugOf(idea)).toBe(slug)
  })

  it('keeps folder names short and safe', () => {
    const long = slugOf('Supercalifragilisticexpialidocious extraordinarily-long name')
    expect(long.length).toBeLessThanOrEqual(EASY_SLUG_MAX)
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('freeFolder takes the name, then -2, -3 beside folders that exist', () => {
    const dir = join('C:', 'Projects')
    const taken = new Set([join(dir, 'bakery'), join(dir, 'bakery-2')])
    expect(freeFolder(dir, 'bakery', (p) => taken.has(p))).toEqual({
      folder: join(dir, 'bakery-3'),
      name: 'bakery-3',
    })
    expect(freeFolder(dir, 'cafe', (p) => taken.has(p))).toEqual({ folder: join(dir, 'cafe'), name: 'cafe' })
  })
})

describe('the tasks', () => {
  it("puts the idea first, then the template's outline, then the scaffold note", () => {
    const t = readBuiltinTemplates().find((x) => x.id === 'static-site')
    if (t === undefined) throw new Error('static-site')
    const task = easyTask(t, '  A tip splitter  ')
    expect(task.startsWith('A tip splitter\n\n')).toBe(true)
    expect(task).toContain(t.task)
    expect(task.endsWith(SCAFFOLD_EXISTING_NOTE)).toBe(true)
    expect(task.indexOf('A tip splitter')).toBeLessThan(task.indexOf(t.task))
  })

  it('a change keeps the rest working; carrying on builds on what is there', () => {
    expect(changeTask(' Bigger buttons ')).toMatch(/^Bigger buttons\n\n.*keep everything else working/s)
    expect(continueTask('Make a quiz')).toMatch(/stopped before it was finished.*Make a quiz$/s)
  })

  it('names no kind twice and covers every kind', () => {
    const kinds: EasyKind[] = [...EASY_KINDS]
    expect(new Set(kinds).size).toBe(7)
  })
})
