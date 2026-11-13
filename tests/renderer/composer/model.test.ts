// Pure composer helpers (Quick composer, the Critic-swap rule, the Fix row's "Fresh, different vendor",
// folder.lock / folder.git answers): the pending overrides (prune, identity, row save/reset/restore), core's Critic
// swap and Fix session suggestions as formatted, reading core's preflight answers, the Run reasons and model-id parsing.
import { describe, expect, it } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { ComposerSuggestions } from '@shared/ipc.ts'
import { leafPointers } from '@renderer/pages/dashboard/composer/actions.ts'
import {
  blockedReason,
  criticSwapTarget,
  fixSessionOf,
  modeChoices,
  modelHasNoPricing,
  notGitRepo,
  otherFixVendor,
  parseModelInput,
  planModeText,
  provenanceTitle,
  queueCheck,
  vendorChoices,
} from '@renderer/pages/dashboard/composer/model.ts'
import type { ResolvedView } from '@renderer/pages/dashboard/composer/model.ts'
import {
  countOverrides,
  dropPass,
  isEmptyOverrides,
  overridesForRequest,
  passOverride,
  restorePass,
  setAuto,
  setGate,
  setPassValues,
  setProfile,
  settle,
} from '@renderer/pages/dashboard/composer/overrides.ts'
import { baseConfig, check, probe, report } from './fixtures.tsx'

const cfg = (edit?: (c: ReturnType<typeof baseConfig>) => void): ResolvedView => {
  const c = baseConfig()
  edit?.(c)
  return c
}

describe('pending overrides', () => {
  it('sets and removes pass fields, prunes empty branches and keeps identity when nothing changed', () => {
    const a = setPassValues({}, 'plan', { model: 'sonnet' })
    expect(a).toEqual({ passes: { plan: { model: 'sonnet' } } })
    expect(setPassValues(a, 'plan', { model: 'sonnet' })).toBe(a)
    const b = setPassValues(a, 'fix', { reuseSession: false, vendor: 'codex', model: null })
    expect(passOverride(b, 'fix')).toEqual({ reuseSession: false, vendor: 'codex', model: null })
    const c = setPassValues(b, 'fix', { reuseSession: true }, ['vendor', 'model'])
    expect(passOverride(c, 'fix')).toEqual({ reuseSession: true })
    expect(dropPass(dropPass(c, 'fix'), 'plan')).toEqual({})
    expect(isEmptyOverrides(dropPass(dropPass(c, 'fix'), 'plan'))).toBe(true)
    expect(dropPass(c, 'review')).toBe(c)
  })

  it('restores a row exactly (Undo) and counts leaves', () => {
    const o: RunOverrides = setGate(
      setAuto(setPassValues({}, 'plan', { model: 'x', enabled: false }), true),
      'afterPlan',
      false,
    )
    expect(countOverrides(o)).toBe(4)
    const row = passOverride(o, 'plan')
    const reset = dropPass(o, 'plan')
    expect(reset).toEqual({ auto: true, gates: { afterPlan: false } })
    expect(restorePass(reset, 'plan', row)).toEqual(o)
    expect(restorePass(reset, 'plan', undefined)).toEqual(reset)
  })

  it('sends overrides only when there are some; a cleared profile goes away', () => {
    expect(overridesForRequest({})).toBeUndefined()
    expect(overridesForRequest({ passes: {} })).toBeUndefined()
    expect(setProfile(setProfile({}, 'fast'), null)).toEqual({})
    expect(settle({ passes: { plan: { model: 'a' } } }, { passes: { plan: { model: 'a' } } })).toEqual({
      passes: { plan: { model: 'a' } },
    })
  })

  it('lists the pointers a save wrote (for undoing a save that created the file)', () => {
    expect(leafPointers({ passes: { plan: { model: 'a', enabled: false } }, auto: true })).toEqual([
      '/passes/plan/model',
      '/passes/plan/enabled',
      '/auto',
    ])
  })
})

