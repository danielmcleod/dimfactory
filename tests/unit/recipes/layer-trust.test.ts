// A recipe as a config layer (above the project file, below the run's overrides; provenance `recipe` with
// `via: recipe:<id>`), its Auto grant in trust.json (bound to the recipe id and the file's sha256: an edited file needs
// a new grant), and the preflight checks folder.trust.recipeAuto and run.recipe.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DimFactoryConfig } from '@shared/config-schema.ts'
import { PROVENANCE_SOURCES } from '@shared/config-schema.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { recipeOverrides } from '@shared/recipes.ts'
import { planImplementOverrides, resolveBuiltinConfig } from '@core/config/builtins.ts'
import { parseConfigText, toConfigLayer } from '@core/config/load.ts'
import type { ConfigLayer } from '@core/config/load.ts'
import { describeProvenance, provenanceBadge } from '@core/config/provenance.ts'
import { ConfigResolveError, resolve } from '@core/config/resolve.ts'
import { getTrust, isRecipeAutoGranted, setTrust } from '@core/config/trust.ts'
import type { DimFactoryError } from '@core/errors.ts'
import { readBuiltinRecipes } from '@core/recipes/load.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import type { PreflightDeps, PreflightInput, PreflightRecipe } from '@core/preflight/engine.ts'
import { healthyChecks, healthyDeps, probeResult } from '../preflight/helpers.ts'

function projectLayer(value: DimFactoryConfig): ConfigLayer {
  const r = parseConfigText(JSON.stringify(value, null, 2), { file: 'project.json', scope: 'project' })
  const layer = toConfigLayer(r)
  if (layer === undefined) throw new Error(`invalid project layer: ${JSON.stringify(r.issues)}`)
  return layer
}

describe('resolve: the recipe layer', () => {
  const bugFix = readBuiltinRecipes().find((v) => v.recipe.id === 'bug-fix')?.recipe
  if (bugFix === undefined) throw new Error('no bug-fix')

  it('applies the recipe above the project file, with provenance recipe and via recipe:<id>', () => {
    const r = resolve({
      project: projectLayer({ passes: { fix: { rounds: 3 }, review: { acceptance: false } } }),
      recipe: { id: 'bug-fix', value: recipeOverrides(bugFix) },
    })
    expect(r.config.passes.fix.rounds).toBe(2)
    expect(r.config.passes.review.acceptance).toBe(true)
    expect(r.config.passes.plan.research).toBe(false)
    expect(r.config.verify.enabled).toBe(true)
    expect(r.provenance['/passes/fix/rounds']).toEqual({ source: 'recipe', via: 'recipe:bug-fix' })
    expect(r.provenance['/passes/review/acceptance']).toEqual({ source: 'recipe', via: 'recipe:bug-fix' })
    expect(r.provenance['/verify/enabled']).toEqual({ source: 'recipe', via: 'recipe:bug-fix' })
    expect(provenanceBadge(r.provenance['/passes/fix/rounds'])).toBe('recipe')
    expect(describeProvenance(r.provenance['/passes/fix/rounds'])).toBe('recipe (recipe:bug-fix)')
    expect(PROVENANCE_SOURCES).toContain('recipe')
  })

  it("the run layer (composer overrides, --set) wins over the recipe's", () => {
    const r = resolve({
      recipe: { id: 'bug-fix', value: recipeOverrides(bugFix) },
      run: { passes: { fix: { rounds: 1 } }, verify: { enabled: false } },
    })
    expect(r.config.passes.fix.rounds).toBe(1)
    expect(r.config.verify.enabled).toBe(false)
    expect(r.provenance['/passes/fix/rounds']?.source).toBe('run')
    // What the run left alone stays the recipe's.
    expect(r.provenance['/passes/review/acceptance']?.source).toBe('recipe')
  })

  it('a user or project recipe file is named in the provenance; Auto from a recipe still sets the modes', () => {
    const r = resolve({
      recipe: { id: 'ship', file: 'C:\\repo\\.dimfactory\\recipes\\ship.json', value: { auto: true } },
    })
    expect(r.config.auto).toBe(true)
    expect(r.config.passes.implement.mode).toBe('full')
    expect(r.provenance['/auto']).toEqual({
      source: 'recipe',
      file: 'C:\\repo\\.dimfactory\\recipes\\ship.json',
      via: 'recipe:ship',
    })
    expect(r.provenance['/passes/implement/mode']?.source).toBe('auto')
  })

  it('profiles are unaffected: the recipe layers on top of the selected profile', () => {
    const r = resolve({ profile: 'thorough', recipe: { id: 'bug-fix', value: recipeOverrides(bugFix) } })
    expect(r.config.profile).toBe('thorough')
    // thorough turns Clarify and Research on; Bug fix turns them off.
    expect(r.config.passes.plan.clarify).toBe(false)
    expect(r.config.passes.plan.research).toBe(false)
    // thorough's own security advisor stays (Bug fix leaves it alone).
    expect(r.config.passes.security.enabled).toBe(true)
  })

  it('a recipe layer that is not a run layer is refused (ConfigResolveError, source recipe)', () => {
    let err: unknown
    try {
      resolve({ recipe: { id: 'bad', value: { vendors: {} } as never } })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConfigResolveError)
    expect((err as ConfigResolveError).message).toContain('The recipe "bad" is invalid')
    expect((err as ConfigResolveError).issues[0]?.source).toBe('recipe')
  })
})

