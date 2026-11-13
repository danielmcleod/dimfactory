// Games phase 3 in the real app (Electron), with the fixture snake game on the starter engine.
// - Play-test: a phone scenario plays at phone size with touch emulation, so a `tap` is a real touch (the game sees a
//   touch pointer and starts); a reduced-motion scenario runs with the system setting on; the next scenario is back on
//   the desktop window. The built-in checks now include reduced motion (the snake's state says so) and the name check.
// - A famous game's name in the page title is a [should] game check (the name check); the original name passes.
// - Phone size: the game's preview window goes to 390 by 844 with touch (the touch buttons show, the title says so),
//   and back to its own size.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, test } from './harness.ts'
import { SNAKE_HTML, SNAKE_PLAYTEST, layoutGame } from './playtest-helpers.ts'

/** The snake's scenarios, plus a phone tap, a reduced-motion one, and a desktop one after them. */
const PHONE_PLAYTEST = {
  ...SNAKE_PLAYTEST,
  scenarios: [
    {
      name: 'A tap on the garden starts the game on a phone',
      viewport: 'phone',
      steps: [
        { tap: [0.5, 0.5] },
        { wait: { ms: 300 } },
        { expect: 'scene', eq: 'playing' },
        { expect: 'pointer', eq: 'touch' },
        { expect: 'touch', eq: true },
      ],
    },
    {
      name: 'With less motion asked for, the game says so',
      reducedMotion: true,
      steps: [{ expect: 'reducedMotion', eq: true }],
    },
    {
      name: 'Back on a computer a click is the mouse and motion is as the system says',
      steps: [
        { click: [0.5, 0.5] },
        { expect: 'pointer', eq: 'mouse' },
        { expect: 'reducedMotion', eq: false },
      ],
    },
    ...SNAKE_PLAYTEST.scenarios,
  ],
}

/** A window's content size, within a pixel (the screen's scaling rounds it). */
function expectSize(size: number[], width: number, height: number): void {
  expect(Math.abs((size[0] ?? 0) - width)).toBeLessThanOrEqual(1)
  expect(Math.abs((size[1] ?? 0) - height)).toBeLessThanOrEqual(1)
}

/** The preview window's content size, page width, title and touch support. */
async function previewFacts(
  app: ElectronApplication,
  url: string,
): Promise<{ size: number[]; title: string; inner: number; touch: number; buttons: string }> {
  return app.evaluate(async ({ BrowserWindow }, u) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(u))
    if (win === undefined) throw new Error('no preview window')
    const page = (await win.webContents.executeJavaScript(
      `({ inner: innerWidth, touch: navigator.maxTouchPoints, buttons: getComputedStyle(document.querySelector('.touch')).display })`,
    )) as { inner: number; touch: number; buttons: string }
    return { size: win.getContentSize(), title: win.getTitle(), ...page }
  }, url)
}

test('a tap playtest at phone size, reduced motion, the name check and the phone-size preview', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')
  layoutGame(e2e.sandbox, SNAKE_HTML, PHONE_PLAYTEST)
  const info = await e2e.call('preview.detect', { folder: e2e.sandbox })
  const stat = info.commands.find((c) => c.kind === 'static' && c.staticRoot === '.')
  const session = await e2e.call('preview.start', { folder: e2e.sandbox, commandId: stat?.id ?? '' })
  expect(session.game).toBe(true)

  // ---- the play-test: a real tap at phone size, reduced motion, then the desktop again ----
  const played = await e2e.call('preview.playtest', { sessionId: session.id })
  const r = played.report
  if (r === null) throw new Error(`nothing was played: ${played.problem ?? ''}`)
  expect(r.scenarios.map((s) => [s.name, s.status, s.failure?.message ?? ''])).toEqual(
    PHONE_PLAYTEST.scenarios.map((s) => [s.name, 'pass', '']),
  )
  const status = Object.fromEntries(r.checks.map((c) => [c.id, c.status]))
  expect(status).toMatchObject({ hook: 'pass', motion: 'pass', names: 'pass', errors: 'pass' })

  // ---- a famous name in the title: the name check finds it ----
  writeFileSync(
    join(e2e.sandbox, 'index.html'),
    SNAKE_HTML.replace('<title>Garden Snake</title>', '<title>Tetris Snake</title>'),
  )
  const smoke = await e2e.call('preview.smoke', { sessionId: session.id })
  expect(smoke.checks?.find((c) => c.id === 'names')).toMatchObject({
    status: 'fail',
    title: "The game uses a famous game's name (Tetris): give it an original name",
  })
  expect(smoke.checks?.find((c) => c.id === 'motion')?.status).toBe('pass')
  writeFileSync(join(e2e.sandbox, 'index.html'), SNAKE_HTML)

  // ---- Phone size: the preview window at 390 by 844 with touch, then back as it was ----
  const url = session.url ?? ''
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await e2e.call('preview.open', { sessionId: session.id, target: 'app' })
  await opened
  await expect
    .poll(async () => (await previewFacts(app, url)).title, { timeout: 15_000 })
    .toBe('Preview: Garden Snake')
  const before = await previewFacts(app, url)
  expectSize(before.size, 1100, 780)
  const on = await e2e.call('preview.phone', { sessionId: session.id, phone: true })
  expect(on.phone).toBe(true)
  await expect.poll(async () => (await previewFacts(app, url)).inner, { timeout: 15_000 }).toBe(390)
  const phone = await previewFacts(app, url)
  expectSize(phone.size, 390, 844)
  expect(phone.title).toBe('Preview (phone size): Garden Snake')
  expect(phone.touch).toBeGreaterThan(0)
  // The touch buttons a phone needs show (they hide for a mouse).
  expect(phone.buttons).toBe('grid')
  const off = await e2e.call('preview.phone', { sessionId: session.id, phone: false })
  expect(off.phone).toBeUndefined()
  await expect.poll(async () => (await previewFacts(app, url)).inner, { timeout: 15_000 }).toBe(1100)
  // Back as it was before (this computer's own touch screen, if it has one, is its own).
  await expect.poll(async () => (await previewFacts(app, url)).inner, { timeout: 15_000 }).toBe(before.inner)
  const after = await previewFacts(app, url)
  expectSize(after.size, 1100, 780)
  expect({ ...after, size: null }).toEqual({ ...before, size: null })
  await e2e.call('preview.stop', { sessionId: session.id })
})
