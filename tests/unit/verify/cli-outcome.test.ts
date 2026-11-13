// CLI footer (outcome strings; "Auto → skip the command and add a [should] finding"; the
// Fix skip rule counts only [must] verify failures): a clean run can list a [should] from Verify, so the headline
// names the counts instead of "no findings".
import { describe, expect, it } from 'vitest'
import { headline } from '../../../src/cli/render.ts'
import { resolveBuiltinConfig } from '../../../src/core/config/builtins.ts'
import { initRunState, runConfigFromResolved } from '../../../src/core/supervisor/machine.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { Finding } from '../../../src/shared/findings.ts'

const T0 = 1_000_000

function clean(list: Finding[]): RunState {
  const s = initRunState({
    runId: '20261009T000000Z-abcd',
    displayNo: 3,
    folder: 'C:/work/ts-small',
    folderKey: 'k',
    task: 'add a --version flag',
    profile: 'claude-only',
    createdAt: T0,
    config: runConfigFromResolved(resolveBuiltinConfig({ profile: 'claude-only' })),
  })
  s.started = true
  s.status = 'completed'
  s.phase = 'done'
  s.outcome = 'clean'
  s.endedAt = T0 + 65_000
  s.findings = { sources: {}, list, selected: [], notes: [] }
  return s
}

describe('CLI headline: clean with a [should] from Verify', () => {
  it('names the counts', () => {
    const should: Finding = {
      id: 'v1',
      n: 1,
      severity: 'should',
      source: 'verify',
      title: '`npm run check` changed since it was trusted, so it was not run (it needs your approval)',
      body: '',
      flags: [],
      round: 1,
    }
    expect(headline(clean([should]), 0)).toBe('Run #3 completed (Clean) in 1m 05s · 0 must · 1 should')
  })

  it('still says "no findings" when there are none', () => {
    expect(headline(clean([]), 0)).toBe('Run #3 completed (Clean) in 1m 05s · no findings')
  })
})