describe('core’s suggestions and the vendor picker', () => {
  // The rules (Critic swap, the Fix session, the other ready vendor) are core's: tests/unit/config/suggestions.test.ts.
  const suggestions = (over: Partial<ComposerSuggestions> = {}): ComposerSuggestions => ({
    criticSwap: { to: 'codex' },
    fixSession: { choice: 'reuse' },
    otherFixVendor: 'codex',
    ...over,
  })

  it('formats core’s Critic swap and "different vendor" answers, and nothing without them', () => {
    expect(criticSwapTarget(suggestions())).toBe('codex')
    expect(criticSwapTarget(suggestions({ criticSwap: null }))).toBeNull()
    expect(criticSwapTarget(undefined)).toBeNull()
    expect(otherFixVendor(suggestions())).toBe('codex')
    expect(otherFixVendor(suggestions({ otherFixVendor: null }))).toBeNull()
    expect(otherFixVendor(undefined)).toBeNull()
  })

  it('reads the Fix session from core, else (an older core) from the config as stated', () => {
    const fresh = suggestions({ fixSession: { choice: 'fresh-other', reason: 'vendor-differs' } })
    // A Fix vendor override with reuseSession still on: core says Fix starts fresh on the other vendor.
    expect(
      fixSessionOf(
        cfg((c) => void (c.passes.fix.vendor = 'codex')),
        fresh,
      ),
    ).toBe('fresh-other')
    expect(fixSessionOf(cfg(), undefined)).toBe('reuse')
    expect(
      fixSessionOf(
        cfg((c) => void (c.passes.fix.reuseSession = false)),
        undefined,
      ),
    ).toBe('fresh')
  })

  it('builds the vendor picker: primary first, More for probed or unbuilt vendors and local presets', () => {
    const choices = vendorChoices(
      [
        probe('claude', 'ready'),
        probe('codex', 'login-needed'),
        probe('gemini', 'not-installed'),
        probe('grok', 'ready'),
      ],
      [{ id: 'local-qwen', label: 'Qwen (local)' }],
      'muse',
    )
    expect(choices.map((c) => [c.id, c.group, c.disabled, c.note ?? null])).toEqual([
      ['claude', 'primary', false, null],
      ['codex', 'primary', false, 'Login needed'],
      ['gemini', 'more', true, 'Not installed'],
      ['grok', 'more', false, null],
      ['local-qwen', 'more', false, null],
      ['muse', 'more', false, null],
    ])
    expect(choices[2]?.title).toBe('npm install -g gemini-cli')
  })
})

describe('reading core’s preflight answers', () => {
  it('finds the queue, a non-git folder and the plan mode in the report', () => {
    expect(queueCheck(report())).toBeNull()
    const queued = report({ info: [check('folder.lock', { title: 'Queues behind run #3 (paused 2d)' })] })
    expect(queueCheck(queued)?.title).toBe('Queues behind run #3 (paused 2d)')
    expect(queueCheck(null)).toBeNull()
    expect(notGitRepo(report())).toBe(false)
    expect(notGitRepo(report({ info: [check('folder.git', { title: 'Not a git repository' })] }))).toBe(true)
    expect(
      notGitRepo(
        report({
          blocking: [
            check('folder.git', {
              status: 'fail',
              title: 'Isolated runs need a git repository',
              detail: 'C:\\x is not a git repository.',
            }),
          ],
        }),
      ),
    ).toBe(true)
    expect(planModeText(report())).toBe('Native plan')
    expect(planModeText(report({ info: [] }))).toBeNull()
  })

  it('words the disabled Run reason with at most three titles', () => {
    const c = (t: string) => check(t, { status: 'fail', title: t })
    expect(blockedReason([c('A')])).toBe('Fix 1 issue to run: A')
    expect(blockedReason([c('A'), c('B'), c('C')])).toBe('Fix 3 issues to run: A; B; C')
    expect(blockedReason([c('A'), c('B'), c('C'), c('D'), c('E')])).toBe(
      'Fix 5 issues to run: A; B; C; and 2 more',
    )
  })
})

describe('modes, models and provenance', () => {
  it('offers Approve everything only with Auto, and one mode for read-only passes', () => {
    expect(modeChoices('implement', false)).toEqual(['readonly', 'autoedit'])
    expect(modeChoices('fix', true)).toEqual(['readonly', 'autoedit', 'full'])
    expect(modeChoices('critic', true)).toEqual(['readonly'])
  })

  it('parses model ids like the config does', () => {
    expect(parseModelInput('  ')).toEqual({ ok: true, model: null })
    expect(parseModelInput(' gpt-5.1-codex ')).toEqual({ ok: true, model: 'gpt-5.1-codex' })
    expect(parseModelInput('claude-opus-4[1m]')).toEqual({ ok: true, model: 'claude-opus-4[1m]' })
    expect(parseModelInput('a b').ok).toBe(false)
    expect(parseModelInput('x'.repeat(129)).ok).toBe(false)
  })

  it('flags a model without pricing from core’s model list or the estimate', () => {
    const opts = [
      { id: 'a', source: 'cli' as const, hasPricing: true, aliases: ['alias-a'] },
      { id: 'b', source: 'cli' as const, hasPricing: false },
    ]
    expect(modelHasNoPricing('claude', null, opts, null)).toBe(false)
    expect(modelHasNoPricing('claude', 'alias-a', opts, null)).toBe(false)
    expect(modelHasNoPricing('claude', 'b', opts, null)).toBe(true)
  })

  it('explains each provenance source', () => {
    expect(provenanceTitle({ source: 'default', via: 'profile:balanced' })).toBe('From the balanced profile')
    expect(provenanceTitle({ source: 'project', file: 'C:\\r\\dimfactory.json', line: 3 })).toBe(
      'Project settings: C:\\r\\dimfactory.json:3',
    )
    expect(provenanceTitle({ source: 'run' })).toBe('This run only')
    expect(provenanceTitle({ source: 'cli' })).toBe('Left to the CLI: it uses its own default model')
  })
})
