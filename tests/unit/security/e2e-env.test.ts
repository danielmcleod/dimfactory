// Security pass, test hooks (IPC "e2e.{state,power,clock}, registered only when DIM_FACTORY_E2E=1";
// E2E-only hooks): a packaged build honours none of the DIM_FACTORY_E2E* switches. Playwright cannot drive
// a packaged app (its enableNodeCliInspectArguments fuse is off), so there they could only turn test hooks on for
// someone else: e2e.* commands, a window that ignores the mouse, a folder picked without a dialog, diagnostics saved
// to a set path, the vendor search and the user home Grok's scan reads. main removes them before anything reads them.
import { describe, expect, it } from 'vitest'
import { dropE2EEnv, isE2E } from '../../../src/main/constants.ts'

const SWITCHES = {
  DIM_FACTORY_E2E: '1',
  DIM_FACTORY_E2E_TIME_SCALE: '100',
  DIM_FACTORY_E2E_PICK_FOLDER: 'C:\\Users\\me',
  DIM_FACTORY_E2E_DIAGNOSTICS_PATH: 'C:\\Users\\Public\\diag.txt',
  DIM_FACTORY_E2E_VENDOR_SEARCH: 'configured',
  DIM_FACTORY_E2E_USER_HOME: 'C:\\elsewhere',
}

describe('dropE2EEnv', () => {
  it('a packaged build removes every DIM_FACTORY_E2E* switch, whatever its case, and nothing else', () => {
    const env: Record<string, string | undefined> = {
      ...SWITCHES,
      dim_factory_e2e_extra: 'x',
      DIM_FACTORY_HOME: 'C:\\h',
      PATH: 'C:\\bin',
    }
    const removed = dropE2EEnv(env, true)
    expect(removed.sort()).toEqual([...Object.keys(SWITCHES), 'dim_factory_e2e_extra'].sort())
    expect(env).toEqual({ DIM_FACTORY_HOME: 'C:\\h', PATH: 'C:\\bin' })
    expect(isE2E(env)).toBe(false)
  })

  it('an unpackaged build (tests, development) keeps them', () => {
    const env: Record<string, string | undefined> = { ...SWITCHES }
    expect(dropE2EEnv(env, false)).toEqual([])
    expect(env).toEqual(SWITCHES)
    expect(isE2E(env)).toBe(true)
  })

  it('main drops them first thing, before the smoke, E2E, home or core reads the environment', async () => {
    const { readFileSync } = await import('node:fs')
    const main = readFileSync('src/main/index.ts', 'utf8')
    const body = main.slice(main.indexOf('async function main(): Promise<void> {'))
    const drop = body.indexOf('dropE2EEnv(env, app.isPackaged)')
    expect(drop).toBeGreaterThan(0)
    for (const later of ['smokeMode(', 'isE2E(env)', 'resolveHome(', 'createCore(']) {
      expect(body.indexOf(later), later).toBeGreaterThan(drop)
    }
  })
})
