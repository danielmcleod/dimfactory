// A fixed-timestep game loop: update() always gets the same small dt, render() draws as often as the screen allows.
// It pauses by itself when the window loses focus, and never resumes by itself.
// Part of the Dim Factory game starter. MIT License: copy, change and share it freely.

/**
 * @param {object} options
 * @param {(dtSeconds: number) => void} options.update Game logic. Called with 1/hz each time.
 * @param {(alpha: number) => void} options.render Draw the game. alpha is 0 to 1 (how far into the next step we are).
 * @param {number} [options.hz] Updates per second. Default 60.
 * @param {number} [options.maxFrameMs] Longest time one frame may count. Default 250.
 * @param {() => number} [options.now] Clock in milliseconds. Default performance.now.
 * @param {(cb: () => void) => any} [options.requestFrame] Default requestAnimationFrame.
 * @param {(handle: any) => void} [options.cancelFrame] Default cancelAnimationFrame.
 * @param {EventTarget} [options.target] Where blur events come from. Default window.
 * @param {() => boolean} [options.isHidden] True when the tab is hidden. Default document.hidden.
 * @param {() => void} [options.onPause]
 * @param {() => void} [options.onResume]
 */
export function createLoop(options) {
  const { update, render, hz = 60, maxFrameMs = 250, onPause, onResume } = options
  const now = options.now ?? (() => globalThis.performance.now())
  const requestFrame = options.requestFrame ?? ((cb) => globalThis.requestAnimationFrame(cb))
  const cancelFrame = options.cancelFrame ?? ((h) => globalThis.cancelAnimationFrame(h))
  const isHidden = options.isHidden ?? (() => globalThis.document?.hidden === true)
  const stepMs = 1000 / hz

  let running = false
  let paused = false
  let ticks = 0
  let last = 0
  let accumulator = 0
  let handle = null
  let listenTarget = null

  function runUpdate() {
    update(stepMs / 1000)
    ticks++
  }

  function frame() {
    if (!running) return
    const t = now()
    const elapsed = Math.min(Math.max(t - last, 0), maxFrameMs)
    last = t
    if (!paused) {
      accumulator += elapsed
      while (accumulator >= stepMs) {
        runUpdate()
        accumulator -= stepMs
      }
    }
    render(accumulator / stepMs)
    handle = requestFrame(frame)
  }

  function onBlur() {
    pause()
  }
  function onVisibility() {
    if (isHidden()) pause()
  }

  function pause() {
    if (paused) return
    paused = true
    onPause?.()
  }

  function resume() {
    if (!paused) return
    paused = false
    last = now()
    onResume?.()
  }

  function start() {
    if (running) return
    running = true
    last = now()
    accumulator = 0
    listenTarget = options.target ?? globalThis.window ?? null
    listenTarget?.addEventListener('blur', onBlur)
    listenTarget?.addEventListener('visibilitychange', onVisibility)
    handle = requestFrame(frame)
  }

  function stop() {
    if (!running) return
    running = false
    if (handle !== null) cancelFrame(handle)
    handle = null
    listenTarget?.removeEventListener('blur', onBlur)
    listenTarget?.removeEventListener('visibilitychange', onVisibility)
    listenTarget = null
  }

  /** Runs exactly n updates and one render right now, even while paused. For tests and the test hook. */
  function stepOnce(n = 1) {
    for (let i = 0; i < n; i++) runUpdate()
    render(0)
  }

  return {
    start,
    stop,
    pause,
    resume,
    stepOnce,
    get running() {
      return running
    },
    get paused() {
      return paused
    },
    get ticks() {
      return ticks
    },
  }
}
