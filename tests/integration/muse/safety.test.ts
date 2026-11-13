// The Muse safety rules on a real spawn path (Muse is exec-only, no relay, Experimental): read-only passes never run on Muse
// (nothing is spawned), a folder without the vendorFolder grant never runs, `--yolo` only in full mode, the prompt only
// in the file Dim Factory wrote (never argv), no relay (an exec that waits on an approval never raises an ask: the stall
// timer's stop ends it), and a process that lingers after its terminal record is stopped.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../src/core/adapters/types.ts'
import type { Op } from './helpers.ts'
import { checkInvariants, drive, eventsOf, fakeMuse, fakeSetup, scenario, tempDir } from './helpers.ts'

const SESSION = '0199d2a0-4c1e-7a3b-8d5f-6e7a8b9c0f01'
const record = (seq: number, payloadType: string, payload: Record<string, unknown>): string =>
  JSON.stringify({
    schema_version: 1,
    id: `0199d2a0-4c21-7d0f-8000-${seq.toString(16).padStart(12, '0')}`,
    stream: { kind: 'session', id: SESSION },
    sequence: seq,
    recorded_at: 1_791_676_800_000_000 + seq,
    record_type: 'event',
    durability: 'durable',
    causation_id: 'c-1',
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  })

const COMPLETED = record(9, 'run.terminal.completed', {
  kind: 'run_terminal',
  command_id: 'c-1',
  terminal: 'completed',
  reason: null,
  text: 'Done.',
})

function startOf(cwd: string, o: Partial<StartOptions> = {}): StartOptions {
  return {
    runId: '20261011T120000Z-c3d4',
    step: 'implement',
    cwd,
    prompt: 'Add a --version flag.',
    mode: 'autoedit',
    planNative: false,
    allowRules: [],
    askTimeoutMs: 600_000,
    trustFolder: true,
    ...o,
  }
}

/** A run that prints one session record, then the terminal record, and exits 0. */
const plainRun: Op[] = [
  {
    op: 'stdout',
    line: record(1, 'runtime.command.accepted', { kind: 'command_accepted', command_id: 'c-1' }),
  },
  { op: 'stdout', line: COMPLETED },
  { op: 'exit', code: 0 },
]

describe('Muse never runs a read-only pass', () => {
  it.each(['plan', 'review', 'critic'] as const)(
    '%s fails before any spawn (capability_missing)',
    async (step) => {
      const setup = await fakeSetup()
      const fake = fakeMuse(setup, scenario([{ match: {}, script: plainRun, repeat: true }]))
      const d = await drive(fake.adapter, startOf(tempDir('muse-cwd-'), { step, mode: 'readonly' }))
      checkInvariants(d)
      expect(eventsOf(d.entries).at(-1)).toMatchObject({
        type: 'error',
        fatal: true,
        category: 'capability_missing',
      })
      expect(fake.starts()).toEqual([])
    },
  )

  it('an Implement in readonly mode is refused too', async () => {
    const setup = await fakeSetup()
    const fake = fakeMuse(setup, scenario([{ match: {}, script: plainRun, repeat: true }]))
    const d = await drive(fake.adapter, startOf(tempDir('muse-cwd-'), { mode: 'readonly' }))
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'capability_missing' })
    expect(fake.starts()).toEqual([])
  })
})

describe('the vendorFolder grant', () => {
  it('without it nothing is spawned (trust_required), whatever the mode', async () => {
    const setup = await fakeSetup()
    for (const mode of ['autoedit', 'full'] as const) {
      const fake = fakeMuse(setup, scenario([{ match: {}, script: plainRun, repeat: true }]))
      const d = await drive(fake.adapter, startOf(tempDir('muse-cwd-'), { mode, trustFolder: false }))
      expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'trust_required' })
      expect(fake.starts()).toEqual([])
    }
  })

  it('readiness fails without it, with the grant action; passes with it', async () => {
    const setup = await fakeSetup()
    const fake = fakeMuse(setup, scenario([]))
    const cwd = tempDir('muse-cwd-')
    const need = { pass: 'implement', mode: 'autoedit', planNative: false } as const
    const without = await fake.adapter.readiness(cwd, { ...need, trustFolder: false })
    const trust = without.find((c) => c.id === 'pass.implement.readiness.trust')
    expect(trust).toMatchObject({ status: 'fail', blocking: true, category: 'trust_required' })
    expect(trust?.recovery).toEqual([
      expect.objectContaining({ kind: 'grant', grant: 'vendorFolder', vendor: 'muse' }),
    ])
    const granted = await fake.adapter.readiness(cwd, { ...need, trustFolder: true })
    expect(granted.find((c) => c.id === 'pass.implement.readiness.trust')?.status).toBe('pass')
    // Review on Muse: the mode check fails (blocking) with the honest copy.
    const review = await fake.adapter.readiness(cwd, {
      pass: 'review',
      mode: 'readonly',
      planNative: false,
      trustFolder: true,
    })
    expect(review.find((c) => c.id === 'pass.review.readiness.mode')).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'capability_missing',
    })
    expect(fake.starts()).toEqual([])
  })
})

