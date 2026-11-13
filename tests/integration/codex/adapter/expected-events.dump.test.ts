// A tool, not a check (tests/fixtures/codex/README.md "Re-recording live"): after a live re-record, it replays the fixtures
// named in DUMP_IDS through the real adapter, as replay.test.ts does, and writes what the adapter emits as their
// expected.events.json (partial entries, README "expected.events.json"; the replay's folder back to <CWD>). Skipped
// unless DUMP_IDS is set:
//
//   DUMP_IDS=X02-review-agent-deltas,exec/E01-review-readonly pnpm vitest run --project integration
//     tests/integration/codex/adapter/expected-events.dump.test.ts
//
// Passes only: X01b (the probe's handshake) has no pass to drive.
//
// Review the diff: a live recording's events are what the adapter makes of it, so a wrong one is an adapter fix.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../../../../src/shared/events.ts'
import type { Entry } from './helpers.ts'
import {
  drive,
  fakeCodex,
  fakeSetup,
  loadFixture,
  probeFactsFor,
  replayScenario,
  startOptionsFor,
  tempDir,
  withCwdPlaceholder,
} from './helpers.ts'

const IDS = (process.env['DUMP_IDS'] ?? '').split(',').filter((s) => s !== '')

function partial(e: Entry): Record<string, unknown> | undefined {
  switch (e.type) {
    case 'shell-command':
    case 'guardrail-blocked':
    case 'liveness':
      return undefined
    case 'waiting':
      return { type: 'waiting', tasks: e.tasks }
    case 'session':
      return { type: 'session', id: e.id }
    case 'text':
      return { type: 'text', delta: e.delta }
    case 'tool':
      if (e.name === 'todo') return { type: 'tool', name: 'todo' }
      return e.phase === 'end'
        ? { type: 'tool', id: e.id, name: e.name, phase: 'end', status: e.status }
        : { type: 'tool', id: e.id, name: e.name, phase: e.phase }
    case 'ask':
      return { type: 'ask', kind: e.kind, allowSession: e.allowSession }
    case 'done':
      return e.usage === undefined
        ? { type: 'done', result: e.result }
        : { type: 'done', result: e.result, usage: e.usage }
    case 'error':
      return { type: 'error', fatal: e.fatal, category: e.category }
    case 'auto-answered':
      return { type: 'auto-answered', decision: e.decision, why: e.why }
    case 'ask-withdrawn':
      return { type: 'ask-withdrawn' }
    case 'allow-rule':
      return { type: 'allow-rule', rule: { vendor: e.rule.vendor, kind: e.rule.kind, tool: e.rule.tool } }
    case 'plan-captured':
      return { type: 'plan-captured', markdown: e.markdown, source: e.source }
    case 'meta':
      return e.key === 'lateAllowRule' || e.key === 'planFallback'
        ? { type: 'meta', key: e.key }
        : { type: 'meta', key: e.key, value: e.value }
    case 'context':
    case 'compaction':
    case 'context-breakdown':
    case 'subagent-tokens':
      return { ...e }
    default:
      return { ...(e as Record<string, unknown>) }
  }
}

describe.runIf(IDS.length > 0)('dump expected events', () => {
  for (const spec of IDS) {
    const [route, id] = spec.includes('/')
      ? (spec.split('/') as ['app-server' | 'exec', string])
      : ['app-server' as const, spec]
    it(
      spec,
      async () => {
        const f = loadFixture(route, id)
        const setup = await fakeSetup()
        const p = f.header.pass!
        const fake = fakeCodex(setup, replayScenario(f), {
          facts: {
            route: f.route,
            ...(p.winSandbox !== undefined ? { winSandbox: p.winSandbox } : {}),
            ...probeFactsFor(f),
          },
          adapter: { vendorEnv: { FAKE_CLI_OUT_CWD: '1' } },
        })
        const cwd = tempDir('codex-cwd-')
        const o = startOptionsFor(f, cwd)
        const stop = p.stop
        const d = await drive(fake.adapter, o, p.answers ?? [], {
          ...(stop !== undefined
            ? {
                stopAfter: (e: NormalizedEvent) =>
                  e.type === stop.after.type &&
                  (stop.after.phase === undefined || (e as { phase?: string }).phase === stop.after.phase),
                stopReason: stop.reason,
              }
            : {}),
        })
        const errors = fake.logEntries().filter((e) => e['kind'] === 'error')
        expect(errors).toEqual([])
        const out = withCwdPlaceholder(d.entries, cwd)
          .map(partial)
          .filter((x) => x !== undefined)
        writeFileSync(join(f.dir, 'expected.events.json'), `${JSON.stringify(out, null, 2)}\n`)
      },
      60_000,
    )
  }
})
