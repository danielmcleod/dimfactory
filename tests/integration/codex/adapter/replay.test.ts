// Every Codex fixture (tests/fixtures/codex/{app-server,exec}/<ID>/recording.jsonl, X01-X17 and E01-E08, SYNTHESIZED
// until recorded live) replayed through the real adapter, the real resolver and spawn path and the fake CLI
// (the fake deep-compares every host frame and exits 99 on a mismatch). Checks the contract invariants,
// the recorded expected events, and what each scenario is about (approvals, resume echo, plan fallback, X17, sandbox).
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { META_PLAN_FALLBACK } from '../../../../src/core/adapters/codex/normalize.ts'
import { META_STRUCTURED_OUTPUT } from '../../../../src/core/adapters/types.ts'
import { addUsage } from '../../../../src/core/adapters/usage.ts'
import type { NormalizedEvent } from '../../../../src/shared/events.ts'
import type { Fixture, ScenarioEntry } from './helpers.ts'
import {
  COMMITTED_SCHEMA,
  checkInvariants,
  drive,
  eventsOf,
  fakeCodex,
  fakeSetup,
  fixtureIds,
  loadFixture,
  probeFactsFor,
  replayScenario,
  startOptionsFor,
  tempDir,
  withCwdPlaceholder,
} from './helpers.ts'

const READ_ONLY = new Set(['plan', 'review', 'critic', 'heal', 'catalog', 'research'])

const LOGIN_OUT: ScenarioEntry = {
  match: { argvIncludes: ['login', 'status'] },
  script: [
    { op: 'stderr', line: 'Not logged in' },
    { op: 'exit', code: 1 },
  ],
  repeat: true,
}
const LOGIN_IN: ScenarioEntry = {
  match: { argvIncludes: ['login', 'status'] },
  script: [
    { op: 'stderr', line: 'Logged in using ChatGPT' },
    { op: 'exit', code: 0 },
  ],
  repeat: true,
}
const SCHEMA: ScenarioEntry = {
  match: { argvIncludes: ['generate-json-schema'] },
  script: [
    {
      op: 'copyFiles',
      from: join(COMMITTED_SCHEMA, 'codex_app_server_protocol.schemas.json'),
      argvPath: '--out',
    },
    { op: 'exit', code: 0 },
  ],
  repeat: true,
}

/** The fake never reported a mismatch (it would have exited 99 and logged an error). */
function expectNoMismatch(logEntries: Record<string, unknown>[]): void {
  expect(logEntries.filter((e) => e['kind'] === 'error')).toEqual([])
}

