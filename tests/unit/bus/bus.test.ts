import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunEnvelope, RunEventBody } from '../../../src/shared/run.ts'
import { EventBus, REPLAY_MAX_LIMIT, forEachEnvelope, lastSeqInFile } from '../../../src/core/bus/bus.ts'
import type { BusSink, GlobalEvent } from '../../../src/core/bus/bus.ts'
import { homePaths } from '../../../src/core/home.ts'
import { createMemoryLogger } from '../../../src/core/log.ts'
import { readJsonlAll } from '../../../src/core/store/jsonl.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const eventsFile = (runId: string): string => homePaths(home()).run(runId).eventsJsonl
const stat = (n: number): RunEventBody => ({ t: 'diff-stats', files: n, added: 0, deleted: 0, live: true })
const runStatus: RunEventBody = { t: 'run-status', status: 'running', phase: 'planning' }

let buses: EventBus[] = []
function makeBus(opts: Partial<ConstructorParameters<typeof EventBus>[0]> = {}): EventBus {
  const bus = new EventBus({ home: home(), app: 'test', now: () => 1234, ...opts })
  buses.push(bus)
  return bus
}

function collect(bus: EventBus): RunEnvelope[] {
  const seen: RunEnvelope[] = []
  bus.attach({ name: 'collect', run: (e) => seen.push(e) })
  return seen
}

/** Text deltas and other event types in emitted order, for ordering assertions. */
const shape = (envs: RunEnvelope[]): string[] =>
  envs.map((e) =>
    e.body.t === 'ev'
      ? e.body.ev.type === 'text'
        ? `${e.body.step}:text:${e.body.ev.delta}`
        : `${e.body.step}:${e.body.ev.type}`
      : e.body.t,
  )

afterEach(async () => {
  vi.useRealTimers()
  for (const b of buses) await b.close().catch(() => undefined)
  buses = []
})

