// Every Muse fixture (tests/fixtures/muse/exec/<ID>/recording.jsonl, M01-M05, SYNTHESIZED until recorded live) replayed
// through the real adapter, the real resolver and spawn path and the fake CLI ("per-adapter P1 fixtures pass
// replay + contract"). The fake checks the prompt file the adapter wrote and the
// stdin close, and exits 99 on a mismatch. Checks the contract invariants, the recorded expected events, the argv the
// recording names, and what each scenario is about (no relay, --yolo only in full mode, the auth failure).
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../../../src/shared/events.ts'
import type { Fixture } from './helpers.ts'
import {
  checkInvariants,
  drive,
  eventsOf,
  fakeMuse,
  fakeSetup,
  fixtureIds,
  loadFixture,
  replayScenario,
  startOptionsFor,
  tempDir,
} from './helpers.ts'

const EVENT = new Set(['session', 'text', 'tool', 'ask', 'done', 'error'])
const isEvent = (e: unknown): boolean => EVENT.has((e as { type?: string }).type ?? '')

/** The fake never reported a mismatch (it would have exited 99 and logged an error). */
function expectNoMismatch(entries: Record<string, unknown>[]): void {
  expect(entries.filter((e) => e['kind'] === 'error')).toEqual([])
}

async function replay(f: Fixture) {
  const setup = await fakeSetup()
  const fake = fakeMuse(setup, replayScenario(f))
  const cwd = tempDir('muse-cwd-')
  const o = startOptionsFor(f, cwd)
  const d = await drive(fake.adapter, o)
  return { fake, cwd, o, d }
}

describe('Muse fixtures replay through the real adapter (M01-M05)', () => {
  const ids = fixtureIds()

  it('has the five P1 scenarios', () => {
    expect(ids.map((id) => id.slice(0, 3))).toEqual(['M01', 'M02', 'M03', 'M04', 'M05'])
  })

  it.each(ids)('%s', async (id) => {
    const f = loadFixture(id)
    expect(f.header.synthesized).toBe(true)
    const { fake, o, d } = await replay(f)
    expectNoMismatch(fake.logEntries())
    checkInvariants(d)

    // The events in order, then the signals in order (no liveness), every signal before the terminal event.
    expect(eventsOf(d.entries)).toMatchObject(f.expected.filter(isEvent))
    // The context meter's per-call signals are checked in tests/unit/context (no Muse fixture is about them).
    const signals = d.entries.filter((e) => !isEvent(e) && e.type !== 'liveness' && e.type !== 'context')
    expect(signals).toMatchObject(f.expected.filter((e) => !isEvent(e)))
    const terminal = d.entries.findIndex((e) => e.type === 'done' || (e.type === 'error' && e.fatal))
    for (const s of signals) expect(d.entries.indexOf(s)).toBeLessThan(terminal)

    // The argv the recording names, with the prompt file Dim Factory wrote under runs/<id>/prompts.
    const [argv] = fake.starts().filter((a) => a.includes('exec') && !a.includes('--help'))
    expect(argv).toBeDefined()
    const promptAt = argv!.indexOf('--prompt-file') + 1
    const promptFile = argv![promptAt]!
    expect(argv!.map((a, i) => (i === promptAt ? '<PROMPT_FILE>' : a))).toEqual(f.header.argv.slice(1))
    const rel = relative(join(fake.dimFactoryHome, 'runs', o.runId, 'prompts'), promptFile)
    expect(rel).toMatch(/^implement-muse-\d+\.md$/)
    expect(readFileSync(promptFile, 'utf8')).toBe(`${o.prompt}\n`)
    // The prompt itself is never in argv.
    expect(argv!.some((a) => a.includes(o.prompt))).toBe(false)
    expect(existsSync(promptFile)).toBe(true)

    scenarioChecks(f, eventsOf(d.entries), argv!)
  })
})

function scenarioChecks(f: Fixture, events: NormalizedEvent[], argv: readonly string[]): void {
  const terminal = events.at(-1)
  const fullMode = f.header.pass.mode === 'full'
  // --yolo only from full mode (Auto), --disable-approval otherwise; never both; the grant's --trust-workspace.
  expect(argv.includes('--yolo')).toBe(fullMode)
  expect(argv.includes('--disable-approval')).toBe(!fullMode)
  expect(argv.includes('--trust-workspace')).toBe(true)
  switch (f.id) {
    case 'M03-escalation-fails': {
      // No relay: the escalation fails as a declined tool row, never an ask, and the pass completes.
      const ends = events.filter((e) => e.type === 'tool' && e.phase === 'end')
      expect(ends.map((e) => (e.type === 'tool' ? e.status : undefined))).toEqual(['declined'])
      expect(terminal).toMatchObject({ type: 'done' })
      break
    }
    case 'M05-auth-failure':
      expect(terminal).toMatchObject({ type: 'error', fatal: true, category: 'auth_required' })
      expect(terminal?.type === 'error' ? terminal.message : '').toMatch(/sign in|META_API_KEY/i)
      break
    default:
      expect(terminal).toMatchObject({ type: 'done' })
  }
}
