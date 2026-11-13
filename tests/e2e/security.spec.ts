// Security pass on the built app (IPC sender, CSP, fuses, allowlists, redaction, no credential reads; the boot
// hardening; security and packaging). The unit tests under
// tests/unit/security hold the rules; this spec checks the running window keeps them:
// - CSP: the page refuses eval, inline script and frames, its document carries the policy as a header too, and the
//   Diff tab's highlighter workers refuse eval while they still highlight; file:// is refused to the page.
// - app:// (the renderer is served from app://): the page is app://dim-factory/index.html, a secure context with
//   that origin; its workers start from app:// files and take the policy from their own response; main's handler,
//   reached through Chromium's own URL handling (net.fetch on the window's session), serves the built files with the
//   policy and refuses traversal in every spelling, another host, a missing file, another method and every file://.
// - The window: isolated and sandboxed, no Node in the page, window.dimFactory the only bridge; new windows, navigation
//   away and permissions refused, clipboard writes allowed.
// - IPC: strict requests; a second window loading the app's own page with the app's own preload is still refused
//   (the sender check is the window, not the page).
// - The rendered document preview (Easy's Open it for a document): a loopback page in the sandboxed preview window, on
//   its own session (not the app's), with no preload, no bridge and no Node; its page allows no script; Save as PDF
//   prints it in a hidden window built the same way.
// - The game preview window: full screen is its one permission (the smoke check's hidden window stays deny-all), F11
//   toggles it and Escape leaves it, and the page has the keyboard focus once it has loaded.
// - A game's hidden smoke and play-test windows: muted, every permission (fullscreen too) refused, loopback only.
// - Phone size: touch emulation goes over the DevTools protocol of the game's own preview window alone (never the app's
//   window, nor a preview that is not a game), and the protocol is let go when Phone size is turned off and when the
//   window closes.
// - Redaction: a secret a vendor prints reaches neither the raw log nor the diagnostics bundle.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { RENDERER_CSP_HEADER } from '../../src/main/csp.ts'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { CLEAN_FLOW, VERSION_WRITE } from './scenarios.ts'
import { SNAKE_HTML, layoutGame } from './playtest-helpers.ts'

/** Collect every CSP violation the page reports, from now on. */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __cspViolations: string[] }
    w.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__cspViolations.push(`${e.effectiveDirective} ${e.blockedURI}`)
    })
  })
  return () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)
}

/** eval from a task of the page's own (Playwright's own evaluate is exempt from the policy). */
const EVAL_IN_A_TASK = (): Promise<string> =>
  new Promise((done) =>
    setTimeout(() => {
      try {
        done(`ran: ${String((0, eval)('1 + 1'))}`)
      } catch (e) {
        done(`refused: ${e instanceof Error ? e.name : String(e)}`)
      }
    }, 0),
  )

