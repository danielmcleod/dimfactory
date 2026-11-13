// The play-test's rules, Electron-free so they are unit-tested (main/playtest.ts drives the hidden window with them):
// - a scenario as a list of actions (real key presses, clicks and taps, test-hook calls, waits, checks, screenshots),
// - the keys a scenario may press as Electron's key codes,
// - the only scripts ever run in the game's page: fixed strings Dim Factory owns, with the scenario's values (already
//   checked against playtest.json's format) passed through JSON.stringify, never pasted as code,
// - reading what the page answers: untrusted text, size-capped, parsed and checked before use,
// - the built-in checks' verdicts (a blank canvas, a stalled loop, slow frames, a different state for the same seed, a
//   game that does not follow reduced motion).
import { z } from 'zod'
import type { GameCheck, PlaytestScenario, PlaytestSpec, PlaytestStep } from '@shared/playtest.ts'
import {
  PLAYTEST_ACTION_PATTERN,
  PLAYTEST_KEY_PATTERN,
  PLAYTEST_STATE_MAX_BYTES,
  PLAYTEST_TICK_MS,
  TEST_HOOK_VERSION,
  describeStep,
} from '@shared/playtest.ts'

// ---- keys -----------------------------------------------------------------------------------------------------------

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Control',
  ControlRight: 'Control',
  AltLeft: 'Alt',
  AltRight: 'Alt',
}

/** A KeyboardEvent.code (the playtest.json key) as the key code Electron's sendInputEvent takes; null when refused. */
export function electronKeyCode(code: string): string | null {
  if (!PLAYTEST_KEY_PATTERN.test(code)) return null
  const named = NAMED_KEYS[code]
  if (named !== undefined) return named
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter !== null) return letter[1] ?? null
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit !== null) return digit[1] ?? null
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code
  return null
}

// ---- the page's address ----------------------------------------------------------------------------------------------

/** The game's page with `?test=1&seed=N` (other query parameters kept, a fragment dropped). */
export function testUrl(url: string, seed: number): string {
  const u = new URL(url)
  u.searchParams.set('test', '1')
  u.searchParams.set('seed', String(Math.trunc(seed) >>> 0))
  u.hash = ''
  return u.href
}

export const DEFAULT_SEED = 1

/** The page with the starter's own reduced-motion flag (`?reducedMotion=1`), for when the system setting cannot be set. */
export function reducedMotionUrl(url: string): string {
  const u = new URL(url)
  u.searchParams.set('reducedMotion', '1')
  return u.href
}

export function seedOf(spec: Pick<PlaytestSpec, 'seed'>, scenario: Pick<PlaytestScenario, 'seed'>): number {
  return scenario.seed ?? spec.seed ?? DEFAULT_SEED
}

// ---- actions ---------------------------------------------------------------------------------------------------------

export type HookOp = 'press' | 'release' | 'tap' | 'seed' | 'step' | 'pause' | 'resume'

/** One thing the runner does. `step` is the scenario's step it comes from (1-based) for the report. */
export type PlayAction =
  | { t: 'key'; keyCode: string; step: number }
  | { t: 'down'; keyCode: string; step: number }
  | { t: 'up'; keyCode: string; step: number }
  | { t: 'sleep'; ms: number; step: number }
  | { t: 'ticks'; n: number; step: number }
  | { t: 'pointer'; kind: 'click' | 'tap'; fx: number; fy: number; step: number }
  | { t: 'hook'; op: HookOp; arg?: string | number; step: number }
  | { t: 'expect'; check: Extract<PlaytestStep, { expect: string }>; step: number }
  | { t: 'shot'; name: string; step: number }

