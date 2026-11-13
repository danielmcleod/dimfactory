// Beginners, part A through a real core, real git and the fake Claude on temp folders (the projects folder is a temp
// folder set in the user file; no network): a website or app idea resolves to React (this machine has a Node.js new
// enough), the new project starts from the web starter's files with the needs answered in its task, the template's
// checks as the run's Verify commands and the look-and-feel bar in its Brief; "Get it ready to share" asks to trust the
// project's build first, then runs it through Verify's runner so the upload file can be made from dist/; and a Verify
// round runs the built-in page-load check on a page served by the static server (the page checker stands in for the
// app's hidden window), failing on a console error and passing once it is fixed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { homePaths } from '../../../src/core/home.ts'
import { startStaticServer } from '../../../src/core/preview/static-server.ts'
import { runVerifyRound } from '../../../src/core/verify/run.ts'
import type { PageChecker } from '../../../src/core/verify/pageload.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import { cleanup, hermeticEnv, makeHome, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

async function boot(): Promise<{ core: Core; home: string; projects: string }> {
  const sc = await makeScenario({
    clarify: [{ recording: 'C02-review-shape', text: '{"questions": []}' }],
    plan: { recording: 'C06-plan-native-host' },
  })
  const { home } = await makeHome(sc)
  const projects = join(temp('dimf-easy-a-'), 'Projects')
  dirs.push(home, sc.dir)
  const file = join(home, 'dimfactory.json')
  const user = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(
    file,
    JSON.stringify(
      {
        ...user,
        passes: { ...(user['passes'] as object), plan: { model: 'haiku' } },
        easy: { projectsDir: projects },
      },
      null,
      2,
    ),
  )
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  value(await core.invoke('vendors.probe', { vendor: 'claude' }))
  return { core, home, projects }
}

describe('a React project from an idea', () => {
  it('starts from the web starter, with its needs, its checks and the look-and-feel bar', async () => {
    const { core, home } = await boot()
    const idea = 'An AI caption writer app for my photos'
    const r = value(await core.invoke('easy.resolve', { idea }))
    expect(r.template.id).toBe('react-site')
    expect(r.stack).toEqual({ chosen: 'react', react: true })
    expect(r.needs?.[0]?.need).toBe('ai')
    expect(existsSync(r.folder)).toBe(false)
    const started = value(
      await core.invoke('easy.create', {
        idea,
        kind: r.kind,
        folder: r.folder,
        limits: { maxCostUsd: null, maxMinutes: null },
        consent: true,
        stack: 'react',
        needs: { ai: 'proxy' },
      }),
    )
    for (const f of [
      'package.json',
      'src/main.tsx',
      'src/styles/tokens.css',
      'public/_redirects',
      'lib/VENDORED.md',
    ])
      expect(existsSync(join(r.folder, ...f.split('/'))), f).toBe(true)
    const resolved = JSON.parse(readFileSync(homePaths(home).run(started.runId).resolvedJson, 'utf8')) as {
      config: { verify: { enabled: boolean; commands: { name: string; run: string[] }[] } }
      brief?: { text: string; focus?: string }
    }
    expect(resolved.config.verify.enabled).toBe(true)
    expect(resolved.config.verify.commands.map((c) => c.run)).toEqual([
      ['npm', 'run', 'test'],
      ['npm', 'run', 'build'],
      ['dimf:pageload', 'dist/index.html'],
    ])
    expect(resolved.brief?.text).toContain(
      'Look and feel (a default: the request does not say how it should look):',
    )
    expect(resolved.brief?.focus).toMatch(/VITE_/)
    const doc = JSON.parse(readFileSync(homePaths(home).run(started.runId).runJson, 'utf8')) as {
      state: { task: string }
    }
    expect(doc.state.task).toMatch(/small server function/)
    value(await core.invoke('runs.stop', { runId: started.runId }))
  })
})