test('CSP: the page, its document and the highlighter workers refuse eval; file:// is refused', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ scenario: CLEAN_FLOW, config: { gates: { afterPlan: false } } })
  const violations = await watchViolations(page)

  // ---- the page is the app:// origin, a secure context ----
  expect(page.url()).toMatch(/^app:\/\/dim-factory\/index\.html(#.*)?$/)
  expect(await page.evaluate(() => ({ origin: location.origin, secure: window.isSecureContext }))).toEqual({
    origin: 'app://dim-factory',
    secure: true,
  })

  // ---- the page ----
  expect(await page.evaluate(EVAL_IN_A_TASK)).toBe('refused: EvalError')
  expect(
    await page.evaluate(async () => {
      const s = document.createElement('script')
      s.textContent = 'window.__inlineRan = true'
      document.head.append(s)
      await new Promise((r) => setTimeout(r, 200))
      return (window as unknown as { __inlineRan?: boolean }).__inlineRan === true
    }),
  ).toBe(false)
  expect(
    await page.evaluate(async () => {
      const f = document.createElement('iframe')
      f.src = location.href
      document.body.append(f)
      await new Promise((r) => setTimeout(r, 500))
      const loaded = f.contentDocument?.querySelector('#root') !== null && f.contentDocument !== null
      f.remove()
      return loaded
    }),
  ).toBe(false)
  await expect
    .poll(violations)
    .toEqual(
      expect.arrayContaining([
        'script-src eval',
        'script-src-elem inline',
        expect.stringMatching(/^frame-src /),
      ]),
    )

  // ---- the document's own response carries the policy; file:// is refused (the policy, and main) ----
  const header = await page.evaluate(async () =>
    (await fetch(location.href)).headers.get('content-security-policy'),
  )
  expect(header).toBe(RENDERER_CSP_HEADER)
  const outside = pathToFileURL(join(REPO_ROOT, 'out', 'main', 'index.js')).href
  expect(
    await page.evaluate(async (u) => {
      try {
        const r = await fetch(u)
        return `status ${r.status}`
      } catch {
        return 'refused'
      }
    }, outside),
  ).not.toBe('status 200')
  const sandboxFile = pathToFileURL(join(e2e.sandbox, 'package.json')).href
  expect(
    await page.evaluate(async (u) => {
      try {
        const r = await fetch(u)
        return r.ok ? await r.text() : `status ${r.status}`
      } catch {
        return 'refused'
      }
    }, sandboxFile),
  ).not.toContain('"name"')

  // ---- the highlighter workers: the policy reaches them, and they still highlight ----
  const run = await e2e.runFromDashboard('add a --version flag')
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await page.evaluate((id) => (location.hash = `#/runs/${id}/diff`), run.runId)
  await expect(page.getByTestId('diff-tab')).toBeVisible()
  expect(
    await page.evaluate(async () => {
      const check = (window as unknown as { __dimFactoryDiffCheck?: () => Promise<string | null> })
        .__dimFactoryDiffCheck
      return check === undefined ? 'no hook' : await check()
    }),
  ).toBeNull()
  await expect.poll(() => page.workers().length).toBeGreaterThan(0)
  for (const w of page.workers()) {
    // Started from the bundled file itself: its own response carries the policy.
    expect(w.url()).toMatch(/^app:\/\/dim-factory\/assets\/[A-Za-z0-9_-]+\.js$/)
    expect(await w.evaluate(EVAL_IN_A_TASK), w.url()).toBe('refused: EvalError')
  }
  // What this test provoked (the refused eval, script and frame; the two refused file reads) and nothing else.
  const provoked = /Content Security Policy|EvalError|status of 403 \(Forbidden\)/i
  expect(e2e.pageErrors.filter((e) => !provoked.test(e))).toEqual([])
})

