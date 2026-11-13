// The built renderer on app:// (no "file://" reads;
// boot hardening; src/main/renderer-files.ts). Main registers `app` before ready as a standard, secure scheme
// with fetch and nothing more, and answers app://dim-factory/<file> from the built renderer folder only: a built file
// goes out with its content type, the CSP as a header and nosniff; traversal in any spelling (`..`, encoded dots,
// encoded separators of either kind), an NTFS stream, a NUL, a device name, another host, port or user, the folder
// itself and anything unparseable are refused; a missing file is a 404; only GET and HEAD are answered. file:// is
// refused to the window's session whatever the target, the built renderer's own files included. Every answer, each
// refusal included, carries the CSP header, nosniff and no-cache. Every file of the
// build passes the name rule with a known content type, and none is .wasm. security.spec.ts repeats the handler's
// checks through Chromium's own URL handling.
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { RENDERER_CSP_HEADER } from '../../../src/main/csp.ts'
import {
  APP_SCHEME_PRIVILEGES,
  contentTypeOf,
  installRendererFiles,
  isSafeFileName,
  registerAppScheme,
  rendererBaseHeaders,
  rendererFileFor,
  rendererFileHeaders,
} from '../../../src/main/renderer-files.ts'
import type { ProtocolLike } from '../../../src/main/renderer-files.ts'
import { APP_INDEX_URL, rendererTarget } from '../../../src/main/urls.ts'

const rendererDir = resolve('out', 'renderer')
const target = rendererTarget({ devUrl: undefined, packaged: true, rendererDir })
const devTarget = rendererTarget({ devUrl: 'http://localhost:5173/', packaged: false, rendererDir })
const at = (...parts: string[]): string => join(rendererDir, ...parts)

describe('the app scheme', () => {
  it('is registered as standard and secure with fetch, and nothing that would widen it', () => {
    const registerSchemesAsPrivileged = vi.fn()
    registerAppScheme({ registerSchemesAsPrivileged })
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ])
    // No bypassCSP, service workers, CORS from other origins, streaming, extensions or code cache.
    expect(Object.keys(APP_SCHEME_PRIVILEGES).sort()).toEqual(['secure', 'standard', 'supportFetchAPI'])
  })

  it('the built target loads app://dim-factory/index.html from the renderer folder', () => {
    expect(target).toEqual({
      kind: 'app',
      dir: rendererDir,
      url: 'app://dim-factory/index.html',
      origin: 'app://dim-factory',
    })
    expect(APP_INDEX_URL).toBe('app://dim-factory/index.html')
  })
})

