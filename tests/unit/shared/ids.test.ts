import { describe, expect, it } from 'vitest'
import { RUN_ID_PATTERN, fileSafe, newRequestId, newRunId, newUuid } from '@shared/ids.ts'
import { STEP_KEYS } from '@shared/run.ts'

describe('newRunId', () => {
  it('encodes the UTC timestamp and a 4-hex suffix', () => {
    const id = newRunId(new Date(Date.UTC(2026, 9, 5, 1, 2, 3)))
    expect(id).toMatch(RUN_ID_PATTERN)
    expect(id.startsWith('20261005T010203Z-')).toBe(true)
  })

  it('defaults to now and matches the pattern', () => {
    expect(newRunId()).toMatch(RUN_ID_PATTERN)
  })

  it('sorts lexicographically by creation time', () => {
    const a = newRunId(new Date(Date.UTC(2026, 0, 31, 23, 59, 59)))
    const b = newRunId(new Date(Date.UTC(2026, 1, 1, 0, 0, 0)))
    const c = newRunId(new Date(Date.UTC(2026, 9, 5, 12, 0, 0)))
    expect([c, a, b].sort()).toEqual([a, b, c])
  })

  it('is safe to use as a file name', () => {
    const id = newRunId()
    expect(fileSafe(id)).toBe(id)
  })
})

describe('newUuid', () => {
  it('returns distinct RFC 4122 v4 UUIDs', () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    const a = newUuid()
    const b = newUuid()
    expect(a).toMatch(v4)
    expect(b).toMatch(v4)
    expect(a).not.toBe(b)
  })
})

describe('newRequestId', () => {
  it('uses the prefix and 16 hex characters', () => {
    expect(newRequestId()).toMatch(/^req_[0-9a-f]{16}$/)
    expect(newRequestId('ask')).toMatch(/^ask_[0-9a-f]{16}$/)
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRequestId()))
    expect(ids.size).toBe(500)
  })
})

describe('fileSafe', () => {
  it("maps ':' so step keys never create NTFS alternate data streams", () => {
    expect(fileSafe('verify:1')).toBe('verify-1')
    expect(fileSafe('raw/fix:2')).toBe('raw-fix-2')
    for (const key of STEP_KEYS) expect(fileSafe(key)).not.toContain(':')
  })

  it('maps every Windows-reserved path character', () => {
    expect(fileSafe('a:b<c>d"e|f?g*h\\i/j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('keeps safe names unchanged and is idempotent', () => {
    for (const s of ['plan', 'plan.original', 'S0..S1', 'post-verify-1', 'run_start'])
      expect(fileSafe(s)).toBe(s)
    const once = fileSafe('verify:2?')
    expect(fileSafe(once)).toBe(once)
  })
})
