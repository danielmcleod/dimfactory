// Findings parser corpus.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MUST_TAGS,
  TAG_RE,
  buildFindingsFile,
  countFindings,
  detectTag,
  failedSource,
  findingId,
  mergeFindings,
  normalizeOutput,
  parseFindings,
  stripLineLead,
  tidyLocation,
  unwrapSingleFence,
} from '@core/findings/parse.ts'
import type { ParsedSource } from '@core/findings/parse.ts'
import type { Finding } from '@shared/findings.ts'

const md = (...lines: string[]): string => lines.join('\n')
const parse = (text: string, source: 'review' | 'critic' = 'review'): ParsedSource =>
  parseFindings(text, source)
const brief = (r: ParsedSource): [string, string, string][] =>
  r.findings.map((f) => [f.severity, f.title, f.body])

describe('normalization', () => {
  it('strips a BOM and turns CRLF / CR into LF', () => {
    expect(normalizeOutput('\uFEFFa\r\nb\rc')).toBe('a\nb\nc')
  })

  it('unwraps one ```markdown, ```md, bare or ~~~ fence around the whole output', () => {
    for (const open of ['```markdown', '```md', '```', '~~~', '````Markdown', '```  md  ']) {
      const close = open.startsWith('~') ? '~~~' : open.replace(/[^`]/g, '')
      expect(unwrapSingleFence(`${open}\n- [must] a\n${close}`)).toBe('- [must] a')
    }
    expect(unwrapSingleFence('\n\n```md\n- [must] a\n```\n\n')).toBe('- [must] a')
  })

  it('keeps nested fences inside the unwrapped block', () => {
    const text = md('```markdown', '- [must] a', '  ```ts', '  code', '  ```', '- [should] b', '```')
    expect(unwrapSingleFence(text)).toBe(md('- [must] a', '  ```ts', '  code', '  ```', '- [should] b'))
  })

  it('does not unwrap other languages, several blocks, or an unclosed fence', () => {
    for (const text of [
      '```ts\nconst a = 1\n```',
      '```\none\n```\nprose\n```\ntwo\n```',
      '```md\n- [must] a',
      'prose\n```md\n- [must] a\n```',
      '```md\n- [must] a\n```js',
    ]) {
      expect(unwrapSingleFence(text)).toBe(text)
    }
  })

  it('parses fenced, BOM-prefixed CRLF output like plain output', () => {
    const plain = md('- [must] a.ts:1 — broken', '  because', '- [should] b')
    const wrapped = '\uFEFF' + `\`\`\`markdown\r\n${plain.replace(/\n/g, '\r\n')}\r\n\`\`\`\r\n`
    expect(parse(wrapped)).toEqual(parse(plain))
    expect(brief(parse(wrapped))).toEqual([
      ['must', 'a.ts:1 — broken', 'because'],
      ['should', 'b', ''],
    ])
  })
})

describe('status none / empty', () => {
  it('NO FINDINGS exactly, with whitespace, emphasis or backticks', () => {
    for (const t of [
      'NO FINDINGS',
      '  NO FINDINGS\n',
      '**NO FINDINGS**',
      '`NO FINDINGS`',
      '```\nNO FINDINGS\n```',
    ]) {
      const r = parse(t)
      expect(r.parse).toEqual({ status: 'none', count: 0, rawFile: 'review.md' })
      expect(r.findings).toEqual([])
    }
  })

  it('a short "no issues / LGTM" answer', () => {
    for (const t of [
      'No findings.',
      'no issues found in this change',
      'No problems spotted.',
      'LGTM',
      'lgtm, ship it',
      'Looks good to me.',
    ]) {
      expect(parse(t).parse.status).toBe('none')
    }
  })

  it('a long answer that starts with "no issues" is not none', () => {
    const long = `No issues with the logic, but ${'the naming could be clearer in several places. '.repeat(5)}`
    expect(long.length).toBeGreaterThanOrEqual(200)
    const r = parse(long)
    expect(r.parse.status).toBe('unstructured')
    expect(r.findings).toHaveLength(1)
  })

  it('a NO FINDINGS first line followed by commentary is none (extension)', () => {
    const t = md('NO FINDINGS', '', 'I checked the error paths and the tests; ' + 'all fine. '.repeat(30))
    expect(parse(t).parse.status).toBe('none')
  })

  it('a NO FINDINGS last line after commentary is none (the final text after the last tool call)', () => {
    for (const t of [
      md(
        'I checked the new flag handling, the tests and the README; everything matches the plan.',
        '',
        'NO FINDINGS',
      ),
      md('The change is complete and correct.', '', '**NO FINDINGS**'),
      md('Checked the error paths.', 'No findings.', ''),
    ]) {
      const r = parse(t)
      expect(r.parse.status, t).toBe('none')
      expect(r.findings).toEqual([])
    }
  })

  it('a last-line NO FINDINGS does not hide untagged list items (they stay findings)', () => {
    const r = parse(md('Problems:', '- `src/cli.ts:12` is never registered', '', 'NO FINDINGS'))
    expect(r.parse.status).toBe('untagged')
    expect(r.findings.map((f) => f.title)).toEqual(['`src/cli.ts:12` is never registered'])
  })

  it.each([
    'No issues with the parsing, but the new `--version` flag is never registered in `src/cli.ts:12`, so it does nothing.',
    'LGTM apart from one bug: `src/cli.ts:12` reads the version from the wrong package.json.',
    'No problems found in the tests. However `src/version.ts` is missing from the diff.',
    'Looks good, but `src/cli.ts:14` writes the version to stderr instead of stdout.',
    'LGTM except `src/cli.ts:14` exits 1 after printing.',
    'Looks good — the new flag prints to stderr.',
  ])('a short "no issues" opener followed by a problem is one unstructured finding: %s', (t) => {
    const r = parse(t)
    expect(r.parse.status).toBe('unstructured')
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]?.flags).toEqual(['unstructured'])
  })

  it.each([
    md('Looks good overall, except:', '- `src/cli.ts:12` — the flag is never registered'),
    md(
      'No issues with the logic. Two problems remain:',
      '- `src/cli.ts:14` prints the version to stderr',
      '- no test covers `-V`',
    ),
  ])('untagged list items after a "no issues" opener are findings: %s', (t) => {
    const r = parse(t)
    expect(r.parse.status).toBe('untagged')
    expect(r.findings.length).toBeGreaterThan(0)
    expect(r.findings.every((f) => f.flags.includes('untagged'))).toBe(true)
  })

  it('tags win over a short "no issues" opener', () => {
    const r = parse(md('No issues except:', '- [must] a.ts:3 — off by one'))
    expect(r.parse.status).toBe('ok')
    expect(brief(r)).toEqual([['must', 'a.ts:3 — off by one', '']])
  })

  it('empty output (nothing, whitespace, an empty fence, a BOM) is empty', () => {
    for (const t of ['', '   \n\n  ', '\uFEFF', '```\n```', '```markdown\n\n```']) {
      expect(parse(t).parse).toEqual({ status: 'empty', count: 0, rawFile: 'review.md' })
    }
  })
})

