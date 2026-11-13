// Settings skeleton (the Settings table; "UI for unbuilt backends renders but is
// blocked"): every section that arrives later shows its real structure with its controls disabled and named with
// "Available in a later version", calls nothing, and Diagnostics / Notifications show what AppInfo already knows.
import '../helpers/rtl.ts'
import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { LATER_SECTION } from '@renderer/pages/settings/kit.tsx'
import { SETTINGS_SECTIONS } from '@renderer/pages/settings/sections.ts'
import { setAppInfo } from '@renderer/state/actions.ts'
import { defaultAppInfo } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, setUp, tearDown } from '../dashboard/setup.tsx'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp()
})

afterEach(() => tearDown(mock))

function mount(section: string): HTMLElement {
  render(
    <Providers>
      <SettingsPage section={section} />
    </Providers>,
  )
  return screen.getByTestId('settings-content')
}

const LATER = SETTINGS_SECTIONS.filter((s) => !s.live)

/** Controls a later section shows disabled (each inside its "Available in a later version" group). */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  // Every section is live now: General, Profiles and Prompts (tests/renderer/settings), Self-heal
  // (tests/renderer/self-heal/selfHealSettings.test.tsx), Diagnostics, Config file and Catalog (tests/renderer/settings
  // and tests/renderer/catalog-refresh), and Isolation & Verify (tests/renderer/settings/catalogIsolation.test.tsx,
  // tests/renderer/verify and tests/renderer/isolated-runs).
}

describe('later sections', () => {
  it.each(LATER.map((s) => [s.id, s] as const))(
    '%s shows its controls disabled, and fetches nothing',
    (id) => {
      const before = mock.calls.length
      const content = mount(id)
      expect(within(content).getByText(LATER_SECTION)).toBeTruthy()
      const groups = within(content).getAllByRole('group', { name: /Available in a later version$/ })
      expect(groups.length).toBeGreaterThan(0)
      for (const label of EXPECTED[id] ?? []) {
        const group = within(content).getByRole('group', { name: `${label} Available in a later version` })
        const control = group.querySelector('button, input')
        expect(control === null ? null : (control as HTMLButtonElement | HTMLInputElement).disabled).toBe(
          true,
        )
      }
      expect(mock.calls.length).toBe(before)
    },
  )

  it('every later section has an entry in the expectations', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(LATER.map((s) => s.id).sort())
  })
})

describe('what is known already', () => {
  it('Diagnostics lists the versions and paths from AppInfo', () => {
    act(() =>
      setAppInfo(
        defaultAppInfo({
          git: { path: 'C:\\Program Files\\Git\\cmd\\git.exe', version: '2.51.0' },
          packaged: true,
        }),
      ),
    )
    const content = mount('diagnostics')
    const list = within(content).getByTestId('diagnostics-versions')
    expect(list.textContent).toContain('Dim Factory0.1.0-test')
    expect(list.textContent).toContain('Electron44.5.1')
    expect(list.textContent).toContain('Git2.51.0 · C:\\Program Files\\Git\\cmd\\git.exe')
    expect(list.textContent).toContain('Data folderC:\\dim-factory-test-home')
  })

  it('Notifications shows the Windows notification setup from AppInfo', () => {
    act(() => setAppInfo(defaultAppInfo({ notifications: { aumid: true, clsid: false } })))
    const content = mount('notifications')
    // Notifications is live (tests/renderer/settings): the identity row reads AppInfo the same way.
    expect(within(content).getByTestId('notif-identity').textContent).toContain('AUMID✓')
    expect(within(content).getByTestId('notif-identity').textContent).toContain('CLSID✗')
    expect(within(content).getByTestId('notif-repair')).toBeTruthy()
  })
})
