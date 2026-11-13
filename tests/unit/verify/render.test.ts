// {{verify}} and the round's findings (results, the Fix skip rule, the template rendering rules):
// `- PASS \`cmd\` (12s)`, `- FAIL \`cmd\` (exit 1, 41s)` + a fenced excerpt, the baseline marker, the 16 KB
// cap without a cut fence; [must] per failure, [should] per Auto-skipped untrusted command, none for env.
import { describe, expect, it } from 'vitest'
import { render as renderTemplate } from '../../../src/core/prompts/template.ts'
import {
  VERIFY_SECTION_CAP_BYTES,
  fencedExcerpt,
  formatTimeout,
  formatVerifyDuration,
  renderVerifySection,
  verifyFindings,
  verifyHasMustFailures,
} from '../../../src/core/verify/render.ts'
import type { VerifyCommandResult } from '../../../src/shared/verify.ts'

const r = (
  o: Partial<VerifyCommandResult> & Pick<VerifyCommandResult, 'name' | 'status'>,
): VerifyCommandResult => ({
  argv: ['pnpm', 'run', o.name],
  exitCode: o.status === 'pass' ? 0 : o.status === 'fail' ? 1 : null,
  durationMs: 0,
  excerpt: '',
  logPath: '',
  ...o,
})

const PASS = r({ name: 'typecheck', status: 'pass', durationMs: 12_300 })
const FAIL = r({
  name: 'test',
  status: 'fail',
  durationMs: 41_000,
  excerpt: 'FAIL src/a.test.ts\nexpected 1 to be 2',
})

describe('formatVerifyDuration / formatTimeout', () => {
  it('seconds, minutes, hours', () => {
    expect(formatVerifyDuration(0)).toBe('0s')
    expect(formatVerifyDuration(12_300)).toBe('12s')
    expect(formatVerifyDuration(101_000)).toBe('1m 41s')
    expect(formatVerifyDuration(3_725_000)).toBe('1h 02m')
    expect(formatTimeout(600_000)).toBe('10m')
    expect(formatTimeout(5_400_000)).toBe('1h 30m')
    expect(formatTimeout(3_600_000)).toBe('1h')
    expect(formatTimeout(1_500)).toBe('2s')
  })
})

describe('renderVerifySection', () => {
  it('PASS and FAIL lines as the template writes them, the excerpt fenced under the failure', () => {
    expect(renderVerifySection([PASS, FAIL])).toBe(
      [
        '- PASS `pnpm run typecheck` (12s)',
        '- FAIL `pnpm run test` (exit 1, 41s)',
        '  ```',
        '  FAIL src/a.test.ts',
        '  expected 1 to be 2',
        '  ```',
      ].join('\n'),
    )
  })

  it('a baseline failure reads "already failing before this run"', () => {
    expect(renderVerifySection([FAIL], { test: 'fail' }).split('\n')[0]).toBe(
      '- FAIL (already failing before this run) `pnpm run test` (exit 1, 41s)',
    )
    expect(renderVerifySection([FAIL], { test: 'pass' }).split('\n')[0]).toBe(
      '- FAIL `pnpm run test` (exit 1, 41s)',
    )
  })

  it('commands that did not run say why; a timeout says so', () => {
    const text = renderVerifySection([
      r({ name: 'lint', status: 'env', reason: 'Dim Factory could not find eslint' }),
      r({ name: 'e2e', status: 'skipped', reason: 'Not run: failFast stopped the round after test failed' }),
      r({ name: 'build', status: 'skipped-untrusted', trust: 'changed' }),
      r({ name: 'fmt', status: 'skipped-untrusted' }),
      r({
        name: 'slow',
        status: 'fail',
        exitCode: null,
        timedOut: true,
        durationMs: 600_000,
        excerpt: 'waiting',
      }),
    ])
    expect(text.split('\n')).toEqual([
      '- NOT RUN `pnpm run lint` (could not run: Dim Factory could not find eslint)',
      '- NOT RUN `pnpm run e2e` (Not run: failFast stopped the round after test failed)',
      '- NOT RUN `pnpm run build` (changed since it was trusted)',
      '- NOT RUN `pnpm run fmt` (not trusted)',
      '- FAIL `pnpm run slow` (timed out, 10m 00s)',
      '  ```',
      '  waiting',
      '  ```',
    ])
  })

  it('no results → empty, so {{#verify}} drops its section', () => {
    expect(renderVerifySection([])).toBe('')
  })

  it('a fence longer than any backtick run in the excerpt', () => {
    expect(fencedExcerpt('a ``` b')).toBe('````\na ``` b\n````')
    const text = renderVerifySection([r({ name: 't', status: 'fail', excerpt: '```js\ncode\n```' })])
    expect(text).toContain('  ````\n  ```js\n  code\n  ```\n  ````')
  })

  it('stays within 16 KB by shortening excerpts (their last lines stay), never cutting a fence', () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n')
    const many = Array.from({ length: 8 }, (_, i) => r({ name: `t${i}`, status: 'fail', excerpt: big }))
    const text = renderVerifySection([PASS, ...many])
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(VERIFY_SECTION_CAP_BYTES)
    expect(text.match(/^ {2}```$/gm)?.length).toBe(16)
    expect(text).toContain(`line 199 ${'x'.repeat(60)}`)
    expect(
      text.startsWith('- PASS `pnpm run typecheck` (12s)\n- FAIL `pnpm run t0` (exit 1, 0s)\n  ```\n  …'),
    ).toBe(true)
    // The template's own 16 KB cap then has nothing to cut.
    const out = renderTemplate(
      '{{diff}}\n{{#verify}}\n{{verify}}\n{{/verify}}',
      { verify: text, diff: 'd' },
      { template: 'review' },
    )
    expect(out.warnings.filter((w) => w.code === 'truncated')).toEqual([])
    expect(out.text).toContain(text)
  })
})

