// Review fixes in main (src/main): the renderer may write the clipboard (and nothing else), only a new
// app document resets push state (a blocked navigation does not), tray items open their route, renderer log data
// never overrides the record's own fields, and the OS session end starts the shutdown inside its handler.
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { createMemoryLogger } from '../../../src/core/log.ts'
import { createAppStateStore } from '../../../src/main/app-state.ts'
import { createMainHandlers, rendererLogData } from '../../../src/main/main-handlers.ts'
import type { MainHandlerDeps } from '../../../src/main/main-handlers.ts'
import { QuitController } from '../../../src/main/quit.ts'
import type { QuitControllerDeps } from '../../../src/main/quit.ts'
import { isMainRoute, trayRoute } from '../../../src/main/tray-model.ts'
import {
  RENDERER_PERMISSIONS,
  isAppDocumentLoad,
  permissionAllowed,
  rendererTarget,
} from '../../../src/main/urls.ts'

const rendererDir = resolve('out', 'renderer')
const builtTarget = rendererTarget({ devUrl: undefined, packaged: true, rendererDir })
const devTarget = rendererTarget({ devUrl: 'http://localhost:5173/', packaged: false, rendererDir })
// The built page is app://dim-factory/index.html; over file:// it is not the app.
const indexUrl = 'app://dim-factory/index.html'
const indexFileUrl = pathToFileURL(join(rendererDir, 'index.html')).href
const RUN_ID = '20261006T120000Z-ab12'

describe('permissionAllowed', () => {
  it('grants only sanitized clipboard writes', () => {
    expect(RENDERER_PERMISSIONS).toEqual(['clipboard-sanitized-write'])
  })

  it("grants clipboard writes to the app's own top frame (built files and dev server)", () => {
    const q = { permission: 'clipboard-sanitized-write', isMainFrame: true }
    expect(permissionAllowed({ ...q, requestingUrl: `${indexUrl}#/runs/x` }, builtTarget)).toBe(true)
    expect(permissionAllowed({ ...q, requestingUrl: 'http://localhost:5173/#/' }, devTarget)).toBe(true)
  })

  it.each([
    ['another permission', 'clipboard-read', indexUrl, true],
    ['notifications', 'notifications', indexUrl, true],
    ['media', 'media', indexUrl, true],
    ['a subframe', 'clipboard-sanitized-write', indexUrl, false],
    [
      'a page outside the renderer',
      'clipboard-sanitized-write',
      pathToFileURL(resolve('README.md')).href,
      true,
    ],
    ['a web page', 'clipboard-sanitized-write', 'https://example.com/', true],
    ['the built page over file://', 'clipboard-sanitized-write', indexFileUrl, true],
    ['no URL', 'clipboard-sanitized-write', undefined, true],
    ['an empty URL', 'clipboard-sanitized-write', '', true],
  ])('denies %s', (_what, permission, requestingUrl, isMainFrame) => {
    expect(permissionAllowed({ permission, requestingUrl, isMainFrame }, builtTarget)).toBe(false)
  })
})

describe('isAppDocumentLoad (when main resets the push focus and queue)', () => {
  const nav = (url: string, o: { isMainFrame?: boolean; isSameDocument?: boolean } = {}) => ({
    url,
    isMainFrame: o.isMainFrame ?? true,
    isSameDocument: o.isSameDocument ?? false,
  })

  it('resets for a reload of the app page', () => {
    expect(isAppDocumentLoad(nav(indexUrl), builtTarget)).toBe(true)
    expect(isAppDocumentLoad(nav('http://localhost:5173/'), devTarget)).toBe(true)
  })

  it('keeps the push state for a dropped file, a web page, a hash change or a subframe', () => {
    expect(isAppDocumentLoad(nav('file:///C:/Windows/win.ini'), builtTarget)).toBe(false)
    expect(isAppDocumentLoad(nav(indexFileUrl), builtTarget)).toBe(false)
    expect(isAppDocumentLoad(nav('https://example.com/'), builtTarget)).toBe(false)
    expect(isAppDocumentLoad(nav(`${indexUrl}#/runs`, { isSameDocument: true }), builtTarget)).toBe(false)
    expect(isAppDocumentLoad(nav(indexUrl, { isMainFrame: false }), builtTarget)).toBe(false)
  })
})

