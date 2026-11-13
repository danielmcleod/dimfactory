// The game templates and the files a template copies into a new project. The three game templates (arcade on a
// canvas, a grid of buttons for boards and puzzles, a story or quiz told as data) fit the Games pack and the task cap,
// and each task asks for what every game needs. A template's `files` take only ids from the bundled manifest and
// targets under lib/, src/ or docs/ (no `..`, no absolute path, nothing hidden); every bundled file matches its
// sha256, and a copy checks each hash before anything is written, never overwrites, and writes lib/VENDORED.md (and a
// third-party library's licence under lib/LICENSES/). A user template may not copy files.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { LICENSES_DIR, VENDORED_FILE, copyTemplateFiles, readVendorManifest } from '@core/templates/files.ts'
import {
  builtinTemplatesDir,
  loadTemplates,
  readBuiltinTemplates,
  templatePackProblem,
} from '@core/templates/load.ts'
import { TEMPLATE_TASK_MAX, TemplateZ, templateTargetProblem } from '@shared/templates.ts'
import type { Template, TemplateView } from '@shared/templates.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-games-'))
  dirs.push(d)
  return d
}

const packs = readBuiltinPacks().map((v) => v.pack)
const templates = readBuiltinTemplates()
const GAME_IDS = ['game-canvas', 'game-board', 'game-story']
const game = (id: string): Template => templates.find((t) => t.id === id) as Template
const builtin = (t: Template): TemplateView => ({ template: t, layer: 'builtin' })

/** A copy of the built-in templates folder (with vendor/) to change in a test. */
function templatesCopy(): string {
  const d = join(temp(), 'templates')
  cpSync(builtinTemplatesDir(), d, { recursive: true, filter: (s) => !s.endsWith('.ts') })
  return d
}

describe('the game templates', () => {
  it('fit the Games pack and stay under the task cap', () => {
    for (const id of GAME_IDS) {
      const t = game(id)
      expect(t.pack, id).toBe('games')
      expect(t.recipe, id).toBe('new-game')
      expect(templatePackProblem(t, packs), id).toBeNull()
      expect(t.task.length, id).toBeLessThan(TEMPLATE_TASK_MAX)
    }
  })

  it.each(GAME_IDS)('%s asks for what every game needs', (id) => {
    const task = game(id).task
    for (const want of [
      /title screen/,
      /pause with P or Esc/,
      /loses focus/,
      /game over or a win/,
      /Restart/,
      /changes the keys/,
      /mutes sound/,
      /reduced motion/,
      /colour-safe palette/,
      /touch/,
      /best score/,
      /test hook/,
      /playtest\.json/,
      /node --test/,
      /README\.md: how to play \(the goal and the controls\)/,
      /how to share it/,
      /credits/,
      /original names, characters and art/,
      /never copy a famous game's name/,
      /no eval/,
      /src\/engine\//,
    ])
      expect(task, String(want)).toMatch(want)
  })

  it('the board game is a grid of real buttons and the story keeps its story as data, never code', () => {
    expect(game('game-board').task).toMatch(/grid of real HTML buttons/)
    expect(game('game-story').task).toMatch(/data\/story\.json/)
    expect(game('game-story').task).toMatch(/never evaluates any of it as code/)
  })

  it('copy the starter engine and its doc', () => {
    for (const id of GAME_IDS)
      expect(game(id).files?.map((f) => f.to)).toEqual([
        'src/engine/loop.js',
        'src/engine/rng.js',
        'src/engine/input.js',
        'src/engine/storage.js',
        'src/engine/test-hook.js',
        'docs/game-test-hook.md',
      ])
  })
})

