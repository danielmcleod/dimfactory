// Games phase 3, the parts with no window: a play-test's phone scenarios and reduced motion (driven through a fake page
// and a fake emulator: a phone scenario sets phone size, taps with a real touch and goes back; reduced motion is the
// system setting, or the starter's ?reducedMotion=1 flag without an emulator), the reduced-motion check's verdicts, the
// preview window's DevTools protocol rules (which windows, which commands), the name check (famous games' names in the
// title, README title and file names), the server focus lines for a game server, and the Full-mode online template
// (copied with its server, offered as `node server.js` only once trusted, refused by Easy, which offers pass and play
// or play by link instead).
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { briefRecord } from '@core/brief/brief.ts'
import { EasyService } from '@core/easy/service.ts'
import type { EasyDeps } from '@core/easy/service.ts'
import { asksOnlinePlay, chooseTemplate, easyTask, ideaBrief, onlineInstead } from '@core/easy/resolve.ts'
import { silentLogger } from '@core/log.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { detectPreviewCommands } from '@core/preview/detect.ts'
import {
  checkGameNames,
  famousNameIn,
  findFamousNames,
  nameWords,
  namesCheck,
  pageTitleOf,
  readmeTitleOf,
} from '@core/preview/names.ts'
import { gameFindings } from '@core/preview/smoke.ts'
import { copyTemplateFiles, readVendorManifest } from '@core/templates/files.ts'
import { loadTemplates, readBuiltinTemplates, templatePackProblem } from '@core/templates/load.ts'
import { GAMES_CATEGORY, PackZ, renderSecurityFocus } from '@shared/brief.ts'
import type { Pack } from '@shared/brief.ts'
import type { RunStartRequest } from '@shared/ipc.ts'
import { PHONE_VIEWPORT, PlaytestSpecZ, parsePlaytestText } from '@shared/playtest.ts'
import type { PlaytestSpec } from '@shared/playtest.ts'
import { TEMPLATE_TASK_MAX, TemplateZ, templateTargetProblem } from '@shared/templates.ts'
import type { Template } from '@shared/templates.ts'
import { GameDriver, checkReducedMotion, runScenarios } from '../../../src/main/playtest.ts'
import type { PageEmulator } from '../../../src/main/playtest.ts'
import { CANVAS_RECT_JS, STATE_JS, motionCheck, reducedMotionUrl } from '../../../src/main/playtest-model.ts'
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  PREVIEW_DEBUGGER_METHODS,
  debuggerAllowed,
  phoneKeyAction,
  previewTitle,
  reducedMotionCommand,
  touchEmulationCommands,
  touchTapCommands,
} from '../../../src/main/preview-model.ts'

const views = readBuiltinPacks()
const packs = views.map((v) => v.pack)
const games = packs.find((p) => p.id === GAMES_CATEGORY) as Pack
const NAMES = games.namesToAvoid ?? []
const templates = readBuiltinTemplates()
const template = (id: string): Template => templates.find((t) => t.id === id) as Template

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-games3-'))
  dirs.push(d)
  return d
}

// ---- a fake page and emulator -------------------------------------------------------------------------------------

interface FakeGame {
  wc: WebContents
  emulator: PageEmulator
  calls: string[]
  inputs: unknown[]
  urls: string[]
}

/**
 * A game page that answers the play-test's fixed scripts: its state says the scene (a touch tap starts it), whether
 * reduced motion is on (the emulated setting, or ?reducedMotion=1), and ticks. `reports` false: a state without
 * reducedMotion.
 */
