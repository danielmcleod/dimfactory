// Research lenses as data: the generic lenses file, every pack's research block, the defaults, a pack lens replacing a
// generic one, unknown ids, the repository-only fallback without web search, and the prompt fragments and mode copy.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PackZ } from '@shared/brief.ts'
import type { Pack } from '@shared/brief.ts'
import { GenericLensesZ, REPOSITORY_LENS, defaultLensIds, lensOptions } from '@shared/research.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'
import {
  GENERIC_LENSES_FILE,
  readGenericLenses,
  renderAccess,
  renderLenses,
  researchSupport,
  resolveLenses,
} from '@core/research/lenses.ts'
import { builtinDir } from '@core/packs/load.ts'

const generic = readGenericLenses()
const pack = (id: string): Pack => {
  const v = readBuiltinPacks().find((p) => p.pack.id === id)
  if (v === undefined) throw new Error(id)
  return v.pack
}

describe('the lens data', () => {
  it('the generic lenses file is valid, has the repository lens without web, and its defaults exist', () => {
    const raw: unknown = JSON.parse(readFileSync(join(builtinDir(), GENERIC_LENSES_FILE), 'utf8'))
    expect(GenericLensesZ.safeParse(raw).success).toBe(true)
    const ids = generic.lenses.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(generic.lenses.find((l) => l.id === REPOSITORY_LENS)).toMatchObject({ web: false })
    expect(generic.lenses.filter((l) => l.id !== REPOSITORY_LENS).every((l) => l.web)).toBe(true)
    for (const d of generic.defaults) expect(ids).toContain(d)
    for (const l of generic.lenses) expect(`${l.label} ${l.ask}`).not.toContain('—')
  })

  it("every pack's research block is valid, its lens ids unique, and its defaults resolve", () => {
    for (const v of readBuiltinPacks()) {
      const r = v.pack.research
      expect(r, v.pack.id).toBeDefined()
      const own = (r?.lenses ?? []).map((l) => l.id)
      expect(new Set(own).size, v.pack.id).toBe(own.length)
      const options = lensOptions(generic, v.pack).map((l) => l.id)
      expect(new Set(options).size, v.pack.id).toBe(options.length)
      for (const d of r?.defaults ?? []) expect(options, `${v.pack.id}: ${d}`).toContain(d)
      for (const l of r?.lenses ?? []) expect(`${l.label} ${l.ask}`).not.toContain('—')
    }
    // Only the research and writing pack researches by default.
    expect(
      readBuiltinPacks()
        .filter((v) => v.pack.research?.on === true)
        .map((v) => v.pack.id),
    ).toEqual(['research-writing'])
  })

  it('PackZ takes a research block and refuses a malformed lens', () => {
    const base = { ...pack('design') }
    expect(PackZ.safeParse(base).success).toBe(true)
    const bad = (lens: unknown): boolean => PackZ.safeParse({ ...base, research: { lenses: [lens] } }).success
    expect(bad({ id: 'ok', label: 'OK', ask: 'Why?', web: true })).toBe(true)
    expect(bad({ id: 'Bad Id', label: 'OK', ask: 'Why?', web: true })).toBe(false)
    expect(bad({ id: 'ok', label: '', ask: 'Why?', web: true })).toBe(false)
    expect(bad({ id: 'ok', label: 'OK', ask: 'Why?' })).toBe(false)
    expect(bad({ id: 'ok', label: 'OK', ask: 'Why?', web: true, extra: 1 })).toBe(false)
  })
})

describe('resolving lenses', () => {
  it('the generic lenses, then the pack’s; the pack’s defaults when the run names none', () => {
    const sw = pack('software')
    const ids = lensOptions(generic, sw).map((l) => [l.id, l.source])
    expect(ids.slice(0, generic.lenses.length).every(([, s]) => s === 'generic')).toBe(true)
    expect(ids).toContainEqual(['seo', 'software'])
    expect(defaultLensIds(generic, sw)).toEqual(generic.defaults)
    expect(defaultLensIds(generic, pack('research-writing'))).toEqual([
      'literature',
      'competitors',
      'standards',
      'pitfalls',
    ])
    const r = resolveLenses([], { generic, pack: sw, web: true })
    expect(r.config.lenses.map((l) => l.id)).toEqual(generic.defaults)
    expect(r.unknown).toEqual([])
  })

  it('a pack lens with a generic id replaces the generic one', () => {
    const p: Pack = {
      ...pack('design'),
      research: {
        lenses: [
          { id: 'mvp', label: 'Smallest prototype', ask: 'What is the smallest prototype?', web: true },
        ],
      },
    }
    const opts = lensOptions(generic, p).filter((l) => l.id === 'mvp')
    expect(opts).toEqual([
      {
        id: 'mvp',
        label: 'Smallest prototype',
        ask: 'What is the smallest prototype?',
        web: true,
        source: 'design',
      },
    ])
  })

  it('reports unknown ids and keeps the known ones in the order asked', () => {
    const r = resolveLenses(['seo', 'nope', 'comparable', 'seo'], {
      generic,
      pack: pack('software'),
      web: true,
    })
    expect(r.config.lenses.map((l) => l.id)).toEqual(['seo', 'comparable'])
    expect(r.unknown).toEqual(['nope'])
    // A pack lens is unknown to another pack.
    expect(resolveLenses(['seo'], { generic, pack: pack('documents'), web: true }).unknown).toEqual(['seo'])
  })

  it('without web search keeps the repository lens and names the web lenses it left out', () => {
    const r = resolveLenses(['comparable', 'repository'], { generic, pack: pack('software'), web: false })
    expect(r.config).toEqual({
      web: false,
      lenses: [expect.objectContaining({ id: 'repository', web: false })],
      offWeb: ['Comparable products'],
    })
    // Only web lenses: the repository lens runs instead, so Research always has something to read.
    const only = resolveLenses(['seo'], { generic, pack: pack('software'), web: false })
    expect(only.config.lenses.map((l) => l.id)).toEqual(['repository'])
    expect(only.config.offWeb).toEqual(['SEO'])
  })
})

describe('prompt fragments and mode copy', () => {
  it('renders one numbered question per lens, marking the repository-only ones', () => {
    const r = resolveLenses(['comparable', 'repository'], { generic, web: true })
    expect(renderLenses(r.config.lenses).split('\n')).toEqual([
      '1. Comparable products: What do similar products offer? Which features are table stakes and which are differentiators?',
      expect.stringMatching(/^2\. This repository \(repository only, no web\): /),
    ])
  })

  it('says what the pass may reach, with and without the web', () => {
    expect(renderAccess(true)).toMatch(/search the web/)
    expect(renderAccess(false)).toMatch(/no web access/)
    expect(renderAccess(false)).toContain('repo:<path>')
    for (const w of [true, false])
      expect(renderAccess(w)).toMatch(/cannot edit files, run commands or start other agents/)
  })

  it('its mode copy is honest about the web and has no em dash', () => {
    expect(researchSupport(true)).toMatchObject({ status: 'supported' })
    expect(researchSupport(false)).toMatchObject({ status: 'degraded' })
    expect(researchSupport(false).copy).toMatch(/reads this repository only/)
    for (const w of [true, false]) expect(researchSupport(w).copy).not.toContain('—')
  })
})
