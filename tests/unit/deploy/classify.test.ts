// The Deploy helper's classification corpus: folders (as signals) and briefs to the deliverable class, with the
// source and confidence it reports. Pure: no files are read.
import { describe, expect, it } from 'vitest'
import type { BriefInput } from '@shared/brief.ts'
import { DEPLOY_CLASSES } from '@shared/deploy.ts'
import type { DeployClass } from '@shared/deploy.ts'
import { classifyDeploy, deployClassList, folderEvidence } from '@core/deploy/classify.ts'
import { emptySignals } from '@core/deploy/signals.ts'
import type { DeploySignals, PackageSignals } from '@core/deploy/signals.ts'

const pkg = (over: Partial<PackageSignals> = {}): PackageSignals => ({
  deps: [],
  scripts: {},
  private: true,
  library: false,
  bin: false,
  ...over,
})

const sig = (over: Partial<DeploySignals> = {}): DeploySignals => ({ ...emptySignals('demo'), ...over })

interface Case {
  name: string
  s: DeploySignals
  cls: DeployClass
  confidence?: 'high' | 'medium' | 'low'
}

const CORPUS: Case[] = [
  {
    name: 'a lone index.html',
    s: sig({ files: ['index.html', 'style.css'], html: true }),
    cls: 'static-site',
    confidence: 'high',
  },
  {
    name: 'a Vite React app',
    s: sig({
      files: ['package.json', 'vite.config.ts'],
      pkg: pkg({ deps: ['react', 'react-dom', 'vite'], scripts: { dev: 'vite' } }),
    }),
    cls: 'spa',
    confidence: 'high',
  },
  {
    name: 'a Vue app without a bundler named',
    s: sig({ files: ['package.json'], pkg: pkg({ deps: ['vue'], scripts: { dev: 'x' } }) }),
    cls: 'spa',
    confidence: 'medium',
  },
  {
    name: 'an Express API',
    s: sig({
      files: ['package.json'],
      pkg: pkg({ deps: ['express'], scripts: { start: 'node server.js' } }),
    }),
    cls: 'server-app',
    confidence: 'high',
  },
  {
    name: 'a Next.js app (it renders on a server)',
    s: sig({
      files: ['package.json'],
      pkg: pkg({ deps: ['next', 'react', 'react-dom'], scripts: { dev: 'next dev' } }),
    }),
    cls: 'server-app',
  },
  {
    name: 'a FastAPI service',
    s: sig({
      files: ['pyproject.toml'],
      python: { deps: ['fastapi', 'uvicorn'], buildSystem: false, scripts: false },
    }),
    cls: 'server-app',
  },
  {
    name: 'a Django project',
    s: sig({
      files: ['manage.py', 'requirements.txt'],
      python: { deps: ['django'], buildSystem: false, scripts: false },
    }),
    cls: 'server-app',
  },
  {
    name: 'a Go service with gin',
    s: sig({ files: ['go.mod', 'main.go'], go: { main: true, deps: ['github.com/gin-gonic/gin'] } }),
    cls: 'server-app',
  },
  {
    name: 'an Axum service',
    s: sig({ files: ['Cargo.toml'], rust: { bin: true, lib: false, deps: ['axum', 'tokio'] } }),
    cls: 'server-app',
  },
  {
    name: 'an Express app with a Dockerfile ships as a container',
    s: sig({ files: ['package.json', 'Dockerfile'], pkg: pkg({ deps: ['express'] }) }),
    cls: 'container',
  },
  {
    name: 'a compose project',
    s: sig({ files: ['docker-compose.yml'] }),
    cls: 'container',
    confidence: 'medium',
  },
  {
    name: 'a Cloudflare Worker',
    s: sig({ files: ['wrangler.toml', 'package.json'], pkg: pkg({ deps: ['hono'] }) }),
    cls: 'serverless',
  },
  { name: 'a Serverless Framework project', s: sig({ files: ['serverless.yml'] }), cls: 'serverless' },
  {
    name: 'Netlify functions',
    s: sig({ files: ['netlify.toml'], dirs: ['netlify'], netlifyFunctions: true }),
    cls: 'serverless',
  },
  {
    name: 'Vercel api/ functions without a server',
    s: sig({ dirs: ['api'], apiFunctions: true }),
    cls: 'serverless',
  },
  {
    name: 'an npm library',
    s: sig({
      files: ['package.json'],
      pkg: pkg({ private: false, library: true, deps: ['typescript'], scripts: { build: 'tsc' } }),
    }),
    cls: 'package',
    confidence: 'high',
  },
  {
    name: 'an npm CLI',
    s: sig({ files: ['package.json'], pkg: pkg({ private: false, bin: true, scripts: { test: 'vitest' } }) }),
    cls: 'package',
  },
  {
    name: 'a React component library is a package, not an app',
    s: sig({
      files: ['package.json'],
      pkg: pkg({ private: false, library: true, deps: ['react', 'vite'], scripts: { build: 'vite build' } }),
    }),
    cls: 'package',
  },
  {
    name: 'a Python package with console scripts',
    s: sig({ files: ['pyproject.toml'], python: { deps: ['click'], buildSystem: true, scripts: true } }),
    cls: 'package',
  },
  {
    name: 'a Rust library crate',
    s: sig({ files: ['Cargo.toml'], rust: { bin: false, lib: true, deps: [] } }),
    cls: 'package',
  },
  {
    name: 'an Electron app',
    s: sig({
      files: ['package.json'],
      pkg: pkg({ deps: ['electron', 'react'], scripts: { start: 'electron .' } }),
    }),
    cls: 'desktop-installer',
  },
  {
    name: 'a Tauri app',
    s: sig({
      files: ['package.json'],
      dirs: ['src-tauri'],
      pkg: pkg({ deps: ['@tauri-apps/api', 'svelte'] }),
    }),
    cls: 'desktop-installer',
  },
  {
    name: 'an Expo app',
    s: sig({ files: ['app.json', 'package.json'], expo: true, pkg: pkg({ deps: ['expo', 'react-native'] }) }),
    cls: 'mobile-app',
  },
  {
    name: 'a Flutter app',
    s: sig({ files: ['pubspec.yaml'], dirs: ['android', 'ios', 'lib'] }),
    cls: 'mobile-app',
  },
  { name: 'an MkDocs site', s: sig({ files: ['mkdocs.yml'], dirs: ['docs'] }), cls: 'docs-site' },
  {
    name: 'a Docusaurus site',
    s: sig({ files: ['package.json'], pkg: pkg({ deps: ['@docusaurus/core', 'react'] }) }),
    cls: 'docs-site',
  },
  {
    name: 'a VitePress site',
    s: sig({ dirs: ['.vitepress'], files: ['package.json'], pkg: pkg({ deps: ['vitepress', 'vue'] }) }),
    cls: 'docs-site',
  },
  { name: 'a Sphinx project', s: sig({ files: ['conf.py', 'index.rst'] }), cls: 'docs-site' },
  {
    name: 'a Gatsby site is static',
    s: sig({ files: ['package.json'], pkg: pkg({ deps: ['gatsby', 'react'] }) }),
    cls: 'static-site',
  },
  {
    name: 'SvelteKit with the static adapter is static',
    s: sig({
      files: ['package.json'],
      pkg: pkg({ deps: ['@sveltejs/kit', '@sveltejs/adapter-static', 'svelte'] }),
    }),
    cls: 'static-site',
  },
]