/** A scenario as the runner's actions, in order. The first format's end-of-scenario `expect` object comes last. */
export function scenarioActions(s: PlaytestScenario): PlayAction[] {
  const out: PlayAction[] = []
  s.steps.forEach((st, i) => {
    const step = i + 1
    if ('key' in st) {
      out.push({ t: 'key', keyCode: electronKeyCode(st.key) ?? 'Space', step })
    } else if ('hold' in st) {
      const keyCode = electronKeyCode(st.hold) ?? 'Space'
      out.push({ t: 'down', keyCode, step })
      out.push(st.ms !== undefined ? { t: 'sleep', ms: st.ms, step } : { t: 'ticks', n: st.ticks ?? 1, step })
      out.push({ t: 'up', keyCode, step })
    } else if ('click' in st) {
      out.push({ t: 'pointer', kind: 'click', fx: st.click[0], fy: st.click[1], step })
    } else if ('tap' in st) {
      if (typeof st.tap === 'string') out.push({ t: 'hook', op: 'tap', arg: st.tap, step })
      else out.push({ t: 'pointer', kind: 'tap', fx: st.tap[0], fy: st.tap[1], step })
    } else if ('hook' in st) {
      if (st.hook === 'press' || st.hook === 'release')
        out.push({ t: 'hook', op: st.hook, arg: st.action, step })
      else if (st.hook === 'seed') out.push({ t: 'hook', op: 'seed', arg: st.seed, step })
      else if (st.hook === 'step') out.push({ t: 'hook', op: 'step', arg: st.ticks, step })
      else out.push({ t: 'hook', op: st.hook, step })
    } else if ('wait' in st) {
      out.push(
        'ms' in st.wait ? { t: 'sleep', ms: st.wait.ms, step } : { t: 'ticks', n: st.wait.ticks, step },
      )
    } else if ('expect' in st) {
      out.push({ t: 'expect', check: st, step })
    } else if ('screenshot' in st) {
      out.push({ t: 'shot', name: st.screenshot, step })
    } else if ('press' in st) {
      out.push({ t: 'hook', op: 'press', arg: st.press, step })
    } else if ('release' in st) {
      out.push({ t: 'hook', op: 'release', arg: st.release, step })
    } else {
      out.push({ t: 'hook', op: 'step', arg: st.step, step })
    }
  })
  const end = s.steps.length + 1
  for (const [path, value] of Object.entries(s.expect ?? {}))
    out.push({ t: 'expect', check: { expect: path, eq: value }, step: end })
  return out
}

/** The words for a scenario's step in the report (the first format's end checks read "the end"). */
export function stepWords(s: PlaytestScenario, step: number): string {
  const st = s.steps[step - 1]
  return st === undefined ? 'the end of the scenario' : describeStep(st)
}

/** How long to wait for `n` ticks before calling the game stalled: three times the time, plus a second. */
export function ticksTimeoutMs(n: number): number {
  return Math.ceil(n * PLAYTEST_TICK_MS * 3) + 1000
}

// ---- the scripts run in the page (fixed strings) --------------------------------------------------------------------

/** What the hook offers, as JSON text: whether it is there, its version, ready, and which members are functions. */
export const HOOK_PROBE_JS = `(() => {
  try {
    const g = window.__game
    if (g === undefined || g === null) return JSON.stringify({ present: false })
    const fns = ['actions', 'pause', 'resume', 'step', 'press', 'release', 'seed', 'state'].filter((k) => typeof g[k] === 'function')
    return JSON.stringify({ present: true, version: g.version, ready: g.ready === true, fns })
  } catch (e) {
    return JSON.stringify({ present: false, error: true })
  }
})()`

/** Whether `window.__game` is there (it must not be without ?test=1). */
export const HOOK_PRESENT_JS = `typeof window.__game !== 'undefined'`

/** The hook's state as JSON text, capped (a larger answer reads as too big; a throw as an error). */
export const STATE_JS = `(() => {
  try {
    const g = window.__game
    if (!g || typeof g.state !== 'function') return '{"__dimf":"no-hook"}'
    const text = JSON.stringify(g.state())
    if (typeof text !== 'string') return '{"__dimf":"not-json"}'
    return text.length <= ${PLAYTEST_STATE_MAX_BYTES} ? text : '{"__dimf":"too-big"}'
  } catch (e) {
    return '{"__dimf":"threw"}'
  }
})()`

/** The script for one hook call: a fixed member, its argument checked and passed through JSON.stringify. */
export function hookCallJs(op: HookOp, arg?: string | number): string {
  const call = (body: string): string =>
    `(() => { try { const g = window.__game; if (!g) return 'no-hook'; ${body}; return 'ok' } catch (e) { return 'threw' } })()`
  switch (op) {
    case 'press':
    case 'release':
    case 'tap': {
      const a = typeof arg === 'string' && PLAYTEST_ACTION_PATTERN.test(arg) ? arg : 'action'
      return call(`g.${op}(${JSON.stringify(a)})`)
    }
    case 'seed':
    case 'step': {
      const n = typeof arg === 'number' && Number.isInteger(arg) && arg >= 0 && arg <= 0xffffffff ? arg : 1
      return call(`g.${op}(${JSON.stringify(n)})`)
    }
    case 'pause':
    case 'resume':
      return call(`g.${op}()`)
  }
}

