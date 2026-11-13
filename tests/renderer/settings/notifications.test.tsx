// Settings → Notifications (event toggles, pause 1 h, [Send test],
// Windows AUMID ✓ CLSID ✗ [Repair]; notification events and rules): values from config.resolve, switches write
// the user file with config.patch and offer Undo, Pause for 1 hour / Resume through state.set, the test notification's
// reply in words, and the Windows identity with Repair ("Available in the installed app" when not packaged).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppState, ConfigWriteResult } from '@shared/ipc.ts'
import { LOAD_DELAY_MS, PAUSE_MS, testResultText } from '@renderer/pages/settings/NotificationsSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { bumpConfigEpoch, setAppInfo } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { Providers, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { defaultAppInfo, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

let mock: MockDimFactory
let notifications: {
  desktop: boolean
  sound: boolean
  onlyWhenUnfocused: boolean
  events: { ask: boolean; gate: boolean; completed: boolean; failed: boolean; catalog: boolean }
}
let pausedUntil: number | null

const write = (backupId: string | null): ConfigWriteResult => ({
  path: 'C:\\home\\dimfactory.json',
  changed: true,
  diff: '',
  backupId,
})

const appState = (): AppState => ({
  schemaVersion: 1,
  setupDismissed: false,
  firstLaunchCompletedAt: null,
  catalog: { lastRefreshAt: null, snoozedUntil: null },
  notifications: { pausedUntil },
})

beforeEach(() => {
  notifications = {
    desktop: true,
    sound: false,
    onlyWhenUnfocused: true,
    events: { ask: true, gate: true, completed: true, failed: true, catalog: false },
  }
  pausedUntil = null
  mock = setUp({
    handlers: {
      'config.resolve': () => {
        const base = resolvedView()
        return { ...base, config: { ...base.config, notifications } }
      },
      'config.patch': () => write('b-1'),
      'config.restoreBackup': () => write(null),
      'state.get': () => appState(),
      'state.set': (req) => {
        if (req.notificationsPausedUntil !== undefined) pausedUntil = req.notificationsPausedUntil
        return appState()
      },
      'notifications.test': () => ({ shown: true, surface: 'native' }),
      'notifications.repairShortcut': () => ({ applicable: false, aumid: true, clsid: false }),
    },
  })
})

afterEach(() => tearDown(mock))

async function mount(): Promise<HTMLElement> {
  render(
    <Providers>
      <SettingsPage section="notifications" />
    </Providers>,
  )
  await settle(LOAD_DELAY_MS)
  return screen.getByTestId('settings-notifications')
}

async function click(el: HTMLElement): Promise<void> {
  fireEvent.click(el)
  await settle()
}

const checked = (id: string): string | null => screen.getByTestId(id).getAttribute('aria-checked')

