// Context health through createCore and the fake Claude: an Implement pass whose CLI compacts its context
// automatically (C23s) reports the meter as it fills and the compaction (throttled `context` bodies), the run summary
// keeps the pass's peak, compactions and baseline, and once the run is over the snapshot carries the Context health
// report and runs/<id>/context-health.json holds the same. The names the breakdown gives never reach Dim Factory's
// own log.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { ContextHealthReport } from '../../../src/shared/context.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from './scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

/** The fake's answer to get_context_usage: one MCP server with a name that must stay out of the log. */
const BREAKDOWN = {
  totalTokens: 12_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  memoryFiles: [],
  mcpTools: [{ name: 'mcp__zz-secret-server__a', serverName: 'zz-secret-server', tokens: 11_000 }],
  agents: [],
}

describe('context health', () => {
  it('meter, compaction, summary, end-of-run report and context-health.json', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C23s-compact-auto',
          write: { path: 'src/version.ts', content: 'export const v = 1\n' },
          // A moment before and after the compaction starts: the breakdown's answer (the window) lands meanwhile.
          holdAroundCompactingMs: 400,
        },
      ],
    })
    sc.env['FAKE_CLI_CONTEXT_USAGE_JSON'] = JSON.stringify(BREAKDOWN)
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
    const done = await c.waitFor(settled, 60_000)
    expect(done.status).toBe('completed')
    await c.settle(10_000)

    // The meter's bodies for Implement, once the window is known (the start breakdown's answer, which may come before
    // or after the first request): near full, summarising, after. Each a whole point or a compaction change.
    const bodies = events
      .filter((e) => e.runId === r.value.runId && e.body.t === 'context' && e.body.step === 'implement')
      .map((e) => e.body)
      .flatMap((b) =>
        b.t === 'context' && b.percent !== undefined ? [[b.percent, b.compactions, b.compacting]] : [],
      )
    expect(bodies.slice(-3)).toEqual([
      [83, 0, false],
      [83, 0, true],
      [16, 1, false],
    ])

    const snap = await core.invoke('runs.get', { runId: r.value.runId })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(snap.value.steps.implement.context).toMatchObject({
      percent: 16,
      peakPercent: 83,
      compactions: 1,
      window: 200_000,
      windowFrom: 'vendor',
    })
    expect(snap.value.summary.steps.find((s) => s.key === 'implement')?.context).toMatchObject({
      peakPercent: 83,
      compactions: 1,
    })
    const health = snap.value.contextHealth
    expect(health?.passes.map((p) => p.step)).toEqual(['plan', 'implement'])
    const impl = health?.passes.find((p) => p.step === 'implement')
    expect(impl?.contributors[0]).toEqual({
      kind: 'mcp',
      name: 'zz-secret-server',
      tokens: 11_000,
      tools: 1,
      from: 'vendor',
      // The pass called tools, none of them on this server.
      calls: 0,
    })
    expect(health?.items.some((i) => i.id === 'D1' && i.step === 'implement')).toBe(true)

    const file = join(home, 'runs', r.value.runId, 'context-health.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')) as ContextHealthReport).toEqual(health)

    // Names are the user's: in the run's history, never in Dim Factory's own log.
    const logs = join(home, 'logs')
    const logText = existsSync(logs)
      ? readdirSync(logs)
          .map((f) => readFileSync(join(logs, f), 'utf8'))
          .join('\n')
      : ''
    expect(logText).not.toContain('zz-secret-server')
  }, 90_000)
})