describe('rendererFileFor', () => {
  it('serves the built files with their content types', () => {
    expect(rendererFileFor('app://dim-factory/index.html', rendererDir)).toEqual({
      kind: 'serve',
      path: at('index.html'),
      contentType: 'text/html; charset=utf-8',
    })
    expect(rendererFileFor('app://dim-factory/assets/index-CU7tUf8N.js', rendererDir)).toEqual({
      kind: 'serve',
      path: at('assets', 'index-CU7tUf8N.js'),
      contentType: 'text/javascript; charset=utf-8',
    })
    // A module worker is a JavaScript file like any other (strict MIME checking refuses anything else).
    expect(rendererFileFor('app://dim-factory/assets/worker-CrcNF_Qa.js', rendererDir)).toMatchObject({
      kind: 'serve',
      contentType: 'text/javascript; charset=utf-8',
    })
    expect(rendererFileFor('app://dim-factory/assets/PatchView--7XsiFwe.js', rendererDir)).toMatchObject({
      kind: 'serve',
    })
    expect(rendererFileFor('app://dim-factory/assets/index-BavEQh0i.css', rendererDir)).toMatchObject({
      contentType: 'text/css; charset=utf-8',
    })
    expect(rendererFileFor('app://dim-factory/assets/font.woff2', rendererDir)).toMatchObject({
      contentType: 'font/woff2',
    })
    expect(rendererFileFor('app://dim-factory/assets/data.bin', rendererDir)).toMatchObject({
      contentType: 'application/octet-stream',
    })
    // A query, a hash or the host's case does not change which file it is.
    expect(rendererFileFor('app://dim-factory/index.html?x=1#/runs/a', rendererDir)).toMatchObject({
      kind: 'serve',
      path: at('index.html'),
    })
    expect(rendererFileFor('app://DIM-FACTORY/index.html', rendererDir)).toMatchObject({ kind: 'serve' })
  })

  it.each([
    ['`..`', 'app://dim-factory/../main/index.js'],
    ['`..` deeper down', 'app://dim-factory/assets/../../main/index.js'],
    ['an encoded `..`', 'app://dim-factory/assets/%2e%2e/%2E%2e/main/index.js'],
    ['a half-encoded `..`', 'app://dim-factory/assets/.%2e/%2e./main/index.js'],
  ])('resolves %s inside the folder (the URL parser drops it), never above it', (_what, u) => {
    const d = rendererFileFor(u, rendererDir)
    expect(d).toEqual({
      kind: 'serve',
      path: at('main', 'index.js'),
      contentType: 'text/javascript; charset=utf-8',
    })
    // out/renderer/main/index.js does not exist: the read answers 404 (installRendererFiles below).
    if (d.kind === 'serve') expect(relative(rendererDir, d.path).startsWith('..')).toBe(false)
  })

  it.each([
    ['an encoded slash', 'app://dim-factory/assets/..%2f..%2fmain%2findex.js'],
    ['an encoded backslash', 'app://dim-factory/assets/..%5c..%5cmain%5cindex.js'],
    ['a literal backslash', 'app://dim-factory/assets\\..\\..\\main\\index.js'],
    ['a segment of encoded dots and a separator', 'app://dim-factory/%2e%2e%2fmain/index.js'],
    ['an NTFS stream', 'app://dim-factory/index.html::$DATA'],
    ['a named stream', 'app://dim-factory/assets/a.js:evil'],
    ['a drive', 'app://dim-factory/C:/Windows/win.ini'],
    ['an encoded drive', 'app://dim-factory/C%3A%5CWindows%5Cwin.ini'],
    ['a NUL', 'app://dim-factory/index.html%00.js'],
    ['a trailing dot', 'app://dim-factory/index.html.'],
    ['a trailing space', 'app://dim-factory/index.html%20'],
    ['a dot segment kept by encoding', 'app://dim-factory/assets/%2e'],
    ['a device name', 'app://dim-factory/NUL'],
    ['a device name with an extension', 'app://dim-factory/assets/con.js'],
    ['another device', 'app://dim-factory/com1.js'],
    ['an empty segment', 'app://dim-factory/assets//index.js'],
    ['a trailing slash', 'app://dim-factory/assets/'],
    ['a percent sign', 'app://dim-factory/assets/%2525.js'],
    ['another host', 'app://other/index.html'],
    ['a look-alike host', 'app://dim-factory.evil/index.html'],
    ['a port', 'app://dim-factory:8080/index.html'],
    ['a user', 'app://user@dim-factory/index.html'],
  ])('refuses %s', (_what, u) => {
    expect(rendererFileFor(u, rendererDir)).toMatchObject({ kind: 'refuse', status: 403 })
  })

  it('answers 404 for the folder itself and other schemes, 400 for what cannot be read', () => {
    expect(rendererFileFor('app://dim-factory/', rendererDir)).toMatchObject({ kind: 'refuse', status: 404 })
    expect(rendererFileFor('app://dim-factory', rendererDir)).toMatchObject({ kind: 'refuse', status: 404 })
    expect(rendererFileFor(pathToFileURL(at('index.html')).href, rendererDir)).toMatchObject({
      kind: 'refuse',
      status: 404,
    })
    expect(rendererFileFor('https://dim-factory/index.html', rendererDir)).toMatchObject({ status: 404 })
    expect(rendererFileFor('app://dim-factory/%E0%A4%A.js', rendererDir)).toMatchObject({ status: 400 })
    expect(rendererFileFor('not a url', rendererDir)).toMatchObject({ status: 400 })
  })

  it('holds the result inside the folder whatever the platform', () => {
    const win = 'C:\\App\\out\\renderer'
    expect(rendererFileFor('app://dim-factory/assets/a.js', win, 'win32')).toMatchObject({ kind: 'serve' })
    expect(rendererFileFor('app://dim-factory/assets/a.js:x', win, 'win32')).toMatchObject({ status: 403 })
  })
})