function fakeGame(o: { reports?: boolean; emulate?: boolean } = {}): FakeGame {
  const ev = new EventEmitter()
  const calls: string[] = []
  const inputs: unknown[] = []
  const urls: string[] = []
  let url = ''
  let reduced = false
  let scene = 'title'
  let ticks = 0
  const wc = {
    isDestroyed: () => false,
    once: (e: string, f: (...a: unknown[]) => void) => ev.once(e, f),
    on: (e: string, f: (...a: unknown[]) => void) => ev.on(e, f),
    removeListener: (e: string, f: (...a: unknown[]) => void) => ev.removeListener(e, f),
    loadURL: (u: string) => {
      url = u
      urls.push(u)
      scene = 'title'
      setTimeout(() => ev.emit('did-finish-load'), 5)
      return Promise.resolve()
    },
    executeJavaScript: (js: string) => {
      if (js === STATE_JS) {
        ticks += 5
        const flag = new URL(url).searchParams.get('reducedMotion') === '1'
        return Promise.resolve(
          JSON.stringify({
            scene,
            score: 0,
            lives: 1,
            level: 1,
            ticks,
            ...(o.reports === false ? {} : { reducedMotion: reduced || flag }),
          }),
        )
      }
      if (js === CANVAS_RECT_JS)
        return Promise.resolve(JSON.stringify({ x: 10, y: 20, width: 200, height: 100 }))
      if (js.includes('window.__game')) return Promise.resolve('ok')
      return Promise.resolve(undefined)
    },
    sendInputEvent: (e: unknown) => inputs.push(e),
    capturePage: () => Promise.resolve({ isEmpty: () => true }),
  } as unknown as WebContents
  const emulator: PageEmulator = {
    viewport: (phone) => {
      calls.push(`viewport ${phone}`)
      return Promise.resolve(true)
    },
    reducedMotion: (on) => {
      calls.push(`reducedMotion ${on}`)
      reduced = on
      return Promise.resolve(true)
    },
    tap: (x, y) => {
      calls.push(`tap ${x},${y}`)
      scene = 'playing'
      return Promise.resolve(true)
    },
  }
  return { wc, emulator, calls, inputs, urls }
}

const driverOf = (g: FakeGame, emulate = true): GameDriver =>
  new GameDriver(g.wc, {
    clearStorage: () => Promise.resolve(),
    ...(emulate ? { emulator: g.emulator } : {}),
  })

const URL_ = 'http://127.0.0.1:5555/'
const spec = (s: unknown): PlaytestSpec => PlaytestSpecZ.parse({ version: 1, scenarios: [s] })

