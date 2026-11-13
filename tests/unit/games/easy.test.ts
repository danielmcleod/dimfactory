// "A game", Easy's seventh kind: every table keyed by kind has an entry for it; Easy's words pick it ("a quiz app" could
// be a game or an app, so it asks); a game's template is chosen from its words (boards, puzzles, words, cards and
// memory games on a grid of buttons; stories, adventures, quizzes and trivia as data; the rest on a canvas); the
// idea's words refine the template's Brief and added photos make its look "My photos"; making one copies the starter
// engine into the new folder and remembers the photos for Share it; the Done screen reads the controls from How to play.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { copyTemplateFiles } from '@core/templates/files.ts'
import { loadTemplates, readBuiltinTemplates } from '@core/templates/load.ts'
import { EasyService } from '@core/easy/service.ts'
import type { EasyDeps } from '@core/easy/service.ts'
import { intentPrompt } from '@core/easy/intent.ts'
import {
  KIND_TEMPLATE,
  ambiguousKinds,
  briefUsesPhotos,
  chooseTemplate,
  detectKind,
  gameTemplate,
  ideaBrief,
} from '@core/easy/resolve.ts'
import { silentLogger } from '@core/log.ts'
import {
  EASY_KINDS,
  EASY_KIND_PACK,
  EASY_KIND_RECIPE,
  EASY_PLAY_KINDS,
  EASY_RESEARCH_KINDS,
  isEasyPhotoName,
} from '@shared/easy.ts'
import type { BriefInput } from '@shared/brief.ts'
import type { RunStartRequest } from '@shared/ipc.ts'
import type { Template } from '@shared/templates.ts'
import { controlsLine } from '@renderer/pages/easy/model.ts'
import { EXAMPLES, KIND_A, KIND_NOUN, KIND_TEXT } from '@renderer/pages/easy/text.ts'

const packs = readBuiltinPacks().map((v) => v.pack)
const NONE = { node: false, python: false }
const template = (id: string): Template => readBuiltinTemplates().find((t) => t.id === id) as Template

describe('the game kind', () => {
  it('is the seventh kind, and every table keyed by kind has an entry for every kind', () => {
    expect(EASY_KINDS).toHaveLength(7)
    expect(EASY_KINDS[6]).toBe('game')
    const tables: Record<string, Readonly<Record<string, string>>> = {
      EASY_KIND_PACK,
      EASY_KIND_RECIPE,
      KIND_TEMPLATE,
      KIND_TEXT,
      KIND_A,
      KIND_NOUN,
    }
    for (const [name, table] of Object.entries(tables)) {
      expect(Object.keys(table).sort(), name).toEqual([...EASY_KINDS].sort())
      for (const k of EASY_KINDS) expect(table[k]?.trim(), `${name}.${k}`).not.toBe('')
    }
    for (const k of EASY_KINDS) expect(intentPrompt('x', [k]), k).toMatch(new RegExp(`- ${k}: \\w`))
    expect(EASY_KIND_PACK.game).toBe('games')
    expect(EASY_KIND_RECIPE.game).toBe('easy-game')
    expect(EASY_RESEARCH_KINDS).toContain('game')
    expect(EASY_PLAY_KINDS).toEqual(['game'])
    expect(KIND_TEXT.game).toBe('A game')
  })

  it('has two gallery cards: a snake game and a memory game with your photos', () => {
    const games = EXAMPLES.filter((e) => e.kind === 'game')
    expect(games.map((e) => e.id ?? e.kind)).toEqual(['game', 'game-photos'])
    for (const e of games) expect(detectKind(e.text, packs)).toEqual({ kind: 'game', source: 'words' })
    expect(gameTemplate(games[0]?.text ?? '')).toBe('game-canvas')
    expect(gameTemplate(games[1]?.text ?? '')).toBe('game-board')
  })
})

describe('words', () => {
  it.each([
    ['A snake game I can play on my phone or laptop', 'game'],
    ['A quiz about birds for my class', 'game'],
    ['Trivia night questions about the 80s', 'game'],
    ['A sudoku for my grandma', 'game'],
    ['A tip splitter my friends can open on their phones', 'app'],
    ['A help guide for my board game club', 'document'],
  ] as const)('%s is %s', (idea, kind) => {
    expect(detectKind(idea, packs).kind).toBe(kind)
  })

  it('"a quiz app" could be a game or an app, so Easy asks', () => {
    expect(ambiguousKinds('A quiz app for my class', packs)).toEqual(['game', 'app'])
    expect(ambiguousKinds('A website for my game studio', packs)).toEqual(['game', 'website'])
    expect(ambiguousKinds('A snake game', packs)).toEqual([])
  })

  it('a game with no Easy word is still found through the Games pack', () => {
    expect(detectKind('An endless runner where a cat jumps over boxes', packs)).toEqual({
      kind: 'game',
      source: 'words',
    })
  })
})

describe("a game's template", () => {
  it.each([
    ['A memory game with family photos', 'game-board'],
    ['A word game with five-letter words', 'game-board'],
    ['A card game for two', 'game-board'],
    ['A sliding puzzle', 'game-board'],
    ['A board game like checkers', 'game-board'],
    ['A choose your own adventure story', 'game-story'],
    ['A pub quiz about films', 'game-story'],
    ['A trivia game for a birthday', 'game-story'],
    ['A snake game', 'game-canvas'],
    ['A space shooter with three levels', 'game-canvas'],
    // The family the idea names first wins.
    ['A quiz about card games', 'game-story'],
    ['A word puzzle that tells a story', 'game-board'],
  ] as const)('%s starts from %s', (idea, id) => {
    expect(chooseTemplate('game', idea, NONE)).toEqual({ templateId: id })
  })

  it('needs nothing installed, whatever the toolchain', () => {
    expect(chooseTemplate('game', 'A React game', { node: true, python: true })).toEqual({
      templateId: 'game-canvas',
    })
  })
})

