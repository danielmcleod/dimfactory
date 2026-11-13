// Renderer origin, IPC sender and external-link rules (src/main/urls.ts; hardening, "IPC: sender check").
// The built renderer is app://dim-factory/index.html, no longer a file:// URL.
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  allowedExternalUrl,
  isAppUrl,
  isInsideDir,
  rendererTarget,
  senderAllowed,
  urlForLog,
} from '../../../src/main/urls.ts'
import type { RendererTarget, SenderInfo } from '../../../src/main/urls.ts'

const rendererDir = resolve('out', 'renderer')
const builtTarget = rendererTarget({ devUrl: undefined, packaged: true, rendererDir })
const devTarget = rendererTarget({ devUrl: 'http://localhost:5173/', packaged: false, rendererDir })
const indexUrl = 'app://dim-factory/index.html'
const indexFileUrl = pathToFileURL(join(rendererDir, 'index.html')).href

describe('rendererTarget', () => {
  it('uses the built files when packaged, even with a dev URL in the environment', () => {
    const t = rendererTarget({ devUrl: 'http://localhost:5173/', packaged: true, rendererDir })
    expect(t).toEqual({ kind: 'app', dir: rendererDir, url: indexUrl, origin: 'app://dim-factory' })
  })

  it('uses the dev server when unpackaged and the URL is http(s)', () => {
    expect(devTarget).toEqual({ kind: 'url', url: 'http://localhost:5173/', origin: 'http://localhost:5173' })
  })

  it('ignores a dev URL that is not http(s) or not a URL', () => {
    expect(rendererTarget({ devUrl: 'file:///etc/passwd', packaged: false, rendererDir }).kind).toBe('app')
    expect(rendererTarget({ devUrl: 'not a url', packaged: false, rendererDir }).kind).toBe('app')
    expect(rendererTarget({ devUrl: '  ', packaged: false, rendererDir }).kind).toBe('app')
  })
})

describe('isAppUrl', () => {
  it('accepts the built index and hash routes', () => {
    expect(isAppUrl(indexUrl, builtTarget)).toBe(true)
    expect(isAppUrl(`${indexUrl}#/run/abc`, builtTarget)).toBe(true)
    expect(isAppUrl('app://dim-factory/assets/x.js', builtTarget)).toBe(true)
    // Chromium lower-cases a standard scheme's host; Node's URL keeps it as written.
    expect(isAppUrl('app://DIM-FACTORY/index.html', builtTarget)).toBe(true)
  })

  it('rejects every file:// URL (the built files included), look-alike hosts, ports and users', () => {
    expect(isAppUrl(pathToFileURL(resolve('out', 'main', 'index.js')).href, builtTarget)).toBe(false)
    expect(isAppUrl(indexFileUrl, builtTarget)).toBe(false)
    expect(isAppUrl(`${indexFileUrl}#/run/abc`, builtTarget)).toBe(false)
    expect(isAppUrl('app://dim-factory.evil/index.html', builtTarget)).toBe(false)
    expect(isAppUrl('app://evil/index.html', builtTarget)).toBe(false)
    expect(isAppUrl('app://dim-factory:1/index.html', builtTarget)).toBe(false)
    expect(isAppUrl('app://user@dim-factory/index.html', builtTarget)).toBe(false)
    expect(isAppUrl('app:dim-factory/index.html', builtTarget)).toBe(false)
  })

  it('rejects other schemes and remote file hosts for the built target', () => {
    expect(isAppUrl('https://example.com/', builtTarget)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', builtTarget)).toBe(false)
    expect(isAppUrl('file://evil-host/share/index.html', builtTarget)).toBe(false)
    expect(isAppUrl('garbage', builtTarget)).toBe(false)
  })

  it('matches the dev origin only', () => {
    expect(isAppUrl('http://localhost:5173/#/runs', devTarget)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', devTarget)).toBe(false)
    expect(isAppUrl('https://localhost:5173/', devTarget)).toBe(false)
    expect(isAppUrl(indexUrl, devTarget)).toBe(false)
  })

  it('folds case on Windows and macOS only', () => {
    const t: RendererTarget = builtTarget
    if (t.kind !== 'app') throw new Error('a packaged target is the built renderer')
    const upper = join(rendererDir.toUpperCase(), 'index.html')
    expect(isInsideDir(upper, t.dir, 'win32')).toBe(true)
    expect(isInsideDir(upper, t.dir, 'darwin')).toBe(true)
    expect(isInsideDir(upper, t.dir, 'linux')).toBe(upper === join(rendererDir, 'index.html'))
  })
})

describe('senderAllowed', () => {
  const ok: SenderInfo = { fromMainWindow: true, mainFrame: true, frameUrl: indexUrl }

  it('allows the main window top frame showing the app', () => {
    expect(senderAllowed(ok, builtTarget)).toBe(true)
  })

  it.each<[string, Partial<SenderInfo>]>([
    ['another webContents', { fromMainWindow: false }],
    ['a subframe', { mainFrame: false }],
    ['a gone frame', { frameUrl: null }],
    ['a foreign page in the main frame', { frameUrl: 'https://example.com/' }],
    ['a file outside the renderer', { frameUrl: pathToFileURL(resolve('evil.html')).href }],
    ['the built page over file://', { frameUrl: indexFileUrl }],
    ['another app:// host', { frameUrl: 'app://evil/index.html' }],
  ])('refuses %s', (_name, patch) => {
    expect(senderAllowed({ ...ok, ...patch }, builtTarget)).toBe(false)
  })

  it('checks the dev origin in development', () => {
    expect(senderAllowed({ ...ok, frameUrl: 'http://localhost:5173/' }, devTarget)).toBe(true)
    expect(senderAllowed({ ...ok, frameUrl: indexUrl }, devTarget)).toBe(false)
  })
})

describe('allowedExternalUrl', () => {
  it.each([
    'https://docs.anthropic.com/en/docs/claude-code',
    'https://claude.ai/',
    'https://claude.com/download',
    'https://platform.openai.com/docs',
    'https://chatgpt.com/codex',
    'https://github.com/openai/codex',
    'https://ai.google.dev/gemini-api',
    'https://google.dev/',
    'https://nodejs.org/en/download',
    'https://git-scm.com/downloads',
    'https://docs.x.ai/docs',
    'https://CLAUDE.AI/path',
  ])('opens %s', (url) => {
    expect(allowedExternalUrl(url)).toBe(new URL(url).href)
  })

  it.each([
    'http://claude.ai/',
    'https://evilclaude.ai/',
    'https://claude.ai.evil.com/',
    'https://x.ai/',
    'https://user:pass@github.com/',
    'https://github.com:8443/',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'not a url',
  ])('refuses %s', (url) => {
    expect(allowedExternalUrl(url)).toBeNull()
  })
})

describe('urlForLog', () => {
  it('keeps only scheme and host', () => {
    expect(urlForLog('https://example.com/secret?token=abc')).toBe('https://example.com')
    expect(urlForLog(indexFileUrl)).toBe('file:')
    expect(urlForLog(`${indexUrl}#/runs/secret`)).toBe('app://dim-factory')
    expect(urlForLog('::')).toBe('[invalid url]')
  })
})