describe('a phone scenario', () => {
  it('parses with viewport and reducedMotion, and refuses anything else', () => {
    expect(
      parsePlaytestText(
        JSON.stringify({
          version: 1,
          scenarios: [{ name: 'Tap', viewport: 'phone', reducedMotion: true, steps: [{ tap: [0.5, 0.5] }] }],
        }),
      ).ok,
    ).toBe(true)
    expect(
      parsePlaytestText(
        JSON.stringify({ version: 1, scenarios: [{ name: 'Tap', viewport: 'tablet', steps: [] }] }),
      ).ok,
    ).toBe(false)
    expect(PHONE_VIEWPORT).toEqual({ width: 390, height: 844 })
  })

  it('plays at phone size, taps with a real touch (not the mouse), then goes back to the desktop window', async () => {
    const g = fakeGame()
    const out = await runScenarios(
      driverOf(g),
      URL_,
      spec({
        name: 'A tap starts the game',
        viewport: 'phone',
        steps: [{ tap: [0.5, 0.5] }, { expect: 'scene', eq: 'playing' }],
      }),
      null,
    )
    expect(out.map((s) => s.status)).toEqual(['pass'])
    // The middle of the canvas box (10, 20, 200 by 100).
    expect(g.calls).toEqual(['viewport true', 'tap 110,70', 'viewport false'])
    expect(g.inputs).toEqual([])
  })

  it('a tap on a desktop scenario stays a mouse click', async () => {
    const g = fakeGame()
    const out = await runScenarios(
      driverOf(g),
      URL_,
      spec({ name: 'Click', steps: [{ tap: [0.5, 0.5] }] }),
      null,
    )
    expect(out[0]?.status).toBe('pass')
    expect(g.calls).toEqual([])
    expect(g.inputs.map((e) => (e as { type: string }).type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
  })

  it('without an emulator (no Dim Factory window) a phone scenario is not played', async () => {
    const g = fakeGame()
    const out = await runScenarios(
      driverOf(g, false),
      URL_,
      spec({ name: 'Tap', viewport: 'phone', steps: [{ tap: [0.5, 0.5] }] }),
      null,
    )
    expect(out[0]).toMatchObject({ status: 'error', failure: { what: 'open the game at phone size' } })
    expect(out[0]?.failure?.message).toMatch(/needs the Dim Factory app/)
  })
})

describe('reduced motion', () => {
  it('a reduced-motion scenario on the snake-like page: the system setting on, then off again', async () => {
    const g = fakeGame()
    const out = await runScenarios(
      driverOf(g),
      URL_,
      spec({ name: 'Calm', reducedMotion: true, steps: [{ expect: 'reducedMotion', eq: true }] }),
      null,
    )
    expect(out[0]?.status).toBe('pass')
    expect(g.calls).toEqual(['reducedMotion true', 'reducedMotion false'])
    expect(g.urls.every((u) => !u.includes('reducedMotion'))).toBe(true)
  })

  it("without an emulator a reduced-motion scenario uses the starter's ?reducedMotion=1 flag", async () => {
    const g = fakeGame()
    const out = await runScenarios(
      driverOf(g, false),
      URL_,
      spec({ name: 'Calm', reducedMotion: true, steps: [{ expect: 'reducedMotion', eq: true }] }),
      null,
    )
    expect(out[0]?.status).toBe('pass')
    expect(g.urls[0]).toContain('reducedMotion=1')
  })

  it('the built-in check passes when the state says so, emulated or by the flag', async () => {
    const g = fakeGame()
    expect(await checkReducedMotion(driverOf(g), URL_)).toMatchObject({ id: 'motion', status: 'pass' })
    expect(g.calls).toEqual(['reducedMotion true', 'reducedMotion false'])
    const h = fakeGame()
    expect(await checkReducedMotion(driverOf(h, false), URL_)).toMatchObject({ status: 'pass' })
    expect(h.urls[0]).toContain('reducedMotion=1')
  })

  it('is a [should] finding when the state does not say it, or says false', async () => {
    const check = await checkReducedMotion(driverOf(fakeGame({ reports: false })), URL_)
    expect(check).toMatchObject({ id: 'motion', status: 'fail' })
    expect(motionCheck({ reducedMotion: false })).toMatchObject({
      status: 'fail',
      title: 'The game ignores reduced motion',
    })
    expect(motionCheck(null).status).toBe('skipped')
    const found = gameFindings({ checks: [check], failedLoads: [], blocked: [] })
    expect(found.map((f) => f.title)).toEqual([
      'Game check: The game does not say whether it follows reduced motion',
    ])
    expect(reducedMotionUrl('http://127.0.0.1:1/?test=1')).toBe('http://127.0.0.1:1/?test=1&reducedMotion=1')
  })

  it("the starter's test hook reports reduced motion (the setting, the flag, or the game's own)", async () => {
    const { pathToFileURL } = await import('node:url')
    const file = join(process.cwd(), 'src', 'core', 'templates', 'vendor', 'starter', 'game', 'test-hook.js')
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
      installTestHook: (o: Record<string, unknown>) => { state: () => Record<string, unknown> } | null
      prefersReducedMotion: (o: Record<string, unknown>) => boolean
    }
    const base = {
      loop: { pause() {}, resume() {}, stepOnce() {}, paused: false, ticks: 3 },
      input: { press() {}, release() {} },
      rng: { seed: 1 },
      state: () => ({ scene: 'title', score: 0, lives: 1, level: 1 }),
    }
    const reduce = (q: string): { matches: boolean } => ({ matches: q.includes('reduce') })
    const none = (): { matches: boolean } => ({ matches: false })
    expect(mod.prefersReducedMotion({ location: { search: '' }, matchMedia: reduce })).toBe(true)
    expect(mod.prefersReducedMotion({ location: { search: '?reducedMotion=1' }, matchMedia: none })).toBe(
      true,
    )
    expect(mod.prefersReducedMotion({ location: { search: '' }, matchMedia: none })).toBe(false)
    const hook = mod.installTestHook({ ...base, location: { search: '?test=1&reducedMotion=1' }, target: {} })
    expect(hook?.state()).toMatchObject({ reducedMotion: true, paused: false, ticks: 3 })
    const own = mod.installTestHook({
      ...base,
      location: { search: '?test=1' },
      target: {},
      reducedMotion: () => true,
    })
    expect(own?.state()['reducedMotion']).toBe(true)
  })
})

describe("the preview window's DevTools protocol", () => {
  it('is for the game preview window and the hidden smoke and play-test windows, never Save as PDF', () => {
    expect(debuggerAllowed('window')).toBe(true)
    expect(debuggerAllowed('smoke')).toBe(true)
    expect(debuggerAllowed('playtest')).toBe(true)
    expect(debuggerAllowed('pdf')).toBe(false)
  })

  it('sends only touch emulation, reduced motion and touch taps', () => {
    expect([...PREVIEW_DEBUGGER_METHODS].sort()).toEqual([
      'Emulation.setEmitTouchEventsForMouse',
      'Emulation.setEmulatedMedia',
      'Emulation.setTouchEmulationEnabled',
      'Input.dispatchTouchEvent',
    ])
    const all = [
      ...touchEmulationCommands(true),
      ...touchEmulationCommands(false),
      reducedMotionCommand(true),
      reducedMotionCommand(false),
      ...touchTapCommands(10.4, 20.6),
    ]
    for (const c of all) expect(PREVIEW_DEBUGGER_METHODS.has(c.method), c.method).toBe(true)
    expect(touchEmulationCommands(true)[0]?.params).toEqual({ enabled: true, maxTouchPoints: 5 })
    expect(touchEmulationCommands(false).map((c) => c.params['enabled'])).toEqual([false, false])
    expect(reducedMotionCommand(true).params).toEqual({
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    expect(touchTapCommands(10.4, 20.6)[0]?.params['touchPoints']).toEqual([
      { x: 10, y: 21, radiusX: 4, radiusY: 4, force: 1, id: 1 },
    ])
  })

  it('Phone size is 390 by 844; Ctrl+Shift+M toggles it; the title says so', () => {
    expect(PHONE_SIZE).toEqual({ width: 390, height: 844 })
    expect(DESKTOP_SIZE).toEqual({ width: 1100, height: 780 })
    expect(phoneKeyAction({ type: 'keyDown', key: 'M', control: true, shift: true })).toBe('toggle')
    expect(phoneKeyAction({ type: 'keyDown', key: 'm', meta: true, shift: true })).toBe('toggle')
    expect(phoneKeyAction({ type: 'keyDown', key: 'm', control: true })).toBeNull()
    expect(phoneKeyAction({ type: 'keyUp', key: 'm', control: true, shift: true })).toBeNull()
    expect(phoneKeyAction({ type: 'keyDown', key: 'm', control: true, shift: true, alt: true })).toBeNull()
    expect(previewTitle('Garden Snake', URL_, true)).toBe('Preview (phone size): Garden Snake')
    expect(previewTitle('Garden Snake', URL_)).toBe('Preview: Garden Snake')
  })
})

describe('the name check', () => {
  it('reads words the same way whatever the spelling', () => {
    expect(nameWords('PacMan_clone-2.js')).toEqual(['pac', 'man', 'clone', '2', 'js'])
    expect(nameWords('Pokémon Quest')).toEqual(['pokemon', 'quest'])
  })

  it.each([
    ['Tetris Clone', 'Tetris'],
    ['tetris.js', 'Tetris'],
    ['My PACMAN game', 'Pac-Man'],
    ['pac-man', 'Pac-Man'],
    ['SuperMario Run', 'Super Mario'],
    ['src/game/super_mario.js', 'Super Mario'],
    ['Pokémon battle', 'Pokemon'],
    ['Flappy Bird but a fish', 'Flappy Bird'],
    ['Plants vs Zombies tower defence', 'Plants vs. Zombies'],
  ])('%j uses %s', (text, name) => {
    expect(famousNameIn(text, NAMES)).toBe(name)
  })

  it.each([
    'Garden Snake',
    'scenario.js',
    'Marionette Falls',
    'Block Drop',
    'src/engine/loop.js',
    'Brick Party',
  ])('%j is its own name', (text) => {
    expect(famousNameIn(text, NAMES)).toBeNull()
  })

  it('reads the page title and the README title', () => {
    expect(pageTitleOf('<html><head><title>\n  Block &amp; Drop </title>')).toBe('Block & Drop')
    expect(pageTitleOf('<p>none</p>')).toBeNull()
    expect(readmeTitleOf('\uFEFFSome intro\n# Garden Snake\n\n## How to play')).toBe('Garden Snake')
    expect(readmeTitleOf('No heading')).toBeNull()
  })

  it('finds a famous name in the title, the README title and file names, but not in lib/ or node_modules', async () => {
    const d = temp()
    writeFileSync(join(d, 'index.html'), '<title>Tetris Deluxe</title>')
    writeFileSync(join(d, 'README.md'), '# Tetris Deluxe\n')
    mkdirSync(join(d, 'src', 'game'), { recursive: true })
    writeFileSync(join(d, 'src', 'game', 'pacman-ghosts.js'), '')
    mkdirSync(join(d, 'lib', 'zelda'), { recursive: true })
    writeFileSync(join(d, 'lib', 'zelda', 'x.js'), '')
    mkdirSync(join(d, 'node_modules', 'minecraft'), { recursive: true })
    writeFileSync(join(d, 'node_modules', 'minecraft', 'index.js'), '')
    const hits = await findFamousNames(d, NAMES)
    expect(hits).toEqual([
      { where: 'title', text: 'Tetris Deluxe', name: 'Tetris' },
      { where: 'readme', text: 'Tetris Deluxe', name: 'Tetris' },
      { where: 'file', text: 'src/game/pacman-ghosts.js', name: 'Pac-Man' },
    ])
    const check = namesCheck(hits)
    expect(check).toMatchObject({ id: 'names', status: 'fail' })
    expect(check.title).toBe("The game uses a famous game's name (Tetris, Pac-Man): give it an original name")
    expect(check.detail).toContain('the page title "Tetris Deluxe"')
    expect(gameFindings({ checks: [check], failedLoads: [], blocked: [] })).toHaveLength(1)
  })

  it('passes an original game, and a missing folder is never a throw', async () => {
    const d = temp()
    writeFileSync(join(d, 'index.html'), '<title>Garden Snake</title>')
    writeFileSync(join(d, 'README.md'), '# Garden Snake\n')
    expect(await checkGameNames(d, NAMES)).toMatchObject({ id: 'names', status: 'pass' })
    expect((await checkGameNames(join(d, 'nope'), NAMES)).status).toBe('pass')
    expect(namesCheck([]).status).toBe('pass')
  })

  it("is the Games pack's data: well-known names, wording only, and the schema caps it", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(20)
    expect(NAMES).toContain('Tetris')
    expect(NAMES.every((n) => n.length <= 40 && !/https?:|\.(?:png|svg|jpg)/.test(n))).toBe(true)
    expect(PackZ.safeParse({ ...games, namesToAvoid: Array(101).fill('Xy') }).success).toBe(false)
  })
})

describe('the server focus lines', () => {
  const view = views.find((v) => v.pack.id === GAMES_CATEGORY)
  if (view === undefined) throw new Error('no games pack')

  it('render for a game server deliverable, and only then', () => {
    const plain = briefRecord(view, { category: 'games', fields: {} }, [])
    const server = briefRecord(
      view,
      { category: 'games', fields: { deliverable: { choices: ['game-server'] } } },
      [],
    )
    expect(plain.focus).not.toMatch(/binds 127\.0\.0\.1/)
    expect(server.focus).toMatch(/- The game server binds 127\.0\.0\.1 while you develop/)
    expect(server.focus).toMatch(/Origin of every WebSocket connection/)
    expect(server.focus).toMatch(/capped in size \(2 KB\) and rate/)
    expect(server.focus).toMatch(/room codes/)
    // The pack's own lines come first, each once.
    expect(server.focus?.startsWith(renderSecurityFocus(games))).toBe(true)
    expect(renderSecurityFocus(games, { fields: { deliverable: { choices: ['single-page'] } } })).toBe(
      renderSecurityFocus(games),
    )
  })

  it("a when set must name the pack's own group and option", () => {
    const bad = {
      ...games,
      security: { ...games.security, when: [{ group: 'deliverable', option: 'nope', focus: ['x'] }] },
    }
    expect(PackZ.safeParse(bad).success).toBe(false)
  })
})

describe('the online multiplayer template', () => {
  const t = template('game-online')

  it('is a Full-mode-only game template labelled "needs a server you host", within its pack and task cap', () => {
    expect(TemplateZ.safeParse(t).success).toBe(true)
    expect(t.fullOnly).toBe(true)
    expect(t.label).toBe('Online multiplayer game (needs a server you host)')
    expect(templatePackProblem(t, packs)).toBeNull()
    expect(t.task.length).toBeLessThanOrEqual(TEMPLATE_TASK_MAX)
    expect(t.brief.fields['deliverable']?.choices).toEqual(['game-server'])
    expect(t.brief.fields['players']?.choices).toEqual(['online'])
    for (const want of [/binds 127\.0\.0\.1/, /Origin/, /2 KB/, /never copy a famous game/, /playtest\.json/])
      expect(t.task).toMatch(want)
    expect(`${t.label} ${t.description} ${t.task}`).not.toMatch(/[–—]/)
  })

  it('copies its server to the root (the one root file a template may write) with the starter engine', async () => {
    expect(templateTargetProblem('server.js')).toBeNull()
    expect(templateTargetProblem('index.html')).not.toBeNull()
    expect(templateTargetProblem('package.json')).not.toBeNull()
    const project = temp()
    const written = await copyTemplateFiles({ template: t, layer: 'builtin' }, project)
    expect(written).toContain('server.js')
    expect(written).toContain('src/server/rooms.js')
    expect(written).toContain('docs/game-server.md')
    expect(written).toContain('src/engine/test-hook.js')
    expect(readFileSync(join(project, 'server.js'), 'utf8')).toContain("'127.0.0.1'")
    const m = await readVendorManifest()
    for (const id of ['game-server', 'game-rooms', 'game-server-doc'])
      expect(m.entries.find((e) => e.id === id)?.license).toBe('MIT')
  })

  it('is offered as `node server.js` (untrusted until the user trusts it) for a game with a server', async () => {
    const d = temp()
    writeFileSync(join(d, 'server.js'), '')
    writeFileSync(join(d, 'playtest.json'), '{}')
    writeFileSync(join(d, 'index.html'), '<title>x</title>')
    const cmds = await detectPreviewCommands({ folder: d, packs, platform: 'linux' })
    const server = cmds.find((c) => c.id === 'pack:games:game-server')
    expect(server).toMatchObject({
      argv: ['node', 'server.js'],
      kind: 'server',
      trust: 'untrusted',
      urlHint: 'http://127.0.0.1:8787/',
    })
    expect(server?.note).toMatch(/server you host/)
    // A Node project with a server.js but no game is not offered the game server.
    const plain = temp()
    writeFileSync(join(plain, 'server.js'), '')
    const none = await detectPreviewCommands({ folder: plain, packs, platform: 'linux' })
    expect(none.some((c) => c.id === 'pack:games:game-server')).toBe(false)
  })
})

describe('Easy and online play', () => {
  it.each([
    'An online multiplayer chess game',
    'A tic tac toe game I can play online with my friends',
    'A card game with real-time multiplayer and matchmaking',
    'A quiz my friends can play together over the internet',
  ])('%j asks for online play', (idea) => {
    expect(asksOnlinePlay(idea)).toBe(true)
  })

  it.each([
    'A snake game I can play on my phone',
    'A two player pong on one keyboard',
    'A chess game I can play by sending a link to my friend',
  ])('%j does not', (idea) => {
    expect(asksOnlinePlay(idea)).toBe(false)
  })

  it('never chooses the online template, and turns the Brief to pass and play or play by link', () => {
    const idea = 'An online multiplayer tic tac toe game'
    const choice = chooseTemplate('game', idea, { node: true, python: true })
    expect(choice.templateId).not.toBe('game-online')
    const t = template(choice.templateId)
    const b = ideaBrief('game', t, idea, packs)
    expect(b.fields['players']?.choices).toEqual(['pass-and-play'])
    expect(ideaBrief('game', t, idea, packs, [], 'play-by-link').fields['players']?.choices).toEqual([
      'play-by-link',
    ])
    expect(onlineInstead('An online chess game I send as a link')).toBe('play-by-link')
    const server = ideaBrief('game', t, 'A board game with a game server', packs)
    expect(server.fields['deliverable']?.choices ?? []).not.toContain('game-server')
    expect(easyTask(t, idea)).toMatch(
      /Online multiplayer is not part of this project: it needs a server you host/,
    )
    expect(easyTask(t, idea)).toMatch(/pass and play/)
    expect(easyTask(t, 'A snake game')).not.toMatch(/Online multiplayer/)
  })

  it('resolve offers the other ways, create makes the chosen one, and a Full-only template never starts', async () => {
    const home = temp()
    const projects = temp()
    const starts: RunStartRequest[] = []
    const deps: EasyDeps = {
      home,
      documentsDir: join(temp(), 'Documents'),
      newHome: false,
      log: silentLogger,
      now: () => 1000,
      readUser: () => Promise.resolve({ easy: { projectsDir: projects } }),
      patchUser: () => Promise.resolve(),
      packs: () => Promise.resolve(packs),
      templates: () => loadTemplates({ home }),
      readiness: () => ({ claude: true, codex: false, profile: 'claude-only', runnable: true }),
      toolchain: () => Promise.resolve({ node: true, python: true }),
      estimate: () => Promise.resolve(null),
      prepareFolder: (folder) => Promise.resolve(folder),
      saveBrief: () => Promise.resolve(),
      copyTemplateFiles: (view, folder) => copyTemplateFiles(view, folder),
      startRun: (req) => {
        starts.push(req)
        return Promise.resolve({ runId: 'r1', displayNo: 1 })
      },
      summaries: () => [],
      runTask: () => Promise.resolve(null),
      exists: () => false,
    }
    const svc = new EasyService(deps)
    const idea = 'An online multiplayer checkers game for me and my friends'
    const resolved = await svc.resolve({ idea })
    expect(resolved.kind).toBe('game')
    expect(resolved.template.id).not.toBe('game-online')
    expect(resolved.online).toEqual({ instead: 'pass-and-play' })
    expect((await svc.resolve({ idea: 'A snake game' })).online).toBeUndefined()
    await svc.create({
      idea,
      kind: 'game',
      folder: join(projects, 'checkers'),
      limits: { maxCostUsd: null, maxMinutes: null },
      consent: false,
      multiplayer: 'play-by-link',
    })
    expect(starts[0]?.brief?.fields['players']?.choices).toEqual(['play-by-link'])
    expect(starts[0]?.task).toMatch(/Make it play by link/)
    // A user template that turns a game Easy picks into the Full-only online one is refused.
    mkdirSync(join(home, 'templates'))
    const online = template('game-online')
    const { files: _files, ...rest } = template('game-board')
    writeFileSync(
      join(home, 'templates', 'game-board.json'),
      JSON.stringify({ ...rest, label: online.label, fullOnly: true }),
    )
    await expect(svc.resolve({ idea: 'A memory card game' })).rejects.toThrow(/Full mode only/)
  })
})
