// Verify excerpt (execution): the last 60 lines plus error-pattern lines with 2 lines of context,
// ANSI stripped, capped at 4 KB; collected while streaming with bounded memory.
import { describe, expect, it } from 'vitest'
import {
  EXCERPT_MAX_BYTES,
  ExcerptCollector,
  buildExcerpt,
  cleanLine,
} from '../../../src/core/verify/excerpt.ts'

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`): string[] =>
  Array.from({ length: n }, (_, i) => f(i))
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

describe('cleanLine', () => {
  it('strips ANSI colour, cursor and OSC sequences and control characters', () => {
    expect(cleanLine('\x1b[31mFAIL\x1b[0m src/a.test.ts')).toBe('FAIL src/a.test.ts')
    expect(cleanLine('\x1b[2K\x1b[1Gdone')).toBe('done')
    expect(cleanLine('\x1b]0;title\x07text')).toBe('text')
    expect(cleanLine('a\x00b\x08c\td')).toBe('abc\td')
  })

  it('keeps what a terminal shows last after a carriage return', () => {
    expect(cleanLine('progress 10%\rprogress 100%')).toBe('progress 100%')
    expect(cleanLine('text\r')).toBe('text')
  })
})

describe('excerpt', () => {
  it('a short output is the whole output', () => {
    expect(buildExcerpt(['a', 'b', 'Error: boom', 'c'])).toBe('a\nb\nError: boom\nc')
  })

  it('keeps the last 60 lines', () => {
    const out = buildExcerpt(lines(200)).split('\n')
    expect(out).toEqual(lines(60, (i) => `line ${140 + i}`))
  })

  it('adds error lines before the tail with 2 lines of context, … between pieces', () => {
    const src = lines(300)
    src[10] = 'FAIL src/a.test.ts > adds'
    src[11] = 'AssertionError: expected 1 to be 2'
    src[100] = 'TypeError: x is not a function'
    const out = buildExcerpt(src).split('\n')
    expect(out.slice(0, 13)).toEqual([
      'line 8',
      'line 9',
      'FAIL src/a.test.ts > adds',
      'AssertionError: expected 1 to be 2',
      'line 12',
      'line 13',
      '…',
      'line 98',
      'line 99',
      'TypeError: x is not a function',
      'line 101',
      'line 102',
      '…',
    ])
    expect(out.slice(13)).toEqual(lines(60, (i) => `line ${240 + i}`))
  })

  it('no gap marker when the error context runs into the tail', () => {
    const src = lines(70)
    src[8] = 'error here'
    const out = buildExcerpt(src).split('\n')
    expect(out[0]).toBe('line 6')
    expect(out).not.toContain('…')
    expect(out).toHaveLength(64)
  })

  it('error lines inside the tail are not repeated', () => {
    const src = lines(30)
    src[20] = 'Error: once'
    expect(buildExcerpt(src).split('Error: once')).toHaveLength(2)
  })

  it('is at most 4 KB: the first errors keep up to half, the tail keeps its last lines', () => {
    const long = (i: number): string => `${'x'.repeat(150)} ${i}`
    const src = lines(5000, long)
    for (let i = 0; i < 4000; i += 50) src[i] = `error number ${i} ${'e'.repeat(120)}`
    const out = buildExcerpt(src)
    expect(bytes(out)).toBeLessThanOrEqual(EXCERPT_MAX_BYTES)
    const parts = out.split('\n')
    expect(parts[0]).toBe(src[0])
    expect(parts.at(-1)).toBe(long(4999))
    expect(parts).toContain('…')
    expect(bytes(out)).toBeGreaterThan(EXCERPT_MAX_BYTES - 400)
  })

  it('cuts a single huge line, multibyte safe', () => {
    const out = buildExcerpt([`${'é'.repeat(10_000)}`, 'Error: ✗ failed ×'])
    expect(bytes(out)).toBeLessThanOrEqual(EXCERPT_MAX_BYTES)
    expect(out.endsWith('Error: ✗ failed ×')).toBe(true)
    expect(out).toContain('é…')
    expect(out).not.toContain('�')
  })

  it('custom caps hold for any size', () => {
    for (const cap of [64, 200, 1000]) {
      expect(
        bytes(
          buildExcerpt(
            lines(500, (i) => `fail ${i} ${'z'.repeat(i % 90)}`),
            cap,
          ),
        ),
      ).toBeLessThanOrEqual(cap)
    }
  })

  it('streams a large output with bounded state', () => {
    const c = new ExcerptCollector()
    for (let i = 0; i < 200_000; i++) c.push(i % 1000 === 0 ? `error ${i}` : `ok ${i}`)
    expect(c.lines).toBe(200_000)
    expect(c.tail()).toHaveLength(60)
    const out = c.excerpt()
    expect(out.startsWith('ok 998\nok 999\nerror 1000')).toBe(false) // error 0 comes first
    expect(out.startsWith('error 0\nok 1\nok 2')).toBe(true)
    expect(out.endsWith('ok 199999')).toBe(true)
  })

  it('an empty output is empty', () => {
    expect(buildExcerpt([])).toBe('')
  })
})
