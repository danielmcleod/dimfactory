// A small remote control for automated play-testing. It only exists when the page URL contains ?test=1.
// A test tool can then pause the game, step it frame by frame, press buttons and read the state.
// Part of the Dim Factory game starter. MIT License: copy, change and share it freely.

export const TEST_HOOK_VERSION = 1

/** state() answers at most this many bytes of JSON; a bigger state is cut down to the fields every game reports. */
export const STATE_MAX_BYTES = 8 * 1024

/** The most ticks one step() may run (one minute at 60 updates a second). */
export const STEP_MAX_TICKS = 3600

const REQUIRED = ['scene', 'score', 'lives', 'level']

/**
 * Whether the player asked for less motion: the system's "reduce motion" setting, or ?reducedMotion=1 in the address
 * (handy for trying it). Use it to turn off screen shake, flashes and fast scrolling.
 * @param {object} [options]
 * @param {{search: string}} [options.location] Default window.location.
 * @param {(query: string) => {matches: boolean}} [options.matchMedia] Default window.matchMedia.
 * @returns {boolean}
 */
export function prefersReducedMotion(options = {}) {
  const location = options.location ?? globalThis.location
  const media = options.matchMedia ?? globalThis.matchMedia
  try {
    if (location && new URLSearchParams(location.search).get('reducedMotion') === '1') return true
    return typeof media === 'function' && media('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/**
 * @param {object} options
 * @param {{pause, resume, stepOnce, paused: boolean, ticks: number}} options.loop From createLoop().
 * @param {{press, release, bindings?}} options.input From createInput().
 * @param {{seed: any}} options.rng From createRng().
 * @param {() => object} options.state Returns { scene, score, lives, level, ... } with small JSON-safe values.
 * @param {(seed: number) => void} [options.setSeed] Restarts the game with that seed.
 * @param {() => boolean} [options.reducedMotion] Whether the game runs with less motion now (your setting).
 *   Default: prefersReducedMotion().
 * @param {{search: string}} [options.location] Default window.location.
 * @param {object} [options.target] Where __game is set. Default window.
 * @returns {object | null} The hook, or null when the URL has no ?test=1.
 */
export function installTestHook(options) {
  const { loop, input, rng, state, setSeed } = options
  const location = options.location ?? globalThis.location
  const target = options.target ?? globalThis.window
  if (!location || !target) return null
  if (new URLSearchParams(location.search).get('test') !== '1') return null

  let seed = rng.seed
  const reducedMotion = options.reducedMotion ?? (() => prefersReducedMotion({ location }))

  /** A plain JSON copy of the state, plus reducedMotion, paused and ticks, never more than STATE_MAX_BYTES. */
  function readState() {
    const full = JSON.parse(
      JSON.stringify({
        reducedMotion: reducedMotion() === true,
        ...state(),
        paused: loop.paused,
        ticks: loop.ticks,
      }),
    )
    if (JSON.stringify(full).length <= STATE_MAX_BYTES) return full
    const small = { truncated: true, reducedMotion: full.reducedMotion, paused: full.paused, ticks: full.ticks }
    for (const k of REQUIRED) if (k in full && JSON.stringify(full[k]).length < 256) small[k] = full[k]
    return small
  }

  const hook = Object.freeze({
    version: TEST_HOOK_VERSION,
    /** True once the game is wired up (the hook is installed last). */
    ready: true,
    /** The input map's action names, like ['action', 'down', 'left']. */
    actions: () => (typeof input.bindings === 'function' ? Object.keys(input.bindings()).sort() : []),
    pause: () => loop.pause(),
    resume: () => loop.resume(),
    /** Runs exactly `ticks` fixed steps (1 to STEP_MAX_TICKS) and one render, even while paused. */
    step(ticks = 1) {
      const n = Math.floor(Number(ticks))
      if (!Number.isFinite(n) || n < 1 || n > STEP_MAX_TICKS) throw new RangeError('step(ticks): 1 to 3600')
      loop.stepOnce(n)
    },
    press: (action) => input.press(String(action)),
    release: (action) => input.release(String(action)),
    /** Press, run one step so the game sees it, release. */
    tap(action) {
      input.press(String(action))
      loop.stepOnce(1)
      input.release(String(action))
    },
    /** Restarts with seed n when you pass one. Returns the seed in use. */
    seed(n) {
      if (n !== undefined && setSeed) {
        setSeed(n)
        seed = n
      }
      return seed
    },
    state: readState,
  })
  target.__game = hook
  return hook
}
