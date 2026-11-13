// Whether a folder is a game (Run & Preview then treats its preview as one: no internet by default, the built-in game
// checks in the smoke check, Play-test). A game is a folder whose saved Brief is in the Games category, or one that
// keeps a playtest.json or the starter's test hook (src/engine/test-hook.js). Reads only; never throws.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GAMES_CATEGORY } from '../../shared/brief.ts'
import { PLAYTEST_FILE } from '../../shared/playtest.ts'
import type { PageloadReport } from '../../shared/pageload.ts'
import type { PlaytestReport, PlaytestSpec } from '../../shared/playtest.ts'
import { readSavedBrief } from '../brief/store.ts'

/** Files that mark a game folder even without a saved Brief. */
export const GAME_MARKERS: readonly string[] = [PLAYTEST_FILE, 'src/engine/test-hook.js']

export async function isGameFolder(home: string, folder: string): Promise<boolean> {
  if (GAME_MARKERS.some((f) => existsSync(join(folder, ...f.split('/'))))) return true
  try {
    return (await readSavedBrief(home, folder))?.category === GAMES_CATEGORY
  } catch {
    return false
  }
}

/** What main's play-tester does (main/preview.ts): play a loopback page in its hidden, sandboxed play-test window. */
export interface MainPlaytester {
  playUrl(o: {
    url: string
    /** null: the built-in game checks only. */
    spec: PlaytestSpec | null
    /** Where scenario screenshots go (null: none kept). */
    shotsDir: string | null
    signal?: AbortSignal
  }): Promise<PlaytestReport>
  /**
   * The built-in page-load check: open a loopback page in a hidden, sandboxed window with no internet; whether it
   * loaded and what went wrong. Absent: the page-load check is not run here.
   */
  checkPage?(o: { url: string; signal?: AbortSignal }): Promise<PageloadReport>
}

/**
 * The folder Dim Factory serves to play a game: its own folder (index.html), or a Vite game's build (dist/) once it is
 * built. Otherwise why there is nothing to play (the play-test is then not run, which is not a failure).
 */
export async function gamePageRoot(folder: string): Promise<{ dir: string } | { reason: string }> {
  let vite: boolean
  try {
    const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as Record<string, unknown>
    const deps = {
      ...(pkg['dependencies'] as object | undefined),
      ...(pkg['devDependencies'] as object | undefined),
    }
    vite = Object.hasOwn(deps, 'vite')
  } catch {
    vite = false
  }
  if (vite) {
    if (existsSync(join(folder, 'dist', 'index.html'))) return { dir: join(folder, 'dist') }
    return { reason: 'Build the game first (its build makes dist/, which the play-test plays)' }
  }
  if (existsSync(join(folder, 'index.html'))) return { dir: folder }
  return { reason: 'There is no index.html to play' }
}