describe('EventBus seq and persistence', () => {
  it('writes a header (seq 0) and numbers envelopes from 1', async () => {
    const bus = makeBus()
    const opened = await bus.openRun('r1', { createdAt: 99 })
    expect(opened).toEqual({ lastSeq: 0, created: true, readOnly: false, truncatedBytes: 0 })
    const a = bus.emit('r1', runStatus)
    const b = bus.emit('r1', stat(1))
    expect([a.seq, b.seq]).toEqual([1, 2])
    expect(a).toEqual({ runId: 'r1', seq: 1, ts: 1234, body: runStatus })
    await bus.sync('r1')
    const lines = (await readFile(eventsFile('r1'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as unknown)
    expect(lines[0]).toEqual({
      seq: 0,
      t: 'header',
      schemaVersion: 1,
      runId: 'r1',
      app: 'test',
      createdAt: 99,
    })
    expect(lines[1]).toEqual({ seq: 1, ts: 1234, body: runStatus })
    expect(lines).toHaveLength(3)
    expect(bus.lastSeq('r1')).toBe(2)
  })

  it('continues seq across reopen from the file tail', async () => {
    const bus1 = makeBus()
    await bus1.openRun('r1')
    for (let i = 1; i <= 5; i++) bus1.emit('r1', stat(i))
    await bus1.closeRun('r1')

    const bus2 = makeBus()
    expect(await bus2.openRun('r1')).toMatchObject({ lastSeq: 5, created: false })
    expect(bus2.emit('r1', stat(6)).seq).toBe(6)
    await bus2.sync('r1')
    const page = await bus2.replay('r1', 0)
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(page).toMatchObject({ lastSeq: 6, more: false })
    const { values } = await readJsonlAll(eventsFile('r1'))
    expect(values.filter((v) => (v as { t?: string }).t === 'header')).toHaveLength(1)
  })

  it('continues from run.json lastSeq when it is ahead of the file', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    bus.emit('r1', stat(1))
    await bus.closeRun('r1')
    const bus2 = makeBus()
    expect((await bus2.openRun('r1', { lastSeq: 50 })).lastSeq).toBe(50)
    expect(bus2.emit('r1', stat(2)).seq).toBe(51)
  })

  it('drops a torn trailing line at reopen and keeps numbering', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    for (let i = 1; i <= 3; i++) bus.emit('r1', stat(i))
    await bus.closeRun('r1')
    await appendFile(eventsFile('r1'), '{"seq":4,"ts":1,"body":{"t":"diff-st')
    const bus2 = makeBus()
    const opened = await bus2.openRun('r1')
    expect(opened.lastSeq).toBe(3)
    expect(opened.truncatedBytes).toBeGreaterThan(0)
    expect(bus2.emit('r1', stat(4)).seq).toBe(4)
    await bus2.closeRun('r1')
    const { values, stats } = await readJsonlAll(eventsFile('r1'))
    expect(stats.bad).toBe(0)
    expect(stats.partialTail).toBe(false)
    expect(values.map((v) => (v as { seq: number }).seq)).toEqual([0, 1, 2, 3, 4])
  })

  it('opens a log from a newer Dim Factory read-only: replay works, emit throws NEWER_SCHEMA', async () => {
    const file = eventsFile('r9')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      `${JSON.stringify({ seq: 0, t: 'header', schemaVersion: 2, runId: 'r9' })}\n${JSON.stringify({ seq: 1, ts: 5, body: stat(1) })}\n`,
    )
    const bus = makeBus()
    expect(await bus.openRun('r9')).toMatchObject({ readOnly: true, lastSeq: 1 })
    expect(() => bus.emit('r9', stat(2))).toThrow(expect.objectContaining({ code: 'NEWER_SCHEMA' }))
    expect((await bus.replay('r9', 0)).events.map((e) => e.seq)).toEqual([1])
  })

  it('refuses to emit for a run that is not open', async () => {
    const bus = makeBus()
    expect(() => bus.emit('nope', stat(1))).toThrow(expect.objectContaining({ code: 'INTERNAL' }))
    await bus.openRun('r1')
    await bus.closeRun('r1')
    expect(() => bus.emit('r1', stat(1))).toThrow(/not open/)
  })

  it('openRun is idempotent and concurrent opens share one writer', async () => {
    const bus = makeBus()
    const [a, b] = await Promise.all([bus.openRun('r1'), bus.openRun('r1')])
    expect(a).toEqual(b)
    expect((await bus.openRun('r1')).created).toBe(false)
    bus.emit('r1', stat(1))
    await bus.sync('r1')
    expect((await readJsonlAll(eventsFile('r1'))).values).toHaveLength(2)
  })

  it('lastSeqInFile reads the tail and widens for giant lines', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    bus.emit('r1', stat(1))
    bus.emit('r1', {
      t: 'card',
      state: 'open',
      card: {
        id: 'c',
        kind: 'gate:afterPlan',
        title: 't',
        body: 'x'.repeat(200_000),
        payload: null,
        blocking: true,
        choices: [],
      },
    })
    await bus.sync('r1')
    expect(await lastSeqInFile(eventsFile('r1'))).toBe(2)
    expect(await lastSeqInFile(eventsFile('missing'))).toBe(0)
  })
})

