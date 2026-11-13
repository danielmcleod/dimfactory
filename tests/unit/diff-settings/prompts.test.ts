// Settings → Prompts (templates; "Prompts: tabs; placeholder chips; Implement word count;
// user/project scope; diff vs default; reset with undo"): config/prompt-files.ts. prompts.get carries the builtin
// default, the placeholders the text uses, its issues and which scopes override it; prompts.save refuses an unknown
// placeholder (VALIDATION, line-numbered), saves a missing required one with a warning, and returns what the scope
// held before so the toast's Undo can put it back (a reset is text null).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getPromptView, savePrompt } from '../../../src/core/config/prompt-files.ts'
import type { PromptFileOptions } from '../../../src/core/config/prompt-files.ts'
import { readBuiltinTemplate, resolveStepTemplates } from '../../../src/core/prompts/resolve.ts'
import { STEP_PROMPT_NAMES } from '../../../src/shared/prompt-names.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function opts(project = true): PromptFileOptions {
  const home = process.env['DIM_FACTORY_HOME'] ?? ''
  if (!project) return { home }
  const folder = mkdtempSync(join(tmpdir(), 'dim-factory-prompts-'))
  dirs.push(folder)
  return { home, projectRoot: folder, folderKey: '0123456789abcdef', scopeRoot: folder }
}

