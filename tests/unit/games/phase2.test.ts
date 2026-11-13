// Games, phase 2 in core: the starter's test hook keeps its contract (ready, actions(), step(ticks) with a range, a
// state capped at 8 KB, a deterministic fixed step); Easy picks the helper, Phaser and Vite templates from the idea; a
// folder counts as a game for its preview; what page the play-test serves; the smoke check's game findings (a blank
// canvas, a blocked request to the internet; a stutter is no finding) and its picture of play; the game variant of
// "Look it over".
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { saveBrief } from '@core/brief/store.ts'
import { chooseTemplate } from '@core/easy/resolve.ts'
import { visualPrompt } from '@core/easy/visual.ts'
import { homePaths } from '@core/home.ts'
import { gamePageRoot, isGameFolder } from '@core/preview/game.ts'
import { gameFindings, recordSmoke } from '@core/preview/smoke.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-games2-'))
  dirs.push(d)
  return d
}

const starter = fileURLToPath(new URL('../../../src/core/templates/vendor/starter/game/', import.meta.url))
const load = async <T>(name: string): Promise<T> =>
  (await import(/* @vite-ignore */ pathToFileURL(starter + name).href)) as T

interface Hook {
  version: number
  ready: boolean
  actions: () => string[]
  pause: () => void
  step: (n?: number) => void
  press: (a: string) => void
  seed: (n?: number) => unknown
  state: () => Record<string, unknown>
}

describe('the starter test hook contract', async () => {
  const { installTestHook, STATE_MAX_BYTES } = await load<{
    installTestHook: (o: Record<string, unknown>) => Hook | null
    STATE_MAX_BYTES: number
  }>('test-hook.js')
  const { createLoop } = await load<{ createLoop: (o: Record<string, unknown>) => { ticks: number } }>(
    'loop.js',
  )
  const { createInput } = await load<{ createInput: (o?: Record<string, unknown>) => unknown }>('input.js')
  const { createRng } = await load<{ createRng: (s?: number) => { seed: number; next: () => number } }>(
    'rng.js',
  )

  /** A tiny game whose state depends on the seed and every fixed step. */
  function setup(big = false) {
    let rng = createRng(5)
    const game = { scene: 'title', score: 0, lives: 3, level: 1, x: 0, pad: big ? 'x'.repeat(10_000) : '' }
    const loop = createLoop({
      update: (dt: number) => {
        game.x += Math.floor(rng.next() * 10) + dt
      },
      render: () => undefined,
      requestFrame: () => 1,
      cancelFrame: () => undefined,
      now: () => 0,
      target: new EventTarget(),
    })
    const input = createInput({ target: new EventTarget(), gamepad: false })
    const hook = installTestHook({
      loop,
      input,
      rng,
      state: () => ({ ...game }),
      setSeed: (n: number) => {
        rng = createRng(n)
        game.x = 0
      },
      location: { search: '?test=1' },
      target: {},
    }) as Hook
    return { hook, game }
  }

  it('is ready and lists the input actions', () => {
    const { hook } = setup()
    expect(hook.ready).toBe(true)
    expect(hook.actions()).toEqual(['action', 'down', 'left', 'pause', 'right', 'up'])
  })

  it('step(ticks) takes 1 to 3600 and is deterministic for a seed', () => {
    const a = setup().hook
    const b = setup().hook
    for (const h of [a, b]) {
      h.pause()
      h.seed(9)
      h.step(120)
    }
    expect(a.state()).toEqual(b.state())
    expect(a.state()['ticks']).toBe(120)
    expect(() => a.step(0)).toThrow(RangeError)
    expect(() => a.step(3601)).toThrow(RangeError)
    expect(() => a.step(Number.NaN)).toThrow(RangeError)
  })

  it('a state over 8 KB is cut to the fields every game reports', () => {
    const { hook } = setup(true)
    const s = hook.state()
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(STATE_MAX_BYTES)
    expect(s).toEqual({
      truncated: true,
      reducedMotion: false,
      paused: false,
      ticks: 0,
      scene: 'title',
      score: 0,
      lives: 3,
      level: 1,
    })
  })
})

describe('Easy picks the phase 2 templates from the idea', () => {
  const both = { node: true, python: true }
  it('a game helper, a platformer, a Vite game (with Node), else the canvas arcade', () => {
    expect(chooseTemplate('game', 'A dice roller for our tabletop nights', both).templateId).toBe('game-tool')
    expect(chooseTemplate('game', 'A scorekeeper for board game night', both).templateId).toBe('game-tool')
    expect(chooseTemplate('game', 'A tournament bracket for our office league', both).templateId).toBe(
      'game-tool',
    )
    expect(chooseTemplate('game', 'A platformer where a fox jumps between trees', both).templateId).toBe(
      'game-phaser',
    )
    expect(chooseTemplate('game', 'A top-down dungeon crawler with keys and doors', both).templateId).toBe(
      'game-phaser',
    )
    expect(chooseTemplate('game', 'A space shooter in TypeScript with Vite', both).templateId).toBe(
      'game-vite',
    )
    expect(
      chooseTemplate('game', 'A space shooter in TypeScript with Vite', { node: false, python: false }),
    ).toEqual({
      templateId: 'game-canvas',
      fallback: { wanted: 'game-vite', needs: 'node' },
    })
    expect(chooseTemplate('game', 'A snake game I can play on my phone', both).templateId).toBe('game-canvas')
    expect(chooseTemplate('game', 'A memory game with our family photos', both).templateId).toBe('game-board')
  })
})

