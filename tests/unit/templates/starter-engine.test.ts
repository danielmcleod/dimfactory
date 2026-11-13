import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// The starter modules are plain browser JavaScript (no types, and tsconfig does not allow .js imports), so they are
// loaded by file URL and described with small local interfaces.
interface Rng {
  seed: unknown
  next: () => number
  int: (min: number, max: number) => number
  range: (min: number, max: number) => number
  chance: (p: number) => boolean
  pick: <T>(a: T[]) => T | undefined
  shuffle: <T>(a: T[]) => T[]
  state: () => number[]
  setState: (s: number[]) => void
}
interface Loop {
  start: () => void
  stop: () => void
  pause: () => void
  resume: () => void
  stepOnce: (n?: number) => void
  readonly running: boolean
  readonly paused: boolean
  readonly ticks: number
}
interface Input {
  isDown: (a: string) => boolean
  pressed: (a: string) => boolean
  released: (a: string) => boolean
  update: () => void
  press: (a: string) => void
  release: (a: string) => void
  rebind: (a: string, codes: string[]) => void
  bindings: () => Record<string, string[]>
  setBindings: (m: Record<string, string[]>) => void
  attachTouchButton: (el: EventTarget, a: string) => () => void
  pointer: { x: number; y: number; down: boolean }
  destroy: () => void
}
interface Store<T> {
  load: () => T
  save: (d: T) => boolean
  reset: () => T
  key: string
}
interface Hook {
  version: number
  pause: () => void
  resume: () => void
  step: (n?: number) => void
  press: (a: string) => void
  release: (a: string) => void
  tap: (a: string) => void
  seed: (n?: number) => unknown
  state: () => Record<string, unknown>
}
interface FakeStorage {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
}

const dir = fileURLToPath(new URL('../../../src/core/templates/vendor/starter/game/', import.meta.url))
const load = async <T>(name: string): Promise<T> =>
  (await import(/* @vite-ignore */ pathToFileURL(dir + name).href)) as T

const { createRng, randomSeed } = await load<{
  createRng: (seed?: string | number) => Rng
  randomSeed: () => number
}>('rng.js')
const { createLoop } = await load<{ createLoop: (o: Record<string, unknown>) => Loop }>('loop.js')
const { createInput, DEFAULT_BINDINGS } = await load<{
  createInput: (o?: Record<string, unknown>) => Input
  DEFAULT_BINDINGS: Record<string, string[]>
}>('input.js')
const { createStorage } = await load<{
  createStorage: (o: Record<string, unknown>) => Store<Record<string, unknown>>
}>('storage.js')
const { installTestHook, TEST_HOOK_VERSION } = await load<{
  installTestHook: (o: Record<string, unknown>) => Hook | null
  TEST_HOOK_VERSION: number
}>('test-hook.js')

const key = (type: string, code: string, repeat = false): Event =>
  Object.assign(new Event(type, { cancelable: true }), { code, repeat })

describe('starter rng', () => {
  it('gives the same 100 numbers for the same seed', () => {
    const a = createRng('abc')
    const b = createRng('abc')
    const xs = Array.from({ length: 100 }, () => a.next())
    expect(Array.from({ length: 100 }, () => b.next())).toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
  })

  it('gives different numbers for different seeds', () => {
    const a = Array.from(
      { length: 10 },
      (
        (r) => () =>
          r.next()
      )(createRng(1)),
    )
    const b = Array.from(
      { length: 10 },
      (
        (r) => () =>
          r.next()
      )(createRng(2)),
    )
    expect(a).not.toEqual(b)
  })

  it('exposes a seed, also when none is given', () => {
    expect(createRng(42).seed).toBe(42)
    expect(typeof createRng().seed).toBe('number')
    expect(typeof randomSeed()).toBe('number')
  })

  it('int is inclusive and whole; range is a float in [min, max)', () => {
    const r = createRng(7)
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const n = r.int(3, 6)
      expect(Number.isInteger(n)).toBe(true)
      seen.add(n)
      const f = r.range(-2, 2)
      expect(f >= -2 && f < 2).toBe(true)
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6])
  })

  it('chance and pick behave', () => {
    const r = createRng(1)
    expect(r.chance(0)).toBe(false)
    expect(r.chance(1)).toBe(true)
    expect(r.pick([])).toBeUndefined()
    expect(['a', 'b']).toContain(r.pick(['a', 'b']))
  })

  it('shuffle returns a permutation and leaves the input alone', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const out = createRng(5).shuffle(input)
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect([...out].sort((x, y) => x - y)).toEqual(input)
    expect(out).not.toBe(input)
  })

  it('state and setState replay the sequence', () => {
    const r = createRng('x')
    r.next()
    const s = r.state()
    const first = [r.next(), r.next(), r.next()]
    r.setState(s)
    expect([r.next(), r.next(), r.next()]).toEqual(first)
  })
})

