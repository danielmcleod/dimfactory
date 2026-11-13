import { appendFile, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  JsonlWriter,
  SeqOffsetIndex,
  fileSize,
  readJsonlAll,
  readJsonlTail,
  scanJsonl,
} from '../../../src/core/store/jsonl.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

describe('JsonlWriter', () => {
  it('appends lines in order, returns byte offsets and joins a tick into one write', async () => {
    const file = join(home(), 'd', 'a.jsonl')
    const w = await JsonlWriter.open(file)
    const offsets = [w.append({ i: 1 }), w.append({ i: 2, s: 'é' }), w.append({ i: 3 })]
    expect(w.pendingBytes).toBeGreaterThan(0)
    await w.flush()
    expect(w.pendingBytes).toBe(0)
    const text = await readFile(file, 'utf8')
    expect(text).toBe('{"i":1}\n{"i":2,"s":"é"}\n{"i":3}\n')
    const buf = Buffer.from(text)
    expect(offsets).toEqual([0, 8, 8 + Buffer.byteLength('{"i":2,"s":"é"}\n')])
    expect(buf.subarray(offsets[2]).toString()).toBe('{"i":3}\n')
    expect(w.size).toBe(buf.length)
    await w.close()
  })

  it('never drops lines across many ticks and concurrent flushes', async () => {
    const file = join(home(), 'many.jsonl')
    const w = await JsonlWriter.open(file)
    const flushes: Promise<void>[] = []
    for (let i = 0; i < 5000; i++) {
      w.append({ i, pad: 'x'.repeat(i % 50) })
      if (i % 97 === 0) {
        flushes.push(w.flush())
        await Promise.resolve()
      }
    }
    await Promise.all(flushes)
    await w.datasync()
    await w.close()
    const { values, stats } = await readJsonlAll(file)
    expect(stats.bad).toBe(0)
    expect(values.map((v) => (v as { i: number }).i)).toEqual(Array.from({ length: 5000 }, (_, i) => i))
  })

  it('truncates a torn trailing line on open and continues cleanly', async () => {
    const file = join(home(), 'torn.jsonl')
    await writeFile(file, '{"a":1}\n{"a":2}\n{"a":')
    const w = await JsonlWriter.open(file)
    expect(w.truncatedBytes).toBe(5)
    expect(w.size).toBe(16)
    w.append({ a: 3 })
    await w.close()
    expect(await readFile(file, 'utf8')).toBe('{"a":1}\n{"a":2}\n{"a":3}\n')
  })

  it('truncates a file that is one partial line to empty', async () => {
    const file = join(home(), 'partial.jsonl')
    await writeFile(file, '{"never":"finished"')
    const w = await JsonlWriter.open(file)
    expect(w.size).toBe(0)
    await w.close()
    expect(await fileSize(file)).toBe(0)
  })

  it('rejects lines with embedded newlines and appends after close', async () => {
    const w = await JsonlWriter.open(join(home(), 'x.jsonl'))
    expect(() => w.appendLine('a\nb')).toThrow(/newline/)
    await w.close()
    expect(() => w.append({})).toThrow(/closed/)
  })

  it('flush right after a flush (write still settling) resolves', async () => {
    const w = await JsonlWriter.open(join(home(), 'settle.jsonl'))
    for (let i = 0; i < 50; i++) {
      w.append({ i })
      await w.flush()
      await w.flush()
    }
    await w.close()
    expect((await readJsonlAll(join(home(), 'settle.jsonl'))).values).toHaveLength(50)
  })

  it('keeps lines queued through failed writes (partial write, ENOSPC) and retries in order', async () => {
    const file = join(home(), 'retry.jsonl')
    const errors: string[] = []
    let calls = 0
    const w = await JsonlWriter.open(file, {
      retryDelaysMs: [5, 5, 5],
      onError: (e) => errors.push(String((e.details as { errno?: string } | undefined)?.errno)),
      write: async (handle, buf, offset, length) => {
        calls++
        if (calls === 1) {
          // Short write of 3 bytes, then the disk fills up.
          return handle.write(buf, offset, Math.min(3, length), null)
        }
        if (calls === 2 || calls === 3) {
          throw Object.assign(new Error('ENOSPC: no space'), { code: 'ENOSPC' })
        }
        return handle.write(buf, offset, length, null)
      },
    })
    w.append({ a: 1 })
    w.append({ a: 2 })
    await expect(w.flush()).rejects.toMatchObject({ code: 'STORAGE' })
    w.append({ a: 3 })
    // The retry timer (or this explicit flush) eventually writes everything.
    let done = false
    for (let i = 0; i < 20 && !done; i++) {
      done = await w.flush().then(
        () => true,
        () => false,
      )
    }
    expect(done).toBe(true)
    await w.close()
    expect(errors).toEqual(['ENOSPC', 'ENOSPC'])
    expect(await readFile(file, 'utf8')).toBe('{"a":1}\n{"a":2}\n{"a":3}\n')
  })

  it('warns once when the unwritten backlog exceeds the bound', async () => {
    const warnings: string[] = []
    const w = await JsonlWriter.open(join(home(), 'big.jsonl'), {
      backlogWarnBytes: 100,
      onWarn: (m) => warnings.push(m),
    })
    for (let i = 0; i < 20; i++) w.append({ i, pad: 'y'.repeat(20) })
    expect(warnings).toHaveLength(1)
    await w.close()
    const { values } = await readJsonlAll(join(home(), 'big.jsonl'))
    expect(values).toHaveLength(20)
  })
})