test('app://: main serves the built files with the policy; traversal, another host, other methods and file:// are refused', async ({
  e2e,
}) => {
  await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')
  const worker = readdirSync(join(REPO_ROOT, 'out', 'renderer', 'assets')).find((f) =>
    /^worker-.+\.js$/.test(f),
  )
  if (worker === undefined) throw new Error('the build has no highlighter worker')
  const outsideFile = pathToFileURL(join(REPO_ROOT, 'out', 'main', 'index.js')).href
  const requests: [string, string][] = [
    ['GET', 'app://dim-factory/index.html'],
    ['HEAD', 'app://dim-factory/index.html'],
    ['GET', `app://dim-factory/assets/${worker}`],
    ['GET', 'app://DIM-FACTORY/index.html'],
    // Chromium resolves these before main sees them: still inside out/renderer, where no such file is.
    ['GET', 'app://dim-factory/../main/index.js'],
    ['GET', 'app://dim-factory/assets/%2e%2e/%2E%2e/main/index.js'],
    ['GET', 'app://dim-factory/assets\\..\\..\\main\\index.js'],
    // These reach main as one segment, which no built file is named.
    ['GET', 'app://dim-factory/assets/..%2f..%2fmain%2findex.js'],
    ['GET', 'app://dim-factory/assets/..%5c..%5cmain%5cindex.js'],
    ['GET', 'app://dim-factory/index.html::$DATA'],
    ['GET', 'app://dim-factory/index.html%00.js'],
    ['GET', 'app://dim-factory/'],
    ['GET', 'app://dim-factory/assets/missing.js'],
    ['GET', 'app://other/index.html'],
    ['POST', 'app://dim-factory/index.html'],
    ['GET', outsideFile],
  ]
  const answers = await app.evaluate(async ({ session }, list) => {
    const out: {
      url: string
      status: number
      type: string | null
      csp: string | null
      nosniff: string | null
      cache: string | null
      bytes: number
    }[] = []
    for (const [method, url] of list) {
      try {
        const r = await session.defaultSession.fetch(url, { method })
        out.push({
          url: `${method} ${url}`,
          status: r.status,
          type: r.headers.get('content-type'),
          csp: r.headers.get('content-security-policy'),
          nosniff: r.headers.get('x-content-type-options'),
          cache: r.headers.get('cache-control'),
          bytes: (await r.arrayBuffer()).byteLength,
        })
      } catch (e) {
        out.push({
          url: `${method} ${url}`,
          status: -1,
          type: String(e),
          csp: null,
          nosniff: null,
          cache: null,
          bytes: 0,
        })
      }
    }
    return out
  }, requests)
  const by = new Map(answers.map((a) => [a.url, a]))
  const get = (u: string, method = 'GET') => {
    const a = by.get(`${method} ${u}`)
    if (a === undefined) throw new Error(`no answer for ${u}`)
    return a
  }
  expect(get('app://dim-factory/index.html')).toMatchObject({
    status: 200,
    type: 'text/html; charset=utf-8',
    csp: RENDERER_CSP_HEADER,
  })
  expect(get('app://dim-factory/index.html').bytes).toBeGreaterThan(100)
  expect(get('app://dim-factory/index.html', 'HEAD')).toMatchObject({ status: 200, bytes: 0 })
  expect(get(`app://dim-factory/assets/${worker}`)).toMatchObject({
    status: 200,
    type: 'text/javascript; charset=utf-8',
    csp: RENDERER_CSP_HEADER,
  })
  expect(get('app://DIM-FACTORY/index.html').status).toBe(200)
  for (const u of [
    'app://dim-factory/../main/index.js',
    'app://dim-factory/assets/%2e%2e/%2E%2e/main/index.js',
    'app://dim-factory/assets\\..\\..\\main\\index.js',
    'app://dim-factory/',
    'app://dim-factory/assets/missing.js',
  ]) {
    expect(get(u).status, u).toBe(404)
  }
  for (const u of [
    'app://dim-factory/assets/..%2f..%2fmain%2findex.js',
    'app://dim-factory/assets/..%5c..%5cmain%5cindex.js',
    'app://dim-factory/index.html::$DATA',
    'app://dim-factory/index.html%00.js',
    'app://other/index.html',
    outsideFile,
  ]) {
    expect(get(u).status, u).toBe(403)
  }
  expect(get('app://dim-factory/index.html', 'POST').status).toBe(405)
  // Nothing refused carried a body, and every answer, each refusal included, carried the policy, nosniff and
  // no-cache (the app:// release rules).
  for (const a of answers.filter((x) => x.status !== 200)) expect(a.bytes, a.url).toBe(0)
  for (const a of answers) {
    expect(a, a.url).toMatchObject({ csp: RENDERER_CSP_HEADER, nosniff: 'nosniff', cache: 'no-cache' })
  }
})