describe('Get it ready to share', () => {
  it('asks to trust the build, then builds dist/ for the upload file', async () => {
    const { core } = await boot()
    const folder = join(temp('dimf-share-int-'), 'site')
    mkdirSync(folder)
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({ name: 'site', scripts: { build: 'node build.mjs' }, devDependencies: { vite: '7' } }),
    )
    writeFileSync(
      join(folder, 'build.mjs'),
      "import { mkdirSync, writeFileSync } from 'node:fs'\nmkdirSync('dist', { recursive: true })\nwriteFileSync('dist/index.html', '<!doctype html><title>Site</title>')\n",
    )
    let report = value(await core.invoke('deploy.inspect', { folder, cls: 'spa' }))
    expect(report.upload).toMatchObject({ dir: 'dist', ready: false, build: { command: 'npm run build' } })
    const ask = value(await core.invoke('deploy.build', { folder }))
    if (ask.status !== 'trust') throw new Error(`expected a trust question, got ${ask.status}`)
    expect(ask.command).toBe('npm run build')
    expect(ask.body).toContain('node build.mjs')
    expect(existsSync(join(folder, 'dist'))).toBe(false)
    // A hash for something else is not trust.
    const wrong = value(await core.invoke('deploy.build', { folder, trustHash: 'b'.repeat(64) }))
    expect(wrong.status).toBe('trust')
    const built = value(await core.invoke('deploy.build', { folder, trustHash: ask.hash }))
    expect(built).toMatchObject({ status: 'built', dir: 'dist' })
    expect(existsSync(join(folder, 'dist', 'index.html'))).toBe(true)
    // Trusted now: it builds again without asking.
    expect(value(await core.invoke('deploy.build', { folder })).status).toBe('built')
    report = value(await core.invoke('deploy.inspect', { folder, cls: 'spa' }))
    expect(report.upload?.ready).toBe(true)
    const zip = value(await core.invoke('deploy.uploadFile', { folder, cls: 'spa' }))
    expect(zip.status).toBe('made')
    // A failing build says so, with its output (the grant covers the package.json script, which is unchanged).
    writeFileSync(join(folder, 'build.mjs'), "console.error('something broke'); process.exit(1)\n")
    const failed = value(await core.invoke('deploy.build', { folder }))
    expect(failed.status).toBe('failed')
    if (failed.status === 'failed') expect(failed.excerpt).toContain('something broke')
    // A changed build script is asked about again before anything runs.
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({
        name: 'site',
        scripts: { build: 'node build.mjs --fast' },
        devDependencies: { vite: '7' },
      }),
    )
    expect(value(await core.invoke('deploy.build', { folder })).status).toBe('trust')
  }, 120_000)
})

describe('the page-load check in a Verify round', () => {
  it('fails on a console error and passes once the page is fixed', async () => {
    const folder = temp('dimf-pageload-int-')
    const home = temp('dimf-pageload-home-')
    // The app's hidden window, stood in for: the page is fetched from the static server and a console.error call in
    // it counts as a console error.
    const seen: string[] = []
    const checker: PageChecker = async (req) => {
      const server = await startStaticServer(req.folder)
      try {
        const url = new URL(req.page, server.url).href
        seen.push(url)
        const res = await fetch(url)
        const html = await res.text()
        const errors = [...html.matchAll(/console\.error\('([^']*)'\)/g)].map((m) => ({
          message: m[1] ?? '',
        }))
        return {
          kind: 'report',
          report: { url, loaded: res.ok, consoleErrors: errors, failedLoads: [], blocked: [], durationMs: 1 },
        }
      } finally {
        await server.close()
      }
    }
    const roundOf = () =>
      runVerifyRound(
        {
          paths: homePaths(home),
          pathEnv: [dirname(process.execPath), process.env['PATH'] ?? ''].join(delimiter),
          grants: () => Promise.resolve({}),
          pageload: checker,
        },
        {
          runId: 'r1',
          round: 'verify:1',
          folder,
          commands: [{ name: 'Page loads (Dim Factory)', run: ['dimf:pageload', 'index.html'], cwdRel: '.' }],
          failFast: true,
        },
      )
    writeFileSync(join(folder, 'index.html'), "<script>console.error('Cannot read the menu')</script>")
    const first = await roundOf()
    expect(first.results[0]).toMatchObject({
      status: 'fail',
      reason: 'The page loaded with 1 console error',
    })
    expect(first.results[0]?.excerpt).toContain('console error: Cannot read the menu')
    writeFileSync(join(folder, 'index.html'), '<p>Menu</p>')
    const second = await roundOf()
    expect(second.results[0]?.status).toBe('pass')
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/)
  })
})