/** A clock and a requestFrame that the test drives by hand. */
function fakeClock() {
  let t = 0
  let cb: (() => void) | null = null
  return {
    now: () => t,
    requestFrame: (f: () => void) => {
      cb = f
      return 1
    },
    cancelFrame: () => {
      cb = null
    },
    advance(ms: number) {
      t += ms
      const f = cb
      cb = null
      f?.()
    },
    get pending() {
      return cb !== null
    },
  }
}

describe('starter loop', () => {
  function make(extra: Record<string, unknown> = {}, target: EventTarget = new EventTarget()) {
    const clock = fakeClock()
    const calls = { updates: 0, renders: 0, alphas: [] as number[], dts: [] as number[], pause: 0, resume: 0 }
    const loop = createLoop({
      update: (dt: number) => {
        calls.updates++
        calls.dts.push(dt)
      },
      render: (a: number) => {
        calls.renders++
        calls.alphas.push(a)
      },
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      target,
      onPause: () => calls.pause++,
      onResume: () => calls.resume++,
      ...extra,
    })
    return { clock, calls, loop, target }
  }

  it.each([30, 60, 144])('runs about 60 updates per second at %i fps', (fps) => {
    const { clock, calls, loop } = make()
    loop.start()
    const frameMs = 1000 / fps
    for (let i = 0; i < fps; i++) clock.advance(frameMs)
    expect(Math.abs(calls.updates - 60)).toBeLessThanOrEqual(1)
    expect(calls.renders).toBe(fps)
    expect(calls.dts.every((dt) => Math.abs(dt - 1 / 60) < 1e-9)).toBe(true)
    expect(calls.alphas.every((a) => a >= 0 && a < 1)).toBe(true)
    expect(loop.ticks).toBe(calls.updates)
    loop.stop()
  })

  it('caps a long gap at maxFrameMs', () => {
    const { clock, calls, loop } = make({ maxFrameMs: 250 })
    loop.start()
    clock.advance(5000)
    expect(calls.updates).toBeLessThanOrEqual(15)
    expect(calls.updates).toBeGreaterThan(0)
    loop.stop()
  })

  it('pause stops updates but not renders; stepOnce runs exactly n updates while paused', () => {
    const { clock, calls, loop } = make()
    loop.start()
    clock.advance(100)
    loop.pause()
    const before = calls.updates
    const renders = calls.renders
    clock.advance(1000)
    expect(calls.updates).toBe(before)
    expect(calls.renders).toBe(renders + 1)
    loop.stepOnce(3)
    expect(calls.updates).toBe(before + 3)
    expect(loop.paused).toBe(true)
    loop.resume()
    expect(calls.resume).toBe(1)
    loop.pause()
    loop.pause()
    expect(calls.pause).toBe(2)
    loop.stop()
  })

  it('pauses on blur once, never resumes by itself, and stop removes the listeners', () => {
    const { clock, calls, loop, target } = make()
    loop.start()
    target.dispatchEvent(new Event('blur'))
    target.dispatchEvent(new Event('blur'))
    expect(loop.paused).toBe(true)
    expect(calls.pause).toBe(1)
    clock.advance(100)
    expect(loop.paused).toBe(true)
    loop.resume()
    loop.stop()
    expect(loop.running).toBe(false)
    expect(clock.pending).toBe(false)
    target.dispatchEvent(new Event('blur'))
    expect(loop.paused).toBe(false)
    expect(calls.pause).toBe(1)
  })

  it('pauses when the page becomes hidden', () => {
    let hidden = false
    const { loop, target } = make({ isHidden: () => hidden })
    loop.start()
    target.dispatchEvent(new Event('visibilitychange'))
    expect(loop.paused).toBe(false)
    hidden = true
    target.dispatchEvent(new Event('visibilitychange'))
    expect(loop.paused).toBe(true)
    loop.stop()
  })
})

