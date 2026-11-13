// Security pass, navigation and windows (boot hardening "permissions, navigation and window-open
// blocked; https opens externally"; src/main/security.ts) against a fake `electron`: every webContents may navigate
// only within the app's renderer, a link elsewhere opens in the browser only when it is an allowlisted https link,
// a frame may not navigate at all (will-navigate is the top frame's only), redirects away are stopped, new
// windows and <webview> are refused. tests/unit/main/security.test.ts covers the permission handlers.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

type Listener = (ev: FakeEvent) => void
interface FakeEvent {
  url: string
  isMainFrame?: boolean
  defaultPrevented: boolean
  preventDefault(): void
}

const fake = vi.hoisted(() => ({
  created: undefined as ((e: unknown, contents: unknown) => void) | undefined,
}))

vi.mock('electron', () => ({
  app: {
    on: (event: string, l: (e: unknown, contents: unknown) => void) => {
      if (event === 'web-contents-created') fake.created = l
    },
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
    },
  },
}))

const { installHardening } = await import('../../../src/main/security.ts')
const { rendererTarget } = await import('../../../src/main/urls.ts')

const rendererDir = resolve('out', 'renderer')
const target = rendererTarget({ devUrl: undefined, packaged: true, rendererDir })
const appUrl = 'app://dim-factory/index.html#/runs/r1'

function contents() {
  const listeners = new Map<string, Listener>()
  let openHandler: ((d: { url: string }) => { action: string }) | undefined
  const c = {
    on: (event: string, l: Listener) => {
      listeners.set(event, l)
      return c
    },
    setWindowOpenHandler: (h: (d: { url: string }) => { action: string }) => (openHandler = h),
  }
  return {
    c,
    fire(event: string, url: string, isMainFrame = true): boolean {
      const l = listeners.get(event)
      if (l === undefined) throw new Error(`no ${event} listener`)
      const ev: FakeEvent = {
        url,
        isMainFrame,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        },
      }
      l(ev)
      return ev.defaultPrevented
    },
    open(url: string): string {
      if (openHandler === undefined) throw new Error('no window-open handler')
      return openHandler({ url }).action
    },
  }
}

function setUp() {
  const openExternal = vi.fn()
  const warn = vi.fn()
  installHardening({ target, openExternal, log: { warn } })
  const w = contents()
  if (fake.created === undefined) throw new Error('web-contents-created was not handled')
  fake.created({}, w.c)
  return { w, openExternal, warn }
}

describe('navigation', () => {
  it("lets the app's own page navigate within itself", () => {
    const { w, openExternal } = setUp()
    expect(w.fire('will-navigate', appUrl)).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('stops navigation away; an allowlisted https link opens in the browser instead', () => {
    const { w, openExternal, warn } = setUp()
    expect(w.fire('will-navigate', 'https://github.com/openai/codex')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/openai/codex')
    for (const u of [
      'https://evil.example/',
      'http://github.com/',
      pathToFileURL(resolve('README.md')).href,
    ]) {
      expect(w.fire('will-navigate', u)).toBe(true)
    }
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('blocked navigation', { url: 'https://evil.example' })
  })

  it('stops every frame navigation, even to an app or allowlisted URL, and opens nothing', () => {
    const { w, openExternal, warn } = setUp()
    for (const u of [appUrl, 'https://github.com/', 'https://evil.example/x?secret=1', 'about:blank']) {
      expect(w.fire('will-frame-navigate', u, false), u).toBe(true)
    }
    expect(openExternal).not.toHaveBeenCalled()
    // Logged by scheme and host only (a URL's path or query may carry data).
    expect(warn).toHaveBeenCalledWith('blocked frame navigation', { url: 'https://evil.example' })
    // The top frame's own navigation is will-navigate's to judge.
    expect(w.fire('will-frame-navigate', 'https://evil.example/', true)).toBe(false)
  })

  it('stops a top-frame redirect away from the app; a frame redirect is left to will-frame-navigate', () => {
    const { w } = setUp()
    expect(w.fire('will-redirect', 'https://evil.example/')).toBe(true)
    expect(w.fire('will-redirect', appUrl)).toBe(false)
  })
})

describe('new windows and webviews', () => {
  it('denies every window.open; an allowlisted https link opens in the browser', () => {
    const { w, openExternal } = setUp()
    expect(w.open('https://claude.ai/settings')).toBe('deny')
    expect(openExternal).toHaveBeenCalledWith('https://claude.ai/settings')
    expect(w.open(appUrl)).toBe('deny')
    expect(w.open('https://evil.example/')).toBe('deny')
    expect(w.open('javascript:alert(1)')).toBe('deny')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('refuses to attach a <webview>', () => {
    const { w } = setUp()
    expect(w.fire('will-attach-webview', appUrl)).toBe(true)
  })
})