describe('tag detection', () => {
  it('keeps the findings regex verbatim', () => {
    expect(TAG_RE.source).toBe(
      String.raw`^\[\s*(security\s*[:/-]\s*(?:critical|high|medium|moderate|low)|security|must(?:[\s-]?fix)?|should|blocker|critical|major|nit|minor|consider|could)\s*\]\s*[:\-–—]?\s*`,
    )
    expect(TAG_RE.flags).toBe('i')
    expect([...MUST_TAGS].sort()).toEqual([
      'blocker',
      'critical',
      'major',
      'must',
      'mustfix',
      'security:critical',
      'security:high',
    ])
  })

  it.each([
    ['[must] x', 'must', 'must'],
    ['[MUST] x', 'must', 'must'],
    ['[ must ] x', 'must', 'must'],
    ['[must fix] x', 'mustfix', 'must'],
    ['[must-fix] x', 'mustfix', 'must'],
    ['[mustfix] x', 'mustfix', 'must'],
    ['[Blocker] x', 'blocker', 'must'],
    ['[critical] x', 'critical', 'must'],
    ['[major] x', 'major', 'must'],
    ['[should] x', 'should', 'should'],
    ['[nit] x', 'nit', 'should'],
    ['[minor] x', 'minor', 'should'],
    ['[consider] x', 'consider', 'should'],
    ['[could] x', 'could', 'should'],
  ])('%s → %s (%s)', (line, tag, severity) => {
    expect(detectTag(`- ${line}`)).toEqual({ tag, severity, title: 'x' })
  })

  it.each([
    ['[must]: x', 'x'],
    ['[must] - x', 'x'],
    ['[must] – x', 'x'],
    ['[must] — x', 'x'],
    ['**[must]** x', 'x'],
    ['**[must]**: x', 'x'],
    ['**[must]:** x', 'x'],
    ['**[must] x**', 'x'],
    ['**[must] x** and y', 'x and y'],
    ['*[must]* x', 'x'],
    ['_[must]_ x', 'x'],
    ['`[must]` x', 'x'],
    ['**`[must]`** x', 'x'],
    ['[must] `a.ts:12` — x', '`a.ts:12` — x'],
    ['**[must]** `a.ts:12` — x', '`a.ts:12` — x'],
  ])('strips the separator and emphasis: %s', (line, title) => {
    expect(detectTag(`- ${line}`)?.title).toBe(title)
    expect(detectTag(line)?.title).toBe(title)
  })

  it('strips bullet and number markers, checkboxes and indentation first', () => {
    for (const line of [
      '- [must] x',
      '* [must] x',
      '+ [must] x',
      '1. [must] x',
      '12) [must] x',
      '    - [must] x',
      '- [ ] [must] x',
      '- [x] [must] x',
      '- [X] **[must]** x',
      '## [must] x',
      '\t- [must] x',
    ]) {
      expect(detectTag(line)?.title, line).toBe('x')
    }
    expect(stripLineLead('  3. [ ] text')).toBe('text')
  })

  it('ignores lines that do not start with a tag', () => {
    for (const line of [
      '- must: x',
      '- see [must] x',
      '- [mustard] x',
      '- [todo] x',
      '- (must) x',
      '- x [should]',
      '> [must] x',
      '- [must x',
      '',
    ]) {
      expect(detectTag(line), line).toBeNull()
    }
  })
})

