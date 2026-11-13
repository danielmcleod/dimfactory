// Previewing a React site: its own index.html is the build's source (never served as it is), so Run & Preview offers its
// dev server (the trusted preview command) and, once built, its dist/ through Dim Factory's static server, which falls
// back the way the hosts do (_redirects' single-page rule, else 404.html) so a link to an inner page opens. The web
// starter's files copy into a new project (a web starter may write its root files and public/ and assets/; no other
// template may), and the page-load check's pure parts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectPreviewCommands } from '@core/preview/detect.ts'
import { fallbackFor, startStaticServer } from '@core/preview/static-server.ts'
import { copyTemplateFiles, VENDORED_FILE } from '@core/templates/files.ts'
import { readBuiltinTemplates } from '@core/templates/load.ts'
import {
  missingPageReason,
  pageOf,
  pageloadLogLines,
  pageloadVerdict,
  runPageload,
} from '@core/verify/pageload.ts'
import type { PageChecker } from '@core/verify/pageload.ts'
import { isBuiltinCheckArgv, isPageloadArgv, pageloadArgv } from '@shared/pageload.ts'
import type { PageloadReport } from '@shared/pageload.ts'
import { TemplateZ, templateTargetProblem } from '@shared/templates.ts'

let root: string

function write(rel: string, content: string): void {
  const p = join(root, ...rel.split('/'))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dimf-react-preview-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Run & Preview for a React site', () => {
  it('offers the dev server and, once built, dist/; never the source index.html', async () => {
    write(
      'package.json',
      JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '7' } }),
    )
    write('index.html', '<script type="module" src="/src/main.tsx"></script>')
    write('public/index.html', 'not a page')
    let ids = (await detectPreviewCommands({ folder: root })).map((c) => c.id)
    expect(ids).toContain('pkg:dev')
    expect(ids).not.toContain('static:.')
    expect(ids).not.toContain('static:public')
    write('dist/index.html', '<!doctype html><div id="root"></div>')
    ids = (await detectPreviewCommands({ folder: root })).map((c) => c.id)
    expect(ids).toContain('static:dist')
    expect(ids).not.toContain('static:.')
  })

  it('a vite.config alone marks it too; a plain page is still served as it is', async () => {
    write('vite.config.ts', 'export default {}')
    write('index.html', '<p>x</p>')
    expect((await detectPreviewCommands({ folder: root })).map((c) => c.id)).not.toContain('static:.')
    rmSync(join(root, 'vite.config.ts'))
    expect((await detectPreviewCommands({ folder: root })).map((c) => c.id)).toContain('static:.')
  })
})

