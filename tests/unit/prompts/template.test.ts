import { describe, expect, it } from 'vitest'
import {
  PROMPT_HARD_CAP_BYTES,
  TemplateError,
  VALUE_CAPS_BYTES,
  completeTemplate,
  defaultSectionFor,
  diffBudgetBytes,
  formatIssue,
  parseTemplate,
  placeholdersOf,
  render,
  suggestName,
  truncateUtf8,
  validateTemplate,
} from '@core/prompts/template.ts'
import type { TemplateIssue } from '@core/prompts/template.ts'

const errorsOf = (issues: TemplateIssue[]): TemplateIssue[] => issues.filter((i) => i.severity === 'error')

describe('grammar', () => {
  it('substitutes placeholders, with or without inner whitespace', () => {
    const r = render('Task: {{task}} / {{ task }}', { task: 'x' }, { template: 'plan' })
    expect(r.text).toBe('Task: x / x')
    expect(r.warnings).toEqual([])
  })

  it('renders a section only when the value is non-empty (whitespace counts as empty)', () => {
    const t = 'A{{#plan}}[{{plan}}]{{/plan}}B {{task}}'
    expect(render(t, { task: 't', plan: 'p' }, { template: 'implement', planEnabled: false }).text).toBe(
      'A[p]B t',
    )
    expect(render(t, { task: 't' }, { template: 'implement', planEnabled: false }).text).toBe('AB t')
    expect(render(t, { task: 't', plan: '  \n ' }, { template: 'implement', planEnabled: false }).text).toBe(
      'AB t',
    )
    expect(render(t, { task: 't', plan: null }, { template: 'implement', planEnabled: false }).text).toBe(
      'AB t',
    )
  })

  it('removes standalone section tag lines entirely, so an empty section leaves no blank lines', () => {
    const t = 'Task:\n{{task}}\n{{#plan}}\n\nPlan:\n{{plan}}\n{{/plan}}\n\nRules:\n'
    expect(render(t, { task: 'T' }, { template: 'implement', planEnabled: false }).text).toBe(
      'Task:\nT\n\nRules:\n',
    )
    expect(render(t, { task: 'T', plan: 'P' }, { template: 'implement' }).text).toBe(
      'Task:\nT\n\nPlan:\nP\n\nRules:\n',
    )
  })

  it('treats indented standalone tags as standalone and inline tags as inline', () => {
    const t = '  {{#plan}}  \nP={{plan}}\n\t{{/plan}}\nend {{task}}'
    expect(render(t, { task: 't', plan: 'x' }, { template: 'implement' }).text).toBe('P=x\nend t')
    const inline = 'a {{#plan}}b{{/plan}} c\n{{task}}'
    expect(render(inline, { task: 't' }, { template: 'implement', planEnabled: false }).text).toBe('a  c\nt')
  })

  it('a standalone tag on the last line without a trailing newline is removed', () => {
    expect(
      render(
        '{{task}}\n{{#plan}}\n{{plan}}\n{{/plan}}',
        { task: 't' },
        { template: 'implement', planEnabled: false },
      ).text,
    ).toBe('t\n')
  })

  it('supports nested sections', () => {
    const t = '{{#plan}}P{{#verify}}+V{{/verify}}{{/plan}}{{diff}}'
    expect(render(t, { plan: 'p', verify: 'v', diff: 'd' }, { template: 'review' }).text).toBe('P+Vd')
    expect(render(t, { plan: 'p', diff: 'd' }, { template: 'review' }).text).toBe('Pd')
    expect(render(t, { verify: 'v', diff: 'd' }, { template: 'review' }).text).toBe('d')
  })

  it('\\{{ is a literal {{ and is never parsed as a tag', () => {
    const t = 'Use \\{{task}} or \\{{#x}} in docs; real: {{task}}'
    const v = validateTemplate(t, 'plan')
    expect(v.ok).toBe(true)
    expect(v.placeholders).toEqual(['task'])
    expect(render(t, { task: 'T' }, { template: 'plan' }).text).toBe(
      'Use {{task}} or {{#x}} in docs; real: T',
    )
    // An escaped brace may be followed by a third brace.
    expect(render('\\{{{task}}}', { task: 'T' }, { template: 'plan' }).text).toBe('{{{task}}}')
  })

  it('normalizes a BOM and CRLF in templates and values', () => {
    const t = '\uFEFFTask:\r\n{{task}}\r\n{{#plan}}\r\n{{plan}}\r\n{{/plan}}\r\nend\r\n'
    expect(render(t, { task: 'a\r\nb', plan: 'p\r\n\r\n' }, { template: 'implement' }).text).toBe(
      'Task:\na\nb\np\nend\n',
    )
  })

  it('drops trailing line breaks from values', () => {
    expect(render('<{{task}}>', { task: 'x\n\n' }, { template: 'plan' }).text).toBe('<x>')
  })

  it('placeholdersOf lists vars and sections in first-use order', () => {
    expect(placeholdersOf(parseTemplate('{{#plan}}{{task}}{{/plan}}{{task}}{{diff}}').nodes)).toEqual([
      'plan',
      'task',
      'diff',
    ])
  })
})