// UI copy standard: no em dash in the app, also in a title a reviewer wrote in a format
// Dim Factory used to ask for ("`file:line` — problem").
describe('tidyLocation', () => {
  it.each([
    ['`a.ts:12` — x', '`a.ts:12`: x'],
    ['`a.ts:12`—x', '`a.ts:12`: x'],
    ['`a.ts:12` – x', '`a.ts:12`: x'],
    ['`a.ts:12` - x', '`a.ts:12`: x'],
    ['`a.ts:12` -- x', '`a.ts:12`: x'],
    ['`a.ts:12`: x', '`a.ts:12`: x'],
    ['`a.ts:12` : x', '`a.ts:12`: x'],
  ])('reads a location and its separator as a colon: %s', (title, tidy) => {
    expect(tidyLocation(title)).toBe(tidy)
  })

  it.each(['no location — x', '`--flag` -x is wrong', '`a.ts` is missing', '`a.ts:12` —', 'x `a.ts:12` — y'])(
    'leaves anything else as it is: %s',
    (title) => {
      expect(tidyLocation(title)).toBe(title)
    },
  )

  it('keeps the id of the raw line', () => {
    const r = parse('- [must] `a.ts:1` — x')
    expect(r.findings[0]?.title).toBe('`a.ts:1`: x')
    expect(r.findings[0]?.id).toBe(findingId('review', '- [must] `a.ts:1` — x'))
  })
})

