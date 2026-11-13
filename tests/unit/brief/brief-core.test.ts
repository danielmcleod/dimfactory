// The Brief in core: checking a brief against its pack and the folder's facts (unknown ids and two values in a
// single-choice group refused; a locked single-choice group keeps the repository's value; "Let Dim Factory decide"
// fields dropped), rendering `{{brief}}` (only set fields and facts; method guidance; sources), per-folder saved
// briefs (save, read back, Reset), and the service's run brief (VALIDATION, Test-first, the folder's facts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BriefFact, BriefInput, Pack } from '@shared/brief.ts'
import { briefTestFirst } from '@shared/brief.ts'
import { briefRecord, checkBrief, lockedGroups, renderBrief } from '@core/brief/brief.ts'
import { BriefService } from '@core/brief/service.ts'
import { briefFile, readSavedBrief, saveBrief } from '@core/brief/store.ts'
import { packById, readBuiltinPacks } from '@core/packs/load.ts'
import { AdapterRegistry } from '@core/adapters/registry.ts'

const software = (): Pack => {
  const v = packById(readBuiltinPacks(), 'software')
  if (v === undefined) throw new Error('no software pack')
  return v.pack
}

const reactFact: BriefFact = {
  group: 'uiFramework',
  option: 'react',
  label: 'React 19',
  evidence: 'package.json',
}
const tsFact: BriefFact = {
  group: 'language',
  option: 'typescript',
  label: 'TypeScript',
  evidence: 'tsconfig.json',
}
const pmFact: BriefFact = { group: 'packageManager', label: 'pnpm', evidence: 'pnpm-lock.yaml' }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-brief-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('checkBrief', () => {
  it('keeps set fields, drops "Let Dim Factory decide" ones', () => {
    const r = checkBrief(
      {
        category: 'software',
        fields: {
          projectType: { choices: ['spa'], source: 'user' },
          styling: { choices: ['tailwind', 'component-library'], source: 'suggested' },
          hosting: { choices: [], source: 'user' },
          data: { choices: [], other: 'Turso', source: 'user' },
        },
      },
      software(),
      [],
    )
    expect(r).toEqual({
      ok: true,
      brief: {
        category: 'software',
        fields: {
          projectType: { choices: ['spa'], source: 'user' },
          styling: { choices: ['tailwind', 'component-library'], source: 'suggested' },
          data: { choices: [], other: 'Turso', source: 'user' },
        },
      },
    })
  })

  it('refuses unknown groups and options, two values in a single-choice group, Other where none is taken', () => {
    const bad = (fields: BriefInput['fields']): string[] => {
      const r = checkBrief({ category: 'software', fields }, software(), [])
      return r.ok ? [] : r.problems
    }
    expect(bad({ nope: { choices: ['x'] } })).toEqual(['The Software brief has no group "nope".'])
    expect(bad({ styling: { choices: ['velvet'] } })[0]).toContain('has no option "velvet"')
    expect(bad({ projectType: { choices: ['spa', 'cli'] } })).toEqual(['Project type takes one choice.'])
    expect(bad({ projectType: { choices: ['spa'], other: 'a game engine' } })).toEqual([
      'Project type takes one choice.',
    ])
    expect(bad({ approach: { choices: [], other: 'my own way' } })[0]).toContain('takes no "Other" text')
    const wrong = checkBrief({ category: 'documents', fields: {} }, software(), [])
    expect(wrong.ok).toBe(false)
  })

  it('a fact locks its group: a single-choice group keeps the repository value; a multi-choice one keeps additions', () => {
    const r = checkBrief(
      {
        category: 'software',
        fields: {
          uiFramework: { choices: ['vue'], source: 'user' },
          language: { choices: ['python'], source: 'user' },
        },
      },
      software(),
      [reactFact, tsFact],
    )
    expect(r.ok && r.brief.fields).toEqual({ language: { choices: ['python'], source: 'user' } })
    expect([...lockedGroups(software(), [reactFact, tsFact, pmFact])].sort()).toEqual([
      'language',
      'uiFramework',
    ])
  })
})

