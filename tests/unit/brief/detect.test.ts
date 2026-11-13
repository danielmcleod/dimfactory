import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BriefFact, Pack } from '@shared/brief.ts'
import { detectCategory, keywordFields, scanFolder } from '@core/brief/detect.ts'
import type { FolderScan } from '@core/brief/detect.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'

const packs: Pack[] = readBuiltinPacks().map((v) => v.pack)
const software = packs.find((p) => p.id === 'software') as Pack

let root: string
let n = 0
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-detect-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A temp folder holding these files (paths relative, `/` separated; a trailing `/` makes a directory). */
function folderWith(files: Record<string, string | object>): string {
  const dir = join(root, `f${n++}`)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, ...rel.split('/'))
    if (rel.endsWith('/')) {
      mkdirSync(path, { recursive: true })
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return dir
}

const pick = (f: BriefFact): string => `${f.group}:${f.option ?? '-'}:${f.label}`
async function scan(files: Record<string, string | object>): Promise<{ s: FolderScan; sw: string[] }> {
  const s = await scanFolder(folderWith(files), packs)
  return { s, sw: (s.facts['software'] ?? []).map(pick) }
}

describe('scanFolder: the ecosystem corpus', () => {
  it('node + react + vite + tailwind + vitest + pnpm', async () => {
    const { s, sw } = await scan({
      'package.json': {
        name: 'app',
        scripts: { dev: 'vite', build: 'vite build', test: 'vitest', lint: 'eslint .' },
        dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' },
        devDependencies: { typescript: '~5.8.0', vite: '^6.0.0', tailwindcss: '^4.0.0', vitest: '^3.0.0' },
      },
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'tsconfig.json': '{}',
      'vite.config.ts': 'export default {}',
      'index.html': '<!doctype html>',
      'src/': '',
      'README.md': '# App',
    })
    expect(sw).toEqual([
      'language:typescript:TypeScript',
      'uiFramework:react:React 19',
      'styling:tailwind:Tailwind CSS',
      'packageManager:-:pnpm',
      'testRunner:-:Vitest',
      'scripts:-:Scripts: dev, build, test, lint',
    ])
    expect(s.facts['software']?.[0]?.evidence).toBe('tsconfig.json')
    expect(detectCategory('', s, packs)).toMatchObject({ id: 'software', source: 'folder' })
    expect(detectCategory('', s, packs).reason).toMatch(/^This folder has /)
  })

  it('next.js + prisma postgres + Clerk + vercel.json', async () => {
    const { sw } = await scan({
      'package.json': {
        dependencies: { next: '15.2.0', react: '19.0.0', '@prisma/client': '^6', '@clerk/nextjs': '^6' },
        devDependencies: { prisma: '^6', typescript: '^5' },
      },
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      'vercel.json': '{}',
      'package-lock.json': '{}',
    })
    expect(sw).toEqual([
      'language:typescript:TypeScript',
      'uiFramework:react:React 19',
      'backend:nextjs:Next.js 15',
      'data:postgres:PostgreSQL (Prisma)',
      'auth:hosted-auth:Clerk',
      'hosting:vercel-netlify:Vercel',
      'packageManager:-:npm',
    ])
  })

  it('python fastapi + pytest (pyproject, uv)', async () => {
    const { sw } = await scan({
      'pyproject.toml':
        '[project]\nname = "svc"\ndependencies = [\n  "fastapi>=0.110",\n  "asyncpg",\n]\n\n[dependency-groups]\ndev = ["pytest>=8"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
      'uv.lock': '',
    })
    expect(sw).toEqual([
      'language:python:Python',
      'backend:python-web:FastAPI',
      'data:postgres:PostgreSQL',
      'testRunner:-:pytest',
      'packageManager:-:uv',
    ])
  })

  it('django from requirements.txt', async () => {
    const { s, sw } = await scan({
      'requirements.txt': 'Django==5.1\npsycopg2-binary==2.9\n# flask is not here\n',
      'manage.py': '',
    })
    expect(sw).toEqual([
      'language:python:Python',
      'backend:python-web:Django',
      'data:postgres:PostgreSQL',
      'packageManager:-:pip',
    ])
    expect(s.facts['software']?.find((f) => f.group === 'backend')?.evidence).toBe('requirements.txt: django')
  })

  it('go module with gin', async () => {
    const { sw } = await scan({
      'go.mod': 'module example.com/svc\n\ngo 1.23\n\nrequire github.com/gin-gonic/gin v1.10.0\n',
      'main.go': 'package main',
    })
    expect(sw).toEqual([
      'language:go:Go',
      'backend:go:Gin',
      'packageManager:-:Go modules',
      'testRunner:-:go test',
    ])
  })

  it('rust cargo', async () => {
    const { sw } = await scan({ 'Cargo.toml': '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n' })
    expect(sw).toEqual(['language:rust:Rust', 'packageManager:-:Cargo', 'testRunner:-:cargo test'])
  })

  it('.NET web csproj with xUnit', async () => {
    const { sw } = await scan({
      'Api.csproj':
        '<Project Sdk="Microsoft.NET.Sdk.Web">\n<ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>\n</Project>',
      'Api.sln': 'Project("{X}") = "Api", "Api.csproj", "{Y}"',
    })
    expect(sw).toEqual(['language:csharp:C#', 'backend:dotnet:ASP.NET Core', 'testRunner:-:xUnit'])
  })

  it('java maven with junit', async () => {
    const { sw } = await scan({
      'pom.xml':
        '<project><dependencies><dependency><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>',
    })
    expect(sw).toEqual(['language:java-kotlin:Java', 'packageManager:-:Maven', 'testRunner:-:JUnit'])
  })

  it('electron app', async () => {
    const { sw } = await scan({
      'package.json': { devDependencies: { electron: '^38.0.0' }, dependencies: { react: '^19' } },
    })
    expect(sw).toContain('projectType:desktop:Electron app')
    expect(sw).toContain('language:javascript:JavaScript')
  })

  it('browser extension, manifest v3', async () => {
    const { sw } = await scan({
      'manifest.json': { manifest_version: 3, name: 'X', version: '1' },
      'popup.html': '',
      'popup.js': '',
    })
    expect(sw).toEqual(['projectType:browser-extension:Browser extension (Manifest V3)'])
  })

  it('a static site: index.html only', async () => {
    const { s, sw } = await scan({ 'index.html': '<!doctype html>', 'style.css': '' })
    expect(sw).toEqual(['projectType:static-site:Static site'])
    expect(detectCategory('', s, packs).id).toBe('software')
  })

  it('a Dockerfile with fly.toml: Fly hosting, a Docker image deliverable', async () => {
    const { sw } = await scan({ Dockerfile: 'FROM node:24', 'fly.toml': 'app = "x"' })
    expect(sw).toEqual(['deliverable:docker-image:Docker image', 'hosting:render-fly:Fly.io'])
  })

  it('docker compose alone: container hosting', async () => {
    const { sw } = await scan({ Dockerfile: 'FROM node:24', 'compose.yaml': 'services: {}' })
    expect(sw).toEqual(['deliverable:docker-image:Docker image', 'hosting:container:Docker Compose'])
  })

  it('netlify.toml and vercel.json', async () => {
    expect((await scan({ 'netlify.toml': '' })).sw).toEqual(['hosting:vercel-netlify:Netlify'])
    expect((await scan({ 'vercel.json': '{}' })).sw).toEqual(['hosting:vercel-netlify:Vercel'])
  })

  it('an empty folder: no facts, the default category', async () => {
    const { s } = await scan({})
    expect(Object.values(s.facts).flat()).toEqual([])
    expect(s.files).toEqual([])
    expect(detectCategory('', s, packs)).toEqual({
      id: 'software',
      source: 'default',
      reason: 'Nothing points elsewhere',
    })
  })

  it('a docs folder with mkdocs.yml', async () => {
    const { s, sw } = await scan({
      'mkdocs.yml': 'site_name: X',
      'docs/index.md': '# Hi',
      'README.md': '# X',
    })
    expect(sw).toEqual([])
    expect(s.facts['documents']?.map(pick)).toEqual(['format:html-site:MkDocs site'])
    expect(detectCategory('', s, packs)).toMatchObject({ id: 'documents', source: 'folder' })
  })

  it('a data folder with csv and notebooks', async () => {
    const { s } = await scan({ 'sales.csv': 'a,b', 'costs.csv': 'a,b', 'analysis.ipynb': '{}' })
    expect(s.facts['data']?.map(pick)).toEqual(['sources:csv:2 CSV files', 'notebooks:-:1 notebook'])
    expect(s.facts['data']?.[0]?.evidence).toBe('costs.csv, sales.csv')
    expect(detectCategory('', s, packs)).toMatchObject({ id: 'data', source: 'folder' })
  })

  it('terraform files: an operations fact', async () => {
    const { s } = await scan({ 'main.tf': '', 'variables.tf': '' })
    expect(s.facts['operations']?.map(pick)).toEqual(['tooling:terraform:Terraform'])
    expect(detectCategory('', s, packs).id).toBe('operations')
  })

  it('GitHub workflows and a bin field', async () => {
    const { sw } = await scan({
      'package.json': { bin: { x: 'cli.js' } },
      '.github/workflows/ci.yml': 'on: push',
    })
    expect(sw).toContain('projectType:cli:CLI')
    expect(sw).toContain('ci:-:GitHub Actions')
  })

  it('only returns facts for packs present, and drops options a pack lacks', async () => {
    const dir = folderWith({ 'package.json': { dependencies: { react: '18.3.1' } } })
    const trimmed: Pack = {
      ...software,
      groups: software.groups
        .filter((g) => g.id !== 'language')
        .map((g) =>
          g.id === 'uiFramework' ? { ...g, options: g.options.filter((o) => o.id !== 'react') } : g,
        ),
    }
    const s = await scanFolder(dir, [trimmed])
    expect(Object.keys(s.facts)).toEqual(['software'])
    const facts = s.facts['software'] ?? []
    expect(facts.find((f) => f.group === 'uiFramework')).toEqual({
      group: 'uiFramework',
      label: 'React 18',
      evidence: 'package.json: react',
    })
    expect(facts.find((f) => f.group === 'language')?.option).toBeUndefined()
  })

  it('an unreadable or missing folder gives no facts and does not throw', async () => {
    const s = await scanFolder(join(root, 'does-not-exist'), packs)
    expect(s.files).toEqual([])
    expect(Object.values(s.facts).flat()).toEqual([])
    const file = folderWith({ 'a.txt': '' })
    const s2 = await scanFolder(join(file, 'a.txt'), packs)
    expect(Object.values(s2.facts).flat()).toEqual([])
  })

  it('a broken package.json is ignored', async () => {
    const { sw } = await scan({ 'package.json': '{ nope', 'tsconfig.json': '{}' })
    expect(sw).toEqual(['language:typescript:TypeScript'])
  })

  it('is deterministic', async () => {
    const files = {
      'package.json': {
        dependencies: { vue: '^3.5.0', express: '^5', mongoose: '^8' },
        devDependencies: { jest: '1' },
      },
      'yarn.lock': '',
      'render.yaml': '',
    }
    const a = await scanFolder(folderWith(files), packs)
    const b = await scanFolder(folderWith(files), packs)
    expect(b).toEqual(a)
    expect((a.facts['software'] ?? []).map(pick)).toEqual([
      'language:javascript:JavaScript',
      'uiFramework:vue:Vue 3',
      'backend:node:Express 5',
      'data:mongodb:MongoDB',
      'hosting:render-fly:Render',
      'packageManager:-:Yarn',
      'testRunner:-:Jest',
    ])
  })
})

