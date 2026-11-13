// Classifier assertions on recorded fixtures: every tests/fixtures/<vendor>/<route>/<ID>/ that has an
// expected.failure.json (see fixture-input.ts). Phase 2 adds those files next to the recordings.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classifyDetailed } from '@core/heal/classify.ts'
import { failureFixtureCases, inputFromRecording } from './fixture-input.ts'

const root = fileURLToPath(new URL('../../fixtures/', import.meta.url))
const cases = failureFixtureCases(root)

describe('classify: recorded fixtures', () => {
  if (cases.length === 0) {
    it('has no expected.failure.json fixtures yet', () => {
      expect(cases).toEqual([])
    })
  } else {
    it.each(cases.map((c) => [`${c.vendor}/${c.id}`, c] as const))('%s', (_name, c) => {
      const r = classifyDetailed(c.input)
      if (c.expected.category === null) {
        expect(r).toBeNull()
        return
      }
      expect(r?.failure.category).toBe(c.expected.category)
      if (c.expected.classifiedBy) expect(r?.failure.classifiedBy).toBe(c.expected.classifiedBy)
      if (c.expected.rule) expect(r?.rule).toBe(c.expected.rule)
    })
  }

  const c16 = fileURLToPath(
    new URL('../../fixtures/claude/stdio/C16-probe-handshake/recording.jsonl', import.meta.url),
  )
  it.skipIf(!existsSync(c16))('reads a recording into classifier input', () => {
    const rec = c16
    const input = inputFromRecording(rec, 'claude')
    expect(input.exitCode).toBe(0)
    expect(input.structured!.length).toBeGreaterThan(0)
    // A clean handshake is not a failure.
    expect(classifyDetailed(input)).toBeNull()
  })
})
