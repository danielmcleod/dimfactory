// A tool, not a check (tests/fixtures/gemini/README.md "Re-recording live"): after a live
// re-record, it replays the Gemini fixtures named in DUMP_IDS through the real Gemini adapter, as
// tests/integration/acp/adapter/replay.test.ts does, and writes what the adapter emits as their expected.events.json
// (the partial entries of the README's "expected.events.json"; the replay's folder back to <CWD>). Skipped unless
// DUMP_IDS is set:
//
//   DUMP_IDS=G07-review-readonly-rejects,G08-plan-exit-captured pnpm vitest run --project integration
//     tests/integration/acp/fixtures/expected-events.dump.test.ts
//
// Passes only: G01 (the probe's handshake) has no pass to drive. Review the diff: a live recording's events are what
// the adapter makes of it, so a wrong one is an adapter fix, never an edit to the recording.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../../src/core/adapters/types.ts'
import type { NormalizedEvent } from '../../../../src/shared/events.ts'
import type { Answer, Entry } from '../adapter/helpers.ts'
import { acpScenario, drive, fakeGemini, fakeSetup, loadFixture, tempDir } from '../adapter/helpers.ts'

const IDS = (process.env['DUMP_IDS'] ?? '').split(',').filter((s) => s !== '')

interface FixturePass {
  kind: 'pass' | 'probe'
  step?: StartOptions['step']
  mode?: StartOptions['mode']
  planNative?: boolean
  prompt?: string
  model?: string
  trustFolder?: boolean
  resume?: StartOptions['resume']
  allowRules?: StartOptions['allowRules']
  answers?: Answer[]
  stop?: { after: { type: string; phase?: string }; reason: 'user' | 'timeout' }
}

/** One entry as expected.events.json keeps it (synthesize.mjs `ev`): only the fields the contract fixes. */
export function partialEntry(e: Entry): Record<string, unknown> | undefined {
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
      return e.phase === 'end'
        ? { type: 'tool', id: e.id, phase: 'end', status: e.status }
        : { type: 'tool', id: e.id, phase: e.phase }
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
      return { type: 'allow-rule', rule: { vendor: e.rule.vendor, kind: e.rule.kind } }
    case 'plan-captured':
      return { type: 'plan-captured', markdown: e.markdown, source: e.source }
    case 'meta':
      return { type: 'meta', key: e.key }
    case 'context':
    case 'compaction':
    case 'context-breakdown':
    case 'subagent-tokens':
      return { ...e }
  }
}

/** The replay's own pass folder back to the recording's `<CWD>` in every string. */
function withCwdPlaceholder<T>(value: T, cwd: string): T {
  const spellings = [...new Set([cwd, cwd.split('\\').join('/')])]
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return spellings.reduce((s, c) => s.split(c).join('<CWD>'), v)
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

describe('the dump format', () => {
  it('keeps what expected.events.json fixes and drops liveness, ids of asks and values of meta', () => {
    expect(partialEntry({ type: 'liveness' })).toBeUndefined()
    expect(
      partialEntry({
        type: 'ask',
        requestId: 'r',
        kind: 'shell',
        allowSession: false,
        tool: 'run_shell_command',
        summary: 'npm test',
        expiresAt: 1,
      } as unknown as Entry),
    ).toEqual({ type: 'ask', kind: 'shell', allowSession: false })
    expect(partialEntry({ type: 'meta', key: 'usageApprox', value: true })).toEqual({
      type: 'meta',
      key: 'usageApprox',
    })
  })
})

describe.runIf(IDS.length > 0)('dump expected events', () => {
  for (const id of IDS) {
    it(
      id,
      async () => {
        const f = loadFixture(id)
        const p = (f.header.pass ?? { kind: 'pass' }) as unknown as FixturePass
        expect(p.kind, 'only a pass can be driven').toBe('pass')
        const setup = await fakeSetup()
        const fake = fakeGemini(setup, acpScenario(f.recording), { vendorEnv: { FAKE_CLI_OUT_CWD: '1' } })
        const cwd = tempDir('gemini-dump-')
        const o: StartOptions = {
          runId: 'run-dump',
          step: p.step ?? 'implement',
          cwd,
          prompt: p.prompt ?? '',
          mode: p.mode ?? 'autoedit',
          planNative: p.planNative ?? false,
          allowRules: p.allowRules ?? [],
          askTimeoutMs: 600_000,
          trustFolder: p.trustFolder ?? false,
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.resume !== undefined ? { resume: p.resume } : {}),
        }
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
        expect(fake.logEntries().filter((e) => e['kind'] === 'error')).toEqual([])
        const out = withCwdPlaceholder(d.entries, cwd)
          .map(partialEntry)
          .filter((x) => x !== undefined)
        writeFileSync(join(f.dir, 'expected.events.json'), `${JSON.stringify(out, null, 2)}\n`)
      },
      60_000,
    )
  }
})
