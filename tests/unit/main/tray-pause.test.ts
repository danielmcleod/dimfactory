// Tray "Pause notifications for 1 hour" (tray menu, state.json notifications.pausedUntil): the model's
// items while running, paused and without notifications, and tray.ts routing the clicks (fake `electron`).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LATER_VERSION, clockTime, trayMenu, trayRoute } from '../../../src/main/tray-model.ts'
import type { TrayMenuItem, TrayState } from '../../../src/main/tray-model.ts'

interface FakeMenuItem {
  label?: string
  enabled?: boolean
  click?: () => void
}

const native = vi.hoisted(() => {
  let menu: FakeMenuItem[] = []
  class FakeTray {
    setImage(): void {}
    setToolTip(): void {}
    setTitle(): void {}
    setContextMenu(m: { items: FakeMenuItem[] }): void {
      menu = m.items
    }
    on(): void {}
    destroy(): void {}
  }
  return {
    menu: (): FakeMenuItem[] => menu,
    module: {
      Tray: FakeTray,
      Menu: { buildFromTemplate: (items: FakeMenuItem[]) => ({ items }) },
      nativeImage: { createFromPath: () => ({ setTemplateImage: () => undefined }) },
    },
  }
})

vi.mock('electron', () => native.module)

const { createTray } = await import('../../../src/main/tray.ts')

const base: TrayState = { activeRuns: 0, needsYou: 0, runs: [] }
const item = (menu: TrayMenuItem[], label: string): TrayMenuItem | undefined =>
  menu.find((i) => i.type === 'item' && i.label === label)
const labels = (menu: TrayMenuItem[]): string[] => menu.map((i) => (i.type === 'separator' ? '—' : i.label))

describe('trayMenu pause items', () => {
  it('without notifications wired: the disabled placeholder', () => {
    expect(item(trayMenu(base, 'win32'), 'Pause notifications for 1 hour')).toEqual({
      type: 'item',
      label: 'Pause notifications for 1 hour',
      enabled: false,
      toolTip: LATER_VERSION,
    })
  })

  it('not paused: an enabled "Pause notifications for 1 hour"', () => {
    const menu = trayMenu({ ...base, notifications: { pausedUntil: null } }, 'win32')
    expect(item(menu, 'Pause notifications for 1 hour')).toEqual({
      type: 'item',
      label: 'Pause notifications for 1 hour',
      enabled: true,
      action: { kind: 'pause-notifications' },
    })
    expect(item(menu, 'Resume notifications')).toBeUndefined()
  })

  it('paused: "Notifications paused until 14:05" and Resume, in the pause item’s place', () => {
    const until = new Date(2026, 9, 6, 14, 5, 30).getTime()
    const menu = trayMenu({ ...base, notifications: { pausedUntil: until } }, 'linux')
    expect(labels(menu)).toEqual([
      'Open Dim Factory',
      '—',
      'No active runs',
      '—',
      'New run',
      'Notifications paused until 14:05',
      'Resume notifications',
      '—',
      'Quit',
    ])
    expect(item(menu, 'Notifications paused until 14:05')).toMatchObject({ enabled: false })
    expect(item(menu, 'Resume notifications')).toMatchObject({
      enabled: true,
      action: { kind: 'resume-notifications' },
    })
  })

  it('formats a local 24-hour time and routes nowhere', () => {
    expect(clockTime(new Date(2026, 0, 1, 9, 7).getTime())).toBe('09:07')
    expect(clockTime(new Date(2026, 0, 1, 23, 59).getTime())).toBe('23:59')
    expect(trayRoute({ kind: 'pause-notifications' })).toBeNull()
    expect(trayRoute({ kind: 'resume-notifications' })).toBeNull()
  })
})

describe('tray.ts pause / resume clicks', () => {
  const realPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('calls the pause and resume callbacks', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const onPause = vi.fn()
    const onResume = vi.fn()
    const tray = createTray({
      iconDir: 'icons',
      onOpen: vi.fn(),
      onNewRun: vi.fn(),
      onOpenRun: vi.fn(),
      onQuit: vi.fn(),
      onPauseNotifications: onPause,
      onResumeNotifications: onResume,
    })
    tray.update({ ...base, notifications: { pausedUntil: null } })
    native
      .menu()
      .find((m) => m.label === 'Pause notifications for 1 hour')
      ?.click?.()
    expect(onPause).toHaveBeenCalledTimes(1)
    tray.update({ ...base, notifications: { pausedUntil: Date.now() + 60_000 } })
    native
      .menu()
      .find((m) => m.label === 'Resume notifications')
      ?.click?.()
    expect(onResume).toHaveBeenCalledTimes(1)
    tray.dispose()
  })
})