test('the window: isolated and sandboxed; navigation, new windows and permissions refused; clipboard writes allowed', async ({
  e2e,
}) => {
  const page = await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    // The preferences the page was made with (an Electron WebContents method its typings leave out).
    const wc = w?.webContents as unknown as
      { getLastWebPreferences(): Record<string, unknown> | null } | undefined
    const p = wc?.getLastWebPreferences()
    return p === undefined || p === null
      ? null
      : {
          contextIsolation: p.contextIsolation,
          sandbox: p.sandbox,
          nodeIntegration: p.nodeIntegration,
          nodeIntegrationInWorker: p.nodeIntegrationInWorker,
          nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames,
          webSecurity: p.webSecurity,
          webviewTag: p.webviewTag,
          allowRunningInsecureContent: p.allowRunningInsecureContent,
        }
  })
  expect(prefs).toEqual({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
  })

  // No Node in the page; window.dimFactory is the only bridge, and it is a few functions and facts.
  expect(
    await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>)['require'],
      process: typeof (globalThis as Record<string, unknown>)['process'],
      module: typeof (globalThis as Record<string, unknown>)['module'],
      bridge: Object.keys(window.dimFactory).sort(),
    })),
  ).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    bridge: ['initialTheme', 'invoke', 'platform', 'subscribe'],
  })

  // window.open opens nothing; navigating away stays here.
  const before = page.url()
  expect(await page.evaluate(() => window.open('https://example.com/') === null)).toBe(true)
  expect(await page.evaluate(() => window.open(location.href) === null)).toBe(true)
  await page.evaluate(
    (u) => {
      location.href = u
    },
    pathToFileURL(join(e2e.sandbox, 'package.json')).href,
  )
  await page.waitForTimeout(1_000)
  expect(page.url()).toBe(before)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

  // Permissions: everything refused but the Copy buttons' clipboard write.
  const perms = await page.evaluate(async () => {
    const out: Record<string, string> = {}
    out['notifications'] = await Notification.requestPermission()
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
      out['microphone'] = 'granted'
    } catch (e) {
      out['microphone'] = e instanceof Error ? e.name : 'refused'
    }
    try {
      await navigator.clipboard.writeText('permission check')
      out['clipboard-write'] = 'granted'
    } catch {
      out['clipboard-write'] = 'refused'
    }
    try {
      await navigator.clipboard.readText()
      out['clipboard-read'] = 'granted'
    } catch {
      out['clipboard-read'] = 'refused'
    }
    out['geolocation'] = await new Promise<string>((done) =>
      navigator.geolocation.getCurrentPosition(
        () => done('granted'),
        (e) => done(e.code === e.PERMISSION_DENIED ? 'denied' : `error ${e.code}`),
        { timeout: 5_000 },
      ),
    )
    return out
  })
  expect(perms).toEqual({
    notifications: 'denied',
    microphone: 'NotAllowedError',
    'clipboard-write': 'granted',
    'clipboard-read': 'refused',
    geolocation: 'denied',
  })
})