describe('prompts.get (the Settings → Prompts fields)', () => {
  it('the builtin template: its placeholders, no issues, no overrides, the default text for the diff view', async () => {
    const o = opts()
    const v = await getPromptView('review', o)
    expect(v).toMatchObject({ name: 'review', source: 'builtin', path: null, editable: true })
    expect(v.text).toBe(readBuiltinTemplate('review'))
    expect(v.defaultText).toBe(v.text)
    expect(v.placeholders).toContain('diff')
    expect(v.issues).toEqual([])
    expect(v.overrides).toEqual({ user: false, project: false })
    expect((await getPromptView('plan', opts(false))).overrides).toEqual({ user: false, project: null })
  })

  it('the implement template stays under 200 words and needs task and plan', async () => {
    const v = await getPromptView('implement', opts())
    expect(v.wordCount).toBeLessThan(200)
    expect(v.required).toEqual(['task', 'plan'])
  })

  it('internal prompts are not served', async () => {
    await expect(getPromptView('heal', opts())).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('prompts.save', () => {
  it('refuses an unknown placeholder with its line and column, writing nothing', async () => {
    const o = opts()
    await expect(
      savePrompt({ ...o, name: 'review', scope: 'project', text: 'Look at this:\n\n  {{dif}}\n' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('3:3: Unknown placeholder {{dif}}') as unknown,
      details: [expect.objectContaining({ code: 'unknown-placeholder', line: 3, col: 3 })] as unknown,
    })
    expect(existsSync(join(o.projectRoot ?? '', '.dimfactory', 'prompts', 'review.md'))).toBe(false)
  })

  it('saves a text missing a required placeholder, with a warning; the project override wins', async () => {
    const o = opts()
    const v = await savePrompt({
      ...o,
      name: 'fix',
      scope: 'project',
      text: 'Fix what the reviewers found.\n',
    })
    expect(v).toMatchObject({ source: 'project', overrides: { user: false, project: true } })
    expect(v.issues).toEqual([
      expect.objectContaining({ code: 'missing-required', severity: 'warning', name: 'findings' }),
    ])
    expect(v.previous).toEqual({ scope: 'project', text: null })
    expect(readFileSync(join(o.projectRoot ?? '', '.dimfactory', 'prompts', 'fix.md'), 'utf8')).toBe(
      'Fix what the reviewers found.\n',
    )
    expect((await getPromptView('fix', o)).source).toBe('project')
    expect((await getPromptView('fix', opts())).source).toBe('builtin')
  })

  it('reset (text null) removes the override and answers its text; saving that text back undoes it', async () => {
    const o = opts()
    const mine = 'Plan this carefully:\n{{task}}\n'
    await savePrompt({ ...o, name: 'plan', scope: 'user', text: mine })
    const reset = await savePrompt({ ...o, name: 'plan', scope: 'user', text: null })
    expect(reset).toMatchObject({ source: 'builtin', previous: { scope: 'user', text: mine } })
    expect(reset.overrides).toEqual({ user: false, project: false })
    const undone = await savePrompt({ ...o, name: 'plan', scope: 'user', text: reset.previous?.text ?? null })
    expect(undone).toMatchObject({ source: 'user', text: mine, previous: { scope: 'user', text: null } })
    expect(undone.placeholders).toEqual(['task'])
  })

  it('a second save answers the text it replaced', async () => {
    const o = opts()
    await savePrompt({ ...o, name: 'critic', scope: 'project', text: 'First:\n{{diff}}\n' })
    const second = await savePrompt({ ...o, name: 'critic', scope: 'project', text: 'Second:\n{{diff}}\n' })
    expect(second.previous).toEqual({ scope: 'project', text: 'First:\n{{diff}}\n' })
  })
})

describe('the optional steps’ prompts (Clarify, Research, acceptance, Explain, Deploy, the plain-words twins)', () => {
  it('are served with their own step’s placeholders, editable', async () => {
    const o = opts()
    for (const name of STEP_PROMPT_NAMES) {
      const v = await getPromptView(name, o)
      expect(v).toMatchObject({ name, source: 'builtin', path: null, editable: true })
      expect(v.text).toBe(readBuiltinTemplate(name))
      expect(v.issues?.filter((i) => i.severity === 'error')).toEqual([])
    }
    // A plain-words twin takes its step's placeholders.
    expect((await getPromptView('clarify-easy', o)).required).toEqual(['task', 'questions'])
    expect((await getPromptView('explain-easy', o)).allowed).toContain('files')
    expect((await getPromptView('deploy', o)).required).toEqual(['target', 'files'])
  })

  it('a save is validated against the step’s placeholders: an unknown one is refused, a known one saved', async () => {
    const o = opts()
    await expect(
      savePrompt({
        ...o,
        name: 'clarify-easy',
        scope: 'project',
        text: 'Ask {{questions}} about {{diff}}\n',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: [expect.objectContaining({ code: 'unknown-placeholder', name: 'diff', line: 1 })] as unknown,
    })
    const v = await savePrompt({
      ...o,
      name: 'research',
      scope: 'project',
      text: 'Study {{lenses}} with {{access}} for:\n{{task}}\n',
    })
    expect(v).toMatchObject({ name: 'research', source: 'project' })
    expect(readFileSync(join(o.projectRoot ?? '', '.dimfactory', 'prompts', 'research.md'), 'utf8')).toBe(
      'Study {{lenses}} with {{access}} for:\n{{task}}\n',
    )
  })

  it('a run takes the override when it is made, and passes over one with template errors for the built-in', () => {
    const o = opts()
    const root = o.projectRoot ?? ''
    mkdirSync(join(root, '.dimfactory', 'prompts'), { recursive: true })
    writeFileSync(join(root, '.dimfactory', 'prompts', 'explain-easy.md'), 'Say it simply:\n{{task}}\n')
    writeFileSync(join(root, '.dimfactory', 'prompts', 'deploy.md'), 'Deploy {{nowhere}}\n')
    const skipped: string[] = []
    const t = resolveStepTemplates({ home: o.home, folder: root }, (name) => skipped.push(name))
    expect(Object.keys(t).sort()).toEqual([...STEP_PROMPT_NAMES].sort())
    expect(t['explain-easy']).toMatchObject({ layer: 'project', name: 'explain-easy' })
    expect(t.deploy).toMatchObject({ layer: 'builtin' })
    expect(t.clarify).toMatchObject({ layer: 'builtin' })
    expect(skipped).toEqual(['deploy'])
  })
})