describe('verifyFindings', () => {
  it('[must] per failing command with the excerpt; nothing for passes, env and skips', () => {
    const f = verifyFindings([
      PASS,
      FAIL,
      r({ name: 'lint', status: 'env', reason: 'missing' }),
      r({ name: 'e2e', status: 'skipped' }),
    ])
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({
      n: 1,
      severity: 'must',
      source: 'verify',
      title: '`pnpm run test` failed (exit 1, 41s)',
      body: '```\nFAIL src/a.test.ts\nexpected 1 to be 2\n```',
      flags: [],
      round: 1,
    })
  })

  it('[should] per command Auto skipped as untrusted; must findings first', () => {
    const f = verifyFindings(
      [
        r({ name: 'build', status: 'skipped-untrusted', trust: 'changed' }),
        FAIL,
        r({ name: 'fmt', status: 'skipped-untrusted', trust: 'untrusted' }),
      ],
      { round: 2 },
    )
    expect(f.map((x) => [x.n, x.severity, x.title, x.round])).toEqual([
      [1, 'must', '`pnpm run test` failed (exit 1, 41s)', 2],
      [
        2,
        'should',
        '`pnpm run build` changed since it was trusted, so it was not run (it needs your approval)',
        2,
      ],
      [3, 'should', '`pnpm run fmt` is not trusted, so it was not run (it needs your approval)', 2],
    ])
  })

  it('a baseline failure is [should] + preexisting and does not block the skip rule', () => {
    const f = verifyFindings([FAIL], { baseline: { test: 'fail' } })
    expect(f[0]).toMatchObject({
      severity: 'should',
      flags: ['preexisting'],
      title: '`pnpm run test` failed (exit 1, 41s) (already failing before this run)',
    })
    expect(verifyHasMustFailures([FAIL], { test: 'fail' })).toBe(false)
    expect(verifyHasMustFailures([FAIL])).toBe(true)
    expect(verifyHasMustFailures([PASS, r({ name: 'x', status: 'env' })])).toBe(false)
  })

  it('a timeout is a [must] too', () => {
    const f = verifyFindings([
      r({ name: 's', status: 'fail', exitCode: null, timedOut: true, durationMs: 600_000 }),
    ])
    expect(f[0]?.title).toBe('`pnpm run s` timed out (10m 00s)')
    expect(f[0]?.body).toBe('')
  })

  it('ids are stable across rounds (the duration and exit code are not part of them) and unique', () => {
    const a = verifyFindings([FAIL])[0]?.id
    const b = verifyFindings([{ ...FAIL, durationMs: 1, exitCode: 2 }])[0]?.id
    expect(a).toBe(b)
    const twice = verifyFindings([FAIL, { ...FAIL, name: 'test (2)' }])
    expect(new Set(twice.map((x) => x.id)).size).toBe(2)
  })
})
