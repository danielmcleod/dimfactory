// The rendered document view (Run & Preview's `document` kind): a project's Markdown shown as a readable page by Dim
// Factory itself, the way its static server shows a folder of plain files.
//
// - What is shown: one Markdown file (`memo.md`), or a folder of them (`docs/`: index.md first, then getting-started.md,
//   then the rest by name) as one page with a contents list, each file a section of its own. Links between those files
//   become links to their sections.
// - Rendering (marked): raw HTML in the Markdown is shown as text, never as HTML; a link may go to http(s), mailto, a
//   section or a file in the project (nothing else: `javascript:` and the like become `#`); an image may be a project
//   file or a data: image.
// - Serving (the static server's rules, static-server.ts): 127.0.0.1 only, the Host header checked, GET and HEAD, files
//   only inside the project's real path, no dot files. The page is `/`; it carries a Content-Security-Policy that
//   allows no script, no frame, no form and no connection, with images from the page's own origin or data: only.
//   Any other path serves the project's files read-only (the document's images).
// - Save as PDF prints this same page (main/preview.ts), so the PDF is what the window shows.
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname, join, posix } from 'node:path'
import { Marked } from 'marked'
import type { Token, Tokens } from 'marked'
import { contentTypeOf, resolveRequestPath, STATIC_HOST } from './static-server.ts'
import type { StaticServer } from './static-server.ts'

/** The most Markdown files a folder document shows, and the largest one read. */
export const DOC_MAX_FILES = 60
export const DOC_MAX_BYTES = 2 * 1024 * 1024

/** The page's policy: no script, frame, form or connection; its own styles; images from itself or data:. */
export const DOC_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** Markdown files never shown as a document of their own (project housekeeping). */
const HOUSEKEEPING =
  /^(?:readme|run|changelog|license|licence|contributing|code_of_conduct|security|agents|claude|dimfactory)\.md$/i

const isMarkdown = (name: string): boolean => /\.(?:md|markdown)$/i.test(name)

/** Order a folder's pages: index (or README) first, getting started next, then by name. */
export function pageOrder(names: readonly string[]): string[] {
  const rank = (n: string): number => {
    const b = n.toLowerCase()
    if (b === 'index.md' || b === 'readme.md') return 0
    if (b.startsWith('getting-started') || b.startsWith('getting_started') || b.startsWith('start')) return 1
    return 2
  }
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en'))
}

/** The top-level Markdown documents of a folder worth showing (not README, RUN, CHANGELOG...). */
export async function topDocuments(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile() && isMarkdown(e.name) && !HOUSEKEEPING.test(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

/** A folder's Markdown pages (one level, at most DOC_MAX_FILES), in reading order. */
export async function folderPages(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const names = entries
    .filter((e) => e.isFile() && isMarkdown(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
  return pageOrder(names).slice(0, DOC_MAX_FILES)
}

const ESC: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c)

/** A section id for a file (`docs/getting-started.md` → `page-getting-started`). */
export function sectionId(file: string): string {
  const stem = basename(file).replace(/\.(?:md|markdown)$/i, '')
  return `page-${
    stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'page'
  }`
}

/**
 * A link or image target as the page may use it: a section, a page of the set (its section), a project file
 * (relative), http(s) or mailto for a link, data: for an image; anything else is `#`.
 */
export function safeHref(
  href: string,
  o: { image: boolean; pages: ReadonlySet<string>; base?: string },
): string {
  const h = href.trim()
  if (h === '' || h.startsWith('#')) return h || '#'
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h)?.[1]?.toLowerCase()
  if (scheme !== undefined) {
    if (o.image)
      return scheme === 'data' && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);/i.test(h) ? h : '#'
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? h : '#'
  }
  if (h.startsWith('//') || h.startsWith('\\')) return '#'
  const [path = '', anchor] = h.split('#', 2)
  const name = basename(path.replace(/\\/g, '/'))
  if (!o.image && isMarkdown(name) && o.pages.has(name.toLowerCase())) {
    return anchor !== undefined && anchor !== '' ? `#${anchor}` : `#${sectionId(name)}`
  }
  // A project file, from the page's own folder (the page itself is served at the top).
  if (h.startsWith('/')) return h
  // A path that climbs out of the project goes nowhere.
  const rel = posix.normalize(posix.join(o.base ?? '', h.replace(/\\/g, '/')))
  return rel === '..' || rel.startsWith('../') ? '#' : `/${rel === '.' ? '' : rel}`
}

function renderer(pages: ReadonlySet<string>, base: string): Marked {
  return new Marked({
    gfm: true,
    walkTokens(token: Token) {
      if (token.type === 'link') {
        const t = token as Tokens.Link
        t.href = safeHref(t.href, { image: false, pages, base })
      } else if (token.type === 'image') {
        const t = token as Tokens.Image
        t.href = safeHref(t.href, { image: true, pages, base })
      }
    },
    renderer: {
      // Raw HTML in the Markdown is text on the page, never markup.
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text)
      },
    },
  })
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1f2328;--bg:#ffffff;--muted:#57606a;--line:#d0d7de;--code:#f6f8fa;--link:#0a58ca}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9da7b3;--line:#30363d;--code:#161b22;--link:#6cb6ff}}
html{background:var(--bg);color:var(--fg)}
body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:46rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .6em}
h1{font-size:1.9rem}h2{font-size:1.45rem;border-bottom:1px solid var(--line);padding-bottom:.25em}
a{color:var(--link)}
code{font:0.9em ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);padding:.1em .3em;border-radius:4px}
pre{background:var(--code);padding:.8em 1em;border-radius:6px;overflow:auto}pre code{padding:0;background:none}
table{border-collapse:collapse;margin:1em 0;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:.35em .7em;text-align:left}
blockquote{margin:1em 0;padding:0 1em;border-left:4px solid var(--line);color:var(--muted)}
img{max-width:100%}
nav.contents{border:1px solid var(--line);border-radius:8px;padding:.6em 1.2em;margin:0 0 2rem}
nav.contents ol{margin:.3em 0;padding-left:1.4em}
section.page+section.page{margin-top:3rem;border-top:2px solid var(--line);padding-top:1rem}
@media print{:root{--fg:#000;--bg:#fff;--muted:#444;--line:#bbb;--code:#f3f3f3}body{max-width:none;padding:0}nav.contents{break-after:page}section.page+section.page{break-before:page;border-top:none}a{color:inherit}}
`

/** The first heading of a Markdown text, for the contents list and the title. */
function firstHeading(md: string): string | undefined {
  const m = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(md)
  return m?.[1]?.trim()
}

export interface DocumentPage {
  title: string
  html: string
}

/**
 * The page for `doc` under `root` (a project-relative Markdown file, or a folder of them): see the header. Files
 * that cannot be read are named on the page, never fatal.
 */
export async function renderDocument(root: string, doc: string): Promise<DocumentPage> {
  const abs = join(root, ...doc.split('/'))
  const st = await stat(abs).catch(() => null)
  const files = st?.isDirectory() === true ? (await folderPages(abs)).map((f) => posix.join(doc, f)) : [doc]
  const pages = new Set(files.map((f) => basename(f).toLowerCase()))
  const md = renderer(
    pages,
    st?.isDirectory() === true ? doc : posix.dirname(doc) === '.' ? '' : posix.dirname(doc),
  )
  const sections: { id: string; title: string; body: string }[] = []
  for (const f of files) {
    const p = join(root, ...f.split('/'))
    let text: string
    try {
      const s = await stat(p)
      text =
        s.size > DOC_MAX_BYTES
          ? `*${escapeHtml(f)} is too large to show here.*`
          : (await readFile(p, 'utf8')).replace(/^\uFEFF/, '')
    } catch {
      text = `*${escapeHtml(f)} could not be read.*`
    }
    const body = await md.parse(text)
    sections.push({ id: sectionId(f), title: firstHeading(text) ?? basename(f), body })
  }
  const title = sections[0]?.title ?? basename(doc)
  const contents =
    sections.length > 1
      ? `<nav class="contents" aria-label="Contents"><strong>Contents</strong><ol>${sections
          .map((s) => `<li><a href="#${s.id}">${escapeHtml(s.title)}</a></li>`)
          .join('')}</ol></nav>`
      : ''
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${DOC_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>`,
    contents,
    ...sections.map((s) => `<section class="page" id="${s.id}">${s.body}</section>`),
    '</main></body></html>',
  ].join('\n')
  return { title, html }
}

