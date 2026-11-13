// playtest.json: data only. The format's caps (12 scenarios, 200 steps and 60 seconds of waits and holds in all), the
// step shapes, dotted state paths read by own keys only (no prototype, no expressions), the expect operators, and the
// first format's shorthands. Nothing in the file is ever evaluated: a path or a value that looks like code is refused
// or stays a plain string.
import { describe, expect, it } from 'vitest'
import {
  PLAYTEST_ARGV,
  PLAYTEST_MAX_PLAY_MS,
  PLAYTEST_MAX_SCENARIOS,
  PLAYTEST_MAX_STEPS,
  PlaytestSpecZ,
  checkExpect,
  describeStep,
  failedMustScenarios,
  isMustScenario,
  isPlaytestArgv,
  parsePlaytestText,
  readStatePath,
  statePathProblem,
} from '@shared/playtest.ts'
import type { PlaytestStep } from '@shared/playtest.ts'

const spec = (scenarios: unknown[], extra: Record<string, unknown> = {}): unknown => ({
  version: 1,
  ...extra,
  scenarios,
})
const ok = (v: unknown): boolean => PlaytestSpecZ.safeParse(v).success

describe('playtest.json format', () => {
  it('takes every step kind', () => {
    const steps: PlaytestStep[] = [
      { key: 'Space' },
      { key: 'ArrowLeft' },
      { key: 'KeyP' },
      { key: 'Digit1' },
      { hold: 'ArrowRight', ms: 500 },
      { hold: 'KeyD', ticks: 30 },
      { click: [0.5, 0.5] },
      { tap: [0, 1] },
      { hook: 'press', action: 'left' },
      { hook: 'release', action: 'left' },
      { hook: 'seed', seed: 7 },
      { hook: 'step', ticks: 60 },
      { hook: 'pause' },
      { hook: 'resume' },
      { wait: { ms: 200 } },
      { wait: { ticks: 10 } },
      { expect: 'scene', eq: 'playing' },
      { expect: 'score', gt: 0 },
      { expect: 'player.x', lte: 100 },
      { expect: 'snake.0.y', changed: true },
      { screenshot: 'title' },
    ]
    const r = PlaytestSpecZ.safeParse(spec([{ name: 'All', steps }]))
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true)
  })

  it('keeps the first format: press, release, tap and step shorthands and an expect object', () => {
    const first = {
      version: 1,
      scenarios: [
        {
          name: 'Start the game',
          must: true,
          steps: [{ press: 'action' }, { step: 5 }, { release: 'action' }, { tap: 'action' }],
          expect: { scene: 'playing' },
        },
      ],
    }
    expect(ok(first)).toBe(true)
  })

  it('caps scenarios, steps and play time', () => {
    const one = { name: 'x', steps: [{ key: 'Space' }] }
    const many = Array.from({ length: PLAYTEST_MAX_SCENARIOS }, (_, i) => ({ ...one, name: `s${i}` }))
    expect(ok(spec(many))).toBe(true)
    expect(ok(spec([...many, { ...one, name: 'one more' }]))).toBe(false)
    // 200 steps in all, across scenarios.
    const steps = (n: number): unknown[] => Array.from({ length: n }, () => ({ key: 'Space' }))
    expect(
      ok(
        spec([
          { name: 'a', steps: steps(100) },
          { name: 'b', steps: steps(100) },
        ]),
      ),
    ).toBe(true)
    const over = parsePlaytestText(
      JSON.stringify(
        spec([
          { name: 'a', steps: steps(100) },
          { name: 'b', steps: steps(PLAYTEST_MAX_STEPS - 99) },
        ]),
      ),
    )
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toContain('At most 200 steps')
    // 60 seconds of waits and holds in all.
    expect(ok(spec([{ name: 'a', steps: [{ wait: { ms: PLAYTEST_MAX_PLAY_MS } }] }]))).toBe(true)
    const long = parsePlaytestText(
      JSON.stringify(
        spec([
          { name: 'a', steps: [{ wait: { ms: 40_000 } }] },
          { name: 'b', steps: [{ hold: 'Space', ms: 20_001 }] },
        ]),
      ),
    )
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.error).toContain('60 seconds')
    expect(ok(spec([{ name: 'a', steps: [{ wait: { ticks: 3601 } }] }]))).toBe(false)
  })

  it('refuses what is not data it knows: unknown keys, code in a key name, two operators, duplicate names', () => {
    expect(ok(spec([{ name: 'a', steps: [{ key: 'Space', run: 'alert(1)' }] }]))).toBe(false)
    expect(ok(spec([{ name: 'a', steps: [{ eval: 'window.close()' }] }]))).toBe(false)
    expect(ok(spec([{ name: 'a', steps: [{ key: 'alert(1)' }] }]))).toBe(false)
    expect(ok(spec([{ name: 'a', steps: [{ hook: 'press', action: 'a"); alert(1); ("' }] }]))).toBe(false)
    expect(ok(spec([{ name: 'a', steps: [{ hook: 'eval', action: 'x' }] }]))).toBe(false)
    expect(ok(spec([{ name: 'a', steps: [{ expect: 'score', gt: 1, lt: 5 }] }]))).toBe(false)
    expect(ok(spec([{ name: 'a', steps: [{ expect: 'score' }] }]))).toBe(false)
    expect(ok(spec([{ name: 'a', steps: [{ click: [1.5, 0] }] }]))).toBe(false)
    expect(
      ok(
        spec([
          { name: 'A', steps: [] },
          { name: 'a', steps: [] },
        ]),
      ),
    ).toBe(false)
    expect(ok(spec([]))).toBe(false)
    expect(ok({ version: 2, scenarios: [{ name: 'a', steps: [] }] })).toBe(false)
    expect(ok(spec([{ name: 'a', steps: [] }], { script: 'x' }))).toBe(false)
  })

  it('says why a file is refused, and refuses one that is too large or not JSON', () => {
    const bad = parsePlaytestText('{ not json')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/not valid JSON/)
    const big = parsePlaytestText(`{"version":1,"scenarios":[],"pad":"${'x'.repeat(70 * 1024)}"}`)
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.error).toMatch(/larger than 64 KB/)
    const good = parsePlaytestText(
      `${String.fromCharCode(0xfeff)}${JSON.stringify(spec([{ name: 'a', steps: [] }]))}`,
    )
    expect(good.ok).toBe(true)
  })

  it('must is the default; failed must scenarios are the ones that decide', () => {
    expect(isMustScenario({})).toBe(true)
    expect(isMustScenario({ must: false })).toBe(false)
    const failed = failedMustScenarios({
      scenarios: [
        { name: 'a', must: true, status: 'pass', durationMs: 1, screenshots: [] },
        { name: 'b', must: true, status: 'fail', durationMs: 1, screenshots: [] },
        { name: 'c', must: false, status: 'fail', durationMs: 1, screenshots: [] },
        { name: 'd', must: true, status: 'error', durationMs: 1, screenshots: [] },
      ],
    })
    expect(failed.map((s) => s.name)).toEqual(['b', 'd'])
  })

  it('the built-in command is recognised by its first word only', () => {
    expect(isPlaytestArgv(PLAYTEST_ARGV)).toBe(true)
    expect(isPlaytestArgv(['dimf:playtest'])).toBe(true)
    expect(isPlaytestArgv(['node', 'dimf:playtest'])).toBe(false)
    expect(isPlaytestArgv(['dimf'])).toBe(false)
  })

  it('describes steps in plain words', () => {
    expect(describeStep({ key: 'Space' })).toBe('press Space')
    expect(describeStep({ hold: 'ArrowRight', ms: 300 })).toBe('hold ArrowRight for 300 ms')
    expect(describeStep({ expect: 'scene', eq: 'playing' })).toBe('scene eq "playing"')
    expect(describeStep({ expect: 'score', changed: true })).toBe('score changed')
    expect(describeStep({ hook: 'seed', seed: 3 })).toBe('restart with seed 3')
    expect(describeStep({ tap: 'action' })).toBe('tap action')
    expect(describeStep({ tap: [0.5, 0.25] })).toBe('tap at 0.5, 0.25')
  })
})