describe('the static server falls back as hosts do', () => {
  it('an inner page of a single-page site gets index.html; with only a 404.html, that page with a 404', async () => {
    write('index.html', '<p>app</p>')
    write('_redirects', '# comment\n/*    /index.html   200\n')
    expect(await fallbackFor(root, '/about')).toEqual({
      path: expect.stringMatching(/index\.html$/) as string,
      status: 200,
    })
    // A file that is not there stays a 404 (only addresses that look like pages fall back).
    expect(await fallbackFor(root, '/missing.js')).toBeNull()
    rmSync(join(root, '_redirects'))
    expect(await fallbackFor(root, '/about')).toBeNull()
    write('404.html', '<p>not found</p>')
    expect(await fallbackFor(root, '/about?x=1')).toEqual({
      path: expect.stringMatching(/404\.html$/) as string,
      status: 404,
    })
  })

  it('serves it over loopback', async () => {
    write('index.html', '<p>app</p>')
    write('_redirects', '/* /index.html 200\n')
    const server = await startStaticServer(root)
    try {
      const inner = await fetch(new URL('about/team', server.url))
      expect(inner.status).toBe(200)
      expect(await inner.text()).toBe('<p>app</p>')
      expect((await fetch(new URL('nope.css', server.url))).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('the web starter', () => {
  const templates = readBuiltinTemplates()
  const site = templates.find((t) => t.id === 'react-site')
  if (site === undefined) throw new Error('react-site')

  it('may write its root files, public/ and assets/; no other template may', () => {
    expect(templateTargetProblem('index.html')).not.toBeNull()
    expect(templateTargetProblem('package.json')).not.toBeNull()
    expect(templateTargetProblem('public/_redirects')).not.toBeNull()
    expect(templateTargetProblem('index.html', { web: true })).toBeNull()
    expect(templateTargetProblem('public/_redirects', { web: true })).toBeNull()
    expect(templateTargetProblem('assets/README.md', { web: true })).toBeNull()
    expect(templateTargetProblem('.env', { web: true })).not.toBeNull()
    expect(templateTargetProblem('public/../x', { web: true })).not.toBeNull()
    expect(templateTargetProblem('other/x.js', { web: true })).not.toBeNull()
    const { webStarter: _w, ...plain } = site
    expect(TemplateZ.safeParse(plain).success).toBe(false)
    expect(TemplateZ.safeParse(site).success).toBe(true)
  })

  it('copies a project that runs as it is, with its licence noted', async () => {
    const written = await copyTemplateFiles({ template: site, layer: 'builtin' }, root)
    for (const f of [
      'package.json',
      'index.html',
      'src/main.tsx',
      'public/_redirects',
      'public/social-preview.png',
    ])
      expect(written, f).toContain(f)
    expect(written.at(-1)).toBe(VENDORED_FILE)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(Object.keys(pkg.scripts)).toEqual(['dev', 'build', 'preview', 'test'])
    const vendored = readFileSync(join(root, 'lib', 'VENDORED.md'), 'utf8')
    expect(vendored).toContain('(Dim Factory web starter)')
    expect(vendored).toContain('The Dim Factory web starter is under the MIT License')
    expect(vendored).not.toContain('game starter is under')
    // Never over a file that is there.
    await expect(copyTemplateFiles({ template: site, layer: 'builtin' }, root)).rejects.toThrow(
      /already in the project/,
    )
    expect(existsSync(join(root, 'src', 'styles', 'tokens.css'))).toBe(true)
  })
})

describe('the page-load check', () => {
  const report = (o: Partial<PageloadReport> = {}): PageloadReport => ({
    url: 'http://127.0.0.1:1/',
    loaded: true,
    consoleErrors: [],
    failedLoads: [],
    blocked: [],
    durationMs: 10,
    ...o,
  })

  it('is a built-in check, named by its page', () => {
    expect(pageloadArgv('dist/index.html')).toEqual(['dimf:pageload', 'dist/index.html'])
    expect(isPageloadArgv(['dimf:pageload', 'x'])).toBe(true)
    expect(isBuiltinCheckArgv(['dimf:playtest', 'playtest.json'])).toBe(true)
    expect(isBuiltinCheckArgv(['npm', 'test'])).toBe(false)
    expect(pageOf(['dimf:pageload', 'dist/index.html'], root)?.rel).toBe('dist/index.html')
    expect(pageOf(['dimf:pageload'], root)?.rel).toBe('index.html')
    expect(pageOf(['dimf:pageload', '../x.html'], root)).toBeNull()
    expect(pageOf(['dimf:pageload', 'C:/x.html'], root)).toBeNull()
    expect(missingPageReason('dist/index.html')).toMatch(/the build did not make the page/)
    expect(missingPageReason('index.html')).toBe('There is no index.html to open')
  })

  it('passes a clean load; fails on console errors or files that did not load; notes blocked requests', () => {
    expect(pageloadVerdict(report())).toEqual({ status: 'pass' })
    expect(
      pageloadVerdict(report({ blocked: [{ url: 'https://fonts.example/x.css', host: 'fonts.example' }] })),
    ).toEqual({
      status: 'pass',
    })
    expect(pageloadVerdict(report({ loaded: false, error: 'boom' }))).toEqual({
      status: 'fail',
      reason: 'boom',
    })
    expect(
      pageloadVerdict(
        report({
          consoleErrors: [{ message: 'x is not defined' }],
          failedLoads: [{ url: '/a.js', error: '404' }],
        }),
      ),
    ).toEqual({ status: 'fail', reason: 'The page loaded with 1 console error and 1 file that did not load' })
    expect(
      pageloadLogLines(
        'index.html',
        report({ consoleErrors: [{ message: 'x is not defined', source: 'app.js', line: 3 }] }),
      ),
    ).toEqual(['loaded index.html', 'console error: x is not defined (app.js:3)'])
  })

  it('runs: not here without the app, a missing page fails, and the checker sees the page in its folder', async () => {
    const lines: string[] = []
    const write_ = (t: string): void => {
      lines.push(t)
    }
    const argv = ['dimf:pageload', 'dist/index.html']
    const skipped = await runPageload({
      name: 'Page loads',
      argv,
      cwd: root,
      write: write_,
      checker: undefined,
      signal: undefined,
    })
    expect(skipped.status).toBe('skipped')
    const seen: { folder: string; page: string }[] = []
    let next = report({ consoleErrors: [{ message: 'Uncaught TypeError: boom' }] })
    const checker: PageChecker = (r) => {
      seen.push({ folder: r.folder, page: r.page })
      return Promise.resolve({ kind: 'report', report: next })
    }
    const missing = await runPageload({
      name: 'Page loads',
      argv,
      cwd: root,
      write: write_,
      checker,
      signal: undefined,
    })
    expect(missing).toMatchObject({ status: 'fail', reason: missingPageReason('dist/index.html') })
    expect(seen).toEqual([])
    write('dist/index.html', '<p>x</p>')
    const failed = await runPageload({
      name: 'Page loads',
      argv,
      cwd: root,
      write: write_,
      checker,
      signal: undefined,
    })
    expect(failed.status).toBe('fail')
    expect(failed.excerpt).toContain('console error: Uncaught TypeError: boom')
    expect(seen).toEqual([{ folder: join(root, 'dist'), page: 'index.html' }])
    next = report()
    const passed = await runPageload({
      name: 'Page loads',
      argv,
      cwd: root,
      write: write_,
      checker,
      signal: undefined,
    })
    expect(passed.status).toBe('pass')
    expect(lines.join('')).toContain('loaded dist/index.html')
  })
})