describe("a game's Brief", () => {
  it("refines the template's choices with the idea's words", () => {
    const b = ideaBrief(
      'game',
      template('game-canvas'),
      'A two players snake game for kids on a tablet',
      packs,
    )
    expect(b.category).toBe('games')
    expect(b.fields['players']).toEqual({ choices: ['same-device'], source: 'keyword' })
    expect(b.fields['audience']).toEqual({ choices: ['kids'], source: 'keyword' })
    // A multi-choice group keeps the template's choices and adds the idea's.
    expect(b.fields['platform']?.choices).toEqual(['desktop', 'phone', 'tablet'])
    expect(b.fields['engine']).toEqual({ choices: ['canvas'], source: 'user' })
    expect(briefUsesPhotos(b)).toBe(false)
  })

  it('makes the look "My photos" when the idea says so or a photo was added', () => {
    expect(
      briefUsesPhotos(
        ideaBrief('game', template('game-board'), 'A memory game with our family photos', packs),
      ),
    ).toBe(true)
    const b = ideaBrief('game', template('game-board'), 'A memory game', packs, ['assets/gran.JPG'])
    expect(b.fields['artStyle']).toEqual({ choices: ['my-photos'], source: 'user' })
    expect(isEasyPhotoName('a.heic')).toBe(true)
    expect(isEasyPhotoName('notes.txt')).toBe(false)
  })

  it('leaves every other kind with its template Brief', () => {
    const t = template('static-site')
    const b: BriefInput = ideaBrief('app', t, 'A two players tip splitter on my phone', packs)
    expect(b.fields).toEqual(
      Object.fromEntries(Object.entries(t.brief.fields).map(([k, v]) => [k, { ...v, source: 'user' }])),
    )
  })
})

describe('making a game', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const temp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'dimf-game-'))
    dirs.push(d)
    return d
  }

  it('copies the starter engine into the new folder, saves the refined Brief and remembers the photos', async () => {
    const home = temp()
    const projects = temp()
    const starts: RunStartRequest[] = []
    const saved: BriefInput[] = []
    const deps: EasyDeps = {
      home,
      documentsDir: join(temp(), 'Documents'),
      newHome: false,
      log: silentLogger,
      now: () => 1000,
      readUser: () => Promise.resolve({ easy: { projectsDir: projects } }),
      patchUser: () => Promise.resolve(),
      packs: () => Promise.resolve(packs),
      templates: () => loadTemplates({ home }),
      readiness: () => ({ claude: true, codex: false, profile: 'claude-only', runnable: true }),
      toolchain: () => Promise.resolve(NONE),
      estimate: () => Promise.resolve(null),
      prepareFolder: (folder) => Promise.resolve(folder),
      saveBrief: (_folder, brief) => {
        saved.push(brief)
        return Promise.resolve()
      },
      copyTemplateFiles: (view, folder) => copyTemplateFiles(view, folder),
      startRun: (req) => {
        starts.push(req)
        return Promise.resolve({ runId: 'r1', displayNo: 1 })
      },
      summaries: () => [],
      runTask: () => Promise.resolve(null),
      exists: () => false,
    }
    const svc = new EasyService(deps)
    const idea = 'A birthday memory game with our family photos: find the matching pairs.'
    const resolved = await svc.resolve({ idea })
    expect(resolved).toMatchObject({
      kind: 'game',
      kindSource: 'words',
      template: { id: 'game-board' },
      recipe: 'easy-game',
      research: true,
    })
    const folder = join(projects, 'birthday-memory-game')
    const started = await svc.create({
      idea,
      kind: 'game',
      folder,
      limits: { maxCostUsd: null, maxMinutes: null },
      consent: false,
    })
    expect(started.folder).toBe(folder)
    expect(readdirSync(join(folder, 'src', 'engine')).sort()).toEqual([
      'input.js',
      'loop.js',
      'rng.js',
      'storage.js',
      'test-hook.js',
    ])
    expect(readdirSync(join(folder, 'lib'))).toEqual(['VENDORED.md'])
    expect(starts[0]?.recipe).toBe('easy-game')
    expect(starts[0]?.brief?.category).toBe('games')
    expect(starts[0]?.task).toContain('src/engine/')
    expect(saved[0]?.fields['artStyle']?.choices).toEqual(['my-photos'])
    expect(await svc.project(folder)).toMatchObject({ kind: 'game', photos: true, templateId: 'game-board' })
  })
})

describe('the controls line', () => {
  it.each([
    [
      '## How to play\nControls: arrow keys to steer, P or Esc to pause\nEat apples.',
      'arrow keys to steer, P or Esc to pause',
    ],
    ['**Controls:** Space to jump', 'Space to jump'],
    ['- **Controls**: tap the cards', 'tap the cards'],
    ['controls: `WASD` to move', 'WASD to move'],
  ])('reads %j', (text, want) => {
    expect(controlsLine(text)).toBe(want)
  })

  it('is null when the summary names no controls', () => {
    expect(controlsLine('## What was built\nA game.')).toBeNull()
    expect(controlsLine('Controls:')).toBeNull()
  })
})
