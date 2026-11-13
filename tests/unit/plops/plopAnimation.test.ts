// The Plops' animation layer (src/renderer/src/pages/plops/plopAnimation.ts), with a seeded random source and a
// hand-driven timer: running Plops rotate snacks and gas or smoke, a Plop that grew eats a snack first, a Plop in use
// snacks now and then at rest (random times, random snacks, capped page-wide), oil and steam take priority, reduced
// motion is one still pose, and stopping leaves no timer behind.
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_EMITS,
  createPlopAnimator,
  createSnackGate,
  FIRST_MIN_MS,
  NIBBLE_FIRST_MAX_MS,
  NIBBLE_FIRST_MIN_MS,
  NIBBLE_GAP_MAX_MS,
  NIBBLE_GAP_MIN_MS,
  NIBBLE_RETRY_MAX_MS,
  NIBBLE_RETRY_MIN_MS,
  pickGrowSnack,
  pickNibble,
  pickRotation,
  ROTATE_MAX_MS,
  ROTATE_MIN_MS,
  ROTATION_ITEMS,
  seededRandom,
  SNACK_MS,
  snackCap,
  SNACKS,
} from '@renderer/pages/plops/plopAnimation.ts'
import type { AnimatorInput, PlopFrame, PlopTimer, Snack } from '@renderer/pages/plops/plopAnimation.ts'
import { GROWING_MS } from '@renderer/pages/plops/plopModel.ts'

interface FakeTimer extends PlopTimer {
  /** Every hold asked for, in order. */
  holds: number[]
  pending(): number
  /** Runs the one pending timer (asserting there is exactly one), returning the hold it waited. */
  fire(): number
}

function fakeTimer(): FakeTimer {
  const q = new Map<number, { fn: () => void; ms: number }>()
  let id = 0
  const holds: number[] = []
  return {
    holds,
    set(fn, ms) {
      holds.push(ms)
      q.set(++id, { fn, ms })
      return id
    },
    clear(h) {
      q.delete(h as number)
    },
    pending: () => q.size,
    fire() {
      expect(q.size).toBe(1)
      const [key, t] = [...q.entries()][0]!
      q.delete(key)
      t.fn()
      return t.ms
    },
  }
}

/** A timer on a hand-stepped clock, for several animators at once: `advance` runs what falls due, in time order. */
interface ClockTimer extends PlopTimer {
  pending(): number
  advance(ms: number, afterEach?: () => void): void
}

function clockTimer(): ClockTimer {
  const q = new Map<number, { fn: () => void; at: number }>()
  let id = 0
  let now = 0
  return {
    set(fn, ms) {
      q.set(++id, { fn, at: now + ms })
      return id
    },
    clear(h) {
      q.delete(h as number)
    },
    pending: () => q.size,
    advance(ms, afterEach) {
      const end = now + ms
      for (;;) {
        let due: [number, { fn: () => void; at: number }] | null = null
        for (const e of q) if (e[1].at <= end && (due === null || e[1].at < due[1].at)) due = e
        if (due === null) break
        q.delete(due[0])
        now = due[1].at
        due[1].fn()
        afterEach?.()
      }
      now = end
    },
  }
}

const input = (over: Partial<AnimatorInput> = {}): AnimatorInput => ({
  resting: 'happy',
  emit: 'gas',
  grow: false,
  animated: true,
  ...over,
})

const SNACK_SET = new Set<string>(SNACKS)
const ACTIVE_SET = new Set<string>(ACTIVE_EMITS)