describe('renderBrief ({{brief}})', () => {
  it('renders the category, the facts, the choices with their sources, and the approach guidance', () => {
    const brief: BriefInput = {
      category: 'software',
      fields: {
        projectType: { choices: ['spa'], source: 'user' },
        styling: { choices: ['tailwind'], source: 'keyword' },
        data: { choices: ['sqlite'], source: 'suggested' },
        quality: { choices: ['accessible'], other: 'print friendly', source: 'user' },
        approach: { choices: ['test-first', 'walking-skeleton'], source: 'user' },
      },
    }
    const text = renderBrief(software(), brief, [reactFact, pmFact])
    expect(text).toContain('Category: Software')
    expect(text).toContain('Already in this repository (build on these; do not replace them):')
    expect(text).toContain('- UI framework: React 19 (package.json)')
    expect(text).toContain('- Package manager: pnpm (pnpm-lock.yaml)')
    expect(text).toContain('- Project type: Single-page app\n')
    expect(text).toContain('(from the task text)')
    expect(text).toContain('(suggested by Dim Factory, accepted by the user)')
    expect(text).toContain('Other: print friendly')
    expect(text).toMatch(/Approach:\n- Test-first: /)
    expect(text).toMatch(/- Walking skeleton \(guides the plan\): /)
    // Groups left to Dim Factory are not listed.
    expect(text).not.toContain('Hosting')
    expect(text).not.toMatch(/—/)
  })

  it('is empty when the brief says nothing and the folder has no facts', () => {
    expect(renderBrief(software(), { category: 'software', fields: {} }, [])).toBe('')
    expect(renderBrief(software(), { category: 'software', fields: {} }, [tsFact])).toContain('TypeScript')
  })

  it('briefRecord carries Test-first and the pack', () => {
    const [view] = readBuiltinPacks().filter((v) => v.pack.id === 'software')
    if (view === undefined) throw new Error('no pack')
    const brief: BriefInput = { category: 'software', fields: { approach: { choices: ['test-first'] } } }
    const rec = briefRecord(view, brief, [])
    expect(rec).toMatchObject({ testFirst: true, pack: { id: 'software', layer: 'builtin' } })
    expect(briefTestFirst(brief, view.pack)).toBe(true)
    expect(briefTestFirst({ category: 'software', fields: {} }, view.pack)).toBe(false)
    expect(briefTestFirst(brief, undefined)).toBe(false)
  })
})

describe('saved briefs', () => {
  it('saves per folder, reads back, Reset forgets it; an invalid file reads as none', async () => {
    const home = join(root, 'home')
    const a = join(root, 'a')
    const b = join(root, 'b')
    const brief: BriefInput = { category: 'software', fields: { styling: { choices: ['tailwind'] } } }
    await saveBrief(home, a, brief, 1)
    expect(await readSavedBrief(home, a)).toEqual(brief)
    expect(await readSavedBrief(home, b)).toBeNull()
    await saveBrief(home, a, null, 2)
    expect(await readSavedBrief(home, a)).toBeNull()
    mkdirSync(join(home, 'briefs'), { recursive: true })
    writeFileSync(briefFile(home, b), '{"brief":{"category":"BAD ID","fields":{}}}')
    expect(await readSavedBrief(home, b)).toBeNull()
  })
})

describe('BriefService', () => {
  const service = (home: string): BriefService =>
    new BriefService({ home, now: () => 5, suggest: { registry: new AdapterRegistry() } })

  it('forRun: checks the brief against the folder (facts lock), renders it, says Test-first', async () => {
    const home = join(root, 'home')
    const folder = join(root, 'project')
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' }, devDependencies: { typescript: '^5.0.0' } }),
    )
    const s = service(home)
    expect(await s.forRun(folder, undefined)).toBeUndefined()
    const p = await s.forRun(folder, {
      category: 'software',
      fields: {
        uiFramework: { choices: ['vue'], source: 'user' },
        approach: { choices: ['test-first'], source: 'user' },
      },
    })
    expect(p?.testFirst).toBe(true)
    expect(p?.record.input.fields['uiFramework']).toBeUndefined()
    expect(p?.text).toContain('React')
    await expect(
      s.forRun(folder, { category: 'software', fields: { styling: { choices: ['x'] } } }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    await expect(s.forRun(folder, { category: 'nosuch', fields: {} })).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    expect(
      await s.testFirst(folder, { category: 'software', fields: { approach: { choices: ['test-first'] } } }),
    ).toBe(true)
  })

  it('detect: packs, the category, facts and keyword fields per pack, the saved brief, the suggest target', async () => {
    const home = join(root, 'home')
    const folder = join(root, 'project')
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({ devDependencies: { tailwindcss: '^4.0.0' } }),
    )
    const s = service(home)
    await s.save(folder, { category: 'software', fields: { auth: { choices: ['oauth'], source: 'user' } } })
    const ctx = await s.detect({ folder, task: 'Build a landing page with a contact form' }, null)
    expect(ctx.packs.map((p) => p.pack.id)).toContain('software')
    expect(ctx.facts['software']?.some((f) => f.group === 'styling' && f.option === 'tailwind')).toBe(true)
    expect(ctx.saved).toEqual({
      category: 'software',
      fields: { auth: { choices: ['oauth'], source: 'user' } },
    })
    // Nothing can answer here: the target says why.
    expect(ctx.suggest).toMatchObject({ vendor: null })
    expect(ctx.suggest.reason).toBeDefined()
    // Keyword fields never touch a locked group or the approach group.
    for (const [pack, fields] of Object.entries(ctx.keywordFields)) {
      expect(fields['approach'], pack).toBeUndefined()
    }
    expect(ctx.keywordFields['software']?.['styling']).toBeUndefined()
  })
})
