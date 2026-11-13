// `{{verify}}` (templates and their rendering rules): Review, Critic and Fix get verify:1's
// results (PASS / FAIL with its fenced excerpt / NOT RUN); a run without a verify round renders no section; Fix's
// `{{findings}}` carries the verify `[must]` (source verify) and a Fix reusing Implement's session still gets it.
import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { buildPrompt } from '@core/supervisor/effects.ts'
import { verifyResultsFor } from '@core/supervisor/machine.ts'
import type { LaunchPlan, RunState } from '@core/supervisor/types.ts'
import { VERIFY_REASON } from '@core/supervisor/machine.ts'
import { VFlow, result, trusted, untrusted, verifyMust } from './machine-helpers.ts'

const config = (): ResolvedConfig => resolveBuiltinConfig({ profile: 'claude-only' })

const fresh: LaunchPlan = { fresh: {} }

const prompt = (s: RunState, step: 'review' | 'critic' | 'fix', launch: LaunchPlan = fresh): string =>
  buildPrompt(s, config(), { step, launch }, { diff: 'Files changed (1):\nA src/version.ts' }).text

function failedVerify(): VFlow {
  return new VFlow().toVerified(
    result('test', 'fail', { excerpt: 'FAIL src/version.test.ts\n  expected "1.0.0", got "0.1.0"' }),
    [verifyMust('test')],
  )
}

describe('{{verify}} in the reviewer prompts', () => {
  it('Review and Critic: FAIL with the fenced excerpt, under "Automated checks Dim Factory ran after the change"', () => {
    const f = failedVerify()
    for (const step of ['review', 'critic'] as const) {
      const text = prompt(f.state, step)
      expect(text).toContain(
        'Automated checks Dim Factory ran after the change:\n- FAIL `npm run test` (exit 1, 2s)',
      )
      expect(text).toContain('  ```\n  FAIL src/version.test.ts\n    expected "1.0.0", got "0.1.0"\n  ```')
      // The section sits before the diff, as the template lays it out.
      expect(text.indexOf('Automated checks')).toBeLessThan(text.indexOf('<diff>'))
    }
  })

  it('a passing round reads PASS with its duration', () => {
    const f = new VFlow().toVerified(result('test', 'pass', { durationMs: 12_400 }))
    expect(prompt(f.state, 'review')).toContain('- PASS `npm run test` (12s)')
  })

  it('Auto skipped an untrusted command: NOT RUN (not trusted)', () => {
    const f = new VFlow({ auto: true }).toS1()
    f.check([untrusted('test'), trusted('lint')])
    f.round(
      [
        result('test', 'skipped-untrusted', { reason: VERIFY_REASON.notTrusted, trust: 'untrusted' }),
        result('lint', 'pass'),
      ],
      [],
    )
    const text = prompt(f.state, 'review')
    expect(text).toContain('- NOT RUN `npm run test` (not trusted)\n- PASS `npm run lint` (2s)')
  })

  it('no verify round → no section ({{#verify}} drops out)', () => {
    const f = new VFlow({ enabled: false }).toS1()
    const text = prompt(f.state, 'review')
    expect(text).not.toContain('Automated checks')
    expect(verifyResultsFor(f.state, 'review')).toEqual([])
  })

  it('a round still running renders nothing (only finished rounds count)', () => {
    const f = new VFlow().toS1()
    f.check([trusted()])
    expect(verifyResultsFor(f.state, 'review')).toEqual([])
  })
})

describe('Fix: {{findings}} with the verify [must], {{verify}} as the latest results', () => {
  it('a fresh Fix gets F1 (verify) and the latest check results', () => {
    const f = failedVerify()
    f.toJoinAfterVerify('none', 'none')
    f.choose('gate:beforeFix', 'continue')
    const text = prompt(f.state, 'fix')
    expect(text).toContain('- [must] F1 (verify) `npm run test` failed (exit 1, 2s)')
    expect(text).toContain('Latest automated check results:\n- FAIL `npm run test` (exit 1, 2s)')
  })

  it('a Fix reusing Implement’s session still gets the check results (task, plan and diff stay empty)', () => {
    const f = failedVerify()
    f.toJoinAfterVerify('none', 'none')
    f.choose('gate:beforeFix', 'continue')
    const text = prompt(f.state, 'fix', {
      resume: { sessionId: 'impl-session' },
      session: { reuse: true, sessionId: 'impl-session' },
    })
    expect(text).toContain('Latest automated check results:')
    expect(text).not.toContain('<diff>')
    expect(text).not.toContain('add a --version flag')
  })

  it('the excerpt stays within the 16 KB {{verify}} cap', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const f = new VFlow().toVerified(result('test', 'fail', { excerpt: big }), [verifyMust('test')])
    const text = prompt(f.state, 'review')
    const start = text.indexOf('Automated checks Dim Factory ran after the change:')
    const end = text.indexOf('This diff is the complete set')
    expect(Buffer.byteLength(text.slice(start, end), 'utf8')).toBeLessThan(16 * 1024 + 200)
    expect(text).toContain('line 1999')
  })
})
