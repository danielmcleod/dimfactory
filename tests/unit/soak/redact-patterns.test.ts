// Soak: raw-log redaction cost about 37 µs a line, so the compiled patterns are cached:
// redactText compiles its path, user name and host patterns once per set of option
// values (pathPatternsFor, a small bounded cache) instead of on every call, and skips the second rule pass when nothing
// changed the text. Results are the same: the reused global patterns start at 0 on every call, a key a host
// replacement exposes is still caught, and the cache forgets the oldest option set past its bound.
import { describe, expect, it } from 'vitest'
import { PATH_PATTERN_CACHE_MAX, pathPatternsFor, redactLine, redactText } from '@shared/redact.ts'
import type { RedactOptions } from '@shared/redact.ts'

const HOME = String.raw`C:\Users\jane`
const OPTS: RedactOptions = { mode: 'diagnostics', home: HOME, username: 'jane', hostname: 'JANEPC' }
// Assembled at runtime so this file holds no scanner-shaped literal.
const KEY = 'sk-' + 'proj-' + 'Zq9'.repeat(8)

describe('compiled path patterns (soak)', () => {
  it('compiles once per set of option values', () => {
    const a = pathPatternsFor({ ...OPTS })
    expect(pathPatternsFor({ ...OPTS })).toBe(a)
    expect(a.home.length).toBeGreaterThan(0)
    expect(a.user).not.toBeNull()
    expect(a.host).not.toBeNull()
    expect(pathPatternsFor({ ...OPTS, home: String.raw`C:\Users\joe` })).not.toBe(a)
    // cwd counts in fixture mode only.
    expect(pathPatternsFor({ ...OPTS, cwd: 'D:/work' })).toBe(a)
    expect(pathPatternsFor({ ...OPTS, mode: 'fixture', cwd: 'D:/work' }).cwd.length).toBeGreaterThan(0)
  })

  it('keeps at most PATH_PATTERN_CACHE_MAX option sets, forgetting the oldest', () => {
    const first = pathPatternsFor({ mode: 'diagnostics', home: '/home/first' })
    for (let i = 0; i < PATH_PATTERN_CACHE_MAX; i++)
      pathPatternsFor({ mode: 'diagnostics', home: `/home/u${i}` })
    expect(pathPatternsFor({ mode: 'diagnostics', home: '/home/first' })).not.toBe(first)
  })

  it('gives the same result call after call (the reused patterns start at 0)', () => {
    const line = String.raw`open C:\Users\jane\proj and C:/Users/jane/x on JANEPC; /home/jane/y`
    const once = redactText(line, OPTS)
    expect(once.text).toBe(String.raw`open ~\proj and ~/x on <host>; /home/<user>/y`)
    for (let i = 0; i < 5; i++) expect(redactText(line, OPTS)).toEqual(once)
    const json = JSON.stringify({ path: String.raw`C:\Users\jane\a`, text: 'JANEPC said hi' })
    const red = redactLine(json, OPTS).text
    for (let i = 0; i < 3; i++) expect(redactLine(json, OPTS).text).toBe(red)
    expect(red).not.toContain('jane')
    expect(red).not.toContain('JANEPC')
  })

  it('still catches a key that only a host replacement exposes', () => {
    // A letter before `sk-` hides the key until the host name in front of it is replaced.
    const r = redactText(`JANEPC${KEY}`, OPTS)
    expect(r.text).toBe('<host>[REDACTED]')
    expect(r.counts).toMatchObject({ hostname: 1, 'openai-key': 1 })
  })

  it('leaves clean text as it is', () => {
    const clean = '- line 12: dim-factory stream delta replay buffer review implement focus seq'
    expect(redactText(clean, OPTS)).toEqual({ text: clean, counts: {} })
  })
})
