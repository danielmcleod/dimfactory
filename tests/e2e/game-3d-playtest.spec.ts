// The optional light 3D game in the real app (Electron). The fixture "Tilt Garden"
// (tests/fixtures/games/marble3d) draws with three.js loaded from the project's own node_modules through an import map,
// as a project made from the game-3d-lite template does after npm install; the copy comes from this repository's
// devDependency at test time. Its preview is a game's (loopback only, no internet), the module files come from the
// same origin, and Play-test plays its playtest.json with real key presses: every scenario passes (WebGL included), and
// so do the built-in checks (hook, canvas, loop, pause, the same seed, no errors, nothing from the internet). Without
// node_modules (before npm install) the smoke check names the module it could not load.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { layoutMarble3d } from '../unit/games/marble3d-fixture.ts'

const SCENARIOS = [
  'Space starts the game',
  'Arrow keys roll the marble',
  'P pauses the game',
  'The score starts at zero',
]

test('Play-test: the three.js marble game plays offline from node_modules and passes', async ({ e2e }) => {
  test.setTimeout(300_000)
  await e2e.start()
  layoutMarble3d(e2e.sandbox)
  const info = await e2e.call('preview.detect', { folder: e2e.sandbox })
  const stat = info.commands.find((c) => c.kind === 'static' && c.staticRoot === '.')
  expect(stat).toBeDefined()
  const session = await e2e.call('preview.start', { folder: e2e.sandbox, commandId: stat?.id ?? '' })
  expect(session.game).toBe(true)
  expect(session.network).toBe('loopback')

  const played = await e2e.call('preview.playtest', { sessionId: session.id })
  const r = played.report
  if (r === null) throw new Error(`nothing was played: ${played.problem ?? ''}`)
  expect(r.loaded).toBe(true)
  expect(r.hook).toBe(true)
  expect(r.scenarios.map((s) => [s.name, s.status, s.failure?.message ?? ''])).toEqual(
    SCENARIOS.map((n) => [n, 'pass', '']),
  )
  const status = Object.fromEntries(r.checks.map((c) => [c.id, c.status]))
  expect(status).toMatchObject({
    hook: 'pass',
    canvas: 'pass',
    loop: 'pass',
    pause: 'pass',
    determinism: 'pass',
    errors: 'pass',
    offline: 'pass',
  })
  expect(['pass', 'warn']).toContain(status['frames'])
  // three.js came from the project's own folder: nothing was asked of the internet.
  expect(r.blocked).toEqual([])

  // The smoke check loads the same page: it renders, with no failed loads.
  const smoke = await e2e.call('preview.smoke', { sessionId: session.id })
  expect(smoke.loaded).toBe(true)
  expect(smoke.failedLoads).toEqual([])
  expect(smoke.consoleErrors).toEqual([])
  expect(smoke.blocked ?? []).toEqual([])
  expect(smoke.checks?.find((c) => c.id === 'canvas')?.status).toBe('pass')

  // Before npm install there is no three.js to load: the smoke check names the missing module, and nothing plays.
  rmSync(join(e2e.sandbox, 'node_modules'), { recursive: true, force: true })
  const bare = await e2e.call('preview.smoke', { sessionId: session.id })
  expect(bare.failedLoads.map((f) => f.url).join(' ')).toContain('node_modules/three/build/three.module.js')
  expect(bare.blocked ?? []).toEqual([])
  await e2e.call('preview.stop', { sessionId: session.id })
  expect(e2e.pageErrors).toEqual([])
})