/** The PDF's name for a document: `memo.md` → `memo.pdf`, `docs` → `docs.pdf`. */
export function pdfNameOf(doc: string): string {
  const base = basename(doc.replace(/[\\/]+$/, '')) || 'document'
  const stem = isMarkdown(base) ? base.slice(0, base.length - extname(base).length) : base
  return `${stem.replace(/[^A-Za-z0-9._ -]+/g, '-') || 'document'}.pdf`
}

/**
 * Serve the document view of `doc` under `root` on 127.0.0.1 (see the header). The page is rendered again on every
 * load, so a reload shows the files as they are now.
 */
export async function startDocumentServer(
  root: string,
  doc: string,
  o: { onRequest?: (line: string) => void } = {},
): Promise<StaticServer> {
  const rootReal = await realpath(root)
  let port = 0
  const hosts = (): Set<string> => new Set([`${STATIC_HOST}:${port}`, `localhost:${port}`])
  const plain = (res: ServerResponse, status: number, extra: Record<string, string> = {}): number => {
    const body = `${status}\n`
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...extra,
    })
    res.end(body)
    return status
  }
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    if (!hosts().has((req.headers.host ?? '').toLowerCase())) return plain(res, 421)
    const method = req.method ?? ''
    if (method !== 'GET' && method !== 'HEAD') return plain(res, 405, { Allow: 'GET, HEAD' })
    const url = req.url ?? '/'
    const pathOnly = url.split('?')[0] ?? '/'
    if (pathOnly === '/' || pathOnly === '/index.html') {
      const page = await renderDocument(rootReal, doc)
      const body = Buffer.from(page.html, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(body.length),
        'Content-Security-Policy': DOC_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      res.end(method === 'HEAD' ? undefined : body)
      return 200
    }
    const r = await resolveRequestPath(rootReal, url)
    if (r.kind === 'error') return plain(res, r.status)
    if (r.kind === 'redirect') return plain(res, 404)
    const bytes = await readFile(r.path)
    res.writeHead(200, {
      'Content-Type': contentTypeOf(r.path),
      'Content-Length': String(bytes.length),
      'Content-Security-Policy': DOC_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    res.end(method === 'HEAD' ? undefined : bytes)
    return 200
  }
  const server: Server = createServer((req, res) => {
    void handle(req, res)
      .then((status) => o.onRequest?.(`${req.method ?? '?'} ${(req.url ?? '/').slice(0, 300)} ${status}`))
      .catch(() => {
        if (!res.headersSent) plain(res, 404)
        else res.destroy()
      })
  })
  server.keepAliveTimeout = 2000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, STATIC_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port
  let closing: Promise<void> | null = null
  return {
    url: `http://${STATIC_HOST}:${port}/`,
    port,
    root: rootReal,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })),
  }
}
