// config.resolve lists the profile names every layer defines (the Quick composer's profile picker): built-ins
// first, then user profiles, then the folder's project profiles.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  for (let attempt = 0; ; attempt++) {
    try {
      cleanup(...dirs.splice(0))
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 60 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw err
      await delay(250)
    }
  }
})

describe('config.resolve: profiles', () => {
  it('lists built-in, user and project profile names in layer order', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const userFile = join(home, 'dimfactory.json')
    const user = JSON.parse(readFileSync(userFile, 'utf8')) as Record<string, unknown>
    writeFileSync(
      userFile,
      JSON.stringify({ ...user, profiles: { mine: { critic: { enabled: false } } } }, null, 2),
    )
    const folder = makeSandbox()
    dirs.push(folder)
    mkdirSync(join(folder, '.dimfactory'), { recursive: true })
    writeFileSync(
      join(folder, '.dimfactory', 'dimfactory.json'),
      JSON.stringify({ profiles: { team: { review: { model: 'opus' } } } }),
    )
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)

    const builtins = ['balanced', 'claude-only', 'codex-only', 'fast', 'thorough']
    const withFolder = await core.invoke('config.resolve', { folder })
    if (!withFolder.ok) throw new Error(withFolder.error.message)
    expect(withFolder.value.profiles).toEqual([...builtins, 'mine', 'team'])
    expect(withFolder.value.profiles).toContain(withFolder.value.config.profile)

    const userOnly = await core.invoke('config.resolve', {})
    if (!userOnly.ok) throw new Error(userOnly.error.message)
    expect(userOnly.value.profiles).toEqual([...builtins, 'mine'])
  })
})