describe('candidates', () => {
  it('parses the review.md template output', () => {
    const r = parse(
      md(
        '- [must] `src/a.ts:10`: Null dereference when the list is empty. Guard it.',
        '  The caller in `src/b.ts:4` passes [] on first launch.',
        '- [should] `src/c.ts:2`: Name is misleading. Rename to `loadAll`.',
      ),
    )
    expect(r.parse).toEqual({ status: 'ok', count: 2, rawFile: 'review.md' })
    expect(r.findings.map((f) => [f.n, f.severity, f.source, f.round, f.flags])).toEqual([
      [1, 'must', 'review', 1, []],
      [2, 'should', 'review', 1, []],
    ])
    expect(brief(r)).toEqual([
      [
        'must',
        '`src/a.ts:10`: Null dereference when the list is empty. Guard it.',
        'The caller in `src/b.ts:4` passes [] on first launch.',
      ],
      ['should', '`src/c.ts:2`: Name is misleading. Rename to `loadAll`.', ''],
    ])
  })

  it('numbers must first, then document order', () => {
    const r = parse(md('- [nit] one', '- [must] two', '- [should] three', '- [blocker] four'))
    expect(r.findings.map((f) => `F${f.n} ${f.severity} ${f.title}`)).toEqual([
      'F1 must two',
      'F2 must four',
      'F3 should one',
      'F4 should three',
    ])
  })

  it('[must]: x is caught even though it parses as a link reference definition', () => {
    // Top-level definitions, a repeated label (marked drops it from the token stream) and one inside an item.
    const r = parse(md('[must]: src/a.ts', '', '[must]: src/b.ts', '', '- [should]: src/c.ts', '  detail'))
    expect(brief(r)).toEqual([
      ['must', 'src/a.ts', ''],
      ['must', 'src/b.ts', ''],
      ['should', 'src/c.ts', 'detail'],
    ])
    const titled = parse('[must]: src/a.ts "a title"\n[should]: <b.ts>')
    expect(brief(titled)).toEqual([
      ['must', 'src/a.ts "a title"', ''],
      ['should', '<b.ts>', ''],
    ])
  })

  it('a tagged nested item becomes its own finding and leaves the parent body', () => {
    const r = parse(
      md(
        '- [must] parent problem',
        '  parent detail',
        '  - [should] child problem',
        '    child detail',
        '  - untagged child note',
        '    note detail',
        '',
        '  parent tail',
      ),
    )
    expect(brief(r)).toEqual([
      [
        'must',
        'parent problem',
        md('parent detail', '- untagged child note', '  note detail', '', 'parent tail'),
      ],
      ['should', 'child problem', 'child detail'],
    ])
  })

  it('finds tagged items at any depth under untagged grouping items', () => {
    const r = parse(
      md(
        '- Security',
        '  - [must] a',
        '    1. [should] deep',
        '       deep detail',
        '  - [nit] b',
        '- Style',
        '  * [could] c',
      ),
    )
    expect(brief(r)).toEqual([
      ['must', 'a', ''],
      ['should', 'deep', 'deep detail'],
      ['should', 'b', ''],
      ['should', 'c', ''],
    ])
  })

  it('handles numbered lists with both delimiters', () => {
    const r = parse(md('1. [must] one', '   detail', '2. [should] two', '', '3) [major] three'))
    expect(brief(r)).toEqual([
      ['must', 'one', 'detail'],
      ['must', 'three', ''],
      ['should', 'two', ''],
    ])
  })

  it('handles GFM checkboxes in tight and loose lists', () => {
    const tight = parse(md('- [ ] [must] a', '- [x] [should] b'))
    expect(brief(tight)).toEqual([
      ['must', 'a', ''],
      ['should', 'b', ''],
    ])
    const loose = parse(md('- [ ] [must] a', '  detail', '', '- [x] [should] b', '', '  more'))
    expect(brief(loose)).toEqual([
      ['must', 'a', 'detail'],
      ['should', 'b', 'more'],
    ])
  })

  it('handles emphasis-wrapped tags', () => {
    const r = parse(md('- **[must]** `a.ts:1` — x', '- **[should]: y**', '- *[nit]* z', '- `[minor]` w'))
    // A location's separator reads as a colon in the title (no em dash in the app).
    expect(r.findings.map((f) => f.title)).toEqual(['`a.ts:1`: x', 'y', 'z', 'w'])
  })

  it('takes the first content line when the marker stands alone', () => {
    const r = parse(md('-', '  [must] blank first line', '  detail'))
    expect(brief(r)).toEqual([['must', 'blank first line', 'detail']])
  })

  it('promotes the first body line when the tag line has no title', () => {
    const r = parse(md('- [must]', '  the actual problem', '  more'))
    expect(brief(r)).toEqual([['must', 'the actual problem', 'more']])
  })

  it('ignores tags inside code blocks, HTML, blockquotes and tables', () => {
    const r = parse(
      md(
        '```',
        '- [must] in a fence',
        '```',
        '',
        '    - [must] indented code',
        '',
        '<div>',
        '[must] in html',
        '</div>',
        '',
        '> - [must] quoted',
        '> [should] quoted too',
        '',
        '| sev | issue |',
        '|---|---|',
        '| [must] | in a table |',
        '',
        '- [should] the only real one',
      ),
    )
    expect(brief(r)).toEqual([['should', 'the only real one', '']])
  })

  it('keeps code blocks inside a finding body without looking at their tags', () => {
    const r = parse(
      md('- [must] a', '  ```ts', '  // [should] not a finding', '  x()', '  ```', '- [should] b'),
    )
    expect(brief(r)).toEqual([
      ['must', 'a', md('```ts', '// [should] not a finding', 'x()', '```')],
      ['should', 'b', ''],
    ])
  })

  it('headings are findings; the body runs to the next heading of the same or a higher level', () => {
    const r = parse(
      md(
        '# Review',
        '',
        '## [must] Heading problem ##',
        'Why it matters.',
        '',
        '- supporting bullet',
        '- [should] tagged bullet under the heading',
        '',
        '### Details',
        'deeper text',
        '',
        '## [nit] Second heading',
        'second body',
        '',
        '# Summary',
        'not part of any finding',
      ),
    )
    expect(brief(r)).toEqual([
      [
        'must',
        'Heading problem',
        md('Why it matters.', '', '- supporting bullet', '', '### Details', 'deeper text'),
      ],
      ['should', 'tagged bullet under the heading', ''],
      ['should', 'Second heading', 'second body'],
    ])
  })

  it('a tagged subheading is cut out of a tagged parent heading', () => {
    const r = parse(md('## [must] parent', 'parent body', '### [should] child', 'child body', '## next'))
    expect(brief(r)).toEqual([
      ['must', 'parent', 'parent body'],
      ['should', 'child', 'child body'],
    ])
  })

  it('setext headings are candidates too', () => {
    const r = parse(md('[must] setext title', '---', 'body text'))
    expect(brief(r)).toEqual([['must', 'setext title', 'body text']])
  })

  it('top-level paragraphs: each tagged line starts a finding', () => {
    const r = parse(
      md(
        'Summary prose that is not a finding.',
        '[must] first',
        'continues first',
        '**[should]** second',
        '',
        '[nit] third',
        '',
        'Closing remarks.',
      ),
    )
    expect(brief(r)).toEqual([
      ['must', 'first', 'continues first'],
      ['should', 'second', ''],
      ['should', 'third', ''],
    ])
  })

  it('dedents bodies and collapses blank runs', () => {
    const r = parse(md('- [must] a', '', '', '      indented more', '  base', '', '', '', '  after gap'))
    expect(r.findings[0]?.body).toBe(md('    indented more', 'base', '', 'after gap'))
  })

  it('records the source, round and raw file', () => {
    const r = parseFindings('- [must] a', 'critic', { round: 2, rawFile: 'critic-2.md' })
    expect(r.parse).toEqual({ status: 'ok', count: 1, rawFile: 'critic-2.md' })
    expect(r.findings[0]).toMatchObject({ source: 'critic', round: 2 })
  })
})