describe('a template file target', () => {
  it.each([
    ['src/engine/loop.js', null],
    ['lib/phaser.min.js', null],
    ['docs/how-to.md', null],
  ])('%s is fine', (to, problem) => {
    expect(templateTargetProblem(to)).toBe(problem)
  })

  it.each([
    '../outside.js',
    'src/../../x.js',
    'src/./x.js',
    '/etc/passwd',
    'C:/Windows/x.js',
    'C:x.js',
    'src\\engine\\x.js',
    'src/.hidden/x.js',
    'src/.env',
    'index.html',
    'assets/x.png',
    'src',
    'src/',
    'src//x.js',
    'src/x\0.js',
  ])('%s is refused', (to) => {
    expect(templateTargetProblem(to)).not.toBeNull()
  })

  it('the schema refuses a bad target, an unknown id shape and the same target twice', () => {
    const t = { ...game('game-canvas') }
    expect(TemplateZ.safeParse({ ...t, files: [{ from: 'game-loop', to: '../x.js' }] }).success).toBe(false)
    expect(TemplateZ.safeParse({ ...t, files: [{ from: '../loop', to: 'src/x.js' }] }).success).toBe(false)
    expect(
      TemplateZ.safeParse({
        ...t,
        files: [
          { from: 'game-loop', to: 'src/x.js' },
          { from: 'game-rng', to: 'SRC/X.js'.replace('SRC', 'src') },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('the bundled manifest', () => {
  it('lists every file the built-in templates copy, each matching its sha256', async () => {
    const manifest = await readVendorManifest()
    const ids = new Set(manifest.entries.map((e) => e.id))
    for (const t of templates)
      for (const f of t.files ?? []) expect(ids.has(f.from), `${t.id}: ${f.from}`).toBe(true)
    for (const e of manifest.entries) {
      const bytes = readFileSync(join(builtinTemplatesDir(), 'vendor', ...e.path.split('/')))
      expect(createHash('sha256').update(bytes).digest('hex'), e.id).toBe(e.sha256)
    }
    // Phaser is the one third-party library bundled (for the Phaser template), with its licence beside it.
    expect(manifest.entries.filter((e) => e.origin === 'third-party').map((e) => e.id)).toEqual(['phaser'])
  })
})

describe('copyTemplateFiles', () => {
  it('copies the starter engine and writes lib/VENDORED.md', async () => {
    const project = temp()
    const written = await copyTemplateFiles(builtin(game('game-canvas')), project)
    expect(written).toEqual([
      'src/engine/loop.js',
      'src/engine/rng.js',
      'src/engine/input.js',
      'src/engine/storage.js',
      'src/engine/test-hook.js',
      'docs/game-test-hook.md',
      VENDORED_FILE,
    ])
    const vendored = readFileSync(join(project, 'lib', 'VENDORED.md'), 'utf8')
    expect(vendored).toContain(
      '| src/engine/loop.js | Fixed-timestep game loop (Dim Factory game starter) | MIT |',
    )
    expect(vendored).toContain('MIT License')
    expect(readFileSync(join(project, 'src', 'engine', 'rng.js'), 'utf8')).toContain(
      'export function createRng',
    )
    expect(existsSync(join(project, 'lib', 'LICENSES'))).toBe(false)
  })

  it('copies nothing for a template without files or one that is not built in', async () => {
    const project = temp()
    const site = templates.find((t) => t.id === 'static-site') as Template
    expect(await copyTemplateFiles(builtin(site), project)).toEqual([])
    expect(await copyTemplateFiles({ template: game('game-canvas'), layer: 'user' }, project)).toEqual([])
    expect(readdirSync(project)).toEqual([])
  })

  it('refuses a changed bundled file and writes nothing', async () => {
    const dir = templatesCopy()
    writeFileSync(join(dir, 'vendor', 'starter', 'game', 'storage.js'), '// changed\n')
    const project = temp()
    await expect(
      copyTemplateFiles(builtin(game('game-canvas')), project, { builtinDir: dir }),
    ).rejects.toThrow(/game-storage.*is not the one Dim Factory shipped/)
    expect(readdirSync(project)).toEqual([])
  })

  it('refuses an id the manifest does not have, and writes nothing', async () => {
    const dir = templatesCopy()
    const file = join(dir, 'game-board.json')
    const t = JSON.parse(readFileSync(file, 'utf8')) as Template
    t.files = [...(t.files ?? []), { from: 'no-such-file', to: 'lib/x.js' }]
    writeFileSync(file, JSON.stringify(t))
    const project = temp()
    await expect(copyTemplateFiles(builtin(t), project, { builtinDir: dir })).rejects.toThrow(
      /"no-such-file" is not a bundled file/,
    )
    expect(readdirSync(project)).toEqual([])
  })

  it('never overwrites a file that is there already', async () => {
    const project = temp()
    mkdirSync(join(project, 'src', 'engine'), { recursive: true })
    writeFileSync(join(project, 'src', 'engine', 'input.js'), 'mine')
    await expect(copyTemplateFiles(builtin(game('game-story')), project)).rejects.toThrow(
      /already in the project/,
    )
    expect(readFileSync(join(project, 'src', 'engine', 'input.js'), 'utf8')).toBe('mine')
    expect(existsSync(join(project, 'src', 'engine', 'loop.js'))).toBe(false)
  })

  it('a third-party library brings its licence to lib/LICENSES and says so in VENDORED.md', async () => {
    const dir = templatesCopy()
    const lib = 'export const tiny = 1\n'
    const licence = 'MIT License\n\nCopyright (c) Example\n'
    mkdirSync(join(dir, 'vendor', 'tiny'), { recursive: true })
    writeFileSync(join(dir, 'vendor', 'tiny', 'tiny.js'), lib)
    writeFileSync(join(dir, 'vendor', 'tiny', 'LICENSE.txt'), licence)
    const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
    const mf = join(dir, 'vendor', 'manifest.json')
    const manifest = JSON.parse(readFileSync(mf, 'utf8')) as { entries: unknown[] }
    manifest.entries.push({
      id: 'tiny',
      origin: 'third-party',
      name: 'Tiny',
      version: '1.0.0',
      homepage: 'https://example.com/tiny',
      path: 'tiny/tiny.js',
      sha256: sha(lib),
      license: 'MIT',
      licenseFile: 'tiny/LICENSE.txt',
      licenseSha256: sha(licence),
    })
    writeFileSync(mf, JSON.stringify(manifest))
    const file = join(dir, 'game-canvas.json')
    const t = JSON.parse(readFileSync(file, 'utf8')) as Template
    t.files = [{ from: 'tiny', to: 'lib/tiny.js' }]
    writeFileSync(file, JSON.stringify(t))
    const project = temp()
    const written = await copyTemplateFiles(builtin(t), project, { builtinDir: dir })
    expect(written).toEqual(['lib/tiny.js', `${LICENSES_DIR}/tiny.txt`, VENDORED_FILE])
    expect(readFileSync(join(project, 'lib', 'LICENSES', 'tiny.txt'), 'utf8')).toBe(licence)
    expect(readFileSync(join(project, 'lib', 'VENDORED.md'), 'utf8')).toContain(
      '| lib/tiny.js | Tiny 1.0.0 (https://example.com/tiny) | MIT, see lib/LICENSES/tiny.txt |',
    )
  })
})

describe('a user template', () => {
  it('may not copy files: it is refused with the reason, and the built-in stays', async () => {
    const home = temp()
    mkdirSync(join(home, 'templates'))
    const t = { ...game('game-canvas'), label: 'My arcade' }
    writeFileSync(join(home, 'templates', 'game-canvas.json'), JSON.stringify(t))
    const list = await loadTemplates({ home })
    expect(list.issues.map((i) => i.message)).toEqual([
      'Only built-in templates can copy files into a project. Remove "files" to use this template.',
    ])
    const view = list.templates.find((v) => v.template.id === 'game-canvas')
    expect(view?.layer).toBe('builtin')
    expect(view?.template.label).toBe('Arcade game (canvas)')
  })
})

describe('the phase 2 game templates', () => {
  it('Phaser (copied with its licence), the game helper and the Vite game are games, valid and fit their pack', () => {
    for (const id of ['game-phaser', 'game-tool', 'game-vite']) {
      const t = game(id)
      expect(TemplateZ.safeParse(t).success, id).toBe(true)
      expect(t.pack, id).toBe('games')
      expect(templatePackProblem(t, packs), id).toBeNull()
      expect(t.task.length, id).toBeLessThanOrEqual(TEMPLATE_TASK_MAX)
      expect(t.task, id).toContain('playtest.json')
      expect(t.task, id).toContain('never copy a famous game')
      expect(t.task, id).not.toMatch(/[–—]/)
    }
    expect(game('game-phaser').brief.fields['engine']?.choices).toEqual(['phaser'])
    expect(game('game-tool').brief.fields['genre']?.choices).toEqual(['helper'])
    expect(game('game-vite').brief.fields['engine']?.choices).toEqual(['vite-ts'])
    // The Phaser template loads the bundled copy, never a CDN.
    expect(game('game-phaser').task).toContain('lib/phaser/phaser.min.js')
    expect(game('game-phaser').task).toContain('never load it from a CDN')
  })

  it('the Phaser template copies Phaser and its licence, checked by hash, and lists it in VENDORED.md', async () => {
    const project = temp()
    const written = await copyTemplateFiles(builtin(game('game-phaser')), project)
    expect(written).toContain('lib/phaser/phaser.min.js')
    expect(written).toContain(`${LICENSES_DIR}/phaser.txt`)
    expect(readFileSync(join(project, 'lib', 'LICENSES', 'phaser.txt'), 'utf8')).toMatch(/The MIT License/)
    expect(readFileSync(join(project, 'lib', 'phaser', 'phaser.min.js'), 'utf8').slice(0, 200)).toContain(
      'Phaser',
    )
    const vendored = readFileSync(join(project, 'lib', 'VENDORED.md'), 'utf8')
    expect(vendored).toMatch(
      /\| lib\/phaser\/phaser\.min\.js \| Phaser 3\.90\.0 \(https:\/\/phaser\.io\) \| MIT, see lib\/LICENSES\/phaser\.txt \|/,
    )
  })
})