describe('validation', () => {
  it('reports unknown placeholders with line/col and a suggestion', () => {
    const v = validateTemplate('Line one\n  see {{tsk}}\n{{#plna}}x{{/plna}} {{task}}', 'plan')
    expect(v.ok).toBe(false)
    const errs = errorsOf(v.issues)
    expect(errs).toHaveLength(2)
    expect(errs[0]).toMatchObject({ code: 'unknown-placeholder', line: 2, col: 7, name: 'tsk' })
    expect(errs[0]?.message).toContain('did you mean {{task}}?')
    expect(errs[1]).toMatchObject({ code: 'unknown-placeholder', line: 3, col: 1, name: 'plna' })
    expect(formatIssue(errs[0] as TemplateIssue, 'C:/p/plan.md')).toMatch(
      /^C:\/p\/plan\.md:2:7: Unknown placeholder/,
    )
  })

  it('allowed placeholders differ per template (the placeholder table)', () => {
    expect(validateTemplate('{{task}}{{diff}}', 'plan').ok).toBe(false)
    expect(validateTemplate('{{task}}{{plan}}{{diff}}{{verify}}', 'review').ok).toBe(true)
    expect(validateTemplate('{{findings}}{{diff}}', 'review').ok).toBe(false)
    expect(validateTemplate('{{task}}{{plan}}{{diff}}{{findings}}{{verify}}', 'fix').ok).toBe(true)
    expect(validateTemplate('{{task}}{{verify}}', 'implement').ok).toBe(false)
    expect(
      validateTemplate('{{trigger}}{{probe}}{{passConfig}}{{env}}{{tail}}{{shell}}{{os}}', 'heal').issues,
    ).toEqual([])
    expect(
      validateTemplate('{{vendors}}{{officialSources}}{{today}}{{currentCatalog}}{{jsonSchema}}', 'catalog')
        .issues,
    ).toEqual([])
    expect(validateTemplate('{{task}}', 'heal').ok).toBe(false)
  })

  it('missing required placeholders are warnings, not errors', () => {
    const v = validateTemplate('Review this.', 'review')
    expect(v.ok).toBe(true)
    expect(v.missingRequired).toEqual(['diff'])
    expect(v.issues).toEqual([
      expect.objectContaining({ code: 'missing-required', severity: 'warning', name: 'diff' }),
    ])
    expect(validateTemplate('{{task}}', 'implement').missingRequired).toEqual([])
    expect(validateTemplate('{{task}}', 'implement', { planEnabled: true }).missingRequired).toEqual(['plan'])
    expect(validateTemplate('x', 'heal').missingRequired).toHaveLength(7)
  })

  it.each([
    ['unterminated', 'a {{task\n}}', 'unterminated-tag', 1, 3],
    ['malformed (space in name)', '{{task}} {{foo bar}}', 'malformed-tag', 1, 10],
    ['malformed (empty)', '{{task}}\n{{}}', 'malformed-tag', 2, 1],
    ['malformed (triple braces)', '{{{task}}}', 'malformed-tag', 1, 1],
    ['unclosed section', '{{task}}\n{{#plan}}x', 'unclosed-section', 2, 1],
    ['mismatched close', '{{#plan}}{{task}}{{/task}}', 'mismatched-section', 1, 18],
    ['close without open', '{{task}}{{/plan}}', 'unexpected-close', 1, 9],
  ] as const)('%s', (_label, text, code, line, col) => {
    const v = validateTemplate(text, 'implement')
    expect(v.ok).toBe(false)
    expect(errorsOf(v.issues).find((i) => i.code === code)).toMatchObject({ code, line, col })
  })

  it('render throws TemplateError(invalid) for templates with errors', () => {
    try {
      render('{{tsk}}', { task: 'x' }, { template: 'plan' })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError)
      expect((err as TemplateError).code).toBe('invalid')
      expect((err as TemplateError).issues[0]?.code).toBe('unknown-placeholder')
    }
  })

  it('suggestName stays within edit distance 2', () => {
    expect(suggestName('promptTemplte', ['promptTemplate', 'profile'])).toBe('promptTemplate')
    expect(suggestName('xyz', ['task', 'plan'])).toBeUndefined()
  })
})

