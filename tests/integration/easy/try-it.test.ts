// The walk Try it for me runs inside a page, in a real browser: what it presses, what it leaves out, and how a form gets
// filled. The hidden window around it (no internet, no leaving the page's address) is the page-load check's.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TRY_IT_LOOK, TRY_IT_NEXT, tryItProblems, tryItSummary } from '../../../src/shared/try-it.ts'

type Ctx = { page: Page }

/** A real browser: Playwright's own when installed, else one this machine has. Nothing is downloaded. */
async function launch(): Promise<Browser> {
  let last: unknown
  for (const channel of [undefined, 'msedge', 'chrome']) {
    try {
      return await chromium.launch({ headless: true, ...(channel !== undefined ? { channel } : {}) })
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error('no browser could be started')
}

async function withPage(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const browser = await launch()
  try {
    await fn({ page: await (await browser.newContext()).newPage() })
  } finally {
    await browser.close()
  }
}

const PAGES: Record<string, string> = {
  '/': `<!doctype html><title>t</title><body>
    <h1>Home</h1>
    <a href="/about">About us</a>
    <a href="https://example.com/">Elsewhere</a>
    <a href="mailto:a@example.com">Mail us</a>
    <button onclick="window.pressed = (window.pressed || []).concat('hello')">Say hello</button>
    <button onclick="window.pressed = (window.pressed || []).concat('delete')">Delete everything</button>
    <button onclick="window.pressed = (window.pressed || []).concat('pay')">Pay now</button>
    <button style="display:none" onclick="window.pressed = (window.pressed || []).concat('hidden')">Hidden</button>
    <form onsubmit="event.preventDefault(); window.sent = Object.fromEntries(new FormData(this))">
      <input name="name"><input type="email" name="email"><textarea name="message"></textarea>
      <input type="password" name="secret">
      <button type="submit">Send it</button>
    </form>
  </body>`,
  '/about': '<!doctype html><title>a</title><body><p>About page</p></body>',
  '/blank': '<!doctype html><title>b</title><body></body>',
}

let server: Server
let address = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(PAGES[req.url ?? '/'] ?? 'x')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

type Next = { did: string | null; skipped: string[] }

async function walk(page: Page): Promise<string[]> {
  const did: string[] = []
  for (let i = 0; i < 12; i++) {
    const next = await page.evaluate<Next>(TRY_IT_NEXT).catch((): Next => ({ did: 'a link', skipped: [] }))
    if (next.did === null) break
    did.push(next.did)
    await page.waitForTimeout(100)
  }
  return did
}

describe('the walk', () => {
  it('presses what a visitor would, and never the same thing twice on a page', () =>
    withPage(async ({ page }) => {
      await page.goto(`${address}/`)
      const first = await page.evaluate<Next>(TRY_IT_NEXT)
      expect(first.did).toBe('About us')
      await page.waitForURL(`${address}/about`)
      await page.goBack()
      const rest = await walk(page)
      expect(rest).toContain('Say hello')
      expect(rest).toContain('Send it')
      expect(rest).not.toContain('About us')
      expect(new Set(rest).size).toBe(rest.length)
    }))

  it('leaves out paying, deleting, hidden controls, other sites and mail links', () =>
    withPage(async ({ page }) => {
      await page.goto(`${address}/about`)
      await page.goto(`${address}/`)
      const seen = await page.evaluate<Next>(TRY_IT_NEXT)
      expect(seen.skipped).toEqual(expect.arrayContaining(['Delete everything', 'Pay now']))
      // The step clicked a link: its navigation lands first, so the next goto is not cut short by it.
      if (seen.did === 'About us') await page.waitForURL(`${address}/about`)
      await page.goto(`${address}/`)
      const did = await walk(page)
      for (const never of ['Elsewhere', 'Mail us', 'Delete everything', 'Pay now', 'Hidden']) {
        expect(did).not.toContain(never)
      }
    }))

  it('fills a form with made-up details and never a password', () =>
    withPage(async ({ page }) => {
      await page.goto(`${address}/`)
      await page.evaluate(`sessionStorage.setItem('__dimTryIt', JSON.stringify({
        '/|A|About us': 1, '/|BUTTON|Say hello': 1 }))`)
      const r = await page.evaluate<Next>(TRY_IT_NEXT)
      expect(r.did).toBe('Send it')
      const sent = await page.evaluate<Record<string, string>>('window.sent')
      expect(sent).toEqual({
        name: 'Sam Example',
        email: 'sam@example.com',
        message: 'A short test message',
        secret: '',
      })
    }))

  it('answers nothing left on a page with nothing to press, and sees a blank page', () =>
    withPage(async ({ page }) => {
      await page.goto(`${address}/blank`)
      expect((await page.evaluate<Next>(TRY_IT_NEXT)).did).toBeNull()
      expect((await page.evaluate<{ blank: boolean }>(TRY_IT_LOOK)).blank).toBe(true)
      await page.goto(`${address}/about`)
      expect((await page.evaluate<{ blank: boolean }>(TRY_IT_LOOK)).blank).toBe(false)
    }))
})

describe('the words it reports in', () => {
  const report = { url: 'u', loaded: true, skipped: [], openProblems: [], steps: [] }

  it('says nothing went wrong only when nothing did', () => {
    expect(tryItSummary({ ...report, steps: [{ did: 'Go', problems: [] }] })).toBe(
      'Pressed 1 thing, and nothing went wrong.',
    )
    expect(tryItSummary(report)).toBe('It opened with no errors, and had nothing to press.')
  })

  it('counts problems from opening and from each press', () => {
    const r = { ...report, openProblems: ['x'], steps: [{ did: 'Go', problems: ['y'] }] }
    expect(tryItSummary(r)).toBe('Pressed 1 thing, and found 2 problems.')
    expect(tryItProblems(r)).toEqual(['x', 'After pressing "Go": y'])
  })

  it('says why when it could not open the page', () => {
    expect(tryItSummary({ ...report, loaded: false, error: 'It did not open.' })).toBe('It did not open.')
  })
})
