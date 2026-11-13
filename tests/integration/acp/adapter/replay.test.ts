// Every Gemini fixture (tests/fixtures/gemini/acp/<ID>/recording.jsonl, G01-G10 and the GX exit codes, SYNTHESIZED
// until recorded live) replayed through the real Gemini adapter, the real resolver and spawn path and the fake CLI
// (the fake deep-compares every host frame and exits 99 on a mismatch). Checks the contract
// invariants, the recorded argv, the expected events, and what each scenario is about (G05 decides cached-token
// subtraction; G08 the captured plan; G09 the load quiet window).
import { describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../../src/core/adapters/types.ts'
import { addUsage } from '../../../../src/core/adapters/usage.ts'
import { realPathSync } from '../../../../src/core/real-path.ts'
import type { NormalizedEvent, Usage } from '../../../../src/shared/events.ts'
import type { Answer, Entry, Fixture } from './helpers.ts'
import {
  acpScenario,
  checkInvariants,
  drive,
  eventsOf,
  expectNoMismatch,
  fakeGemini,
  fakeSetup,
  fixtureIds,
  loadFixture,
  signalsOf,
  tempDir,
} from './helpers.ts'

const READ_ONLY = new Set(['plan', 'review', 'critic', 'heal', 'catalog'])

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

/** StartOptions that make the adapter talk to the agent the way the recording's host did. */
function startOptionsFor(f: Fixture, cwd: string): StartOptions {
  const p = (f.header.pass ?? { kind: 'pass' }) as unknown as FixturePass
  return {
    runId: 'run-replay',
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
}

/**
 * The replay's own pass folder back to the recording's `<CWD>` in every string, by both spellings (the fake names it
 * by its getcwd(), on macOS /private/var for the host's /var), the longer first.
 */
function withCwdPlaceholder<T>(value: T, cwd: string): T {
  const spellings = [...new Set([cwd, realPathSync(cwd)].flatMap((c) => [c, c.split('\\').join('/')]))].sort(
    (a, b) => b.length - a.length,
  )
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return spellings.reduce((s, c) => s.split(c).join('<CWD>'), v)
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

const EVENT = new Set(['session', 'text', 'tool', 'ask', 'done', 'error'])
const isEvent = (e: unknown): boolean => EVENT.has((e as { type?: string }).type ?? '')

/**
 * expected.events.json lists the events (partial: no ask id, detail or expiry, no tool name or summary) and the
 * signals the scenario is about. The events must match in order; the expected signals must appear in that order among
 * the adapter's (it may report more, e.g. `ask-withdrawn` for an ask a stop left unanswered, as Codex X08b does), and
 * every signal comes before the terminal event (the engine reads a signal before the event it explains).
 */
function expectRecorded(entries: Entry[], expected: unknown[]): void {
  expect(eventsOf(entries)).toMatchObject(expected.filter(isEvent))
  const signals = signalsOf(entries)
  let at = 0
  for (const want of expected.filter((e) => !isEvent(e))) {
    const i = signals.findIndex((s, k) => k >= at && matches(s, want))
    expect(i, `signal ${JSON.stringify(want)} in order`).toBeGreaterThanOrEqual(0)
    at = i + 1
  }
  const terminal = entries.findIndex((e) => e.type === 'done' || (e.type === 'error' && e.fatal))
  for (const s of signals) if (s.type !== 'ask-withdrawn') expect(entries.indexOf(s)).toBeLessThan(terminal)
}

function matches(actual: unknown, want: unknown): boolean {
  try {
    expect(actual).toMatchObject(want as Record<string, unknown>)
    return true
  } catch {
    return false
  }
}

async function replayPass(f: Fixture): Promise<void> {
  const setup = await fakeSetup()
  const p = f.header.pass as unknown as FixturePass
  const fake = fakeGemini(setup, acpScenario(f.recording), {
    // The agent names the pass folder in its frames (tool locations): the recording's <CWD> becomes it.
    vendorEnv: { FAKE_CLI_OUT_CWD: '1' },
  })
  const cwd = tempDir('gemini-replay-')
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
  checkInvariants(d, { readOnly: READ_ONLY.has(o.step) || o.mode === 'readonly' })
  // Contract invariant: the session's prior totals plus this pass's delta are the running total it reports.
  const done = eventsOf(d.entries).find((e) => e.type === 'done')
  const cumulative = d.handle.cumulativeUsage()
  if (done?.type === 'done' && done.usage !== undefined) {
    expect(cumulative).toBeDefined()
    const total = addUsage(o.resume?.priorUsage ?? { input: 0, output: 0 }, done.usage)
    for (const k of ['input', 'output', 'cacheRead', 'reasoning'] as const)
      expect(total[k] ?? 0).toBe((cumulative as Usage)[k] ?? 0)
  }
  // The recorded argv (after the program name), as the fake saw it after `node <entry>`.
  const argv = fake.starts().find((a) => a.includes('--acp'))
  expect(argv).toEqual((f.header.argv ?? []).slice(1))
  if (f.expected !== undefined) expectRecorded(withCwdPlaceholder(d.entries, cwd), f.expected)
  scenarioChecks(f, d.entries)
}

/** What each scenario is about, beyond the invariants and the expected events. */
function scenarioChecks(f: Fixture, entries: Entry[]): void {
  const events = eventsOf(entries)
  const terminal = events.at(-1)
  const signals = signalsOf(entries)
  if (f.id.startsWith('G08')) {
    // The plan exit was captured, rejected and the turn cancelled: the plan is the pass's result.
    const captured = signals.find((s) => s.type === 'plan-captured')
    expect(captured).toMatchObject({ source: 'acp-exit-plan' })
    expect(terminal).toMatchObject({ type: 'done', result: (captured as { markdown: string }).markdown })
  }
  if (f.id.startsWith('G07') || f.id.startsWith('G02') || f.id.startsWith('G05')) {
    // Read-only Review: zero asks; every request auto-rejected.
    expect(events.some((e) => e.type === 'ask')).toBe(false)
    for (const s of signals.filter((x) => x.type === 'auto-answered'))
      expect(s).toMatchObject({ decision: 'deny', why: 'readonly' })
  }
  if (f.id.startsWith('G09a')) {
    // The replayed history never reaches the stream: only this pass's text and tools.
    const tools = events.filter((e) => e.type === 'tool')
    expect(
      tools.every(
        (t) => (t as { phase?: string }).phase === 'start' || (t as { phase?: string }).phase === 'end',
      ),
    ).toBe(true)
  }
  if (f.id.startsWith('G10a')) expect(terminal).toMatchObject({ type: 'error', category: 'user_cancelled' })
  if (f.id.startsWith('G10b')) expect(terminal).toMatchObject({ type: 'error', category: 'auth_required' })
  if (f.id.startsWith('GX55')) expect(terminal).toMatchObject({ type: 'error', category: 'trust_required' })
}

describe('Gemini fixtures through the adapter', () => {
  const ids = fixtureIds('acp')
  it('the fixture set is present (G01-G10 and the exit codes)', () => {
    for (const g of ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09', 'G10'])
      expect(
        ids.some((id) => id.startsWith(g)),
        g,
      ).toBe(true)
  })

  for (const id of ids) {
    const f = loadFixture(id)
    const kind = (f.header.pass as FixturePass | undefined)?.kind
    if (kind === 'pass') {
      it(`${id}: replays through the adapter`, () => replayPass(f), 60_000)
    } else if (kind === 'probe') {
      it(`${id}: the probe handshake (initialize + session/new in the probe folder with --skip-trust)`, async () => {
        const setup = await fakeSetup()
        const fake = fakeGemini(setup, acpScenario(f.recording), { vendorEnv: { GEMINI_API_KEY: 'k' } })
        const probe = await fake.adapter.probe()
        expectNoMismatch(fake.logEntries())
        expect(probe.checks.map((c) => [c.id, c.status])).toEqual([
          ['vendor.gemini.bin', 'pass'],
          ['vendor.gemini.version', 'pass'],
          ['vendor.gemini.auth', 'pass'],
          ['vendor.gemini.protocol', 'pass'],
          ['vendor.gemini.plan', 'pass'],
        ])
        expect(probe.capabilities.planMode).toBe('native')
        expect(probe.capabilities.resume).toBe('load')
        expect(probe.models.length).toBeGreaterThan(0)
        expect(fake.starts().find((a) => a.includes('--acp'))).toEqual((f.header.argv ?? []).slice(1))
      }, 60_000)
    }
  }
})
