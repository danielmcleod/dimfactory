// Games phase 2 for the E2E specs: a game folder laid out from the fixture snake game (tests/fixtures/games/snake) on the
// starter engine the templates copy (src/engine/), its playtest.json, and variants of the page: a broken key binding,
// a blank canvas, a font asked for from the internet.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import { PLAYTEST_ARGV, PLAYTEST_COMMAND_NAME } from '../../src/shared/playtest.ts'

export const SNAKE_HTML = readFileSync(
  join(REPO_ROOT, 'tests', 'fixtures', 'games', 'snake', 'index.html'),
  'utf8',
)
const ENGINE = join(REPO_ROOT, 'src', 'core', 'templates', 'vendor', 'starter', 'game')

/** The snake game's scenarios: three a player must be able to do, one only reported. */
export const SNAKE_PLAYTEST = {
  version: 1,
  seed: 1,
  scenarios: [
    {
      name: 'Space starts the game',
      steps: [
        { key: 'Space' },
        { wait: { ms: 200 } },
        { expect: 'scene', eq: 'playing' },
        { screenshot: 'playing' },
      ],
    },
    {
      name: 'Arrow keys steer the snake',
      steps: [
        { key: 'Space' },
        { hold: 'ArrowDown', ms: 300 },
        { wait: { ms: 300 } },
        { expect: 'dir.y', eq: 1 },
        { expect: 'head.y', changed: true },
      ],
    },
    {
      name: 'P pauses the game',
      steps: [
        { key: 'Space' },
        { wait: { ms: 150 } },
        { key: 'KeyP' },
        { wait: { ms: 150 } },
        { expect: 'scene', eq: 'paused' },
      ],
    },
    { name: 'The score starts at zero', must: false, steps: [{ expect: 'score', eq: 0 }] },
  ],
}

export const SNAKE_SCENARIOS = SNAKE_PLAYTEST.scenarios.map((s) => s.name)

/** ArrowDown is no longer bound (down is on S only): "Arrow keys steer the snake" fails. */
export function brokenKeys(html: string): string {
  const out = html.replace(
    'const input = createInput()',
    "const input = createInput({ bindings: { left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['KeyS'], action: ['Space', 'Enter'], pause: ['KeyP', 'Escape'] } })",
  )
  if (out === html) throw new Error('the fixture changed: no createInput() to break')
  return out
}

/** Nothing is ever drawn on the canvas (the rules still run). */
export function blankCanvas(html: string): string {
  const out = html.replace(
    /const loop = createLoop\(\{\n(\s+)update,\n\s+render,/,
    'const loop = createLoop({\n$1update,\n$1render: () => undefined,',
  )
  if (out === html) throw new Error('the fixture changed: no render to blank')
  return out
}

/** A web font asked for from another computer (a game preview blocks it). */
export const CDN_URL = 'https://fonts.example.invalid/garden.css'
export function cdnFont(html: string): string {
  return html.replace(
    '<title>Garden Snake</title>',
    `<title>Garden Snake</title>\n    <link rel="stylesheet" href="${CDN_URL}" />`,
  )
}

/** The game in `folder`: the starter engine, its page and (unless null) its playtest.json. */
export function layoutGame(folder: string, html = SNAKE_HTML, playtest: unknown = SNAKE_PLAYTEST): void {
  mkdirSync(join(folder, 'src', 'engine'), { recursive: true })
  for (const f of ['loop.js', 'rng.js', 'input.js', 'storage.js', 'test-hook.js'])
    cpSync(join(ENGINE, f), join(folder, 'src', 'engine', f))
  writeFileSync(join(folder, 'index.html'), html)
  if (playtest !== null)
    writeFileSync(join(folder, 'playtest.json'), `${JSON.stringify(playtest, null, 2)}\n`)
}

/** A project config that verifies with Dim Factory's own play-test after Implement and after Fix. */
export function playtestVerifyConfig(folder: string): void {
  mkdirSync(join(folder, '.dimfactory'), { recursive: true })
  writeFileSync(
    join(folder, '.dimfactory', 'dimfactory.json'),
    `${JSON.stringify(
      {
        verify: {
          enabled: true,
          runAfter: ['implement', 'fix'],
          commands: [{ name: PLAYTEST_COMMAND_NAME, run: [...PLAYTEST_ARGV] }],
        },
      },
      null,
      2,
    )}\n`,
  )
}
