// E2E isolation from the developer's own mouse (src/main/window.ts; an E2E-only hook), against a fake
// BrowserWindow: with `ignoreOsPointer` (DIM_FACTORY_E2E=1) the window ignores the OS pointer before it is ever shown;
// without it (every normal launch) setIgnoreMouseEvents is never called. ui-layout.spec.ts checks the real window.
// E2E windows may also be larger than the screen (macOS enableLargerThanScreen); a normal launch never asks for it.
import { describe, expect, it, vi } from 'vitest'

const calls: string[] = []
const options: Record<string, unknown>[] = []

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
    constructor(o: Record<string, unknown>) {
      options.push(o)
    }
    setIgnoreMouseEvents(ignore: boolean, o?: { forward?: boolean }): void {
      calls.push(`ignore:${String(ignore)}:${String(o?.forward ?? false)}`)
    }
    show(): void {
      calls.push('show')
    }
    once(event: string): this {
      calls.push(`once:${event}`)
      return this
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
  }
  return { BrowserWindow }
})

const { createMainWindow } = await import('../../../src/main/window.ts')

function open(o: {
  ignoreOsPointer?: boolean
  largerThanScreen?: boolean
  showImmediately: boolean
}): string[] {
  calls.length = 0
  options.length = 0
  createMainWindow({
    preload: 'preload.cjs',
    target: { kind: 'url', url: 'http://localhost:5173/', origin: 'http://localhost:5173' },
    theme: { theme: 'system', resolved: 'light', accent: 'blue' },
    log: { error: () => undefined },
    ...o,
  })
  return [...calls]
}

describe('E2E windows ignore the OS pointer', () => {
  it('under E2E: ignored (nothing forwarded) before the window is shown', () => {
    expect(open({ ignoreOsPointer: true, showImmediately: true })).toEqual(['ignore:true:false', 'show'])
  })

  it('a normal launch never touches mouse events', () => {
    expect(open({ showImmediately: false })).toEqual(['once:ready-to-show'])
    expect(open({ ignoreOsPointer: false, showImmediately: true })).toEqual(['show'])
  })
})

describe('E2E windows may be larger than the screen (macOS)', () => {
  it('under E2E: enableLargerThanScreen, so a spec gets the size it sets on a small CI display', () => {
    open({ ignoreOsPointer: true, largerThanScreen: true, showImmediately: true })
    expect(options[0]?.['enableLargerThanScreen']).toBe(true)
  })

  it('a normal launch keeps the screen limit', () => {
    open({ showImmediately: false })
    expect(options[0]).not.toHaveProperty('enableLargerThanScreen')
    open({ largerThanScreen: false, showImmediately: true })
    expect(options[0]).not.toHaveProperty('enableLargerThanScreen')
  })
})
