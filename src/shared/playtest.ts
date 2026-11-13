// Play-testing a game without a person: the playtest.json a game project keeps (data only, never code), the built-in
// game checks, and what a play-test reports. Dim Factory plays the scenarios in its sandboxed preview with real key
// presses and reads the game's state through the test hook (`window.__game`, only with `?test=1`); nothing in the file
// is ever evaluated. A state path is a dotted path read from the state's own JSON (no property lookups beyond the
// object's own keys), and every comparison is a fixed operator.
import { z } from 'zod'

/** The file a game project keeps its scenarios in (at its root). */
export const PLAYTEST_FILE = 'playtest.json'
/** A playtest.json larger than this is refused. */
export const PLAYTEST_FILE_MAX_BYTES = 64 * 1024
/** At most this many scenarios, steps (all scenarios together) and seconds of play (waits and holds together). */
export const PLAYTEST_MAX_SCENARIOS = 12
export const PLAYTEST_MAX_STEPS = 200
export const PLAYTEST_MAX_PLAY_MS = 60_000
/** At most this many screenshots in one file. */
export const PLAYTEST_MAX_SCREENSHOTS = 12
/** The fixed step of the starter loop: 60 updates a second. */
export const PLAYTEST_HZ = 60
export const PLAYTEST_TICK_MS = 1000 / PLAYTEST_HZ
/** state() answers at most this much JSON (8 KB); a larger answer is refused. */
export const PLAYTEST_STATE_MAX_BYTES = 8 * 1024
/** The test hook's contract version. */
export const TEST_HOOK_VERSION = 1

/** The built-in Verify command that plays playtest.json (run inside Dim Factory, never as a program). */
export const PLAYTEST_COMMAND_NAME = 'Play-test (Dim Factory)'
/** Its argv: a name no program has, so it is never looked up on PATH or spawned. */
export const PLAYTEST_ARGV: readonly string[] = ['dimf:playtest', PLAYTEST_FILE]

/** Where a built-in command "resolves" (shown where a program's path would be). */
export const BUILTIN_COMMAND_PATH = 'built into Dim Factory'

/** Whether an argv is the built-in play-test (its first word, exactly). */
export function isPlaytestArgv(argv: readonly string[]): boolean {
  return argv[0] === PLAYTEST_ARGV[0]
}

// ---- keys -----------------------------------------------------------------------------------------------------------

/**
 * The keys a scenario may press, by KeyboardEvent.code (what the starter's input map binds): letters, digits, arrows,
 * Space, Enter, Escape, Tab, Backspace, Shift, Control, Alt and F1 to F12.
 */
export const PLAYTEST_KEY_PATTERN =
  /^(?:Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|Space|Enter|Escape|Tab|Backspace|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|F(?:[1-9]|1[0-2]))$/

const KeyZ = z
  .string()
  .regex(
    PLAYTEST_KEY_PATTERN,
    'Not a key Dim Factory can press (use KeyboardEvent.code, e.g. ArrowLeft, KeyA, Space)',
  )

/** An action name of the input map ('left', 'action'). */
export const PLAYTEST_ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
const ActionZ = z.string().regex(PLAYTEST_ACTION_PATTERN, 'Not an action name')

// ---- state paths ------------------------------------------------------------------------------------------------------

const PATH_SEGMENT = /^(?:[A-Za-z_$][A-Za-z0-9_$]{0,63}|\d{1,4})$/
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])
export const PLAYTEST_PATH_MAX_SEGMENTS = 8

/** Why a dotted state path is refused (null: fine). `scene`, `player.x`, `snake.0.x`. */
export function statePathProblem(path: string): string | null {
  if (path.length === 0 || path.length > 200) return 'The path is empty or too long.'
  const segs = path.split('.')
  if (segs.length > PLAYTEST_PATH_MAX_SEGMENTS)
    return `A path has at most ${PLAYTEST_PATH_MAX_SEGMENTS} parts.`
  for (const s of segs) {
    if (!PATH_SEGMENT.test(s)) return `"${s}" is not a plain name or index.`
    if (FORBIDDEN_SEGMENTS.has(s)) return `"${s}" may not be read.`
  }
  return null
}

