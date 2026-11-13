// Security pass, CSP (boot hardening; src/main/csp.ts): the
// renderer's policy allows no eval and no inline or remote script, no frames, plugins, forms or <base>, workers only
// from the app's own files (app://), and loads nothing from the network; the header form adds
// frame-ancestors. The built out/renderer/index.html and a packaged app.asar (when they exist) carry it, with no inline
// script. security.spec.ts checks the running app: the page and the highlighter workers refuse eval.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RENDERER_CSP,
  RENDERER_CSP_DIRECTIVES,
  RENDERER_CSP_HEADER,
  parseCsp,
} from '../../../src/main/csp.ts'

const BUILT_INDEX = resolve('out', 'renderer', 'index.html')
const PACKAGED_ASAR = resolve('dist', 'win-unpacked', 'resources', 'app.asar')

/** The security properties every copy of the policy must have (the source, the built page, a packaged page). */
function expectSafePolicy(policy: string): void {
  const p = parseCsp(policy)
  const src = (name: string): string[] => p.get(name) ?? p.get('default-src') ?? []
  expect(p.get('default-src')).toEqual(["'self'"])
  expect(p.get('script-src')).toEqual(["'self'"])
  for (const name of ['default-src', 'script-src', 'worker-src']) {
    const list = src(name).map((s) => s.toLowerCase())
    expect(list, name).not.toContain("'unsafe-eval'")
    expect(list, name).not.toContain("'unsafe-inline'")
    expect(list, name).not.toContain("'wasm-unsafe-eval'")
    expect(list, name).not.toContain("'unsafe-hashes'")
    expect(list, name).not.toContain('data:')
    expect(list, name).not.toContain('*')
  }
  // Workers: the app's own files only; each takes this policy from its own app:// response.
  expect(p.get('worker-src')).toEqual(["'self'"])
  expect(p.get('object-src')).toEqual(["'none'"])
  expect(p.get('base-uri')).toEqual(["'none'"])
  expect(p.get('form-action')).toEqual(["'none'"])
  expect(p.get('frame-src')).toEqual(["'none'"])
  // Nothing loads from the network: no scheme or host source beyond the app's own files, data: and blob:.
  for (const [name, list] of p) {
    for (const s of list) {
      expect(`${name} ${s}`).not.toMatch(/https?:|wss?:|\*|\.[a-z]{2,}$/i)
    }
  }
}

describe('the renderer policy', () => {
  it('has no eval, inline or remote script, no frames, plugins, forms or <base>', () => {
    expectSafePolicy(RENDERER_CSP)
    expect(RENDERER_CSP).toBe(RENDERER_CSP_DIRECTIVES.join('; '))
  })

  it('names each directive once', () => {
    const names = RENDERER_CSP_DIRECTIVES.map((d) => d.split(' ')[0])
    expect(new Set(names).size).toBe(names.length)
  })

  it('the header form adds what only a header carries, and keeps the rest', () => {
    expectSafePolicy(RENDERER_CSP_HEADER)
    expect(RENDERER_CSP_HEADER.startsWith(RENDERER_CSP)).toBe(true)
    expect(parseCsp(RENDERER_CSP_HEADER).get('frame-ancestors')).toEqual(["'none'"])
    // frame-ancestors is ignored in a <meta>, so it is never put there.
    expect(parseCsp(RENDERER_CSP).has('frame-ancestors')).toBe(false)
  })
})

/** The CSP <meta> of a built index.html, and every <script> tag in it. */
function pageOf(html: string): { csp: string | null; scripts: string[] } {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html)
  const csp =
    meta?.[1]
      ?.replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&') ?? null
  return { csp, scripts: [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]) }
}

function expectBuiltPage(html: string): void {
  const page = pageOf(html)
  expect(page.csp, 'the CSP meta').not.toBeNull()
  expectSafePolicy(page.csp ?? '')
  // The policy is the first thing in <head>, before any script or stylesheet.
  expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.search(/<script|<link/i))
  // Every script is a file of the app: none inline (the policy would refuse it anyway).
  expect(page.scripts.length).toBeGreaterThan(0)
  for (const s of page.scripts) {
    expect(s).toMatch(/\ssrc="\.\/assets\/[^"]+\.js"/)
    expect(
      s
        .replace(/<script\b[^>]*>/i, '')
        .replace(/<\/script>$/i, '')
        .trim(),
    ).toBe('')
  }
}

describe('the built renderer', () => {
  it.skipIf(!existsSync(BUILT_INDEX))(
    'out/renderer/index.html carries the policy and no inline script',
    () => {
      expectBuiltPage(readFileSync(BUILT_INDEX, 'utf8'))
    },
  )

  it.skipIf(!existsSync(PACKAGED_ASAR))("the packaged app's index.html carries it too", async () => {
    const asar = (await import('@electron/asar')) as unknown as {
      extractFile(archive: string, filename: string): Buffer
    }
    expectBuiltPage(asar.extractFile(PACKAGED_ASAR, join('out', 'renderer', 'index.html')).toString('utf8'))
  })
})