describe('EventBus fan-out', () => {
  it('delivers synchronously in seq order; a throwing sink is logged and skipped', async () => {
    const log = createMemoryLogger()
    const bus = makeBus({ log })
    await bus.openRun('r1')
    const seen: number[] = []
    bus.attach({
      name: 'bad',
      run: () => {
        throw new Error('sink bug')
      },
    })
    bus.attach({ name: 'good', run: (e) => seen.push(e.seq) })
    const env = bus.emit('r1', stat(1))
    expect(seen).toEqual([1])
    expect(env.seq).toBe(1)
    expect(log.records.some((r) => r.msg === 'bus sink threw' && r['sink'] === 'bad')).toBe(true)
  })

  it('an emit from inside a sink is delivered after the current envelope to every sink', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    const a: number[] = []
    const b: number[] = []
    bus.attach({
      name: 'a',
      run: (e) => {
        a.push(e.seq)
        if (e.seq === 1) bus.emit('r1', stat(2))
      },
    })
    bus.attach({ name: 'b', run: (e) => b.push(e.seq) })
    bus.emit('r1', stat(1))
    expect(a).toEqual([1, 2])
    expect(b).toEqual([1, 2])
  })

  it('global events reach global sinks; detach stops delivery', () => {
    const bus = makeBus()
    const got: GlobalEvent[] = []
    const sink: BusSink = { name: 'g', global: (e) => got.push(e) }
    const detach = bus.attach(sink)
    bus.global({ kind: 'heartbeat', at: 1 })
    detach()
    bus.global({ kind: 'heartbeat', at: 2 })
    expect(got).toEqual([{ kind: 'heartbeat', at: 1 }])
  })
})

describe('EventBus text coalescing', () => {
  it('never reorders text across another event of the same step', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    const seen = collect(bus)
    expect(bus.pass('r1', 'plan', 1, { type: 'text', delta: 'Hel' })).toBeNull()
    bus.pass('r1', 'plan', 1, { type: 'text', delta: 'lo' })
    bus.pass('r1', 'plan', 1, { type: 'tool', name: 'Read', summary: 'a.ts', phase: 'start' })
    bus.pass('r1', 'plan', 1, { type: 'text', delta: ' world' })
    bus.emit('r1', { t: 'step-status', step: 'plan', attempt: 1, status: 'done' })
    expect(shape(seen)).toEqual(['plan:text:Hello', 'plan:tool', 'plan:text: world', 'step-status'])
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    await bus.sync('r1')
    const page = await bus.replay('r1', 0)
    expect(page.events).toEqual(seen)
  })

  it('a step event leaves other steps buffered; a run-level event flushes the whole run first', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    const seen = collect(bus)
    bus.pass('r1', 'review', 1, { type: 'text', delta: 'R1' })
    bus.pass('r1', 'critic', 1, { type: 'text', delta: 'C1' })
    bus.pass('r1', 'critic', 1, { type: 'done', result: 'ok' })
    expect(shape(seen)).toEqual(['critic:text:C1', 'critic:done'])
    bus.emit('r1', runStatus)
    expect(shape(seen)).toEqual(['critic:text:C1', 'critic:done', 'review:text:R1', 'run-status'])
  })

  it('flushes buffered text after 40 ms', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    const seen = collect(bus)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    bus.pass('r1', 'implement', 2, { type: 'text', delta: 'a' })
    bus.pass('r1', 'implement', 2, { type: 'text', delta: 'b' })
    vi.advanceTimersByTime(39)
    expect(seen).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(shape(seen)).toEqual(['implement:text:ab'])
    expect(seen[0]?.body).toEqual({
      t: 'ev',
      step: 'implement',
      attempt: 2,
      ev: { type: 'text', delta: 'ab' },
    })
  })

  it('sync() emits pending text and makes it durable; closeRun flushes too', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    bus.pass('r1', 'plan', 1, { type: 'text', delta: 'pending' })
    await bus.sync('r1')
    expect(await readFile(eventsFile('r1'), 'utf8')).toContain('"delta":"pending"')
    bus.pass('r1', 'plan', 1, { type: 'text', delta: 'at close' })
    await bus.closeRun('r1')
    expect(await readFile(eventsFile('r1'), 'utf8')).toContain('"delta":"at close"')
  })
})

