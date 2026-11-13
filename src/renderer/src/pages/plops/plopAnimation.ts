// What a Plop on the Plops page is doing from moment to moment: the renderer's animation layer over the state core
// gives it (lineup.ts). Core says "running now" with `gas`; here that becomes gas or smoke, picked at random, and a
// rotation of snacks and emissions while steps run. A Plop that crossed a stage first eats a snack, then grows (once).
// Oil and steam keep their meanings and take priority: a Plop showing either never rotates and never snacks at rest;
// nor does a puddle, which gets no emission and no snack-then-grow either. A Plop in use (happy or idle: tokens in the
// period, used in the last 24 hours) with no emission (not running, no oil, no steam) snacks now and then at rest: one
// random snack for one eating loop, never the same one twice in a row, at random gaps, with a page-wide gate
// (SnackGate) so at most about half of them eat at once. The random source, the timer and the page's visibility are
// injected (PlopMotionContext), so tests run it deterministically.
//
// Phases: `snack` (the pre-growth snack, one eating loop) -> `growing` (GROWING_MS) -> `live` (rotating, 5 to 9 s per
// item, the first item held a random 1.5 to 9 s so Plops change out of step) or `rest`. A Plop in use goes from `rest`
// to `nibble` (a random snack, one eating loop) and back: the first after 1.5 to 12 s, then 6 to 20 s after the last
// ends, tried again 2 to 5 s later when the gate is full. Without motion: `still`, one pose that still shows the state
// (a static gas or smoke puff), no timers at all.
import { createContext } from 'react'
import type { PlopEmit, PlopMood, PlopSnack } from '@shared/plops.ts'
import { GROWING_MS } from './plopModel.ts'

/** A random source: a number in [0, 1), like Math.random. */
export type PlopRandom = () => number

export interface PlopTimer {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface PlopMotion {
  random: PlopRandom
  timer: PlopTimer
  /** Whether the page or window is hidden now (timers stop while it is). */
  hidden(): boolean
  /** Calls `cb` when the page or window is shown or hidden; returns the unsubscribe. */
  onVisibilityChange(cb: () => void): () => void
}

/** The bit of `document` this needs, read off globalThis so the module also loads where there is no DOM. */
interface VisibilityDoc {
  visibilityState: string
  addEventListener(type: 'visibilitychange', cb: () => void): void
  removeEventListener(type: 'visibilitychange', cb: () => void): void
}
const doc = (): VisibilityDoc | undefined => (globalThis as { document?: VisibilityDoc }).document

export const defaultPlopMotion: PlopMotion = {
  random: () => Math.random(),
  timer: {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
  hidden: () => doc()?.visibilityState === 'hidden',
  onVisibilityChange: (cb) => {
    const d = doc()
    if (d === undefined) return () => {}
    d.addEventListener('visibilitychange', cb)
    return () => d.removeEventListener('visibilitychange', cb)
  },
}

export const PlopMotionContext = createContext<PlopMotion>(defaultPlopMotion)

/** A small seeded random source (mulberry32), for tests and anything that wants a repeatable sequence. */
export function seededRandom(seed: number): PlopRandom {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const ACTIVE_EMITS = ['gas', 'smoke'] as const satisfies readonly PlopEmit[]
export type ActiveEmit = (typeof ACTIVE_EMITS)[number]
export const SNACKS = ['metal', 'cord', 'bolt', 'water'] as const satisfies readonly PlopSnack[]
export type Snack = (typeof SNACKS)[number]

/** One rotation item's hold: 5 to 9 s. */
export const ROTATE_MIN_MS = 5000
export const ROTATE_MAX_MS = 9000
/** The first item's hold: 1.5 to 9 s, so Plops on one page change out of step. */
export const FIRST_MIN_MS = 1500
/** The pre-growth snack plays one eating loop (the cord's loop is short, so it bites twice). */
export const SNACK_MS: Readonly<Record<Snack, number>> = { metal: 2400, cord: 3200, bolt: 2200, water: 3000 }

/** The first random snack at rest comes 1.5 to 12 s in, so Plops on one page start out of step. */
export const NIBBLE_FIRST_MIN_MS = 1500
export const NIBBLE_FIRST_MAX_MS = 12000
/** Then one 6 to 20 s after the last one ends. */
export const NIBBLE_GAP_MIN_MS = 6000
export const NIBBLE_GAP_MAX_MS = 20000
/** When the page's gate is full, the Plop tries again 2 to 5 s later. */
export const NIBBLE_RETRY_MIN_MS = 2000
export const NIBBLE_RETRY_MAX_MS = 5000

const between = (random: PlopRandom, min: number, max: number): number =>
  Math.round(min + random() * (max - min))
export const nibbleFirstGap = (random: PlopRandom): number =>
  between(random, NIBBLE_FIRST_MIN_MS, NIBBLE_FIRST_MAX_MS)
export const nibbleGap = (random: PlopRandom): number => between(random, NIBBLE_GAP_MIN_MS, NIBBLE_GAP_MAX_MS)
export const nibbleRetry = (random: PlopRandom): number =>
  between(random, NIBBLE_RETRY_MIN_MS, NIBBLE_RETRY_MAX_MS)

/**
 * The page-wide cap on random snacks at rest: the Plops that snack join while their timers run, and at most half of
 * them (at least one) eat at the same moment.
 */
export interface SnackGate {
  /** Joins while the Plop's timers run; returns the leave (safe to call twice). */
  join(): () => void
  /** Takes a seat if one is free. */
  enter(): boolean
  /** Gives a seat back. */
  exit(): void
  readonly eating: number
  readonly members: number
}

export const snackCap = (members: number): number => Math.max(1, Math.floor(members / 2))

export function createSnackGate(): SnackGate {
  let members = 0
  let eating = 0
  return {
    join() {
      members++
      let left = false
      return () => {
        if (left) return
        left = true
        members--
      }
    },
    enter() {
      if (eating >= snackCap(members)) return false
      eating++
      return true
    },
    exit() {
      eating = Math.max(0, eating - 1)
    },
    get eating() {
      return eating
    },
    get members() {
      return members
    },
  }
}

/** The page's gate; without one (no provider) nothing caps the snacks. */
export const PlopSnackGateContext = createContext<SnackGate | null>(null)

/** A random snack at rest: any of the four, never the one eaten last. */
export function pickNibble(random: PlopRandom, prev: Snack | null): Snack {
  return pick(
    SNACKS.filter((x) => x !== prev),
    random,
  )
}

/** One rotation item: a snack, an emission, or a snack and an emission together. */
export interface RotationItem {
  snack: PlopSnack
  emit: ActiveEmit | 'none'
}

/** Every item the rotation picks among: each snack alone, each emission alone, and each pair. */
export const ROTATION_ITEMS: readonly RotationItem[] = [
  ...SNACKS.map((snack): RotationItem => ({ snack, emit: 'none' })),
  ...ACTIVE_EMITS.map((emit): RotationItem => ({ snack: 'none', emit })),
  ...SNACKS.flatMap((snack) => ACTIVE_EMITS.map((emit): RotationItem => ({ snack, emit }))),
]

const pick = <T>(list: readonly T[], random: PlopRandom): T =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))]!

