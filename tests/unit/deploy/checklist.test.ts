// The Deploy helper's pre-flight checklist: what Dim Factory can check (secrets with the security advisor's scanner,
// .env files git would commit, the environment variables the code reads and .env.example, a licence file), and the
// manual items, which read "not checked" until the user ticks them. Also the folder signals the classifier reads.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  envReadsIn,
  exampleKeys,
  folderFiles,
  isEnvExample,
  isEnvFile,
  licenceFile,
  manualItems,
  runChecklist,
} from '@core/deploy/checklist.ts'
import {
  exposedPort,
  parseGoDeps,
  parsePackageSignals,
  parsePythonSignals,
  parseRustSignals,
  readDeploySignals,
} from '@core/deploy/signals.ts'
import { DEPLOY_CLASSES } from '@shared/deploy.ts'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dimf-deploy-'))
  temps.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, ...rel.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
  return dir
}

function git(cwd: string, args: string[]): void {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  const r = spawnSync('git', args, {
    cwd,
    env: {
      ...env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
    windowsHide: true,
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
}

// A string the scanner reads as an AWS key (a known format) without being one anyone could use.
const FAKE_AWS = ['AKIA', 'QWERTYUIOPASDFGH'].join('')

describe('pure parts', () => {
  it('reads environment variables in every common form, leaving out what runtimes set', () => {
    const js =
      'const a = process.env.API_KEY; const b = process.env["DB_URL"]; import.meta.env.VITE_SITE; process.env.NODE_ENV'
    expect(envReadsIn(js)).toEqual(['API_KEY', 'DB_URL', 'VITE_SITE'])
    expect(envReadsIn("os.environ['SECRET_KEY']; os.environ.get(\"DEBUG\"); os.getenv('PORT')")).toEqual([
      'DEBUG',
      'PORT',
      'SECRET_KEY',
    ])
    expect(envReadsIn('os.Getenv("REDIS_ADDR"); std::env::var("RUST_LOG"); ENV.fetch("RAILS_KEY")')).toEqual([
      'RAILS_KEY',
      'REDIS_ADDR',
      'RUST_LOG',
    ])
    expect(envReadsIn('Environment.GetEnvironmentVariable("CONN")')).toEqual(['CONN'])
  })

  it('reads .env.example keys and tells example files from real ones', () => {
    expect(exampleKeys('# comment\nAPI_KEY=\nexport DB_URL=postgres://localhost\n\nnot a line\n')).toEqual([
      'API_KEY',
      'DB_URL',
    ])
    expect(isEnvExample('.env.example')).toBe(true)
    expect(isEnvExample('app/.env.sample')).toBe(true)
    expect(isEnvFile('.env')).toBe(true)
    expect(isEnvFile('web/.env.production')).toBe(true)
    expect(isEnvFile('.env.example')).toBe(false)
    expect(isEnvFile('src/env.ts')).toBe(false)
  })

  it('finds a licence file at the root only', () => {
    expect(licenceFile(['README.md', 'LICENSE'])).toBe('LICENSE')
    expect(licenceFile(['LICENCE.txt'])).toBe('LICENCE.txt')
    expect(licenceFile(['COPYING'])).toBe('COPYING')
    expect(licenceFile(['vendor/LICENSE'])).toBeUndefined()
  })

  it('every class has manual items, never auto, and only web classes ask about HTTPS', () => {
    for (const cls of DEPLOY_CLASSES) {
      const items = manualItems(cls)
      expect(items.length, cls).toBeGreaterThan(0)
      for (const i of items) expect(i.detail).not.toMatch(/—/)
    }
    expect(manualItems('server-app').map((i) => i.id)).toEqual([
      'https',
      'admin-auth',
      'error-pages',
      'logging',
      'backups',
      'privacy',
    ])
    expect(manualItems('package').map((i) => i.id)).toEqual(['package-contents'])
    expect(manualItems('mobile-app').map((i) => i.id)).not.toContain('https')
  })
})

describe('runChecklist', () => {
  it('a clean folder: secrets ok, no .env, variables listed, a licence; the manual items not checked', async () => {
    const dir = folder({
      LICENSE: 'MIT',
      'src/app.js': 'const key = process.env.API_KEY\n',
      '.env.example': 'API_KEY=\n',
    })
    const r = await runChecklist(dir, 'server-app')
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]))
    expect(byId['secrets']).toMatchObject({ state: 'ok', auto: true })
    expect(byId['env-file']).toMatchObject({ state: 'ok', auto: true })
    expect(byId['env-vars']).toMatchObject({ state: 'ok', evidence: ['API_KEY'] })
    expect(byId['license']).toMatchObject({ state: 'ok' })
    expect(byId['https']).toMatchObject({ state: 'not-checked', auto: false })
    expect(byId['https']?.tickedAt).toBeUndefined()
    expect(r.env).toEqual([{ name: 'API_KEY', files: ['src/app.js'], inExample: true }])
  })

  it('a secret in the files is a problem, shown masked; a missing .env.example and licence are warnings', async () => {
    const dir = folder({
      'src/config.js': `const aws = "${FAKE_AWS}"\nconst db = process.env.DATABASE_URL\n`,
    })
    const r = await runChecklist(dir, 'server-app')
    const secrets = r.items.find((i) => i.id === 'secrets')
    expect(secrets?.state).toBe('problem')
    expect(secrets?.evidence?.[0]).toMatch(/^src\/config\.js:1 AWS/)
    expect(secrets?.evidence?.join('\n')).not.toContain(FAKE_AWS)
    expect(r.items.find((i) => i.id === 'env-vars')).toMatchObject({ state: 'warn' })
    expect(r.items.find((i) => i.id === 'env-vars')?.detail).toMatch(/no \.env\.example/)
    expect(r.items.find((i) => i.id === 'license')).toMatchObject({ state: 'warn' })
  })

  it('a .env git would commit is a problem; an ignored one is not; its values are never read out', async () => {
    const dir = folder({ '.env': `KEY=${FAKE_AWS}\n`, 'index.js': 'process.env.KEY\n' })
    git(dir, ['init', '-q'])
    let r = await runChecklist(dir, 'server-app')
    expect(r.items.find((i) => i.id === 'env-file')).toMatchObject({ state: 'problem', evidence: ['.env'] })
    // The .env file's own value is not reported as a secret hit (the file itself is the finding).
    expect(r.items.find((i) => i.id === 'secrets')?.state).toBe('ok')
    writeFileSync(join(dir, '.gitignore'), '.env\n')
    r = await runChecklist(dir, 'server-app')
    expect(r.items.find((i) => i.id === 'env-file')).toMatchObject({ state: 'ok' })
    expect((await folderFiles(dir)).tracked).toBe(true)
  })

  it('outside git a .env is a warning (nothing keeps it out of an upload)', async () => {
    const dir = folder({ '.env': 'A=1\n' })
    const r = await runChecklist(dir, 'static-site')
    expect(r.items.find((i) => i.id === 'env-file')).toMatchObject({ state: 'warn' })
    expect((await folderFiles(dir)).tracked).toBe(false)
  })

  it('a ticked manual item carries its tick (shown as ticked by the user, never as checked)', async () => {
    const dir = folder({ 'index.html': '<p>hi</p>' })
    const r = await runChecklist(dir, 'static-site', { https: 1234 })
    expect(r.items.find((i) => i.id === 'https')).toMatchObject({ state: 'not-checked', tickedAt: 1234 })
  })

  it('a package without a licence says it may not legally be used', async () => {
    const dir = folder({ 'package.json': '{"name":"x"}' })
    const r = await runChecklist(dir, 'package')
    expect(r.items.find((i) => i.id === 'license')?.detail).toMatch(/may not legally/)
  })
})

