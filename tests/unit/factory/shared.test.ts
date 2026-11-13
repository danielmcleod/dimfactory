// The shared factory helpers (src/shared/factory.ts): TODO parsing, task titles, run results and counts.
import { describe, expect, it } from 'vitest'
import {
  QUEUE_TITLE_MAX,
  countTasks,
  failedOutcomeText,
  parseTodo,
  queueResultOf,
  taskTitle,
} from '@shared/factory.ts'
import { RUN_OUTCOMES } from '@shared/run.ts'

describe('parseTodo', () => {
  it('reads open checkbox items of every list style, at any indent, with their lines', () => {
    const text = [
      '# Tasks',
      '- [ ] dash item',
      '* [ ] star item',
      '+ [ ] plus item',
      '  - [ ] indented item  ',
      '1. [ ] numbered item',
      '2) [ ] numbered with a paren',
      '- [x] done item',
      '- [X] also done',
      '- [] not a checkbox',
      '- [ ]',
      'plain line',
    ].join('\n')
    expect(parseTodo(text)).toEqual([
      { line: 2, text: 'dash item' },
      { line: 3, text: 'star item' },
      { line: 4, text: 'plus item' },
      { line: 5, text: 'indented item' },
      { line: 6, text: 'numbered item' },
      { line: 7, text: 'numbered with a paren' },
    ])
  })

  it('skips fenced code blocks (backticks and tildes), and a fence only closes with its own mark', () => {
    const text = [
      '```',
      '- [ ] in code',
      '~~~',
      '- [ ] still code',
      '```',
      '~~~md',
      '- [ ] tilde code',
      '~~~',
      '- [ ] after',
    ].join('\n')
    expect(parseTodo(text)).toEqual([{ line: 9, text: 'after' }])
  })

  it('handles a BOM and CRLF line endings', () => {
    expect(parseTodo('\uFEFF- [ ] first\r\n- [ ] second\r\n')).toEqual([
      { line: 1, text: 'first' },
      { line: 2, text: 'second' },
    ])
  })
})

describe('taskTitle', () => {
  it('the first non-empty line, trimmed, cut with dots past the limit', () => {
    expect(taskTitle('\n\n  Fix it  \nmore')).toBe('Fix it')
    const long = 'x'.repeat(QUEUE_TITLE_MAX + 10)
    const t = taskTitle(long)
    expect(t).toHaveLength(QUEUE_TITLE_MAX)
    expect(t.endsWith('...')).toBe(true)
    expect(taskTitle('   ')).toBe('')
  })
})

describe('queueResultOf and failedOutcomeText', () => {
  it('done for fixed, clean and findings-open; failed for the other outcomes; stopped when cancelled', () => {
    const done = RUN_OUTCOMES.filter((o) => queueResultOf('completed', o) === 'done')
    expect(done).toEqual(['fixed', 'clean', 'findings-open'])
    for (const o of RUN_OUTCOMES) {
      if (done.includes(o)) expect(failedOutcomeText(o)).toBeUndefined()
      else {
        expect(queueResultOf('completed', o)).toBe('failed')
        expect(failedOutcomeText(o)).toMatch(/\.$/)
        expect(failedOutcomeText(o)).not.toContain('\u2014')
      }
    }
    expect(queueResultOf('cancelled', 'failed')).toBe('stopped')
    for (const s of ['queued', 'running', 'waiting', 'paused', 'failed'] as const)
      expect(queueResultOf(s)).toBeUndefined()
  })
})

describe('countTasks', () => {
  it('counts each status; blocked counts as waiting', () => {
    expect(
      countTasks([
        { status: 'pending' },
        { status: 'pending' },
        { status: 'running' },
        { status: 'waiting' },
        { status: 'blocked' },
        { status: 'done' },
        { status: 'failed' },
        { status: 'stopped' },
      ]),
    ).toEqual({ pending: 2, running: 1, waiting: 2, done: 1, failed: 1, stopped: 1 })
  })
})