describe('the rotation while steps run', () => {
  it('picks among the snacks and gas or smoke, and changes on the timer', () => {
    const timer = fakeTimer()
    const a = createPlopAnimator(input(), { random: seededRandom(7), timer })
    const frames: PlopFrame[] = []
    a.subscribe((f) => frames.push(f))
    expect(a.frame.phase).toBe('live')
    a.start()
    const first = a.frame
    for (let i = 0; i < 40; i++) timer.fire()
    const all = [first, ...frames]
    expect(all).toHaveLength(41)
    for (const f of all) {
      expect(f.mood).toBe('happy')
      expect(f.snack === 'none' || SNACK_SET.has(f.snack)).toBe(true)
      expect(f.emit === 'none' || ACTIVE_SET.has(f.emit)).toBe(true)
      expect(f.snack !== 'none' || f.emit !== 'none').toBe(true)
    }
    // Never the same item twice in a row; over 40 changes it shows snacks, both emissions and pairs.
    for (let i = 1; i < all.length; i++)
      expect([all[i]!.snack, all[i]!.emit]).not.toEqual([all[i - 1]!.snack, all[i - 1]!.emit])
    expect(all.some((f) => f.emit === 'gas')).toBe(true)
    expect(all.some((f) => f.emit === 'smoke')).toBe(true)
    expect(all.some((f) => f.snack !== 'none' && f.emit === 'none')).toBe(true)
    expect(all.some((f) => f.snack !== 'none' && f.emit !== 'none')).toBe(true)
    // The first hold is offset (1.5 to 9 s), every later one 5 to 9 s.
    expect(timer.holds[0]).toBeGreaterThanOrEqual(FIRST_MIN_MS)
    expect(timer.holds[0]).toBeLessThanOrEqual(ROTATE_MAX_MS)
    for (const h of timer.holds.slice(1)) {
      expect(h).toBeGreaterThanOrEqual(ROTATE_MIN_MS)
      expect(h).toBeLessThanOrEqual(ROTATE_MAX_MS)
    }
  })

  it('is repeatable with one seed, and Plops with different draws change out of step', () => {
    const run = (seed: number): { holds: number[]; frames: string[] } => {
      const timer = fakeTimer()
      const a = createPlopAnimator(input(), { random: seededRandom(seed), timer })
      a.start()
      const frames = [`${a.frame.snack}/${a.frame.emit}`]
      for (let i = 0; i < 5; i++) {
        timer.fire()
        frames.push(`${a.frame.snack}/${a.frame.emit}`)
      }
      return { holds: timer.holds, frames }
    }
    expect(run(3)).toEqual(run(3))
    expect(run(3).holds[0]).not.toBe(run(4).holds[0])
  })

  it('never repeats the item showing now', () => {
    for (let prev = 0; prev < ROTATION_ITEMS.length; prev++)
      for (const r of [0, 0.3, 0.5, 0.99]) {
        const i = pickRotation(() => r, prev)
        expect(i).not.toBe(prev)
        expect(i).toBeGreaterThanOrEqual(0)
        expect(i).toBeLessThan(ROTATION_ITEMS.length)
      }
  })
})

describe('the snack before growing', () => {
  it('eats one snack for one eating loop, then grows, then rests', () => {
    for (const resting of ['happy', 'sleepy'] as const) {
      const timer = fakeTimer()
      const a = createPlopAnimator(input({ resting, emit: 'none', grow: true }), {
        random: seededRandom(11),
        timer,
      })
      expect(a.grows).toBe(true)
      const snack = a.frame.snack
      expect(a.frame).toMatchObject({ phase: 'snack', mood: resting, emit: 'none' })
      expect(SNACK_SET.has(snack)).toBe(true)
      a.start()
      expect(timer.fire()).toBe(SNACK_MS[snack as Snack])
      expect(a.frame).toEqual({ phase: 'growing', mood: 'growing', snack: 'none', emit: 'none' })
      expect(timer.fire()).toBe(GROWING_MS)
      expect(a.frame).toEqual({ phase: 'rest', mood: resting, snack: 'none', emit: 'none' })
      // A sleepy Plop rests for good; a happy one (in use) waits for its next snack at rest.
      expect(timer.pending()).toBe(resting === 'sleepy' ? 0 : 1)
    }
  })

  it('then snacks at rest on the regular gap, starting with a different snack', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const timer = fakeTimer()
      const a = createPlopAnimator(input({ emit: 'none', grow: true }), { random: seededRandom(seed), timer })
      const grown = a.frame.snack
      a.start()
      timer.fire()
      timer.fire()
      expect(a.frame.phase).toBe('rest')
      const gap = timer.fire()
      expect(gap).toBeGreaterThanOrEqual(NIBBLE_GAP_MIN_MS)
      expect(gap).toBeLessThanOrEqual(NIBBLE_GAP_MAX_MS)
      expect(a.frame.phase).toBe('nibble')
      expect(a.frame.snack).not.toBe(grown)
    }
  })

  it('goes on into the rotation when steps are running', () => {
    const timer = fakeTimer()
    const a = createPlopAnimator(input({ grow: true }), { random: seededRandom(5), timer })
    expect(a.frame.phase).toBe('snack')
    expect(ACTIVE_SET.has(a.frame.emit)).toBe(true)
    a.start()
    timer.fire()
    expect(a.frame.mood).toBe('growing')
    timer.fire()
    expect(a.frame.phase).toBe('live')
    timer.fire()
    // Out of a growth spurt the rotation runs on its regular hold.
    expect(timer.holds[2]).toBeGreaterThanOrEqual(ROTATE_MIN_MS)
  })

  it('prefers water, but any of the four can come', () => {
    expect([0, 0.2, 0.4, 0.6, 0.8, 0.99].map((r) => pickGrowSnack(() => r))).toEqual([
      'metal',
      'cord',
      'bolt',
      'water',
      'water',
      'water',
    ])
  })
})

