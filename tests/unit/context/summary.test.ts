import { describe, expect, it } from 'vitest'
import { STATE_NOTE_MAX_BYTES, stateNote } from '@core/context/summary.ts'

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

describe('stateNote: the fresh restart and reminder note', () => {
  it('names the pass, the compactions, the criteria, the files and the plan', () => {
    const text = stateNote({
      step: 'implement',
      why: 'restart',
      compactions: 3,
      plan: '1. Add the parser\n2. Wire it in',
      criteria: [{ id: 'AC1', text: 'Parses dates' }],
      files: ['src/parse.ts', 'src/index.ts'],
    })
    expect(text).toContain('continuing Implement in a fresh session')
    expect(text).toContain('summarised its notes 3 times')
    expect(text).toContain('- AC1: Parses dates')
    expect(text).toContain('- src/parse.ts')
    expect(text).toContain('1. Add the parser')
    expect(text).not.toContain('—')
  })

  it('says twice, lists Fix findings and "none yet" without files', () => {
    const text = stateNote({ step: 'fix', why: 'restart', compactions: 2, findings: ['F1 broken import'] })
    expect(text).toContain('summarised its notes twice')
    expect(text).toContain('Findings to fix:\n- F1 broken import')
    expect(text).toContain('Files changed so far:\n- none yet')
  })

  it('a reminder reads as one', () => {
    expect(stateNote({ step: 'implement', why: 'reminder', compactions: 1 })).toMatch(
      /^Reminder after the context/,
    )
  })

  it('stays within 1.5k tokens whatever it is given', () => {
    const text = stateNote({
      step: 'implement',
      why: 'restart',
      compactions: 4,
      plan: 'step '.repeat(20_000),
      criteria: Array.from({ length: 50 }, (_, i) => ({ id: `AC${i + 1}`, text: 'x'.repeat(500) })),
      files: Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`),
    })
    expect(bytes(text)).toBeLessThanOrEqual(STATE_NOTE_MAX_BYTES)
    expect(text).toContain('- and 38 more')
    expect(text).toContain('- and 460 more files')
  })
})