test("IPC: strict requests, and the app's own page in another window is still refused", async ({ e2e }) => {
  const page = await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')

  const extra = await e2e.invoke('runs.list', { limit: 5, extra: true } as never)
  expect(extra.ok ? 'ok' : extra.error.code).toBe('VALIDATION')
  const deep = await e2e.invoke('config.patch', {
    scope: 'user',
    ops: [{ op: 'remove', path: '/x', from: '/y' }],
  } as never)
  expect(deep.ok ? 'ok' : deep.error.code).toBe('VALIDATION')
  for (const cmd of ['no.such', '__proto__', 'constructor']) {
    const r = await page.evaluate(
      (c) => (window.dimFactory.invoke as (cmd: string, req?: unknown) => Promise<unknown>)(c, {}),
      cmd,
    )
    expect((r as { error?: { code?: string } }).error?.code, cmd).toBe('UNKNOWN_COMMAND')
  }
  // The main window may use e2e.* (DIM_FACTORY_E2E=1 here).
  expect((await e2e.invoke('e2e.state')).ok).toBe(true)

  // A second window: the same page, the same preload, the same session. Only the main window may send commands.
  const preload = join(REPO_ROOT, 'out', 'preload', 'index.cjs')
  const answers = await app.evaluate(async ({ BrowserWindow }, preloadPath) => {
    const main = BrowserWindow.getAllWindows()[0]
    const index = main?.webContents.getURL().split('#')[0] ?? ''
    const second = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    try {
      await second.loadURL(`${index}#/settings`)
      return (await second.webContents.executeJavaScript(
        `Promise.all([window.dimFactory.invoke('runs.list', {}), window.dimFactory.invoke('e2e.state'), window.dimFactory.invoke('shell.open', { target: 'url', url: 'https://github.com/' })])`,
      )) as unknown
    } finally {
      second.destroy()
    }
  }, preload)
  expect(answers).toEqual([
    { ok: false, error: { code: 'FORBIDDEN', message: 'This sender may not use Dim Factory commands.' } },
    { ok: false, error: { code: 'FORBIDDEN', message: 'This sender may not use Dim Factory commands.' } },
    { ok: false, error: { code: 'FORBIDDEN', message: 'This sender may not use Dim Factory commands.' } },
  ])
  // The main window still works after it.
  expect((await e2e.invoke('runs.list', {})).ok).toBe(true)
})

