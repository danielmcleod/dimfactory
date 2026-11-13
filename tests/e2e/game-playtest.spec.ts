// Automatic play-testing in the real app (Electron), with the fixture snake game on the starter engine.
// - A game folder's preview is loopback-only (no internet) and a game: Play-test plays its playtest.json in a hidden,
//   sandboxed window with real key presses and every scenario passes; the built-in checks pass (hook, canvas, loop,
//   pause, the same seed). A broken key binding makes "Arrow keys steer the snake" fail. A blank canvas is found by the
//   smoke check's game checks; a font asked for from the internet is blocked and recorded on the session; "Allow
//   internet for this preview" lifts the block in one click.
// - As a Verify check in a run (the fake Claude): Implement writes the game with a broken key binding, so the play-test
//   (a must scenario) fails Verify with a [must] finding; Fix writes the working game and Verify after Fix passes. The
//   run's smoke check then finds a blank canvas and a request to the internet as [should] findings.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { git } from '../integration/run/scenario.ts'
import { PLAYTEST_COMMAND_NAME } from '../../src/shared/playtest.ts'
import {
  CDN_URL,
  SNAKE_HTML,
  SNAKE_SCENARIOS,
  blankCanvas,
  brokenKeys,
  cdnFont,
  layoutGame,
  playtestVerifyConfig,
} from './playtest-helpers.ts'

test('Play-test: the snake passes, a broken key fails, a blank canvas and a blocked request are found', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  await e2e.start()
  layoutGame(e2e.sandbox)
  const info = await e2e.call('preview.detect', { folder: e2e.sandbox })
  const stat = info.commands.find((c) => c.kind === 'static' && c.staticRoot === '.')
  expect(stat).toBeDefined()
  const session = await e2e.call('preview.start', { folder: e2e.sandbox, commandId: stat?.id ?? '' })
  // A game's preview: no internet until the user allows it.
  expect(session.game).toBe(true)
  expect(session.network).toBe('loopback')

  // ---- the snake plays: every scenario passes, so do the built-in checks ----
  const good = await e2e.call('preview.playtest', { sessionId: session.id })
  const r = good.report
  if (r === null) throw new Error(`nothing was played: ${good.problem ?? ''}`)
  expect(r.loaded).toBe(true)
  expect(r.hook).toBe(true)
  expect(r.scenarios.map((s) => [s.name, s.status, s.failure?.message ?? ''])).toEqual(
    SNAKE_SCENARIOS.map((n) => [n, 'pass', '']),
  )
  expect(r.scenarios[0]?.screenshots).toEqual([])
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
  expect(r.blocked).toEqual([])

  // ---- a broken key binding: steering fails, the rest still pass ----
  writeFileSync(join(e2e.sandbox, 'index.html'), brokenKeys(SNAKE_HTML))
  const broken = await e2e.call('preview.playtest', { sessionId: session.id })
  const steer = broken.report?.scenarios.find((s) => s.name === 'Arrow keys steer the snake')
  expect(steer?.status).toBe('fail')
  expect(steer?.failure?.message).toBe('expected dir.y to be 1, got 0')
  expect(broken.report?.scenarios.find((s) => s.name === 'Space starts the game')?.status).toBe('pass')

  // ---- a blank canvas: the smoke check's game checks say so ----
  writeFileSync(join(e2e.sandbox, 'index.html'), blankCanvas(SNAKE_HTML))
  const blank = await e2e.call('preview.smoke', { sessionId: session.id })
  expect(blank.loaded).toBe(true)
  expect(blank.checks?.find((c) => c.id === 'canvas')).toMatchObject({
    status: 'fail',
    title: 'The canvas is blank: it shows one flat colour',
  })

  // ---- a font from the internet: blocked, recorded, then allowed with one click ----
  writeFileSync(join(e2e.sandbox, 'index.html'), cdnFont(SNAKE_HTML))
  const cdn = await e2e.call('preview.smoke', { sessionId: session.id })
  expect(cdn.blocked?.map((b) => b.url)).toContain(CDN_URL)
  expect(cdn.checks?.find((c) => c.id === 'offline')?.status).toBe('fail')
  const listed = (await e2e.call('preview.list')).find((s) => s.id === session.id)
  expect(listed?.blocked?.hosts).toContain('fonts.example.invalid')
  expect(listed?.blocked?.count).toBeGreaterThan(0)
  const allowed = await e2e.call('preview.network', { sessionId: session.id, internet: true })
  expect(allowed.network).toBe('internet')

  // ---- no playtest.json: Play-test says so and plays nothing ----
  writeFileSync(
    join(e2e.sandbox, 'playtest.json'),
    '{"version":1,"scenarios":[{"name":"x","steps":[{"eval":"1"}]}]}',
  )
  const refused = await e2e.call('preview.playtest', { sessionId: session.id })
  expect(refused.report).toBeNull()
  expect(refused.problem).toMatch(/playtest.json does not fit its format/)
  await e2e.call('preview.stop', { sessionId: session.id })
  expect(e2e.pageErrors).toEqual([])
})