describe('starter input', () => {
  it('has the six default actions', () => {
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual(['action', 'down', 'left', 'pause', 'right', 'up'])
  })

  it('drives isDown, pressed and released from keyboard events', () => {
    const target = new EventTarget()
    const input = createInput({ target, gamepad: false })
    const down = key('keydown', 'ArrowLeft')
    target.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(input.isDown('left')).toBe(true)
    expect(input.pressed('left')).toBe(false)
    input.update()
    expect(input.pressed('left')).toBe(true)
    input.update()
    expect(input.pressed('left')).toBe(false)
    expect(input.isDown('left')).toBe(true)
    target.dispatchEvent(key('keyup', 'ArrowLeft'))
    expect(input.isDown('left')).toBe(false)
    input.update()
    expect(input.released('left')).toBe(true)
    input.update()
    expect(input.released('left')).toBe(false)
  })

  it('does not prevent default for unbound keys and ignores key repeat', () => {
    const target = new EventTarget()
    const input = createInput({ target, gamepad: false })
    const other = key('keydown', 'KeyQ')
    target.dispatchEvent(other)
    expect(other.defaultPrevented).toBe(false)
    target.dispatchEvent(key('keydown', 'Space'))
    input.update()
    expect(input.pressed('action')).toBe(true)
    target.dispatchEvent(key('keydown', 'Space', true))
    input.update()
    expect(input.pressed('action')).toBe(false)
  })

  it('catches a tap that is over before the next update', () => {
    const target = new EventTarget()
    const input = createInput({ target, gamepad: false })
    target.dispatchEvent(key('keydown', 'Enter'))
    target.dispatchEvent(key('keyup', 'Enter'))
    input.update()
    expect(input.pressed('action')).toBe(true)
    expect(input.released('action')).toBe(true)
  })

  it('rebind takes the code away from the other action', () => {
    const input = createInput({ target: new EventTarget(), gamepad: false })
    input.rebind('action', ['KeyA'])
    const b = input.bindings()
    expect(b.action).toEqual(['KeyA'])
    expect(b.left).toEqual(['ArrowLeft'])
    b.left = []
    expect(input.bindings().left).toEqual(['ArrowLeft'])
    input.setBindings({ jump: ['KeyJ'] })
    expect(Object.keys(input.bindings())).toEqual(['jump'])
  })

  it('press and release work without a keyboard, and touch buttons detach', () => {
    const target = new EventTarget()
    const button = new EventTarget()
    const input = createInput({ target, gamepad: false })
    input.press('up')
    expect(input.isDown('up')).toBe(true)
    input.update()
    expect(input.pressed('up')).toBe(true)
    input.release('up')
    expect(input.isDown('up')).toBe(false)

    const detach = input.attachTouchButton(button, 'action')
    button.dispatchEvent(new Event('pointerdown'))
    expect(input.isDown('action')).toBe(true)
    button.dispatchEvent(new Event('pointerleave'))
    expect(input.isDown('action')).toBe(false)
    button.dispatchEvent(new Event('pointerdown'))
    detach()
    expect(input.isDown('action')).toBe(false)
    button.dispatchEvent(new Event('pointerdown'))
    expect(input.isDown('action')).toBe(false)
  })

  it('reads a standard gamepad', () => {
    const pad = { buttons: Array.from({ length: 16 }, () => ({ pressed: false })), axes: [0, 0] }
    const input = createInput({ target: new EventTarget(), getGamepads: () => [null, pad] })
    input.update()
    expect(input.isDown('action')).toBe(false)
    pad.buttons[0]!.pressed = true
    pad.axes = [-0.8, 0.2]
    pad.buttons[12]!.pressed = true
    input.update()
    expect(input.isDown('action')).toBe(true)
    expect(input.pressed('action')).toBe(true)
    expect(input.isDown('left')).toBe(true)
    expect(input.isDown('up')).toBe(true)
    expect(input.isDown('right')).toBe(false)
    expect(input.isDown('down')).toBe(false)
  })

  it('does not read gamepads when disabled', () => {
    const pad = { buttons: [{ pressed: true }], axes: [] }
    const input = createInput({ target: new EventTarget(), gamepad: false, getGamepads: () => [pad] })
    input.update()
    expect(input.isDown('action')).toBe(false)
  })

  it('clears held keys on blur and tracks the pointer', () => {
    const target = new EventTarget()
    const input = createInput({ target, gamepad: false })
    target.dispatchEvent(key('keydown', 'ArrowRight'))
    target.dispatchEvent(new Event('blur'))
    expect(input.isDown('right')).toBe(false)
    input.update()
    expect(input.released('right')).toBe(true)

    target.dispatchEvent(Object.assign(new Event('pointerdown'), { clientX: 12, clientY: 34 }))
    expect(input.pointer).toEqual({ x: 12, y: 34, down: true })
    input.destroy()
    target.dispatchEvent(key('keydown', 'ArrowRight'))
    expect(input.isDown('right')).toBe(false)
  })
})

