// The builtin templates (src/core/prompts/defaults/*.md) are the source of truth for the passes' prompts. This pins
// each one by hash, so an accidental edit fails here, and checks what any wording must keep: it validates for its
// pass, it has its pass's required placeholders, and implement.md stays under 200 words.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PASS_NAMES } from '@shared/run.ts'
import { BUILTIN_PROMPTS_DIR, readBuiltinTemplate } from '@core/prompts/resolve.ts'
import {
  parseTemplate,
  placeholdersOf,
  render,
  requiredFor,
  validateTemplate,
} from '@core/prompts/template.ts'

/**
 * sha256 of each approved template (LF line endings). A wording change is a deliberate decision: change the
 * template and its pin together. To update a pin after an intended edit, run this file: the failing case prints
 * the received hash (of the file with LF line endings), which is the new pin.
 */
const APPROVED_SHA256: Record<(typeof PASS_NAMES)[number], string> = {
  plan: '60cd823d6596deb6344f05c1147be2d9fb4ee898f248e6636bd23aa202214cb7',
  implement: 'f4c334f559aa9a786da131d02d28e390e27cd9f6c5ca5836eb44defa3debf19e',
  review: '12d84efc4b9fe2848f0a106bcabe0e28170d8c74eb152673f7cb38ba6419ee8a',
  critic: 'c95a51da7bd1cc489f0f876c7d28db7aa016bdc93cf240a3cf8cef08a6d2770d',
  security: 'ea45eb4d47405b6ea207cf2aaedfdf5cc4f8a887dc908e9885202ca2c980eb67',
  fix: '9a8cdcc35138152fcc658790776eb864c92044d26f807a4535b9dd286e644ebb',
}

const raw = (pass: string): string => readFileSync(join(BUILTIN_PROMPTS_DIR, `${pass}.md`), 'utf8')

describe('builtin prompt templates', () => {
  it.each(PASS_NAMES)('%s.md is the approved text verbatim', (pass) => {
    const text = raw(pass).replace(/\r\n/g, '\n')
    expect(createHash('sha256').update(text).digest('hex')).toBe(APPROVED_SHA256[pass])
  })

  it.each(PASS_NAMES)('%s.md has every placeholder its pass requires', (pass) => {
    const used = placeholdersOf(parseTemplate(readBuiltinTemplate(pass)).nodes)
    const required = requiredFor(pass, { planEnabled: true })
    expect(required.length).toBeGreaterThan(0)
    for (const name of required) expect(used, name).toContain(name)
  })

  it.each(PASS_NAMES)('%s.md validates with no issues', (pass) => {
    const v = validateTemplate(readBuiltinTemplate(pass), pass, { planEnabled: true })
    expect(v.issues).toEqual([])
    expect(v.ok).toBe(true)
  })

  it('implement.md is under 200 words', () => {
    const words = readBuiltinTemplate('implement')
      .split(/\s+/)
      .filter((w) => w !== '')
    expect(words.length).toBeLessThan(200)
  })

  it('implement.md renders with and without a plan', () => {
    const text = readBuiltinTemplate('implement')
    const without = render(
      text,
      { task: 'Add a --version flag.' },
      { template: 'implement', planEnabled: false },
    )
    expect(without.warnings).toEqual([])
    expect(without.text).toContain('Task:\nAdd a --version flag.\n\nRules:\n')
    expect(without.text).not.toContain('Approved plan')
    expect(without.text).not.toMatch(/\n\n\n/)
    const withPlan = render(text, { task: 'T', plan: '## Goal\nG\n' }, { template: 'implement' })
    expect(withPlan.text).toContain(
      'Task:\nT\n\nApproved plan — follow it. The user may have edited it; this version wins:\n## Goal\nG\n\nRules:\n',
    )
    expect(withPlan.text).not.toContain('{{')
  })

  it('plan.md renders the task', () => {
    const r = render(readBuiltinTemplate('plan'), { task: 'Do X' }, { template: 'plan' })
    expect(r.text).toContain('Task:\nDo X\n\nInvestigate')
    expect(r.text).not.toContain('{{')
  })

  it('fix.md with only findings collapses every optional section', () => {
    const r = render(readBuiltinTemplate('fix'), { findings: '- [must] F1 (review) x' }, { template: 'fix' })
    expect(r.text).toMatch(
      /^Address the findings below in this repository\.\n\nFindings to address \(selected by the user, \[must\] first\):\n- \[must\] F1 \(review\) x\n\nRules:\n/,
    )
    expect(r.text).not.toMatch(/\n\n\n/)
  })

  it('review.md and critic.md keep the diff inside <diff> tags', () => {
    for (const pass of ['review', 'critic'] as const) {
      const r = render(readBuiltinTemplate(pass), { task: 'T', diff: 'diff --git a b' }, { template: pass })
      expect(r.text).toContain('<diff>\ndiff --git a b\n</diff>')
      expect(r.text).not.toContain('Automated checks')
    }
  })
})

describe('project memory in the builtin templates', () => {
  it.each(PASS_NAMES)(
    '%s.md renders {{memory}} when the run has it, and drops the section without it',
    (pass) => {
      const text = readBuiltinTemplate(pass)
      const values = { task: 'T', plan: 'P', diff: 'D', findings: '- [must] F1 x' }
      const withMemory = render(text, { ...values, memory: '## Conventions\n- tabs' }, { template: pass })
      expect(withMemory.text).toContain(
        "The project's memory: its conventions, decisions and notes kept from earlier runs. Follow its conventions and decisions unless the task says otherwise:\n## Conventions\n- tabs",
      )
      const without = render(text, values, { template: pass })
      expect(without.text).not.toContain("The project's memory")
      expect(without.text).not.toMatch(/\n\n\n/)
    },
  )
})
