import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResolvedTemplateZ } from '@shared/config-schema.ts'
import {
  BUILTIN_PROMPTS_DIR,
  PromptResolveError,
  readBuiltinTemplate,
  renderPassPrompt,
  resolvePromptTemplate,
  sha256Text,
  templateCandidates,
  toResolvedTemplate,
} from '@core/prompts/resolve.ts'

let root: string
let folder: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-prompts-'))
  folder = join(root, 'project')
  home = join(root, 'home')
  mkdirSync(join(folder, '.dimfactory', 'prompts'), { recursive: true })
  mkdirSync(join(home, 'prompts'), { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const projectPrompt = (name: string, text: string): void =>
  writeFileSync(join(folder, '.dimfactory', 'prompts', `${name}.md`), text)
const userPrompt = (name: string, text: string): void =>
  writeFileSync(join(home, 'prompts', `${name}.md`), text)

describe('resolvePromptTemplate', () => {
  it('null → the builtin <pass>.md', () => {
    const r = resolvePromptTemplate(null, { pass: 'plan', folder, home })
    expect(r).toMatchObject({ name: 'plan', layer: 'builtin', requested: 'plan', fellBack: false })
    expect(r.path).toBe(join(BUILTIN_PROMPTS_DIR, 'plan.md'))
    expect(r.sha256).toBe(sha256Text(readBuiltinTemplate('plan')))
    expect(ResolvedTemplateZ.safeParse(toResolvedTemplate(r)).success).toBe(true)
  })

  it('looks up project → user → builtin', () => {
    userPrompt('review', 'user {{diff}}')
    expect(resolvePromptTemplate(null, { pass: 'review', folder, home })).toMatchObject({
      layer: 'user',
      text: 'user {{diff}}',
    })
    projectPrompt('review', 'project {{diff}}')
    expect(resolvePromptTemplate(null, { pass: 'review', folder, home })).toMatchObject({
      layer: 'project',
      text: 'project {{diff}}',
    })
    // No folder → no project layer.
    expect(resolvePromptTemplate(null, { pass: 'review', home }).layer).toBe('user')
    expect(templateCandidates('x', { pass: 'plan', folder, home }).map((c) => c.layer)).toEqual([
      'project',
      'user',
      'builtin',
    ])
  })

  it('a custom name can reuse another builtin (critic using review)', () => {
    const r = resolvePromptTemplate('review', { pass: 'critic', folder, home })
    expect(r).toMatchObject({ name: 'review', layer: 'builtin', fellBack: false })
  })

  it('an unknown name falls back to the pass builtin and says so', () => {
    const r = resolvePromptTemplate('strict-review', { pass: 'review', folder, home })
    expect(r).toMatchObject({ name: 'review', layer: 'builtin', requested: 'strict-review', fellBack: true })
  })

  it('rejects names that could escape the prompts folder', () => {
    for (const bad of ['../x', 'a/b', 'A', '.hidden', '']) {
      expect(() => resolvePromptTemplate(bad, { pass: 'plan', folder, home })).toThrow(PromptResolveError)
    }
  })

  it('hashes normalized text, so CRLF and BOM do not change the sha', () => {
    projectPrompt('plan', 'Task:\n{{task}}\n')
    const lf = resolvePromptTemplate(null, { pass: 'plan', folder, home })
    projectPrompt('plan', '﻿Task:\r\n{{task}}\r\n')
    const crlf = resolvePromptTemplate(null, { pass: 'plan', folder, home })
    expect(crlf.text).toBe('Task:\n{{task}}\n')
    expect(crlf.sha256).toBe(lf.sha256)
  })

  it('a missing builtin directory is an error', () => {
    expect(() => resolvePromptTemplate(null, { pass: 'plan', home, builtinDir: join(root, 'nope') })).toThrow(
      /builtin plan template is missing/,
    )
  })
})

describe('renderPassPrompt', () => {
  it('re-reads the template and appends default sections from the builtin', () => {
    projectPrompt('review', 'Be strict.\n')
    const t = resolvePromptTemplate(null, { pass: 'review', folder, home })
    const r = renderPassPrompt('review', t, { task: 'T', diff: 'DIFF' })
    expect(r.text).toMatch(/^Be strict\.\n\nThis diff is the complete set of changes made by this run;/)
    expect(r.text).toContain('<diff>\nDIFF\n</diff>')
    expect(r.warnings.map((w) => w.code)).toEqual(['missing-required'])
    expect(r.sha256).toBe(t.sha256)
  })

  it('fails when the file disappeared since resolve', () => {
    projectPrompt('plan', '{{task}}')
    const t = resolvePromptTemplate(null, { pass: 'plan', folder, home })
    rmSync(t.path)
    expect(() => renderPassPrompt('plan', t, { task: 'x' })).toThrow(PromptResolveError)
  })
})
