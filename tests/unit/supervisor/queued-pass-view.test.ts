// toRunSnapshot (the PassCard header): a pass that has not spawned yet carries its configured vendor, model and
// mode from the run's resolved config, so a queued card names them; a spawned pass keeps what it actually ran with,
// and a disabled pass gets nothing.
import { describe, expect, it } from 'vitest'
import { resolveBuiltinConfig } from '../../../src/core/config/builtins.ts'
import { toRunSnapshot } from '../../../src/core/supervisor/derive.ts'
import { initRunState, runConfigFromResolved } from '../../../src/core/supervisor/machine.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'

function run(): RunState {
  return initRunState({
    runId: '20261007T120000Z-abcd',
    displayNo: 1,
    folder: 'C:\\tmp\\ts-small',
    folderKey: '0123456789abcdef',
    task: 'add a --version flag',
    profile: 'claude-only',
    createdAt: 1000,
    config: runConfigFromResolved(resolveBuiltinConfig({ profile: 'claude-only' }), 'native'),
  })
}

describe('queued pass views', () => {
  it('fill vendor, model and mode from the run config', () => {
    const s = run()
    const snap = toRunSnapshot(s, 0, 2000)
    const impl = snap.steps.implement
    expect(impl.status).toBe('queued')
    expect(impl.vendor).toBe(s.config.passes.implement.vendor)
    expect(impl.model).toBe(s.config.passes.implement.model)
    expect(impl.mode).toBe(s.config.passes.implement.mode)
    expect(snap.steps.review.mode).toBe('readonly')
  })

  it('leave a spawned pass and a disabled pass alone', () => {
    const s = run()
    s.steps.plan.vendor = 'claude'
    s.steps.plan.model = 'opus-actual'
    s.steps.plan.mode = 'readonly'
    s.steps.plan.status = 'running'
    s.config.passes.critic.enabled = false
    const snap = toRunSnapshot(s, 0, 2000)
    expect(snap.steps.plan.model).toBe('opus-actual')
    expect(snap.steps.critic.vendor).toBeUndefined()
    expect(snap.steps.critic.mode).toBeUndefined()
  })
})