describe('trayRoute / isMainRoute', () => {
  it('opens the Dashboard for New run and the Run view for a run', () => {
    expect(trayRoute({ kind: 'new-run' })).toBe('#/')
    expect(trayRoute({ kind: 'open-run', runId: RUN_ID })).toBe(`#/runs/${RUN_ID}`)
    expect(trayRoute({ kind: 'open' })).toBeNull()
    expect(trayRoute({ kind: 'quit' })).toBeNull()
  })

  it('never builds a route from something that is not a run id', () => {
    for (const runId of ['', '../x', 'r1', `${RUN_ID}"; alert(1); "`, `${RUN_ID}/diff`])
      expect(trayRoute({ kind: 'open-run', runId })).toBeNull()
  })

  it('accepts only the routes trayRoute builds', () => {
    expect(isMainRoute('#/')).toBe(true)
    expect(isMainRoute(`#/runs/${RUN_ID}`)).toBe(true)
    for (const h of ['', '#', '#/runs', '#/settings', `#/runs/${RUN_ID}/diff`, 'javascript:1', `#/runs/x"y`])
      expect(isMainRoute(h)).toBe(false)
  })
})

describe('renderer log lines', () => {
  it("moves the record's own keys out of the renderer's data", () => {
    expect(rendererLogData(undefined)).toBeUndefined()
    expect(rendererLogData({ ms: 70 })).toEqual({ ms: 70 })
    expect(rendererLogData({ part: 'main', level: 'error', msg: 'x', ts: 1, ms: 70 })).toEqual({
      ms: 70,
      rendererData: { part: 'main', level: 'error', msg: 'x', ts: 1 },
    })
  })

  it('log.write stays a part=renderer line at the requested level whatever the data says', async () => {
    const log = createMemoryLogger()
    const deps = {
      core: { paths: homePaths(process.env['DIM_FACTORY_HOME'] ?? ''), log },
      appState: createAppStateStore(homePaths(process.env['DIM_FACTORY_HOME'] ?? '')),
    } as unknown as MainHandlerDeps
    const h = createMainHandlers(deps)
    await h['log.write']?.({
      level: 'info',
      msg: 'hello',
      data: { part: 'main', level: 'error', msg: 'forged', ts: 0, ms: 5 },
    })
    const rec = log.records.at(-1)
    expect(rec).toMatchObject({ level: 'info', msg: 'hello', part: 'renderer', ms: 5 })
    expect(rec?.ts).not.toBe(0)
    expect(rec?.['rendererData']).toEqual({ part: 'main', level: 'error', msg: 'forged', ts: 0 })
  })
})

describe('QuitController.endSession', () => {
  it('starts the shutdown inside the OS handler: before-shutdown and shutdown run before it returns', async () => {
    const calls: string[] = []
    const later: (() => void)[] = []
    const deps: QuitControllerDeps = {
      interruptible: () => ['r1'],
      requestConfirmation: () => calls.push('confirm'),
      beforeShutdown: () => calls.push('before'),
      shutdown: () => {
        calls.push('shutdown')
        return Promise.resolve()
      },
      exit: (code) => calls.push(`exit:${code}`),
      // The IPC path defers; the session end must not.
      defer: (fn) => later.push(fn),
    }
    const q = new QuitController(deps)
    q.endSession('session end')
    expect(calls).toEqual(['before', 'shutdown'])
    expect(later).toEqual([])
    await q.done
    expect(calls).toEqual(['before', 'shutdown', 'exit:0'])
  })

  it('an IPC quit still answers before its shutdown starts', async () => {
    const calls: string[] = []
    let run: (() => void) | undefined
    const q = new QuitController({
      interruptible: () => [],
      requestConfirmation: vi.fn(),
      shutdown: () => {
        calls.push('shutdown')
        return Promise.resolve()
      },
      exit: vi.fn(),
      defer: (fn) => (run = fn),
    })
    await q.request(true)
    expect(calls).toEqual([])
    run?.()
    await q.done
    expect(calls).toEqual(['shutdown'])
  })
})