describe('untagged and unstructured output', () => {
  it('nothing tagged but list items: each top-level item is an untagged should', () => {
    const r = parse(
      md(
        '## Findings',
        '',
        '1. **Missing null check** in `a.ts:10`',
        '   The list can be empty.',
        '2. Rename `foo`',
        '   - sub point stays in the body',
        '',
        'Overall fine.',
      ),
    )
    expect(r.parse).toEqual({ status: 'untagged', count: 2, rawFile: 'review.md' })
    expect(r.findings.map((f) => [f.severity, f.title, f.body, f.flags])).toEqual([
      ['should', '**Missing null check** in `a.ts:10`', 'The list can be empty.', ['untagged']],
      ['should', 'Rename `foo`', '- sub point stays in the body', ['untagged']],
    ])
  })

  it('untagged items are dropped when some candidate is tagged', () => {
    const r = parse(md('- [must] real', '- just a remark'))
    expect(r.parse.status).toBe('ok')
    expect(brief(r)).toEqual([['must', 'real', '']])
  })

  it('prose only: one unstructured should with the whole answer', () => {
    const text = md(
      'The change mostly works, but the retry loop never backs off and will hammer the server.',
      '',
      'Also the new flag is undocumented.',
    )
    const r = parse(text, 'critic')
    expect(r.parse).toEqual({ status: 'unstructured', count: 1, rawFile: 'critic.md' })
    expect(r.findings).toEqual([
      {
        id: findingId(
          'critic',
          'The change mostly works, but the retry loop never backs off and will hammer the server.',
        ),
        n: 1,
        severity: 'should',
        source: 'critic',
        title: 'The change mostly works, but the retry loop never backs off and will hammer the server.',
        body: 'Also the new flag is undocumented.',
        flags: ['unstructured'],
        round: 1,
      },
    ])
  })

  it('prose that opens with a code block gets a generic title and keeps everything in the body', () => {
    const r = parse(md('```ts', 'const a = 1', '```', 'This is wrong.'), 'critic')
    expect(r.findings[0]?.title).toBe('Critic replied without a findings list')
    expect(r.findings[0]?.body).toBe(md('```ts', 'const a = 1', '```', 'This is wrong.'))
  })
})