describe('trust.json recipeAuto', () => {
  let root: string
  let home: string
  let folder: string
  const folderScope = (): { scopeRoot: string; folderKey: string } => ({
    scopeRoot: folder,
    folderKey: '0011223344556677',
  })
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'df-recipe-trust-'))
    home = join(root, 'home')
    folder = join(root, 'repo')
    mkdirSync(home, { recursive: true })
    mkdirSync(folder, { recursive: true })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)

  it('is bound to the recipe id and the sha256 of its file: an edited file needs a new grant', async () => {
    const opts = { home, folderScope: folderScope() }
    const granted = await setTrust(folder, { kind: 'recipeAuto', recipeId: 'ship' }, true, {
      ...opts,
      recipeSha: A,
    })
    expect(granted.grants.recipeAuto?.['ship']?.sha).toBe(A)
    expect(isRecipeAutoGranted(granted.grants, 'ship', A)).toBe(true)
    expect(isRecipeAutoGranted(granted.grants, 'ship', B)).toBe(false)
    expect(isRecipeAutoGranted(granted.grants, 'other', A)).toBe(false)
    expect(isRecipeAutoGranted(granted.grants, 'ship', null)).toBe(false)
    // The version shown is not the file's now: refused.
    await expect(
      setTrust(folder, { kind: 'recipeAuto', recipeId: 'ship', recipeSha: A }, true, {
        ...opts,
        recipeSha: B,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<DimFactoryError>)
    // No such project recipe: nothing to trust.
    await expect(
      setTrust(folder, { kind: 'recipeAuto', recipeId: 'gone' }, true, { ...opts, recipeSha: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A second recipe keeps the first one's grant; revoking one leaves the other.
    await setTrust(folder, { kind: 'recipeAuto', recipeId: 'deploy-it', recipeSha: B }, true, {
      ...opts,
      recipeSha: B,
    })
    const both = await getTrust(folder, opts)
    expect(Object.keys(both.grants.recipeAuto ?? {}).sort()).toEqual(['deploy-it', 'ship'])
    const revoked = await setTrust(folder, { kind: 'recipeAuto', recipeId: 'ship' }, false, opts)
    expect(revoked.grants.recipeAuto).toEqual({ 'deploy-it': { at: expect.any(Number) as number, sha: B } })
  })
})

describe('preflight: folder.trust.recipeAuto and run.recipe', () => {
  let root: string
  let folder: string
  let home: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'df-recipe-preflight-'))
    folder = join(root, 'project')
    home = join(root, 'home')
    mkdirSync(folder, { recursive: true })
    mkdirSync(home, { recursive: true })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
  const byId = (r: PreflightReport, id: string): CheckResult | undefined => all(r).find((x) => x.id === id)
  const SHA = 'c'.repeat(64)
  const recipe = (over: Partial<PreflightRecipe> = {}): PreflightRecipe => ({
    id: 'ship',
    label: 'Ship it',
    layer: 'project',
    path: join(folder, '.dimfactory', 'recipes', 'ship.json'),
    sha256: SHA,
    summary: 'Turns on Auto mode.',
    setsAuto: true,
    verifyCommands: 1,
    ...over,
  })

  async function run(input: PreflightInput, over: Partial<PreflightDeps> = {}): Promise<PreflightReport> {
    const engine = createPreflightEngine(healthyDeps({ home, ...over }))
    engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
    const config = resolveBuiltinConfig({ profile: 'claude-only', overrides: planImplementOverrides() })
    return engine.run('live', { folder, config, ...input })
  }

  it('a project recipe that turns Auto on blocks (trust_required) with a grant and a this-run fix', async () => {
    const r = await run({ recipe: recipe() }, { trustGrants: () => Promise.resolve({}) })
    const c = r.blocking.find((x) => x.id === 'folder.trust.recipeAuto')
    expect(c).toMatchObject({ category: 'trust_required', title: 'This project recipe turns on Auto mode' })
    expect(c?.detail).toContain(
      'Verify commands a recipe adds still ask for your trust before they first run.',
    )
    expect(c?.detail).not.toMatch(/[\u2013\u2014]/)
    expect(c?.recovery[0]).toMatchObject({
      kind: 'grant',
      grant: 'recipeAuto',
      recipeId: 'ship',
      recipeSha: SHA,
    })
    expect(c?.recovery[1]).toMatchObject({
      kind: 'config_patch',
      target: 'runOverrides',
      ops: [{ op: 'add', path: '/auto', value: false }],
    })
    expect(r.ok).toBe(false)
  })

  it('passes with the grant for this version of the file; a grant for an older version asks again', async () => {
    const ok = await run(
      { recipe: recipe() },
      { trustGrants: () => Promise.resolve({ recipeAuto: { ship: { at: 1, sha: SHA } } }) },
    )
    expect(ok.blocking.map((x) => x.id)).not.toContain('folder.trust.recipeAuto')
    expect(byId(ok, 'folder.trust.recipeAuto')?.status).toBe('pass')
    const stale = await run(
      { recipe: recipe() },
      { trustGrants: () => Promise.resolve({ recipeAuto: { ship: { at: 1, sha: 'd'.repeat(64) } } }) },
    )
    expect(stale.blocking.find((x) => x.id === 'folder.trust.recipeAuto')?.detail).toContain(
      'The file changed since you allowed it',
    )
  })

  it('a recipe that does not turn Auto on from the project needs no grant; run.recipe names it', async () => {
    const r = await run({ recipe: recipe({ setsAuto: false, layer: 'builtin', label: 'Bug fix' }) })
    expect(byId(r, 'folder.trust.recipeAuto')).toBeUndefined()
    const info = byId(r, 'run.recipe')
    expect(info).toMatchObject({ status: 'pass', title: 'Recipe: Bug fix' })
    expect(info?.detail.startsWith('Built in. Turns on Auto mode.')).toBe(true)
    expect(info?.detail).toContain('It adds 1 verify command; each asks for your trust before it first runs.')
    const none = await run({})
    expect(byId(none, 'run.recipe')).toBeUndefined()
  })
})
