// Run & Preview on demand, end to end, in the temp sandbox with a tiny fake dev server (a node script that
// prints its loopback URL and serves a page whose script logs a console error). No network beyond loopback, no
// vendor: the Run it page (the palette's "Run it") finds `npm run dev`, Trust then Start runs it as a trusted
// command, the panel reads the URL from its output, Open preview shows the page in Dim Factory's preview window
// (sandboxed: no node, no Dim Factory bridge, its navigation kept to the preview's origin, window.open denied),
// Open in browser is recorded (E2E never opens the developer's browser), the smoke check finds the console error
// (a note: no run), and Stop ends the server's process tree and closes the preview window.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import { setScripts, writeSandbox } from './verify-helpers.ts'

const SERVER = `
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
writeFileSync('server.pid', String(process.pid))
const page = '<!doctype html><title>Fake app</title><h1 id="hello">Hello from the fake dev server</h1>' +
  '<script>console.error("preview smoke boom")</script>'
const s = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(page)
})
s.listen(0, '127.0.0.1', () => console.log('  Local:   http://localhost:' + s.address().port + '/'))
`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a fake dev server: trust, start, in-app preview, smoke check finds a console error, stop', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const page = await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('the app did not start')
  writeSandbox(e2e, { 'server.mjs': SERVER })
  setScripts(e2e, { dev: 'node server.mjs' })

  // ---- the Run it page: in the sidebar (under Queue), then for a folder by the palette's action route ----
  const navRunIt = page.getByTestId('nav-run-it')
  const settingsBox = await page.getByTestId('nav-settings').boundingBox()
  await navRunIt.click()
  await expect(page).toHaveURL(/#\/preview$/)
  await expect(navRunIt).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('preview-page')).toBeVisible()
  // Nothing else in the sidebar moved for it.
  expect(await page.getByTestId('nav-settings').boundingBox()).toEqual(settingsBox)
  await page.evaluate((folder) => {
    window.location.hash = `#/preview?folder=${encodeURIComponent(folder)}`
  }, e2e.sandbox)
  await expect(page.getByTestId('preview-page')).toBeVisible()
  const row = page.getByTestId('run-it-command-pkg:dev')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toHaveAttribute('data-trust', 'untrusted')
  const start = page.getByTestId('run-it-start-pkg:dev')
  await expect(start).toBeDisabled()
  const width = (await start.boundingBox())?.width

  await page.getByTestId('run-it-trust-button-pkg:dev').click()
  await expect(row).toHaveAttribute('data-trust', 'trusted')
  await expect(start).toBeEnabled()
  await start.click()

  const status = page.getByTestId('run-it-status')
  await expect(status).toContainText('Running npm run dev at http://localhost:', { timeout: 60_000 })
  // Start turned Stop at the same width; the output box shows the server's line.
  await expect(start).toContainText('Stop')
  expect((await start.boundingBox())?.width).toBe(width)
  await expect(page.getByTestId('run-it-log')).toContainText('Local:')
  const url = ((await status.textContent()) ?? '').replace(/^.* at /, '')
  expect(url).toMatch(/^http:\/\/localhost:\d+\/$/)
  const pid = Number(readFileSync(join(e2e.sandbox, 'server.pid'), 'utf8'))
  expect(alive(pid)).toBe(true)

  // ---- Open preview: Dim Factory's sandboxed preview window ----
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await page.getByTestId('run-it-open-app').click()
  const preview: Page = await opened
  await preview.waitForLoadState('domcontentloaded')
  expect(preview.url()).toBe(url)
  await expect(preview.locator('#hello')).toHaveText('Hello from the fake dev server')
  // The window says it is a preview (the page keeps its own document.title).
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle())))
    .toContain('Preview: Fake app')
  // No node, no Dim Factory bridge, no new windows.
  const isolation = await preview.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: 'dimFactory' in window,
    popup: window.open('http://127.0.0.1:9/') === null,
  }))
  expect(isolation).toEqual({ require: 'undefined', process: 'undefined', bridge: false, popup: true })
  // A navigation away from the preview's origin is stopped (loopback, another port: nothing leaves the machine).
  await preview.evaluate(() => {
    window.location.href = 'http://127.0.0.1:9/elsewhere'
  })
  await page.waitForTimeout(500)
  expect(preview.url()).toBe(url)

  // ---- Open in browser: recorded, never opened under E2E ----
  await page.getByTestId('run-it-open-browser').click()
  await expect.poll(async () => (await e2e.e2eState()).extra?.['previewBrowserUrl']).toBe(url)

  // ---- the smoke check finds the console error (a note: this preview is not part of a run) ----
  await page.getByTestId('run-it-smoke').click()
  const smoke = page.getByTestId('run-it-smoke-result')
  await expect(smoke).toBeVisible({ timeout: 60_000 })
  await expect(smoke.getByTestId('run-it-smoke-error').first()).toContainText('preview smoke boom')
  await expect(smoke.getByTestId('run-it-smoke-summary')).toContainText('1 console error')
  await expect(smoke.getByTestId('run-it-smoke-note')).toBeVisible()
  await expect(smoke.getByTestId('run-it-smoke-thumbnail')).toBeVisible()

  // ---- Stop: the server's tree ends and the preview window closes ----
  const closed = preview.waitForEvent('close', { timeout: 30_000 })
  await start.click()
  await expect(status).toHaveText('npm run dev stopped.', { timeout: 30_000 })
  await closed
  await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false)
  await expect(start).toContainText('Start')
  expect(e2e.pageErrors).toEqual([])
})
