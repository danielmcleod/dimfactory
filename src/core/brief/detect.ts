// The Brief's local detection, with no model calls: what a folder already says (its manifests, lockfiles and config
// files at the root), which category a task most likely belongs to, and which options the task text names outright.
// Reads a bounded, fixed set of files; never runs anything, spawns nothing and never touches the network.
import type { Dirent } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { APPROACH_GROUP, DEFAULT_CATEGORY } from '../../shared/brief.ts'
import type { BriefCategoryGuess, BriefFact, BriefField, Pack } from '../../shared/brief.ts'

/** What a folder says: locked and informational facts per pack id, and the root entry names seen. */
export interface FolderScan {
  facts: Record<string, BriefFact[]>
  files: string[]
}

/** One file read is capped here; a longer file is read up to the cap (a cut JSON file then simply fails to parse). */
export const SCAN_FILE_MAX_BYTES = 512 * 1024

// ---- reading ------------------------------------------------------------------------------------------------------

async function readCapped(path: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(SCAN_FILE_MAX_BYTES)
    const { bytesRead } = await fh.read(buf, 0, SCAN_FILE_MAX_BYTES, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>))
    if (typeof val === 'string') out[k] = val
  return out
}

/** "React 19" when the range names a plain major version, else just "React". */
function withMajor(name: string, range: string | undefined): string {
  const m = range === undefined ? null : /^[\^~>=v\s]*(\d+)(?:\.|$|\s)/.exec(range)
  return m?.[1] !== undefined ? `${name} ${m[1]}` : name
}

// ---- facts ---------------------------------------------------------------------------------------------------------

interface RawFact {
  pack: string
  group: string
  option?: string
  label: string
  evidence: string
}

class FactSink {
  readonly raw: RawFact[] = []
  add(pack: string, group: string, option: string | undefined, label: string, evidence: string): void {
    const same = this.raw.find((f) => f.pack === pack && f.group === group && f.option === option)
    if (same !== undefined) {
      if (!same.evidence.split(', ').includes(evidence)) same.evidence = `${same.evidence}, ${evidence}`
      return
    }
    this.raw.push(
      option === undefined ? { pack, group, label, evidence } : { pack, group, option, label, evidence },
    )
  }
  has(pack: string, group: string, option?: string): boolean {
    return this.raw.some(
      (f) => f.pack === pack && f.group === group && (option === undefined || f.option === option),
    )
  }
  sw(group: string, option: string | undefined, label: string, evidence: string): void {
    this.add('software', group, option, label, evidence)
  }
  info(group: string, label: string, evidence: string): void {
    this.add('software', group, undefined, label, evidence)
  }
}

/** Facts for the packs present, mapped onto their groups and options (an option the pack lacks is dropped). */
function factsForPacks(sink: FactSink, packs: readonly Pack[]): Record<string, BriefFact[]> {
  const out: Record<string, BriefFact[]> = {}
  for (const pack of packs) {
    const groupOrder = (id: string): number => {
      const i = pack.groups.findIndex((g) => g.id === id)
      return i < 0 ? pack.groups.length : i
    }
    const optionOrder = (group: string, option: string | undefined): number => {
      const g = pack.groups.find((x) => x.id === group)
      const i = g?.options.findIndex((o) => o.id === option) ?? -1
      return i < 0 ? Number.MAX_SAFE_INTEGER : i
    }
    const facts = sink.raw
      .filter((f) => f.pack === pack.id)
      .map((f, index) => ({ f, index }))
      .sort(
        (a, b) =>
          groupOrder(a.f.group) - groupOrder(b.f.group) ||
          optionOrder(a.f.group, a.f.option) - optionOrder(b.f.group, b.f.option) ||
          a.index - b.index,
      )
      .map(({ f }): BriefFact => {
        const group = pack.groups.find((g) => g.id === f.group)
        const keep = f.option !== undefined && group?.options.some((o) => o.id === f.option) === true
        return keep
          ? { group: f.group, option: f.option as string, label: f.label, evidence: f.evidence }
          : { group: f.group, label: f.label, evidence: f.evidence }
      })
    out[pack.id] = facts
  }
  return out
}

