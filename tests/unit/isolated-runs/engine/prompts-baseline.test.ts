// `{{verify}}` with the verify:0 baseline ("A command that failed in verify:0 too renders as
// `- FAIL (already failing before this run) \`cmd\``"): the reviewers and Fix are told which failures are not the run's.
import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { buildPrompt } from '@core/supervisor/effects.ts'
import { VFlow, result, verifyMust } from '../../verify/machine-helpers.ts'

const config = (): ResolvedConfig => resolveBuiltinConfig({ profile: 'claude-only' })

describe('{{verify}} with a baseline', () => {
  it('a failure the baseline had too reads "already failing before this run"; a new one stays FAIL', () => {
    const f = new VFlow().toS1()
    f.check([
      { name: 'test', argv: ['npm', 'run', 'test'], cwdRel: '.', body: null, trust: 'trusted' },
      { name: 'lint', argv: ['npm', 'run', 'lint'], cwdRel: '.', body: null, trust: 'trusted' },
    ])
    f.round([result('test', 'fail'), result('lint', 'fail')], [verifyMust('test'), verifyMust('lint')])
    const s = {
      ...f.state,
      isolation: { rows: [], baseline: { test: 'fail' as const, lint: 'pass' as const } },
    }
    const text = buildPrompt(s, config(), { step: 'review', launch: { fresh: {} } }, { diff: '' }).text
    expect(text).toContain('- FAIL (already failing before this run) `npm run test` (exit 1, 2s)')
    expect(text).toContain('- FAIL `npm run lint` (exit 1, 2s)')
  })
})