const StatePathZ = z.string().superRefine((p, ctx) => {
  const problem = statePathProblem(p)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
})

/** What a dotted path finds in a state (a plain JSON value), by own keys only; `missing` when it is not there. */
export function readStatePath(
  state: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  if (statePathProblem(path) !== null) return { found: false }
  let at: unknown = state
  for (const seg of path.split('.')) {
    if (Array.isArray(at)) {
      if (!/^\d+$/.test(seg)) return { found: false }
      const i = Number(seg)
      if (i >= at.length) return { found: false }
      at = at[i]
    } else if (typeof at === 'object' && at !== null) {
      if (!Object.hasOwn(at, seg)) return { found: false }
      at = (at as Record<string, unknown>)[seg]
    } else return { found: false }
  }
  return { found: true, value: at }
}

// ---- steps -------------------------------------------------------------------------------------------------------------

const Fraction = z.number().min(0).max(1)
const PointZ = z.tuple([Fraction, Fraction])
const MsZ = z.number().int().min(0).max(PLAYTEST_MAX_PLAY_MS)
const TicksZ = z
  .number()
  .int()
  .min(1)
  .max(PLAYTEST_MAX_PLAY_MS / PLAYTEST_TICK_MS)
const SeedZ = z.number().int().min(0).max(0xffffffff)
const ScalarZ = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])

export const EXPECT_OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'changed'] as const
export type ExpectOp = (typeof EXPECT_OPS)[number]

const ExpectStepZ = z
  .strictObject({
    expect: StatePathZ,
    eq: ScalarZ.optional(),
    ne: ScalarZ.optional(),
    gt: z.number().finite().optional(),
    lt: z.number().finite().optional(),
    gte: z.number().finite().optional(),
    lte: z.number().finite().optional(),
    changed: z.literal(true).optional(),
  })
  .superRefine((s, ctx) => {
    const ops = EXPECT_OPS.filter((op) => s[op] !== undefined)
    if (ops.length !== 1)
      ctx.addIssue({
        code: 'custom',
        message: 'An expect step has exactly one of eq, ne, gt, lt, gte, lte, changed.',
      })
  })

export const PlaytestStepZ = z.union([
  /** Press a key and let it go. */
  z.strictObject({ key: KeyZ }),
  /** Hold a key down for a while (ms, or ticks of the 60 Hz step). */
  z
    .strictObject({ hold: KeyZ, ms: MsZ.optional(), ticks: TicksZ.optional() })
    .refine((s) => (s.ms === undefined) !== (s.ticks === undefined), 'A hold has ms or ticks (one of them).'),
  /** A mouse click or a touch tap at a point of the game (fractions of its canvas, or of the page without one). */
  z.strictObject({ click: PointZ }),
  z.strictObject({ tap: PointZ }),
  /** The test hook itself: press or release an action, restart with a seed, run ticks, pause or resume. */
  z.strictObject({ hook: z.enum(['press', 'release']), action: ActionZ }),
  z.strictObject({ hook: z.literal('seed'), seed: SeedZ }),
  z.strictObject({ hook: z.literal('step'), ticks: TicksZ }),
  z.strictObject({ hook: z.enum(['pause', 'resume']) }),
  /** Wait a while (ms), or until the game ran so many ticks. */
  z.strictObject({ wait: z.union([z.strictObject({ ms: MsZ }), z.strictObject({ ticks: TicksZ })]) }),
  /** Check one value of the state. */
  ExpectStepZ,
  /** Keep a picture of the game now (for the visual review and the record). */
  z.strictObject({ screenshot: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'A short lower-case name') }),
  // The first file format's shorthands (docs/game-test-hook.md before the step list grew): hook press, release, a
  // quick press-step-release of an action, and run ticks.
  z.strictObject({ press: ActionZ }),
  z.strictObject({ release: ActionZ }),
  z.strictObject({ tap: ActionZ }),
  z.strictObject({ step: TicksZ }),
])
export type PlaytestStep = z.infer<typeof PlaytestStepZ>

