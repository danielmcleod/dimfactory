// Context health's reactions through createCore and the fake Claude:
//   - an Auto run whose Implement compacts three times restarts it once in a fresh session, and the new prompt carries
//     the {{state}} note (where the work stands)
//   - a run whose Implement makes the same call twelve times shows the loop card at eight and stops the pass at twelve
//     (runaway_loop)
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { matchFullMode } from '../attention/helpers.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario, stdinByScript } from './scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

describe('context reactions', () => {
  it('Auto: three compactions restart Implement fresh with a summary', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        { recording: 'C23s-compact-auto', compactions: 3, afterCompactionsMs: 20_000 },
        {
          recording: 'C23s-compact-auto',
          write: { path: 'src/version.ts', content: 'export const v = 1\n' },
        },
      ],
    })
    // Auto launches Implement in full mode (bypassPermissions).
    matchFullMode(sc)
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const r = await core.invoke('runs.start', {
      folder,
      task: 'add a --version flag',
      overrides: {
        auto: true,
        passes: { review: { enabled: false }, critic: { enabled: false } },
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = core.controller(r.value.runId)!
    const done = await c.waitFor(settled, 60_000)
    expect(done.status).toBe('completed')
    expect(done.notes).toContain('Auto: restarted Implement fresh with a summary after 3 compactions.')
    expect(done.steps.implement.attempt).toBe(2)
    expect(done.steps.implement.autoRetryUsed).toBe(true)
    // The second Implement's prompt says where the work stands.
    const stdin = stdinByScript(sc.entries())
    const second = (stdin.get('implement-2.script.jsonl') ?? []).join('\n')
    expect(second).toContain('You are continuing Implement in a fresh session.')
    expect(second).toContain('summarised its notes 3 times')
    expect(second).toContain('Files changed so far:')
    const first = (stdin.get('implement-1.script.jsonl') ?? []).join('\n')
    expect(first).not.toContain('You are continuing Implement in a fresh session.')
  }, 90_000)

  it('the same call twelve times: the loop card at eight, the loop stop at twelve', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C23s-compact-auto', toolCalls: 12, delayMs: 0 }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const events: RunEnvelope[] = []
    core.bus.attach({ name: 't', run: (e) => events.push(e), global: () => undefined })
    const r = await core.invoke('runs.start', {
      folder,
      task: 'add a --version flag',
      overrides: {
        gates: { afterPlan: false },
        passes: { review: { enabled: false }, critic: { enabled: false } },
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = core.controller(r.value.runId)!
    const st = await c.waitFor((s) => s.steps.implement.status === 'failed', 60_000)
    expect(st.steps.implement.failure).toMatchObject({
      category: 'runaway_loop',
      classifiedBy: 'app',
      message: 'The AI kept repeating the same step, so Dim Factory stopped it.',
    })
    const cards = events
      .filter((e) => e.runId === r.value.runId && e.body.t === 'card')
      .map((e) => (e.body.t === 'card' ? `${e.body.card.kind}:${e.body.state}` : ''))
    expect(cards).toContain('loop:open')
    expect(cards).toContain('loop:resolved')
    const snag = events.find((e) => e.runId === r.value.runId && e.body.t === 'snag')
    expect(JSON.stringify(snag?.body)).toContain('Retry in a fresh session')
  }, 90_000)
})
