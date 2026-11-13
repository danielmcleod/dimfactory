import { Readable } from 'node:stream'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { LineSplitter, splitLines } from '../../../src/core/proc/lines.ts'
import type { LineRecord } from '../../../src/core/proc/lines.ts'

const texts = (recs: LineRecord[]): string[] => recs.map((r) => (r.kind === 'line' ? r.line : `<${r.bytes}>`))

function feed(chunks: (string | Buffer)[], max?: number): string[] {
  const s = new LineSplitter(max)
  const out: LineRecord[] = []
  for (const c of chunks) out.push(...s.push(c))
  out.push(...s.end())
  return texts(out)
}

describe('LineSplitter', () => {
  it('splits lines across chunk boundaries', () => {
    expect(feed(['{"a":', '1}\n{"b"', ':2}\n'])).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('strips CR from CRLF and keeps empty lines', () => {
    expect(feed(['one\r\ntwo\r', '\n\r\nthree\n'])).toEqual(['one', 'two', '', 'three'])
  })

  it('flushes a partial tail at end', () => {
    expect(feed(['a\nb'])).toEqual(['a', 'b'])
    expect(feed(['a\n'])).toEqual(['a'])
    expect(feed([])).toEqual([])
  })

  it('decodes a multi-byte UTF-8 code point split across chunks', () => {
    const bytes = Buffer.from('héllo 🌍 wörld\n', 'utf8')
    const at = bytes.indexOf(0xf0) + 2 // inside the 4-byte emoji
    expect(feed([bytes.subarray(0, at), bytes.subarray(at)])).toEqual(['héllo 🌍 wörld'])
  })

  it('turns an over-limit line into an oversize record and keeps going', () => {
    const s = new LineSplitter(10)
    const recs = [...s.push('short\n0123456789ABC'), ...s.push('DEF\nnext\n'), ...s.end()]
    expect(recs).toEqual([
      { kind: 'line', line: 'short' },
      { kind: 'oversize', bytes: 16, head: '0123456789ABCDEF' },
      { kind: 'line', line: 'next' },
    ])
  })

  it('a line of exactly maxLineBytes is kept', () => {
    expect(feed(['0123456789\n'], 10)).toEqual(['0123456789'])
  })

  it('any chunking yields the same lines (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ unit: 'grapheme', maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, '')),
          {
            maxLength: 8,
          },
        ),
        fc.array(fc.nat(), { maxLength: 6 }),
        (lines, cuts) => {
          const bytes = Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8')
          const points = [...new Set(cuts.map((c) => (bytes.length === 0 ? 0 : c % bytes.length)))].sort(
            (a, b) => a - b,
          )
          const chunks: Buffer[] = []
          let prev = 0
          for (const p of points) {
            chunks.push(bytes.subarray(prev, p))
            prev = p
          }
          chunks.push(bytes.subarray(prev))
          expect(feed(chunks)).toEqual(lines)
        },
      ),
    )
  })
})

describe('splitLines', () => {
  it('splits an async stream', async () => {
    const src = Readable.from([Buffer.from('x\ny'), Buffer.from('z\n')])
    const out: LineRecord[] = []
    for await (const rec of splitLines(src)) out.push(rec)
    expect(texts(out)).toEqual(['x', 'yz'])
  })
})