/** The phone-size viewport (CSS pixels): the preview window's Phone size and a phone scenario of a play-test. */
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const

/** Where a scenario is played: a desktop window (the default), or a phone-size one with touch input. */
export const PLAYTEST_VIEWPORTS = ['desktop', 'phone'] as const
export type PlaytestViewport = (typeof PLAYTEST_VIEWPORTS)[number]

export const PlaytestScenarioZ = z.strictObject({
  name: z.string().trim().min(1).max(120),
  /** A must scenario decides Verify (a failure is a failing check); others are reported only. Default true. */
  must: z.boolean().optional(),
  /** The seed the game starts with (`?seed=`); default the file's, else 1. */
  seed: SeedZ.optional(),
  /**
   * `phone`: played at phone size (390 by 844) with touch input, so a `tap` step is a real touch. Default `desktop`.
   */
  viewport: z.enum(PLAYTEST_VIEWPORTS).optional(),
  /** Played with the system's "reduce motion" setting on (prefers-reduced-motion: reduce). */
  reducedMotion: z.boolean().optional(),
  steps: z.array(PlaytestStepZ).max(PLAYTEST_MAX_STEPS),
  /** The first format's end-of-scenario checks: each field of the state equals its value. */
  expect: z.record(StatePathZ, ScalarZ).optional(),
})
export type PlaytestScenario = z.infer<typeof PlaytestScenarioZ>

/** How long a step plays (waits and holds; ticks at 60 Hz). */
export function stepPlayMs(s: PlaytestStep): number {
  if ('hold' in s) return s.ms ?? (s.ticks ?? 0) * PLAYTEST_TICK_MS
  if ('wait' in s) return 'ms' in s.wait ? s.wait.ms : s.wait.ticks * PLAYTEST_TICK_MS
  return 0
}

export const PlaytestSpecZ = z
  .strictObject({
    $schema: z.string().max(2048).optional(),
    version: z.literal(1),
    seed: SeedZ.optional(),
    scenarios: z.array(PlaytestScenarioZ).min(1).max(PLAYTEST_MAX_SCENARIOS),
  })
  .superRefine((spec, ctx) => {
    const steps = spec.scenarios.reduce((n, s) => n + s.steps.length, 0)
    if (steps > PLAYTEST_MAX_STEPS)
      ctx.addIssue({
        code: 'custom',
        message: `At most ${PLAYTEST_MAX_STEPS} steps in all (this file has ${steps}).`,
      })
    const ms = spec.scenarios.reduce((n, s) => n + s.steps.reduce((m, st) => m + stepPlayMs(st), 0), 0)
    if (ms > PLAYTEST_MAX_PLAY_MS)
      ctx.addIssue({
        code: 'custom',
        message: `At most ${PLAYTEST_MAX_PLAY_MS / 1000} seconds of waits and holds in all (this file has ${Math.ceil(ms / 1000)}).`,
      })
    const shots = spec.scenarios.reduce((n, s) => n + s.steps.filter((st) => 'screenshot' in st).length, 0)
    if (shots > PLAYTEST_MAX_SCREENSHOTS)
      ctx.addIssue({ code: 'custom', message: `At most ${PLAYTEST_MAX_SCREENSHOTS} screenshots in all.` })
    const names = new Set<string>()
    spec.scenarios.forEach((s, i) => {
      const k = s.name.toLowerCase()
      if (names.has(k))
        ctx.addIssue({
          code: 'custom',
          path: ['scenarios', i, 'name'],
          message: `"${s.name}" is there twice.`,
        })
      names.add(k)
    })
  })