/** The largest visible canvas's box in CSS pixels, as JSON text (null: none). */
export const CANVAS_RECT_JS = `(() => {
  let best = null
  for (const c of document.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) continue
    if (best === null || r.width * r.height > best.width * best.height) best = { x: r.left, y: r.top, width: r.width, height: r.height }
  }
  return JSON.stringify(best)
})()`

/** The page's viewport, as JSON text. */
export const VIEWPORT_JS = `JSON.stringify({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })`

/** About a second of frames: rAF deltas and long tasks, as JSON text. */
export const FRAME_PROBE_JS = `new Promise((done) => {
  const deltas = []
  let long = 0
  let observer = null
  try {
    observer = new PerformanceObserver((list) => { long += list.getEntries().length })
    observer.observe({ type: 'longtask', buffered: false })
  } catch (e) {}
  let last = performance.now()
  const end = last + 1000
  const frame = (t) => {
    deltas.push(t - last)
    last = t
    if (t < end && deltas.length < 240) requestAnimationFrame(frame)
    else { if (observer) observer.disconnect(); done(JSON.stringify({ deltas, long })) }
  }
  requestAnimationFrame(frame)
  setTimeout(() => { if (observer) observer.disconnect(); done(JSON.stringify({ deltas, long })) }, 3000)
})`

// ---- reading the page's answers (untrusted) -----------------------------------------------------------------------

/** At most this much text is read from any answer of the page. */
export const ANSWER_MAX_CHARS = 64 * 1024

/** The page's answer parsed with a schema: undefined when it is not a string, too long, not JSON or the wrong shape. */
export function parseAnswer<T>(raw: unknown, schema: z.ZodType<T>, max = ANSWER_MAX_CHARS): T | undefined {
  if (typeof raw !== 'string' || raw.length > max) return undefined
  try {
    const r = schema.safeParse(JSON.parse(raw))
    return r.success ? r.data : undefined
  } catch {
    return undefined
  }
}

export const HookProbeZ = z.object({
  present: z.boolean(),
  version: z.unknown().optional(),
  ready: z.boolean().optional(),
  fns: z.array(z.string().max(20)).max(20).optional(),
  error: z.boolean().optional(),
})
export type HookProbe = z.infer<typeof HookProbeZ>

const REQUIRED_HOOK_FNS = ['pause', 'resume', 'step', 'press', 'release', 'seed', 'state'] as const

/** What is missing from the hook's contract (empty: it is complete). */
export function hookProblems(p: HookProbe | undefined): string[] {
  if (p === undefined || !p.present) return ['window.__game is not there with ?test=1']
  const out: string[] = []
  if (p.version !== TEST_HOOK_VERSION)
    out.push(`its version is ${JSON.stringify(p.version) ?? 'missing'}, not ${TEST_HOOK_VERSION}`)
  if (p.ready !== true) out.push('ready is not true')
  const fns = new Set(p.fns ?? [])
  const missing = REQUIRED_HOOK_FNS.filter((f) => !fns.has(f))
  if (missing.length > 0) out.push(`it has no ${missing.join(', ')}`)
  return out
}

/** A state answer: the state (a plain JSON object), or why there is none. */
export function parseState(
  raw: unknown,
): { ok: true; state: Record<string, unknown> } | { ok: false; why: string } {
  if (typeof raw !== 'string') return { ok: false, why: 'the page gave no state' }
  if (raw.length > PLAYTEST_STATE_MAX_BYTES + 64) return { ok: false, why: 'the state is larger than 8 KB' }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { ok: false, why: 'the state is not JSON' }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    return { ok: false, why: 'the state is not an object' }
  const marker = (v as Record<string, unknown>)['__dimf']
  if (typeof marker === 'string') {
    const why: Record<string, string> = {
      'no-hook': 'window.__game is not there',
      'not-json': 'state() did not give JSON',
      'too-big': 'state() is larger than 8 KB',
      threw: 'state() threw an error',
    }
    return { ok: false, why: why[marker] ?? 'the state could not be read' }
  }
  return { ok: true, state: v as Record<string, unknown> }
}

/** The tick count in a state (the hook adds it), or null. */
export function ticksOf(state: Record<string, unknown>): number | null {
  const t = state['ticks']
  return typeof t === 'number' && Number.isFinite(t) ? t : null
}

export const RectZ = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
})
export type Rect = z.infer<typeof RectZ>

