// What a guardrail refused reaches the readers and Fix: Review, Critic and Security see it beside the checks Dim
// Factory ran, and Fix sees it in its notes, so nobody asks for the refused change to be made again.
import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { GuardrailFinding } from '@shared/guardrails.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { buildPrompt } from '@core/supervisor/effects.ts'
import type { LaunchPlan, RunState } from '@core/supervisor/types.ts'
import { VFlow, result, verifyMust } from './machine-helpers.ts'

const config = (): ResolvedConfig => resolveBuiltinConfig({ profile: 'claude-only' })
const fresh: LaunchPlan = { fresh: {} }

const prompt = (s: RunState, step: 'review' | 'critic' | 'fix'): string =>
  buildPrompt(s, config(), { step, launch: fresh }, { diff: 'Files changed (1):\nA src/version.ts' }).text

const push: GuardrailFinding = {
  kind: 'forbiddenCommand',
  rule: 'Forbidden command: git push',
  onBreak: 'stop',
  subject: 'git push origin main',
  detail: 'This command is forbidden.',
}
const settings: GuardrailFinding = {
  kind: 'protectedFiles',
  self: true,
  rule: 'Settings files',
  onBreak: 'undo',
  subject: '.claude/settings.json',
  detail: 'Runs may not change settings files.',
}

const REFUSED =
  "- Dim Factory's guardrail refused git push origin main (Forbidden command: git push); this was on purpose, so do not report its absence as a finding."

describe('guardrail refusals in the prompts', () => {
  it('Review and Critic are told what was refused and put back, beside the checks', () => {
    // The reducer takes a refusal whenever it comes; sent once S1 is in, the run is under way.
    const f = new VFlow({ enabled: false }).toS1()
    f.send({ t: 'guardrail-findings', step: 'implement', findings: [push], undone: [], blocked: true })
    f.send({ t: 'guardrail-findings', step: 'implement', findings: [settings], undone: [settings.subject] })
    for (const step of ['review', 'critic'] as const) {
      const text = prompt(f.state, step)
      expect(text).toContain(`Guardrails:\n${REFUSED}`)
      expect(text).toContain(
        "Dim Factory's guardrail put back a change to .claude/settings.json (Settings files)",
      )
      expect(text.indexOf('Guardrails:')).toBeLessThan(text.indexOf('<diff>'))
    }
  })

  it('comes after the verify results when both are there', () => {
    const f = new VFlow().toVerified(result('test', 'pass'))
    f.send({ t: 'guardrail-findings', step: 'implement', findings: [push], undone: [], blocked: true })
    const text = prompt(f.state, 'review')
    expect(text).toContain('- PASS `npm run test` (2s)\n\nGuardrails:')
  })

  it('a finding that was only reported, not refused or put back, adds nothing', () => {
    const f = new VFlow({ enabled: false }).toS1()
    f.send({
      t: 'guardrail-findings',
      step: 'implement',
      findings: [{ ...push, onBreak: 'ask' }],
      undone: [],
    })
    expect(prompt(f.state, 'review')).not.toContain('Guardrails:')
    expect(f.state.guardrails?.refused).toBeUndefined()
  })

  it('Fix gets the same lines in its notes', () => {
    const f = new VFlow().toVerified(result('test', 'fail', { excerpt: 'FAIL x' }), [verifyMust('test')])
    f.send({ t: 'guardrail-findings', step: 'implement', findings: [push], undone: [], blocked: true })
    f.toJoinAfterVerify('none', 'none')
    f.choose('gate:beforeFix', 'continue')
    expect(prompt(f.state, 'fix')).toContain(REFUSED.slice(2))
  })

  it('keeps each line once', () => {
    const f = new VFlow({ enabled: false }).toS1()
    for (let i = 0; i < 3; i++)
      f.send({ t: 'guardrail-findings', step: 'implement', findings: [push], undone: [], blocked: true })
    expect(f.state.guardrails?.refused).toHaveLength(1)
  })
})
