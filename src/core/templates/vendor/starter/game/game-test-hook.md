# Game test hook

Open the game with `?test=1` at the end of the address, for example `index.html?test=1`. This turns on a small remote control called `window.__game`. Without `?test=1` it does not exist, so players never see it.

A test tool (or you, in the browser console) can use it to pause the game, step it one tick at a time, press buttons and read what is going on. Dim Factory's play-test uses it.

## The `window.__game` contract

| Member            | Type                       | What it does                                                                     |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `version`         | number                     | Always `1` for now.                                                              |
| `ready`           | boolean                    | `true` once the game is wired up.                                                |
| `actions()`       | function: string[]         | The input map's action names, like `['action', 'down', 'left']`.                 |
| `pause()`         | function                   | Pauses the loop. Updates stop.                                                   |
| `resume()`        | function                   | Resumes the loop.                                                                |
| `step(ticks = 1)` | function (ticks: number)   | Runs exactly `ticks` fixed 60 Hz updates and one render, even while paused.      |
| `press(action)`   | function (action: string)  | Holds an action down, like `'left'` or `'action'`.                               |
| `release(action)` | function (action: string)  | Lets an action go.                                                               |
| `tap(action)`     | function (action: string)  | Press, step once, release. A quick button press.                                 |
| `seed(n)`         | function (n?: number): any | Restarts with seed `n` when you pass one. Returns the seed in use.               |
| `state()`         | function: object           | A JSON-safe copy of the state, plus `reducedMotion`, `paused` and `ticks`. 8 KB. |

The loop's step is fixed (1/60 of a second), so the same seed and the same steps always give the same state. A play-test relies on that.

## State every game should report

`state()` must at least return these fields. Add more small fields if they help (a position, a length, a count).

- `scene`: one of `'title'`, `'playing'`, `'paused'`, `'over'`, `'won'`.
- `score`: number.
- `lives`: number.
- `level`: number.

The hook adds `reducedMotion` (boolean), `paused` (boolean) and `ticks` (how many updates have run). A state larger than 8 KB is cut down to these fields with `truncated: true`, so keep it small.

## Reduced motion

Some players ask their computer or phone for less motion. `prefersReducedMotion()` (exported by `test-hook.js`) says whether they did: the system setting, or `?reducedMotion=1` in the address to try it. When it is on, turn off screen shake, flashes and fast scrolling. The hook reports it as `reducedMotion` in `state()`; if your game has its own "Reduce motion" setting, pass it to the hook so the state says what the game really does:

```js
installTestHook({ loop, input, rng, state, setSeed, reducedMotion: () => settings.reducedMotion })
```

Dim Factory turns the system setting on in its play-test window and checks that the state then says `reducedMotion: true`.

## Wiring it in

In `main.js`, after you create the loop, input and random generator:

```js
import { createLoop } from './engine/loop.js'
import { createInput } from './engine/input.js'
import { createRng } from './engine/rng.js'
import { installTestHook } from './engine/test-hook.js'

const input = createInput()
let rng = createRng(Number(new URLSearchParams(location.search).get('seed') ?? 1))
const game = { scene: 'title', score: 0, lives: 3, level: 1 }

const loop = createLoop({
  update(dt) {
    input.update() // always first, so pressed() works
    // ...move things, check rules, change game.scene...
  },
  render(alpha) {
    // ...draw...
  },
})

installTestHook({
  loop,
  input,
  rng,
  state: () => ({ ...game }),
  setSeed: (n) => {
    rng = createRng(n)
    // ...start a new game...
  },
})
loop.start()
```

Your `update` must call `input.update()` once per step. Then `tap('action')` is seen by `input.pressed('action')`.

## Play-test scenarios: `playtest.json`

Describe how to play the game in a `playtest.json` file at the project's root. It is data, not code: nothing in it is ever run. Dim Factory opens the game with `?test=1&seed=N` in a hidden, sandboxed window with no internet, plays each scenario with real key presses, clicks and taps, and checks the state. A scenario with `"must": true` (the default) has to pass for Verify to pass; `"must": false` is reported only.

```json
{
  "version": 1,
  "seed": 1,
  "scenarios": [
    {
      "name": "Space starts the game",
      "steps": [{ "key": "Space" }, { "wait": { "ms": 200 } }, { "expect": "scene", "eq": "playing" }]
    },
    {
      "name": "Arrow keys steer the snake",
      "steps": [
        { "key": "Space" },
        { "hold": "ArrowDown", "ms": 400 },
        { "expect": "snake.0.y", "changed": true },
        { "screenshot": "steering" }
      ]
    },
    {
      "name": "P pauses the game",
      "must": false,
      "steps": [{ "key": "Space" }, { "key": "KeyP" }, { "expect": "paused", "eq": true }]
    }
  ]
}
```

### Steps

| Step                                          | What it does                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `{ "key": "Space" }`                          | Presses a key and lets it go. Keys are `KeyboardEvent.code` names.             |
| `{ "hold": "ArrowRight", "ms": 500 }`         | Holds a key down for a while (`ms`, or `ticks` of the 60 Hz step).             |
| `{ "click": [0.5, 0.5] }`                     | Clicks a point of the game's canvas (fractions: 0 is left or top, 1 the end).  |
| `{ "tap": [0.5, 0.9] }`                       | Taps a point the same way (a touch button).                                    |
| `{ "hook": "press", "action": "left" }`       | Holds an action through the hook (`"release"` lets it go).                     |
| `{ "hook": "seed", "seed": 7 }`               | Restarts the game with a seed.                                                 |
| `{ "hook": "step", "ticks": 30 }`             | Runs exact ticks (pause first with `{ "hook": "pause" }` for exact results).   |
| `{ "wait": { "ms": 300 } }`                   | Waits (or `{ "ticks": 20 }`: until the game ran 20 more ticks).                |
| `{ "expect": "score", "gt": 0 }`              | Checks a value of `state()`: `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `changed`.  |
| `{ "screenshot": "title" }`                   | Keeps a picture of the game at that moment.                                    |

A scenario can also say how it is played: `"viewport": "phone"` plays it at phone size (390 by 844) with touch input, so a `tap` is a real finger tap, and `"reducedMotion": true` plays it with the system's "reduce motion" setting on.

```json
{
  "name": "Tapping the board starts the game on a phone",
  "viewport": "phone",
  "steps": [{ "tap": [0.5, 0.5] }, { "wait": { "ms": 200 } }, { "expect": "scene", "eq": "playing" }]
}
```

`expect` takes a dotted path into the state, like `scene`, `player.x` or `snake.0.y`. `changed` means the value differs from what it was when the scenario started.

Each scenario starts from a fresh page. Limits: 12 scenarios, 200 steps and 60 seconds of waits and holds in all.

The first format (`press`, `release`, `tap` and `step` steps, and an `expect` object at the end of a scenario) still works.

## Built-in checks

With or without a `playtest.json`, Dim Factory also checks that the game logs no errors, the canvas is not blank, the loop runs, the frames come in time, the same seed gives the same state, pausing stops the game, it follows reduced motion, nothing is loaded from the internet, and its title, README title and file names do not use a famous game's name.

Part of the Dim Factory game starter. MIT License: copy, change and share it freely.