describe('scanJsonl', () => {
  it('ignores a trailing partial line, counts bad lines, tolerates CRLF and blank lines', async () => {
    const file = join(home(), 'mixed.jsonl')
    await writeFile(file, '{"a":1}\r\n\nnot json\n{"a":2}\n{"a":3')
    const seen: { value: unknown; lineNo: number }[] = []
    const bad: number[] = []
    const stats = await scanJsonl(file, (l) => void seen.push({ value: l.value, lineNo: l.lineNo }), {
      onBad: (b) => bad.push(b.lineNo),
    })
    expect(seen).toEqual([
      { value: { a: 1 }, lineNo: 1 },
      { value: { a: 2 }, lineNo: 4 },
    ])
    expect(stats).toMatchObject({ exists: true, lines: 2, bad: 1, badLineNos: [3], partialTail: true })
    expect(bad).toEqual([3])
  })

  it('reports byte-exact offsets across chunk boundaries', async () => {
    const file = join(home(), 'chunks.jsonl')
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, s: 'ü'.repeat(i % 13) }))
    await writeFile(file, `${lines.join('\n')}\n`)
    const text = await readFile(file)
    const got: { offset: number; length: number; value: unknown }[] = []
    await scanJsonl(file, (l) => void got.push(l), { chunkSize: 37 })
    expect(got).toHaveLength(200)
    for (const [i, l] of got.entries()) {
      expect(JSON.parse(text.subarray(l.offset, l.offset + l.length).toString())).toEqual({
        i,
        s: 'ü'.repeat(i % 13),
      })
    }
  })

  it('starts at an offset, stops at an end, and can stop early', async () => {
    const file = join(home(), 'range.jsonl')
    await writeFile(file, '{"n":1}\n{"n":2}\n{"n":3}\n{"n":4}\n')
    const from: unknown[] = []
    await scanJsonl(file, (l) => void from.push(l.value), { start: 8, end: 24 })
    expect(from).toEqual([{ n: 2 }, { n: 3 }])
    const early: unknown[] = []
    const stats = await scanJsonl(file, (l) => {
      early.push(l.value)
      return early.length < 2 ? undefined : false
    })
    expect(early).toEqual([{ n: 1 }, { n: 2 }])
    expect(stats.stopped).toBe(true)
  })

  it('treats a missing file as empty', async () => {
    const { values, stats } = await readJsonlAll(join(home(), 'nope.jsonl'))
    expect(values).toEqual([])
    expect(stats.exists).toBe(false)
  })
})

describe('readJsonlTail', () => {
  it('returns only complete lines inside the window with absolute offsets', async () => {
    const file = join(home(), 'tail.jsonl')
    for (let i = 0; i < 100; i++) await appendFile(file, `${JSON.stringify({ i })}\n`)
    await appendFile(file, '{"torn":')
    const size = (await stat(file)).size
    const t = await readJsonlTail(file, 64)
    expect(t.size).toBe(size)
    const values = t.lines.map((l) => (l.value as { i: number }).i)
    expect(values.at(-1)).toBe(99)
    expect(values.length).toBeGreaterThan(2)
    expect(values).toEqual(Array.from({ length: values.length }, (_, k) => 100 - values.length + k))
    const text = await readFile(file)
    const last = t.lines.at(-1)!
    expect(text.subarray(last.offset, last.offset + last.length).toString()).toBe('{"i":99}\n')
  })

  it('reads a small file whole', async () => {
    const file = join(home(), 'small.jsonl')
    await writeFile(file, '{"a":1}\n{"a":2}\n')
    expect((await readJsonlTail(file)).lines.map((l) => l.value)).toEqual([{ a: 1 }, { a: 2 }])
  })
})

describe('SeqOffsetIndex', () => {
  it('keeps one entry per `every` seqs and finds the floor', () => {
    const idx = new SeqOffsetIndex(500)
    for (let seq = 1; seq <= 2000; seq++) idx.note(seq, seq * 10)
    expect(idx.size).toBe(4)
    expect(idx.floor(0)).toBeNull()
    expect(idx.floor(1)).toEqual({ seq: 1, offset: 10 })
    expect(idx.floor(500)).toEqual({ seq: 1, offset: 10 })
    expect(idx.floor(501)).toEqual({ seq: 501, offset: 5010 })
    expect(idx.floor(1999)).toEqual({ seq: 1501, offset: 15010 })
    expect(idx.floor(99999)).toEqual({ seq: 1501, offset: 15010 })
  })

  it('starts at the first noted seq even when it is not 1', () => {
    const idx = new SeqOffsetIndex(3)
    for (const seq of [42, 43, 44, 45, 46]) idx.note(seq, seq)
    expect(idx.firstSeq).toBe(42)
    expect(idx.floor(41)).toBeNull()
    expect(idx.floor(47)).toEqual({ seq: 45, offset: 45 })
  })
})
