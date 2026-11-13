// Dim Factory's read-only static server: bound to 127.0.0.1, serving only inside its folder. Path traversal (plain,
// encoded, backslashed, a drive or stream colon), dot files, a symlink or junction that leaves the folder, methods
// other than GET/HEAD, a foreign Host header, directory listings: all refused. Content types by extension, HEAD with
// no body, a folder's index.html behind a redirect to its slash form.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  contentTypeOf,
  resolveRequestPath,
  startStaticServer,
} from '../../../src/core/preview/static-server.ts'
import type { StaticServer } from '../../../src/core/preview/static-server.ts'
import { removeDir, tempDir, writeFiles } from '../verify/helpers.ts'

let base = ''
let site = ''
let server: StaticServer | null = null

beforeEach(() => {
  base = tempDir('dim-factory-static-')
  site = join(base, 'site')
  writeFiles(base, {
    'secret.txt': 'outside the folder',
    'site/index.html': '<h1>home</h1>',
    'site/app.js': 'console.log(1)',
    'site/style.css': 'body{}',
    'site/data.json': '{}',
    'site/logo.svg': '<svg/>',
    'site/font.woff2': 'x',
    'site/blob.xyz': 'x',
    'site/docs/index.html': '<h1>docs</h1>',
    'site/empty/readme.txt': 'no index here',
    'site/.env': 'TOKEN=1',
    'site/.git/config': '[core]',
    'site/.well-known/security.txt': 'contact',
  })
})

afterEach(async () => {
  await server?.close()
  server = null
  removeDir(base)
})

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function send(path: string, o: { method?: string; host?: string } = {}): Promise<Answer> {
  const s = server as StaticServer
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: s.port,
        method: o.method ?? 'GET',
        path,
        headers: { host: o.host ?? `127.0.0.1:${s.port}` },
      },
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

describe('the static server', () => {
  it('listens on 127.0.0.1 only, on a port the OS picked', async () => {
    server = await startStaticServer(site)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`)
    expect(server.port).toBeGreaterThan(0)
  })

  it('serves files with their content types, nosniff and no caching', async () => {
    server = await startStaticServer(site)
    const home = await send('/')
    expect(home.status).toBe(200)
    expect(home.body).toBe('<h1>home</h1>')
    expect(home.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(home.headers['x-content-type-options']).toBe('nosniff')
    expect(home.headers['cache-control']).toBe('no-store')
    expect((await send('/app.js')).headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect((await send('/style.css')).headers['content-type']).toBe('text/css; charset=utf-8')
    expect((await send('/data.json')).headers['content-type']).toBe('application/json; charset=utf-8')
    expect((await send('/logo.svg')).headers['content-type']).toBe('image/svg+xml')
    expect((await send('/font.woff2')).headers['content-type']).toBe('font/woff2')
    expect((await send('/blob.xyz')).headers['content-type']).toBe('application/octet-stream')
    expect((await send('/app.js?v=2')).status).toBe(200)
    expect(contentTypeOf('A.PNG')).toBe('image/png')
  })

  it('answers HEAD without a body and refuses every other method', async () => {
    server = await startStaticServer(site)
    const head = await send('/index.html', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(head.headers['content-length']).toBe(String('<h1>home</h1>'.length))
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await send('/index.html', { method })
      expect(r.status, method).toBe(405)
      expect(r.headers['allow']).toBe('GET, HEAD')
    }
  })

  it('serves a folder only through its index.html: a redirect to the slash form, never a listing', async () => {
    server = await startStaticServer(site)
    const redirect = await send('/docs')
    expect(redirect.status).toBe(301)
    expect(redirect.headers['location']).toBe('/docs/')
    expect((await send('/docs/')).body).toBe('<h1>docs</h1>')
    expect((await send('/empty/')).status).toBe(404)
    expect((await send('/missing.html')).status).toBe(404)
  })

  it.each([
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/docs/..%2f..%2fsecret.txt',
    '/..%5csecret.txt',
    '/%2e%2e%5csecret.txt',
    '/C:%5cWindows%5cwin.ini',
    '/index.html::$DATA',
    '/.env',
    '/.git/config',
    '/%00index.html',
  ])('refuses %s', async (path) => {
    server = await startStaticServer(site)
    const r = await send(path)
    expect([400, 403, 404]).toContain(r.status)
    expect(r.body).not.toContain('outside the folder')
    expect(r.body).not.toContain('TOKEN')
  })

  it('serves .well-known, and refuses a protocol-relative path and a malformed escape', async () => {
    server = await startStaticServer(site)
    expect((await send('/.well-known/security.txt')).body).toBe('contact')
    expect((await send('//evil.test/docs')).status).toBe(400)
    expect((await send('/%E0%A4%A')).status).toBe(400)
  })

  it('refuses a Host header that is not its own (DNS rebinding)', async () => {
    server = await startStaticServer(site)
    expect((await send('/', { host: 'evil.test' })).status).toBe(421)
    expect((await send('/', { host: `localhost:${server.port}` })).status).toBe(200)
  })

  it('follows a link only while it stays inside the folder', async () => {
    mkdirSync(join(base, 'outside'))
    writeFileSync(join(base, 'outside', 'index.html'), 'escaped')
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(join(base, 'outside'), join(site, 'out-link'), type)
    symlinkSync(join(site, 'docs'), join(site, 'in-link'), type)
    server = await startStaticServer(site)
    const out = await send('/out-link/index.html')
    expect(out.status).toBe(403)
    expect(out.body).not.toContain('escaped')
    expect((await send('/in-link/index.html')).body).toBe('<h1>docs</h1>')
  })

  it('maps request paths without the network too', async () => {
    const { realpathSync } = await import('node:fs')
    // The native realpath, as the server's own (the JS one keeps a Windows 8.3 short name as written).
    const real = realpathSync.native(site)
    expect(await resolveRequestPath(real, '/docs/')).toEqual({
      kind: 'file',
      path: realpathSync.native(join(site, 'docs', 'index.html')),
    })
    expect(await resolveRequestPath(real, 'index.html')).toEqual({ kind: 'error', status: 400 })
    expect(await resolveRequestPath(real, '/a/../index.html')).toEqual({ kind: 'error', status: 403 })
  })

  it('stops listening when closed', async () => {
    server = await startStaticServer(site)
    const port = server.port
    await server.close()
    await expect(
      new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/' }, resolve)
        req.on('error', reject)
        req.end()
      }),
    ).rejects.toThrow()
    server = null
  })
})