describe('a game folder and the page it plays', () => {
  it('is a game by its Brief, its playtest.json or the starter hook', async () => {
    const home = temp()
    const a = temp()
    expect(await isGameFolder(home, a)).toBe(false)
    await saveBrief(home, a, { category: 'games', fields: {} }, 1)
    expect(await isGameFolder(home, a)).toBe(true)
    const b = temp()
    writeFileSync(join(b, 'playtest.json'), '{}')
    expect(await isGameFolder(home, b)).toBe(true)
    const c = temp()
    mkdirSync(join(c, 'src', 'engine'), { recursive: true })
    writeFileSync(join(c, 'src', 'engine', 'test-hook.js'), '')
    expect(await isGameFolder(home, c)).toBe(true)
  })

  it('plays its index.html, a Vite game only once built (dist/)', async () => {
    const plain = temp()
    expect(await gamePageRoot(plain)).toEqual({ reason: 'There is no index.html to play' })
    writeFileSync(join(plain, 'index.html'), '<canvas></canvas>')
    expect(await gamePageRoot(plain)).toEqual({ dir: plain })
    const vite = temp()
    writeFileSync(join(vite, 'index.html'), '<script type="module" src="/src/main.ts"></script>')
    writeFileSync(join(vite, 'package.json'), JSON.stringify({ devDependencies: { vite: '^7.0.0' } }))
    const unbuilt = await gamePageRoot(vite)
    expect('reason' in unbuilt && unbuilt.reason).toMatch(/Build the game first/)
    mkdirSync(join(vite, 'dist'))
    writeFileSync(join(vite, 'dist', 'index.html'), '<canvas></canvas>')
    expect(await gamePageRoot(vite)).toEqual({ dir: join(vite, 'dist') })
  })
})

describe("the smoke check's game findings", () => {
  it('a blocked request, a failed load and a failed check are findings; a stutter is not', () => {
    const out = gameFindings({
      checks: [
        { id: 'canvas', status: 'fail', title: 'The canvas is blank: it shows one flat colour' },
        { id: 'frames', status: 'warn', title: 'The game may stutter: frames come late' },
        { id: 'loop', status: 'pass', title: 'The game loop runs' },
        { id: 'offline', status: 'fail', title: 'It tried to reach the internet' },
      ],
      failedLoads: [{ url: 'http://127.0.0.1:5000/sprites.png', error: '404' }],
      blocked: [
        { url: 'https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.min.js', host: 'cdn.jsdelivr.net' },
        { url: 'https://cdn.jsdelivr.net/other.js', host: 'cdn.jsdelivr.net' },
      ],
    })
    expect(out.map((f) => f.title)).toEqual([
      'The game could not load http://127.0.0.1:5000/sprites.png (404)',
      'The game tried to load something from the internet (cdn.jsdelivr.net); game previews have no internet, so it was blocked',
      'Game check: The canvas is blank: it shows one flat colour',
    ])
  })

  it("a run's smoke check keeps them as [should] findings with the picture of play", async () => {
    const paths = homePaths(temp())
    const runId = '20261026T120000Z-game'
    const view = await recordSmoke(paths, {
      sessionId: 'pv1',
      runId,
      at: 1,
      seen: {
        url: 'http://127.0.0.1:5000/',
        loaded: true,
        consoleErrors: [{ message: 'Uncaught TypeError: x is undefined' }],
        failedLoads: [],
        thumbnail: null,
        png: new Uint8Array([1, 2, 3]),
        checks: [{ id: 'canvas', status: 'fail', title: 'The canvas is blank: it shows one flat colour' }],
        measures: { canvasVariance: 0 },
        blocked: [{ url: 'https://fonts.example.com/a.woff2', host: 'fonts.example.com' }],
        gamePng: new Uint8Array([4, 5, 6]),
      },
    })
    expect(view.findings.map((f) => [f.severity, f.source, f.n])).toEqual([
      ['should', 'preview', 1],
      ['should', 'preview', 2],
      ['should', 'preview', 3],
    ])
    expect(view.findings[1]!.title).toMatch(/internet \(fonts\.example\.com\)/)
    expect(view.findings[2]!.title).toBe('Game check: The canvas is blank: it shows one flat colour')
    expect(view.checks).toHaveLength(1)
    expect(view.blocked).toHaveLength(1)
    expect(readFileSync(view.gameplayPath ?? '')).toEqual(Buffer.from([4, 5, 6]))
  })
})

describe('"Look it over" for a game', () => {
  it('looks at two pictures for the HUD, the play area, placeholder art, contrast and famous characters', () => {
    const p = visualPrompt('game')
    expect(p).toContain('the first is its title screen, the second a moment of play')
    for (const w of [
      'HUD',
      'play area',
      'placeholder art',
      'colours that are hard to tell apart',
      'famous game',
    ])
      expect(p).toContain(w)
    expect(p).toContain('```json')
    expect(visualPrompt()).toContain('screenshot of a web page')
  })
})