describe('ids', () => {
  it('is sha1(source + "\\n" + normalized first line), 12 hex chars', () => {
    const expected = createHash('sha1').update('review\n[must] `a.ts:1` — x').digest('hex').slice(0, 12)
    const r = parse('- [must] `a.ts:1` — x')
    expect(r.findings[0]?.id).toBe(expected)
    expect(findingId('review', '  -   [must]   `a.ts:1`  —  x  ')).toBe(expected)
    expect(findingId('critic', '- [must] `a.ts:1` — x')).not.toBe(expected)
  })

  it('is stable across re-parses, bodies, markers and reordering', () => {
    const a = parse(md('- [must] one', '  body A', '- [should] two'))
    const b = parse(md('1. [should] two', '   other body', '2. [must] one'))
    const ids = (r: ParsedSource): string[] => r.findings.map((f) => f.id).sort()
    expect(ids(a)).toEqual(ids(b))
    expect(parse(md('- [must] one', '  body A', '- [should] two'))).toEqual(a)
  })

  it('suffixes -2, -3 on collisions, in document order', () => {
    const r = parse(md('- [must] same', '- [must] same', '  - [must] same', '- [should] other'))
    const base = findingId('review', '[must] same')
    expect(r.findings.map((f) => f.id)).toEqual([
      base,
      `${base}-2`,
      `${base}-3`,
      findingId('review', '[should] other'),
    ])
  })
})

describe('merge and findings.json', () => {
  const review = parseFindings(md('- [should] r-should', '- [must] r-must'), 'review')
  const critic = parseFindings(md('- [must] c-must', '- [nit] c-nit'), 'critic')

  it('renumbers across sources: must first, then review before critic', () => {
    const merged = mergeFindings([critic, review])
    expect(merged.map((f) => `F${f.n} ${f.source} ${f.title}`)).toEqual([
      'F1 review r-must',
      'F2 critic c-must',
      'F3 review r-should',
      'F4 critic c-nit',
    ])
  })

  it('keeps ids unique across merged parts', () => {
    const merged = mergeFindings([review, review])
    expect(new Set(merged.map((f) => f.id)).size).toBe(merged.length)
  })

  it('builds the file with every finding selected unless a selection is carried over', () => {
    const file = buildFindingsFile({ runId: 'r1', round: 1, parts: [review, critic] })
    expect(file.schemaVersion).toBe(1)
    expect(file.runId).toBe('r1')
    expect(file.sources).toEqual({ review: review.parse, critic: critic.parse })
    expect(Object.values(file.selected)).toEqual([true, true, true, true])
    expect(file.fixReport).toBeUndefined()

    const nit = file.findings.find((f) => f.title === 'c-nit') as Finding
    const again = buildFindingsFile({
      runId: 'r1',
      round: 1,
      parts: [review, critic, failedSource('verify')],
      selected: { [nit.id]: false },
      fixReport: { [nit.id]: 'skipped' },
    })
    expect(again.selected[nit.id]).toBe(false)
    expect(again.sources.verify).toEqual({ status: 'failed', count: 0, rawFile: 'verify.md' })
    expect(again.fixReport).toEqual({ [nit.id]: 'skipped' })
    expect(countFindings(again.findings)).toEqual({ must: 2, should: 2 })
    expect(countFindings(again.findings, again.selected)).toEqual({ must: 2, should: 1 })
  })
})

