// direct.md, the Quick shape's Implement prompt: the user's task as it is, with only the essential context (the Brief,
// the project's notes, the run hint, the safety notes), never a wrapper that narrows the work. And Easy's build passes
// at the user's own Extensions level, the read-only ones at none, and a note on the
// build passes that fits the result to someone who does not write code.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILTIN_PROMPTS_DIR, builtinTemplatePath } from '@core/prompts/resolve.ts'
import { render, validateTemplate } from '@core/prompts/template.ts'
import { easyOverrides } from '@core/easy/overrides.ts'
import { resolve } from '@core/config/resolve.ts'
import { RUN_LIMITS_NONE } from '@shared/config-schema.ts'
import { PASS_NAMES } from '@shared/run.ts'
import { CLOSING_NOTE, PLAIN_PERSON_NOTE, buildPrompt, startOptionsFor } from '@core/supervisor/effects.ts'
import { runConfigFromResolved } from '@core/supervisor/machine.ts'
import type { EffectOf } from '@core/supervisor/types.ts'
import { makeRun } from '../supervisor/helpers.ts'

const text = readFileSync(builtinTemplatePath('direct'), 'utf8')

describe('direct.md', () => {
  it('is in the built-in prompts and valid as an Implement template', () => {
    expect(builtinTemplatePath('direct').startsWith(BUILTIN_PROMPTS_DIR)).toBe(true)
    const check = validateTemplate(text, 'implement')
    expect(check.issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('starts with the task, as the user wrote it', () => {
    expect(text.startsWith('{{task}}\n')).toBe(true)
  })

  it('has no wording that narrows or restricts the work', () => {
    for (const phrase of [
      /stay within/i,
      /scope/i,
      /do not refactor/i,
      /unrelated/i,
      /only (?:change|edit|touch)/i,
      /minimal/i,
      /follow (?:it|the plan)/i,
      /approved plan/i,
      /\{\{plan\}\}/,
    ])
      expect(text, String(phrase)).not.toMatch(phrase)
  })

  it('keeps the essentials: the Brief, the notes, the run hint and the safety notes', () => {
    expect(text).toContain('{{brief}}')
    expect(text).toContain('{{memory}}')
    expect(text).toContain('{{run}}')
    expect(text).toMatch(/Do not commit, push or switch git branches/)
    expect(text).toMatch(/secrets or API keys/)
  })

  it('renders the task untouched when nothing else is set', () => {
    const task = 'Make the header sticky.\nKeep the logo on the left.'
    const out = render(
      text,
      { task, brief: null, memory: null, run: null, state: null, acceptance: null, tests: null },
      { template: 'implement' },
    )
    expect(out.text.startsWith(`${task}\n`)).toBe(true)
    expect(out.text).not.toContain("The user's brief")
  })

  it('asks for what the person checks: tests for the change, docs, clear errors (the closing note adds the summary)', () => {
    expect(text).toMatch(/add a test that would have caught it/)
    expect(text).toMatch(/if it has none, do not add a test framework/)
    expect(text).toMatch(/update the README or usage text/)
    expect(text).toMatch(/Error messages name the bad value/)
    expect(text).toMatch(/opens without installing anything/)
  })

  it('has no em dashes', () => {
    expect(text).not.toMatch(/\u2014/)
  })
})

describe("Easy: the user's own tools on the passes that build", () => {
  const run = easyOverrides({ profile: 'claude-only', skipPlanCheck: false, limits: RUN_LIMITS_NONE })

  it('Implement and Fix pass through by default; Plan, Review, Critic and Security stay at none', () => {
    const { config } = resolve({ run })
    const want = (p: string): string => (p === 'implement' || p === 'fix' ? 'passthrough' : 'none')
    for (const p of PASS_NAMES) expect(config.passes[p].extensions, p).toBe(want(p))
  })

  it("the user's configured level for Implement is the one Easy's build passes run at", () => {
    const { config } = resolve({
      user: { value: { passes: { implement: { extensions: 'allowed' } } } },
      run,
    })
    expect(config.passes.implement.extensions).toBe('allowed')
    expect(config.passes.fix.extensions).toBe('allowed')
    expect(config.passes.review.extensions).toBe('none')
  })

  it("Test-first's Tests step and the Deploy step run on Implement's level; Explain and the acceptance review at none", () => {
    const { config } = resolve({ run })
    const state = makeRun(runConfigFromResolved(config))
    const spawn = (step: EffectOf<'spawn'>['step']): EffectOf<'spawn'> => ({
      t: 'spawn',
      step,
      attempt: 1,
      spawnNo: 1,
      launch: { fresh: {} },
      vendor: 'claude',
      model: null,
      mode: step === 'explain' || step === 'acceptance' ? 'readonly' : 'autoedit',
    })
    const level = (step: EffectOf<'spawn'>['step']): string | undefined =>
      startOptionsFor({ runId: state.runId, cwd: 'C:\\x', config, state, spawn: spawn(step), prompt: '' })
        .extensions?.level
    expect(level('implement')).toBe('passthrough')
    expect(level('fix')).toBe('passthrough')
    expect(level('tests')).toBe('passthrough')
    expect(level('deploy')).toBe('passthrough')
    expect(level('explain')).toBe('none')
    expect(level('acceptance')).toBe('none')
    expect(level('plan')).toBe('none')
  })

  it('Implement and Fix get the note for someone who does not write code; a run outside Easy does not', () => {
    const prompt = (
      cfg: ReturnType<typeof resolve>['config'],
      step: 'implement' | 'fix' | 'review',
    ): string => buildPrompt(makeRun(runConfigFromResolved(cfg)), cfg, { step, launch: { fresh: {} } }).text
    const easy = resolve({ run }).config
    expect(prompt(easy, 'implement').trimEnd().endsWith(PLAIN_PERSON_NOTE)).toBe(true)
    expect(prompt(easy, 'fix')).toContain(PLAIN_PERSON_NOTE)
    expect(prompt(easy, 'review')).not.toContain(PLAIN_PERSON_NOTE)
    expect(prompt(resolve({}).config, 'implement')).not.toContain(PLAIN_PERSON_NOTE)
    expect(PLAIN_PERSON_NOTE).not.toMatch(/\u2014/)
  })

  it('Implement and Fix, on every run, end with the closing note about the whole job; readers do not get it', () => {
    const cfg = resolve({}).config
    const prompt = (step: 'implement' | 'fix' | 'review'): string =>
      buildPrompt(makeRun(runConfigFromResolved(cfg)), cfg, { step, launch: { fresh: {} } }).text
    expect(prompt('implement').trimEnd().endsWith(CLOSING_NOTE)).toBe(true)
    expect(prompt('fix').trimEnd().endsWith(CLOSING_NOTE)).toBe(true)
    expect(prompt('review')).not.toContain(CLOSING_NOTE)
    expect(CLOSING_NOTE).toMatch(/whole job/)
    expect(CLOSING_NOTE).toMatch(/never by an absolute path/)
    expect(CLOSING_NOTE).toMatch(/never print a secret/)
    expect(CLOSING_NOTE).not.toMatch(/\u2014/)
  })

  it('Fix sees what the person was told so far, with paths made relative; a resumed session already has it', () => {
    const cfg = resolve({}).config
    const state = makeRun(runConfigFromResolved(cfg))
    state.folder = '/home/me/shop'
    state.steps.implement.result = 'Fixed /home/me/shop/src/coupons.js. All 9 tests pass.'
    const fresh = buildPrompt(state, cfg, { step: 'fix', launch: { fresh: {} } }).text
    expect(fresh).toContain('What the person was told about the result before these fixes')
    expect(fresh).toContain('Fixed src/coupons.js. All 9 tests pass.')
    const resumed = buildPrompt(state, cfg, {
      step: 'fix',
      launch: { resume: { sessionId: 's1' }, session: { reuse: true, sessionId: 's1' } },
    }).text
    expect(resumed).not.toContain('What the person was told')
    expect(resumed.trimEnd().endsWith(CLOSING_NOTE)).toBe(true)
  })

  it('a forced depth goes with the overrides (Auto adds nothing)', () => {
    expect(
      easyOverrides({ profile: 'balanced', skipPlanCheck: false, limits: RUN_LIMITS_NONE, depth: 'direct' })
        .depth,
    ).toBe('direct')
    expect(
      easyOverrides({ profile: 'balanced', skipPlanCheck: false, limits: RUN_LIMITS_NONE, depth: 'auto' })
        .depth,
    ).toBeUndefined()
  })
})