test('Verify: a failing must scenario makes Verify red, Fix repairs the game, the smoke check finds the rest', async ({
  e2e,
}) => {
  test.setTimeout(400_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'index.html', content: brokenKeys(SNAKE_HTML) },
        },
      ],
      // Fix continues Implement's session (C08b) and writes the working game.
      resume: [
        {
          recording: 'C08b-resume-fix',
          write: { path: 'index.html', content: SNAKE_HTML },
          text: 'F1 fixed',
        },
      ],
    },
  })
  layoutGame(e2e.sandbox)
  playtestVerifyConfig(e2e.sandbox)
  git(e2e.sandbox, 'add', '-A')
  git(e2e.sandbox, 'commit', '-q', '-m', 'a snake game with a play-test')

  const run = await e2e.runFromDashboard('Make the snake steer with the arrow keys')
  await e2e.approvePlan()
  const ended = await e2e.waitForEnd(run.runId, 300_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  const doc = JSON.parse(readFileSync(join(e2e.home, 'runs', run.runId, 'run.json'), 'utf8')) as {
    state: {
      steps: Record<
        string,
        {
          status: string
          verify?: {
            commands: {
              name: string
              status: string
              reason?: string
              scenarios?: { name: string; status: string }[]
            }[]
            findings?: { severity: string; title: string; body: string }[]
          }
        }
      >
    }
  }
  const v1 = doc.state.steps['verify:1']?.verify?.commands.find((c) => c.name === PLAYTEST_COMMAND_NAME)
  expect(v1?.status).toBe('fail')
  expect(v1?.reason).toBe('1 of 3 must scenarios did not pass: Arrow keys steer the snake')
  expect(v1?.scenarios?.map((s) => `${s.status} ${s.name}`)).toEqual([
    'pass Space starts the game',
    'fail Arrow keys steer the snake',
    'pass P pauses the game',
    'pass The score starts at zero',
  ])
  const findings = doc.state.steps['verify:1']?.verify?.findings ?? []
  expect(findings.map((f) => f.severity)).toEqual(['must'])
  expect(findings[0]?.body).toContain('Arrow keys steer the snake')
  // Fix ran on the failing play-test and Verify after Fix is green.
  expect(doc.state.steps['fix']?.status).toBe('done')
  const v2 = doc.state.steps['verify:2']?.verify?.commands.find((c) => c.name === PLAYTEST_COMMAND_NAME)
  expect(v2?.status).toBe('pass')
  expect(readFileSync(join(e2e.sandbox, 'index.html'), 'utf8')).toBe(SNAKE_HTML)
  // The Fix prompt was given the failing scenario.
  const fixPrompt = e2e
    .fakeLog()
    .filter((x) => x.kind === 'stdin')
    .map((x) => JSON.stringify(x))
    .find((t) => t.includes('fix') && t.includes('Arrow keys steer the snake'))
  expect(fixPrompt).toBeDefined()

  // The Verify card names each scenario as passed or failed (on a click).
  const toggle = page.locator('[data-testid$="-scenarios-toggle"]').first()
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await toggle.click()
  const rows = page.locator('[data-testid$="-scenario"]')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'fail')
  await expect(rows.nth(1)).toContainText('Failed')
  await expect(rows.nth(1)).toContainText('Arrow keys steer the snake')
  await expect(rows.nth(3)).toContainText('(not required)')

  // ---- the run's smoke check: a blank canvas and a request to the internet are [should] findings ----
  writeFileSync(join(e2e.sandbox, 'index.html'), cdnFont(blankCanvas(SNAKE_HTML)))
  const info = await e2e.call('preview.detect', { runId: run.runId })
  const stat = info.commands.find((c) => c.kind === 'static' && c.staticRoot === '.')
  const session = await e2e.call('preview.start', { runId: run.runId, commandId: stat?.id ?? '' })
  expect(session.network).toBe('loopback')
  const smoke = await e2e.call('preview.smoke', { sessionId: session.id })
  const titles = smoke.findings.map((f) => `[${f.severity}] ${f.title}`)
  expect(titles).toContain('[should] Game check: The canvas is blank: it shows one flat colour')
  expect(titles).toContain(
    '[should] The game tried to load something from the internet (fonts.example.invalid); game previews have no internet, so it was blocked',
  )
  await e2e.call('preview.stop', { sessionId: session.id })
})