describe('argv and the prompt file', () => {
  it('autoedit: --disable-approval, the network off and --trust-workspace; the prompt only in the file', async () => {
    const setup = await fakeSetup()
    const fake = fakeMuse(setup, scenario([{ match: {}, script: plainRun, repeat: true }]))
    const o = startOf(tempDir('muse-cwd-'), { systemAppend: 'Follow the plan.', model: 'muse-spark-1.2' })
    const d = await drive(fake.adapter, o)
    checkInvariants(d)
    const [argv] = fake.starts().filter((a) => a.includes('--json'))
    expect(argv?.slice(0, 3)).toEqual(['exec', '--json', '--prompt-file'])
    expect(argv?.slice(4)).toEqual([
      '--model',
      'muse-spark-1.2',
      '--trust-workspace',
      '--disable-approval',
      '--sandbox-network',
      'restricted',
    ])
    expect(argv?.some((a) => a.includes('--version flag') || a.includes('Follow the plan'))).toBe(false)
    expect(readFileSync(argv![3]!, 'utf8')).toBe('Follow the plan.\n\nAdd a --version flag.\n')
  })

  it('full mode (Auto): --yolo, never --disable-approval', async () => {
    const setup = await fakeSetup()
    const fake = fakeMuse(setup, scenario([{ match: {}, script: plainRun, repeat: true }]))
    await drive(fake.adapter, startOf(tempDir('muse-cwd-'), { mode: 'full' }))
    const [argv] = fake.starts().filter((a) => a.includes('--json'))
    expect(argv).toContain('--yolo')
    expect(argv).not.toContain('--disable-approval')
    expect(argv).not.toContain('--sandbox-network')
  })

  it('a prompt file that differs from what the recording expects is a mismatch (the fake exits 99)', async () => {
    const setup = await fakeSetup()
    const recording = [
      JSON.stringify({ kind: 'header', schemaVersion: 1, vendor: 'muse', route: 'exec', scenario: 'x' }),
      JSON.stringify({ t: 0, dir: 'promptFile', argvPath: '--prompt-file', content: 'Something else.\n' }),
      JSON.stringify({ t: 0, dir: 'exit', code: 0, signal: null }),
    ].join('\n')
    const file = join(tempDir('muse-rec-'), 'recording.jsonl')
    writeFileSync(file, `${recording}\n`)
    const fake = fakeMuse(setup, scenario([{ match: {}, script: file, repeat: true }]))
    const d = await drive(fake.adapter, startOf(tempDir('muse-cwd-')))
    expect(d.exit.code).toBe(99)
    expect(fake.logEntries().some((e) => e['kind'] === 'error')).toBe(true)
    checkInvariants(d)
  })

  it('a forbidden extra flag (--approval-mode) is refused before the spawn', async () => {
    const setup = await fakeSetup()
    const fake = fakeMuse(setup, scenario([{ match: {}, script: plainRun, repeat: true }]))
    const d = await drive(
      fake.adapter,
      startOf(tempDir('muse-cwd-'), { extraArgs: ['--approval-mode', 'on-request'] }),
    )
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'config_invalid' })
    expect(fake.starts()).toEqual([])
  })
})

describe('no relay', () => {
  it('an exec that waits (an approval it cannot get) raises no ask; the stall timer stop ends it as timeout_hard', async () => {
    const setup = await fakeSetup()
    const waiting: Op[] = [
      {
        op: 'stdout',
        line: record(1, 'runtime.command.accepted', { kind: 'command_accepted', command_id: 'c-1' }),
      },
      { op: 'sleep', ms: 60_000 },
      { op: 'exit', code: 0 },
    ]
    const fake = fakeMuse(setup, scenario([{ match: {}, script: waiting, repeat: true }]))
    const d = await drive(fake.adapter, startOf(tempDir('muse-cwd-')), {
      stopAfter: (e) => e.type === 'session',
      stopReason: 'timeout',
    })
    checkInvariants(d)
    expect(d.handle.pendingAsks()).toEqual([])
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'timeout_hard' })
    expect(d.exit.stoppedBy).toBe('timeout')
  })

  it('a user Stop ends the pass as user_cancelled', async () => {
    const setup = await fakeSetup()
    const waiting: Op[] = [
      {
        op: 'stdout',
        line: record(1, 'runtime.command.accepted', { kind: 'command_accepted', command_id: 'c-1' }),
      },
      { op: 'sleep', ms: 60_000 },
      { op: 'exit', code: 0 },
    ]
    const fake = fakeMuse(setup, scenario([{ match: {}, script: waiting, repeat: true }]))
    const d = await drive(fake.adapter, startOf(tempDir('muse-cwd-')), {
      stopAfter: (e) => e.type === 'session',
    })
    checkInvariants(d)
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'user_cancelled' })
  })

  it('a process that lingers after its terminal record is stopped; the pass is done', async () => {
    const setup = await fakeSetup()
    const lingering: Op[] = [
      {
        op: 'stdout',
        line: record(1, 'runtime.command.accepted', { kind: 'command_accepted', command_id: 'c-1' }),
      },
      { op: 'stdout', line: COMPLETED },
      { op: 'sleep', ms: 60_000 },
      { op: 'exit', code: 0 },
    ]
    const fake = fakeMuse(setup, scenario([{ match: {}, script: lingering, repeat: true }]), {
      adapter: { timing: { exitAfterTerminalMs: 300, stopStdinMs: 100 } },
    })
    const started = Date.now()
    const d = await drive(fake.adapter, startOf(tempDir('muse-cwd-')))
    checkInvariants(d)
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done', result: 'Done.' })
    expect(Date.now() - started).toBeLessThan(30_000)
  })
})