describe('classifyDeploy: the folder corpus', () => {
  it.each(CORPUS.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const g = classifyDeploy(c.s)
    expect(g.id).toBe(c.cls)
    expect(g.source).toBe('folder')
    if (c.confidence !== undefined) expect(g.confidence).toBe(c.confidence)
    expect(g.reasons.length).toBeGreaterThan(0)
    expect(g.alternatives).not.toContain(c.cls)
  })

  it('names what else the folder shows as alternatives', () => {
    const g = classifyDeploy(sig({ files: ['package.json', 'Dockerfile'], pkg: pkg({ deps: ['express'] }) }))
    expect(g.id).toBe('container')
    expect(g.alternatives).toContain('server-app')
  })

  it('an empty folder is a low-confidence default that says so', () => {
    const g = classifyDeploy(emptySignals())
    expect(g).toMatchObject({ id: 'static-site', source: 'default', confidence: 'low', alternatives: [] })
    expect(g.reasons[0]).toMatch(/Nothing in the folder/)
  })

  it('a single weak sign is low confidence', () => {
    const g = classifyDeploy(sig({ files: ['go.mod', 'main.go'], go: { main: true, deps: [] } }))
    expect(g).toMatchObject({ id: 'server-app', source: 'folder', confidence: 'low' })
  })
})