test('the document preview window: its own session, no bridge, no Node, loopback only, no script', async ({
  e2e,
}) => {
  await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')
  writeFileSync(
    join(e2e.sandbox, 'memo.md'),
    '# Memo\n\n<script>window.__ran = 1</script>\n\n[x](javascript:alert(1))\n',
  )
  const info = await e2e.call('preview.detect', { folder: e2e.sandbox })
  const doc = info.commands.find((c) => c.kind === 'document')
  expect(doc).toMatchObject({ id: 'doc:memo.md', trust: 'none', argv: [] })
  const session = await e2e.call('preview.start', { folder: e2e.sandbox, commandId: doc?.id ?? '' })
  expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await e2e.call('preview.open', { sessionId: session.id, target: 'app' })
  const preview = await opened
  await preview.waitForLoadState('domcontentloaded')
  expect(preview.url()).toBe(session.url)
  await expect(preview.locator('h1')).toHaveText('Memo')

  // No bridge, no Node, no script ran (the Markdown's script is text), no javascript: link.
  expect(
    await preview.evaluate(() => ({
      bridge: 'dimFactory' in window,
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      ran: (window as unknown as { __ran?: number }).__ran ?? null,
      scripts: document.querySelectorAll('script').length,
      jsLinks: [...document.querySelectorAll('a')].filter((a) => a.href.startsWith('javascript:')).length,
    })),
  ).toEqual({ bridge: false, require: 'undefined', process: 'undefined', ran: null, scripts: 0, jsLinks: 0 })
  // An inline script added now is refused by the page's own policy.
  expect(
    await preview.evaluate(async () => {
      const s = document.createElement('script')
      s.textContent = 'window.__late = true'
      document.head.append(s)
      await new Promise((r) => setTimeout(r, 200))
      return (window as unknown as { __late?: boolean }).__late === true
    }),
  ).toBe(false)

  // Its own session (not the app's), no preload, sandboxed; the command channel refuses it.
  const facts = await app.evaluate(({ BrowserWindow }, url) => {
    const all = BrowserWindow.getAllWindows()
    const main = all.find((w) => w.webContents.getURL().startsWith('app://'))
    const win = all.find((w) => w.webContents.getURL() === url)
    const wc = win?.webContents as unknown as
      { getLastWebPreferences(): Record<string, unknown> | null; session: unknown } | undefined
    const p = wc?.getLastWebPreferences() ?? null
    return {
      found: win !== undefined,
      sameSession: wc !== undefined && main !== undefined && wc.session === main.webContents.session,
      preload: p?.['preload'] ?? null,
      sandbox: p?.['sandbox'],
      contextIsolation: p?.['contextIsolation'],
      nodeIntegration: p?.['nodeIntegration'],
    }
  }, session.url)
  expect(facts).toEqual({
    found: true,
    sameSession: false,
    preload: null,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  })

  // Save as PDF needs nothing from the page: main prints it.
  const saved = await e2e.call('preview.savePdf', { sessionId: session.id })
  expect(saved.path).toBe(join(e2e.sandbox, 'memo.pdf'))
  expect(readFileSync(saved.path).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  await e2e.call('preview.stop', { sessionId: session.id })
})

test('the game preview window: fullscreen its only permission, F11 and Esc, focused on load; the smoke check denies all', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')
  // The page asks for a permission as it loads (the smoke check records the answer as a console error).
  writeFileSync(
    join(e2e.sandbox, 'index.html'),
    '<!doctype html><title>Game</title><p>Play</p>' +
      "<script>Notification.requestPermission().then((p) => console.error('notifications: ' + p))</script>\n",
  )
  const info = await e2e.call('preview.detect', { folder: e2e.sandbox })
  const stat = info.commands.find((c) => c.kind === 'static' && c.staticRoot === '.')
  expect(stat).toBeDefined()
  const session = await e2e.call('preview.start', { folder: e2e.sandbox, commandId: stat?.id ?? '' })
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await e2e.call('preview.open', { sessionId: session.id, target: 'app' })
  const preview = await opened
  await preview.waitForLoadState('load')

  type Probe = { focused: boolean; full: boolean; answer: unknown }
  const probe = (code: string | null): Promise<Probe> =>
    app.evaluate(
      async ({ BrowserWindow }, a) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === a.url)
        if (win === undefined) throw new Error('no preview window')
        // userGesture: as a click on the game's own full screen button.
        const answer: unknown = a.code === null ? null : await win.webContents.executeJavaScript(a.code, true)
        return { focused: win.webContents.isFocused(), full: win.isFullScreen(), answer }
      },
      { url: session.url, code },
    )

  // Focused once it has loaded: a game's keys work without a click first.
  await expect.poll(async () => (await probe(null)).focused).toBe(true)
  // Fullscreen is the one permission; everything else is still refused.
  const asked = await probe(
    `Promise.all([
      document.documentElement.requestFullscreen().then(() => 'granted', (e) => 'refused: ' + e.name),
      Notification.requestPermission(),
      navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => e.name),
      new Promise((done) => navigator.geolocation.getCurrentPosition(() => done('granted'), (e) => done(e.code === e.PERMISSION_DENIED ? 'denied' : 'error ' + e.code), { timeout: 5000 })),
    ])`,
  )
  expect(asked.answer).toEqual(['granted', 'denied', 'NotAllowedError', 'denied'])
  await expect.poll(async () => (await probe(null)).full).toBe(true)
  await probe('document.exitFullscreen().then(() => true)')
  await expect.poll(async () => (await probe(null)).full).toBe(false)

  // F11 toggles the window's full screen; Escape leaves it (keys as the OS delivers them to the window).
  const key = (keyCode: string): Promise<void> =>
    app.evaluate(
      ({ BrowserWindow }, a) => {
        const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === a.url)?.webContents
        wc?.sendInputEvent({ type: 'keyDown', keyCode: a.keyCode })
        wc?.sendInputEvent({ type: 'keyUp', keyCode: a.keyCode })
      },
      { url: session.url, keyCode },
    )
  await key('F11')
  await expect.poll(async () => (await probe(null)).full).toBe(true)
  await key('Escape')
  await expect.poll(async () => (await probe(null)).full).toBe(false)

  // The smoke check's hidden window, on its own partition, is still refused everything.
  const smoke = await e2e.call('preview.smoke', { sessionId: session.id })
  expect(smoke.loaded).toBe(true)
  expect(smoke.consoleErrors.map((c) => c.message)).toContain('notifications: denied')
  await e2e.call('preview.stop', { sessionId: session.id })
})

