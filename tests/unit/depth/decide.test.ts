// Adaptive depth's decision (a forced depth, an explicit profile, else the classifier), the Quick shape as a run layer
// (Plan off, the direct prompt, one reviewer on another vendor when one is ready, Critic off), how it resolves, and the
// folder facts it reads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolve } from '@core/config/resolve.ts'
import { runConfigFromResolved } from '@core/supervisor/machine.ts'
import {
  DEPTH_CHOSEN_REASON,
  DIRECT_TEMPLATE,
  decideDepth,
  directLayer,
  directReviewer,
  withDirect,
} from '@core/depth/decide.ts'
import { DEPTH_REASON } from '@core/depth/classify.ts'
import { folderSize } from '@core/depth/folder.ts'
import { DEPTH_SUMMARY, depthLine } from '@shared/depth.ts'

const existing = { exists: true, files: 40 }

describe('decideDepth', () => {
  it('auto: the classifier decides (a small change is Quick)', () => {
    const d = decideDepth({
      setting: undefined,
      profile: 'balanced',
      profileChosen: false,
      input: { task: 'Fix the off-by-one in the pager', folder: existing },
    })
    expect(d).toEqual({
      depth: 'direct',
      source: 'auto',
      reason: DEPTH_REASON.small,
      signals: ['small-change'],
    })
  })

  it('a forced depth wins, in the run or in the settings, with its own words', () => {
    const base = {
      profile: 'balanced',
      profileChosen: true,
      input: { task: 'Add sign-in', folder: existing },
    } as const
    expect(decideDepth({ ...base, setting: 'direct', settingFrom: 'run' })).toEqual({
      depth: 'direct',
      source: 'chosen',
      reason: DEPTH_CHOSEN_REASON.run('Quick'),
      signals: [],
    })
    expect(decideDepth({ ...base, setting: 'full', settingFrom: 'settings' }).reason).toBe(
      DEPTH_CHOSEN_REASON.settings('Thorough'),
    )
  })

  it("an explicit profile choice keeps that profile's own pipeline", () => {
    const run = decideDepth({
      setting: 'auto',
      profile: 'balanced',
      profileChosen: true,
      input: { task: 'Fix the typo', folder: existing },
    })
    expect(run).toMatchObject({ depth: 'full', source: 'profile', profile: 'balanced' })
    // A profile that is not one first launch picks by readiness (thorough, fast, a custom one) counts as chosen.
    for (const profile of ['thorough', 'fast', 'my-team']) {
      expect(
        decideDepth({
          setting: undefined,
          profile,
          profileChosen: false,
          input: { task: 'x', folder: existing },
        }).source,
      ).toBe('profile')
    }
  })

  it('the readiness profiles leave it to the classifier', () => {
    for (const profile of ['balanced', 'claude-only', 'codex-only']) {
      expect(
        decideDepth({
          setting: undefined,
          profile,
          profileChosen: false,
          input: { task: 'Fix the typo', folder: existing },
        }).source,
      ).toBe('auto')
    }
  })

  it('reads as one line for the composer and the Easy confirm screen', () => {
    const d = decideDepth({
      setting: undefined,
      profile: 'balanced',
      profileChosen: false,
      input: { task: 'Fix the typo', folder: existing },
    })
    expect(depthLine(d)).toBe(`${DEPTH_SUMMARY.direct}. ${DEPTH_REASON.small}`)
    expect(DEPTH_SUMMARY.direct).toBe('Quick: one strong session plus checks')
    expect(DEPTH_SUMMARY.full).toMatch(/^Thorough: plan, build, two reviewers/)
  })
})