describe('detectCategory', () => {
  let swScan: FolderScan
  beforeAll(async () => {
    swScan = await scanFolder(
      folderWith({
        'package.json': { dependencies: { react: '^19' } },
        'tsconfig.json': '{}',
        'README.md': '',
      }),
      packs,
    )
  })

  it('the task beats the folder when it clearly asks for docs', () => {
    expect(detectCategory('Write a README for this project', swScan, packs)).toEqual({
      id: 'documents',
      source: 'task',
      reason: 'Your task mentions "readme"',
    })
  })

  it('a software task in a software folder stays software', () => {
    expect(detectCategory('add a login page', swScan, packs)).toMatchObject({
      id: 'software',
      source: 'task',
    })
  })

  it('a task naming a report and charts goes to data', () => {
    const g = detectCategory('Make a report with charts of monthly sales from the CSV', swScan, packs)
    expect(g.id).toBe('data')
    expect(g.source).toBe('task')
    expect(g.reason).toMatch(/^Your task mentions "/)
  })

  it('research and design tasks', () => {
    expect(detectCategory('Research and compare vector databases, pros and cons', null, packs).id).toBe(
      'research-writing',
    )
    expect(detectCategory('Create a wireframe and mockups for the onboarding flow', null, packs).id).toBe(
      'design',
    )
    expect(detectCategory('Write a runbook for restoring backups', null, packs).id).toBe('operations')
  })

  it('a tie in the task goes to the folder, then to the default', () => {
    expect(detectCategory('update the readme for the api', swScan, packs)).toMatchObject({
      id: 'software',
      source: 'folder',
    })
    expect(detectCategory('update the readme for the api', null, packs)).toMatchObject({
      id: 'software',
      source: 'default',
    })
  })

  it('nothing at all: the default', () => {
    expect(detectCategory('hello there', null, packs)).toEqual({
      id: 'software',
      source: 'default',
      reason: 'Nothing points elsewhere',
    })
  })

  it('without a software pack the default is the first pack', () => {
    const rest = packs.filter((p) => p.id !== 'software')
    expect(detectCategory('', null, rest)).toMatchObject({ id: 'documents', source: 'default' })
    expect(detectCategory('', null, [])).toMatchObject({ id: 'software', source: 'default' })
  })

  it('is deterministic', () => {
    const t = 'Analyze the data and write a short report'
    expect(detectCategory(t, swScan, packs)).toEqual(detectCategory(t, swScan, packs))
  })
})

describe('keywordFields', () => {
  it('fills groups the task names, with source keyword', () => {
    const f = keywordFields(
      'Build a React dashboard in TypeScript with Tailwind and Postgres, deploy to Vercel',
      software,
      [],
    )
    expect(f['uiFramework']).toEqual({ choices: ['react'], source: 'keyword' })
    expect(f['language']).toEqual({ choices: ['typescript'], source: 'keyword' })
    expect(f['styling']).toEqual({ choices: ['tailwind'], source: 'keyword' })
    expect(f['data']).toEqual({ choices: ['postgres'], source: 'keyword' })
    expect(f['hosting']).toEqual({ choices: ['vercel-netlify'], source: 'keyword' })
  })

  it('multi-choice groups take every match, in option order', () => {
    const f = keywordFields('A python and typescript monorepo, accessibility and dark mode', software, [])
    expect(f['language']?.choices).toEqual(['typescript', 'python'])
    expect(f['quality']?.choices).toEqual(['accessible', 'dark-mode'])
  })

  it('does not read the English word "go" as the language', () => {
    expect(
      keywordFields("Let's go ahead and add a settings page; good to go", software, [])['language'],
    ).toBeUndefined()
    expect(keywordFields('Write a small service in Go', software, [])['language']?.choices).toEqual(['go'])
    expect(keywordFields('a golang worker', software, [])['language']?.choices).toEqual(['go'])
  })

  it('a single-choice group with two different matches gets nothing', () => {
    const f = keywordFields('Port the React app to Vue', software, [])
    expect(f['uiFramework']).toBeUndefined()
  })

  it('a longer phrase wins over a shorter one inside it', () => {
    const f = keywordFields('Deploy with docker compose', software, [])
    expect(f['hosting']).toEqual({ choices: ['container'], source: 'keyword' })
  })

  it('never fills the approach group', () => {
    const f = keywordFields('Use test-first, walking skeleton, milestones and contract first', software, [])
    expect(f['approach']).toBeUndefined()
  })

  it('never fills a group a locked fact covers', () => {
    const locked: BriefFact[] = [
      { group: 'uiFramework', option: 'vue', label: 'Vue 3', evidence: 'package.json: vue' },
    ]
    const f = keywordFields('Add a React widget in TypeScript', software, locked)
    expect(f['uiFramework']).toBeUndefined()
    expect(f['language']?.choices).toEqual(['typescript'])
  })

  it('is case-insensitive, whole-word and deterministic', () => {
    expect(keywordFields('REACTIVE forms', software, [])['uiFramework']).toBeUndefined()
    expect(keywordFields('a SQLITE cache', software, [])['data']?.choices).toEqual(['sqlite'])
    const t = 'Next.js app with Supabase auth and OAuth'
    expect(keywordFields(t, software, [])).toEqual(keywordFields(t, software, []))
  })

  it('works for the lighter packs', () => {
    const docs = packs.find((p) => p.id === 'documents') as Pack
    const f = keywordFields('A formal one-pager for executives as a PDF', docs, [])
    expect(f['tone']?.choices).toEqual(['formal'])
    expect(f['length']?.choices).toEqual(['short'])
    expect(f['audience']?.choices).toEqual(['executives'])
    expect(f['format']?.choices).toEqual(['pdf'])
  })
})
