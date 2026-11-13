// tray.ts against a fake `electron`: native calls happen only when the model changes, and menu clicks reach the
// right callbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeMenuItem {
  label?: string
  type?: string
  enabled?: boolean
  click?: () => void
}

const native = vi.hoisted(() => {
  const calls: { method: string; arg: unknown }[] = []
  const created: { path: string; template: boolean }[] = []
  let clickHandler: (() => void) | undefined
  let menu: FakeMenuItem[] = []
  class FakeTray {
    constructor(image: unknown) {
      calls.push({ method: 'new', arg: image })
    }
    setImage(image: unknown): void {
      calls.push({ method: 'setImage', arg: image })
    }
    setToolTip(text: string): void {
      calls.push({ method: 'setToolTip', arg: text })
    }
    setTitle(text: string): void {
      calls.push({ method: 'setTitle', arg: text })
    }
    setContextMenu(m: { items: FakeMenuItem[] }): void {
      menu = m.items
      calls.push({ method: 'setContextMenu', arg: m.items.length })
    }
    on(event: string, cb: () => void): void {
      if (event === 'click') clickHandler = cb
    }
    destroy(): void {
      calls.push({ method: 'destroy', arg: null })
    }
  }
  return {
    calls,
    created,
    reset(): void {
      calls.length = 0
      created.length = 0
      clickHandler = undefined
      menu = []
    },
    click(): void {
      clickHandler?.()
    },
    menu: (): FakeMenuItem[] => menu,
    module: {
      Tray: FakeTray,
      Menu: { buildFromTemplate: (items: FakeMenuItem[]) => ({ items }) },
      nativeImage: {
        createFromPath(path: string) {
          const img = {
            path,
            template: false,
            setTemplateImage(v: boolean) {
              img.template = v
            },
          }
          created.push(img)
          return img
        },
      },
    },
  }
})

vi.mock('electron', () => native.module)

const { createTray } = await import('../../../src/main/tray.ts')

const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

function makeTray(): {
  tray: ReturnType<typeof createTray>
  cb: {
    onOpen: ReturnType<typeof vi.fn>
    onNewRun: ReturnType<typeof vi.fn>
    onOpenRun: ReturnType<typeof vi.fn>
    onQuit: ReturnType<typeof vi.fn>
  }
} {
  const cb = { onOpen: vi.fn(), onNewRun: vi.fn(), onOpenRun: vi.fn(), onQuit: vi.fn() }
  const tray = createTray({ iconDir: '/icons', ...cb })
  return { tray, cb }
}

const count = (method: string): number => native.calls.filter((c) => c.method === method).length
const item = (label: string): FakeMenuItem | undefined => native.menu().find((i) => i.label === label)

beforeEach(() => native.reset())
afterEach(() => setPlatform(realPlatform))

describe('createTray (Windows / Linux)', () => {
  beforeEach(() => setPlatform('win32'))

  it('starts idle with the zero icon, tooltip and menu', () => {
    const { tray } = makeTray()
    expect(tray.current).toEqual({ icon: 'tray-0.png', tooltip: 'No active runs' })
    expect(native.created.map((c) => c.path.replace(/\\/g, '/'))).toEqual(['/icons/tray-0.png'])
    expect(count('setToolTip')).toBe(1)
    expect(count('setContextMenu')).toBe(1)
    expect(count('setTitle')).toBe(0)
  })

  it('touches the native tray only for the parts that changed', () => {
    const { tray } = makeTray()
    native.calls.length = 0
    tray.update({ activeRuns: 0, needsYou: 0, runs: [] })
    expect(native.calls).toEqual([])

    tray.update({ activeRuns: 1, needsYou: 0, runs: [{ runId: 'r1', title: 'One', needsYou: false }] })
    expect(count('setImage')).toBe(1)
    expect(count('setToolTip')).toBe(1)
    expect(count('setContextMenu')).toBe(1)
    expect(tray.current).toEqual({ icon: 'tray-1.png', tooltip: '1 run active' })

    native.calls.length = 0
    tray.update({ activeRuns: 1, needsYou: 0, runs: [{ runId: 'r1', title: 'One', needsYou: false }] })
    expect(native.calls).toEqual([])

    // Same icon and tooltip, different run title: only the menu is rebuilt.
    tray.update({ activeRuns: 1, needsYou: 0, runs: [{ runId: 'r1', title: 'Renamed', needsYou: false }] })
    expect(native.calls.map((c) => c.method)).toEqual(['setContextMenu'])
  })

  it('reuses loaded images when an icon comes back', () => {
    const { tray } = makeTray()
    tray.update({ activeRuns: 2, needsYou: 1, runs: [] })
    tray.update({ activeRuns: 0, needsYou: 0, runs: [] })
    tray.update({ activeRuns: 2, needsYou: 1, runs: [] })
    expect(native.created.map((c) => c.path.replace(/\\/g, '/'))).toEqual([
      '/icons/tray-0.png',
      '/icons/tray-2-attn.png',
    ])
    expect(native.created.every((c) => !c.template)).toBe(true)
    expect(tray.current.icon).toBe('tray-2-attn.png')
  })

  it('routes clicks to the callbacks', () => {
    const { tray, cb } = makeTray()
    tray.update({ activeRuns: 1, needsYou: 1, runs: [{ runId: 'r9', title: 'Nine', needsYou: true }] })
    native.click()
    expect(cb.onOpen).toHaveBeenCalledTimes(1)
    item('Open Dim Factory')?.click?.()
    expect(cb.onOpen).toHaveBeenCalledTimes(2)
    item('● Nine')?.click?.()
    expect(cb.onOpenRun).toHaveBeenCalledWith('r9')
    item('New run')?.click?.()
    expect(cb.onNewRun).toHaveBeenCalledTimes(1)
    item('Quit')?.click?.()
    expect(cb.onQuit).toHaveBeenCalledTimes(1)
    expect(item('Pause notifications for 1 hour')).toMatchObject({ enabled: false })
    expect(item('Pause notifications for 1 hour')?.click).toBeUndefined()
  })

  it('destroys the tray once and ignores updates afterwards', () => {
    const { tray } = makeTray()
    tray.dispose()
    tray.dispose()
    native.calls.length = 0
    tray.update({ activeRuns: 3, needsYou: 0, runs: [] })
    expect(native.calls).toEqual([])
    expect(tray.current.icon).toBe('tray-0.png')
  })
})

describe('createTray (macOS)', () => {
  beforeEach(() => setPlatform('darwin'))

  it('uses template images and the count as the title, and leaves left click to the menu', () => {
    const { tray, cb } = makeTray()
    expect(native.created).toEqual([expect.objectContaining({ template: true })])
    expect(count('setTitle')).toBe(1)
    tray.update({ activeRuns: 4, needsYou: 1, runs: [] })
    expect(tray.current).toEqual({ icon: 'trayAttnTemplate.png', tooltip: '4 runs active · 1 needs you' })
    expect(native.calls.filter((c) => c.method === 'setTitle').map((c) => c.arg)).toEqual(['', '4'])
    expect(native.created.every((c) => c.template)).toBe(true)
    native.click()
    expect(cb.onOpen).not.toHaveBeenCalled()
  })
})