describe('file names', () => {
  it('accepts what Vite writes and nothing that names another file', () => {
    for (const ok of [
      'index.html',
      'index-CU7tUf8N.js',
      'PatchView--7XsiFwe.js',
      '_base-x.js',
      'a~b+c@d.css',
    ]) {
      expect(isSafeFileName(ok), ok).toBe(true)
    }
    for (const bad of [
      '',
      '.',
      '..',
      '.hidden',
      'a/b',
      'a\\b',
      'a:b',
      'a.js.',
      'a ',
      'a b',
      'a%2e',
      'a\0',
      'CON',
      'nul.txt',
      'Com9.js',
      'lpt1',
      '$MFT',
    ]) {
      expect(isSafeFileName(bad), JSON.stringify(bad)).toBe(false)
    }
    // A device's name as the start of a longer name is an ordinary file (Shiki's `coq-…`, a `console-…` chunk).
    expect(isSafeFileName('con-abc.js')).toBe(true)
    expect(isSafeFileName('console-abc.js')).toBe(true)
  })

  it.skipIf(!existsSync(rendererDir))(
    'every file of the build is served by its name, with a known content type, and none is .wasm',
    () => {
      const files = readdirSync(rendererDir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(rendererDir, join(e.parentPath, e.name)))
      expect(files).toContain('index.html')
      for (const f of files) {
        const url = `app://dim-factory/${f.split(sep).join('/')}`
        const d = rendererFileFor(url, rendererDir)
        expect(d, f).toMatchObject({ kind: 'serve', path: at(f) })
        expect(contentTypeOf(f), f).not.toBe('application/octet-stream')
        expect(f.toLowerCase().endsWith('.wasm'), f).toBe(false)
      }
    },
  )
})

describe('the served headers', () => {
  it('carry the policy, nosniff and the content type', () => {
    expect(rendererFileHeaders('text/html; charset=utf-8')).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': RENDERER_CSP_HEADER,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    })
  })

  it('every answer, a refusal included, carries the policy, nosniff and no-cache', () => {
    expect(rendererBaseHeaders()).toEqual({
      'Content-Security-Policy': RENDERER_CSP_HEADER,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    })
  })
})

/** The base headers on an answer (rendererBaseHeaders). */
function expectBaseHeaders(r: Response, what: string): void {
  expect(r.headers.get('content-security-policy'), what).toBe(RENDERER_CSP_HEADER)
  expect(r.headers.get('x-content-type-options'), what).toBe('nosniff')
  expect(r.headers.get('cache-control'), what).toBe('no-cache')
}