test("a game's smoke and play-test windows: muted, every permission refused, no internet", async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')
  // The game asks for permissions as it loads, and plays a sound; each answer goes to the console as an error.
  const ask =
    '<script>' +
    "Notification.requestPermission().then((p) => console.error('notifications: ' + p));" +
    "navigator.mediaDevices.getUserMedia({ audio: true }).then(() => console.error('microphone: granted'), (e) => console.error('microphone: ' + e.name));" +
    "document.documentElement.requestFullscreen().then(() => console.error('fullscreen: granted'), (e) => console.error('fullscreen: ' + e.name));" +
    'try { const a = new AudioContext(); const o = a.createOscillator(); o.connect(a.destination); o.start() } catch (e) {}' +
    '</script>\n'
  layoutGame(e2e.sandbox, SNAKE_HTML.replace('</body>', `${ask}</body>`), {
    version: 1,
    scenarios: [
      { name: 'Space starts the game', steps: [{ key: 'Space' }, { expect: 'scene', eq: 'playing' }] },
    ],
  })
  const info = await e2e.call('preview.detect', { folder: e2e.sandbox })
  const stat = info.commands.find((c) => c.kind === 'static' && c.staticRoot === '.')
  const session = await e2e.call('preview.start', { folder: e2e.sandbox, commandId: stat?.id ?? '' })
  expect(session.network).toBe('loopback')

  /** Every hidden check window open now: whether it is muted, and which partition it is on. */
  const hidden = (): Promise<{ muted: boolean; url: string }[]> =>
    app.evaluate(
      ({ webContents }, own) =>
        webContents
          .getAllWebContents()
          .filter((wc) => wc.getURL().startsWith(own))
          .map((wc) => ({ muted: wc.isAudioMuted(), url: wc.getURL() })),
      session.url ?? '',
    )
  const seen: { muted: boolean; url: string }[] = []
  const watch = setInterval(() => {
    void hidden().then(
      (w) => seen.push(...w),
      () => undefined,
    )
  }, 150)
  try {
    const smoke = await e2e.call('preview.smoke', { sessionId: session.id })
    const said = smoke.consoleErrors.map((c) => c.message)
    expect(said).toContain('notifications: denied')
    expect(said).toContain('microphone: NotAllowedError')
    expect(said.some((m) => m.startsWith('fullscreen: ') && m !== 'fullscreen: granted')).toBe(true)
    const play = await e2e.call('preview.playtest', { sessionId: session.id })
    const playSaid = play.report?.consoleErrors.map((c) => c.message) ?? []
    expect(playSaid).toContain('notifications: denied')
    expect(playSaid).toContain('microphone: NotAllowedError')
    expect(playSaid).not.toContain('fullscreen: granted')
    expect(play.report?.scenarios.map((s) => s.status)).toEqual(['pass'])
  } finally {
    clearInterval(watch)
  }
  // The hidden windows were seen (the play-test's on ?test=1), and every one was muted.
  expect(seen.some((w) => w.url.includes('test=1'))).toBe(true)
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every((w) => w.muted)).toBe(true)
  await e2e.call('preview.stop', { sessionId: session.id })
})