describe('EventBus replay', () => {
  it('serves from the ring when it covers the range, else from the file', async () => {
    const bus = makeBus({ ring: { maxItems: 10 }, indexEvery: 4 })
    await bus.openRun('r1')
    for (let i = 1; i <= 25; i++) bus.emit('r1', stat(i))
    // Ring holds 16..25.
    const ring = await bus.replay('r1', 15, 100)
    expect(ring.events.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25])
    expect(ring.more).toBe(false)
    // Prove the next page comes from disk: the file is read after the writer flush.
    const file = await bus.replay('r1', 0, 5)
    expect(file.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(file).toMatchObject({ lastSeq: 25, more: true })
    const mid = await bus.replay('r1', 6, 3)
    expect(mid.events.map((e) => e.seq)).toEqual([7, 8, 9])
    expect(mid.events[0]).toEqual({ runId: 'r1', seq: 7, ts: 1234, body: stat(7) })
    expect(await bus.replay('r1', 25)).toEqual({ events: [], lastSeq: 25, more: false })
  })

  it('pages through a long log with limit ≤ 2000', async () => {
    const bus = makeBus({ ring: { maxItems: 50 } })
    await bus.openRun('r1')
    for (let i = 1; i <= 4500; i++) bus.emit('r1', stat(i))
    const seqs: number[] = []
    let since = 0
    for (;;) {
      const page = await bus.replay('r1', since, 5000)
      expect(page.events.length).toBeLessThanOrEqual(REPLAY_MAX_LIMIT)
      seqs.push(...page.events.map((e) => e.seq))
      since = page.events.at(-1)?.seq ?? since
      if (!page.more) break
    }
    expect(seqs).toEqual(Array.from({ length: 4500 }, (_, i) => i + 1))
  })

  it('replays across the cold (previous session) and hot regions of a reopened log', async () => {
    const bus1 = makeBus()
    await bus1.openRun('r1')
    for (let i = 1; i <= 30; i++) bus1.emit('r1', stat(i))
    await bus1.closeRun('r1')
    const bus2 = makeBus({ ring: { maxItems: 5 }, indexEvery: 7 })
    await bus2.openRun('r1')
    for (let i = 31; i <= 60; i++) bus2.emit('r1', stat(i))
    const page = await bus2.replay('r1', 5, 50)
    expect(page.events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 6))
    expect(page.more).toBe(true)
    const hot = await bus2.replay('r1', 40, 3)
    expect(hot.events.map((e) => e.seq)).toEqual([41, 42, 43])
  })

  it('forEachEnvelope streams the whole log after a seq (recovery projection)', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    for (let i = 1; i <= 2500; i++) bus.emit('r1', stat(i))
    await bus.closeRun('r1')
    const seqs: number[] = []
    const r = await forEachEnvelope(home(), 'r1', 10, (e) => seqs.push(e.seq))
    expect(r).toEqual({ lastSeq: 2500, bad: 0 })
    expect(seqs).toEqual(Array.from({ length: 2490 }, (_, i) => i + 11))
  })

  it('replays a cold run that was never opened by this bus', async () => {
    const bus1 = makeBus()
    await bus1.openRun('r1')
    for (let i = 1; i <= 12; i++) bus1.emit('r1', stat(i))
    await bus1.closeRun('r1')
    const bus2 = makeBus({ indexEvery: 5 })
    const page = await bus2.replay('r1', 3, 4)
    expect(page).toMatchObject({ lastSeq: 12, more: true })
    expect(page.events.map((e) => e.seq)).toEqual([4, 5, 6, 7])
    expect((await bus2.replay('missing', 0)).events).toEqual([])
  })

  it('keeps the ring after closeRun (file no longer needed for recent replay)', async () => {
    const bus = makeBus()
    await bus.openRun('r1')
    for (let i = 1; i <= 3; i++) bus.emit('r1', stat(i))
    await bus.closeRun('r1')
    await rm(eventsFile('r1'))
    expect((await bus.replay('r1', 0)).events.map((e) => e.seq)).toEqual([1, 2, 3])
    bus.forget('r1')
    expect((await bus.replay('r1', 0)).events).toEqual([])
  })
})
