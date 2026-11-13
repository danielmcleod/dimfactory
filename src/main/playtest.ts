// Playing a game in the hidden play-test window (main/preview.ts makes the window: sandboxed, its own in-memory
// partition, confined to the game's loopback origin, muted, no permissions, no internet, rendered off screen at 60
// frames a second with background throttling off so its loop runs as on a screen). Input is real: key presses, clicks
// and taps go in through webContents.sendInputEvent, as the OS would deliver them; a phone scenario's taps are touches
// (main's emulator: phone size with touch emulation, over the DevTools protocol of this window only), and reduced
// motion is the system setting emulated the same way. The page is read only through the
// fixed scripts of playtest-model.ts, each with a time limit, and every answer is treated as untrusted (size-capped,
// parsed, checked). Nothing of playtest.json is ever run as code.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { GameCheck, GameMeasures, PlaytestScenarioResult, PlaytestSpec } from '@shared/playtest.ts'
import { PLAYTEST_LOAD_TIMEOUT_MS, checkExpect, isMustScenario, readStatePath } from '@shared/playtest.ts'
import {
  BLANK_VARIANCE,
  CANVAS_RECT_JS,
  FRAME_PROBE_JS,
  FramesZ,
  HOOK_PRESENT_JS,
  HOOK_PROBE_JS,
  HookProbeZ,
  RectZ,
  STATE_JS,
  VIEWPORT_JS,
  bitmapsDiffer,
  frameCheck,
  frameStats,
  hookCallJs,
  hookProblems,
  motionCheck,
  parseAnswer,
  parseState,
  pixelVariance,
  pointIn,
  reducedMotionUrl,
  sameState,
  scenarioActions,
  seedOf,
  stepWords,
  testUrl,
  ticksOf,
  ticksTimeoutMs,
} from './playtest-model.ts'
import type { HookOp, Rect } from './playtest-model.ts'

/** How long one script in the page may take before its answer is given up on. */
export const SCRIPT_TIMEOUT_MS = 5000
/** How long a page may take to show its test hook after it loaded. */
export const HOOK_WAIT_MS = 5000
/** How long the page settles after it loaded before anything is checked. */
export const SETTLE_MS = 400

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class Aborted extends Error {}

/**
 * What main can change about the hidden window (main/preview.ts, over the DevTools protocol of that window only): phone
 * size with touch input, the system's reduced-motion setting, and a real touch tap. Each answers whether it worked.
 */
export interface PageEmulator {
  viewport(phone: boolean): Promise<boolean>
  reducedMotion(on: boolean): Promise<boolean>
  tap(x: number, y: number): Promise<boolean>
}

/** The page of one hidden window, driven by fixed scripts and real input (see the header). */
export class GameDriver {
  readonly #wc: WebContents
  readonly #signal: AbortSignal | undefined
  readonly #clear: () => Promise<void>
  readonly #emulator: PageEmulator | undefined
  #phone = false

  constructor(
    wc: WebContents,
    o: { signal?: AbortSignal; clearStorage: () => Promise<void>; emulator?: PageEmulator },
  ) {
    this.#wc = wc
    this.#signal = o.signal
    this.#clear = o.clearStorage
    this.#emulator = o.emulator
  }

  /** Whether the system settings can be emulated here (phone size, reduced motion). */
  get canEmulate(): boolean {
    return this.#emulator !== undefined
  }

  /** Phone size with touch input (true), or the desktop window again; false when it could not be set. */
  async setPhone(phone: boolean): Promise<boolean> {
    this.#check()
    if (this.#emulator === undefined) return !phone
    const ok = await this.#emulator.viewport(phone).catch(() => false)
    this.#phone = phone && ok
    return ok
  }

  /** The system's reduced-motion setting on or off; false when it could not be set. */
  async setReducedMotion(on: boolean): Promise<boolean> {
    this.#check()
    if (this.#emulator === undefined) return !on
    return this.#emulator.reducedMotion(on).catch(() => false)
  }

  #check(): void {
    if (this.#signal?.aborted === true || this.#wc.isDestroyed()) throw new Aborted('stopped')
  }

  async sleep(ms: number): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      this.#check()
      await sleep(Math.min(100, end - Date.now()))
    }
    this.#check()
  }

