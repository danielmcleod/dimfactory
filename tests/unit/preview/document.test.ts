// The rendered document view (preview/document.ts) and its detection (preview/detect.ts): Markdown shown as a page
// with raw HTML as text, links and images kept to safe targets, a folder of pages as one page with contents in reading
// order; served on loopback with a policy that allows no script; the PDF's name; the documents a folder offers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DOC_CSP,
  pageOrder,
  pdfNameOf,
  renderDocument,
  safeHref,
  sectionId,
  startDocumentServer,
  topDocuments,
} from '@core/preview/document.ts'
import { detectPreviewCommands } from '@core/preview/detect.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-doc-'))
  dirs.push(d)
  return d
}

function get(
  url: string,
  host?: string,
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname, headers: host !== undefined ? { host } : {} },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('renderDocument', () => {
  it('shows raw HTML as text and keeps links and images to safe targets', async () => {
    const root = temp()
    writeFileSync(
      join(root, 'memo.md'),
      [
        '# Booking options',
        '',
        '<script>alert(1)</script>',
        '<img src=x onerror="alert(2)">',
        '',
        '[evil](javascript:alert(3)) [site](https://example.com) [mail](mailto:a@b.c) [file](notes.txt)',
        '',
        '![logo](assets/logo.png) ![bad](javascript:x) ![data](data:image/png;base64,AAAA)',
      ].join('\n'),
    )
    const page = await renderDocument(root, 'memo.md')
    expect(page.title).toBe('Booking options')
    expect(page.html).not.toContain('<script>alert')
    expect(page.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page.html).not.toMatch(/<img[^>]*onerror/)
    expect(page.html).not.toContain('javascript:')
    expect(page.html).toContain('href="https://example.com"')
    expect(page.html).toContain('href="mailto:a@b.c"')
    expect(page.html).toContain('href="/notes.txt"')
    expect(page.html).toContain('src="/assets/logo.png"')
    expect(page.html).toContain('src="data:image/png;base64,AAAA"')
    expect(page.html).toContain(DOC_CSP)
  })

  it('shows a folder of pages as one page with contents, in reading order, links between pages as sections', async () => {
    const root = temp()
    const docs = join(root, 'docs')
    mkdirSync(docs)
    writeFileSync(join(docs, 'shipping.md'), '# Shipping\n\nSee [ordering](ordering.md).\n')
    writeFileSync(join(docs, 'getting-started.md'), '# Getting started\n')
    writeFileSync(join(docs, 'index.md'), '# Knitting shop help\n\n![yarn](img/yarn.png)\n')
    writeFileSync(join(docs, 'ordering.md'), '# Ordering\n')
    const page = await renderDocument(root, 'docs')
    expect(page.title).toBe('Knitting shop help')
    const order = ['Knitting shop help', 'Getting started', 'Ordering', 'Shipping'].map((t) =>
      page.html.indexOf(`>${t}<`),
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(page.html).toContain('<nav class="contents"')
    expect(page.html).toContain(`href="#${sectionId('ordering.md')}"`)
    expect(page.html).toContain('src="/docs/img/yarn.png"')
  })

  it('helpers: page order, section ids, safe hrefs, the PDF name', () => {
    expect(pageOrder(['z.md', 'getting-started.md', 'a.md', 'index.md'])).toEqual([
      'index.md',
      'getting-started.md',
      'a.md',
      'z.md',
    ])
    expect(sectionId('docs/Getting Started.md')).toBe('page-getting-started')
    const pages = new Set(['a.md'])
    expect(safeHref('vbscript:x', { image: false, pages })).toBe('#')
    expect(safeHref('//evil.example/x', { image: false, pages })).toBe('#')
    expect(safeHref('../../outside.txt', { image: false, pages })).toBe('#')
    expect(safeHref('a.md#part', { image: false, pages })).toBe('#part')
    expect(safeHref('https://x.y/a.png', { image: true, pages })).toBe('#')
    expect(pdfNameOf('memo.md')).toBe('memo.pdf')
    expect(pdfNameOf('docs')).toBe('docs.pdf')
    expect(pdfNameOf('docs/')).toBe('docs.pdf')
  })
})

describe('startDocumentServer', () => {
  it('serves the page on loopback with no script allowed, the files read-only, and checks the Host', async () => {
    const root = temp()
    writeFileSync(join(root, 'memo.md'), '# Memo\n')
    writeFileSync(join(root, '.env'), 'SECRET=1')
    writeFileSync(join(root, 'notes.txt'), 'hello')
    const server = await startDocumentServer(root, 'memo.md')
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      const page = await get(server.url)
      expect(page.status).toBe(200)
      expect(page.headers['content-security-policy']).toBe(DOC_CSP)
      expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'")
      expect(page.body).toContain('<h1>Memo</h1>')
      expect((await get(`${server.url}notes.txt`)).body).toBe('hello')
      expect((await get(`${server.url}.env`)).status).toBe(403)
      expect((await get(`${server.url}..%2f..%2fx`)).status).toBeGreaterThanOrEqual(400)
      expect((await get(server.url, 'evil.example')).status).toBe(421)
    } finally {
      await server.close()
    }
  })
})

describe('document detection', () => {
  it('offers each top-level document and a docs/ folder, after the other ways, needing no trust', async () => {
    const root = temp()
    writeFileSync(join(root, 'memo.md'), '# Memo\n')
    writeFileSync(join(root, 'README.md'), '# Read me\n')
    writeFileSync(join(root, 'index.html'), '<!doctype html>')
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'index.md'), '# Docs\n')
    expect(await topDocuments(root)).toEqual(['memo.md'])
    const commands = await detectPreviewCommands({ folder: root })
    expect(commands.map((c) => [c.id, c.kind, c.trust, c.docPath])).toEqual([
      ['static:.', 'static', 'none', undefined],
      ['doc:memo.md', 'document', 'none', 'memo.md'],
      ['doc:docs', 'document', 'none', 'docs'],
    ])
    expect(commands[1]?.label).toBe('Read memo.md')
    expect(commands[2]?.label).toBe('Read docs/ (1 page)')
  })
})
