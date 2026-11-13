// Core's links into the Settings sections (config errors report file:line:col,
// Restore last good; Settings → Config file, read-only with error markers, and its Restore last good; the executor
// settings_link): a config file's preflight fixes open Settings → Config file on that file (a project's names its folder,
// `&folder=`) at the problem, and "Restore last good" lands on the Restore button (`?field=/backups/last-good`, the
// pointer the config_invalid snag's link uses too).
import { describe, expect, it, vi } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { ConfigIssue } from '@shared/ipc.ts'
import { categoryInfo } from '@core/heal/categories.ts'
import { configFileRecovery } from '@core/preflight/checks/app.ts'
import type { ConfigFileState } from '@core/preflight/engine.ts'
import { executeAction } from '@core/recovery/dispatcher.ts'
import type { ExecuteDeps } from '@core/recovery/dispatcher.ts'
import { LAST_GOOD_POINTER, settingsHref, suggestedFolder } from '@core/recovery/routes.ts'

const FOLDER = 'C:\\work\\my app'
const ISSUE: ConfigIssue = {
  file: `${FOLDER}\\.dimfactory\\dimfactory.json`,
  line: 3,
  col: 5,
  endLine: 3,
  endCol: 11,
  severity: 'error',
  code: 'unknown_key',
  message: 'Unknown key "modle" (did you mean "model"?)',
  pointer: '/passes/plan/modle',
}

function file(scope: 'user' | 'project'): ConfigFileState {
  return {
    scope,
    path: scope === 'project' ? ISSUE.file : 'C:\\home\\dimfactory.json',
    exists: true,
    sha256: 'abc',
    issues: [ISSUE],
    restorable: true,
  }
}

function deps(): ExecuteDeps {
  return {
    run: {
      retryPass: vi.fn(() => Promise.resolve()),
      skipPass: vi.fn(() => Promise.resolve()),
      closeRun: vi.fn(() => Promise.resolve()),
      resumeRun: vi.fn(() => Promise.resolve()),
    },
  }
}

async function routeOf(action: RecoveryAction): Promise<string | undefined> {
  const r = await executeAction({ action, source: { kind: 'folder', folder: FOLDER, checkId: 'x' } }, deps())
  return r.route
}

describe('settings links into Settings → Config file and Diagnostics', () => {
  it("a project file's fixes open that project's file: at the problem, and at Restore", async () => {
    const [open, restore] = configFileRecovery('folder.project.config', file('project'), FOLDER)
    if (open === undefined || restore === undefined) throw new Error('expected two fixes')
    const folder = encodeURIComponent(FOLDER)
    expect(await routeOf(open)).toBe(
      `#/settings/config?field=${encodeURIComponent(ISSUE.pointer)}&folder=${folder}`,
    )
    expect(restore).toMatchObject({ kind: 'settings_link', pointer: LAST_GOOD_POINTER })
    expect(await routeOf(restore)).toBe(
      `#/settings/config?field=${encodeURIComponent(LAST_GOOD_POINTER)}&folder=${folder}`,
    )
  })

  it("your own file's fixes name no folder", async () => {
    const [open, restore] = configFileRecovery('app.config.user', file('user'))
    if (open === undefined || restore === undefined) throw new Error('expected two fixes')
    expect(await routeOf(open)).toBe(`#/settings/config?field=${encodeURIComponent(ISSUE.pointer)}`)
    expect(await routeOf(restore)).toBe(`#/settings/config?field=${encodeURIComponent(LAST_GOOD_POINTER)}`)
  })

  it("the config_invalid snag's Restore link uses the same pointer", () => {
    const pointers = categoryInfo('config_invalid').recovery.map((a) =>
      'pointer' in a ? a.pointer : undefined,
    )
    expect(pointers).toContain(LAST_GOOD_POINTER)
  })

  it('settingsHref adds the folder after the field, never to the composer; suggestedFolder reads a project only', () => {
    expect(settingsHref('settings/config', '', 'C:\\p')).toBe('#/settings/config?folder=C%3A%5Cp')
    expect(settingsHref('settings/config', '/a', '')).toBe('#/settings/config?field=%2Fa')
    expect(settingsHref('composer', '/folder', 'C:\\p')).toBe('#/?field=%2Ffolder')
    expect(suggestedFolder({ scope: 'project', folder: 'C:\\p', line: 1 })).toBe('C:\\p')
    expect(suggestedFolder({ scope: 'user', path: 'C:\\home\\dimfactory.json' })).toBeUndefined()
    expect(suggestedFolder({ scope: 'project', folder: '' })).toBeUndefined()
    expect(suggestedFolder(undefined)).toBeUndefined()
    expect(suggestedFolder('project')).toBeUndefined()
  })
})