describe('classifyDeploy: the brief and the task', () => {
  const brief = (category: string, fields: BriefInput['fields']): BriefInput => ({ category, fields })

  it('the brief wins over the folder (the user said what it is)', () => {
    const s = sig({ files: ['package.json'], pkg: pkg({ deps: ['express'] }) })
    const g = classifyDeploy(s, { brief: brief('software', { deliverable: { choices: ['docker-image'] } }) })
    expect(g).toMatchObject({ id: 'container', source: 'brief', confidence: 'high' })
    expect(g.reasons[0]).toMatch(/docker-image/)
  })

  it('reads the strongest group first: deliverable, project type, platform, hosting', () => {
    expect(
      classifyDeploy(emptySignals(), {
        brief: brief('software', {
          projectType: { choices: ['api'] },
          deliverable: { choices: ['package'] },
        }),
      }).id,
    ).toBe('package')
    expect(
      classifyDeploy(emptySignals(), { brief: brief('software', { projectType: { choices: ['spa'] } }) }).id,
    ).toBe('spa')
    expect(
      classifyDeploy(emptySignals(), { brief: brief('software', { platform: { choices: ['ios'] } }) }).id,
    ).toBe('mobile-app')
    expect(
      classifyDeploy(emptySignals(), { brief: brief('software', { hosting: { choices: ['container'] } }) })
        .id,
    ).toBe('container')
  })

  it('the lighter packs map their own groups', () => {
    expect(
      classifyDeploy(emptySignals(), { brief: brief('documents', { format: { choices: ['html-site'] } }) })
        .id,
    ).toBe('docs-site')
    expect(
      classifyDeploy(emptySignals(), { brief: brief('data', { outputs: { choices: ['dashboard'] } }) }).id,
    ).toBe('server-app')
    expect(
      classifyDeploy(emptySignals(), { brief: brief('design', { output: { choices: ['html-css'] } }) }).id,
    ).toBe('static-site')
  })

  it('a brief that says nothing about the deliverable leaves it to the folder', () => {
    const s = sig({ files: ['mkdocs.yml'] })
    expect(
      classifyDeploy(s, { brief: brief('software', { language: { choices: ['python'] } }) }).source,
    ).toBe('folder')
  })

  it('task words are a weak hint, used only when the folder says nothing clear', () => {
    expect(classifyDeploy(emptySignals(), { task: 'Build a landing page for my bakery' })).toMatchObject({
      id: 'static-site',
      source: 'task',
      confidence: 'low',
    })
    expect(classifyDeploy(emptySignals(), { task: 'Dockerize the service' }).id).toBe('container')
    // A clear folder beats the task's words.
    expect(classifyDeploy(sig({ files: ['mkdocs.yml'] }), { task: 'add an API endpoint' }).id).toBe(
      'docs-site',
    )
  })

  it("the user's pick overrides everything, keeping what else the folder shows", () => {
    const s = sig({ files: ['package.json'], pkg: pkg({ deps: ['express'] }) })
    const g = classifyDeploy(
      s,
      { brief: brief('software', { deliverable: { choices: ['package'] } }) },
      'container',
    )
    expect(g).toMatchObject({ id: 'container', source: 'user', confidence: 'high' })
    expect(g.alternatives).toContain('server-app')
  })
})

describe('the class list and evidence', () => {
  it('lists every class with a label', () => {
    expect(deployClassList().map((c) => c.id)).toEqual([...DEPLOY_CLASSES])
    for (const c of deployClassList()) expect(c.label).not.toMatch(/—/)
  })

  it('evidence reasons never carry an em dash', () => {
    for (const c of CORPUS) for (const e of folderEvidence(c.s)) expect(e.reason).not.toMatch(/—/)
  })
})