describe('Settings → Notifications', () => {
  it('is live: nothing is read while passing through, then core’s values once open', async () => {
    render(
      <Providers>
        <SettingsPage section="notifications" />
      </Providers>,
    )
    expect(screen.queryByText('Arrives in a later version')).toBeNull()
    expect(mock.callsOf('config.resolve')).toEqual([])
    expect(screen.getByTestId('notif-desktop')).toHaveProperty('disabled', true)
    await settle(LOAD_DELAY_MS)
    expect(mock.callsOf('config.resolve')).toEqual([{}])
    expect(mock.callsOf('state.get')).toHaveLength(1)
    expect(checked('notif-desktop')).toBe('true')
    expect(checked('notif-unfocused')).toBe('true')
    expect(checked('notif-sound')).toBe('false')
    expect(checked('notif-event-ask')).toBe('true')
    expect(checked('notif-event-catalog')).toBe('false')
    expect(screen.getByTestId('notif-desktop')).toHaveProperty('disabled', false)
  })

  it('writes a switch to the user file and undoes it from core’s backup', async () => {
    await mount()
    await click(screen.getByTestId('notif-desktop'))
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/notifications/desktop', value: false }] },
    ])
    expect(checked('notif-desktop')).toBe('false')
    const t = useStore.getState().toasts.items.find((x) => x.id === 'notifications-undo')
    expect(t?.message).toBe('Show desktop notifications: off')
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.restoreBackup')).toEqual([{ scope: 'user', backupId: 'b-1' }])
    // The section reads core's values again after the undo.
    await settle(LOAD_DELAY_MS)
    expect(mock.callsOf('config.resolve')).toHaveLength(2)
  })

  it('writes each event under /notifications/events, and undoes a write to a new file by removing it', async () => {
    mock.on('config.patch', (req) => write(req.ops[0]?.op === 'remove' ? 'b-2' : null))
    await mount()
    await click(screen.getByTestId('notif-event-catalog'))
    expect(mock.callsOf('config.patch')[0]).toEqual({
      scope: 'user',
      ops: [{ op: 'replace', path: '/notifications/events/catalog', value: true }],
    })
    expect(useStore.getState().toasts.items.at(-1)?.message).toBe('Model prices may be out of date: notify')
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.patch')[1]).toEqual({
      scope: 'user',
      ops: [{ op: 'remove', path: '/notifications/events/catalog' }],
    })
  })

  it('puts a switch back and shows core’s message when the write fails', async () => {
    mock.on('config.patch', () => {
      throw mockError('VALIDATION', 'dimfactory.json has an error at 3:5.')
    })
    await mount()
    await click(screen.getByTestId('notif-event-gate'))
    expect(checked('notif-event-gate')).toBe('true')
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain(
      'dimfactory.json has an error at 3:5.',
    )
  })

  it('reads the values again after a config change', async () => {
    await mount()
    notifications = { ...notifications, sound: true }
    act(() => bumpConfigEpoch())
    await settle(LOAD_DELAY_MS)
    expect(checked('notif-sound')).toBe('true')
  })

  it('pauses for an hour and resumes', async () => {
    await mount()
    const pause = screen.getByTestId('notif-pause')
    expect(pause.textContent).toBe('Pause for 1 hour')
    const until = Date.now() + PAUSE_MS
    await click(pause)
    expect(mock.callsOf('state.set')).toEqual([{ notificationsPausedUntil: until }])
    expect(screen.getByTestId('notif-pause').textContent).toBe('Resume')
    // 16:00 in this locale's words (the clock is fixed at 15:00).
    const shown = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    expect(screen.getByTestId('notif-paused').textContent).toBe(`Paused until ${shown}`)
    await click(screen.getByTestId('notif-pause'))
    expect(mock.callsOf('state.set')[1]).toEqual({ notificationsPausedUntil: null })
    expect(screen.getByTestId('notif-pause').textContent).toBe('Pause for 1 hour')
  })

  it('shows a pause set elsewhere (the tray) when it opens', async () => {
    pausedUntil = Date.now() + 30 * 60_000
    await mount()
    expect(screen.getByTestId('notif-pause').textContent).toBe('Resume')
  })

  it('sends a test notification and says what happened', async () => {
    await mount()
    await click(screen.getByTestId('notif-test'))
    expect(mock.callsOf('notifications.test')).toHaveLength(1)
    expect(screen.getByTestId('notif-test-result').textContent).toBe('Sent as a desktop notification')
    expect(screen.getByTestId('notif-test-result').getAttribute('role')).toBe('status')
    mock.on('notifications.test', () => {
      throw mockError('UNSUPPORTED', 'Notifications are not available on this system.')
    })
    await click(screen.getByTestId('notif-test'))
    expect(screen.getByTestId('notif-test-result').textContent).toBe(
      'Notifications are not available on this system.',
    )
  })

  it('words every test reply', () => {
    expect(testResultText({ shown: true, surface: 'native' })).toBe('Sent as a desktop notification')
    expect(testResultText({ shown: true, surface: 'in-app', reason: 'Dim Factory is in front' })).toBe(
      'Shown inside Dim Factory: Dim Factory is in front',
    )
    expect(testResultText({ shown: false, surface: 'native', reason: 'Notifications are paused' })).toBe(
      'Not shown: Notifications are paused',
    )
  })

  it('shows the Windows identity and says Repair needs the installed app', async () => {
    act(() => setAppInfo(defaultAppInfo({ notifications: { aumid: true, clsid: false } })))
    await mount()
    const identity = screen.getByTestId('notif-identity')
    expect(identity.textContent).toContain('Notification identity: AUMID✓')
    expect(identity.textContent).toContain('CLSID✗')
    expect(identity.textContent).toContain('missing')
    await click(screen.getByTestId('notif-repair'))
    expect(mock.callsOf('notifications.repairShortcut')).toHaveLength(1)
    expect(screen.getByTestId('notif-repair-result').textContent).toBe('Available in the installed app')
    expect(screen.getByTestId('notif-repair')).toHaveProperty('disabled', true)
  })

  it('repairs the identity in the installed app', async () => {
    mock.on('notifications.repairShortcut', () => ({ applicable: true, aumid: true, clsid: true }))
    act(() => setAppInfo(defaultAppInfo({ packaged: true, notifications: { aumid: true, clsid: false } })))
    await mount()
    await click(screen.getByTestId('notif-repair'))
    expect(screen.getByTestId('notif-identity').textContent).toContain('CLSID✓')
    expect(screen.getByTestId('notif-repair-result').textContent).toBe(
      'Repaired: notification buttons work again.',
    )
  })

  it('has no Windows setup off Windows', async () => {
    act(() => setAppInfo(defaultAppInfo({ platform: 'darwin', notifications: null })))
    const content = await mount()
    expect(within(content).queryByTestId('notif-identity')).toBeNull()
  })
})
