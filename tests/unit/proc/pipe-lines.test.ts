// spawn.pipeLines (performance.spec.ts): while the child lives, the stdio stream pauses after each chunk
// and resumes on the next event-loop turn, so a child writing faster than its lines are handled cannot starve the
// host's timers; lines still arrive complete and in order, and the final flush still delivers a trailing partial line.
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { LineRecord } from '../../../src/core/proc/lines.ts'
import { pipeLines } from '../../../src/core/proc/spawn.ts'

const lineOf = (r: LineRecord): string => (r.kind === 'line' ? r.line : `oversize:${r.bytes}`)
const turn = (): Promise<void> => new Promise((r) => setImmediate(r))

async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) await turn()
}

describe('pipeLines', () => {
  it('yields an event-loop turn between chunks while asked to', async () => {
    const stream = new PassThrough()
    const seen: string[] = []
    pipeLines(
      stream,
      1024,
      (r) => {
        seen.push(lineOf(r))
        // Something the host scheduled while handling the first chunk (a timer, an IPC reply).
        if (lineOf(r) === 'a') setImmediate(() => seen.push('host'))
      },
      () => true,
    )
    stream.write('a\n')
    stream.write('b\n')
    stream.write('c\n')
    await settle()
    expect(seen).toEqual(['a', 'host', 'b', 'c'])
  })

  it('reads back to back when not asked to yield (after the child exited)', async () => {
    const stream = new PassThrough()
    const seen: string[] = []
    pipeLines(stream, 1024, (r) => {
      seen.push(lineOf(r))
      if (lineOf(r) === 'a') setImmediate(() => seen.push('host'))
    })
    stream.write('a\n')
    stream.write('b\n')
    stream.write('c\n')
    await settle()
    expect(seen).toEqual(['a', 'b', 'c', 'host'])
  })

  it('stops yielding when the predicate turns false, keeps order, and flushes a partial last line', async () => {
    const stream = new PassThrough()
    const seen: string[] = []
    let alive = true
    const pipe = pipeLines(
      stream,
      1024,
      (r) => seen.push(lineOf(r)),
      () => alive,
    )
    for (let i = 0; i < 50; i++) stream.write(`line ${i}\n`)
    stream.write('partial')
    await turn()
    alive = false
    await settle(60)
    stream.end()
    await settle()
    pipe.flush()
    expect(seen).toEqual([...Array.from({ length: 50 }, (_, i) => `line ${i}`), 'partial'])
  })

  it('does not resume a stream destroyed while paused', async () => {
    const stream = new PassThrough()
    const seen: string[] = []
    pipeLines(
      stream,
      1024,
      (r) => seen.push(lineOf(r)),
      () => true,
    )
    stream.write('a\n')
    stream.write('b\n')
    stream.destroy()
    await settle()
    expect(seen).toEqual(['a'])
    expect(stream.destroyed).toBe(true)
  })
})