/** A point of a box from fractions, in whole CSS pixels inside it. */
export function pointIn(rect: Rect, fx: number, fy: number): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)
  return {
    x: Math.round(clamp(rect.x + fx * rect.width, rect.x, rect.x + rect.width - 1)),
    y: Math.round(clamp(rect.y + fy * rect.height, rect.y, rect.y + rect.height - 1)),
  }
}

export const FramesZ = z.object({
  deltas: z.array(z.number().finite()).max(400),
  long: z.number().int().min(0).max(10_000),
})

// ---- the built-in checks' verdicts ---------------------------------------------------------------------------------

/** A canvas whose pixels vary less than this (luminance variance, 0 to 65025) is one flat colour: blank. */
export const BLANK_VARIANCE = 4

/** The luminance variance of a BGRA (or RGBA) bitmap; a 1-in-`stride` sample of its pixels. */
export function pixelVariance(bitmap: Uint8Array, stride = 1): number {
  const px = Math.floor(bitmap.length / 4)
  if (px === 0) return 0
  let n = 0
  let sum = 0
  let sq = 0
  const step = Math.max(1, Math.floor(stride))
  for (let i = 0; i < px; i += step) {
    const o = i * 4
    const y = 0.299 * (bitmap[o + 2] ?? 0) + 0.587 * (bitmap[o + 1] ?? 0) + 0.114 * (bitmap[o] ?? 0)
    sum += y
    sq += y * y
    n++
  }
  const mean = sum / n
  return Math.max(0, sq / n - mean * mean)
}

/** Whether two same-sized bitmaps differ anywhere (a sample of their pixels). */
export function bitmapsDiffer(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) return true
  }
  return false
}

/** The frame budget: median at most 20 ms and the 95th percentile at most 33 ms. */
export const FRAME_MEDIAN_MAX_MS = 20
export const FRAME_P95_MAX_MS = 33

export function frameStats(deltas: readonly number[]): { median: number; p95: number } | null {
  // The first delta covers the wait for the first frame: left out.
  const d = deltas
    .slice(1)
    .filter((x) => x >= 0)
    .sort((a, b) => a - b)
  if (d.length < 5) return null
  const at = (q: number): number => d[Math.min(d.length - 1, Math.floor(q * (d.length - 1)))] ?? 0
  return { median: at(0.5), p95: at(0.95) }
}

export function frameCheck(stats: { median: number; p95: number } | null, longTasks: number): GameCheck {
  if (stats === null)
    return { id: 'frames', status: 'skipped', title: 'The frame rate could not be measured' }
  const ms = (v: number): string => `${Math.round(v * 10) / 10} ms`
  const detail = `median ${ms(stats.median)}, slowest 5% ${ms(stats.p95)}, ${longTasks} long task${longTasks === 1 ? '' : 's'}`
  if (stats.median <= FRAME_MEDIAN_MAX_MS && stats.p95 <= FRAME_P95_MAX_MS)
    return { id: 'frames', status: 'pass', title: 'Frames come in time', detail }
  return { id: 'frames', status: 'warn', title: 'The game may stutter: frames come late', detail }
}

/** Two states for the same seed and steps, compared without `ticks` (how long the page ran before it was paused). */
export function sameState(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = (s: Record<string, unknown>): string => {
    const rest = { ...s }
    delete rest['ticks']
    return JSON.stringify(rest)
  }
  return strip(a) === strip(b)
}

/**
 * Reduced motion: with the system's "reduce motion" setting on (or the starter's `?reducedMotion=1` flag), the game's
 * state says `reducedMotion: true`. A state without it, or false, is a `[should]` finding: the game does not show that
 * it calms its shakes, flashes and scrolling for players who asked for less motion.
 */
export function motionCheck(state: Record<string, unknown> | null): GameCheck {
  if (state === null)
    return { id: 'motion', status: 'skipped', title: 'Reduced motion could not be checked (no state)' }
  const v = state['reducedMotion']
  if (v === true) return { id: 'motion', status: 'pass', title: 'The game follows reduced motion' }
  if (v === undefined)
    return {
      id: 'motion',
      status: 'fail',
      title: 'The game does not say whether it follows reduced motion',
      detail:
        'With prefers-reduced-motion on, state() has no reducedMotion field. The starter test hook reports it; pass reducedMotion to installTestHook.',
    }
  return {
    id: 'motion',
    status: 'fail',
    title: 'The game ignores reduced motion',
    detail: `With prefers-reduced-motion on, state() says reducedMotion is ${JSON.stringify(v) ?? 'not set'}.`,
  }
}
