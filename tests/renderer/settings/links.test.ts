// The renderer's own copy of core's settings_link route (the settings_link executor; Settings → Config
// file; src/renderer/src/components/recovery/execute.ts settingsLinkHref, used when core cannot look the action up):
// like core's settingsHref, a project config file's link names the folder (`&folder=`), so Settings → Config file
// opens that project's file; other links are as before.
import { describe, expect, it } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import { settingsLinkHref } from '@renderer/components/recovery/execute.ts'

type Link = Extract<RecoveryAction, { kind: 'settings_link' }>

const link = (over: Partial<Link>): Link => ({
  id: 'x',
  label: 'Open',
  kind: 'settings_link',
  route: 'settings/config',
  pointer: '/backups/last-good',
  ...over,
})

describe('settingsLinkHref', () => {
  it("adds a project file's folder after the field", () => {
    expect(
      settingsLinkHref(
        link({ suggested: { scope: 'project', folder: 'C:\\work\\a b', backupId: 'last-good' } }),
      ),
    ).toBe('#/settings/config?field=%2Fbackups%2Flast-good&folder=C%3A%5Cwork%5Ca%20b')
    expect(settingsLinkHref(link({ pointer: '', suggested: { scope: 'project', folder: '/w/a' } }))).toBe(
      '#/settings/config?folder=%2Fw%2Fa',
    )
  })

  it('names no folder for your own file, a missing folder, or the composer', () => {
    expect(settingsLinkHref(link({ suggested: { scope: 'user', path: 'C:\\h\\dimfactory.json' } }))).toBe(
      '#/settings/config?field=%2Fbackups%2Flast-good',
    )
    expect(settingsLinkHref(link({ suggested: { scope: 'project', folder: '' } }))).toBe(
      '#/settings/config?field=%2Fbackups%2Flast-good',
    )
    expect(
      settingsLinkHref(
        link({ route: 'composer', pointer: '/folder', suggested: { scope: 'project', folder: '/w' } }),
      ),
    ).toBe('#/?field=%2Ffolder')
  })
})