  /** A fixed script's answer within SCRIPT_TIMEOUT_MS (undefined: none, a throw, or too slow). */
  async run(js: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<unknown> {
    this.#check()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.#wc.executeJavaScript(js, false).catch(() => undefined),
        new Promise<undefined>((r) => {
          timer = setTimeout(() => r(undefined), timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Load a page from clean storage; true once its document loaded. */
  async load(url: string): Promise<boolean> {
    this.#check()
    await this.#clear().catch(() => undefined)
    const wc = this.#wc
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => done(false), PLAYTEST_LOAD_TIMEOUT_MS)
      const onLoad = (): void => done(true)
      const onFail = (_e: unknown, code: number, _d: string, _u: string, isMainFrame: boolean): void => {
        if (isMainFrame && code !== -3) done(false)
      }
      function done(v: boolean): void {
        clearTimeout(timer)
        wc.removeListener('did-finish-load', onLoad)
        wc.removeListener('did-fail-load', onFail)
        resolve(v)
      }
      wc.once('did-finish-load', onLoad)
      wc.on('did-fail-load', onFail)
      wc.loadURL(url).catch(() => undefined)
    })
    if (ok) await this.sleep(SETTLE_MS)
    return ok
  }

  async state(): Promise<ReturnType<typeof parseState>> {
    return parseState(await this.run(STATE_JS))
  }

  /** The hook's state once it is there (polled up to HOOK_WAIT_MS), or why it never came. */
  async waitForHook(): Promise<ReturnType<typeof parseState>> {
    const end = Date.now() + HOOK_WAIT_MS
    let last = await this.state()
    while (!last.ok && Date.now() < end) {
      await this.sleep(100)
      last = await this.state()
    }
    return last
  }

  async hook(op: HookOp, arg?: string | number): Promise<boolean> {
    return (await this.run(hookCallJs(op, arg))) === 'ok'
  }

  key(type: 'keyDown' | 'keyUp', keyCode: string): void {
    this.#check()
    this.#wc.sendInputEvent({ type, keyCode })
  }

  async press(keyCode: string): Promise<void> {
    this.key('keyDown', keyCode)
    await this.sleep(50)
    this.key('keyUp', keyCode)
    await this.sleep(50)
  }

  /** The largest canvas's box, else the viewport. */
  async target(): Promise<{ rect: Rect; canvas: boolean } | null> {
    const canvas = parseAnswer(await this.run(CANVAS_RECT_JS), RectZ.nullable())
    if (canvas !== undefined && canvas !== null) return { rect: canvas, canvas: true }
    const view = parseAnswer(await this.run(VIEWPORT_JS), RectZ)
    return view === undefined ? null : { rect: view, canvas: false }
  }

  /** A click (or, at phone size, a tap: a real touch) at a point of the game's canvas, or of the page without one. */
  async pointer(fx: number, fy: number, kind: 'click' | 'tap' = 'click'): Promise<void> {
    const t = await this.target()
    if (t === null) throw new Error('the page has no area to click')
    const { x, y } = pointIn(t.rect, fx, fy)
    this.#check()
    if (kind === 'tap' && this.#phone && this.#emulator !== undefined) {
      if (!(await this.#emulator.tap(x, y).catch(() => false))) throw new Error('the tap could not be made')
      await this.sleep(50)
      return
    }
    this.#wc.sendInputEvent({ type: 'mouseMove', x, y })
    this.#wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await this.sleep(50)
    this.#wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await this.sleep(50)
  }

  /** Wait until the game ran `n` more ticks; false when it did not (stalled or paused). */
  async ticks(n: number): Promise<boolean> {
    const first = await this.state()
    const from = first.ok ? ticksOf(first.state) : null
    if (from === null) {
      await this.sleep(Math.ceil((n * 1000) / 60))
      return true
    }
    const end = Date.now() + ticksTimeoutMs(n)
    while (Date.now() < end) {
      await this.sleep(16)
      const s = await this.state()
      const t = s.ok ? ticksOf(s.state) : null
      if (t !== null && t - from >= n) return true
    }
    return false
  }

  /** A picture of a box of the page (or the whole page) as PNG, and its bitmap. */
  async capture(rect?: Rect): Promise<{ png: Buffer; bitmap: Buffer } | null> {
    this.#check()
    const r =
      rect === undefined
        ? undefined
        : {
            x: Math.max(0, Math.floor(rect.x)),
            y: Math.max(0, Math.floor(rect.y)),
            width: Math.max(1, Math.floor(rect.width)),
            height: Math.max(1, Math.floor(rect.height)),
          }
    const image = await (r === undefined ? this.#wc.capturePage() : this.#wc.capturePage(r)).catch(() => null)
    if (image === null || image.isEmpty()) return null
    return { png: image.toPNG(), bitmap: image.toBitmap() }
  }
}

export const isAborted = (err: unknown): boolean => err instanceof Aborted

// ---- the built-in game checks ----------------------------------------------------------------------------------------

export interface GameCheckRun {
  checks: GameCheck[]
  measures: GameMeasures
  hook: boolean
  /** A picture of the game being played (the action pressed, a moment of play), for the visual review. */
  gameplayPng: Buffer | null
  /** A picture of the title screen (the plain page). */
  titlePng: Buffer | null
}

/**
 * The checks every game gets, with or without a playtest.json: the hook only with ?test=1 and complete, the canvas not
 * blank, the loop running, the frame budget, the same seed giving the same state, pause stopping the game. Console
 * errors, failed loads and blocked requests are the caller's (it watches the whole window).
 */
export async function runGameChecks(d: GameDriver, url: string): Promise<GameCheckRun> {
  const checks: GameCheck[] = []
  const measures: GameMeasures = {}
  // The plain page: no hook without ?test=1, and the title screen's picture.
  let titlePng: Buffer | null = null
  let hookWithoutTest = false
  if (await d.load(url)) {
    hookWithoutTest = (await d.run(HOOK_PRESENT_JS)) === true
    titlePng = (await d.capture())?.png ?? null
  }

  const loaded = await d.load(testUrl(url, 1))
  if (!loaded) {
    checks.push({ id: 'hook', status: 'skipped', title: 'The game page did not load with ?test=1' })
    return { checks, measures, hook: false, gameplayPng: null, titlePng }
  }
  const probe = parseAnswer(await d.run(HOOK_PROBE_JS), HookProbeZ)
  const problems = hookProblems(probe)
  if (hookWithoutTest) problems.unshift('window.__game is there without ?test=1 (players would see it)')
  const hook = probe?.present === true && hookProblems(probe).length === 0
  checks.push(
    problems.length === 0
      ? { id: 'hook', status: 'pass', title: 'The test hook is there with ?test=1 only' }
      : {
          id: 'hook',
          status: 'fail',
          title: 'The test hook does not follow its contract',
          detail: problems.join('; '),
        },
  )

  // The canvas is not one flat colour.
  const target = await d.target()
  if (target === null || !target.canvas) {
    checks.push({ id: 'canvas', status: 'skipped', title: 'No canvas (a page of HTML elements)' })
  } else {
    const shot = await d.capture(target.rect)
    const variance = shot === null ? 0 : pixelVariance(shot.bitmap, 7)
    measures.canvasVariance = Math.round(variance * 10) / 10
    checks.push(
      variance >= BLANK_VARIANCE
        ? { id: 'canvas', status: 'pass', title: 'The canvas shows something' }
        : {
            id: 'canvas',
            status: 'fail',
            title: 'The canvas is blank: it shows one flat colour',
            detail: 'Nothing is drawn on the game canvas after it loaded.',
          },
    )
  }

  // The loop runs: the hook's ticks go up, or (without a hook) two pictures differ.
  if (hook) {
    const a = await d.state()
    await d.sleep(500)
    const b = await d.state()
    const ta = a.ok ? ticksOf(a.state) : null
    const tb = b.ok ? ticksOf(b.state) : null
    const ran = ta !== null && tb !== null && tb - ta >= 5
    checks.push(
      ran
        ? { id: 'loop', status: 'pass', title: 'The game loop runs' }
        : {
            id: 'loop',
            status: 'fail',
            title: 'The game loop does not run',
            detail: `ticks went from ${ta ?? '?'} to ${tb ?? '?'} in half a second`,
          },
    )
  } else {
    const a = await d.capture()
    await d.sleep(500)
    const b = await d.capture()
    const moved = a !== null && b !== null && bitmapsDiffer(a.bitmap, b.bitmap)
    checks.push(
      moved
        ? { id: 'loop', status: 'pass', title: 'Something on the page moves' }
        : {
            id: 'loop',
            status: 'skipped',
            title: 'Nothing moved in half a second, and there is no test hook to ask',
          },
    )
  }

  // The frame budget.
  const frames = parseAnswer(await d.run(FRAME_PROBE_JS, 4000), FramesZ)
  const stats = frames === undefined ? null : frameStats(frames.deltas)
  if (stats !== null) {
    measures.frameMedianMs = Math.round(stats.median * 10) / 10
    measures.frameP95Ms = Math.round(stats.p95 * 10) / 10
  }
  if (frames !== undefined) measures.longTasks = frames.long
  checks.push(frameCheck(stats, frames?.long ?? 0))

  if (!hook) {
    checks.push({ id: 'pause', status: 'skipped', title: 'Pause could not be checked without the test hook' })
    checks.push({
      id: 'determinism',
      status: 'skipped',
      title: 'The seed could not be checked without the test hook',
    })
    checks.push({
      id: 'motion',
      status: 'skipped',
      title: 'Reduced motion could not be checked without the test hook',
    })
    return { checks, measures, hook, gameplayPng: null, titlePng }
  }

  // Pause stops the game.
  await d.hook('resume')
  await d.sleep(200)
  await d.hook('pause')
  const p1 = await d.state()
  await d.sleep(400)
  const p2 = await d.state()
  const t1 = p1.ok ? ticksOf(p1.state) : null
  const t2 = p2.ok ? ticksOf(p2.state) : null
  const pausedFlag = p2.ok ? p2.state['paused'] : undefined
  checks.push(
    t1 !== null && t1 === t2 && pausedFlag !== false
      ? { id: 'pause', status: 'pass', title: 'Pausing stops the game' }
      : {
          id: 'pause',
          status: 'fail',
          title: 'Pausing does not stop the game',
          detail: `ticks went from ${t1 ?? '?'} to ${t2 ?? '?'} while paused`,
        },
  )

  // The same seed gives the same state.
  const play = async (): Promise<Record<string, unknown> | null> => {
    if (!(await d.load(testUrl(url, 7)))) return null
    if (!(await d.waitForHook()).ok) return null
    await d.hook('pause')
    await d.hook('seed', 7)
    await d.hook('step', 120)
    const s = await d.state()
    return s.ok ? s.state : null
  }
  const a = await play()
  const b = await play()
  checks.push(
    a === null || b === null
      ? { id: 'determinism', status: 'skipped', title: 'The seed could not be checked (no state)' }
      : sameState(a, b)
        ? { id: 'determinism', status: 'pass', title: 'The same seed gives the same game' }
        : {
            id: 'determinism',
            status: 'fail',
            title: 'The same seed does not give the same game',
            detail: 'Two games started with seed 7 and run 120 ticks ended in different states.',
          },
  )

  checks.push(await checkReducedMotion(d, url))

  // A moment of play for the visual review: the action pressed, then a little play.
  let gameplayPng: Buffer | null = null
  if (await d.load(testUrl(url, 1))) {
    if ((await d.waitForHook()).ok) {
      await d.hook('tap', 'action')
      await d.hook('resume')
      await d.sleep(700)
      gameplayPng = (await d.capture())?.png ?? null
    }
  }
  return { checks, measures, hook, gameplayPng, titlePng }
}

/**
 * Reduced motion: the game opened with the system's "reduce motion" setting on (emulated in this window; without an
 * emulator, the starter's `?reducedMotion=1` flag) reports `reducedMotion: true` in its state. The setting is turned
 * off again afterwards.
 */
export async function checkReducedMotion(d: GameDriver, url: string): Promise<GameCheck> {
  const emulated = d.canEmulate && (await d.setReducedMotion(true))
  try {
    const page = emulated ? testUrl(url, 1) : reducedMotionUrl(testUrl(url, 1))
    if (!(await d.load(page))) return motionCheck(null)
    const s = await d.waitForHook()
    return motionCheck(s.ok ? s.state : null)
  } finally {
    if (emulated) await d.setReducedMotion(false)
  }
}

// ---- scenarios -----------------------------------------------------------------------------------------------------

/** Play every scenario of a playtest.json, each from a fresh page (see the header). Screenshots go to `shotsDir`. */
export async function runScenarios(
  d: GameDriver,
  url: string,
  spec: PlaytestSpec,
  shotsDir: string | null,
): Promise<PlaytestScenarioResult[]> {
  const out: PlaytestScenarioResult[] = []
  for (const [i, s] of spec.scenarios.entries()) {
    const started = Date.now()
    const must = isMustScenario(s)
    const screenshots: string[] = []
    const result = (
      status: PlaytestScenarioResult['status'],
      failure?: PlaytestScenarioResult['failure'],
    ): PlaytestScenarioResult => ({
      name: s.name,
      must,
      status,
      durationMs: Date.now() - started,
      ...(failure !== undefined ? { failure } : {}),
      screenshots,
    })
    const phone = s.viewport === 'phone'
    const calm = s.reducedMotion === true
    let emulated = { phone: false, calm: false }
    try {
      if (phone) {
        if (!(await d.setPhone(true))) {
          out.push(
            result('error', {
              step: 0,
              what: 'open the game at phone size',
              message: d.canEmulate
                ? 'phone size could not be set'
                : 'phone size needs the Dim Factory app, which plays the game in its preview',
            }),
          )
          continue
        }
        emulated = { ...emulated, phone: true }
      }
      if (calm && d.canEmulate) emulated = { ...emulated, calm: await d.setReducedMotion(true) }
      const page = testUrl(url, seedOf(spec, s))
      if (!(await d.load(calm && !emulated.calm ? reducedMotionUrl(page) : page))) {
        out.push(result('error', { step: 0, what: 'open the game', message: 'the page did not load' }))
        continue
      }
      const first = await d.waitForHook()
      if (!first.ok) {
        out.push(result('error', { step: 0, what: 'open the game', message: first.why }))
        continue
      }
      const initial = first.state
      let failed: PlaytestScenarioResult | null = null
      for (const a of scenarioActions(s)) {
        const what = stepWords(s, a.step)
        const fail = (message: string): PlaytestScenarioResult =>
          result('fail', { step: a.step, what, message })
        if (a.t === 'key') await d.press(a.keyCode)
        else if (a.t === 'down') d.key('keyDown', a.keyCode)
        else if (a.t === 'up') {
          d.key('keyUp', a.keyCode)
          await d.sleep(50)
        } else if (a.t === 'sleep') await d.sleep(a.ms)
        else if (a.t === 'ticks') {
          if (!(await d.ticks(a.n))) failed = fail(`the game did not run ${a.n} ticks (is it paused?)`)
        } else if (a.t === 'pointer') await d.pointer(a.fx, a.fy, a.kind)
        else if (a.t === 'hook') {
          if (!(await d.hook(a.op, a.arg))) failed = fail(`the test hook's ${a.op} did not work`)
        } else if (a.t === 'expect') {
          const now = await d.state()
          if (!now.ok) failed = fail(now.why)
          else {
            const why = checkExpect(a.check, now.state, readStatePath(initial, a.check.expect))
            if (why !== null) failed = fail(why)
          }
        } else if (a.t === 'shot' && shotsDir !== null) {
          const shot = await d.capture()
          if (shot !== null) {
            const file = `playtest-${i + 1}-${a.name}.png`
            await mkdir(shotsDir, { recursive: true })
            await writeFile(join(shotsDir, file), shot.png)
            screenshots.push(file)
          }
        }
        if (failed !== null) break
      }
      out.push(failed ?? result('pass'))
    } catch (err) {
      if (isAborted(err)) {
        out.push(
          result('error', { step: 0, what: 'play', message: 'the play-test was stopped or ran out of time' }),
        )
        // The rest are not played.
        for (const rest of spec.scenarios.slice(i + 1))
          out.push({
            name: rest.name,
            must: isMustScenario(rest),
            status: 'error',
            durationMs: 0,
            failure: {
              step: 0,
              what: 'play',
              message: 'not played: the play-test was stopped or ran out of time',
            },
            screenshots: [],
          })
        break
      }
      out.push(
        result('error', { step: 0, what: 'play', message: err instanceof Error ? err.message : String(err) }),
      )
    } finally {
      // The next scenario starts from the desktop window and the page's own motion setting.
      if (emulated.phone) await d.setPhone(false).catch(() => false)
      if (emulated.calm) await d.setReducedMotion(false).catch(() => false)
    }
  }
  return out
}