export type PlaytestSpec = z.infer<typeof PlaytestSpecZ>

/** A parsed playtest.json, or why it is refused (plain words, the first problems). */
export type PlaytestParse = { ok: true; spec: PlaytestSpec } | { ok: false; error: string }

export function parsePlaytestText(text: string): PlaytestParse {
  if (new TextEncoder().encode(text).length > PLAYTEST_FILE_MAX_BYTES)
    return { ok: false, error: `playtest.json is larger than ${PLAYTEST_FILE_MAX_BYTES / 1024} KB.` }
  let json: unknown
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (err) {
    return { ok: false, error: `playtest.json is not valid JSON: ${(err as Error).message}` }
  }
  const r = PlaytestSpecZ.safeParse(json)
  if (r.success) return { ok: true, spec: r.data }
  const issues = r.error.issues
    .slice(0, 3)
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
  return { ok: false, error: `playtest.json does not fit its format: ${issues.join('; ')}` }
}

/** Whether a scenario decides Verify (`must`, default true). */
export const isMustScenario = (s: Pick<PlaytestScenario, 'must'>): boolean => s.must !== false

/** A step in plain words (the report and the log). */
export function describeStep(s: PlaytestStep): string {
  if ('key' in s) return `press ${s.key}`
  if ('hold' in s) return `hold ${s.hold} for ${s.ms !== undefined ? `${s.ms} ms` : `${s.ticks} ticks`}`
  if ('click' in s) return `click at ${s.click[0]}, ${s.click[1]}`
  if ('tap' in s) return typeof s.tap === 'string' ? `tap ${s.tap}` : `tap at ${s.tap[0]}, ${s.tap[1]}`
  if ('hook' in s) {
    switch (s.hook) {
      case 'press':
      case 'release':
        return `${s.hook} ${s.action}`
      case 'seed':
        return `restart with seed ${s.seed}`
      case 'step':
        return `run ${s.ticks} ticks`
      case 'pause':
      case 'resume':
        return s.hook
    }
  }
  if ('wait' in s) return 'ms' in s.wait ? `wait ${s.wait.ms} ms` : `wait ${s.wait.ticks} ticks`
  if ('expect' in s) {
    const op = EXPECT_OPS.find((o) => s[o] !== undefined) ?? 'eq'
    return op === 'changed' ? `${s.expect} changed` : `${s.expect} ${op} ${JSON.stringify(s[op])}`
  }
  if ('screenshot' in s) return `screenshot ${s.screenshot}`
  if ('press' in s) return `press ${s.press}`
  if ('release' in s) return `release ${s.release}`
  return `run ${s.step} ticks`
}

/**
 * One expect step against the state: null when it holds, else what was wrong (plain words). `initial` is the value
 * the path had when the scenario started (for `changed`).
 */
export function checkExpect(
  s: Extract<PlaytestStep, { expect: string }>,
  state: unknown,
  initial: { found: true; value: unknown } | { found: false },
): string | null {
  const got = readStatePath(state, s.expect)
  if (!got.found) return `the state has no ${s.expect}`
  const v = got.value
  const shown = JSON.stringify(v) ?? 'nothing'
  if (s.changed === true) {
    if (initial.found && JSON.stringify(initial.value) === JSON.stringify(v))
      return `expected ${s.expect} to change, it is still ${shown}`
    return null
  }
  if (s.eq !== undefined)
    return JSON.stringify(v) === JSON.stringify(s.eq)
      ? null
      : `expected ${s.expect} to be ${JSON.stringify(s.eq)}, got ${shown}`
  if (s.ne !== undefined)
    return JSON.stringify(v) !== JSON.stringify(s.ne) ? null : `expected ${s.expect} not to be ${shown}`
  if (typeof v !== 'number' || !Number.isFinite(v)) return `expected ${s.expect} to be a number, got ${shown}`
  const cmp: [ExpectOp, number | undefined, (a: number, b: number) => boolean, string][] = [
    ['gt', s.gt, (a, b) => a > b, 'above'],
    ['lt', s.lt, (a, b) => a < b, 'below'],
    ['gte', s.gte, (a, b) => a >= b, 'at least'],
    ['lte', s.lte, (a, b) => a <= b, 'at most'],
  ]
  for (const [, want, ok, words] of cmp) {
    if (want === undefined) continue
    return ok(v, want) ? null : `expected ${s.expect} to be ${words} ${want}, got ${shown}`
  }
  return 'the expect step has no comparison'
}