describe('missing required → default section appended', () => {
  const DEFAULT_REVIEW =
    'Intro.\n\nTask:\n{{task}}\n\nThe diff:\n<diff>\n{{diff}}\n</diff>\n\nOutput rules.\n'
  const DEFAULT_IMPL = 'Do it.\n\nTask:\n{{task}}\n{{#plan}}\n\nPlan:\n{{plan}}\n{{/plan}}\n\nRules.\n'

  it('extracts the paragraph around a placeholder, or its whole section block', () => {
    expect(defaultSectionFor(DEFAULT_REVIEW, 'diff')).toBe('The diff:\n<diff>\n{{diff}}\n</diff>')
    expect(defaultSectionFor(DEFAULT_IMPL, 'task')).toBe('Task:\n{{task}}')
    expect(defaultSectionFor(DEFAULT_IMPL, 'plan')).toBe('{{#plan}}\n\nPlan:\n{{plan}}\n{{/plan}}')
    expect(defaultSectionFor(DEFAULT_IMPL, 'nope')).toBeUndefined()
  })

  it('appends the default section and warns', () => {
    const r = render(
      'Check my change carefully.\n',
      { diff: 'D', task: 'T' },
      { template: 'review', defaultText: DEFAULT_REVIEW },
    )
    expect(r.text).toBe('Check my change carefully.\n\nThe diff:\n<diff>\nD\n</diff>\n')
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'missing-required', name: 'diff' })])
  })

  it('implement requires plan only when Plan is enabled', () => {
    const user = 'Just do {{task}}.'
    const off = render(
      user,
      { task: 'T' },
      { template: 'implement', defaultText: DEFAULT_IMPL, planEnabled: false },
    )
    expect(off.text).toBe('Just do T.')
    expect(off.warnings).toEqual([])
    const on = render(user, { task: 'T', plan: 'P' }, { template: 'implement', defaultText: DEFAULT_IMPL })
    expect(on.text).toBe('Just do T.\n\nPlan:\nP\n')
    expect(on.warnings.map((w) => w.name)).toEqual(['plan'])
  })

  it('without a default text the warning still says the value is missing', () => {
    const r = render('Nothing here', { diff: 'D' }, { template: 'review' })
    expect(r.text).toBe('Nothing here')
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'missing-required', name: 'diff' })])
  })

  it('completeTemplate is a no-op when everything required is present', () => {
    expect(completeTemplate('{{diff}}\r\n', 'review', DEFAULT_REVIEW)).toEqual({
      text: '{{diff}}\n',
      appended: [],
    })
  })
})

describe('caps', () => {
  it('truncates over-cap values on a UTF-8 boundary with a note and a warning', () => {
    const task = 'é'.repeat(VALUE_CAPS_BYTES['task'] ?? 0) // 2 bytes each → 200 KB
    const r = render('{{task}}', { task }, { template: 'plan' })
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'truncated', name: 'task' })])
    expect(r.text).toMatch(/\n\[… truncated by Dim Factory: 100 KB omitted\]$/)
    const kept = r.text.slice(0, r.text.indexOf('\n['))
    expect(Buffer.byteLength(kept)).toBe(100 * 1024)
    expect(kept).not.toContain('\uFFFD')
  })

  it.each([
    ['plan', 40],
    ['findings', 60],
    ['verify', 16],
  ] as const)('%s is capped at %i KB', (name, kb) => {
    expect(VALUE_CAPS_BYTES[name]).toBe(kb * 1024)
  })

  it('diff is not capped by render (patch.ts sizes it), but the whole prompt is hard-capped at 400 KB', () => {
    const diff = 'x'.repeat(PROMPT_HARD_CAP_BYTES)
    expect(() =>
      render('{{diff}}', { diff: diff.slice(0, PROMPT_HARD_CAP_BYTES - 10) }, { template: 'review' }),
    ).not.toThrow()
    try {
      render('{{diff}}!', { diff }, { template: 'review' })
      expect.unreachable()
    } catch (err) {
      expect((err as TemplateError).code).toBe('too-large')
    }
  })

  it('truncateUtf8 never splits a code point', () => {
    expect(truncateUtf8('aé', 2)).toBe('a')
    expect(truncateUtf8('a😀b', 4)).toBe('a')
    expect(truncateUtf8('abc', 10)).toBe('abc')
  })

  it('diffBudgetBytes: min(150 KB, 0.25 × window × 3.5), shrunk to keep the prompt under 60% of the window', () => {
    expect(diffBudgetBytes(200_000, 10_000)).toBe(150 * 1024)
    expect(diffBudgetBytes(32_000, 0)).toBe(28_000)
    expect(diffBudgetBytes(32_000, 60_000)).toBe(7_200)
    expect(diffBudgetBytes(32_000, 100_000)).toBe(0)
  })
})

describe('resumed Fix', () => {
  it('renders task, plan and diff empty', () => {
    const t =
      '{{#task}}T={{task}}\n{{/task}}{{#plan}}P={{plan}}\n{{/plan}}{{#diff}}D={{diff}}\n{{/diff}}F={{findings}}'
    const values = { task: 't', plan: 'p', diff: 'd', findings: 'f' }
    expect(render(t, values, { template: 'fix' }).text).toBe('T=t\nP=p\nD=d\nF=f')
    expect(render(t, values, { template: 'fix', resumed: true }).text).toBe('F=f')
  })
})
