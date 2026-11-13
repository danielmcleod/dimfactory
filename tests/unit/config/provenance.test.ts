import { describe, expect, it } from 'vitest'
import type { Provenance } from '@shared/config-schema.ts'
import {
  ProvenanceRecorder,
  describeProvenance,
  parseJsonPointer,
  parseProvenanceMap,
  pointerAncestry,
  provenanceAt,
  provenanceBadge,
  provenanceFrom,
  toJsonPointer,
} from '@core/config/provenance.ts'

describe('JSON pointers', () => {
  it('round-trips RFC 6901 escapes', () => {
    const segs = ['vendors', 'claude', 'flagMap', '--a/b~c']
    const p = toJsonPointer(segs)
    expect(p).toBe('/vendors/claude/flagMap/--a~1b~0c')
    expect(parseJsonPointer(p)).toEqual(segs)
    expect(parseJsonPointer('')).toEqual([])
    expect(() => parseJsonPointer('passes')).toThrow(/not a JSON pointer/)
  })

  it('ancestry runs from the pointer to the root', () => {
    expect(pointerAncestry('/a/b/c')).toEqual(['/a/b/c', '/a/b', '/a', ''])
  })
})

describe('ProvenanceRecorder', () => {
  const user = (line: number): Provenance => ({ source: 'user', file: 'u.json', line })

  it('later writes win; a leaf replaces what was recorded below it', () => {
    const rec = new ProvenanceRecorder()
    rec.set('/verify/runAfter', { source: 'default' })
    rec.set('/verify/runAfter', user(3))
    rec.set('/a/b/c', { source: 'default' })
    rec.set('/a/b', user(4))
    expect(rec.toMap()).toEqual({ '/a/b': user(4), '/verify/runAfter': user(3) })
  })

  it('an empty object only fills a gap (it merges, it never clears)', () => {
    const rec = new ProvenanceRecorder()
    rec.setLeaves({ claude: { defaultModel: 'x' } }, ['vendors'], () => user(2))
    rec.setLeaves({}, ['vendors'], () => ({ source: 'project' }))
    expect(rec.toMap()).toEqual({ '/vendors/claude/defaultModel': user(2) })
    rec.setLeaves({}, ['ui'], () => ({ source: 'default' }))
    expect(rec.get('/ui')).toEqual({ source: 'default' })
  })

  it('setLeaves hands each leaf its segments (for file line lookups)', () => {
    const rec = new ProvenanceRecorder()
    const lines: Record<string, number> = { '/gates/afterPlan': 7, '/gates/beforeFix': 8 }
    rec.setLeaves({ afterPlan: false, beforeFix: true }, ['gates'], (segs) =>
      provenanceFrom({ source: 'project', file: 'p.json', lines }, toJsonPointer(segs)),
    )
    expect(rec.toMap()).toEqual({
      '/gates/afterPlan': { source: 'project', file: 'p.json', line: 7 },
      '/gates/beforeFix': { source: 'project', file: 'p.json', line: 8 },
    })
  })

  it('setIfAbsent fills only when nothing is recorded at or below', () => {
    const rec = new ProvenanceRecorder()
    rec.set('/vendors/claude/env/A', user(5))
    rec.setIfAbsent('/vendors/claude/env', { source: 'default' })
    rec.setIfAbsent('/vendors/claude/path', { source: 'default' })
    expect(rec.toMap()).toEqual({
      '/vendors/claude/env/A': user(5),
      '/vendors/claude/path': { source: 'default' },
    })
  })

  it('toMap is sorted by pointer', () => {
    const rec = new ProvenanceRecorder()
    rec.set('/z', { source: 'default' })
    rec.set('/a', { source: 'default' })
    expect(Object.keys(rec.toMap())).toEqual(['/a', '/z'])
  })
})

describe('lookups and display', () => {
  it('provenanceAt: exact, else nearest ancestor', () => {
    const map = {
      '/vendors': { source: 'default' as const },
      '/passes/plan/model': { source: 'user' as const },
    }
    expect(provenanceAt(map, '/passes/plan/model')).toEqual({ source: 'user' })
    expect(provenanceAt(map, '/vendors/claude/path')).toEqual({ source: 'default' })
    expect(provenanceAt(map, '/ui/theme')).toBeUndefined()
  })

  it('provenanceFrom omits what it does not know', () => {
    expect(provenanceFrom({ source: 'run' }, '/auto')).toEqual({ source: 'run' })
    expect(provenanceFrom({ source: 'user', file: 'f', lines: {} }, '/auto', 'passes')).toEqual({
      source: 'user',
      file: 'f',
      via: 'passes',
    })
  })

  it('badges (composer)', () => {
    expect(provenanceBadge(undefined)).toBe('default')
    expect(provenanceBadge({ source: 'default' })).toBe('default')
    expect(provenanceBadge({ source: 'project' })).toBe('project')
    expect(provenanceBadge({ source: 'auto' })).toBe('auto')
    expect(provenanceBadge({ source: 'inherit', via: 'inherit:implement' })).toBe('= implement')
    expect(provenanceBadge({ source: 'vendor' })).toBe('vendor default')
    expect(provenanceBadge({ source: 'cli' })).toBe('CLI default')
  })

  it('describeProvenance', () => {
    expect(describeProvenance({ source: 'user', file: 'c.json', line: 12, via: 'profile:fast' })).toBe(
      'user (c.json:12, profile:fast)',
    )
    expect(describeProvenance({ source: 'cli' })).toBe('cli')
    expect(describeProvenance(undefined)).toBe('default')
  })

  it('parseProvenanceMap keeps well-formed entries only', () => {
    expect(
      parseProvenanceMap({
        '/a': { source: 'user', file: 'f', line: 3, via: 'passes' },
        '/b': { source: 'nope' },
        '/c': { source: 'run', line: -1 },
        bad: { source: 'user' },
        '/d': 'x',
      }),
    ).toEqual({ '/a': { source: 'user', file: 'f', line: 3, via: 'passes' }, '/c': { source: 'run' } })
    expect(parseProvenanceMap(null)).toEqual({})
  })
})