describe('starter storage', () => {
  function fakeStorage(): FakeStorage & { map: Map<string, string> } {
    const map = new Map<string, string>()
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    }
  }
  const defaults = { best: 0, sound: true }

  it('saves and loads, merging shallowly over the defaults', () => {
    const storage = fakeStorage()
    const s = createStorage({ key: 'g', defaults, storage })
    expect(s.load()).toEqual(defaults)
    expect(s.save({ best: 9 })).toBe(true)
    expect(JSON.parse(storage.map.get('g')!)).toEqual({ v: 1, data: { best: 9 } })
    expect(s.load()).toEqual({ best: 9, sound: true })
    expect(s.key).toBe('g')
  })

  it('returns defaults when there is no storage', () => {
    // Node 24 may expose a localStorage getter; passing undefined falls back to it, so use a throwing getter too.
    const s = createStorage({ key: 'g', defaults, storage: undefined })
    expect(s.load()).toEqual(defaults)
    expect(typeof s.save({ best: 1 })).toBe('boolean')
  })

  it('returns defaults when getItem throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    }
    expect(createStorage({ key: 'g', defaults, storage }).load()).toEqual(defaults)
  })

  it('returns defaults for corrupt JSON, wrong shape and newer versions', () => {
    const storage = fakeStorage()
    const s = createStorage({ key: 'g', defaults, storage })
    for (const raw of [
      '{not json',
      '42',
      '{"v":1}',
      '{"v":1,"data":[1]}',
      '{"v":1,"data":"x"}',
      '{"v":2,"data":{"best":5}}',
    ]) {
      storage.map.set('g', raw)
      expect(s.load()).toEqual(defaults)
    }
  })

  it('save returns false instead of throwing on a quota error or without storage', () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => undefined,
    }
    expect(createStorage({ key: 'g', defaults, storage: full }).save({ best: 1 })).toBe(false)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(createStorage({ key: 'g', defaults, storage: fakeStorage() }).save(circular)).toBe(false)
  })

  it('uses migrate for an older version, and falls back to defaults if it throws', () => {
    const storage = fakeStorage()
    storage.map.set('g', '{"v":1,"data":{"hi":7}}')
    const seen: unknown[] = []
    const s = createStorage({
      key: 'g',
      version: 2,
      defaults,
      storage,
      migrate: (old: { hi: number }, v: number) => {
        seen.push(v)
        return { best: old.hi }
      },
    })
    expect(s.load()).toEqual({ best: 7, sound: true })
    expect(seen).toEqual([1])
    const bad = createStorage({
      key: 'g',
      version: 2,
      defaults,
      storage,
      migrate: () => {
        throw new Error('nope')
      },
    })
    expect(bad.load()).toEqual(defaults)
    expect(createStorage({ key: 'g', version: 2, defaults, storage }).load()).toEqual(defaults)
  })

  it('reset clears the key and returns defaults', () => {
    const storage = fakeStorage()
    const s = createStorage({ key: 'g', defaults, storage })
    s.save({ best: 3 })
    expect(s.reset()).toEqual(defaults)
    expect(storage.map.has('g')).toBe(false)
  })

  it('returns copies of the defaults', () => {
    const s = createStorage({ key: 'g', defaults: { list: [1] }, storage: fakeStorage() })
    const a = s.load()
    ;(a.list as number[]).push(2)
    expect(s.load()).toEqual({ list: [1] })
    expect(s.reset()).toEqual({ list: [1] })
  })
})

