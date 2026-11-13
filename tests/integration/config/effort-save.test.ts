// "Save to project" with a pass effort: a new level is written; a default effort (null) the layers already give is
// pruned like a null model (minimal diff); the resolver then reads it from the project file.
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

describe('config.save with effort', () => {
  it('writes a new level, prunes a default one, and the resolver reads it back', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    mkdirSync(join(folder, '.dimfactory'), { recursive: true })
    const file = join(folder, '.dimfactory', 'dimfactory.json')
    writeFileSync(file, '{\n  "gates": { "beforeFix": true }\n}\n')
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)

    const r = await core.invoke('config.save', {
      scope: 'project',
      folder,
      mode: 'row',
      pass: 'review',
      // Both new for Review: written.
      overrides: { passes: { review: { effort: 'high', model: 'opus' } } },
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      gates: { beforeFix: true },
      passes: { review: { effort: 'high', model: 'opus' } },
    })
    const resolved = await core.invoke('config.resolve', { folder })
    if (!resolved.ok) throw new Error(resolved.error.message)
    expect(resolved.value.config.passes.review.effort).toBe('high')
    expect(resolved.value.provenance['/passes/review/effort']?.source).toBe('project')

    // A default effort for Plan (null, as the layers already resolve it): nothing to write.
    const again = await core.invoke('config.save', {
      scope: 'project',
      folder,
      mode: 'row',
      pass: 'plan',
      overrides: { passes: { plan: { effort: null } } },
    })
    if (!again.ok) throw new Error(again.error.message)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      gates: { beforeFix: true },
      passes: { review: { effort: 'high', model: 'opus' } },
    })
  }, 60_000)
})