export const pickActiveEmit = (random: PlopRandom): ActiveEmit => pick(ACTIVE_EMITS, random)

/** The pre-growth snack: any of the four, water twice as likely (a drink goes well with a growth spurt). */
export const pickGrowSnack = (random: PlopRandom): Snack =>
  pick(['metal', 'cord', 'bolt', 'water', 'water'], random)

/** The next rotation item: uniform over ROTATION_ITEMS, never the one showing now. */
export function pickRotation(random: PlopRandom, prev: number | null): number {
  const n = ROTATION_ITEMS.length
  if (prev === null) return Math.min(n - 1, Math.floor(random() * n))
  const i = Math.min(n - 2, Math.floor(random() * (n - 1)))
  return i >= prev ? i + 1 : i
}

export const rotationHold = (random: PlopRandom): number =>
  Math.round(ROTATE_MIN_MS + random() * (ROTATE_MAX_MS - ROTATE_MIN_MS))
export const firstHold = (random: PlopRandom): number =>
  Math.round(FIRST_MIN_MS + random() * (ROTATE_MAX_MS - FIRST_MIN_MS))

export type PlopPhase = 'snack' | 'growing' | 'live' | 'rest' | 'nibble' | 'still'

export interface PlopFrame {
  phase: PlopPhase
  mood: PlopMood
  snack: PlopSnack
  emit: PlopEmit
}

export interface AnimatorInput {
  resting: Exclude<PlopMood, 'growing'>
  /** Core's emission: `gas` means steps are running now. */
  emit: PlopEmit
  /** Play the snack-then-grow sequence (the caller checks it has not played). */
  grow: boolean
  animated: boolean
}

export interface PlopAnimator {
  readonly frame: PlopFrame
  /** Whether this animator plays the snack-then-grow sequence. */
  readonly grows: boolean
  /** Whether this animator snacks now and then at rest (in use, no emission, with motion). */
  readonly nibbles: boolean
  /** Starts (or resumes) the timers; a no-op when still or at rest. */
  start(): void
  /** Clears any pending timer; `start` resumes from the current phase. */
  stop(): void
  subscribe(cb: (f: PlopFrame) => void): () => void
}

/**
 * One Plop's animation state machine. Creating it draws from `random` but starts no timer. `gate` caps the random
 * snacks at rest across the page (none: uncapped).
 */
