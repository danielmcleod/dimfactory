// The Games pack (light web games) as data: it validates, its Brief has the groups a game needs, its approach methods
// guide the plan, its research lenses and copy-only deploy targets (itch.io first) are there, and category detection
// picks it for a game without taking ordinary software tasks. Its security focus (no eval, untrusted saves, no
// third-party scripts, kid-safe rules, no gambling, server rules for multiplayer) is capped data, recorded with a run's
// Brief and rendered into the security reviewer's and the critic's prompts for a game only.
import { describe, expect, it } from 'vitest'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { briefRecord } from '@core/brief/brief.ts'
import { detectCategory, keywordFields } from '@core/brief/detect.ts'
import { briefEvidence } from '@core/deploy/classify.ts'
import { BUILTIN_PACK_IDS, readBuiltinPacks } from '@core/packs/load.ts'
import { readBuiltinRecipes } from '@core/recipes/load.ts'
import { buildPrompt } from '@core/supervisor/effects.ts'
import { initRunState } from '@core/supervisor/machine.ts'
import type { EffectOf } from '@core/supervisor/types.ts'
import { APPROACH_GROUP, GAMES_CATEGORY, PACK_FOCUS_MAX, PackZ, renderSecurityFocus } from '@shared/brief.ts'
import type { Pack } from '@shared/brief.ts'
import { makeConfig } from '../supervisor/helpers.ts'

const views = readBuiltinPacks()
const packs = views.map((v) => v.pack)
const games = packs.find((p) => p.id === GAMES_CATEGORY) as Pack
const software = packs.find((p) => p.id === 'software') as Pack

describe('the Games pack', () => {
  it('is a built-in pack that validates, with the groups a game Brief needs', () => {
    expect(BUILTIN_PACK_IDS).toContain('games')
    expect(PackZ.safeParse(games).success).toBe(true)
    expect(games.groups.map((g) => g.id)).toEqual([
      'genre',
      'controls',
      'players',
      'engine',
      'artStyle',
      'difficulty',
      'length',
      'sound',
      'save',
      'platform',
      'audience',
      'accessibility',
      'deliverable',
      'constraints',
      APPROACH_GROUP,
    ])
    const option = (g: string, o: string): boolean =>
      games.groups.find((x) => x.id === g)?.options.some((x) => x.id === o) === true
    for (const [g, o] of [
      ['controls', 'one-button'],
      ['players', 'pass-and-play'],
      ['players', 'play-by-link'],
      ['artStyle', 'my-photos'],
      ['audience', 'kids'],
      ['accessibility', 'reduced-motion'],
      ['accessibility', 'colour-safe'],
      ['constraints', 'original-art'],
    ] as const)
      expect(option(g, o), `${g}.${o}`).toBe(true)
  })

  it('offers core loop first, playtested and milestones as plan guidance', () => {
    const approach = games.groups.find((g) => g.id === APPROACH_GROUP)
    expect(approach?.options.map((o) => o.id)).toEqual(['core-loop-first', 'playtested', 'milestones'])
    for (const o of approach?.options ?? []) {
      expect(o.effect).toBe('plan')
      expect(o.guidance?.length ?? 0).toBeGreaterThan(40)
    }
  })

  it('researches comparable games, game feel and the smallest fun version by default', () => {
    expect(games.research?.lenses?.map((l) => l.id)).toEqual([
      'comparable-games',
      'game-feel',
      'mvp-scope',
      'controls-a11y',
      'difficulty-curve',
      'engine-choice',
      'originality',
    ])
    expect(games.research?.defaults).toEqual(['comparable-games', 'game-feel', 'mvp-scope'])
  })

  it('shares to itch.io first, then GitHub Pages, Netlify, Cloudflare Pages and Surge; itch.io steps are only words', () => {
    const targets = games.deploy?.targets ?? []
    expect(targets.map((t) => t.id)).toEqual([
      'itch-io',
      'github-pages',
      'netlify',
      'cloudflare-pages',
      'surge',
    ])
    for (const s of targets[0]?.steps ?? []) expect(s.run, s.label).toBeUndefined()
  })

  it("software's game option points at Games", () => {
    const game = software.groups.find((g) => g.id === 'projectType')?.options.find((o) => o.id === 'game')
    expect(game?.hint).toContain('Games category')
  })

  it('a game Brief classifies as a static site for Share it', () => {
    const brief = {
      category: 'games',
      fields: { deliverable: { choices: ['single-page', 'itch-zip'] } },
    }
    expect(briefEvidence(brief)?.cls).toBe('static-site')
    expect(briefEvidence({ category: 'games', fields: { engine: { choices: ['vite-ts'] } } })?.cls).toBe(
      'spa',
    )
  })

  it('has its own recipes: easy-game and new-game', () => {
    const recipes = readBuiltinRecipes().map((v) => v.recipe)
    for (const id of ['easy-game', 'new-game']) {
      const r = recipes.find((x) => x.id === id)
      expect(r?.brief?.category, id).toBe('games')
      expect(r?.researchLenses, id).toEqual(['comparable-games', 'game-feel', 'mvp-scope'])
    }
  })
})