test("Phone size: touch emulation only on the game's preview window, detached when it closes", async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const page = await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')
  layoutGame(e2e.sandbox)
  const info = await e2e.call('preview.detect', { folder: e2e.sandbox })
  const stat = info.commands.find((c) => c.kind === 'static' && c.staticRoot === '.')
  const session = await e2e.call('preview.start', { folder: e2e.sandbox, commandId: stat?.id ?? '' })
  const url = session.url ?? ''

  /** Every webContents now: its URL and whether the DevTools protocol is attached to it. */
  const attached = (): Promise<{ url: string; attached: boolean }[]> =>
    app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((wc) => !wc.isDestroyed())
        .map((wc) => ({ url: wc.getURL(), attached: wc.debugger.isAttached() })),
    )
  expect((await attached()).every((w) => !w.attached)).toBe(true)

  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await e2e.call('preview.phone', { sessionId: session.id, phone: true })
  await opened
  await expect
    .poll(async () => (await attached()).filter((w) => w.attached).map((w) => w.url.startsWith(url)))
    .toEqual([true])
  // The app's own window never has it.
  const appUrl = page.url()
  expect((await attached()).find((w) => w.url === appUrl)?.attached).toBe(false)
  // Off again: let go.
  await e2e.call('preview.phone', { sessionId: session.id, phone: false })
  expect((await attached()).every((w) => !w.attached)).toBe(true)
  // On, then the window closes: let go, and the session is no longer at phone size.
  await e2e.call('preview.phone', { sessionId: session.id, phone: true })
  expect((await attached()).some((w) => w.attached)).toBe(true)
  await app.evaluate(({ BrowserWindow }, u) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith(u))
      ?.close()
  }, url)
  await expect.poll(async () => (await attached()).every((w) => !w.attached)).toBe(true)
  await expect
    .poll(async () => (await e2e.call('preview.list')).find((s) => s.id === session.id)?.phone)
    .toBeUndefined()

  // A preview that is not a game gets no Phone size at all.
  await e2e.call('preview.stop', { sessionId: session.id })
  const plain = join(e2e.sandbox, 'site')
  mkdirSync(plain)
  writeFileSync(join(plain, 'index.html'), '<!doctype html><title>Site</title><p>Hello</p>\n')
  const sinfo = await e2e.call('preview.detect', { folder: plain })
  const site = await e2e.call('preview.start', {
    folder: plain,
    commandId: sinfo.commands.find((c) => c.kind === 'static')?.id ?? '',
  })
  expect(site.game).toBeUndefined()
  await expect(e2e.call('preview.phone', { sessionId: site.id, phone: true })).rejects.toThrow(
    /Phone size is for a game's preview/,
  )
  expect((await attached()).every((w) => !w.attached)).toBe(true)
  await e2e.call('preview.stop', { sessionId: site.id })
})

test('redaction: a secret a vendor prints reaches neither the raw log nor the diagnostics bundle', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  // Fake secrets assembled at runtime; shapes the newer rules added (a key known by its name only) and an older one.
  const metaKey = ['mT4kQ9', 'mT4kQ9', 'mT4kQ9', 'mT4kQ9'].join('')
  const githubToken = ['gh', 'p_', 'aB3'.repeat(12)].join('')
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: VERSION_WRITE,
          text: `Done. I set META_API_KEY=${metaKey} and used ${githubToken} for the clone.`,
        },
      ],
    },
    config: { gates: { afterPlan: false } },
  })
  void page
  const run = await e2e.runFromDashboard('add a --version flag')
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  const rawDir = join(e2e.home, 'runs', run.runId, 'raw')
  expect(existsSync(rawDir)).toBe(true)
  const raw = readdirSync(rawDir)
    .map((f) => readFileSync(join(rawDir, f), 'utf8'))
    .join('\n')
  expect(raw).toContain('META_API_KEY=')
  expect(raw).not.toContain(metaKey)
  expect(raw).not.toContain(githubToken)

  const bundle = await e2e.call('diagnostics.build', { runId: run.runId, includeRaw: true })
  expect(bundle.text).toContain('Raw vendor lines')
  expect(bundle.text).not.toContain(metaKey)
  expect(bundle.text).not.toContain(githubToken)
  const logs = join(e2e.home, 'logs')
  for (const f of readdirSync(logs)) {
    const text = readFileSync(join(logs, f), 'utf8')
    expect(text, f).not.toContain(metaKey)
    expect(text, f).not.toContain(githubToken)
  }
})