describe('dotted state paths (no eval)', () => {
  const state = {
    scene: 'playing',
    score: 30,
    player: { x: 12, alive: true },
    snake: [
      { x: 6, y: 8 },
      { x: 5, y: 8 },
    ],
    nothing: null,
  }

  it('reads own keys and array indexes', () => {
    expect(readStatePath(state, 'scene')).toEqual({ found: true, value: 'playing' })
    expect(readStatePath(state, 'player.x')).toEqual({ found: true, value: 12 })
    expect(readStatePath(state, 'snake.1.x')).toEqual({ found: true, value: 5 })
    expect(readStatePath(state, 'nothing')).toEqual({ found: true, value: null })
    expect(readStatePath(state, 'snake.2.x')).toEqual({ found: false })
    expect(readStatePath(state, 'snake.x')).toEqual({ found: false })
    expect(readStatePath(state, 'player.y')).toEqual({ found: false })
    expect(readStatePath(state, 'score.toFixed')).toEqual({ found: false })
    // Inherited members are never read.
    expect(readStatePath(state, 'toString')).toEqual({ found: false })
    expect(readStatePath(state, 'snake.length')).toEqual({ found: false })
  })

  it('refuses paths that are not plain names (no prototype, no calls, no brackets)', () => {
    for (const p of [
      '__proto__',
      'player.constructor',
      'prototype.x',
      'a()',
      'a[0]',
      'a..b',
      '',
      'a.b.c.d.e.f.g.h.i',
    ])
      expect(statePathProblem(p), p).not.toBeNull()
    expect(readStatePath(state, '__proto__')).toEqual({ found: false })
    expect(statePathProblem('a.b.c.d.e.f.g.h')).toBeNull()
    expect(ok(spec([{ name: 'a', steps: [{ expect: 'constructor.name', eq: 'Object' }] }]))).toBe(false)
    expect(ok(spec([{ name: 'a', steps: [{ expect: 'score + 1', eq: 2 }] }]))).toBe(false)
  })

  it('checks each operator', () => {
    const none = { found: false } as const
    const e = (
      step: Extract<PlaytestStep, { expect: string }>,
      initial: Parameters<typeof checkExpect>[2] = none,
    ) => checkExpect(step, state, initial)
    expect(e({ expect: 'scene', eq: 'playing' })).toBeNull()
    expect(e({ expect: 'scene', eq: 'over' })).toBe('expected scene to be "over", got "playing"')
    expect(e({ expect: 'scene', ne: 'over' })).toBeNull()
    expect(e({ expect: 'scene', ne: 'playing' })).toMatch(/not to be "playing"/)
    expect(e({ expect: 'score', gt: 0 })).toBeNull()
    expect(e({ expect: 'score', gt: 30 })).toBe('expected score to be above 30, got 30')
    expect(e({ expect: 'score', gte: 30 })).toBeNull()
    expect(e({ expect: 'score', lt: 30 })).toMatch(/below 30/)
    expect(e({ expect: 'score', lte: 30 })).toBeNull()
    expect(e({ expect: 'player.alive', eq: true })).toBeNull()
    expect(e({ expect: 'nothing', eq: null })).toBeNull()
    expect(e({ expect: 'scene', gt: 1 })).toMatch(/to be a number/)
    expect(e({ expect: 'missing', eq: 1 })).toBe('the state has no missing')
    expect(e({ expect: 'snake.0.x', changed: true }, { found: true, value: 6 })).toMatch(
      /to change, it is still 6/,
    )
    expect(e({ expect: 'snake.0.x', changed: true }, { found: true, value: 5 })).toBeNull()
    // A value that looks like code is compared as text, never run.
    expect(e({ expect: 'scene', eq: 'playing" || true || "' })).not.toBeNull()
  })
})