const NODE_UI: readonly (readonly [dep: string, option: string, name: string])[] = [
  ['react', 'react', 'React'],
  ['vue', 'vue', 'Vue'],
  ['svelte', 'svelte', 'Svelte'],
  ['solid-js', 'solid', 'Solid'],
  ['@angular/core', 'angular', 'Angular'],
]
const NODE_BACKEND: readonly (readonly [dep: string, option: string, name: string])[] = [
  ['next', 'nextjs', 'Next.js'],
  ['nuxt', 'nextjs', 'Nuxt'],
  ['@sveltejs/kit', 'nextjs', 'SvelteKit'],
  ['@remix-run/node', 'nextjs', 'Remix'],
  ['express', 'node', 'Express'],
  ['fastify', 'node', 'Fastify'],
  ['hono', 'node', 'Hono'],
  ['koa', 'node', 'Koa'],
  ['@nestjs/core', 'node', 'NestJS'],
]
const NODE_DATA: readonly (readonly [dep: string, option: string, name: string])[] = [
  ['pg', 'postgres', 'PostgreSQL'],
  ['postgres', 'postgres', 'PostgreSQL'],
  ['@neondatabase/serverless', 'postgres', 'PostgreSQL (Neon)'],
  ['mysql', 'mysql', 'MySQL'],
  ['mysql2', 'mysql', 'MySQL'],
  ['mongodb', 'mongodb', 'MongoDB'],
  ['mongoose', 'mongodb', 'MongoDB'],
  ['better-sqlite3', 'sqlite', 'SQLite'],
  ['sqlite3', 'sqlite', 'SQLite'],
  ['@supabase/supabase-js', 'hosted', 'Supabase'],
  ['firebase', 'hosted', 'Firebase'],
  ['firebase-admin', 'hosted', 'Firebase'],
]
const NODE_TESTS: readonly (readonly [dep: string, name: string])[] = [
  ['vitest', 'Vitest'],
  ['jest', 'Jest'],
  ['mocha', 'Mocha'],
  ['@playwright/test', 'Playwright'],
  ['cypress', 'Cypress'],
]
const CONFIG_TESTS: readonly (readonly [prefix: string, name: string])[] = [
  ['vitest.config.', 'Vitest'],
  ['jest.config.', 'Jest'],
  ['.mocharc', 'Mocha'],
  ['playwright.config.', 'Playwright'],
  ['cypress.config.', 'Cypress'],
]
const SCRIPT_NAMES = ['dev', 'start', 'build', 'test', 'lint', 'typecheck', 'format'] as const