describe('priorities and stillness', () => {
  it('oil and steam show as they are and never rotate', () => {
    for (const emit of ['oil', 'steam'] as const) {
      const timer = fakeTimer()
      const a = createPlopAnimator(input({ emit }), { random: seededRandom(1), timer })
      expect(a.frame).toEqual({ phase: 'rest', mood: 'happy', snack: 'none', emit })
      a.start()
      expect(timer.pending()).toBe(0)
    }
    // The snack before growing still plays, with the oil showing throughout.
    const timer = fakeTimer()
    const a = createPlopAnimator(input({ emit: 'oil', grow: true }), { random: seededRandom(1), timer })
    a.start()
    expect(a.frame.emit).toBe('oil')
    timer.fire()
    expect(a.frame).toMatchObject({ mood: 'growing', emit: 'oil' })
    timer.fire()
    expect(a.frame).toEqual({ phase: 'rest', mood: 'happy', snack: 'none', emit: 'oil' })
    expect(timer.pending()).toBe(0)
  })

  it('a puddle only lies there: no rotation, no emission, no snack-then-grow, moving or still', () => {
    for (const emit of ['gas', 'smoke', 'oil', 'steam', 'none'] as const) {
      for (const animated of [true, false]) {
        const timer = fakeTimer()
        const a = createPlopAnimator(input({ resting: 'puddle', emit, grow: true, animated }), {
          random: seededRandom(3),
          timer,
        })
        expect(a.grows).toBe(false)
        expect(a.frame).toEqual({
          phase: animated ? 'rest' : 'still',
          mood: 'puddle',
          snack: 'none',
          emit: 'none',
        })
        a.start()
        expect(timer.pending()).toBe(0)
      }
    }
  })

  it('without motion is one still pose that still shows running, with no timer and no snack', () => {
    for (const seed of [1, 2, 3, 4]) {
      const timer = fakeTimer()
      const a = createPlopAnimator(input({ grow: true, animated: false }), {
        random: seededRandom(seed),
        timer,
      })
      expect(a.grows).toBe(false)
      expect(a.frame.phase).toBe('still')
      expect(a.frame.mood).toBe('happy')
      expect(a.frame.snack).toBe('none')
      expect(ACTIVE_SET.has(a.frame.emit)).toBe(true)
      a.start()
      expect(timer.pending()).toBe(0)
    }
  })

  it('stop clears the pending timer and start resumes', () => {
    const timer = fakeTimer()
    const a = createPlopAnimator(input(), { random: seededRandom(9), timer })
    a.start()
    a.start()
    expect(timer.pending()).toBe(1)
    a.stop()
    expect(timer.pending()).toBe(0)
    a.start()
    expect(timer.pending()).toBe(1)
    a.stop()
    expect(timer.pending()).toBe(0)
  })
})

