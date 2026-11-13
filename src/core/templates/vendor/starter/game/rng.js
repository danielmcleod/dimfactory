// A small seeded random number generator: the same seed always gives the same numbers.
// Handy for levels and replays, and it lets tests play a game the same way every time.
// Part of the Dim Factory game starter. MIT License: copy, change and share it freely.

/** Returns a number to use as a seed when the caller did not pick one. */
export function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0
}

/** Turns any string or number into four 32-bit numbers (the xmur3 hash). */
function hashSeed(seed) {
  let h = 1779033703 ^ String(seed).length
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.codePointAt(0), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  const out = []
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    out.push(h >>> 0)
  }
  return out
}

/**
 * @param {string | number} [seed] Leave it out to get a time-based seed (see the `seed` property).
 */
export function createRng(seed) {
  const usedSeed = seed ?? randomSeed()
  let [a, b, c, d] = hashSeed(usedSeed)

  /** One step of sfc32. Returns a float in [0, 1). */
  function next() {
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }

  // Warm up so that similar seeds give very different first numbers.
  for (let i = 0; i < 12; i++) next()

  return {
    seed: usedSeed,
    next,
    /** Whole number from min to max, both included. */
    int(min, max) {
      const lo = Math.ceil(Math.min(min, max))
      const hi = Math.floor(Math.max(min, max))
      return lo + Math.floor(next() * (hi - lo + 1))
    },
    /** Float from min up to (not including) max. */
    range(min, max) {
      return min + next() * (max - min)
    },
    /** True with probability p (0 to 1). */
    chance(p) {
      return next() < p
    },
    /** A random item of the array, or undefined when it is empty. */
    pick(array) {
      return array.length === 0 ? undefined : array[Math.floor(next() * array.length)]
    },
    /** A new shuffled array (Fisher-Yates). The input is not changed. */
    shuffle(array) {
      const copy = array.slice()
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const tmp = copy[i]
        copy[i] = copy[j]
        copy[j] = tmp
      }
      return copy
    },
    /** The inner state as four numbers. Save it to replay from this point. */
    state() {
      return [a >>> 0, b >>> 0, c >>> 0, d >>> 0]
    },
    setState(s) {
      a = s[0] | 0
      b = s[1] | 0
      c = s[2] | 0
      d = s[3] | 0
    },
  }
}