describe('installRendererFiles', () => {
  function install(files: Record<string, string>, t = target) {
    const handlers = new Map<string, (r: Request) => Response | Promise<Response>>()
    const protocol: ProtocolLike = {
      handle: (scheme, h) => {
        expect(handlers.has(scheme), scheme).toBe(false)
        handlers.set(scheme, h)
      },
    }
    const warn = vi.fn()
    const readFile = vi.fn((p: string) => {
      const body = files[p]
      return body === undefined
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(new TextEncoder().encode(body))
    })
    const installed = installRendererFiles({ target: t, protocol, readFile, log: { warn } })
    const send = async (u: string, method = 'GET'): Promise<Response> => {
      const scheme = new URL(u).protocol.slice(0, -1)
      const h = handlers.get(scheme)
      if (h === undefined) throw new Error(`no ${scheme} handler`)
      return h(new Request(u, { method }))
    }
    return { installed, handlers, send, warn, readFile }
  }

  it('answers app:// from the built renderer: its files with the policy, nothing else', async () => {
    const { installed, handlers, send, warn, readFile } = install({
      [at('index.html')]: '<!doctype html>',
      [at('assets', 'worker-a.js')]: 'export {}',
    })
    expect(installed).toBe(true)
    expect([...handlers.keys()].sort()).toEqual(['app', 'file'])

    const ok = await send('app://dim-factory/index.html')
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('<!doctype html>')
    expect(ok.headers.get('content-security-policy')).toBe(RENDERER_CSP_HEADER)
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-type')).toBe('text/html; charset=utf-8')

    const worker = await send('app://dim-factory/assets/worker-a.js')
    expect(worker.status).toBe(200)
    expect(worker.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(worker.headers.get('content-security-policy')).toBe(RENDERER_CSP_HEADER)

    const head = await send('app://dim-factory/index.html', 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-security-policy')).toBe(RENDERER_CSP_HEADER)
    expect(await head.text()).toBe('')

    const post = await send('app://dim-factory/index.html', 'POST')
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
    expect(await post.text()).toBe('')
    expectBaseHeaders(post, 'POST')

    const unsafe = await send('app://dim-factory/assets/..%2f..%2fmain%2findex.js')
    expect(unsafe.status).toBe(403)
    expect(await unsafe.text()).toBe('')
    expect(warn).toHaveBeenCalledWith('refused an app request', { reason: 'an unsafe path' })
    expect((await send('app://other/index.html')).status).toBe(403)

    // Missing, or resolved inside the folder to a file that is not there: 404, and nothing outside was read.
    expect((await send('app://dim-factory/assets/missing.js')).status).toBe(404)
    expect((await send('app://dim-factory/assets/%2e%2e/%2e%2e/main/index.js')).status).toBe(404)
    for (const [p] of readFile.mock.calls) {
      expect(relative(rendererDir, p).startsWith('..'), p).toBe(false)
    }
  })

  it('answers every refusal with the base headers and no body: 400, 403, 404 and 405', async () => {
    const { send } = install({ [at('index.html')]: '<!doctype html>' })
    const cases: [string, string, number][] = [
      ['GET', 'app://dim-factory/index.html', 200],
      ['GET', 'app://dim-factory/assets/%E0%A4%A.js', 400],
      ['GET', 'app://dim-factory/assets/..%2f..%2fmain%2findex.js', 403],
      ['GET', 'app://other/index.html', 403],
      ['GET', 'app://dim-factory/', 404],
      // Allowed by the name rule, then not read: the read's own failure.
      ['GET', 'app://dim-factory/assets/missing.js', 404],
      ['HEAD', 'app://dim-factory/assets/missing.js', 404],
      ['PUT', 'app://dim-factory/index.html', 405],
      ['OPTIONS', 'app://dim-factory/index.html', 405],
      ['GET', pathToFileURL(resolve('package.json')).href, 403],
    ]
    for (const [method, u, status] of cases) {
      const r = await send(u, method)
      expect(r.status, `${method} ${u}`).toBe(status)
      expectBaseHeaders(r, `${method} ${u}`)
      if (status !== 200) expect(await r.text(), `${method} ${u}`).toBe('')
    }
  })

  it('refuses every file:// request, the built renderer itself included', async () => {
    const { send, warn, readFile } = install({ [at('index.html')]: '<!doctype html>' })
    for (const u of [
      pathToFileURL(at('index.html')).href,
      pathToFileURL(resolve('package.json')).href,
      'file://evil-host/share/index.html',
    ]) {
      const r = await send(u)
      expect(r.status, u).toBe(403)
      expect(await r.text()).toBe('')
    }
    expect(readFile).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('refused a file request', { reason: 'file:// is not served' })
  })

  it('with the dev server: file:// still refused, no app:// to serve', async () => {
    const { installed, handlers, send } = install({}, devTarget)
    expect(installed).toBe(false)
    expect([...handlers.keys()]).toEqual(['file'])
    expect((await send(pathToFileURL(resolve('package.json')).href)).status).toBe(403)
  })
})