// ---- results ---------------------------------------------------------------------------------------------------------

/** How long a whole play-test may take: its play time, plus each scenario's page load. */
export const PLAYTEST_LOAD_TIMEOUT_MS = 15_000
export const PLAYTEST_TIMEOUT_MS = PLAYTEST_MAX_PLAY_MS + 60_000

export const SCENARIO_STATUSES = ['pass', 'fail', 'error'] as const
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number]

export interface PlaytestScenarioResult {
  name: string
  must: boolean
  /** `error`: it could not be played (the page did not load, the hook is missing, it ran out of time). */
  status: ScenarioStatus
  durationMs: number
  /** The step that failed (1-based) and why, in words. */
  failure?: { step: number; what: string; message: string }
  /** The screenshots it kept (file names next to the report). */
  screenshots: string[]
}

/** The built-in game checks (they run with or without a playtest.json). */
export const GAME_CHECK_IDS = [
  'errors',
  'hook',
  'canvas',
  'loop',
  'frames',
  'determinism',
  'pause',
  'offline',
  'motion',
  'names',
] as const
export type GameCheckId = (typeof GAME_CHECK_IDS)[number]

/**
 * `fail` becomes a `[should]` finding of the preview check; `warn` is said (a stutter) but never a finding; `skipped`
 * could not be checked (no canvas, no hook).
 */
export type GameCheckStatus = 'pass' | 'warn' | 'fail' | 'skipped'

export interface GameCheck {
  id: GameCheckId
  status: GameCheckStatus
  /** One line: what was checked, or what is wrong. */
  title: string
  detail?: string
}

/** What main measured (numbers for the record). */
export interface GameMeasures {
  /** rAF frame times over about a second, ms. */
  frameMedianMs?: number
  frameP95Ms?: number
  longTasks?: number
  /** Pixel variance inside the canvas (0: one flat colour). */
  canvasVariance?: number
}

/** A request to another computer that a game preview blocked (loopback-only network). */
export interface BlockedRequest {
  url: string
  host: string
}

/** What a play-test (or the game checks alone) saw. */
export interface PlaytestReport {
  url: string
  loaded: boolean
  /** The page had a working test hook with ?test=1. */
  hook: boolean
  scenarios: PlaytestScenarioResult[]
  checks: GameCheck[]
  measures: GameMeasures
  consoleErrors: { message: string; source?: string; line?: number }[]
  failedLoads: { url: string; error: string }[]
  blocked: BlockedRequest[]
  durationMs: number
  /** The play-test could not run at all. */
  error?: string
}

/** Must scenarios that did not pass. */
export function failedMustScenarios(r: Pick<PlaytestReport, 'scenarios'>): PlaytestScenarioResult[] {
  return r.scenarios.filter((s) => s.must && s.status !== 'pass')
}

/** The per-scenario lines a verify result carries (titles as passed or failed, for the record and Acceptance). */
export interface VerifyScenarioLine {
  name: string
  must: boolean
  status: ScenarioStatus
  message?: string
}

/** A game preview's network: only this computer (the default for a game), or the internet too. */
export const PREVIEW_NETWORK_MODES = ['loopback', 'internet'] as const
export type PreviewNetworkMode = (typeof PREVIEW_NETWORK_MODES)[number]
