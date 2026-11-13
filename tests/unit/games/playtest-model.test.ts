// The play-test's rules in main (main/playtest-model.ts, Electron-free): keys as Electron key codes, the test page's
// address, a scenario as actions, the fixed scripts run in the page (the scenario's values only ever go through
// JSON.stringify after the format checked them), the page's answers read as untrusted text, and the built-in checks'
// verdicts. Also the loopback-only network rule a game's preview gets (preview-model.ts).
import { describe, expect, it } from 'vitest'
import {
  ANSWER_MAX_CHARS,
  BLANK_VARIANCE,
  CANVAS_RECT_JS,
  FRAME_PROBE_JS,
  HOOK_PROBE_JS,
  RectZ,
  STATE_JS,
  bitmapsDiffer,
  electronKeyCode,
  frameCheck,
  frameStats,
  hookCallJs,
  hookProblems,
  parseAnswer,
  parseState,
  pixelVariance,
  pointIn,
  sameState,
  scenarioActions,
  seedOf,
  stepWords,
  testUrl,
  ticksOf,
} from '../../../src/main/playtest-model.ts'
import { isLoopbackHost, requestAllowed, requestDecision } from '../../../src/main/preview-model.ts'

describe('keys', () => {
  it('maps KeyboardEvent.code to Electron key codes', () => {
    expect(electronKeyCode('ArrowLeft')).toBe('Left')
    expect(electronKeyCode('ArrowUp')).toBe('Up')
    expect(electronKeyCode('Space')).toBe('Space')
    expect(electronKeyCode('Enter')).toBe('Enter')
    expect(electronKeyCode('Escape')).toBe('Escape')
    expect(electronKeyCode('KeyP')).toBe('P')
    expect(electronKeyCode('Digit7')).toBe('7')
    expect(electronKeyCode('F11')).toBe('F11')
    expect(electronKeyCode('ShiftLeft')).toBe('Shift')
  })
  it('refuses anything else', () => {
    for (const k of ['alert(1)', 'Meta', 'KeyAA', 'F13', '', 'space'])
      expect(electronKeyCode(k), k).toBeNull()
  })
})

describe('the test page', () => {
  it('adds test=1 and the seed, keeps the rest, drops a fragment', () => {
    expect(testUrl('http://127.0.0.1:5000/', 7)).toBe('http://127.0.0.1:5000/?test=1&seed=7')
    expect(testUrl('http://127.0.0.1:5000/game/?lang=en#top', 1)).toBe(
      'http://127.0.0.1:5000/game/?lang=en&test=1&seed=1',
    )
    expect(testUrl('http://127.0.0.1:5000/?test=0&seed=9', 2)).toBe('http://127.0.0.1:5000/?test=1&seed=2')
  })
  it('takes the scenario seed, else the file seed, else 1', () => {
    expect(seedOf({}, {})).toBe(1)
    expect(seedOf({ seed: 4 }, {})).toBe(4)
    expect(seedOf({ seed: 4 }, { seed: 9 })).toBe(9)
  })
})

describe('a scenario as actions', () => {
  it('turns each step into actions, the hold as down, wait, up, and the first format into hook calls', () => {
    const actions = scenarioActions({
      name: 'x',
      steps: [
        { key: 'Space' },
        { hold: 'ArrowRight', ms: 300 },
        { hold: 'KeyD', ticks: 10 },
        { click: [0.25, 0.75] },
        { tap: [0.5, 0.5] },
        { tap: 'action' },
        { hook: 'press', action: 'left' },
        { hook: 'seed', seed: 3 },
        { hook: 'step', ticks: 20 },
        { hook: 'pause' },
        { wait: { ms: 100 } },
        { wait: { ticks: 5 } },
        { expect: 'scene', eq: 'playing' },
        { screenshot: 'mid' },
        { press: 'action' },
        { release: 'action' },
        { step: 2 },
      ],
      expect: { score: 0 },
    })
    expect(actions.map((a) => a.t)).toEqual([
      'key',
      'down',
      'sleep',
      'up',
      'down',
      'ticks',
      'up',
      'pointer',
      'pointer',
      'hook',
      'hook',
      'hook',
      'hook',
      'hook',
      'sleep',
      'ticks',
      'expect',
      'shot',
      'hook',
      'hook',
      'hook',
      'expect',
    ])
    expect(actions[1]).toEqual({ t: 'down', keyCode: 'Right', step: 2 })
    expect(actions[7]).toEqual({ t: 'pointer', kind: 'click', fx: 0.25, fy: 0.75, step: 4 })
    expect(actions[9]).toEqual({ t: 'hook', op: 'tap', arg: 'action', step: 6 })
    // The first format's end checks come last, at "the end of the scenario".
    expect(actions.at(-1)).toEqual({ t: 'expect', check: { expect: 'score', eq: 0 }, step: 18 })
    expect(stepWords({ name: 'x', steps: [{ key: 'Space' }] }, 1)).toBe('press Space')
    expect(stepWords({ name: 'x', steps: [] }, 1)).toBe('the end of the scenario')
  })
})