describe('folder signals', () => {
  it('parses package.json, pyproject and requirements, Cargo.toml, go.mod and EXPOSE', () => {
    expect(
      parsePackageSignals(
        '{"name":"a","version":"1.0.0","private":true,"main":"x.js","dependencies":{"b":"1"},"devDependencies":{"c":"1"}}',
      ),
    ).toMatchObject({
      name: 'a',
      version: '1.0.0',
      deps: ['b', 'c'],
      private: true,
      library: true,
      bin: false,
    })
    expect(parsePackageSignals('not json')).toBeNull()
    const py = parsePythonSignals(
      '[project]\nname = "svc"\nversion = "0.2.0"\ndependencies = ["FastAPI>=0.1", "uvicorn[standard]"]\n[project.scripts]\nsvc = "x:main"\n[build-system]\nrequires = []\n',
      ['Flask==2.0\n# comment\n-r other.txt\n'],
    )
    expect(py).toMatchObject({ name: 'svc', version: '0.2.0', buildSystem: true, scripts: true })
    expect(py.deps).toEqual(['fastapi', 'flask', 'uvicorn'])
    expect(
      parseRustSignals(
        '[package]\nname = "c"\nversion = "0.1.0"\n[dependencies]\naxum = "0.7"\n',
        true,
        false,
      ),
    ).toMatchObject({
      bin: true,
      lib: false,
      deps: ['axum'],
      name: 'c',
    })
    expect(parseGoDeps('module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n)\n')).toEqual([
      'github.com/gin-gonic/gin',
    ])
    expect(exposedPort('FROM node\nEXPOSE 8081\n')).toBe(8081)
    expect(exposedPort('FROM node\n')).toBeUndefined()
  })

  it('reads a folder: root entries, manifests, functions folders, Expo', async () => {
    const dir = folder({
      'package.json': '{"name":"web","dependencies":{"expo":"1","react-native":"1"}}',
      'app.json': '{"expo": {"name": "x"}}',
      'netlify/functions/hello.js': 'export default () => {}',
      'api/x.ts': 'export default 1',
      Dockerfile: 'FROM node\nEXPOSE 3001\n',
    })
    const s = await readDeploySignals(dir)
    expect(s.files).toEqual(expect.arrayContaining(['package.json', 'app.json', 'Dockerfile']))
    expect(s.expo).toBe(true)
    expect(s.netlifyFunctions).toBe(true)
    expect(s.apiFunctions).toBe(true)
    expect(s.exposePort).toBe(3001)
    expect(s.pkg?.deps).toEqual(['expo', 'react-native'])
  })
})
