// Repair without admin rights: when [Repair] could not change a per-machine install's all-users shortcut (main's
// status says `needsAdmin`), Settings → Notifications says that administrator rights are needed and what to do,
// instead of a plain "The repair did not fix it". Any other failed repair reads as before. No em dash.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@shared/ipc.ts'
import { LOAD_DELAY_MS, NEEDS_ADMIN_TEXT } from '@renderer/pages/settings/NotificationsSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { setAppInfo } from '@renderer/state/actions.ts'
import { Providers, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { defaultAppInfo } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

let mock: MockDimFactory

const appState = (): AppState => ({
  schemaVersion: 1,
  setupDismissed: false,
  firstLaunchCompletedAt: null,
  catalog: { lastRefreshAt: null, snoozedUntil: null },
  notifications: { pausedUntil: null },
})

beforeEach(() => {
  mock = setUp({
    handlers: {
      'config.resolve': () => resolvedView(),
      'state.get': () => appState(),
    },
  })
})
afterEach(() => tearDown(mock))

async function repairWith(status: object): Promise<string> {
  mock.on('notifications.repairShortcut', () => status as never)
  act(() => setAppInfo(defaultAppInfo({ packaged: true, notifications: { aumid: true, clsid: false } })))
  render(
    <Providers>
      <SettingsPage section="notifications" />
    </Providers>,
  )
  await settle(LOAD_DELAY_MS)
  await act(async () => {
    fireEvent.click(screen.getByTestId('notif-repair'))
    await settle()
  })
  return screen.getByTestId('notif-repair-result').textContent ?? ''
}

describe('Repair without administrator rights', () => {
  it('says the all-users shortcut needs administrator rights, and what to do', async () => {
    const text = await repairWith({ applicable: true, aumid: true, clsid: false, needsAdmin: true })
    expect(text).toBe(NEEDS_ADMIN_TEXT)
    expect(text).toContain('administrator')
    expect(text).toContain('Reinstall Dim Factory')
    expect(text).not.toContain('—')
  })

  it('any other failed repair reads as before', async () => {
    expect(await repairWith({ applicable: true, aumid: true, clsid: false })).toBe(
      'The repair did not fix it. Reinstalling Dim Factory sets it up again.',
    )
  })
})