describe('the scripts run in the page', () => {
  it('are fixed strings; a hook call passes its checked value through JSON.stringify', () => {
    expect(hookCallJs('press', 'left')).toContain('g.press("left")')
    expect(hookCallJs('seed', 7)).toContain('g.seed(7)')
    expect(hookCallJs('step', 30)).toContain('g.step(30)')
    expect(hookCallJs('pause')).toContain('g.pause()')
    // A value the format would refuse never reaches the page as code: it falls back to a safe value.
    const hostile = hookCallJs('press', '"); fetch("http://x.example/"); ("')
    expect(hostile).not.toContain('fetch')
    expect(hostile).toContain('g.press("action")')
    expect(hookCallJs('step', 1.5)).toContain('g.step(1)')
    expect(hookCallJs('seed', -1)).toContain('g.seed(1)')
    // None of the fixed scripts reads anything but the hook, the canvas box and frame times.
    for (const js of [HOOK_PROBE_JS, STATE_JS, CANVAS_RECT_JS, FRAME_PROBE_JS]) {
      expect(js).not.toMatch(/\beval\b|new Function|fetch\(|XMLHttpRequest|localStorage|document\.cookie/)
    }
    expect(STATE_JS).toContain('8192')
  })
})

describe("the page's answers are untrusted", () => {
  it('parses a state, refuses markers, non-objects and oversized text', () => {
    expect(parseState('{"scene":"title","ticks":4}')).toEqual({
      ok: true,
      state: { scene: 'title', ticks: 4 },
    })
    expect(parseState('{"__dimf":"no-hook"}')).toEqual({ ok: false, why: 'window.__game is not there' })
    expect(parseState('{"__dimf":"too-big"}')).toMatchObject({ ok: false })
    expect(parseState('[1,2]')).toMatchObject({ ok: false, why: 'the state is not an object' })
    expect(parseState('nope')).toMatchObject({ ok: false, why: 'the state is not JSON' })
    expect(parseState(42)).toMatchObject({ ok: false })
    expect(parseState(`{"a":"${'x'.repeat(9000)}"}`)).toMatchObject({
      ok: false,
      why: 'the state is larger than 8 KB',
    })
    expect(ticksOf({ ticks: 12 })).toBe(12)
    expect(ticksOf({ ticks: 'x' })).toBeNull()
  })
  it('parses other answers with a schema and a size cap', () => {
    expect(parseAnswer('{"x":1,"y":2,"width":3,"height":4}', RectZ)).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    })
    expect(parseAnswer('{"x":1}', RectZ)).toBeUndefined()
    expect(parseAnswer({ x: 1 }, RectZ)).toBeUndefined()
    expect(parseAnswer(`"${'x'.repeat(ANSWER_MAX_CHARS)}"`, RectZ)).toBeUndefined()
  })
  it('names what is missing from the hook contract', () => {
    expect(hookProblems(undefined)).toEqual(['window.__game is not there with ?test=1'])
    expect(
      hookProblems({
        present: true,
        version: 1,
        ready: true,
        fns: ['actions', 'pause', 'resume', 'step', 'press', 'release', 'seed', 'state'],
      }),
    ).toEqual([])
    const p = hookProblems({ present: true, version: 2, ready: false, fns: ['state'] })
    expect(p.join('; ')).toMatch(/version is 2/)
    expect(p.join('; ')).toMatch(/ready is not true/)
    expect(p.join('; ')).toMatch(/no pause, resume, step, press, release, seed/)
  })
})

