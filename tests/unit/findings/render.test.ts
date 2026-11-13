// {{findings}} rendering (the template rendering rules), the review.md / critic.md artifact text, the Fix skip
// rule, the Fix report parser and Fix's summary for the person.
import { describe, expect, it } from 'vitest'
import {
  fixReportById,
  fixSummary,
  parseFindings,
  parseFixReport,
  skipRule as skipRuleFromParse,
  withoutFixReport,
} from '@core/findings/parse.ts'
import {
  FINDINGS_CAP_BYTES,
  findingsNotes,
  renderFindings,
  renderFindingsDetailed,
  reviewArtifactText,
  skipRule,
} from '@core/findings/render.ts'
import { render } from '@core/prompts/template.ts'
import { VALUE_CAPS_BYTES } from '@core/prompts/template.ts'
import type { Finding, SourceParse } from '@shared/findings.ts'

const md = (...lines: string[]): string => lines.join('\n')
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

function finding(n: number, severity: Finding['severity'], over: Partial<Finding> = {}): Finding {
  return {
    id: `id${n}`,
    n,
    severity,
    source: 'review',
    title: `title ${n}`,
    body: '',
    flags: [],
    round: 1,
    ...over,
  }
}

describe('renderFindings', () => {
  it('renders notes first, then selected findings must first with bodies indented 2 spaces', () => {
    const findings = [
      finding(3, 'should', { source: 'critic', title: 'naming', body: 'rename x' }),
      finding(1, 'must', { title: '`a.ts:1` — null deref', body: 'line one\n\n  nested\nline three' }),
      finding(2, 'must', { source: 'critic', title: 'design' }),
      finding(4, 'should', { title: 'unselected' }),
    ]
    const text = renderFindings(findings, {
      selected: { id1: true, id2: true, id3: true, id4: false },
      notes: findingsNotes({ reverted: ['src/a.ts', 'src/b.ts'], editedOutside: ['README.md'] }),
    })
    expect(text).toBe(
      md(
        'Notes:',
        '- User reverted after review: src/a.ts, src/b.ts',
        '- User edited outside the run: README.md',
        '',
        '- [must] F1 (review) `a.ts:1` — null deref',
        '  line one',
        '',
        '    nested',
        '  line three',
        '- [must] F2 (critic) design',
        '- [should] F3 (critic) naming',
        '  rename x',
      ),
    )
  })

  it('renders every finding when no selection is given, and no Notes block without notes', () => {
    const text = renderFindings([finding(1, 'must'), finding(2, 'should')])
    expect(text).toBe(md('- [must] F1 (review) title 1', '- [should] F2 (review) title 2'))
    expect(findingsNotes({})).toEqual([])
    expect(findingsNotes({ reverted: [], editedOutside: [] })).toEqual([])
  })

  it('renders an empty selection as nothing (or the notes alone)', () => {
    expect(renderFindings([finding(1, 'must')], { selected: {} })).toBe('')
    expect(renderFindings([finding(1, 'must')], { selected: {}, notes: ['n'] })).toBe(md('Notes:', '- n'))
  })

  it('round-trips parser output into the fix template', () => {
    const parsed = parseFindings(md('- [should] b', '- [must] a', '  why'), 'review')
    const value = renderFindings(parsed.findings)
    const out = render('Findings:\n{{findings}}', { findings: value }, { template: 'fix' })
    expect(out.text).toBe(md('Findings:', '- [must] F1 (review) a', '  why', '- [should] F2 (review) b'))
    expect(out.warnings).toEqual([])
  })

  it('stays within 60 KB by dropping should bodies (last first), then should titles', () => {
    expect(FINDINGS_CAP_BYTES).toBe(VALUE_CAPS_BYTES['findings'])
    const big = 'x'.repeat(20 * 1024)
    const findings = [
      finding(1, 'must', { body: big }),
      finding(2, 'should', { body: big }),
      finding(3, 'should', { body: big }),
      finding(4, 'should', { body: big }),
    ]
    const r = renderFindingsDetailed(findings)
    expect(r.bytes).toBeLessThanOrEqual(FINDINGS_CAP_BYTES)
    expect(r.bytes).toBe(bytes(r.text))
    expect(r).toMatchObject({ included: 4, droppedBodies: 2, droppedFindings: 0, hardTruncated: false })
    // F2 keeps its body; F3 and F4 (the last ones) lose theirs.
    expect(r.text).toContain(`- [should] F2 (review) title 2\n  ${big}`)
    expect(r.text).toContain('- [should] F3 (review) title 3\n- [should] F4 (review) title 4\n')
    expect(
      r.text.endsWith('[Dim Factory left out details of 2 [should] findings to stay within 60 KB.]'),
    ).toBe(true)
  })

  it('drops whole should entries when bodies are not enough', () => {
    const findings = [
      finding(1, 'must', { body: 'm'.repeat(59 * 1024) }),
      ...Array.from({ length: 40 }, (_, i) =>
        finding(i + 2, 'should', { title: 't'.repeat(100), body: 'b' }),
      ),
    ]
    const r = renderFindingsDetailed(findings)
    expect(r.bytes).toBeLessThanOrEqual(FINDINGS_CAP_BYTES)
    expect(r.droppedBodies + r.droppedFindings).toBe(40)
    expect(r.droppedFindings).toBeGreaterThan(0)
    expect(r.hardTruncated).toBe(false)
    expect(r.text).toContain('- [must] F1 (review) title 1')
    expect(r.text).toMatch(
      /\[Dim Factory left out (details of \d+ \[should\] findings? and )?\d+ \[should\] findings?/,
    )
    // The template's own cap never has to cut it again.
    const out = render('{{findings}}', { findings: r.text }, { template: 'fix' })
    expect(out.warnings).toEqual([])
  })

  it('cuts hard, with a note, when the must findings alone exceed the cap', () => {
    const findings = [
      finding(1, 'must', { body: 'é'.repeat(40 * 1024) }),
      finding(2, 'must', { body: 'z'.repeat(1024) }),
    ]
    const r = renderFindingsDetailed(findings)
    expect(r.hardTruncated).toBe(true)
    expect(r.bytes).toBeLessThanOrEqual(FINDINGS_CAP_BYTES)
    expect(r.text.endsWith('[… truncated by Dim Factory to stay within 60 KB]')).toBe(true)
    expect(r.text).not.toContain('\uFFFD')
  })

  it('honours a custom cap and keeps single-line titles', () => {
    const r = renderFindingsDetailed(
      [finding(1, 'must', { title: 'multi\nline   title' }), finding(2, 'should', { body: 'b'.repeat(500) })],
      { capBytes: 300 },
    )
    expect(r.bytes).toBeLessThanOrEqual(300)
    expect(r.text.startsWith('- [must] F1 (review) multi line title\n- [should] F2 (review) title 2')).toBe(
      true,
    )
  })
})

describe('reviewArtifactText', () => {
  it('is the raw output with LF endings and one trailing newline', () => {
    expect(reviewArtifactText('\uFEFF- [must] a\r\n- [should] b\r\n\r\n')).toBe('- [must] a\n- [should] b\n')
    expect(reviewArtifactText('```md\nNO FINDINGS\n```')).toBe('```md\nNO FINDINGS\n```\n')
    expect(reviewArtifactText('  \n')).toBe('')
  })
})

describe('skipRule', () => {
  const p = (status: SourceParse['status'], count = 0): SourceParse => ({ status, count, rawFile: 'x.md' })

  it('is re-exported from render.ts', () => {
    expect(skipRule).toBe(skipRuleFromParse)
  })

  it('skips Fix when every enabled reviewer is none (or ok with 0) and verify is clean', () => {
    expect(skipRule({ review: p('none'), critic: p('none') }, false)).toEqual({
      skip: true,
      reason: 'Review and Critic reported no findings',
    })
    expect(skipRule({ review: p('ok', 0) }, false)).toEqual({
      skip: true,
      reason: 'Review reported no findings',
    })
    expect(skipRule({ critic: p('none') }, false).skip).toBe(true)
    expect(skipRule({}, false)).toEqual({
      skip: true,
      reason: 'Review and Critic are off and no checks failed',
    })
  })

  it('never counts a failed, empty, unparsed or missing reviewer as zero', () => {
    expect(skipRule({ review: p('none'), critic: p('failed') }, false)).toEqual({
      skip: false,
      reason: 'Critic failed',
    })
    expect(skipRule({ review: p('empty') }, false)).toEqual({
      skip: false,
      reason: 'Review returned no output',
    })
    expect(skipRule({ review: null, critic: p('none') }, false)).toEqual({
      skip: false,
      reason: 'Review has no result',
    })
    expect(skipRule({ review: p('untagged', 2) }, false).reason).toBe('Review reported 2 untagged findings')
    expect(skipRule({ critic: p('unstructured', 1) }, false).reason).toBe(
      'Critic replied without a findings list',
    )
    expect(skipRule({ review: p('ok', 1), critic: p('ok', 3) }, false)).toEqual({
      skip: false,
      reason: 'Review reported 1 finding; Critic reported 3 findings',
    })
  })

  it('does not skip while verify has [must] failures, and ignores a verify source entry', () => {
    expect(skipRule({ review: p('none') }, true)).toEqual({
      skip: false,
      reason: 'Automated checks are failing',
    })
    expect(skipRule({ review: p('none'), verify: p('ok', 2) }, false).skip).toBe(true)
  })
})

describe('parseFixReport', () => {
  it('parses the fix.md closing lines', () => {
    const text = md(
      'I changed the guard and added a test.',
      '',
      'F1 fixed',
      'F2 skipped: the rename touches the public API',
      'F3 disputed: the list is never empty here (see b.ts:4)',
    )
    expect(parseFixReport(text)).toEqual([
      { n: 1, status: 'fixed' },
      { n: 2, status: 'skipped', reason: 'the rename touches the public API' },
      { n: 3, status: 'disputed', reason: 'the list is never empty here (see b.ts:4)' },
    ])
  })

  it('tolerates bullets, emphasis, backticks, separators, case and CRLF; the last line wins', () => {
    const text = [
      '- F1 fixed.',
      '* **F2** skipped — too risky',
      '`F3 disputed: not a bug`',
      '1. F4: Fixed',
      'F5 - SKIPPED: later',
      'F1 skipped: actually not',
      'Fixed F6 by hand',
      'F7 was fixed',
    ].join('\r\n')
    expect(parseFixReport(text)).toEqual([
      { n: 1, status: 'skipped', reason: 'actually not' },
      { n: 2, status: 'skipped', reason: 'too risky' },
      { n: 3, status: 'disputed', reason: 'not a bug' },
      { n: 4, status: 'fixed' },
      { n: 5, status: 'skipped', reason: 'later' },
    ])
    expect(parseFixReport('')).toEqual([])
  })

  it('maps F-numbers to finding ids, dropping unknown numbers', () => {
    const findings = [finding(1, 'must', { id: 'aaa' }), finding(2, 'should', { id: 'bbb' })]
    expect(fixReportById(findings, parseFixReport('F1 fixed\nF2 disputed: no\nF9 fixed'))).toEqual({
      aaa: 'fixed',
      bbb: 'disputed',
    })
  })

  it('still reads the report lines when Fix ends with a summary for the person', () => {
    const text = md(
      'Guarded the empty list.',
      '',
      'F1 fixed',
      'F2 skipped: later',
      '',
      '## Summary',
      'It works now.',
    )
    expect(parseFixReport(text)).toEqual([
      { n: 1, status: 'fixed' },
      { n: 2, status: 'skipped', reason: 'later' },
    ])
  })
})

describe("Fix's summary for the person", () => {
  it('is the text under the Summary heading, without report lines', () => {
    const text = md(
      'F1 fixed',
      'F2 disputed: not a bug',
      '',
      '## Summary',
      'The invoice total is right now. Run `npm test` to check: 9 tests pass.',
      '',
      'Nothing is left for you to do.',
      'F1 fixed',
    )
    expect(fixSummary(text)).toBe(
      'The invoice total is right now. Run `npm test` to check: 9 tests pass.\n\nNothing is left for you to do.',
    )
  })

  it('takes the heading at any level, bold, or with a colon; none or an empty one is undefined', () => {
    expect(fixSummary('F1 fixed\n### summary\nDone.')).toBe('Done.')
    expect(fixSummary('F1 fixed\n**Summary:**\nDone.')).toBe('Done.')
    expect(fixSummary('F1 fixed\r\nSummary\r\nDone.')).toBe('Done.')
    expect(fixSummary('Updated the README.\n\nF1 fixed')).toBeUndefined()
    expect(fixSummary('F1 fixed\n## Summary\n')).toBeUndefined()
    expect(fixSummary('The summary of it all: done.')).toBeUndefined()
  })

  it('without a heading, the report lines can still be taken out', () => {
    expect(withoutFixReport('Updated the README.\n\nF1 fixed\nF2 fixed')).toBe('Updated the README.')
    expect(withoutFixReport('F1 fixed')).toBe('')
  })
})
