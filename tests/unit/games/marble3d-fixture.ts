// The 3D fixture game (tests/fixtures/games/marble3d: "Tilt Garden", a marble on a board drawn with three.js) laid out
// in a folder the way a project made from the game-3d-lite template is: the starter engine in src/engine/, and three.js
// in the project's own node_modules as `npm install` leaves it. The three.js copy comes from this repository's
// devDependency at test time (never committed, never bundled with the app); only the files the game loads, its
// package.json and its licence are copied.
import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
export const MARBLE3D_DIR = join(REPO, 'tests', 'fixtures', 'games', 'marble3d')
const ENGINE = join(REPO, 'src', 'core', 'templates', 'vendor', 'starter', 'game')

/** The repository's own three.js (the devDependency; its main entry is build/three.cjs). */
export const THREE_DIR = dirname(dirname(createRequire(import.meta.url).resolve('three')))

/** The three.js files a project's import map reaches, relative to node_modules/three. */
export const THREE_FILES: readonly string[] = [
  'package.json',
  'LICENSE',
  'build/three.module.js',
  'build/three.core.js',
]

/** Put three.js into `folder`/node_modules/three, as npm would. */
export function installThree(folder: string): void {
  for (const f of THREE_FILES) {
    const to = join(folder, 'node_modules', 'three', ...f.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    cpSync(join(THREE_DIR, ...f.split('/')), to)
  }
}

/** The 3D game in `folder`: its page, package.json and playtest.json, the starter engine and (by default) three.js. */
export function layoutMarble3d(folder: string, o: { three?: boolean } = {}): void {
  for (const f of ['index.html', 'package.json', 'playtest.json'])
    cpSync(join(MARBLE3D_DIR, f), join(folder, f))
  mkdirSync(join(folder, 'src', 'engine'), { recursive: true })
  for (const f of ['loop.js', 'rng.js', 'input.js', 'storage.js', 'test-hook.js'])
    cpSync(join(ENGINE, f), join(folder, 'src', 'engine', f))
  if (o.three !== false) installThree(folder)
}