describe('the built-in checks', () => {
  const flat = (n: number, v: number): Uint8Array => new Uint8Array(n * 4).fill(v)
  it('a flat canvas is blank; a drawn one is not', () => {
    expect(pixelVariance(flat(100, 255))).toBe(0)
    const drawn = flat(100, 255)
    for (let i = 0; i < 50 * 4; i++) drawn[i] = 0
    expect(pixelVariance(drawn)).toBeGreaterThan(BLANK_VARIANCE)
    expect(pixelVariance(new Uint8Array())).toBe(0)
  })
  it('two pictures differ or not', () => {
    const a = flat(10, 1)
    const b = flat(10, 1)
    expect(bitmapsDiffer(a, b)).toBe(false)
    b[8] = 2
    expect(bitmapsDiffer(a, b)).toBe(true)
    expect(bitmapsDiffer(a, flat(11, 1))).toBe(true)
  })
  it('the frame budget: median at most 20 ms, the slowest 5% at most 33 ms', () => {
    const steady = [500, ...Array.from({ length: 60 }, () => 16.7)]
    expect(frameCheck(frameStats(steady), 0).status).toBe('pass')
    const stutter = [500, ...Array.from({ length: 50 }, () => 16.7), ...Array.from({ length: 10 }, () => 50)]
    const c = frameCheck(frameStats(stutter), 2)
    expect(c.status).toBe('warn')
    expect(c.detail).toMatch(/2 long tasks/)
    expect(frameCheck(frameStats([16, 16]), 0).status).toBe('skipped')
  })
  it('the same seed: states compared without the tick count', () => {
    expect(sameState({ scene: 'title', ticks: 3, score: 0 }, { scene: 'title', ticks: 9, score: 0 })).toBe(
      true,
    )
    expect(sameState({ scene: 'title', score: 1 }, { scene: 'title', score: 0 })).toBe(false)
  })
  it('a point of a box from fractions stays inside it', () => {
    const r = { x: 10, y: 20, width: 100, height: 50 }
    expect(pointIn(r, 0.5, 0.5)).toEqual({ x: 60, y: 45 })
    expect(pointIn(r, 1, 1)).toEqual({ x: 109, y: 69 })
    expect(pointIn(r, 0, 0)).toEqual({ x: 10, y: 20 })
  })
})

describe("a game preview's network (loopback only)", () => {
  it('blocks other computers, keeps this one, and never allows file: or custom schemes', () => {
    expect(requestDecision('http://127.0.0.1:5173/src/main.js', 'loopback')).toBe('allow')
    expect(requestDecision('http://localhost:8080/', 'loopback')).toBe('allow')
    expect(requestDecision('ws://[::1]:9000/', 'loopback')).toBe('allow')
    expect(requestDecision('http://127.1.2.3/', 'loopback')).toBe('allow')
    expect(requestDecision('https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.min.js', 'loopback')).toBe(
      'blocked',
    )
    expect(requestDecision('wss://game.example.com/socket', 'loopback')).toBe('blocked')
    expect(requestDecision('http://127.0.0.1.example.com/', 'loopback')).toBe('blocked')
    expect(requestDecision('data:image/png;base64,AAAA', 'loopback')).toBe('allow')
    expect(requestDecision('blob:http://127.0.0.1:5000/x', 'loopback')).toBe('allow')
    expect(requestDecision('file:///C:/secret.txt', 'loopback')).toBe('deny')
    expect(requestDecision('file:///C:/secret.txt', 'internet')).toBe('deny')
    expect(requestDecision('https://cdn.jsdelivr.net/x.js', 'internet')).toBe('allow')
    expect(requestDecision('not a url', 'internet')).toBe('deny')
    expect(requestAllowed('https://cdn.example/x.js')).toBe(true)
    expect(requestAllowed('https://cdn.example/x.js', 'loopback')).toBe(false)
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('example.com')).toBe(false)
  })
})
