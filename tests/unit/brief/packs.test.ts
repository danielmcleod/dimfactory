import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPROACH_GROUP, PackZ, TEST_FIRST } from '@shared/brief.ts'
import type { Pack } from '@shared/brief.ts'
import {
  BUILTIN_PACK_IDS,
  PACK_FILE_MAX_BYTES,
  loadPacks,
  packById,
  readBuiltinPacks,
} from '@core/packs/load.ts'

const PACKS_DIR = fileURLToPath(new URL('../../../src/core/packs/', import.meta.url))
/** The en dash and the em dash (from their code points). */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)

const SOFTWARE_GROUPS = [
  'projectType',
  'deliverable',
  'platform',
  'language',
  'uiFramework',
  'styling',
  'backend',
  'data',
  'auth',
  'hosting',
  'quality',
  'constraints',
  'approach',
]
const METHODS = [
  'test-first',
  'contract-first',
  'walking-skeleton',
  'milestones',
  'ui-mock-first',
  'characterization-tests',
]

function uiText(p: Pack): string[] {
  const out = [p.label, p.description]
  for (const g of p.groups) {
    out.push(g.label, g.hint ?? '')
    for (const o of g.options) out.push(o.label, o.hint ?? '', o.guidance ?? '')
  }
  return out
}

describe('built-in packs', () => {
  it('every JSON file validates and its id is its file stem', () => {
    // research-lenses.json beside the packs is Research's generic lenses, not a pack (lenses.test.ts checks it).
    const files = readdirSync(PACKS_DIR).filter((f) => f.endsWith('.json') && f !== 'research-lenses.json')
    expect(files.map((f) => f.slice(0, -5)).sort()).toEqual([...BUILTIN_PACK_IDS].sort())
    for (const f of files) {
      const r = PackZ.safeParse(JSON.parse(readFileSync(join(PACKS_DIR, f), 'utf8')))
      expect(r.success, `${f}: ${r.success ? '' : r.error.message}`).toBe(true)
      if (r.success) expect(r.data.id).toBe(f.slice(0, -5))
    }
  })

  it('reads in the fixed order as the builtin layer', () => {
    const views = readBuiltinPacks()
    expect(views.map((v) => v.pack.id)).toEqual([...BUILTIN_PACK_IDS])
    expect(views.every((v) => v.layer === 'builtin' && /^[0-9a-f]{64}$/.test(v.sha256))).toBe(true)
    expect(readBuiltinPacks()).toBe(views)
  })

  it('software has the full set of groups, with the six methods and only Test-first changing the pipeline', () => {
    const sw = packById(readBuiltinPacks(), 'software')?.pack
    expect(sw?.groups.map((g) => g.id)).toEqual(SOFTWARE_GROUPS)
    const approach = sw?.groups.find((g) => g.id === APPROACH_GROUP)
    expect(approach?.multi).toBe(true)
    expect(approach?.other).toBe(false)
    expect(approach?.options.map((o) => o.id)).toEqual(METHODS)
    for (const o of approach?.options ?? []) {
      expect(o.effect).toBe(o.id === TEST_FIRST ? 'pipeline' : 'plan')
      expect(o.guidance?.length ?? 0).toBeGreaterThan(20)
      expect(o.hint).toBeDefined()
    }
    expect(approach?.options.map((o) => o.label)).toEqual([
      'Test-first',
      'Contract first',
      'Walking skeleton',
      'Milestones',
      'UI mock first',
      'Characterization tests',
    ])
  })

  it('lighter packs have 3 to 6 groups besides an optional approach group', () => {
    // Software and Games are the two full packs (a game's Brief has its genre, controls, players, look...).
    for (const v of readBuiltinPacks().filter((x) => x.pack.id !== 'software' && x.pack.id !== 'games')) {
      const n = v.pack.groups.filter((g) => g.id !== APPROACH_GROUP).length
      expect(n, v.pack.id).toBeGreaterThanOrEqual(3)
      expect(n, v.pack.id).toBeLessThanOrEqual(6)
      for (const o of v.pack.groups.find((g) => g.id === APPROACH_GROUP)?.options ?? []) {
        expect(o.effect).toBe('plan')
      }
    }
  })

  it('no UI text holds an em dash or an en dash', () => {
    for (const v of readBuiltinPacks()) {
      for (const t of uiText(v.pack)) expect(DASHES.test(t), `${v.pack.id}: ${t}`).toBe(false)
    }
  })

  it('a broken built-in throws, naming the file and the problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dim-factory-packs-builtin-'))
    try {
      for (const id of BUILTIN_PACK_IDS)
        writeFileSync(join(dir, `${id}.json`), readFileSync(join(PACKS_DIR, `${id}.json`)))
      writeFileSync(join(dir, 'data.json'), '{"id":"data","version":2}')
      expect(() => readBuiltinPacks(dir)).toThrow(/data\.json.*version/s)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sha256 is the same for LF, CRLF and a BOM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dim-factory-packs-sha-'))
    try {
      const lf = readFileSync(join(PACKS_DIR, 'software.json'), 'utf8').replace(/\r\n/g, '\n')
      const write = (text: string): string => {
        for (const id of BUILTIN_PACK_IDS) {
          writeFileSync(
            join(dir, `${id}.json`),
            id === 'software' ? text : readFileSync(join(PACKS_DIR, `${id}.json`)),
          )
        }
        return readBuiltinPacks(dir)[0]?.sha256 ?? ''
      }
      const a = write(lf)
      const b = write(lf.replace(/\n/g, '\r\n'))
      const c = write(String.fromCharCode(0xfeff) + lf.replace(/\n/g, '\r\n'))
      expect(a).toMatch(/^[0-9a-f]{64}$/)
      expect(b).toBe(a)
      expect(c).toBe(a)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('loadPacks overrides', () => {
  let root: string
  let home: string
  let folder: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dim-factory-packs-'))
    home = join(root, 'home')
    folder = join(root, 'project')
    mkdirSync(join(home, 'packs'), { recursive: true })
    mkdirSync(join(folder, '.dimfactory', 'packs'), { recursive: true })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const builtin = (id: string): Pack => packById(readBuiltinPacks(), id)?.pack as Pack
  const userFile = (name: string, body: unknown): void =>
    writeFileSync(join(home, 'packs', name), typeof body === 'string' ? body : JSON.stringify(body))
  const projectFile = (name: string, body: unknown): void =>
    writeFileSync(
      join(folder, '.dimfactory', 'packs', name),
      typeof body === 'string' ? body : JSON.stringify(body),
    )

  it('no overrides: the built-ins, no issues; missing folders are fine', async () => {
    const r = await loadPacks({ home: join(root, 'nope'), folder: join(root, 'nope2') })
    expect(r.issues).toEqual([])
    expect(r.packs.map((v) => v.pack.id)).toEqual([...BUILTIN_PACK_IDS])
  })

  it('project beats user beats built-in, in place', async () => {
    userFile('documents.json', { ...builtin('documents'), label: 'User docs' })
    userFile('data.json', { ...builtin('data'), label: 'User data' })
    projectFile('documents.json', { ...builtin('documents'), label: 'Project docs' })
    const r = await loadPacks({ home, folder })
    expect(r.issues).toEqual([])
    expect(r.packs.map((v) => v.pack.id)).toEqual([...BUILTIN_PACK_IDS])
    const docs = packById(r.packs, 'documents')
    expect(docs?.pack.label).toBe('Project docs')
    expect(docs?.layer).toBe('project')
    expect(packById(r.packs, 'data')).toMatchObject({ layer: 'user', pack: { label: 'User data' } })
    expect(packById(r.packs, 'software')?.layer).toBe('builtin')
  })

  it('without a folder there is no project layer', async () => {
    userFile('documents.json', { ...builtin('documents'), label: 'User docs' })
    projectFile('documents.json', { ...builtin('documents'), label: 'Project docs' })
    const r = await loadPacks({ home })
    expect(packById(r.packs, 'documents')?.layer).toBe('user')
  })

  it('a new id adds a category after the built-ins, sorted', async () => {
    const extra = (id: string): Pack => ({ ...builtin('research-writing'), id, label: id })
    projectFile('zeta.json', extra('zeta'))
    userFile('alpha.json', extra('alpha'))
    const r = await loadPacks({ home, folder })
    expect(r.packs.map((v) => v.pack.id)).toEqual([...BUILTIN_PACK_IDS, 'alpha', 'zeta'])
  })

  it('broken overrides become issues and the built-in stays', async () => {
    projectFile('software.json', '{ not json')
    userFile('data.json', { ...builtin('data'), version: 2 })
    userFile('design.json', { ...builtin('documents') })
    const huge = { ...builtin('research-writing'), description: 'x' }
    userFile('research-writing.json', JSON.stringify(huge) + ' '.repeat(PACK_FILE_MAX_BYTES))
    userFile('notes.txt', 'ignored')
    const r = await loadPacks({ home, folder })
    expect(r.packs.map((v) => v.pack.id)).toEqual([...BUILTIN_PACK_IDS])
    for (const id of ['software', 'data', 'design', 'research-writing'])
      expect(packById(r.packs, id)?.layer).toBe('builtin')
    const byFile: Record<string, string> = Object.fromEntries(
      r.issues.map((i): [string, string] => [i.file.split(/[\\/]/).pop() ?? '', i.message]),
    )
    expect(Object.keys(byFile).sort()).toEqual([
      'data.json',
      'design.json',
      'research-writing.json',
      'software.json',
    ])
    expect(byFile['software.json']).toMatch(/JSON/)
    expect(byFile['data.json']).toMatch(/version/)
    expect(byFile['design.json']).toMatch(/file name must match/)
    expect(byFile['research-writing.json']).toMatch(/Too large/)
  })

  it('a project override that breaks keeps the user one', async () => {
    userFile('documents.json', { ...builtin('documents'), label: 'User docs' })
    projectFile('documents.json', { ...builtin('documents'), groups: [] })
    const r = await loadPacks({ home, folder })
    expect(packById(r.packs, 'documents')).toMatchObject({ layer: 'user', pack: { label: 'User docs' } })
    expect(r.issues).toHaveLength(1)
  })

  it('an override with the same text as the built-in has the same sha256', async () => {
    projectFile(
      'software.json',
      readFileSync(join(PACKS_DIR, 'software.json'), 'utf8').replace(/\r?\n/g, '\r\n'),
    )
    const r = await loadPacks({ home, folder })
    expect(packById(r.packs, 'software')?.layer).toBe('project')
    expect(packById(r.packs, 'software')?.sha256).toBe(packById(readBuiltinPacks(), 'software')?.sha256)
  })
})
