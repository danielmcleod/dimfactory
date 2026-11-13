// Every Grok fixture (tests/fixtures/grok/acp/<ID>/, GR01-GR05, SYNTHESIZED until recorded live) through the real Grok
// adapter, the real resolver and spawn path and the fake CLI (the fake deep-compares every
// host frame and exits 99 on a mismatch). Checks the contract invariants, the recorded argv, the expected events and
// what each scenario is about: the Test probe (GR01, GR01b), the read-only passes raise zero asks (GR02, GR04), the
// autoedit refusal before any spawn (GR03), full mode's yoloMode only for a full pass (GR05).
import { describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../src/core/adapters/types.ts'
import { addUsage } from '../../../src/core/adapters/usage.ts'
import type { Usage } from '../../../src/shared/events.ts'
import type { Answer, Entry } from '../acp/adapter/helpers.ts'
import {
  checkInvariants,
  drive,
  eventsOf,
  expectNoMismatch,
  fakeSetup,
  signalsOf,
  tempDir,
} from '../acp/adapter/helpers.ts'
import type { GrokFixture } from './helpers.ts'
import { fakeGrok, grokFixtureIds, loadGrokFixture, stdioScenario } from './helpers.ts'

const READ_ONLY = new Set(['plan', 'review', 'critic', 'heal', 'catalog'])

interface FixturePass {
  kind: 'pass' | 'probe' | 'study'
  step?: StartOptions['step']
  mode?: StartOptions['mode']
  planNative?: boolean
  prompt?: string
  model?: string
  trustFolder?: boolean
  answers?: Answer[]
}

function startOptionsFor(f: GrokFixture, cwd: string): StartOptions {
  const p = f.header.pass as unknown as FixturePass
  return {
    runId: 'run-grok-replay',
    step: p.step ?? 'implement',
    cwd,
    prompt: p.prompt ?? '',
    mode: p.mode ?? 'readonly',
    planNative: p.planNative ?? false,
    allowRules: [],
    askTimeoutMs: 600_000,
    trustFolder: p.trustFolder ?? false,
    ...(p.model !== undefined ? { model: p.model } : {}),
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

const EVENT = new Set(['session', 'text', 'tool', 'ask', 'done', 'error'])
const isEvent = (e: unknown): boolean => EVENT.has((e as { type?: string }).type ?? '')

function matches(actual: unknown, want: unknown): boolean {
  try {
    expect(actual).toMatchObject(want as Record<string, unknown>)
    return true
  } catch {
    return false
  }
}

/** Events in order (partial); the expected signals in order among the adapter's, each before the terminal event. */
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

/** The session/new (or load) `_meta` the adapter sent, as the fake read it. */
function sentMeta(lines: unknown[]): unknown {
  const m = lines.find(
    (l) => typeof l === 'object' && l !== null && (l as Record<string, unknown>)['method'] === 'session/new',
  ) as { params?: { _meta?: unknown } } | undefined
  return m?.params?._meta
}

async function replayPass(f: GrokFixture): Promise<void> {
  const setup = await fakeSetup()
  const p = f.header.pass as unknown as FixturePass
  const fake = fakeGrok(setup, stdioScenario(f.recording), {
    vendorEnv: { FAKE_CLI_OUT_CWD: '1' },
    logEnv: ['GROK_DISABLE_AUTOUPDATER', 'GROK_HOME'],
  })
  const cwd = tempDir('grok-replay-')
  const o = startOptionsFor(f, cwd)
  const d = await drive(fake.adapter, o, p.answers ?? [])
  expectNoMismatch(fake.logEntries())
  const readOnly = READ_ONLY.has(o.step) || o.mode === 'readonly'
  checkInvariants(d, { readOnly })
  // Contract invariant: the pass's delta is the running total of a fresh session.
  const done = eventsOf(d.entries).find((e) => e.type === 'done')
  if (done?.type === 'done' && done.usage !== undefined) {
    const total = addUsage({ input: 0, output: 0 }, done.usage)
    for (const k of ['input', 'output', 'cacheRead', 'reasoning'] as const)
      expect(total[k] ?? 0).toBe((d.handle.cumulativeUsage() as Usage)[k] ?? 0)
    // Grok's _meta.usage has its cached reads apart: exact, never flagged approximate.
    expect(signalsOf(d.entries).filter((s) => s.type === 'meta' && s.key === 'usageApprox')).toEqual([])
  }
  // The recorded argv, as the fake saw it; GROK_DISABLE_AUTOUPDATER=1 on every spawn.
  expect(fake.starts().find((a) => a.includes('stdio'))).toEqual(f.header.argv.slice(1))
  for (const env of fake.startEnv()) expect(env['GROK_DISABLE_AUTOUPDATER']).toBe('1')
  expectRecorded(withCwdPlaceholder(d.entries, cwd), f.expected)
  // The posture: full mode always-approve for the session, every other pass asks (and the adapter rejects them).
  expect(sentMeta(fake.stdinLines())).toEqual(
    o.mode === 'full' && !readOnly ? { yoloMode: true } : { yoloMode: false, autoMode: false },
  )
  const events = eventsOf(d.entries)
  if (readOnly) {
    expect(events.some((e) => e.type === 'ask')).toBe(false)
    for (const s of signalsOf(d.entries).filter((x) => x.type === 'auto-answered'))
      expect(s).toMatchObject({ decision: 'deny', why: 'readonly' })
  }
  if (f.id.startsWith('GR04'))
    expect(signalsOf(d.entries).filter((s) => s.type === 'auto-answered')).toHaveLength(3)
  if (f.id.startsWith('GR05')) {
    expect(events.some((e) => e.type === 'ask')).toBe(false)
    expect(signalsOf(d.entries).some((s) => s.type === 'auto-answered')).toBe(false)
  }
}

describe('Grok fixtures through the adapter', () => {
  const ids = grokFixtureIds()

  it('the fixture set is present (GR01-GR05)', () => {
    for (const g of ['GR01', 'GR02', 'GR03', 'GR04', 'GR05'])
      expect(
        ids.some((id) => id.startsWith(g)),
        g,
      ).toBe(true)
  })

  for (const id of ids) {
    const f = loadGrokFixture(id)
    const kind = (f.header.pass as unknown as FixturePass).kind
    if (kind === 'pass') {
      it(`${id}: replays through the adapter`, () => replayPass(f), 60_000)
    } else if (kind === 'study') {
      it(`${id}: an autoedit pass is refused before anything is spawned`, async () => {
        const setup = await fakeSetup()
        const fake = fakeGrok(setup, stdioScenario(f.recording))
        const cwd = tempDir('grok-study-')
        const o = startOptionsFor(f, cwd)
        expect(o.mode).toBe('autoedit')
        const support = fake.adapter.support({
          pass: 'implement',
          mode: 'autoedit',
          planNative: false,
          trustFolder: false,
        })
        expect(support).toMatchObject({ status: 'unsupported' })
        // No reason code beside the copy (the composer and the PassCard show Support.reason).
        expect(support.reason).toBeUndefined()
        expect(support.copy).toMatch(/^Not supported until Dim Factory has seen it work/)
        const d = await drive(fake.adapter, o)
        expect(eventsOf(d.entries)).toMatchObject(f.expected)
        expect(d.exit).toMatchObject({ code: null, sawTerminal: true })
        // Nothing was spawned: not the agent, not even --version (the mode is refused first).
        expect(fake.starts()).toEqual([])
      }, 60_000)
    } else {
      it(`${id}: the Test probe (initialize + session/new in the probe folder)`, async () => {
        const setup = await fakeSetup()
        const fake = fakeGrok(setup, stdioScenario(f.recording), {
          logEnv: ['GROK_DISABLE_AUTOUPDATER'],
        })
        const probe = await fake.adapter.probe({ force: true })
        expectNoMismatch(fake.logEntries())
        expect(fake.starts().find((a) => a.includes('stdio'))).toEqual(f.header.argv.slice(1))
        expect(fake.starts()).toContainEqual(['agent', '--help'])
        const status = Object.fromEntries(probe.checks.map((c) => [c.id, c.status]))
        expect(status).toEqual({
          'vendor.grok.bin': 'pass',
          'vendor.grok.version': 'pass',
          'vendor.grok.auth': id.startsWith('GR01b') ? 'fail' : 'pass',
          'vendor.grok.protocol': 'pass',
          'vendor.grok.plan': 'skip',
        })
        expect(probe.version).toBe('1.0.50')
        expect(probe.capabilities.planMode).toBe('emulated')
        expect(probe.capabilities.resume).toBe('id')
        expect(probe.capabilities.modes.autoedit.status).toBe('unsupported')
        if (id.startsWith('GR01b')) {
          const auth = probe.checks.find((c) => c.id === 'vendor.grok.auth')!
          expect(auth.category).toBe('auth_required')
          expect(auth.recovery[0]).toMatchObject({ kind: 'shell_copy', command: 'grok login' })
          expect(probe.models).toEqual([])
        } else {
          // The session named the models (its configOptions model select and the unstable models list).
          expect(probe.models.map((m) => [m.id, m.isDefault === true])).toEqual([
            ['grok-4.6', true],
            ['grok-4.5', false],
          ])
        }
      }, 60_000)
    }
  }
})
