// The config load check, through a real core: the built adapters' forbidden flags reach it, so a user
// file whose Gemini extraArgs combine a forbidden letter (`-dy` is `--debug --yolo`) is invalid at its `file:line:col`
// (config.read, the composer's app.config.user check), and Settings cannot write one either.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { cleanup, hermeticEnv, makeHome, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

async function home(): Promise<{ home: string; file: string }> {
  const sc = await makeScenario({})
  const { home } = await makeHome(sc)
  dirs.push(home, sc.dir)
  return { home, file: join(home, 'dimfactory.json') }
}

describe('forbidden flags in the user file', () => {
  it('config.read reports -dy for Gemini at its line; a Settings write of --yolo is refused', async () => {
    const { home: h, file } = await home()
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
    cfg['vendors'] = { ...cfg['vendors'], gemini: { extraArgs: ['--debug', '-dy'] } }
    writeFileSync(file, JSON.stringify(cfg, null, 2))
    const core = await createCore({ home: h, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const read = await core.invoke('config.read', { scope: 'user' })
    if (!read.ok) throw new Error(read.error.message)
    const issue = read.value.issues.find((i) => i.code === 'forbidden-flag')
    expect(issue).toMatchObject({
      pointer: '/vendors/gemini/extraArgs/1',
      severity: 'error',
      message: '-dy combines -y with other short flags; -y widens what a pass may do',
    })
    const lines = read.value.text.split(/\r?\n/)
    expect(lines[(issue?.line ?? 0) - 1]).toContain('"-dy"')

    // A Settings write that would add a forbidden flag is refused with the same words, and nothing is written.
    writeFileSync(file, JSON.stringify({ ...cfg, vendors: { ...cfg['vendors'], gemini: {} } }, null, 2))
    const before = readFileSync(file, 'utf8')
    const write = await core.invoke('config.patch', {
      scope: 'user',
      ops: [{ op: 'add', path: '/vendors/gemini/extraArgs', value: ['--yolo'] }],
    })
    expect(write.ok).toBe(false)
    if (!write.ok) expect(write.error.message).toContain('--yolo widens what a pass may do')
    expect(readFileSync(file, 'utf8')).toBe(before)
  }, 120_000)
})
