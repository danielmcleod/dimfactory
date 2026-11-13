// revealRoute (src/main/window.ts; tray menu: Active runs · New run) against a fake window: the tray's
// run items and New run reveal the window and switch the page's hash route; anything else only reveals it.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const { revealRoute } = await import('../../../src/main/window.ts')

const RUN_ID = '20261006T120000Z-ab12'

function fakeWindow(o: { minimized?: boolean; visible?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = []
  const scripts: string[] = []
  const win = {
    isDestroyed: () => o.destroyed === true,
    isMinimized: () => o.minimized === true,
    isVisible: () => o.visible !== false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: {
      executeJavaScript: (code: string) => {
        scripts.push(code)
        return Promise.resolve()
      },
    },
  }
  return { win: win as unknown as Parameters<typeof revealRoute>[0], calls, scripts }
}

describe('revealRoute', () => {
  it("restores, shows and focuses the window, then sets the run's route", () => {
    const { win, calls, scripts } = fakeWindow({ minimized: true, visible: false })
    revealRoute(win, `#/runs/${RUN_ID}`, { warn: vi.fn() })
    expect(calls).toEqual(['restore', 'show', 'focus'])
    expect(scripts).toEqual([`window.location.hash = "#/runs/${RUN_ID}"`])
  })

  it('goes to the Dashboard for New run', () => {
    const { win, scripts } = fakeWindow()
    revealRoute(win, '#/', { warn: vi.fn() })
    expect(scripts).toEqual(['window.location.hash = "#/"'])
  })

  it('only reveals the window for a route main does not build, and does nothing without a window', () => {
    const { win, calls, scripts } = fakeWindow()
    revealRoute(win, '#/runs/x";alert(1);"', { warn: vi.fn() })
    expect(calls).toEqual(['focus'])
    expect(scripts).toEqual([])
    expect(() => revealRoute(null, '#/', { warn: vi.fn() })).not.toThrow()
    const gone = fakeWindow({ destroyed: true })
    revealRoute(gone.win, '#/', { warn: vi.fn() })
    expect(gone.calls).toEqual([])
    expect(gone.scripts).toEqual([])
  })

  it('logs a failed route change instead of throwing', async () => {
    const warn = vi.fn()
    const { win } = fakeWindow()
    const w = win as unknown as { webContents: { executeJavaScript: () => Promise<void> } }
    w.webContents.executeJavaScript = () => Promise.reject(new Error('page gone'))
    revealRoute(win, '#/', { warn })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('could not open the route', expect.anything()))
  })
})