describe('snacks at rest while in use', () => {
  const rest = (over: Partial<AnimatorInput> = {}): AnimatorInput => input({ emit: 'none', ...over })

  it('an in-use Plop snacks at random times, a random snack for one eating loop, then rests again', () => {
    for (const resting of ['happy', 'idle'] as const) {
      const timer = fakeTimer()
      const a = createPlopAnimator(rest({ resting }), { random: seededRandom(21), timer })
      expect(a.nibbles).toBe(true)
      expect(a.frame).toEqual({ phase: 'rest', mood: resting, snack: 'none', emit: 'none' })
      const frames: PlopFrame[] = []
      a.subscribe((f) => frames.push(f))
      a.start()
      const holds: number[] = []
      for (let i = 0; i < 40; i++) holds.push(timer.fire())
      // Rest and snack take turns; each snack lasts its eating loop and the Plop keeps its mood.
      expect(frames).toHaveLength(40)
      frames.forEach((f, i) => {
        if (i % 2 === 0) {
          expect(f.phase).toBe('nibble')
          expect(SNACK_SET.has(f.snack)).toBe(true)
          if (i + 1 < holds.length) expect(holds[i + 1]).toBe(SNACK_MS[f.snack as Snack])
        } else expect(f).toEqual({ phase: 'rest', mood: resting, snack: 'none', emit: 'none' })
        expect(f.mood).toBe(resting)
      })
      // The waits are random: the first 1.5 to 12 s, then 6 to 20 s, and not all the same.
      const gaps = holds.filter((_, i) => i % 2 === 0)
      expect(gaps[0]).toBeGreaterThanOrEqual(NIBBLE_FIRST_MIN_MS)
      expect(gaps[0]).toBeLessThanOrEqual(NIBBLE_FIRST_MAX_MS)
      for (const g of gaps.slice(1)) {
        expect(g).toBeGreaterThanOrEqual(NIBBLE_GAP_MIN_MS)
        expect(g).toBeLessThanOrEqual(NIBBLE_GAP_MAX_MS)
      }
      expect(new Set(gaps).size).toBeGreaterThan(10)
      // Every one of the four snacks comes up.
      expect(new Set(frames.filter((f) => f.phase === 'nibble').map((f) => f.snack))).toEqual(SNACK_SET)
    }
  })

  it('never eats the same snack twice in a row', () => {
    for (const seed of [1, 2, 3]) {
      const timer = fakeTimer()
      const a = createPlopAnimator(rest(), { random: seededRandom(seed), timer })
      a.start()
      const eaten: string[] = []
      for (let i = 0; i < 60; i++) {
        timer.fire()
        if (a.frame.phase === 'nibble') eaten.push(a.frame.snack)
      }
      expect(eaten).toHaveLength(30)
      for (let i = 1; i < eaten.length; i++) expect(eaten[i]).not.toBe(eaten[i - 1])
    }
    for (const prev of SNACKS)
      for (const r of [0, 0.3, 0.6, 0.99]) {
        const s = pickNibble(() => r, prev)
        expect(s).not.toBe(prev)
        expect(SNACK_SET.has(s)).toBe(true)
      }
  })

  it('starts each Plop at its own random offset', () => {
    const random = seededRandom(77)
    const firsts = Array.from({ length: 8 }, () => {
      const timer = fakeTimer()
      createPlopAnimator(rest(), { random, timer }).start()
      return timer.holds[0]!
    })
    for (const f of firsts) {
      expect(f).toBeGreaterThanOrEqual(NIBBLE_FIRST_MIN_MS)
      expect(f).toBeLessThanOrEqual(NIBBLE_FIRST_MAX_MS)
    }
    expect(new Set(firsts).size).toBe(firsts.length)
  })

  it('lets at most half of the lineup (at least one) eat at the same moment', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(snackCap)).toEqual([1, 1, 1, 2, 2, 3, 3])
    for (const count of [2, 5, 8]) {
      const timer = clockTimer()
      const gate = createSnackGate()
      const random = seededRandom(count)
      const plops = Array.from({ length: count }, () => createPlopAnimator(rest(), { random, timer }, gate))
      // A sleepy one and a running one share the page but never take a seat.
      const sleepy = createPlopAnimator(rest({ resting: 'sleepy' }), { random, timer }, gate)
      const running = createPlopAnimator(input(), { random, timer }, gate)
      for (const a of [...plops, sleepy, running]) a.start()
      expect(gate.members).toBe(count)
      const ate = new Set<number>()
      let most = 0
      timer.advance(10 * 60_000, () => {
        const eating = plops.filter((a) => a.frame.phase === 'nibble').length
        expect(eating).toBe(gate.eating)
        expect(eating).toBeLessThanOrEqual(snackCap(count))
        expect(sleepy.frame.phase).toBe('rest')
        expect(running.frame.phase).toBe('live')
        most = Math.max(most, eating)
        plops.forEach((a, i) => a.frame.phase === 'nibble' && ate.add(i))
      })
      expect(most).toBe(snackCap(count))
      // Every Plop got to eat.
      expect(ate.size).toBe(count)
      for (const a of [...plops, sleepy, running]) a.stop()
      expect(timer.pending()).toBe(0)
      expect(gate.eating).toBe(0)
      expect(gate.members).toBe(0)
    }
  })

  it('waits 2 to 5 s and tries again when the gate is full', () => {
    const timer = fakeTimer()
    const gate = createSnackGate()
    const leave = gate.join()
    expect(gate.enter()).toBe(true)
    const a = createPlopAnimator(rest(), { random: seededRandom(4), timer }, gate)
    a.start()
    // Two members: one seat, already taken.
    timer.fire()
    expect(a.frame.phase).toBe('rest')
    const retry = timer.holds[1]!
    expect(retry).toBeGreaterThanOrEqual(NIBBLE_RETRY_MIN_MS)
    expect(retry).toBeLessThanOrEqual(NIBBLE_RETRY_MAX_MS)
    gate.exit()
    timer.fire()
    expect(a.frame.phase).toBe('nibble')
    expect(gate.eating).toBe(1)
    timer.fire()
    expect(a.frame.phase).toBe('rest')
    expect(gate.eating).toBe(0)
    a.stop()
    leave()
    expect(gate.members).toBe(0)
  })

  it('puddle and sleepy Plops never snack, and running Plops keep their rotation instead', () => {
    for (const resting of ['puddle', 'sleepy'] as const) {
      const timer = fakeTimer()
      const gate = createSnackGate()
      const a = createPlopAnimator(rest({ resting }), { random: seededRandom(2), timer }, gate)
      expect(a.nibbles).toBe(false)
      a.start()
      expect(timer.pending()).toBe(0)
      expect(gate.members).toBe(0)
    }
    for (const emit of ['gas', 'smoke'] as const) {
      const timer = fakeTimer()
      const gate = createSnackGate()
      const a = createPlopAnimator(input({ emit }), { random: seededRandom(2), timer }, gate)
      expect(a.nibbles).toBe(false)
      a.start()
      expect(gate.members).toBe(0)
      for (let i = 0; i < 20; i++) {
        timer.fire()
        expect(a.frame.phase).toBe('live')
      }
      // The rotation's holds, not the snack gaps.
      for (const h of timer.holds.slice(1)) {
        expect(h).toBeGreaterThanOrEqual(ROTATE_MIN_MS)
        expect(h).toBeLessThanOrEqual(ROTATE_MAX_MS)
      }
    }
  })

  it('oil and steam Plops never get a random snack and stay out of the cap', () => {
    for (const emit of ['oil', 'steam'] as const)
      for (const resting of ['happy', 'idle'] as const)
        for (const grow of [false, true]) {
          const timer = clockTimer()
          const gate = createSnackGate()
          const a = createPlopAnimator(
            input({ resting, emit, grow }),
            { random: seededRandom(6), timer },
            gate,
          )
          expect(a.nibbles).toBe(false)
          const frames: PlopFrame[] = [a.frame]
          a.subscribe((f) => frames.push(f))
          a.start()
          expect(gate.members).toBe(0)
          timer.advance(10 * 60_000)
          expect(timer.pending()).toBe(0)
          expect(gate.members).toBe(0)
          // Only the pre-growth snack (when it grew), then rest on the emission for good.
          expect(frames.map((f) => f.phase)).toEqual(grow ? ['snack', 'growing', 'rest'] : ['rest'])
          for (const f of frames) expect(f.emit).toBe(emit)
          expect(a.frame).toEqual({ phase: 'rest', mood: resting, snack: 'none', emit })
        }
  })

  it('without motion never snacks', () => {
    const timer = fakeTimer()
    const gate = createSnackGate()
    const a = createPlopAnimator(rest({ animated: false }), { random: seededRandom(2), timer }, gate)
    expect(a.nibbles).toBe(false)
    expect(a.frame).toEqual({ phase: 'still', mood: 'happy', snack: 'none', emit: 'none' })
    a.start()
    expect(timer.pending()).toBe(0)
    expect(gate.members).toBe(0)
  })

  it('stopping (hidden or unmounted) clears the timer, puts the snack away and frees the seat; start resumes', () => {
    const timer = fakeTimer()
    const gate = createSnackGate()
    const a = createPlopAnimator(rest(), { random: seededRandom(8), timer }, gate)
    const heard: PlopFrame[] = []
    a.subscribe((f) => heard.push(f))
    a.start()
    expect(gate.members).toBe(1)
    timer.fire()
    expect(a.frame.phase).toBe('nibble')
    expect(gate.eating).toBe(1)
    a.stop()
    expect(timer.pending()).toBe(0)
    expect(gate.eating).toBe(0)
    expect(gate.members).toBe(0)
    expect(a.frame.phase).toBe('rest')
    // Shown again, listeners hear the rest pose and the next snack is on its regular gap.
    a.start()
    expect(heard.at(-1)).toEqual({ phase: 'rest', mood: 'happy', snack: 'none', emit: 'none' })
    expect(timer.pending()).toBe(1)
    expect(gate.members).toBe(1)
    expect(timer.holds.at(-1)).toBeGreaterThanOrEqual(NIBBLE_GAP_MIN_MS)
    a.stop()
    a.stop()
    expect(timer.pending()).toBe(0)
    expect(gate.members).toBe(0)
  })
})