async function replayPass(f: Fixture): Promise<void> {
  const setup = await fakeSetup()
  const p = f.header.pass!
  const fake = fakeCodex(setup, replayScenario(f), {
    facts: {
      route: f.route,
      ...(p.winSandbox !== undefined ? { winSandbox: p.winSandbox } : {}),
      // Live X18a/b: the probe's model list, a pass with no model's first look.
      ...probeFactsFor(f),
    },
    // The server names the pass folder in its requests (a command's cwd, which the allow cache compares).
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
  expectNoMismatch(fake.logEntries())
  checkInvariants(d, { readOnly: READ_ONLY.has(o.step) })
  // Contract invariant: the session's prior totals plus this pass's delta are the cumulative total it reports.
  const done = eventsOf(d.entries).find((e) => e.type === 'done')
  const cumulative = d.handle.cumulativeUsage()
  if (done?.type === 'done' && done.usage !== undefined && cumulative !== undefined) {
    const total = addUsage(o.resume?.priorUsage ?? { input: 0, output: 0 }, done.usage)
    for (const k of ['input', 'output', 'cacheRead', 'reasoning'] as const)
      expect(total[k] ?? 0).toBe(cumulative[k] ?? 0)
  }
  // A live recording names the sandbox as <CWD>; the replay's own folder reads the same.
  if (f.expected !== undefined) expectRecorded(withCwdPlaceholder(d.entries, cwd), f.expected)
  if (f.route === 'exec') {
    // The exec argv: the recorded one, but for the -o file (a Dim Factory temp file, never in the user's folder).
    const start = fake
      .logEntries()
      .find((e) => e['kind'] === 'start' && (e['argv'] as string[]).includes('exec'))
    const argv = (start?.['argv'] as string[] | undefined) ?? []
    const recorded = (f.header.argv ?? []).slice(1).map((a) => a.replaceAll('<CWD>', cwd))
    const mask = (list: string[]): string[] => list.map((a, i) => (list[i - 1] === '-o' ? '<OUT>' : a))
    expect(mask(argv)).toEqual(mask(recorded))
  }
  scenarioChecks(f, d.entries)
}

const EVENT = new Set(['session', 'text', 'tool', 'ask', 'done', 'error'])
const isEvent = (e: unknown): boolean => EVENT.has((e as { type?: string }).type ?? '')
/** The context meter's signals (context, compaction, Claude's breakdown, a subagent's tokens). */
const CONTEXT_SIGNALS = new Set(['context', 'compaction', 'context-breakdown', 'subagent-tokens'])

/**
 * expected.events.json lists events and signals (no liveness) as the fixture's generator saw them. The events must
 * match in order, the signals in order, and every signal must arrive before the terminal event (the engine reads a
 * signal before the event it explains; within one step the adapter emits signals first).
 */
function expectRecorded(entries: Awaited<ReturnType<typeof drive>>['entries'], expected: unknown[]): void {
  expect(eventsOf(entries)).toMatchObject(expected.filter(isEvent))
  // The context meter's signals are checked where the fixture is about them (X21, X22): a fixture whose expected
  // events name none predates them, and its other signals still match in order.
  const aboutContext = expected.some((e) => CONTEXT_SIGNALS.has((e as { type?: string }).type ?? ''))
  const signals = entries.filter(
    (e) =>
      !isEvent(e) &&
      e.type !== 'liveness' &&
      e.type !== 'shell-command' &&
      (aboutContext || !CONTEXT_SIGNALS.has(e.type)),
  )
  expect(signals).toMatchObject(expected.filter((e) => !isEvent(e)))
  const terminal = entries.findIndex((e) => e.type === 'done' || (e.type === 'error' && e.fatal))
  for (const s of signals) if (s.type !== 'ask-withdrawn') expect(entries.indexOf(s)).toBeLessThan(terminal)
}

/** What each scenario is about, beyond the invariants. */
function scenarioChecks(f: Fixture, entries: Awaited<ReturnType<typeof drive>>['entries']): void {
  const events = eventsOf(entries)
  const terminal = events.at(-1)
  switch (f.id) {
    case 'X06a-ask-timeout-cancel':
      expect(terminal).toMatchObject({ type: 'error', category: 'ask_timeout' })
      break
    case 'X08-turn-interrupt':
    case 'E06-killed-mid-command':
      expect(terminal).toMatchObject({ type: 'error', category: 'user_cancelled' })
      break
    case 'X12c-plan-collaboration-rejected':
      expect(entries.some((e) => e.type === 'meta' && e.key === META_PLAN_FALLBACK)).toBe(true)
      expect(terminal).toMatchObject({ type: 'done' })
      break
    case 'X14-resume-id-mismatch':
    case 'X15-resume-unknown-thread':
    case 'E08-resume-unknown-thread':
      expect(terminal).toMatchObject({ type: 'error', category: 'resume_failed' })
      break
    case 'X17-catalog-refresh': {
      const meta = entries.findIndex((e) => e.type === 'meta' && e.key === META_STRUCTURED_OUTPUT)
      const done = entries.findIndex((e) => e.type === 'done')
      expect(meta).toBeGreaterThan(-1)
      expect(meta).toBeLessThan(done)
      break
    }
    case 'X03c-command-approval-allow-session':
      expect(entries.some((e) => e.type === 'allow-rule')).toBe(true)
      break
    default:
      break
  }
}

describe('app-server fixtures', () => {
  const ids = fixtureIds('app-server')
  it('the fixture set is present', () => {
    expect(ids.length).toBeGreaterThan(0)
  })

  for (const id of ids) {
    const f = loadFixture('app-server', id)
    const kind = f.header.pass?.kind
    if (kind === 'pass') {
      it(`${id}: replays through the adapter`, () => replayPass(f), 60_000)
    } else if (kind === 'probe') {
      it(`${id}: the probe handshake (logged out: no model list) and vendor.codex.winSandbox`, async () => {
        const setup = await fakeSetup()
        const fake = fakeCodex(setup, replayScenario(f, [LOGIN_OUT, SCHEMA]), { platform: 'win32' })
        const probe = await fake.adapter.probe()
        expectNoMismatch(fake.logEntries())
        expect(probe.checks.map((c) => [c.id, c.status])).toEqual([
          ['vendor.codex.bin', 'pass'],
          ['vendor.codex.version', 'pass'],
          ['vendor.codex.auth', 'fail'],
          ['vendor.codex.protocol', 'pass'],
          ['vendor.codex.plan', 'pass'],
          ['vendor.codex.winSandbox', 'fail'],
        ])
        expect(probe.checks.find((c) => c.id === 'vendor.codex.winSandbox')).toMatchObject({
          blocking: false,
          category: 'sandbox_unavailable',
        })
        expect(fake.adapter.facts().winSandbox).toBe('notConfigured')
        // This machine's Codex is not ready (autoedit unsupported) until the sandbox is set up.
        expect(probe.capabilities.modes.autoedit.status).toBe('unsupported')
        expect(probe.capabilities.modes.readonly.status).toBe('degraded')
        expect(probe.models).toEqual([])
      }, 60_000)
    } else if (kind === 'listModels') {
      it(`${id}: model/list for the picker once logged in (a pass with no model's first look)`, async () => {
        const setup = await fakeSetup()
        const fake = fakeCodex(setup, replayScenario(f, [LOGIN_IN, SCHEMA]), { platform: 'linux' })
        const models = await fake.adapter.listModels()
        expectNoMismatch(fake.logEntries())
        expect(models.length).toBeGreaterThan(0)
        expect(models.every((m) => m.source === 'cli')).toBe(true)
        // Live balanced run: the probe asks nothing more; its list is what a pass with no model checks first.
        const defaultId = models.find((m) => m.isDefault === true)?.id
        expect(defaultId).toBeDefined()
        expect(fake.adapter.facts().accountModels).toMatchObject({ defaultId })
        expect(fake.adapter.facts().accountModels?.ids).toEqual(
          expect.arrayContaining(models.map((m) => m.id)),
        )
      }, 60_000)
    } else if (kind === 'vendorSetup') {
      it(`${id}: vendorSetup over a private app-server`, async () => {
        const setup = await fakeSetup()
        const fake = fakeCodex(setup, replayScenario(f), { platform: 'win32' })
        const p = f.header.pass!
        const r = await fake.adapter.vendorSetup(
          'windowsSandbox/setupStart',
          p.params ?? { mode: 'unelevated' },
          new AbortController().signal,
        )
        expectNoMismatch(fake.logEntries())
        expect(r.ok).toBe(p.ok)
        if (p.ok === false) expect(r.detail).toMatch(/CreateRestrictedToken failed/)
      }, 60_000)
    }
  }
})

describe('exec fixtures (the no-relay fallback)', () => {
  for (const id of fixtureIds('exec')) {
    const f = loadFixture('exec', id)
    it(`${id}: replays through the adapter`, () => replayPass(f), 60_000)
  }
})
