// The chaos seam (src/core/chaos.ts, an E2E-only hook): the kill switch the chaos suite
// drives is armed only under DIM_FACTORY_E2E=1 with a well-formed DIM_FACTORY_E2E_CHAOS_KILL, kills its process at the
// nth arrival only (no exit handler runs), notes where, and a packaged build drops both variables before core reads
// its environment.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { armChaos, chaosArmed, parseChaosKill } from '../../../src/core/chaos.ts'
import { dropE2EEnv } from '../../../src/main/constants.ts'
import { REPO_ROOT } from '../run/scenario.ts'

const CHAOS = pathToFileURL(join(REPO_ROOT, 'src', 'core', 'chaos.ts')).href
const dirs: string[] = []
afterEach(() => {
  armChaos({}, '')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A node process that arms the switch from `env`, passes `point` three times, then exits 0 (if still alive). */
function run(
  env: Record<string, string>,
  point: string,
): { status: number | null; out: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-seam-'))
  dirs.push(dir)
  const marker = join(dir, 'chaos.json')
  const script = [
    `import { armChaos, chaosPoint } from ${JSON.stringify(CHAOS)}`,
    "process.on('exit', () => process.stdout.write('exit-handler\\n'))",
    `armChaos(process.env, ${JSON.stringify(marker)})`,
    `for (let i = 1; i <= 3; i++) { process.stdout.write('at ' + i + '\\n'); chaosPoint(${JSON.stringify(point)}) }`,
    "process.stdout.write('survived\\n')",
  ].join('\n')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', ...env },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  return { status: r.status, out: r.stdout, marker }
}

describe('chaos seam', () => {
  it('parses <point>[#n] and refuses anything else', () => {
    expect(parseChaosKill('effect:spawn')).toEqual({ point: 'effect:spawn', nth: 1 })
    expect(parseChaosKill(' event:adapter:done#12 ')).toEqual({ point: 'event:adapter:done', nth: 12 })
    for (const bad of [undefined, '', 'spawn', 'effect:spawn#0', 'effect:spawn#x', 'Effect:spawn', 'a:b c'])
      expect(parseChaosKill(bad)).toBeUndefined()
  })

  it('is armed only under DIM_FACTORY_E2E=1', () => {
    armChaos({ DIM_FACTORY_E2E_CHAOS_KILL: 'effect:spawn' }, 'x')
    expect(chaosArmed()).toBe(false)
    armChaos({ DIM_FACTORY_E2E: '0', DIM_FACTORY_E2E_CHAOS_KILL: 'effect:spawn' }, 'x')
    expect(chaosArmed()).toBe(false)
    armChaos({ DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_CHAOS_KILL: 'not a point' }, 'x')
    expect(chaosArmed()).toBe(false)
    armChaos({ DIM_FACTORY_E2E: '1' }, 'x')
    expect(chaosArmed()).toBe(false)
  })

  it('kills its process at the nth arrival, with no exit handler, and notes where', () => {
    const r = run(
      { DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_CHAOS_KILL: 'effect:snapshot#2' },
      'effect:snapshot',
    )
    expect(r.out).toBe('at 1\nat 2\n')
    expect(r.status).not.toBe(0)
    expect(JSON.parse(readFileSync(r.marker, 'utf8'))).toMatchObject({ point: 'effect:snapshot', n: 2 })
  }, 90_000)

  it('does nothing without DIM_FACTORY_E2E=1, or at another point', () => {
    for (const env of [
      { DIM_FACTORY_E2E_CHAOS_KILL: 'effect:snapshot' },
      { DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_CHAOS_KILL: 'effect:spawn' },
    ]) {
      const r = run(env, 'effect:snapshot')
      expect(r.out).toBe('at 1\nat 2\nat 3\nsurvived\nexit-handler\n')
      expect(r.status).toBe(0)
      expect(existsSync(r.marker)).toBe(false)
    }
  }, 90_000)

  it('a packaged build drops the switch with every other DIM_FACTORY_E2E* variable', () => {
    const env: Record<string, string | undefined> = {
      DIM_FACTORY_E2E: '1',
      DIM_FACTORY_E2E_CHAOS_KILL: 'effect:spawn',
      DIM_FACTORY_E2E_CHAOS_TRACE: 'C:\\trace.txt',
      PATH: 'x',
    }
    expect(dropE2EEnv(env, true).sort()).toEqual([
      'DIM_FACTORY_E2E',
      'DIM_FACTORY_E2E_CHAOS_KILL',
      'DIM_FACTORY_E2E_CHAOS_TRACE',
    ])
    expect(env).toEqual({ PATH: 'x' })
  })
})
