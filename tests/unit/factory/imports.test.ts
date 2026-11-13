// Queue imports (factory/imports.ts): gh's issue list parsed strictly, an issue as a task, and the TODO file's path.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TODO_FILE,
  TODO_FILE_MAX_BYTES,
  issueTask,
  parseIssues,
  readTodo,
  todoLabel,
  todoPath,
} from '@core/factory/imports.ts'
import { QUEUE_TASK_TEXT_MAX } from '@shared/factory.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('parseIssues', () => {
  it('refuses output that is not a JSON list', () => {
    expect(() => parseIssues('not json')).toThrow('gh did not answer with a list of issues.')
    expect(() => parseIssues('{"number":1}')).toThrow('gh did not answer with a list of issues.')
  })

  it('keeps well-formed issues only, and only https addresses', () => {
    const out = parseIssues(
      JSON.stringify([
        { number: 3, title: 'Good', body: 'b', url: 'https://github.com/a/b/issues/3' },
        { number: 4, title: 'No body or url' },
        { number: 5, title: 'Plain http', url: 'http://x.test/5' },
        { number: 0, title: 'zero' },
        { number: 1.5, title: 'fraction' },
        { number: 6, title: '   ' },
        { number: '7', title: 'string number' },
        null,
        'x',
      ]),
    )
    expect(out).toEqual([
      { number: 3, title: 'Good', body: 'b', url: 'https://github.com/a/b/issues/3' },
      { number: 4, title: 'No body or url', body: '' },
      { number: 5, title: 'Plain http', body: '' },
    ])
  })
})

describe('issueTask', () => {
  it('the title, where it came from, then the text', () => {
    expect(
      issueTask({ number: 9, title: ' Fix it ', body: 'Steps\r\n1. a\r\n', url: 'https://x.test/9' }),
    ).toBe('Fix it\n\nGitHub issue #9 (https://x.test/9).\n\nSteps\n1. a')
    expect(issueTask({ number: 9, title: 'Fix it', body: '' })).toBe('Fix it\n\nGitHub issue #9.')
  })

  it('a long body is cut, saying so, and the task fits a queue', () => {
    const t = issueTask({ number: 1, title: 'Big', body: 'x'.repeat(QUEUE_TASK_TEXT_MAX * 2) })
    expect(t.length).toBeLessThanOrEqual(QUEUE_TASK_TEXT_MAX)
    expect(t.endsWith("\n(The issue's text was cut here.)")).toBe(true)
  })
})

describe('TODO files', () => {
  it("todoPath: the folder's TODO.md by default, a relative file under the folder, an absolute one as it is", () => {
    const folder = resolve('/work/repo')
    expect(todoPath(folder, undefined)).toBe(join(folder, DEFAULT_TODO_FILE))
    expect(todoPath(folder, '  ')).toBe(join(folder, DEFAULT_TODO_FILE))
    expect(todoPath(folder, 'docs/todo.md')).toBe(join(folder, 'docs', 'todo.md'))
    const abs = resolve('/elsewhere/list.md')
    expect(todoPath(folder, abs)).toBe(abs)
  })

  it('todoLabel: relative inside the folder with / separators, the full path outside', () => {
    const folder = resolve('/work/repo')
    expect(todoLabel(folder, join(folder, 'docs', 'todo.md'))).toBe('docs/todo.md')
    const out = resolve('/elsewhere/list.md')
    expect(todoLabel(folder, out)).toBe(out)
  })

  it('readTodo: the open items; NOT_FOUND without the file; VALIDATION past 1 MB', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dimf-todo-'))
    dirs.push(d)
    writeFileSync(join(d, 'TODO.md'), '- [ ] one\n- [x] two\n')
    expect(await readTodo(join(d, 'TODO.md'))).toEqual([{ line: 1, text: 'one' }])
    await expect(readTodo(join(d, 'missing.md'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(readTodo(d)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    writeFileSync(join(d, 'big.md'), 'x'.repeat(TODO_FILE_MAX_BYTES + 1))
    await expect(readTodo(join(d, 'big.md'))).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
