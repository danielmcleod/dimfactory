// Page zoom is the user's (src/main/window.ts installZoom, keys.ts; UI control standards;
// WCAG 1.4.4), against a fake webContents: the zoom is never locked or put back on its own, Ctrl+wheel and
// the zoom keys step through the presets, and a level kept from an earlier launch is dropped on the window's first
// load only (the zoom lasts as long as the window, reloads included).
import { describe, expect, it, vi } from 'vitest'
import type { ZoomTarget } from '../../../src/main/window.ts'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const { installZoom, zoomPage } = await import('../../../src/main/window.ts')
const { ZOOM_STEPS, keyAction, nextZoomFactor } = await import('../../../src/main/keys.ts')

type Listener = (event: unknown, direction: 'in' | 'out') => void

function fakeContents(start = 1) {
  let factor = start
  const listeners = new Map<string, { fn: Listener; once: boolean }[]>()
  const add = (event: string, fn: Listener, once: boolean): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), { fn, once }])
  }
  const setVisualZoomLevelLimits = vi.fn(() => Promise.resolve())
  const wc: ZoomTarget & { setVisualZoomLevelLimits: typeof setVisualZoomLevelLimits } = {
    getZoomFactor: () => factor,
    setZoomFactor: (f: number) => {
      factor = f
    },
    setVisualZoomLevelLimits,
    on: (event, fn) => add(event, fn, false),
    once: (event, fn) => add(event, fn, true),
  }
  const emit = (event: string, ...args: [unknown?, ('in' | 'out')?]): void => {
    const all = listeners.get(event) ?? []
    listeners.set(
      event,
      all.filter((l) => !l.once),
    )
    for (const l of all) l.fn(args[0], args[1] ?? 'in')
  }
  return {
    wc,
    emit,
    zoom: () => factor,
    set: (f: number) => (factor = f),
    count: (e: string) => listeners.get(e)?.length ?? 0,
  }
}

describe('page zoom is not locked', () => {
  it('Ctrl+wheel zooms in and out a step at a time, and nothing puts the zoom back', () => {
    const t = fakeContents()
    installZoom(t.wc)
    t.emit('did-finish-load')
    t.emit('zoom-changed', {}, 'in')
    expect(t.zoom()).toBe(1.1)
    t.emit('zoom-changed', {}, 'in')
    expect(t.zoom()).toBe(1.25)
    // A reload keeps the user's zoom.
    t.emit('did-finish-load')
    expect(t.zoom()).toBe(1.25)
    t.emit('zoom-changed', {}, 'out')
    t.emit('zoom-changed', {}, 'out')
    t.emit('zoom-changed', {}, 'out')
    expect(t.zoom()).toBe(0.9)
    // Pinch zoom is left as Electron has it: no limits are set.
    expect(t.wc.setVisualZoomLevelLimits).not.toHaveBeenCalled()
  })

  it("drops a level kept from an earlier launch on the window's first load, and only then", () => {
    const t = fakeContents(1.5)
    installZoom(t.wc)
    t.emit('did-finish-load')
    expect(t.zoom()).toBe(1)
    expect(t.count('did-finish-load')).toBe(0)
    t.set(1.5)
    t.emit('did-finish-load')
    expect(t.zoom()).toBe(1.5)
  })

  it('zoomPage steps through the presets and stops at their ends', () => {
    const t = fakeContents()
    const steps: number[] = []
    for (let i = 0; i < ZOOM_STEPS.length + 2; i++) {
      zoomPage(t.wc, 'zoomIn')
      steps.push(t.zoom())
    }
    expect(steps.slice(0, 5)).toEqual([1.1, 1.25, 1.5, 1.75, 2])
    expect(t.zoom()).toBe(2)
    zoomPage(t.wc, 'zoomReset')
    expect(t.zoom()).toBe(1)
    for (let i = 0; i < ZOOM_STEPS.length + 2; i++) zoomPage(t.wc, 'zoomOut')
    expect(t.zoom()).toBe(0.5)
  })
})

describe('nextZoomFactor', () => {
  it('moves to the next preset from a factor Chromium reads back inexactly', () => {
    expect(nextZoomFactor(1.2500001, 'zoomIn')).toBe(1.5)
    expect(nextZoomFactor(1.2499999, 'zoomOut')).toBe(1.1)
    expect(nextZoomFactor(1.3, 'zoomOut')).toBe(1.25)
    expect(nextZoomFactor(1.3, 'zoomIn')).toBe(1.5)
    expect(nextZoomFactor(3, 'zoomReset')).toBe(1)
  })
})

describe('the zoom keys', () => {
  const key = (k: string, mods: Partial<Record<'control' | 'meta' | 'alt' | 'shift', boolean>> = {}) => ({
    type: 'keyDown',
    key: k,
    control: mods.control ?? false,
    meta: mods.meta ?? false,
    alt: mods.alt ?? false,
    shift: mods.shift ?? false,
  })
  const win = { platform: 'win32' as const, packaged: true }
  const mac = { platform: 'darwin' as const, packaged: true }

  it('Ctrl with = or + zooms in, - zooms out, 0 resets (Cmd on macOS)', () => {
    expect(keyAction(key('=', { control: true }), win)).toBe('zoomIn')
    expect(keyAction(key('+', { control: true, shift: true }), win)).toBe('zoomIn')
    expect(keyAction(key('-', { control: true }), win)).toBe('zoomOut')
    expect(keyAction(key('_', { control: true, shift: true }), win)).toBe('zoomOut')
    expect(keyAction(key('0', { control: true }), win)).toBe('zoomReset')
    expect(keyAction(key('=', { meta: true }), mac)).toBe('zoomIn')
    expect(keyAction(key('-', { meta: true }), mac)).toBe('zoomOut')
    expect(keyAction(key('0', { meta: true }), mac)).toBe('zoomReset')
  })

  it('leaves the keys alone without the command modifier, with Alt, or with the other platform’s modifier', () => {
    expect(keyAction(key('='), win)).toBeNull()
    expect(keyAction(key('-'), win)).toBeNull()
    expect(keyAction(key('0', { control: true, alt: true }), win)).toBeNull()
    expect(keyAction(key('=', { meta: true }), win)).toBeNull()
    expect(keyAction(key('=', { control: true }), mac)).toBeNull()
    expect(keyAction({ ...key('=', { control: true }), type: 'keyUp' }, win)).toBeNull()
  })
})