export function createPlopAnimator(
  input: AnimatorInput,
  motion: Pick<PlopMotion, 'random' | 'timer'>,
  gate: SnackGate | null = null,
): PlopAnimator {
  const { random, timer } = motion
  // A puddle only lies there: no rotation, no emission, no snack-then-grow.
  const puddle = input.resting === 'puddle'
  const running = !puddle && (input.emit === 'gas' || input.emit === 'smoke')
  // The emission shown outside the rotation: oil and steam as they are, running as gas or smoke.
  const baseEmit: PlopEmit = puddle ? 'none' : running ? pickActiveEmit(random) : input.emit
  const grows = !puddle && input.animated && input.grow
  // In use: tokens in the period (not a puddle) and used in the last 24 hours (not sleepy). Running Plops rotate;
  // oil (failures) and steam (a limit or blocker) hold still on their emission.
  const nibbles =
    input.animated && input.emit === 'none' && (input.resting === 'happy' || input.resting === 'idle')
  const listeners = new Set<(f: PlopFrame) => void>()
  let handle: unknown = null
  let rotation: number | null = null
  let firstLive = true
  let growSnack: Snack = 'water'
  let lastNibble: Snack | null = null
  let firstNibble = true
  /** Whether this Plop holds one of the gate's seats now. */
  let seated = false
  let leave: (() => void) | null = null
  const restFrame = (): PlopFrame => ({ phase: 'rest', mood: input.resting, snack: 'none', emit: baseEmit })

  const liveFrame = (): PlopFrame => {
    rotation = pickRotation(random, rotation)
    const item = ROTATION_ITEMS[rotation]!
    return { phase: 'live', mood: input.resting, snack: item.snack, emit: item.emit }
  }
  const settled = (): PlopFrame => (running ? liveFrame() : restFrame())

  let frame: PlopFrame
  if (!input.animated) frame = { phase: 'still', mood: input.resting, snack: 'none', emit: baseEmit }
  else if (grows) {
    growSnack = pickGrowSnack(random)
    // The first snack at rest is a different one.
    lastNibble = growSnack
    frame = { phase: 'snack', mood: input.resting, snack: growSnack, emit: baseEmit }
  } else frame = settled()
  /** The frame listeners last heard (they start from `frame`). */
  let heard = frame

  const holdFor = (f: PlopFrame): number | null => {
    if (f.phase === 'snack') return SNACK_MS[growSnack]
    if (f.phase === 'nibble') return SNACK_MS[f.snack as Snack]
    if (f.phase === 'rest') {
      if (!nibbles) return null
      const first = firstNibble
      firstNibble = false
      return first ? nibbleFirstGap(random) : nibbleGap(random)
    }
    if (f.phase === 'growing') return GROWING_MS
    if (f.phase === 'live') {
      const first = firstLive
      firstLive = false
      return first ? firstHold(random) : rotationHold(random)
    }
    return null
  }
  const next = (f: PlopFrame): PlopFrame => {
    if (f.phase === 'snack') return { phase: 'growing', mood: 'growing', snack: 'none', emit: baseEmit }
    if (f.phase === 'growing') {
      // Coming out of a growth spurt the rotation, or the snacks at rest, start on their regular hold or gap.
      firstLive = false
      firstNibble = false
      return settled()
    }
    if (f.phase === 'nibble') {
      if (seated) gate?.exit()
      seated = false
      return restFrame()
    }
    if (f.phase === 'rest') {
      lastNibble = pickNibble(random, lastNibble)
      return { phase: 'nibble', mood: input.resting, snack: lastNibble, emit: baseEmit }
    }
    return liveFrame()
  }
  const tell = (): void => {
    if (heard === frame) return
    heard = frame
    for (const cb of listeners) cb(frame)
  }
  const scheduleIn = (ms: number): void => {
    handle = timer.set(() => {
      handle = null
      if (frame.phase === 'rest' && gate !== null) {
        // Time for a snack, if the page has a seat free; else try again shortly.
        if (!gate.enter()) {
          scheduleIn(nibbleRetry(random))
          return
        }
        seated = true
      }
      frame = next(frame)
      tell()
      schedule()
    }, ms)
  }
  const schedule = (): void => {
    const ms = holdFor(frame)
    if (ms !== null) scheduleIn(ms)
  }

  return {
    get frame() {
      return frame
    },
    grows,
    nibbles,
    start() {
      if (handle !== null) return
      if (nibbles && gate !== null && leave === null) leave = gate.join()
      // A snack cut short by a stop shows its rest pose again.
      tell()
      schedule()
    },
    stop() {
      if (handle !== null) timer.clear(handle)
      handle = null
      if (frame.phase === 'nibble') {
        // Put the snack away and give the seat back; listeners hear it on the next start.
        if (seated) gate?.exit()
        seated = false
        frame = restFrame()
      }
      leave?.()
      leave = null
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
