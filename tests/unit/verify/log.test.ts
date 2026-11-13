// Verify logs (execution): the first 1 MB and the last 4 MB, with a marker for what was left out.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CappedLog,
  LIVE_TAIL_BYTES,
  LOG_HEAD_BYTES,
  LOG_TAIL_BYTES,
  LiveTail,
} from '../../../src/core/verify/log.ts'
import { removeDir, tempDir } from './helpers.ts'

let dir = ''
beforeEach(() => {
  dir = tempDir()
})
afterEach(() => removeDir(dir))

describe('CappedLog', () => {
  it('defaults to 1 MB + 4 MB', () => {
    expect(LOG_HEAD_BYTES).toBe(1024 * 1024)
    expect(LOG_TAIL_BYTES).toBe(4 * 1024 * 1024)
  })

  it('keeps everything under the caps', async () => {
    const log = await CappedLog.open(join(dir, 'a', 'b.log'), { headBytes: 10, tailBytes: 20 })
    log.write('hello\n')
    log.write('world\n')
    expect(await log.close()).toEqual({ bytes: 12, omitted: 0 })
    expect(readFileSync(join(dir, 'a', 'b.log'), 'utf8')).toBe('hello\nworld\n')
  })

  it('keeps the head and the tail around an omitted marker', async () => {
    const path = join(dir, 'x.log')
    const log = await CappedLog.open(path, { headBytes: 10, tailBytes: 8 })
    for (let i = 0; i < 10; i++) log.write(`${i}${i}${i}${i}\n`) // 50 bytes
    // The last 8 bytes start mid-line ("88\n9999\n"): the kept tail starts at the next line.
    expect(await log.close()).toEqual({ bytes: 50, omitted: 35 })
    expect(readFileSync(path, 'utf8')).toBe('0000\n1111\n\n[… 35 bytes omitted by Dim Factory …]\n9999\n')
  })

  it('never splits a UTF-8 character at either cut', async () => {
    const path = join(dir, 'u.log')
    const log = await CappedLog.open(path, { headBytes: 5, tailBytes: 5 })
    log.write('éééééééééé') // 20 bytes, 2 each
    await log.close()
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('�')
    expect(text.startsWith('éé\n[…')).toBe(true)
    expect(text.endsWith('…]\néé')).toBe(true)
  })

  it('writes after close are ignored', async () => {
    const path = join(dir, 'c.log')
    const log = await CappedLog.open(path)
    log.write('a')
    expect(await log.close()).toEqual({ bytes: 1, omitted: 0 })
    log.write('b')
    expect(await log.close()).toEqual({ bytes: 0, omitted: 0 })
    expect(readFileSync(path, 'utf8')).toBe('a')
  })

  it('each section has its own head and tail (the round log: one section per command)', async () => {
    const path = join(dir, 'round.log')
    const log = await CappedLog.open(path, { headBytes: 4, tailBytes: 4 })
    log.write('$ a\n')
    for (let i = 0; i < 5; i++) log.write(`a${i}\n`)
    // The section's head is on disk while the command runs.
    expect(await log.endSection()).toEqual({ bytes: 19, omitted: 12 })
    log.write('$ b\n')
    log.write('b0\n')
    expect(await log.close()).toEqual({ bytes: 7, omitted: 0 })
    expect(readFileSync(path, 'utf8')).toBe('$ a\n\n[… 12 bytes omitted by Dim Factory …]\na4\n$ b\nb0\n')
  })
})

// The live view froze once a command had written 1 MB (CappedLog writes the rest when the command ends).
describe('LiveTail (live.log: what the Run view follows)', () => {
  it('rewrites the file with the last bytes soon after output arrives, past any head cap, and says so', async () => {
    const path = join(dir, 'live.log')
    let flushed = 0
    const live = new LiveTail(path, { maxBytes: 16, flushMs: 20, onFlushed: () => flushed++ })
    for (let i = 0; i < 10; i++) live.write(`line ${i}\n`) // 70 bytes
    await new Promise((r) => setTimeout(r, 200))
    expect(flushed).toBe(1)
    // The last 16 bytes start mid-line: the kept text starts at the next line.
    expect(readFileSync(path, 'utf8')).toBe("[Earlier output: 0 KB, in the round's logs]\nline 8\nline 9\n")
    live.write('line 10\n')
    await new Promise((r) => setTimeout(r, 200))
    expect(readFileSync(path, 'utf8')).toBe("[Earlier output: 0 KB, in the round's logs]\nline 9\nline 10\n")
    expect(flushed).toBe(2)
    // Nothing new: a flush writes nothing and says nothing.
    await live.close()
    expect(flushed).toBe(2)
    live.write('after close\n')
    await live.flush()
    expect(readFileSync(path, 'utf8')).not.toContain('after close')
  })

  it('a command writing past CappedLog’s 1 MB head is still current in the live file before it ends', async () => {
    const out = await CappedLog.open(join(dir, 'output.log'))
    const live = new LiveTail(join(dir, 'live.log'), { flushMs: 10 })
    const line = `${'x'.repeat(1023)}\n`
    for (let i = 0; i < 1500; i++) {
      out.write(line)
      live.write(line)
    }
    out.write('MARKER-END\n')
    live.write('MARKER-END\n')
    await live.flush()
    // output.log holds only the first 1 MB until the section ends; live.log ends with the latest line.
    expect(readFileSync(join(dir, 'output.log'), 'utf8')).not.toContain('MARKER-END')
    const text = readFileSync(join(dir, 'live.log'), 'utf8')
    expect(text.endsWith('MARKER-END\n')).toBe(true)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIVE_TAIL_BYTES + 64)
    expect(text.startsWith('[Earlier output: ')).toBe(true)
    await Promise.all([out.close(), live.close()])
  })
})