describe('realistic outputs', () => {
  it('a review with a heading, sub-bullets, a code sample and a closing summary', () => {
    const r = parse(
      md(
        "I reviewed the diff against the plan. Here's what I found:",
        '',
        '## Findings',
        '',
        '- [must] `src/cli/version.ts:8` — `--version` prints `undefined` when run from the bundle.',
        '  `package.json` is resolved relative to `process.cwd()`, not the module.',
        '  ```ts',
        "  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))",
        '  ```',
        '  - The test only runs from the repo root, so it passes anyway.',
        '- [should] `tests/cli/version.test.ts:3` — Asserts a hard-coded version string.',
        '  Read it from package.json instead.',
        '- [nit] `README.md:40` — Mention the new flag.',
        '',
        '## Summary',
        '',
        'One blocking issue; the rest is polish.',
      ),
    )
    expect(r.parse).toEqual({ status: 'ok', count: 3, rawFile: 'review.md' })
    expect(r.findings.map((f) => `F${f.n} [${f.severity}] ${f.title}`)).toEqual([
      'F1 [must] `src/cli/version.ts:8`: `--version` prints `undefined` when run from the bundle.',
      'F2 [should] `tests/cli/version.test.ts:3`: Asserts a hard-coded version string.',
      'F3 [should] `README.md:40`: Mention the new flag.',
    ])
    expect(r.findings[0]?.body).toBe(
      md(
        '`package.json` is resolved relative to `process.cwd()`, not the module.',
        '```ts',
        "const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))",
        '```',
        '- The test only runs from the repo root, so it passes anyway.',
      ),
    )
  })

  it('a critic grouped by checklist headings with numbered, bold-tagged items', () => {
    const r = parse(
      md(
        '### 1. Fidelity',
        '',
        '1. **[MUST]** `src/cli/args.ts:22` — `-v` is already `--verbose`; the task asked for `--version` only.',
        '',
        '### 2. Grounding',
        '',
        'Nothing invented.',
        '',
        '### 4. Simpler path',
        '',
        '1. **[consider]** `src/cli/version.ts` — Inline into `args.ts`; a module for one line is needless.',
        '2. **[Critical]**: `src/cli/args.ts:30` — Exits 0 before flushing stdout on Windows.',
      ),
      'critic',
    )
    expect(r.findings.map((f) => [f.n, f.severity, f.source, f.title])).toEqual([
      [
        1,
        'must',
        'critic',
        '`src/cli/args.ts:22`: `-v` is already `--verbose`; the task asked for `--version` only.',
      ],
      [2, 'must', 'critic', '`src/cli/args.ts:30`: Exits 0 before flushing stdout on Windows.'],
      [
        3,
        'should',
        'critic',
        '`src/cli/version.ts`: Inline into `args.ts`; a module for one line is needless.',
      ],
    ])
    expect(r.findings.every((f) => f.body === '')).toBe(true)
  })

  it('many findings', () => {
    const text = Array.from(
      { length: 2000 },
      (_, i) => `- [${i % 3 === 0 ? 'must' : 'should'}] issue ${i}`,
    ).join('\n')
    const r = parse(text)
    expect(r.findings).toHaveLength(2000)
    expect(r.findings.filter((f) => f.severity === 'must')).toHaveLength(667)
    expect(new Set(r.findings.map((f) => f.id)).size).toBe(2000)
  })
})