describe('detection', () => {
  it.each([
    'A snake game I can play in the browser',
    'Make a sudoku with three difficulty levels',
    'A two player tic tac toe',
    'A pixel art platformer with three levels',
    'An endless runner where a cat jumps over boxes',
  ])('a game picks Games: %s', (task) => {
    expect(detectCategory(task, null, packs)).toMatchObject({ id: 'games', source: 'task' })
  })

  it.each([
    'A todo app',
    'Fix the login bug',
    'Add unit tests for the date parser',
    'Build a REST API for orders with a database',
    'A todo app on my phone',
    'Refactor the checkout page into components',
    'A website for my bakery',
  ])('an ordinary task stays elsewhere: %s', (task) => {
    expect(detectCategory(task, null, packs).id).not.toBe('games')
  })

  it("the keyword rules read a game's words", () => {
    expect(keywordFields('A two players memory game with our family photos', games, [])).toMatchObject({
      players: { choices: ['same-device'] },
      artStyle: { choices: ['my-photos'] },
      genre: { choices: ['card-board'] },
    })
  })
})

describe('the security focus', () => {
  it('lists the games rules, including gambling, kid safety, untrusted saves and no eval', () => {
    const focus = games.security?.focus ?? []
    expect(focus.length).toBeGreaterThanOrEqual(6)
    expect(focus.length).toBeLessThanOrEqual(PACK_FOCUS_MAX)
    const all = focus.join('\n')
    for (const want of [
      /eval/,
      /textContent/,
      /untrusted/,
      /third-party scripts/,
      /Kid-safe/,
      /gambling/i,
      /server/,
    ])
      expect(all).toMatch(want)
  })

  it('is capped data: too many lines or a line break are refused', () => {
    const base = { ...games }
    const many = Array.from({ length: PACK_FOCUS_MAX + 1 }, (_, i) => `Rule ${i}`)
    expect(PackZ.safeParse({ ...base, security: { focus: many } }).success).toBe(false)
    expect(PackZ.safeParse({ ...base, security: { focus: ['one\ntwo'] } }).success).toBe(false)
    expect(PackZ.safeParse({ ...base, security: { focus: ['x'.repeat(241)] } }).success).toBe(false)
    expect(PackZ.safeParse({ ...base, security: { focus: [] } }).success).toBe(false)
  })

  it("is recorded with a game's Brief, a website's or app's (the software and design packs), a data report's, and no other's", () => {
    const withFocus = ['games', 'software', 'design', 'data']
    for (const v of views) {
      const rec = briefRecord(v, { category: v.pack.id, fields: {} }, [])
      if (withFocus.includes(v.pack.id)) expect(rec.focus, v.pack.id).toBe(renderSecurityFocus(v.pack))
      else expect(rec.focus, v.pack.id).toBeUndefined()
    }
    expect(renderSecurityFocus(games)).toMatch(/^- No eval/)
    expect(renderSecurityFocus(software)).toMatch(/^- No secret key/)
    expect(renderSecurityFocus(views.find((v) => v.pack.id === 'data')?.pack)).toMatch(
      /never names, email addresses/,
    )
  })

  type Spawn = Pick<EffectOf<'spawn'>, 'step' | 'launch'>
  const spawn = (step: 'security' | 'critic' | 'review'): Spawn => {
    const launch = {} as Spawn['launch']
    return { step, launch }
  }

  const run = (focus?: string) =>
    initRunState({
      runId: '20261026T120000Z-game',
      displayNo: 1,
      folder: 'C:\\p\\snake',
      folderKey: 'k',
      task: 'A snake game',
      profile: 'claude-only',
      createdAt: 1,
      config: makeConfig(),
      category: focus !== undefined ? 'games' : 'software',
      ...(focus !== undefined ? { securityFocus: focus } : {}),
    })

  it('renders into Security and the critic for a game, and nowhere for other runs', () => {
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const focus = renderSecurityFocus(games)
    const game = run(focus)
    expect(game.securityFocus).toBe(focus)
    for (const step of ['security', 'critic'] as const) {
      const text = buildPrompt(game, cfg, spawn(step), { diff: 'diff' }).text
      expect(text, step).toContain('No gambling or real money')
      expect(text, step).toContain("This project's category")
      expect(text, step).not.toContain('{{')
    }
    expect(buildPrompt(game, cfg, spawn('review'), { diff: 'diff' }).text).not.toContain('No gambling')
    const other = run()
    for (const step of ['security', 'critic'] as const) {
      const text = buildPrompt(other, cfg, spawn(step), { diff: 'diff' }).text
      expect(text, step).not.toContain("This project's category")
      expect(text, step).not.toContain('{{')
    }
  })
})
