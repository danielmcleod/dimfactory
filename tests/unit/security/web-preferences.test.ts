// Security pass, webPreferences (src/main/window.ts) against a fake BrowserWindow: the window
// is context-isolated and sandboxed, with Node off in the page and its workers, web security on, no <webview>, no
// insecure content, no experimental or Blink features, and the CJS preload as the only bridge. security.spec.ts reads
// the same preferences back from the running window. The window is the app's only one, and nothing anywhere turns a
// remote module, a <webview> or Node in a renderer back on.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const seen: { options: Record<string, unknown> | undefined; loaded: string[] } = {
  options: undefined,
  loaded: [],
}

vi.mock('electron', () => {
  class FakeWebContents {
    on(): this {
      return this
    }
    once(): this {
      return this
    }
    getZoomFactor(): number {
      return 1
    }
    setZoomFactor(): void {}
  }
  class BrowserWindow {
    webContents = new FakeWebContents()
    constructor(options: Record<string, unknown>) {
      seen.options = options
    }
    setIgnoreMouseEvents(): void {}
    show(): void {}
    once(): this {
      return this
    }
    loadURL(url: string): Promise<void> {
      seen.loaded.push(url)
      return Promise.resolve()
    }
    loadFile(path: string): Promise<void> {
      seen.loaded.push(`loadFile ${path}`)
      return Promise.resolve()
    }
  }
  return { BrowserWindow }
})

const { createMainWindow } = await import('../../../src/main/window.ts')

describe('the main window', () => {
  it('is isolated and sandboxed, with nothing that would widen what the page can do', () => {
    createMainWindow({
      preload: 'C:\\app\\out\\preload\\index.cjs',
      target: {
        kind: 'app',
        dir: 'C:\\app\\out\\renderer',
        url: 'app://dim-factory/index.html',
        origin: 'app://dim-factory',
      },
      theme: { theme: 'system', resolved: 'light', accent: 'blue' },
      showImmediately: false,
      log: { error: () => undefined },
    })
    const prefs = seen.options?.['webPreferences'] as Record<string, unknown>
    expect(prefs).toMatchObject({
      preload: 'C:\\app\\out\\preload\\index.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    })
    // Nothing that turns Node, webviews, insecure content or experiments back on.
    const allowed = new Set([
      'preload',
      'contextIsolation',
      'sandbox',
      'nodeIntegration',
      'webSecurity',
      'spellcheck',
      'additionalArguments',
    ])
    expect(Object.keys(prefs).filter((k) => !allowed.has(k))).toEqual([])
    for (const k of [
      'nodeIntegrationInWorker',
      'nodeIntegrationInSubFrames',
      'webviewTag',
      'allowRunningInsecureContent',
      'experimentalFeatures',
      'enableBlinkFeatures',
      'enableWebSQL',
      'plugins',
    ]) {
      expect(prefs[k], k).toBeUndefined()
    }
    // The only argument the page's preload gets is the initial theme.
    expect(prefs['additionalArguments']).toEqual([
      expect.stringMatching(/^--dim-factory-theme=[A-Za-z0-9_-]+$/),
    ])
    // The built renderer loads from app://, never over file://.
    expect(seen.loaded).toEqual(['app://dim-factory/index.html'])
  })
})

describe('the rest of the app', () => {
  it('makes no other window and has no remote module, no webview and no Node in a renderer', () => {
    const files = readdirSync('src', { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
      .map((e) => join(e.parentPath, e.name))
    const hits = (re: RegExp): string[] =>
      files.filter((f) =>
        readFileSync(f, 'utf8')
          .split(/\r?\n/)
          .some((l) => !/^\s*(\/\/|\*)/.test(l) && re.test(l)),
      )
    // The app's window is window.ts's; the only other windows are Run & Preview's (preview.ts), sandboxed, with no
    // preload, no Node, context isolation, web security, no webview and a partition of their own.
    expect(hits(/new BrowserWindow\(/).map((f) => f.split('\\').join('/'))).toEqual([
      'src/main/preview.ts',
      'src/main/window.ts',
    ])
    const preview = readFileSync(join('src', 'main', 'preview.ts'), 'utf8')
    for (const want of [
      /sandbox: true/,
      /contextIsolation: true/,
      /nodeIntegration: false/,
      /nodeIntegrationInSubFrames: false/,
      /webSecurity: true/,
      /webviewTag: false/,
      /webPreferences: \{ \.\.\.SANDBOXED, partition/,
      // Every permission goes through one rule (preview-model.ts, unit-tested): fullscreen, in the window alone.
      /setPermissionRequestHandler\(\(_wc, permission, callback\) =>\s*callback\(previewPermissionAllowed\(kind, permission\)\),?\s*\)/,
      /setPermissionCheckHandler\(\(_wc, permission\) => previewPermissionAllowed\(kind, permission\)\)/,
      // Every preview partition (window, smoke, playtest, pdf) is hardened per session with its network policy; the
      // built-in Verify play-test's own partition likewise, always loopback only.
      /hardenSession\(ses, kind, this\.#hardened, \{/,
      /hardenSession\(ses, 'playtest', this\.#hardened, \{\s*\/\/[^\n]*\n\s*mode: \(\) => 'loopback',/,
      // The hidden check windows (smoke, playtest): sandboxed on their own partition, muted.
      /webPreferences: \{\s*\.\.\.SANDBOXED,\s*partition: o\.partition,/,
      /setAudioMuted\(true\)/,
      /setWindowOpenHandler/,
    ])
      expect(preview).toMatch(want)
    expect(preview).not.toMatch(/preload:/)
    expect(
      hits(/@electron\/remote|enableRemoteModule|nodeIntegration:\s*true|webviewTag:\s*true|<webview/),
    ).toEqual([])
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >
    expect(Object.keys({ ...pkg['dependencies'], ...pkg['devDependencies'] })).not.toContain(
      '@electron/remote',
    )
  })
})