/** Python dependency names in pyproject.toml / requirements.txt / Pipfile text (whole names, any case). */
function pyHas(text: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[\\s"'\\[,])${n}(?=$|[\\s"'<>=~!\\[\\];,])`, 'im').test(text)
}

/**
 * Read the folder root and a fixed set of known files, and turn them into facts. Never throws: an unreadable folder
 * gives no facts.
 */
export async function scanFolder(folder: string, packs: readonly Pack[]): Promise<FolderScan> {
  const entries = await listDir(folder)
  const files = entries.map((e) => e.name).sort()
  const byLower = new Map<string, Dirent>()
  for (const e of entries) byLower.set(e.name.toLowerCase(), e)
  const isFile = (name: string): boolean => byLower.get(name.toLowerCase())?.isFile() === true
  const isDir = (name: string): boolean => byLower.get(name.toLowerCase())?.isDirectory() === true
  const actual = (name: string): string => byLower.get(name.toLowerCase())?.name ?? name
  const read = async (name: string): Promise<string | undefined> =>
    isFile(name) ? readCapped(join(folder, actual(name))) : undefined
  const withExt = (ext: string): string[] =>
    entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(ext))
      .map((e) => e.name)
      .sort()
  const firstWithPrefix = (prefix: string): string | undefined =>
    entries.find((e) => e.isFile() && e.name.toLowerCase().startsWith(prefix))?.name

  const sink = new FactSink()
  try {
    await scanNode()
    await scanPython()
    await scanOthers()
    scanHosting()
    scanOtherPacks()
  } catch {
    // Defensive: a scan bug must never break the Brief; whatever was found so far stands.
  }
  return { facts: factsForPacks(sink, packs), files }

  async function scanNode(): Promise<void> {
    const pkgText = await read('package.json')
    const pkg = parseJson(pkgText)
    const hasTsconfig = isFile('tsconfig.json')
    if (pkg === undefined) {
      if (hasTsconfig) sink.sw('language', 'typescript', 'TypeScript', 'tsconfig.json')
      return
    }
    const deps: Record<string, string> = {
      ...stringRecord(pkg['optionalDependencies']),
      ...stringRecord(pkg['peerDependencies']),
      ...stringRecord(pkg['devDependencies']),
      ...stringRecord(pkg['dependencies']),
    }
    const has = (d: string): boolean => d in deps
    const ev = (d: string): string => `package.json: ${d}`

    if (hasTsconfig) sink.sw('language', 'typescript', 'TypeScript', 'tsconfig.json')
    else if (has('typescript')) sink.sw('language', 'typescript', 'TypeScript', ev('typescript'))
    else sink.sw('language', 'javascript', 'JavaScript', 'package.json')

    for (const [dep, option, name] of NODE_UI) {
      if (has(dep)) sink.sw('uiFramework', option, withMajor(name, deps[dep]), ev(dep))
    }
    if (has('tailwindcss')) sink.sw('styling', 'tailwind', 'Tailwind CSS', ev('tailwindcss'))
    const twConfig = firstWithPrefix('tailwind.config.')
    if (twConfig !== undefined) sink.sw('styling', 'tailwind', 'Tailwind CSS', twConfig)
    for (const d of ['styled-components', '@emotion/react', '@emotion/styled']) {
      if (has(d))
        sink.sw('styling', 'css-in-js', d === 'styled-components' ? 'styled-components' : 'Emotion', ev(d))
    }
    for (const [d, name] of [
      ['@mui/material', 'MUI'],
      ['@chakra-ui/react', 'Chakra UI'],
      ['antd', 'Ant Design'],
    ] as const) {
      if (has(d)) sink.sw('styling', 'component-library', name, ev(d))
    }
    if (isFile('components.json')) sink.sw('styling', 'component-library', 'shadcn/ui', 'components.json')

    for (const [dep, option, name] of NODE_BACKEND) {
      if (has(dep)) sink.sw('backend', option, withMajor(name, deps[dep]), ev(dep))
    }
    for (const [dep, option, name] of NODE_DATA) {
      if (has(dep)) sink.sw('data', option, name, ev(dep))
    }
    if (has('prisma') || has('@prisma/client')) {
      const schema = await readCapped(join(folder, 'prisma', 'schema.prisma'))
      const provider =
        schema === undefined ? undefined : /provider\s*=\s*"(\w+)"/.exec(schema.split('datasource')[1] ?? '')
      const p = provider?.[1]
      const ev2 = 'prisma/schema.prisma'
      if (p === 'postgresql' || p === 'cockroachdb') sink.sw('data', 'postgres', 'PostgreSQL (Prisma)', ev2)
      else if (p === 'mysql') sink.sw('data', 'mysql', 'MySQL (Prisma)', ev2)
      else if (p === 'sqlite') sink.sw('data', 'sqlite', 'SQLite (Prisma)', ev2)
      else if (p === 'mongodb') sink.sw('data', 'mongodb', 'MongoDB (Prisma)', ev2)
    }

    const depNames = Object.keys(deps).sort()
    const clerk = depNames.find((d) => d.startsWith('@clerk/'))
    if (clerk !== undefined) sink.sw('auth', 'hosted-auth', 'Clerk', ev(clerk))
    const auth0 = depNames.find((d) => d.startsWith('@auth0/'))
    if (auth0 !== undefined) sink.sw('auth', 'hosted-auth', 'Auth0', ev(auth0))
    for (const d of ['next-auth', '@auth/core']) if (has(d)) sink.sw('auth', 'oauth', 'Auth.js', ev(d))

    if (has('electron')) sink.sw('projectType', 'desktop', 'Electron app', ev('electron'))
    if (has('@tauri-apps/api') || isDir('src-tauri')) {
      sink.sw(
        'projectType',
        'desktop',
        'Tauri app',
        has('@tauri-apps/api') ? ev('@tauri-apps/api') : 'src-tauri',
      )
    }
    for (const d of ['react-native', 'expo', '@capacitor/core']) {
      if (has(d))
        sink.sw(
          'projectType',
          'mobile',
          d === '@capacitor/core' ? 'Capacitor app' : 'React Native app',
          ev(d),
        )
    }
    if (pkg['bin'] !== undefined && pkg['bin'] !== null)
      sink.sw('projectType', 'cli', 'CLI', 'package.json: bin')

    const pm = typeof pkg['packageManager'] === 'string' ? pkg['packageManager'] : ''
    if (isFile('pnpm-lock.yaml')) sink.info('packageManager', 'pnpm', 'pnpm-lock.yaml')
    else if (pm.startsWith('pnpm@')) sink.info('packageManager', 'pnpm', 'package.json: packageManager')
    if (isFile('package-lock.json')) sink.info('packageManager', 'npm', 'package-lock.json')
    if (isFile('yarn.lock')) sink.info('packageManager', 'Yarn', 'yarn.lock')
    else if (pm.startsWith('yarn@')) sink.info('packageManager', 'Yarn', 'package.json: packageManager')
    if (isFile('bun.lockb')) sink.info('packageManager', 'Bun', 'bun.lockb')
    else if (isFile('bun.lock')) sink.info('packageManager', 'Bun', 'bun.lock')

    for (const [dep, name] of NODE_TESTS) if (has(dep)) sink.info('testRunner', name, ev(dep))
    const scripts = stringRecord(pkg['scripts'])
    const present = SCRIPT_NAMES.filter((s) => s in scripts)
    if (present.length > 0) sink.info('scripts', `Scripts: ${present.join(', ')}`, 'package.json')
  }

  async function scanPython(): Promise<void> {
    const pyproject = await read('pyproject.toml')
    const requirements = await read('requirements.txt')
    const pipfile = await read('Pipfile')
    const sources: [string, string | undefined][] = [
      ['pyproject.toml', pyproject],
      ['requirements.txt', requirements],
      ['Pipfile', pipfile],
    ]
    // Comments dropped (a `#` to the end of the line), so a mention in a comment is not a dependency.
    const present = sources
      .filter((s): s is [string, string] => s[1] !== undefined)
      .map(([file, text]): [string, string] => [file, text.replace(/#.*$/gm, '')])
    const setupPy = isFile('setup.py')
    if (present.length === 0 && !setupPy) return
    sink.sw('language', 'python', 'Python', present[0]?.[0] ?? 'setup.py')
    const hit = (name: string): string | undefined => present.find(([, text]) => pyHas(text, name))?.[0]
    for (const [d, name] of [
      ['fastapi', 'FastAPI'],
      ['django', 'Django'],
      ['flask', 'Flask'],
    ] as const) {
      const file = hit(d)
      if (file !== undefined) sink.sw('backend', 'python-web', name, `${file}: ${d}`)
    }
    for (const [d, option, name] of [
      ['psycopg', 'postgres', 'PostgreSQL'],
      ['psycopg2', 'postgres', 'PostgreSQL'],
      ['psycopg2-binary', 'postgres', 'PostgreSQL'],
      ['asyncpg', 'postgres', 'PostgreSQL'],
      ['pymysql', 'mysql', 'MySQL'],
      ['mysqlclient', 'mysql', 'MySQL'],
      ['pymongo', 'mongodb', 'MongoDB'],
      ['motor', 'mongodb', 'MongoDB'],
    ] as const) {
      const file = hit(d)
      if (file !== undefined) sink.sw('data', option, name, `${file}: ${d}`)
    }
    const pytest = hit('pytest')
    if (pytest !== undefined) sink.info('testRunner', 'pytest', `${pytest}: pytest`)
    if (pyproject !== undefined && /^\[tool\.pytest\.ini_options\]/m.test(pyproject)) {
      sink.info('testRunner', 'pytest', 'pyproject.toml')
    }
    if (isFile('pytest.ini')) sink.info('testRunner', 'pytest', 'pytest.ini')
    if (isFile('conftest.py')) sink.info('testRunner', 'pytest', 'conftest.py')
    const pyManagers = sink.raw.length
    if (isFile('uv.lock')) sink.info('packageManager', 'uv', 'uv.lock')
    if (isFile('poetry.lock')) sink.info('packageManager', 'Poetry', 'poetry.lock')
    else if (pyproject !== undefined && /^\[tool\.poetry\]/m.test(pyproject)) {
      sink.info('packageManager', 'Poetry', 'pyproject.toml')
    }
    if (pipfile !== undefined) sink.info('packageManager', 'Pipenv', 'Pipfile')
    if (requirements !== undefined && sink.raw.length === pyManagers) {
      sink.info('packageManager', 'pip', 'requirements.txt')
    }
  }

  async function scanOthers(): Promise<void> {
    const gomod = await read('go.mod')
    if (gomod !== undefined) {
      sink.sw('language', 'go', 'Go', 'go.mod')
      sink.info('packageManager', 'Go modules', 'go.mod')
      sink.info('testRunner', 'go test', 'go.mod')
      for (const [mod, name] of [
        ['github.com/gin-gonic/gin', 'Gin'],
        ['github.com/labstack/echo', 'Echo'],
        ['github.com/gofiber/fiber', 'Fiber'],
        ['github.com/go-chi/chi', 'chi'],
      ] as const) {
        if (gomod.includes(mod)) sink.sw('backend', 'go', name, `go.mod: ${mod}`)
      }
    }

    const cargo = await read('Cargo.toml')
    if (cargo !== undefined) {
      sink.sw('language', 'rust', 'Rust', 'Cargo.toml')
      sink.info('packageManager', 'Cargo', 'Cargo.toml')
      sink.info('testRunner', 'cargo test', 'Cargo.toml')
      if (/^\s*tauri\s*=/m.test(cargo)) sink.sw('projectType', 'desktop', 'Tauri app', 'Cargo.toml: tauri')
    }

    for (const name of withExt('.csproj')) {
      sink.sw('language', 'csharp', 'C#', name)
      const text = await read(name)
      if (text !== undefined && /Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(text)) {
        sink.sw('backend', 'dotnet', 'ASP.NET Core', name)
      }
      for (const [ref, runner] of [
        ['xunit', 'xUnit'],
        ['nunit', 'NUnit'],
        ['MSTest', 'MSTest'],
      ] as const) {
        if (text !== undefined && new RegExp(`Include\\s*=\\s*"${ref}`, 'i').test(text)) {
          sink.info('testRunner', runner, name)
        }
      }
    }
    for (const name of withExt('.fsproj')) sink.sw('language', undefined, 'F#', name)
    for (const name of withExt('.sln')) {
      const text = await read(name)
      if (text !== undefined && /\.csproj"/i.test(text)) sink.sw('language', 'csharp', 'C#', name)
    }

    const pom = await read('pom.xml')
    if (pom !== undefined) {
      sink.sw('language', 'java-kotlin', /kotlin-maven-plugin/.test(pom) ? 'Kotlin' : 'Java', 'pom.xml')
      sink.info('packageManager', 'Maven', 'pom.xml')
      if (/<artifactId>junit/i.test(pom)) sink.info('testRunner', 'JUnit', 'pom.xml')
    }
    for (const name of ['build.gradle.kts', 'build.gradle']) {
      const text = await read(name)
      if (text === undefined) continue
      const kotlin = /kotlin\(|org\.jetbrains\.kotlin/.test(text)
      sink.sw('language', 'java-kotlin', kotlin ? 'Kotlin' : 'Java or Kotlin', name)
      sink.info('packageManager', 'Gradle', name)
      if (/com\.android\.application/.test(text)) {
        sink.sw('projectType', 'mobile', 'Android app', name)
        sink.sw('platform', 'android', 'Android', name)
      }
      break
    }
    if (isFile('Package.swift')) sink.sw('language', 'swift', 'Swift', 'Package.swift')
    if (isFile('Gemfile')) {
      sink.sw('language', undefined, 'Ruby', 'Gemfile')
      sink.info('packageManager', 'Bundler', 'Gemfile')
    }
    if (isFile('composer.json')) {
      sink.sw('language', undefined, 'PHP', 'composer.json')
      sink.info('packageManager', 'Composer', 'composer.json')
    }

    const manifest = parseJson(await read('manifest.json'))
    const mv = manifest?.['manifest_version']
    if (typeof mv === 'number') {
      sink.sw('projectType', 'browser-extension', `Browser extension (Manifest V${mv})`, 'manifest.json')
    }

    const eas = isFile('eas.json')
    const appJson = parseJson(await read('app.json'))
    if (eas) sink.sw('projectType', 'mobile', 'Expo app', 'eas.json')
    else if (appJson?.['expo'] !== undefined) sink.sw('projectType', 'mobile', 'Expo app', 'app.json')

    for (const [prefix, name] of CONFIG_TESTS) {
      const file = firstWithPrefix(prefix)
      if (file !== undefined) sink.info('testRunner', name, file)
    }
    if (
      isDir('.github') &&
      (await listDir(join(folder, actual('.github')))).some((e) => e.isDirectory() && e.name === 'workflows')
    ) {
      sink.info('ci', 'GitHub Actions', '.github/workflows')
    }

    const manifests = [
      'package.json',
      'pyproject.toml',
      'requirements.txt',
      'Pipfile',
      'setup.py',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'Gemfile',
      'composer.json',
      'Package.swift',
      'mkdocs.yml',
    ]
    const anyManifest =
      manifests.some(isFile) ||
      withExt('.csproj').length > 0 ||
      withExt('.sln').length > 0 ||
      withExt('.fsproj').length > 0
    if (isFile('index.html') && !anyManifest && typeof mv !== 'number') {
      sink.sw('projectType', 'static-site', 'Static site', 'index.html, no build files')
    }
  }

  function scanHosting(): void {
    const hostFiles: [string, string, string][] = [
      ['vercel.json', 'vercel-netlify', 'Vercel'],
      ['netlify.toml', 'vercel-netlify', 'Netlify'],
      ['wrangler.toml', 'vercel-netlify', 'Cloudflare'],
      ['wrangler.jsonc', 'vercel-netlify', 'Cloudflare'],
      ['wrangler.json', 'vercel-netlify', 'Cloudflare'],
      ['fly.toml', 'render-fly', 'Fly.io'],
      ['render.yaml', 'render-fly', 'Render'],
      ['railway.json', 'render-fly', 'Railway'],
      ['railway.toml', 'render-fly', 'Railway'],
      ['Procfile', 'render-fly', 'Procfile host'],
    ]
    for (const [file, option, name] of hostFiles) if (isFile(file)) sink.sw('hosting', option, name, file)
    const dockerfile = isFile('Dockerfile') ? actual('Dockerfile') : undefined
    const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'].find(isFile)
    if (dockerfile !== undefined) sink.sw('deliverable', 'docker-image', 'Docker image', dockerfile)
    if (!sink.has('software', 'hosting') && (dockerfile !== undefined || compose !== undefined)) {
      sink.sw(
        'hosting',
        'container',
        compose !== undefined ? 'Docker Compose' : 'Container',
        compose ?? 'Dockerfile',
      )
    }
  }

  function scanOtherPacks(): void {
    if (isFile('mkdocs.yml')) sink.add('documents', 'format', 'html-site', 'MkDocs site', 'mkdocs.yml')
    const docusaurus = firstWithPrefix('docusaurus.config.')
    if (docusaurus !== undefined) sink.add('documents', 'format', 'html-site', 'Docusaurus site', docusaurus)

    const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
    const csv = withExt('.csv')
    if (csv.length > 0)
      sink.add(
        'data',
        'sources',
        'csv',
        count(csv.length, 'CSV file', 'CSV files'),
        csv.slice(0, 3).join(', '),
      )
    const excel = [...withExt('.xlsx'), ...withExt('.xls')]
    if (excel.length > 0) {
      sink.add(
        'data',
        'sources',
        'excel',
        count(excel.length, 'Excel workbook', 'Excel workbooks'),
        excel.slice(0, 3).join(', '),
      )
    }
    const parquet = withExt('.parquet')
    if (parquet.length > 0) {
      sink.add(
        'data',
        'sources',
        'parquet',
        count(parquet.length, 'Parquet file', 'Parquet files'),
        parquet.slice(0, 3).join(', '),
      )
    }
    const notebooks = withExt('.ipynb')
    if (notebooks.length > 0) {
      sink.add(
        'data',
        'notebooks',
        undefined,
        count(notebooks.length, 'notebook', 'notebooks'),
        notebooks.slice(0, 3).join(', '),
      )
    }

    const tf = withExt('.tf')
    if (tf.length > 0) sink.add('operations', 'tooling', 'terraform', 'Terraform', tf.slice(0, 3).join(', '))
    for (const f of ['ansible.cfg', 'playbook.yml']) {
      if (isFile(f)) sink.add('operations', 'tooling', 'ansible', 'Ansible', f)
    }
    for (const f of ['Chart.yaml', 'kustomization.yaml']) {
      if (isFile(f)) sink.add('operations', 'tooling', 'helm', f === 'Chart.yaml' ? 'Helm' : 'Kustomize', f)
    }
  }
}

// ---- task text ------------------------------------------------------------------------------------------------------

const phraseCache = new Map<string, RegExp>()

/** A keyword or phrase as a whole-word, any-case pattern (letters and digits around it break a match). */
function phraseRegex(phrase: string): RegExp {
  let re = phraseCache.get(phrase)
  if (re === undefined) {
    const body = phrase
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+')
    re = new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu')
    phraseCache.set(phrase, re)
  }
  return re
}

interface Span {
  start: number
  end: number
}

function phraseSpans(task: string, phrase: string): Span[] {
  const re = phraseRegex(phrase)
  re.lastIndex = 0
  const spans: Span[] = []
  for (let m = re.exec(task); m !== null; m = re.exec(task)) {
    spans.push({ start: m.index, end: m.index + m[0].length })
    if (m[0].length === 0) re.lastIndex++
  }
  return spans
}

const hasPhrase = (task: string, phrase: string): boolean => phraseSpans(task, phrase).length > 0

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`
}

/** A folder signal pattern (a name, or `*.ext`) against a root entry name, any case. */
function fileMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase()
  const n = name.toLowerCase()
  return p.startsWith('*.') ? n.length > p.length - 1 && n.endsWith(p.slice(1)) : n === p
}

interface CategoryScore {
  pack: Pack
  task: number
  words: string[]
  folder: number
  files: string[]
}

function scorePack(task: string, scan: FolderScan | null, pack: Pack): CategoryScore {
  const words: string[] = []
  let taskScore = 0
  for (const k of pack.detect.keywords) {
    if (hasPhrase(task, k)) {
      taskScore += 2
      if (!words.includes(k.toLowerCase())) words.push(k.toLowerCase())
    }
  }
  for (const g of pack.groups) {
    if (g.id === APPROACH_GROUP) continue
    for (const o of g.options) {
      const k = (o.keywords ?? []).find((kw) => hasPhrase(task, kw))
      if (k !== undefined) {
        taskScore += 1
        if (!words.includes(k.toLowerCase())) words.push(k.toLowerCase())
      }
    }
  }
  const files: string[] = []
  let folderScore = 0
  for (const pattern of pack.detect.files) {
    const hit = scan?.files.find((f) => fileMatches(pattern, f))
    if (hit !== undefined) {
      folderScore += 1
      if (!files.includes(hit)) files.push(hit)
    }
  }
  return { pack, task: taskScore, words, folder: folderScore, files }
}

/**
 * The likely category: words in the task count first, folder signals break a tie or decide when the task names
 * nothing; with nothing either way, the default category.
 */
export function detectCategory(
  task: string,
  scan: FolderScan | null,
  packs: readonly Pack[],
): BriefCategoryGuess {
  const fallback = packs.find((p) => p.id === DEFAULT_CATEGORY) ?? packs[0]
  const defaultGuess: BriefCategoryGuess = {
    id: fallback?.id ?? DEFAULT_CATEGORY,
    source: 'default',
    reason: 'Nothing points elsewhere',
  }
  if (packs.length === 0) return defaultGuess
  const scores = packs.map((p) => scorePack(task, scan, p))

  const topTask = Math.max(...scores.map((s) => s.task))
  let pool = scores
  if (topTask > 0) {
    pool = scores.filter((s) => s.task === topTask)
    const [only] = pool
    if (pool.length === 1 && only !== undefined) {
      const quoted = only.words.slice(0, 3).map((w) => `"${w}"`)
      return { id: only.pack.id, source: 'task', reason: `Your task mentions ${joinList(quoted)}` }
    }
  }
  const topFolder = Math.max(...pool.map((s) => s.folder))
  const byFolder = pool.filter((s) => s.folder === topFolder)
  const [winner] = byFolder
  if (topFolder > 0 && byFolder.length === 1 && winner !== undefined) {
    return {
      id: winner.pack.id,
      source: 'folder',
      reason: `This folder has ${joinList(winner.files.slice(0, 3))}`,
    }
  }
  return defaultGuess
}

/**
 * The local keyword rules: options the task names outright, per group. A single-choice group takes its one match and
 * nothing when two options match. The approach group and groups a locked fact covers are never filled.
 */
export function keywordFields(
  task: string,
  pack: Pack,
  locked: readonly BriefFact[],
): Record<string, BriefField> {
  const lockedGroups = new Set(locked.map((f) => f.group))
  const out: Record<string, BriefField> = {}
  for (const g of pack.groups) {
    if (g.id === APPROACH_GROUP || lockedGroups.has(g.id)) continue
    const hits = g.options
      .map((o) => ({ id: o.id, spans: (o.keywords ?? []).flatMap((k) => phraseSpans(task, k)) }))
      .filter((h) => h.spans.length > 0)
    // A match inside a longer match of another option is not a separate mention: the longer phrase wins.
    const kept = hits.filter((h) =>
      h.spans.some(
        (s) =>
          !hits.some(
            (other) =>
              other.id !== h.id &&
              other.spans.some(
                (t) => t.start <= s.start && t.end >= s.end && t.end - t.start > s.end - s.start,
              ),
          ),
      ),
    )
    if (kept.length === 0) continue
    if (!g.multi && kept.length > 1) continue
    out[g.id] = { choices: kept.map((h) => h.id), source: 'keyword' }
  }
  return out
}
