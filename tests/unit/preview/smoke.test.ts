// The smoke check's record: a run's console errors become [should] findings of source `preview` (one per distinct
// message, numbered, stable ids), kept with the run; an on-demand check is a note (no findings, nothing in a run).
// And the preview window's rules (main/preview-model.ts): loopback http only, navigation within the preview's own
// origin, web schemes only, aborted loads are not failures.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { readRunSmoke, recordSmoke, smokeFindings } from '../../../src/core/preview/smoke.ts'
import {
  failedLoadOf,
  navigationAllowed,
  openableUrl,
  previewTitle,
  requestAllowed,
} from '../../../src/main/preview-model.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] as string

describe('smoke findings', () => {
  it('one [should] per distinct console error, numbered, with where it came from', () => {
    const f = smokeFindings([
      { message: 'Uncaught TypeError: x is undefined', source: 'http://127.0.0.1:3000/app.js', line: 12 },
      { message: 'Uncaught TypeError: x is undefined', source: 'http://127.0.0.1:3000/app.js', line: 12 },
      { message: 'Failed to load resource: 404\nmore', source: 'http://127.0.0.1:3000/x.png' },
      { message: '   ' },
    ])
    expect(f.map((x) => [x.n, x.severity, x.source, x.round])).toEqual([
      [1, 'should', 'preview', 1],
      [2, 'should', 'preview', 1],
    ])
    expect(f[0]?.title).toBe('The preview page logged a console error: Uncaught TypeError: x is undefined')
    expect(f[0]?.body).toBe('At http://127.0.0.1:3000/app.js:12.')
    expect(f[1]?.body).toBe('At http://127.0.0.1:3000/x.png.\nmore')
    expect(f[0]?.id).toMatch(/^[0-9a-f]{12}$/)
    expect(smokeFindings([{ message: 'Uncaught TypeError: x is undefined' }])[0]?.id).toBe(f[0]?.id)
  })
})

describe('recordSmoke', () => {
  const seen = {
    url: 'http://127.0.0.1:3000/',
    loaded: true,
    consoleErrors: [{ message: 'boom' }],
    failedLoads: [{ url: 'http://127.0.0.1:3000/x.png', error: '404' }],
    thumbnail: 'data:image/jpeg;base64,AAAA',
    png: new Uint8Array([137, 80, 78, 71]),
  }

  it("keeps a run's result with the run, its console errors as findings", async () => {
    const paths = homePaths(home())
    const view = await recordSmoke(paths, { sessionId: 'pv_1', runId: '20261024T000000Z-abcd', at: 5, seen })
    expect(view.findings.map((f) => f.title)).toEqual(['The preview page logged a console error: boom'])
    const dir = join(paths.run('20261024T000000Z-abcd').dir, 'preview')
    expect(readFileSync(join(dir, 'smoke.png'))).toEqual(Buffer.from([137, 80, 78, 71]))
    expect(await readRunSmoke(paths, '20261024T000000Z-abcd')).toEqual(view)
  })

  it('makes an on-demand result a note: no findings, nothing in a run', async () => {
    const paths = homePaths(home())
    const view = await recordSmoke(paths, { sessionId: 'pv_2', at: 5, seen })
    expect(view.findings).toEqual([])
    expect(view.runId).toBeUndefined()
    expect(existsSync(join(paths.home, 'preview', 'smoke', 'pv_2', 'smoke.png'))).toBe(true)
    expect(existsSync(join(paths.home, 'preview', 'smoke', 'pv_2', 'smoke.json'))).toBe(false)
  })

  it('reads no result for a run that has none', async () => {
    expect(await readRunSmoke(homePaths(home()), '20261024T000000Z-ffff')).toBeNull()
  })
})

describe('the preview window rules', () => {
  it('opens loopback http only', () => {
    expect(openableUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(openableUrl('http://0.0.0.0:8000/')).toBe('http://127.0.0.1:8000/')
    expect(openableUrl('https://localhost:5173/')).toBeNull()
    expect(openableUrl('http://192.168.1.4:5173/')).toBeNull()
    expect(openableUrl('file:///etc/passwd')).toBeNull()
    expect(openableUrl(null)).toBeNull()
  })

  it("keeps navigation within the preview's own origin", () => {
    const origin = 'http://localhost:5173'
    expect(navigationAllowed('http://localhost:5173/about', origin)).toBe(true)
    expect(navigationAllowed('http://localhost:5174/', origin)).toBe(false)
    expect(navigationAllowed('http://127.0.0.1:5173/', origin)).toBe(false)
    expect(navigationAllowed('https://example.com/', origin)).toBe(false)
    expect(navigationAllowed('file:///C:/x', origin)).toBe(false)
    expect(navigationAllowed('http://u:p@localhost:5173/', origin)).toBe(false)
    expect(navigationAllowed('not a url', origin)).toBe(false)
  })

  it('lets requests use web schemes only', () => {
    for (const u of [
      'http://a/',
      'https://cdn.test/x.js',
      'ws://localhost:1/',
      'data:text/plain,x',
      'blob:http://a/1',
    ])
      expect(requestAllowed(u), u).toBe(true)
    for (const u of ['file:///C:/x', 'app://dim-factory/index.html', 'chrome://gpu', 'devtools://x'])
      expect(requestAllowed(u), u).toBe(false)
  })

  it('counts errors and 4xx/5xx as failed loads, not aborted ones', () => {
    expect(failedLoadOf({ url: 'x', statusCode: 404 })).toBe('404')
    expect(failedLoadOf({ url: 'x', statusCode: 200 })).toBeNull()
    expect(failedLoadOf({ url: 'x', error: 'net::ERR_CONNECTION_REFUSED' })).toBe(
      'net::ERR_CONNECTION_REFUSED',
    )
    expect(failedLoadOf({ url: 'x', error: 'net::ERR_ABORTED' })).toBeNull()
  })

  it('titles the window as a preview', () => {
    expect(previewTitle('My app', 'http://localhost:1/')).toBe('Preview: My app')
    expect(previewTitle('', 'http://localhost:1/')).toBe('Preview: http://localhost:1/')
  })
})