describe('the Quick shape', () => {
  const balanced = resolve({}).config
  const claudeOnly = resolve({ run: { profile: 'claude-only' } }).config

  it('balanced: Plan and Critic off, Implement on direct.md, Review stays on Claude (another vendor already)', () => {
    expect(directReviewer(balanced, ['claude', 'codex'])).toBeUndefined()
    expect(directLayer(balanced, ['claude', 'codex'])).toEqual({
      passes: {
        plan: { enabled: false, clarify: false, research: false },
        implement: { promptTemplate: DIRECT_TEMPLATE },
        review: { enabled: true, acceptance: false },
        critic: { enabled: false },
      },
    })
  })

  it('claude-only with Codex ready: the one review goes to Codex (an independent vendor)', () => {
    expect(directReviewer(claudeOnly, ['claude', 'codex'])).toEqual({ vendor: 'codex', model: null })
  })

  it('claude-only with nobody else ready: the same vendor reviews in a fresh session', () => {
    expect(directReviewer(claudeOnly, ['claude'])).toBeUndefined()
  })

  it('a template the user chose for Implement stays', () => {
    const own = resolve({ run: { passes: { implement: { promptTemplate: 'implement' } } } }).config
    expect(directLayer(own, []).passes?.implement).toEqual({ promptTemplate: DIRECT_TEMPLATE })
    const custom = { ...balanced, passes: { ...balanced.passes } }
    custom.passes.implement = {
      ...custom.passes.implement,
      promptTemplate: { ...custom.passes.implement.promptTemplate, name: 'mine' },
    }
    expect(directLayer(custom, []).passes?.implement).toBeUndefined()
  })

  it("the run's own overrides win over the shape (the user may turn Plan back on)", () => {
    const o = withDirect(balanced, [], { passes: { plan: { enabled: true } }, auto: false })
    expect(o.passes?.plan).toEqual({ enabled: true, clarify: false, research: false })
    expect(o.auto).toBe(false)
  })

  it('resolves to the shape the Run view shows: Plan off, Implement on direct.md with pass through, one reviewer', () => {
    const { config } = resolve({ run: withDirect(balanced, ['claude', 'codex'], { depth: 'direct' }) })
    expect(config.depth).toBe('direct')
    expect(config.passes.plan.enabled).toBe(false)
    expect(config.passes.critic.enabled).toBe(false)
    expect(config.passes.review.enabled).toBe(true)
    expect(config.passes.implement.promptTemplate.name).toBe('direct')
    expect(config.passes.implement.extensions).toBe('passthrough')
    const rc = runConfigFromResolved(config)
    expect(rc.fixTrigger).toBe('evidence')
    expect(rc.continuity).toBe(true)
  })

  it('a user who lowered Implement to the Allowed list keeps it in a Quick run', () => {
    const { config } = resolve({
      user: { file: 'u', value: { passes: { implement: { extensions: 'allowed' } } } } as never,
      run: withDirect(balanced, [], { depth: 'direct' }),
    })
    expect(config.passes.implement.extensions).toBe('allowed')
  })

  it('the keys resolve only when a layer sets them (existing resolved configs keep their shape)', () => {
    expect(balanced.depth).toBeUndefined()
    expect(balanced.passes.fix.trigger).toBeUndefined()
    expect(balanced.passes.implement.continuePlan).toBeUndefined()
    const off = resolve({
      run: { passes: { fix: { trigger: 'all' }, implement: { continuePlan: false } } },
    }).config
    const rc = runConfigFromResolved(off)
    expect(rc.fixTrigger).toBeUndefined()
    expect(rc.continuity).toBeUndefined()
  })
})

describe('folderSize', () => {
  it('a folder with only a .env file holds no project yet', async () => {
    const d = mkdtempSync(join(tmpdir(), 'depth-env-'))
    writeFileSync(join(d, '.env'), 'KEY=x')
    writeFileSync(join(d, '.env.local'), 'KEY=x')
    expect(await folderSize(d)).toEqual({ exists: true, files: 0 })
    rmSync(d, { recursive: true, force: true })
  })

  it('a folder of data is not called an existing project', async () => {
    const d = mkdtempSync(join(tmpdir(), 'depth-data-'))
    writeFileSync(join(d, 'sales.csv'), 'a,b')
    const size = await folderSize(d)
    expect(size).toEqual({ exists: true, files: 1, dataOnly: true })
    const v = decideDepth({
      setting: undefined,
      profile: 'balanced',
      profileChosen: false,
      input: { task: 'Make a report', folder: size },
    })
    expect(v.reason).toBe(DEPTH_REASON.smallData)
    expect(v.depth).toBe('direct')
    writeFileSync(join(d, 'app.js'), 'x')
    expect((await folderSize(d)).dataOnly).toBeUndefined()
    rmSync(d, { recursive: true, force: true })
  })

  const root = mkdtempSync(join(tmpdir(), 'dim-depth-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('a missing folder, a folder with only starter files, and a project', async () => {
    expect(await folderSize(join(root, 'nope'))).toEqual({ exists: false, files: 0 })
    const fresh = join(root, 'fresh')
    mkdirSync(join(fresh, '.git'), { recursive: true })
    writeFileSync(join(fresh, 'README.md'), '# x')
    writeFileSync(join(fresh, '.gitignore'), 'node_modules')
    writeFileSync(join(fresh, '.git', 'HEAD'), 'ref')
    expect(await folderSize(fresh)).toEqual({ exists: true, files: 0 })
    const proj = join(root, 'proj')
    mkdirSync(join(proj, 'src'), { recursive: true })
    mkdirSync(join(proj, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(proj, 'src', 'a.ts'), '')
    writeFileSync(join(proj, 'src', 'b.ts'), '')
    writeFileSync(join(proj, 'package.json'), '{}')
    writeFileSync(join(proj, 'node_modules', 'x', 'index.js'), '')
    expect(await folderSize(proj)).toEqual({ exists: true, files: 3 })
    expect(await folderSize(proj, 2)).toEqual({ exists: true, files: 2 })
  })
})
