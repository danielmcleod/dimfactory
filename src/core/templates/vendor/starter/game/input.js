// Keyboard, gamepad, touch buttons and pointer input, mapped to named actions like 'left' or 'action'.
// Call input.update() once per fixed step, then read isDown / pressed / released.
// Part of the Dim Factory game starter. MIT License: copy, change and share it freely.

export const DEFAULT_BINDINGS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  action: ['Space', 'Enter'],
  pause: ['KeyP', 'Escape'],
}

const DEADZONE = 0.4

/** Reads a standard-mapping gamepad and returns the set of actions it holds down. */
function padActions(pad) {
  const out = new Set()
  if (!pad) return out
  const button = (i) => pad.buttons?.[i]?.pressed === true
  const x = pad.axes?.[0] ?? 0
  const y = pad.axes?.[1] ?? 0
  if (button(14) || x < -DEADZONE) out.add('left')
  if (button(15) || x > DEADZONE) out.add('right')
  if (button(12) || y < -DEADZONE) out.add('up')
  if (button(13) || y > DEADZONE) out.add('down')
  if (button(0)) out.add('action')
  if (button(9)) out.add('pause')
  return out
}

/**
 * @param {object} [options]
 * @param {Record<string, string[]>} [options.bindings] Action name to KeyboardEvent.code list.
 * @param {EventTarget} [options.target] Where key events come from. Default window.
 * @param {boolean} [options.gamepad] Read gamepads. Default true.
 * @param {() => any[]} [options.getGamepads] Default navigator.getGamepads.
 */
export function createInput(options = {}) {
  const target = options.target ?? globalThis.window ?? null
  const useGamepad = options.gamepad ?? true
  const getGamepads =
    options.getGamepads ??
    (() =>
      typeof globalThis.navigator?.getGamepads === 'function' ? globalThis.navigator.getGamepads() : [])

  let map = {}
  const keys = new Set() // key codes held right now
  const virtual = new Set() // actions held by press() or touch buttons
  let pad = new Set() // actions held on the gamepad
  let pendingPressed = new Set()
  let pendingReleased = new Set()
  let pressedNow = new Set()
  let releasedNow = new Set()
  const pointer = { x: 0, y: 0, down: false }

  function setMap(next) {
    map = {}
    for (const [action, codes] of Object.entries(next)) map[action] = [...codes]
  }
  setMap(options.bindings ?? DEFAULT_BINDINGS)

  const isDown = (action) =>
    virtual.has(action) || pad.has(action) || (map[action] ?? []).some((code) => keys.has(code))

  /** Runs a change and records which actions went down or up because of it. */
  function change(fn) {
    const names = new Set([...Object.keys(map), ...virtual, ...pad])
    const before = new Set([...names].filter(isDown))
    fn()
    for (const name of new Set([...names, ...Object.keys(map), ...virtual, ...pad])) {
      const was = before.has(name)
      const now = isDown(name)
      if (now && !was) pendingPressed.add(name)
      if (!now && was) pendingReleased.add(name)
    }
  }

  const isBound = (code) => Object.values(map).some((codes) => codes.includes(code))

  function onKeyDown(e) {
    if (isBound(e.code)) e.preventDefault?.()
    if (e.repeat || keys.has(e.code)) return
    change(() => keys.add(e.code))
  }
  function onKeyUp(e) {
    if (isBound(e.code)) e.preventDefault?.()
    change(() => keys.delete(e.code))
  }
  function onBlur() {
    change(() => {
      keys.clear()
      virtual.clear()
      pointer.down = false
    })
  }
  function onPointer(e) {
    const rect = target?.getBoundingClientRect?.()
    pointer.x = (e.clientX ?? 0) - (rect?.left ?? 0)
    pointer.y = (e.clientY ?? 0) - (rect?.top ?? 0)
    if (e.type === 'pointerdown') pointer.down = true
    if (e.type === 'pointerup' || e.type === 'pointercancel') pointer.down = false
  }

  const listeners = [
    ['keydown', onKeyDown],
    ['keyup', onKeyUp],
    ['blur', onBlur],
    ['pointermove', onPointer],
    ['pointerdown', onPointer],
    ['pointerup', onPointer],
    ['pointercancel', onPointer],
  ]
  for (const [type, fn] of listeners) target?.addEventListener(type, fn)

  function press(action) {
    change(() => virtual.add(action))
  }
  function release(action) {
    change(() => virtual.delete(action))
  }

  return {
    isDown,
    pressed: (action) => pressedNow.has(action),
    released: (action) => releasedNow.has(action),
    /** Call once per fixed step, before reading pressed() and released(). */
    update() {
      if (useGamepad) {
        let found = null
        try {
          found = Array.from(getGamepads() ?? []).find((p) => p) ?? null
        } catch {
          found = null
        }
        change(() => {
          pad = padActions(found)
        })
      }
      pressedNow = pendingPressed
      releasedNow = pendingReleased
      pendingPressed = new Set()
      pendingReleased = new Set()
    },
    press,
    release,
    /** Gives an action new keys. Those keys are taken away from every other action. */
    rebind(action, codes) {
      change(() => {
        for (const [name, list] of Object.entries(map)) {
          if (name !== action) map[name] = list.filter((c) => !codes.includes(c))
        }
        map[action] = [...codes]
      })
    },
    bindings() {
      return Object.fromEntries(Object.entries(map).map(([a, c]) => [a, [...c]]))
    },
    setBindings(next) {
      change(() => setMap(next))
    },
    /** Makes an on-screen button hold an action. Returns a function that undoes it. */
    attachTouchButton(element, action) {
      const down = (e) => {
        e.preventDefault?.()
        press(action)
      }
      const up = () => release(action)
      const types = [
        ['pointerdown', down],
        ['pointerup', up],
        ['pointercancel', up],
        ['pointerleave', up],
      ]
      for (const [type, fn] of types) element.addEventListener(type, fn)
      return () => {
        for (const [type, fn] of types) element.removeEventListener(type, fn)
        release(action)
      }
    },
    pointer,
    destroy() {
      for (const [type, fn] of listeners) target?.removeEventListener(type, fn)
      keys.clear()
      virtual.clear()
      pad = new Set()
    },
  }
}