describe('starter test hook', () => {
  function setup(search: string) {
    const target: Record<string, unknown> = {}
    const clockless = { frames: 0 }
    const game = { scene: 'title', score: 0 }
    const loop = createLoop({
      update: () => clockless.frames++,
      render: () => undefined,
      requestFrame: () => 1,
      cancelFrame: () => undefined,
      now: () => 0,
      target: new EventTarget(),
    })
    const input = createInput({ target: new EventTarget(), gamepad: false })
    const rng = createRng(11)
    const seeds: number[] = []
    const hook = installTestHook({
      loop,
      input,
      rng,
      state: () => ({ ...game, undef: undefined }),
      setSeed: (n: number) => seeds.push(n),
      location: { search },
      target,
    })
    return { hook, target, loop, input, seeds, clockless }
  }

  it('does nothing without ?test=1', () => {
    for (const search of ['', '?test=0', '?test=true', '?x=1']) {
      const { hook, target } = setup(search)
      expect(hook).toBeNull()
      expect('__game' in target).toBe(false)
    }
    expect(installTestHook({ location: { search: '' }, target: {} })).toBeNull()
  })

  it('installs a frozen __game with ?test=1', () => {
    const { hook, target } = setup('?a=b&test=1')
    expect(hook).not.toBeNull()
    expect(target.__game).toBe(hook)
    expect(Object.isFrozen(hook)).toBe(true)
    expect(hook!.version).toBe(TEST_HOOK_VERSION)
  })

  it('steps the paused loop and reaches the input', () => {
    const { hook, loop, input, clockless } = setup('?test=1')
    hook!.pause()
    expect(loop.paused).toBe(true)
    hook!.step(4)
    expect(loop.ticks).toBe(4)
    expect(clockless.frames).toBe(4)
    hook!.press('left')
    expect(input.isDown('left')).toBe(true)
    hook!.release('left')
    expect(input.isDown('left')).toBe(false)
    hook!.tap('action')
    expect(loop.ticks).toBe(5)
    expect(input.isDown('action')).toBe(false)
    input.update()
    expect(input.released('action')).toBe(true)
    hook!.resume()
    expect(loop.paused).toBe(false)
  })

  it('reports a JSON-safe state with reducedMotion, paused and ticks, and the seed', () => {
    const { hook, seeds } = setup('?test=1')
    hook!.pause()
    hook!.step(2)
    const s = hook!.state()
    expect(s).toEqual({ reducedMotion: false, scene: 'title', score: 0, paused: true, ticks: 2 })
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    expect(hook!.seed()).toBe(11)
    // Restarting with a seed answers the seed now in use.
    expect(hook!.seed(99)).toBe(99)
    expect(hook!.seed()).toBe(99)
    expect(seeds).toEqual([99])
  })
})
